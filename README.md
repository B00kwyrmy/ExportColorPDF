# Export Color PDF (Combined)

One plugin that exports the current document as a **full-color PDF**, for **all
three** Supernote document types — auto-detected. Replaces the separate
ExportColorPDF (notes/PDF) and ExportEPUBtoColorPDF plugins.

Per-stroke colours come from the **Custom Color Palette** plugin's sidecar
(`{EXPORT}/.ccp/{base}_colors.json`). Output: `{EXPORT}/color_{base}_{mode}_{stamp}.pdf`,
one PDF page per document page.

## Flow

1. **Chooser** (full-screen): pick a page scope —
   - **Annotated pages only** — pages that carry marks.
   - **Pages with new annotations** — annotated pages whose stroke count grew
     since the last export (snapshot in `{base}_exportstate.json`; the SDK has no
     per-stroke timestamp, so "new" is relative to your last export).
   - **Entire document** — every page (`MAX_PAGES`, 0 = all).
2. **Detect type** from the file path.
3. **Render + colour per page**, then assemble a multi-page PDF.

## Per-type pipeline (`src/exporter.js`)

| Type | Base render | Colour overlay |
|------|-------------|----------------|
| `.note` | `PluginFileAPI.generateNotePng` | `overlayColoredStrokes` — distance-band tint (opaque pen) / wash (marker), EMR→pixel segments |
| `.pdf`  | native `renderDocPage` (Android `PdfRenderer`) | `drawColoredShapes` — fill annotation contours on top |
| `.epub` / other doc | `PluginDocAPI.generateDocImage` | `drawColoredShapes` |

Shared: colour resolution (`byUuid` → `byIndex` → legacy ARGB → `penPrefs`) and
the colour-driven wash rule (marker, penType 11, + a highlighter colour → wash;
everything else opaque). Annotated pages come from `getMarkPages` for docs; for
notes, any page with ≥1 element.

## Source

- `index.js` — registers the toolbar button (showType:1) and emits
  `colorPdfExportReset` on each press so the chooser re-arms (PluginHost re-shows
  the same component without remounting; `closePluginView` only hides it).
- `src/App.tsx` — chooser UI + progress + result (shows detected type).
- `src/exporter.js` — `runExport({mode, onProgress})`: detect type, select pages,
  render+colour, assemble, refresh the new-annotations snapshot.
- `android/.../ColorPdfRendererModule.kt` — native module `CombinedColorPdfRenderer`:
  `overlayColoredStrokes`, `renderDocPage`, `drawColoredShapes`, `assemblePdf`,
  `pngInfo`, `readFile`/`writeFile`.

Distinct identity (`pluginID` `ecpc01combinedv1xm`, `applicationId`
`com.exportcolorpdfcombined`, native module `CombinedColorPdfRenderer`) so it
coexists with the two originals during testing.

## Build / deploy

```bash
bash buildPlugin.sh   # → build/outputs/ExportColorPDFCombined.snplg  (needs ANDROID_HOME)
/Users/laurienuzzo/adb -s SN078C10032421 push build/outputs/ExportColorPDFCombined.snplg /storage/emulated/0/MyStyle/
```
