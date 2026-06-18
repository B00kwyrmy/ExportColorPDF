// digestHuntProbe.js — finds digest/bracket entries in the OPEN document.
// RUN WITH THE PDF/EPUB OPEN (the one with bracketed text, e.g. "How to do
// things you hate"). Read-only.
//
// Scans every page for TYPE_TEXT_DIGEST_QUOTE(501)/CREATE(502) elements and
// getKeyWords, dumps their text, and correlates against a known phrase so we can
// confirm we can read bracketed/highlighted text directly. Writes a report to EXPORT.

import { NativeModules } from 'react-native';
import { FileUtils, PluginCommAPI, PluginDocAPI, PluginFileAPI } from 'sn-plugin-lib';

const NEEDLE = 'accept yourself unconditionally'; // your page-6 example
const MAX_PAGES = 30;

function unwrap(r) { if (r && typeof r === 'object' && 'success' in r) return r.success ? { ok: true, val: r.result } : { ok: false, err: r.error }; return { ok: true, val: r }; }
async function safe(p) { try { return unwrap(await p); } catch (e) { return { ok: false, err: e instanceof Error ? e.message : String(e) }; } }
function findApi(n, apis) { for (const a of apis) if (a && typeof a[n] === 'function') return a; return null; }
async function call(n, args, apis) { const o = findApi(n, apis); if (!o) return { ok: false, err: `'${n}' not found`, via: null }; const r = await safe(o[n](...args)); r.via = o.__n || '?'; return r; }
function fmt(r) { if (r.ok) return `OK via ${r.via}`; const c = r.err && (r.err.code ?? r.err); return c === 102 ? `BLOCKED 102 via ${r.via}` : `error via ${r.via}: ${JSON.stringify(r.err)}`; }
function baseName(p) { const l = (p || 'doc').split('/').pop() || 'doc'; return l.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '_') || 'doc'; }

export async function runDigestHuntProbe() {
  const renderer = NativeModules.CombinedColorPdfRenderer;
  const APIS = [PluginFileAPI, PluginDocAPI, PluginCommAPI];
  PluginFileAPI && (PluginFileAPI.__n = 'PluginFileAPI');
  PluginDocAPI && (PluginDocAPI.__n = 'PluginDocAPI');
  PluginCommAPI && (PluginCommAPI.__n = 'PluginCommAPI');
  const report = { when: new Date().toISOString(), pages: {} };
  const L = []; const log = (s) => L.push(s);

  const cur = (await safe(PluginCommAPI.getCurrentFilePath())).val;
  log(`DIGEST HUNT  ${report.when}`);
  log(`document: ${cur}`);
  if (!cur) throw new Error('Open the PDF/EPUB with the brackets first.');

  let total = (await call('getCurrentTotalPages', [], APIS)).val;
  if (typeof total !== 'number' || total < 1) total = (await call('getNoteTotalPageNum', [cur], APIS)).val;
  const marks = (await call('getMarkPages', [cur], APIS)).val;
  const markArr = Array.isArray(marks) ? marks : [];
  log(`total pages: ${total}   markPages: [${markArr.join(', ')}]`);

  const upTo = Math.min(typeof total === 'number' ? total : MAX_PAGES, MAX_PAGES);
  const pages = [...new Set([...Array.from({ length: upTo }, (_, i) => i), ...markArr])].sort((a, b) => a - b);
  log(`scanning pages (0-based): [${pages.join(', ')}]`);

  // getKeyWords for ALL pages at once (earlier we only passed a few).
  const kwAll = await call('getKeyWords', [cur, pages], APIS);
  log(`getKeyWords(ALL pages) → ${kwAll.ok ? JSON.stringify(kwAll.val).slice(0, 600) : fmt(kwAll)}`);
  report.getKeyWordsAll = kwAll;
  log('');

  let foundDigest = false, foundNeedlePage = -1;
  for (const page of pages) {
    const pg = {};
    const elsR = await call('getElements', [page, cur], APIS);
    const els = Array.isArray(elsR.val) ? elsR.val : [];
    const histo = {}; for (const e of els) histo[e?.type] = (histo[e?.type] || 0) + 1;
    pg.histo = histo;

    // Fully dump digest elements (501 quote / 502 create) — the bracket text.
    const digests = [];
    for (const e of els) {
      if (e?.type === 501 || e?.type === 502) {
        const tb = e.textBox || {};
        digests.push({ type: e.type, numInPage: e.numInPage, text: tb.textContentFull ?? null, rect: tb.textRect ?? null });
        foundDigest = true;
      }
      e.recycle?.();
    }
    pg.digests = digests;

    // doc text + needle search
    const dt = (await call('getCurrentDocText', [page], APIS)).val;
    const hasNeedle = typeof dt === 'string' && dt.toLowerCase().includes(NEEDLE);
    if (hasNeedle && foundNeedlePage < 0) foundNeedlePage = page;

    const line = `p${page} (shown ${page + 1}): types ${JSON.stringify(histo)}` +
      (digests.length ? `  ★ DIGESTS: ${JSON.stringify(digests.map(d => ({ t: d.type, text: d.text })))}` : '') +
      (hasNeedle ? `  ⟵ docText contains the example phrase` : '');
    log(line);
    report.pages[page] = pg;
  }

  log('');
  log(`RESULT: digest elements found: ${foundDigest ? 'YES ✅' : 'NO'} ; example phrase seen in docText on page: ${foundNeedlePage >= 0 ? foundNeedlePage : 'not found'}`);
  if (foundDigest) log('→ Bracketed/highlighted text is readable as real text via 501/502 elements. We can extract it directly.');
  else if (kwAll.ok && Array.isArray(kwAll.val) && kwAll.val.length) log('→ No 501/502 elements, but getKeyWords returned data — digests may live there instead. See getKeyWords dump above.');
  else log('→ No digests surfaced via getElements or getKeyWords. They may need a different API or the brackets were not converted. Tell me what you see on the page.');

  const exportDir = (await FileUtils.getExportPath() || '').replace(/\/+$/, '');
  const base = baseName(cur); const stamp = Date.now();
  const summary = L.join('\n');
  try { await renderer.writeFile(`${exportDir}/digesthunt_${base}_${stamp}.json`, JSON.stringify(report, null, 2)); } catch {}
  try { await renderer.writeFile(`${exportDir}/digesthunt_${base}_${stamp}.txt`, summary); } catch {}
  return summary;
}
