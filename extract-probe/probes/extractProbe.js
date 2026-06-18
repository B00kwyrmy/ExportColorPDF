// extractProbe.js — one-off, READ-ONLY diagnostic for the "extract annotations
// into a new note" idea. It mutates nothing: no note is created, no element is
// changed. It interrogates the Supernote SDK on the page(s) you've marked and
// writes two files to your EXPORT directory:
//
//   extractprobe_<base>_<stamp>.json   full machine-readable dump
//   extractprobe_<base>_<stamp>.txt    short human summary (read this first)
//
// The single question it must answer:
//   Does getCurrentDocText(page) return POSITIONED text (word/line boxes) or a
//   FLAT string? That decides whether highlight / underline / circle-of-text
//   extraction (and the text-vs-image branch for enclosures) is possible.
//
// It also dumps the bracket "digest" data, titles, and every non-stroke element
// (with discovered field names) so we learn the real shape of digest-quote (501),
// geometry (700) and picture (200) elements without guessing.

import { NativeModules } from 'react-native';
import { FileUtils, PluginCommAPI, PluginDocAPI, PluginFileAPI } from 'sn-plugin-lib';

// These methods may live on PluginDocAPI OR PluginFileAPI depending on SDK
// version, so we don't hard-code the namespace — we find whoever owns the
// method, call it, and record which API answered. `apis` is tried in order.
function findApi(name, apis) {
  for (const api of apis) {
    if (api && typeof api[name] === 'function') return api;
  }
  return null;
}
async function call(name, args, apis, fallbackOwnerLabel) {
  const owner = findApi(name, apis);
  if (!owner) return { ok: false, err: `${name} not found on any of ${fallbackOwnerLabel}`, via: null };
  const r = await safe(owner[name](...args));
  r.via = owner.__apiName || '(api)';
  return r;
}
// Tag the API objects so we can report which one served each call.
PluginDocAPI && (PluginDocAPI.__apiName = 'PluginDocAPI');
PluginFileAPI && (PluginFileAPI.__apiName = 'PluginFileAPI');

const TYPE_LABELS = {
  0: 'STROKE', 100: 'TITLE', 200: 'PICTURE', 500: 'TEXT',
  501: 'TEXT_DIGEST_QUOTE', 502: 'TEXT_DIGEST_CREATE', 600: 'LINK', 700: 'GEO',
};

// SDK calls return either a raw value or a { success, result, error } envelope.
function unwrap(resp) {
  if (resp && typeof resp === 'object' && 'success' in resp) {
    return resp.success ? resp.result : { __error: resp.error || 'success=false' };
  }
  return resp;
}
async function safe(p) {
  try { return { ok: true, val: unwrap(await p) }; }
  catch (e) { return { ok: false, err: e instanceof Error ? e.message : String(e) }; }
}

// Read an SDK accessor (contoursSrc / points / angles): { size, sample }.
async function readAccessor(acc, maxSample = 3) {
  try {
    const n = (acc && acc.size) ? await acc.size() : 0;
    const want = n > 0 ? [...new Set([0, Math.floor(n / 2), n - 1])] : [];
    const sample = [];
    for (const i of want.slice(0, maxSample)) {
      try { sample.push(await acc.get(i)); } catch {}
    }
    return { __accessor: true, size: n, sample };
  } catch (e) { return { __accessor: true, error: String(e) }; }
}

