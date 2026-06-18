// authoringProbe.js — tests the OUTPUT side of the "Doc Annotations To Note"
// plugin: can this plugin CREATE a note and INSERT an image/text into it, or is
// that permission-blocked (like getTitles returned code 102)?
//
// SIDE EFFECT: on success it creates ONE throwaway note next to the open
// document, named <base>_extract_PROBE_<stamp>.note — safe to delete.
//
// It writes a report to the EXPORT folder and returns the summary string.

import { NativeModules } from 'react-native';
import {
  FileUtils, PluginCommAPI, PluginManager,
  PluginNoteAPI, PluginFileAPI, PluginDocAPI,
} from 'sn-plugin-lib';

function unwrap(resp) {
  if (resp && typeof resp === 'object' && 'success' in resp) {
    return resp.success ? { ok: true, val: resp.result } : { ok: false, err: resp.error };
  }
  return { ok: true, val: resp };
}
async function safe(p) {
  try { const r = unwrap(await p); return r; }
  catch (e) { return { ok: false, err: e instanceof Error ? e.message : String(e) }; }
}
function findApi(name, apis) { for (const a of apis) { if (a && typeof a[name] === 'function') return a; } return null; }
async function call(name, args, apis) {
  const owner = findApi(name, apis);
  if (!owner) return { ok: false, err: `'${name}' not found on any candidate API`, via: null };
  const r = await safe(owner[name](...args));
  r.via = owner.__n || '?';
  return r;
}
// List function-valued members (incl. prototype) so we discover openNote-style APIs.
function methods(obj) {
  const out = new Set(); let o = obj;
  while (o && o !== Object.prototype && o !== Function.prototype) {
    for (const k of Object.getOwnPropertyNames(o)) { try { if (typeof obj[k] === 'function') out.add(k); } catch {} }
    o = Object.getPrototypeOf(o);
  }
  return [...out].sort();
}
function baseName(p) {
  const last = (p || 'doc').split('/').pop() || 'doc';
  return last.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '_') || 'doc';
}

