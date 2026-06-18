// notePictureProbe.js — the "run from a NOTE" probe. Settles two things:
//   (A) Do note-structure APIs (insertNotePage/getNotePageTemplate/insertImage)
//       work in NOTE context even on the borrowed host — i.e. was the earlier 102
//       just because we ran from a PDF?
//   (B) THE deciding test: can an image go in as a PICTURE element through
//       insertElements (path+page addressed, no page-flip), or must images use
//       insertImage (current page only)?
//
// RUN WITH A BLANK NOTE OPEN. Writes into that note + a report to EXPORT.
// Delete anything it adds afterward.

import { NativeModules } from 'react-native';
import { FileUtils, PluginCommAPI, PluginNoteAPI, PluginFileAPI, PluginDocAPI } from 'sn-plugin-lib';

function unwrap(r) {
  if (r && typeof r === 'object' && 'success' in r) return r.success ? { ok: true, val: r.result } : { ok: false, err: r.error };
  return { ok: true, val: r };
}
async function safe(p) { try { return unwrap(await p); } catch (e) { return { ok: false, err: e instanceof Error ? e.message : String(e) }; } }
function findApi(n, apis) { for (const a of apis) if (a && typeof a[n] === 'function') return a; return null; }
async function call(n, args, apis) { const o = findApi(n, apis); if (!o) return { ok: false, err: `'${n}' not found`, via: null }; const r = await safe(o[n](...args)); r.via = o.__n || '?'; return r; }
function isBlocked(r) { const c = r && r.err && (r.err.code ?? r.err); return c === 102; }
function fmt(r) { if (r.ok) return `OK ✅ via ${r.via} (result=${JSON.stringify(r.val)})`; if (isBlocked(r)) return `BLOCKED 102 ❌ via ${r.via}`; return `error via ${r.via}: ${JSON.stringify(r.err)}`; }
function baseName(p) { const l = (p || 'doc').split('/').pop() || 'doc'; return l.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '_') || 'doc'; }
async function readAccessor(a, max = 3) {
  try { const n = a && a.size ? await a.size() : 0; const want = n > 0 ? [...new Set([0, Math.floor(n / 2), n - 1])] : []; const s = []; for (const i of want.slice(0, max)) { try { s.push(await a.get(i)); } catch {} } return { __accessor: true, size: n, sample: s }; }
  catch (e) { return { __accessor: true, error: String(e) }; }
}
async function describe(el) {
  const out = { type: el?.type, numInPage: el?.numInPage, uuid: el?.uuid, fields: {} };
  for (const k of Object.keys(el || {})) {
    if (['type', 'numInPage', 'uuid'].includes(k)) continue;
    let v; try { v = el[k]; } catch { out.fields[k] = '<throws>'; continue; }
    const t = typeof v;
    if (v == null) out.fields[k] = null;
    else if (t === 'string') out.fields[k] = v.length > 300 ? v.slice(0, 300) + '…' : v;
    else if (t === 'number' || t === 'boolean') out.fields[k] = v;
    else if (t === 'function') out.fields[k] = '<fn>';
    else if (t === 'object') {
      if (typeof v.size === 'function' && typeof v.get === 'function') out.fields[k] = await readAccessor(v);
      else { const sub = {}; for (const k2 of Object.keys(v)) { let v2; try { v2 = v[k2]; } catch { sub[k2] = '<throws>'; continue; } const t2 = typeof v2; if (v2 == null || t2 === 'number' || t2 === 'boolean') sub[k2] = v2; else if (t2 === 'string') sub[k2] = v2.length > 200 ? v2.slice(0, 200) + '…' : v2; else if (t2 === 'function') sub[k2] = '<fn>'; else if (t2 === 'object' && typeof v2.size === 'function') sub[k2] = await readAccessor(v2, 2); else sub[k2] = `<${t2}>`; } out.fields[k] = sub; }
    }
  }
  return out;
}