// Bounded, name-discovering description of one element's own fields.
async function describeElement(el) {
  const out = {
    type: el?.type,
    typeLabel: TYPE_LABELS[el?.type] ?? `?${el?.type}`,
    numInPage: el?.numInPage,
    uuid: el?.uuid,
    fields: {},
  };
  for (const key of Object.keys(el || {})) {
    if (['type', 'numInPage', 'uuid'].includes(key)) continue;
    let v;
    try { v = el[key]; } catch { out.fields[key] = '<throws>'; continue; }
    const t = typeof v;
    if (v == null) out.fields[key] = null;
    else if (t === 'string') out.fields[key] = v.length > 400 ? v.slice(0, 400) + `…(+${v.length - 400})` : v;
    else if (t === 'number' || t === 'boolean') out.fields[key] = v;
    else if (t === 'function') out.fields[key] = '<fn>';
    else if (t === 'object') {
      if (typeof v.size === 'function' && typeof v.get === 'function') {
        out.fields[key] = await readAccessor(v);
      } else {
        const sub = {};
        for (const k2 of Object.keys(v)) {
          let v2; try { v2 = v[k2]; } catch { sub[k2] = '<throws>'; continue; }
          const t2 = typeof v2;
          if (v2 == null || t2 === 'number' || t2 === 'boolean') sub[k2] = v2;
          else if (t2 === 'string') sub[k2] = v2.length > 200 ? v2.slice(0, 200) + '…' : v2;
          else if (t2 === 'function') sub[k2] = '<fn>';
          else if (t2 === 'object' && typeof v2.size === 'function') sub[k2] = await readAccessor(v2, 2);
          else sub[k2] = `<${t2}>`;
        }
        out.fields[key] = sub;
      }
    }
  }
  el.recycle?.();
  return out;
}

function diagnoseDocText(val) {
  if (val == null || val === '') return 'EMPTY / NULL — no reachable text layer on this page (or this is a scanned/image page).';
  if (typeof val === 'string')
    return `FLAT STRING (length ${val.length}) — NO coordinates. ⇒ highlight/underline/circle-of-text mapping is NOT possible from this call alone.`;
  if (Array.isArray(val)) {
    const f = val.find(x => x && typeof x === 'object');
    const keys = f ? Object.keys(f) : [];
    const hasPos = keys.some(k => /rect|box|bound|left|top|right|bottom|x|y|pos/i.test(k));
    return `ARRAY of ${val.length} item(s); item keys = [${keys.join(', ')}]. Positioned text: ${hasPos ? 'YES ✅ — region→words mapping IS possible.' : 'no obvious coordinates ⚠️ — inspect JSON.'}`;
  }
  if (typeof val === 'object') return `OBJECT, keys = [${Object.keys(val).join(', ')}] — inspect JSON for nested positioned items.`;
  return `unexpected type ${typeof val}`;
}

function baseName(p) {
  const last = (p || 'doc').split('/').pop() || 'doc';
  return last.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '_') || 'doc';
}

/**
 * Run the probe. Read-only. Returns the summary string (also written to disk).
 * @param {object} [opts]
 * @param {number} [opts.maxPages=4]  how many marked pages to inspect (plus current).
 */