export async function runAuthoringProbe() {
  const renderer = NativeModules.CombinedColorPdfRenderer;
  const APIS = [PluginNoteAPI, PluginFileAPI, PluginDocAPI, PluginManager];
  PluginNoteAPI && (PluginNoteAPI.__n = 'PluginNoteAPI');
  PluginFileAPI && (PluginFileAPI.__n = 'PluginFileAPI');
  PluginDocAPI && (PluginDocAPI.__n = 'PluginDocAPI');
  PluginManager && (PluginManager.__n = 'PluginManager');

  const report = { when: new Date().toISOString(), steps: {} };
  const L = [];
  const log = (s) => L.push(s);

  const np = await safe(PluginCommAPI.getCurrentFilePath());
  const notePath = np.val;
  log(`AUTHORING PROBE  ${report.when}`);
  log(`document: ${notePath}`);
  if (!notePath) throw new Error('Open the PDF/EPUB first.');
  const dir = notePath.slice(0, notePath.lastIndexOf('/'));
  const base = baseName(notePath);
  const stamp = Date.now();
  const newNotePath = `${dir}/${base}_extract_PROBE_${stamp}.note`;
  log(`target new note: ${newNotePath}`);
  log('');

  // (0) API method inventory — reveals createNote/insertImage/openNote/etc.
  log('── available methods (function members) ──');
  for (const api of [PluginNoteAPI, PluginFileAPI, PluginDocAPI]) {
    const ms = methods(api).filter(m => /note|image|text|page|create|insert|open|save|current|element|sticker/i.test(m));
    log(`${api.__n}: ${ms.join(', ')}`);
    report.steps[`methods_${api.__n}`] = ms;
  }
  log('');

  // (1) createNote — try a few template/mode/orientation combos, STOP at first success.
  const templates = ['blank', 'Blank', 'white', 'White', 'none', 'standard', '0'];
  const modes = [0, 1];
  let created = null;
  log('── createNote attempts ──');
  outer:
  for (const template of templates) {
    for (const mode of modes) {
      const r = await call('createNote', [{ notePath: newNotePath, template, mode, isPortrait: true }], APIS);
      log(`  template=${JSON.stringify(template)} mode=${mode} → ${r.ok ? 'OK ✅ via ' + r.via : 'fail: ' + JSON.stringify(r.err)}`);
      if (r.ok) { created = { template, mode, result: r.val, via: r.via }; break outer; }
    }
  }
  report.steps.createNote = created || 'ALL ATTEMPTS FAILED';
  log('');

  if (!created) {
    log('createNote did not succeed with any guess — see errors above (note the exact message; it usually names the valid template/mode).');
  } else {
    // (2) Make the new note current if an API exists, then try to author into it.
    const openR = await call('openNote', [newNotePath], APIS);
    if (openR.via) log(`openNote: ${openR.ok ? 'OK via ' + openR.via : 'fail: ' + JSON.stringify(openR.err)}`);
    else log('openNote: (no such API — createNote may already make it current)');

    // (3) Render the current doc page to a PNG (native renderDocPage exists) to feed insertImage.
    const curR = await safe(PluginCommAPI.getCurrentPageNum());
    const page = typeof curR.val === 'number' ? curR.val : 0;
    const pngPath = `${dir}/${base}_PROBEimg_${stamp}.png`;
    const renderR = await safe(renderer.renderDocPage(notePath, page, 700, 933, pngPath));
    log(`renderDocPage(page ${page}) → ${renderR.ok ? 'OK ' + pngPath : 'fail: ' + renderR.err}`);

    // (4) insertImage — the key test.
    if (renderR.ok) {
      const imgR = await call('insertImage', [{ pngPath }], APIS);
      log(`insertImage → ${imgR.ok ? 'OK ✅ via ' + imgR.via : 'FAIL: ' + JSON.stringify(imgR.err)}`);
      report.steps.insertImage = imgR;
      // also try positional form in case bare pngPath ignores placement
      const imgR2 = await call('insertImage', [{ pngPath, imageRect: { left: 50, top: 50, right: 650, bottom: 850 } }], APIS);
      log(`insertImage(+imageRect) → ${imgR2.ok ? 'OK via ' + imgR2.via : 'fail: ' + JSON.stringify(imgR2.err)}`);
    }

    // (5) insertText — secondary (for labels/headers if we want them).
    const txtR = await call('insertText', [{ textBox: {
      fontSize: 32, textContentFull: 'PROBE: hello from Doc Annotations To Note',
      textRect: { left: 50, top: 900, right: 650, bottom: 980 },
    } }], APIS);
    log(`insertText → ${txtR.ok ? 'OK ✅ via ' + txtR.via : 'fail: ' + JSON.stringify(txtR.err)}`);
    report.steps.insertText = txtR;

    // (5b) insertElements — copy a REAL stroke from the source doc into the new
    // note (vector handwriting: preserves colour + stays editable — preferred path).
    // NOTE: getElements returns lazy accessors (points/contoursSrc); this tests
    // whether a stroke survives the bridge round-trip or must be rebuilt.
    const srcElems = await call('getElements', [page, notePath], APIS);
    const srcArr = Array.isArray(srcElems.val) ? srcElems.val : [];
    const firstStroke = srcArr.find(e => e && e.type === 0);
    if (firstStroke) {
      const insR = await call('insertElements', [newNotePath, 0, [firstStroke]], APIS);
      log(`insertElements(copy 1 source stroke verbatim) → ${insR.ok ? 'OK ✅ via ' + insR.via : 'FAIL: ' + JSON.stringify(insR.err)}`);
      report.steps.insertElements = insR;
    } else {
      log('insertElements: no source stroke on this page to copy');
    }
    for (const e of srcArr) { try { e.recycle?.(); } catch {} }

    // (6) Persist.
    const saveR = await call('saveCurrentNote', [], APIS);
    log(`saveCurrentNote → ${saveR.ok ? 'OK via ' + saveR.via : 'fail: ' + JSON.stringify(saveR.err)}`);

    log('');
    log(`If createNote+insertImage succeeded, open "${base}_extract_PROBE_${stamp}.note" and check the image/text landed. Then delete it.`);
  }

  const exportDir = (await FileUtils.getExportPath() || '').replace(/\/+$/, '');
  const summary = L.join('\n');
  try { await renderer.writeFile(`${exportDir}/authoringprobe_${base}_${stamp}.json`, JSON.stringify(report, null, 2)); } catch {}
  try { await renderer.writeFile(`${exportDir}/authoringprobe_${base}_${stamp}.txt`, summary); } catch {}
  return summary;
}