export async function runNotePictureProbe() {
  const renderer = NativeModules.CombinedColorPdfRenderer;
  const APIS = [PluginCommAPI, PluginNoteAPI, PluginFileAPI, PluginDocAPI];
  PluginCommAPI && (PluginCommAPI.__n = 'PluginCommAPI');
  PluginNoteAPI && (PluginNoteAPI.__n = 'PluginNoteAPI');
  PluginFileAPI && (PluginFileAPI.__n = 'PluginFileAPI');
  PluginDocAPI && (PluginDocAPI.__n = 'PluginDocAPI');
  const report = { when: new Date().toISOString(), results: {} };
  const L = []; const log = (s) => L.push(s);

  const cur = (await safe(PluginCommAPI.getCurrentFilePath())).val;
  log(`NOTE PICTURE PROBE  ${report.when}`);
  log(`current document: ${cur}`);
  if (!cur) throw new Error('Open a blank NOTE first, then run this.');
  const isNote = /\.note$/i.test(cur);
  log(`is a .note: ${isNote}${isNote ? ' ✅' : '  ⚠️ open a blank NOTE — this probe needs note context'}`);
  const dir = cur.slice(0, cur.lastIndexOf('/'));
  const base = baseName(cur);
  const stamp = Date.now();
  log('');

  // (A) note-context structure APIs (these were 102 from the PDF earlier)
  const tmplsR = await call('getNoteSystemTemplates', [], APIS);
  report.results.getNoteSystemTemplates = tmplsR;
  const tmplNames = Array.isArray(tmplsR.val) ? tmplsR.val.map(x => x?.name).filter(Boolean) : [];
  log(`getNoteSystemTemplates → ${tmplsR.ok ? '[' + tmplNames.join(', ') + ']' : fmt(tmplsR)}`);
  const template = tmplNames.find(n => n === 'style_white') || tmplNames.find(n => n === 'style_blank') || tmplNames[0] || 'style_white';

  const gtR = await call('getNotePageTemplate', [cur, 0], APIS);
  report.results.getNotePageTemplate = gtR;
  log(`getNotePageTemplate → ${fmt(gtR)}`);

  // (B) insertText (current page; correct direct-textBox payload)
  const txtR = await call('insertText', [{ fontSize: 36, textContentFull: 'PROBE text ✔',
    textRect: { left: 100, top: 120, right: 900, bottom: 200 } }], APIS);
  report.results.insertText = txtR;
  log(`insertText → ${fmt(txtR)}`);

  // (C) make a PNG from the note page, insertImage it (current page)
  const png = `${dir}/_probe_pic_${stamp}.png`;
  const genR = await safe(PluginFileAPI.generateNotePng({ notePath: cur, page: 0, times: 1, pngPath: png, type: 1 }));
  log(`generateNotePng(note) → ${genR.ok ? 'OK ' + png : fmt(genR)}`);
  if (genR.ok) {
    const imgR = await call('insertImage', [png], APIS);
    report.results.insertImage = imgR;
    log(`insertImage(current page) → ${fmt(imgR)}`);
    await call('saveCurrentNote', [], APIS);
  }

  // (D) read back the PICTURE(200) element to learn its real structure
  let els = (await call('getElements', [0, cur], APIS)).val;
  els = Array.isArray(els) ? els : [];
  const histo = {}; for (const e of els) histo[e?.type] = (histo[e?.type] || 0) + 1;
  log(`getElements(note) → ${els.length} element(s), types ${JSON.stringify(histo)}`);
  const readPic = els.find(e => e && e.type === 200);
  if (readPic) {
    const d = await describe(readPic);
    report.results.pictureElement = d;
    log(`PICTURE(200) fields: [${Object.keys(d.fields).join(', ')}] → ${JSON.stringify(d.fields).slice(0, 500)}`);
  } else {
    log('no PICTURE(200) element found after insertImage');
  }

  // (E) insertNotePage (was 102 from PDF — does it work from a note?)
  const pageR = await call('insertNotePage', [{ notePath: cur, page: 0, template }], APIS);
  report.results.insertNotePage = pageR;
  log(`insertNotePage(template=${JSON.stringify(template)}) → ${fmt(pageR)}`);

  // (F) THE deciding test — image via insertElements (path+page, no page-flip).
  //   F1: feed back the picture element we just read.
  if (readPic) {
    const insR = await call('insertElements', [cur, 0, [readPic]], APIS);
    report.results.insertElements_readPicture = insR;
    log(`insertElements([read picture]) → ${fmt(insR)}`);
  }
  //   F2: build a fresh picture element via createElement(200) + picturePath/rect.
  const ceR = await call('createElement', [200], APIS);
  log(`createElement(200) → ${ceR.ok ? 'OK (got element)' : fmt(ceR)}`);
  if (ceR.ok && ceR.val && typeof ceR.val === 'object') {
    const picEl = ceR.val;
    try {
      picEl.type = 200;
      picEl.picture = { picturePath: png, rect: { left: 1000, top: 1000, right: 6000, bottom: 5000 } };
    } catch (e) { log('  (could not set picture fields: ' + e + ')'); }
    const insR2 = await call('insertElements', [cur, 0, [picEl]], APIS);
    report.results.insertElements_builtPicture = insR2;
    log(`insertElements([built picture]) → ${fmt(insR2)}`);
  }

  await call('saveCurrentNote', [], APIS);

  // verdict
  log('');
  const npOk = report.results.insertNotePage?.ok;
  const picViaEl = report.results.insertElements_readPicture?.ok || report.results.insertElements_builtPicture?.ok;
  const imgOk = report.results.insertImage?.ok;
  log(`SUMMARY: insertNotePage=${npOk ? 'OK' : 'no'}  insertImage=${imgOk ? 'OK' : 'no'}  insertElements([picture])=${picViaEl ? 'OK ✅' : 'no'}`);
  if (picViaEl) log('VERDICT: images CAN ride insertElements → clean multi-page extract (no page-flip dance). Run-from-doc-pick-note also viable.');
  else if (imgOk) log('VERDICT: images need insertImage (current page) → multi-page extract uses Inkling-style page navigation. Run-from-note.');
  else log('VERDICT: inconclusive — check insertImage / insertElements results above.');
  log('Open this note to see what landed; delete anything the probe added.');

  const exportDir = (await FileUtils.getExportPath() || '').replace(/\/+$/, '');
  const summary = L.join('\n');
  try { await renderer.writeFile(`${exportDir}/notepictureprobe_${base}_${stamp}.json`, JSON.stringify(report, null, 2)); } catch {}
  try { await renderer.writeFile(`${exportDir}/notepictureprobe_${base}_${stamp}.txt`, summary); } catch {}
  return summary;
}
