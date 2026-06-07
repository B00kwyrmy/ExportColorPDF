import { NativeModules } from 'react-native';
import {
  FileUtils,
  PluginCommAPI,
  PluginDocAPI,
  PluginFileAPI,
  PluginManager,
  PluginNoteAPI,
} from 'sn-plugin-lib';

// ─── Tunables ─────────────────────────────────────────────────────────────────
const MAX_PAGES = 0;                 // 'full' mode: 0 = every page

// The six highlighter colours (CustomColorPalette "Highlighter …" entries).
// Wash-vs-opaque is colour-driven: a highlighter colour on a wash-capable pen →
// translucent wash; any other colour → opaque.
const HIGHLIGHTER_HEXES = new Set(
  ['#F2C6DE', '#FAEDCB', '#F7D9C4', '#C6DEF1', '#C9E4DE', '#DBCDF0'],
);
function isHighlightColor(hex) { return !!hex && HIGHLIGHTER_HEXES.has(hex.toUpperCase()); }

// Wash-capable pens: the marker (penType 11). Pen(10)/calligraphy(15)/ink(16)
// always render opaque. See [[exportcolorpdf-plugin]].
const WASH_PEN_TYPES = new Set([11 /* marker */]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function deriveBaseName(notePath) {
  const last  = notePath.split('/').pop() || 'doc';
  const noExt = last.replace(/\.[^.]+$/, '');
  return noExt.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'doc';
}
function isArgbColor(penColor) { return penColor > 255 || penColor < 0; }
function argbToHex(argb) {
  const u = argb >>> 0;
  const r = (u >> 16) & 0xFF, g = (u >> 8) & 0xFF, b = u & 0xFF;
  return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}
async function settle(promise) {
  try { return { ok: true, val: await promise, err: null }; }
  catch (e) { return { ok: false, val: null, err: e instanceof Error ? e.message : String(e) }; }
}
function unpack(resp) {
  if (resp && typeof resp === 'object' && 'success' in resp) {
    if (resp.success) return { ok: true, val: resp.result, err: null };
    return { ok: false, val: null, err: (resp.error && resp.error.message) || 'success=false' };
  }
  return { ok: true, val: resp, err: null };
}

// CustomColorPalette sidecar: {export}/.ccp/{base}_colors.json → {byUuid,byIndex,penPrefs}.
async function readSidecar(renderer, exportDir, baseName) {
  const out = { byIndex: {}, byUuid: {}, penPrefs: { pen: null, high: null } };
  try {
    const raw = await renderer.readFile(`${exportDir.replace(/\/+$/,'')}/.ccp/${baseName}_colors.json`);
    if (raw) {
      const d = JSON.parse(raw);
      if (d.byUuid)  out.byUuid  = d.byUuid;
      if (d.byIndex) out.byIndex = d.byIndex;
      if (d.penPrefs?.pen)  out.penPrefs.pen  = d.penPrefs.pen;
      if (d.penPrefs?.high) out.penPrefs.high = d.penPrefs.high;
    }
  } catch {}
  return out;
}

// Per-book export-state snapshot for the "new annotations" mode.
function exportStatePath(exportDir, baseName) {
  return `${exportDir.replace(/\/+$/,'')}/.ccp/${baseName}_exportstate.json`;
}
async function readExportState(renderer, exportDir, baseName) {
  const out = { lastExport: 0, pages: {} };
  try {
    const raw = await renderer.readFile(exportStatePath(exportDir, baseName));
    if (raw) {
      const d = JSON.parse(raw);
      if (typeof d.lastExport === 'number') out.lastExport = d.lastExport;
      if (d.pages && typeof d.pages === 'object') out.pages = d.pages;
    }
  } catch {}
  return out;
}
async function writeExportState(renderer, exportDir, baseName, state) {
  try { await renderer.writeFile(exportStatePath(exportDir, baseName), JSON.stringify(state)); } catch {}
}
async function pageElementCount(notePath, page) {
  const r = unpack(await settle(PluginFileAPI.getElementCounts(notePath, page)).then(x => x.val)).val;
  if (typeof r === 'number') return r;
  if (r && typeof r === 'object') { let s = 0; for (const v of Object.values(r)) if (typeof v === 'number') s += v; return s; }
  return 0;
}

// ─── Per-stroke colour resolution (shared by all document types) ──────────────
function resolveColor(el, page, sidecar) {
  const stroke = el.stroke || {};
  const penColor = stroke.penColor ?? 0;
  const penType  = stroke.penType  ?? 1;
  const uuid     = el.uuid ?? '';
  const idxKey   = `${page}_${el.numInPage}`;
  // Per-stroke recorded colour only — no global fallback. (A penPrefs "last
  // picked" fallback was tried and removed: it force-coloured every unmatched
  // stroke and drifted between exports. Unmatched strokes keep their natural look,
  // handled by the caller.) byUuid is effectively dead — the firmware mints a
  // fresh uuid on every getElements call — but kept first in case that changes;
  // matching is really via byIndex (page_numInPage), whose numInPage is stable.
  let colorHex = null;
  if (uuid && sidecar.byUuid[uuid])     colorHex = sidecar.byUuid[uuid];
  else if (sidecar.byIndex[idxKey])     colorHex = sidecar.byIndex[idxKey];
  else if (isArgbColor(penColor))       colorHex = argbToHex(penColor);
  const isHigh = !!colorHex && WASH_PEN_TYPES.has(penType) && isHighlightColor(colorHex);
  return { colorHex, isHigh, penType };
}

// ─── Build overlay data per page ──────────────────────────────────────────────

// DOCUMENTS (PDF/EPUB): coloured contour polygons drawn on top of the rendered
// page. Contours are pixel coords, so printed text is never recoloured.
async function buildDocShapes(elements, page, sidecar, drawUncolored) {
  const docShapes = []; let totalStrokes = 0, coloredCount = 0;
  for (const el of elements) {
    if (el.type !== 0 || !el.stroke) { el.recycle?.(); continue; }
    totalStrokes++;
    const { colorHex, isHigh, penType } = resolveColor(el, page, sidecar);
    if (colorHex) coloredCount++;

    // NOTES (drawUncolored=false): the base render (generateNotePng) already
    // shows every stroke in grayscale, so we only overlay the COLOURED ones.
    // DOCS (drawUncolored=true): the base has no ink, so every annotation must be
    // drawn — uncoloured marker → neutral light-grey wash, uncoloured pen → black.
    if (!colorHex && !drawUncolored) { el.recycle?.(); continue; }
    const isMarker = WASH_PEN_TYPES.has(penType);
    const drawColor = colorHex || (isMarker ? '#C9C9C9' : '#000000');
    const wash = colorHex ? isHigh : isMarker;

    const polys = [];
    try {
      const cs = el.contoursSrc;
      const nC = (cs && cs.size) ? await cs.size() : 0;
      for (let ci = 0; ci < nC; ci++) {
        const poly = await cs.get(ci);
        if (Array.isArray(poly) && poly.length >= 3) {
          polys.push(poly.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) })));
        }
      }
    } catch {}
    el.recycle?.();
    if (polys.length) docShapes.push({ color: drawColor, wash, polys });
  }
  return { docShapes, totalStrokes, coloredCount };
}