export async function runExtractProbe({ maxPages = 4 } = {}) {
  const renderer = NativeModules.CombinedColorPdfRenderer;
  const report = { when: new Date().toISOString(), steps: {} };
  const lines = [];
  const log = (s) => { lines.push(s); };

  const np = await safe(PluginCommAPI.getCurrentFilePath());
  const notePath = np.val;
  report.notePath = notePath;
  log(`Export-to-note PROBE  ${report.when}`);
  log(`document: ${notePath || '(getCurrentFilePath FAILED: ' + np.err + ')'}`);
  if (!notePath) throw new Error('Open a PDF or EPUB first — getCurrentFilePath returned nothing.');

  const kind = /\.pdf$/i.test(notePath) ? 'pdf' : /\.epub$/i.test(notePath) ? 'epub' : /\.note$/i.test(notePath) ? 'note' : 'doc';
  log(`detected kind: ${kind}`);

  // Which pages to probe: the current page, plus marked pages (capped).
  const curR = await safe(PluginCommAPI.getCurrentPageNum());
  const cur = typeof curR.val === 'number' ? curR.val : 0;
  const marksR = await call('getMarkPages', [notePath], [PluginFileAPI, PluginDocAPI], 'File/Doc');
  const marks = Array.isArray(marksR.val) ? [...new Set(marksR.val)].sort((a, b) => a - b) : [];
  report.steps.getMarkPages = marksR;
  const pages = [...new Set([cur, ...marks])].slice(0, maxPages + 1);
  log(`current page (0-based): ${cur}`);
  log(`getMarkPages: ${marksR.ok ? '[' + marks.join(', ') + ']' : 'FAILED (' + marksR.err + ')'}`);
  log(`probing pages: [${pages.join(', ')}]`);
  log('');

  report.pages = {};
  for (const page of pages) {
    log(`──────── PAGE ${page} ────────`);
    const pg = { page };

    // (1) THE key question: getCurrentDocText shape. (Doc vs File API.)
    const docTextR = await call('getCurrentDocText', [page], [PluginDocAPI, PluginFileAPI], 'Doc/File');
    pg.getCurrentDocText = docTextR;
    log(`getCurrentDocText [via ${docTextR.via}]: ${docTextR.ok ? diagnoseDocText(docTextR.val) : 'CALL FAILED — ' + docTextR.err}`);

    // (2) Bracket digests (your "Keywords"/Digest path).
    const kwR = await call('getKeyWords', [notePath, [page]], [PluginFileAPI, PluginDocAPI], 'File/Doc');
    pg.getKeyWords = kwR;
    log(`getKeyWords [via ${kwR.via}]: ${kwR.ok ? JSON.stringify(kwR.val).slice(0, 500) : 'FAILED — ' + kwR.err}`);

    // (3) Titles/headings.
    const titlesR = await call('getTitles', [notePath, [page]], [PluginFileAPI, PluginDocAPI], 'File/Doc');
    pg.getTitles = titlesR;
    log(`getTitles [via ${titlesR.via}]: ${titlesR.ok ? JSON.stringify(titlesR.val).slice(0, 300) : 'FAILED — ' + titlesR.err}`);

    // (4) Elements: histogram + full dump of every NON-stroke element, plus a
    //     few strokes (to confirm penType/penColor/contour fields once).
    const elemsR = await call('getElements', [page, notePath], [PluginFileAPI, PluginDocAPI], 'File/Doc');
    const elements = Array.isArray(elemsR.val) ? elemsR.val : [];
    const histo = {};
    const described = [];
    let strokeSamples = 0;
    for (const el of elements) {
      const lbl = TYPE_LABELS[el?.type] ?? `?${el?.type}`;
      histo[lbl] = (histo[lbl] || 0) + 1;
      const isStroke = el?.type === 0;
      if (!isStroke || strokeSamples < 5) {
        if (isStroke) strokeSamples++;
        described.push(await describeElement(el));
      } else {
        el.recycle?.();
      }
    }
    pg.elementHistogram = histo;
    pg.elements = described;
    log(`getElements: ${elemsR.ok ? elements.length + ' element(s) → ' + JSON.stringify(histo) : 'FAILED — ' + elemsR.err}`);
    const interesting = described.filter(d => d.type !== 0);
    if (interesting.length) {
      log(`  non-stroke elements (field names discovered):`);
      for (const d of interesting) log(`   • ${d.typeLabel}(#${d.numInPage}) keys=[${Object.keys(d.fields).join(', ')}]`);
    }
    log('');
    report.pages[page] = pg;
  }

  // ── Write report files to EXPORT ───────────────────────────────────────────
  const exportDir = (await FileUtils.getExportPath() || '').replace(/\/+$/, '');
  const base = baseName(notePath);
  const stamp = Date.now();
  const jsonPath = `${exportDir}/extractprobe_${base}_${stamp}.json`;
  const txtPath = `${exportDir}/extractprobe_${base}_${stamp}.txt`;
  const summary = lines.join('\n');
  try { await FileUtils.makeDir(exportDir); } catch {}
  try { await renderer.writeFile(jsonPath, JSON.stringify(report, null, 2)); } catch (e) { log('JSON write FAILED: ' + e); }
  try { await renderer.writeFile(txtPath, summary); } catch (e) { log('TXT write FAILED: ' + e); }

  return `${summary}\n\nWROTE:\n  ${txtPath}\n  ${jsonPath}`;
}
