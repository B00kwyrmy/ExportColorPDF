// insertProbe.js — answers the make-or-break question for the "user makes the
// note, plugin fills it" design: are the WRITE/authoring APIs permission-blocked
// (code 102) like createNote was, or are they allowed on an EXISTING note?
//
// RUN THIS WITH A BLANK NOTE OPEN (create a new blank note, open it, then tap the
// button). It writes into that note. Anything it adds is safe to delete.
//
// Tests, on the currently-open note: getNotePageTemplate, insertText, insertImage
// (string path), insertNotePage, insertElements (feeding back a real stroke).
// Writes a report to EXPORT and returns the summary.

import { NativeModules } from 'react-native';
import {
  FileUtils, PluginCommAPI,
  PluginNoteAPI, PluginFileAPI, PluginDocAPI,
} from 'sn-plugin-lib';

// A source doc to pull a real stroke from for the insertElements test. We know
// this path from the earlier probes; if it's absent the stroke test just skips.
const KNOWN_PDF = '/storage/emulated/0/Document/SHORTFORM/How to do things you hate.pdf';

function unwrap(resp) {
  if (resp && typeof resp === 'object' && 'success' in resp) {
    return resp.success ? { ok: true, val: resp.result } : { ok: false, err: resp.error };
  }
  return { ok: true, val: resp };
}
async function safe(p) {
  try { return unwrap(await p); }
  catch (e) { return { ok: false, err: e instanceof Error ? e.message : String(e) }; }
}
function findApi(name, apis) { for (const a of apis) if (a && typeof a[name] === 'function') return a; return null; }
async function call(name, args, apis) {
  const owner = findApi(name, apis);
  if (!owner) return { ok: false, err: `'${name}' not found`, via: null };
  const r = await safe(owner[name](...args)); r.via = owner.__n || '?'; return r;
}
function isBlocked(r) { const c = r && r.err && (r.err.code ?? r.err); return c === 102; }
function fmt(r) {
  if (r.ok) return `OK ✅ via ${r.via} (result=${JSON.stringify(r.val)})`;
  if (isBlocked(r)) return `BLOCKED 102 ❌ via ${r.via}`;
  return `error via ${r.via}: ${JSON.stringify(r.err)}`;
}
function baseName(p) {
  const last = (p || 'doc').split('/').pop() || 'doc';
  return last.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '_') || 'doc';
}

export async function runInsertProbe() {
  const renderer = NativeModules.CombinedColorPdfRenderer;
  const APIS = [PluginNoteAPI, PluginFileAPI, PluginDocAPI];
  PluginNoteAPI && (PluginNoteAPI.__n = 'PluginNoteAPI');
  PluginFileAPI && (PluginFileAPI.__n = 'PluginFileAPI');
  PluginDocAPI && (PluginDocAPI.__n = 'PluginDocAPI');

  const report = { when: new Date().toISOString(), results: {} };
  const L = []; const log = (s) => L.push(s);

  const cur = (await safe(PluginCommAPI.getCurrentFilePath())).val;
  log(`INSERT PROBE  ${report.when}`);
  log(`current document: ${cur}`);
  if (!cur) throw new Error('Open a blank NOTE first, then run this.');
  const isNote = /\.note$/i.test(cur);
  log(`is a .note: ${isNote}${isNote ? '' : '  ⚠️ open a blank NOTE for a clean test'}`);
  const dir = cur.slice(0, cur.lastIndexOf('/'));
  const base = baseName(cur);
  const stamp = Date.now();
  log('');

  // (0) Valid template for this note (also tells us what createNote/insertNotePage want).
  const tmplR = await call('getNotePageTemplate', [cur, 0], APIS);
  report.results.getNotePageTemplate = tmplR;
  log(`getNotePageTemplate → ${fmt(tmplR)}`);
  const template = (tmplR.ok && (typeof tmplR.val === 'string' ? tmplR.val : tmplR.val?.template)) || '';
  log('');

  // (1) insertText on the current note — simplest authoring permission test.
  const txtR = await call('insertText', [{ textBox: {
    fontSize: 36, textContentFull: 'PROBE insertText ✔',
    textRect: { left: 100, top: 120, right: 900, bottom: 200 },
  } }], APIS);
  report.results.insertText = txtR;
  log(`insertText → ${fmt(txtR)}`);

  // (2) insertImage — render the CURRENT note page to a PNG, then insert it back.
  //     insertImage takes a STRING path (not an object).
  const png = `${dir}/_probe_img_${stamp}.png`;
  const genR = await safe(PluginFileAPI.generateNotePng({ notePath: cur, page: 0, times: 1, pngPath: png, type: 1 }));
  log(`generateNotePng(current) → ${genR.ok ? 'OK ' + png : 'fail: ' + JSON.stringify(genR.err)}`);
  if (genR.ok) {
    const imgR = await call('insertImage', [png], APIS);
    report.results.insertImage = imgR;
    log(`insertImage(string path) → ${fmt(imgR)}`);
  }

  // (3) insertNotePage on the current note (uses the template we read).
  const pageR = await call('insertNotePage', [{ notePath: cur, page: 0, template: template || 'none' }], APIS);
  report.results.insertNotePage = pageR;
  log(`insertNotePage(template=${JSON.stringify(template || 'none')}) → ${fmt(pageR)}`);

  // (4) insertElements — feed back a REAL stroke (with its live accessors) to see
  //     if a stroke survives the bridge. Source: current note, else the known PDF.
  let srcArr = (await call('getElements', [0, cur], APIS)).val;
  srcArr = Array.isArray(srcArr) ? srcArr : [];
  let stroke = srcArr.find(e => e && e.type === 0);
  let strokeFrom = cur;
  if (!stroke) {
    const pdfEls = (await call('getElements', [1, KNOWN_PDF], APIS)).val;
    if (Array.isArray(pdfEls)) { stroke = pdfEls.find(e => e && e.type === 0); strokeFrom = KNOWN_PDF; }
  }
  if (stroke) {
    const insR = await call('insertElements', [cur, 0, [stroke]], APIS);
    report.results.insertElements = insR;
    log(`insertElements(1 stroke from ${strokeFrom === cur ? 'current note' : 'PDF'}) → ${fmt(insR)}`);
  } else {
    log('insertElements: no source stroke available to test (current note empty + PDF not found)');
  }

  // (5) Persist so you can open the note and see what landed.
  const saveR = await call('saveCurrentNote', [], APIS);
  log(`saveCurrentNote → ${fmt(saveR)}`);

  log('');
  const blocked = ['insertText', 'insertImage', 'insertNotePage', 'insertElements']
    .filter(k => report.results[k] && isBlocked(report.results[k]));
  if (blocked.length === 0) log('VERDICT: authoring into an existing note appears ALLOWED ✅ — the "user-makes-note, plugin-fills-it" design is viable.');
  else log(`VERDICT: BLOCKED (102) for: ${blocked.join(', ')} — those are host-restricted even on an existing note.`);
  log('Open this note to see what actually landed, then delete anything the probe added.');

  const exportDir = (await FileUtils.getExportPath() || '').replace(/\/+$/, '');
  const summary = L.join('\n');
  try { await renderer.writeFile(`${exportDir}/insertprobe_${base}_${stamp}.json`, JSON.stringify(report, null, 2)); } catch {}
  try { await renderer.writeFile(`${exportDir}/insertprobe_${base}_${stamp}.txt`, summary); } catch {}
  return summary;
}