// ─── Colour one page (per document type) ──────────────────────────────────────

// Notes render the same way as docs now (contour fill on top of the device page),
// which avoids reading every stroke's sample points. The note base PNG already
// contains the strokes in grayscale, so we overlay only the COLOURED contours
// (drawUncolored=false) — opaque pen / translucent marker wash cover the ink.
async function colorNotePage(renderer, notePath, page, size, sidecar, contentPng, outPng) {
  const r = unpack(await settle(PluginFileAPI.generateNotePng({ notePath, page, times: 1, pngPath: contentPng, type: 1 })).then(x => x.val));
  if (!r.ok) return { ok: false, totalStrokes: 0, coloredCount: 0, err: r.err };
  const elems = unpack(await settle(PluginFileAPI.getElements(page, notePath)).then(x => x.val));
  const elements = Array.isArray(elems.val) ? elems.val : [];
  const { docShapes, totalStrokes, coloredCount } = await buildDocShapes(elements, page, sidecar, false);
  await renderer.drawColoredShapes(contentPng, docShapes, outPng);
  await settle(FileUtils.deleteFile(contentPng));
  return { ok: true, totalStrokes, coloredCount };
}

async function colorDocPage(renderer, notePath, page, size, sidecar, contentPng, outPng, renderBase) {
  const base = await renderBase(contentPng, size);
  if (!base.ok) return { ok: false, totalStrokes: 0, coloredCount: 0, err: base.err };
  const elems = unpack(await settle(PluginFileAPI.getElements(page, notePath)).then(x => x.val));
  const elements = Array.isArray(elems.val) ? elems.val : [];
  const { docShapes, totalStrokes, coloredCount } = await buildDocShapes(elements, page, sidecar, true);
  // drawColoredShapes with an empty array just copies content → out.
  await renderer.drawColoredShapes(contentPng, docShapes, outPng);
  await settle(FileUtils.deleteFile(contentPng));
  return { ok: true, totalStrokes, coloredCount };
}

// ─── Document-type detection + page bookkeeping ───────────────────────────────

function detectKind(notePath) {
  if (/\.note$/i.test(notePath)) return 'note';
  if (/\.pdf$/i.test(notePath))  return 'pdf';
  return 'doc';   // EPUB and other DOC-app formats → generateDocImage
}

async function resolveTotal(kind, notePath) {
  let total;
  if (kind === 'note') {
    total = unpack(await settle(PluginFileAPI.getNoteTotalPageNum(notePath)).then(r => r.val)).val;
  } else {
    total = unpack(await settle(PluginDocAPI.getCurrentTotalPages()).then(r => r.val)).val;
    if (typeof total !== 'number' || total < 1) {
      total = unpack(await settle(PluginFileAPI.getNoteTotalPageNum(notePath)).then(r => r.val)).val;
    }
  }
  return (typeof total === 'number' && total > 0) ? total : null;
}

// Annotated pages: documents expose a mark layer (getMarkPages); notes don't, so
// we treat any page with ≥1 element as "annotated".
async function resolveAnnotatedPages(kind, notePath, total) {
  if (kind !== 'note') {
    const marks = unpack(await settle(PluginFileAPI.getMarkPages(notePath)).then(r => r.val)).val;
    if (Array.isArray(marks) && marks.length) return [...new Set(marks)].sort((a, b) => a - b);
  }
  const pages = [];
  for (let p = 0; p < total; p++) { if (await pageElementCount(notePath, p) > 0) pages.push(p); }
  return pages;
}

// ─── Public: export a colour PDF (one PDF page per document page) ─────────────

/**
 * @param {object}   opts
 * @param {'full'|'annotated'|'new'} opts.mode  page scope.
 * @param {function} [opts.onProgress]   (done, total) callback.
 */
export async function runExport({ mode = 'full', onProgress } = {}) {
  const renderer = NativeModules.CombinedColorPdfRenderer;
  if (!renderer || !renderer.drawColoredShapes || !renderer.overlayColoredStrokes || !renderer.assemblePdf) {
    throw new Error('CombinedColorPdfRenderer native module not found. Is the plugin installed correctly?');
  }

  const exportDir = await FileUtils.getExportPath();
  if (!exportDir) throw new Error('Cannot resolve EXPORT directory');
  await FileUtils.makeDir(exportDir);
  const EXPORT = exportDir.replace(/\/+$/, '');

  const notePath = unpack(await PluginCommAPI.getCurrentFilePath()).val;
  if (!notePath) throw new Error('getCurrentFilePath failed — open a document first');
  const baseName = deriveBaseName(notePath);
  const kind = detectKind(notePath);

  const total = await resolveTotal(kind, notePath);
  if (total == null) throw new Error('Could not determine page count');

  // Resolve the page list for the chosen mode.
  let pages;
  if (mode === 'full') {
    let t = total;
    if (MAX_PAGES > 0 && t > MAX_PAGES) t = MAX_PAGES;
    pages = Array.from({ length: t }, (_, i) => i);
  } else {
    const annotated = await resolveAnnotatedPages(kind, notePath, total);
    if (mode === 'new') {
      const state = await readExportState(renderer, EXPORT, baseName);
      pages = [];
      for (const p of annotated) {
        const count = await pageElementCount(notePath, p);
        const prev = state.pages[String(p)];
        if (prev == null || count > prev) pages.push(p);
      }
      if (pages.length === 0) throw new Error('No pages with new annotations since your last export of this book.');
    } else {
      pages = annotated;
      if (pages.length === 0) throw new Error('No annotated pages found on this document.');
    }
  }

  const sidecar = await readSidecar(renderer, EXPORT, baseName);

  // Notes must be flushed to disk before generateNotePng/getElements.
  if (kind === 'note') { try { await PluginNoteAPI.saveCurrentNote(); } catch {} }

  const stamp = Date.now();
  const pluginDir = await PluginManager.getPluginDirPath();
  const tmpDir = `${(pluginDir || EXPORT).replace(/\/+$/, '')}/cpdf-${stamp}`;
  await FileUtils.makeDir(tmpDir);

  const pagePngPaths = [];
  let totalStrokes = 0, coloredCount = 0, skipped = 0, done = 0;

  try {
    for (const page of pages) {
      const sz = unpack(await settle(PluginFileAPI.getPageSize(notePath, page)).then(r => r.val));
      const size = (sz.ok && sz.val?.width) ? sz.val : { width: 1404, height: 1872 };

      const contentPng = `${tmpDir}/base-${String(page).padStart(4, '0')}.png`;
      const outPng      = `${tmpDir}/page-${String(page).padStart(4, '0')}.png`;

      let r;
      if (kind === 'note') {
        r = await colorNotePage(renderer, notePath, page, size, sidecar, contentPng, outPng);
      } else if (kind === 'pdf') {
        r = await colorDocPage(renderer, notePath, page, size, sidecar, contentPng, outPng,
          async (png, s) => { const x = await settle(renderer.renderDocPage(notePath, page, s.width, s.height, png)); return { ok: x.ok, err: x.err }; });
      } else {
        r = await colorDocPage(renderer, notePath, page, size, sidecar, contentPng, outPng,
          async (png, s) => { const x = unpack(await settle(PluginDocAPI.generateDocImage(notePath, page, png, s)).then(y => y.val)); return { ok: x.ok && x.val !== false, err: x.err }; });
      }

      done++;
      onProgress?.(done, pages.length);
      if (!r.ok) { skipped++; await settle(FileUtils.deleteFile(contentPng)); continue; }
      totalStrokes += r.totalStrokes;
      coloredCount += r.coloredCount;
      pagePngPaths.push(outPng);
    }

    if (pagePngPaths.length === 0) throw new Error('No pages rendered.');

    const outPath = `${EXPORT}/color_${baseName}_${mode}_${stamp}.pdf`;
    await renderer.assemblePdf(pagePngPaths, outPath);

    // Refresh the "new annotations" baseline for every currently-annotated page.
    try {
      const annotatedNow = await resolveAnnotatedPages(kind, notePath, total);
      const snapshot = { lastExport: stamp, pages: {} };
      for (const p of annotatedNow) snapshot.pages[String(p)] = await pageElementCount(notePath, p);
      await writeExportState(renderer, EXPORT, baseName, snapshot);
    } catch {}

    return { path: outPath, pages: pagePngPaths.length, totalStrokes, coloredCount, skipped, mode, kind };

  } finally {
    for (const p of pagePngPaths) { try { await FileUtils.deleteFile(p); } catch {} }
    try { await FileUtils.deleteDir(tmpDir); } catch {}
  }
}
