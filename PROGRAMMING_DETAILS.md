# ExportColorPDF (ExportColorPDFCombined / ECP) — Programming Details

Technical reference: file layout, what each function does, the native renderer, the SDK calls, and the build.

---

## Project layout
```
ExportColorPDFCombined/
├── index.js                          ← entry: button + opens the export UI
├── src/
│   ├── App.tsx                       ← export options UI (mode/format/page-spec) → runExport
│   └── exporter.js                   ← ALL pipeline logic (detect, read sidecars, render, assemble)
├── app.json / PluginConfig.json      ← pluginKey, reactPackages (CombinedColorPdfRenderer)
├── buildPlugin.sh
└── android/app/
    ├── src/main/java/com/exportcolorpdfcombined/
    │   ├── MainApplication.kt
    │   ├── MainActivity.kt
    │   ├── ColorPdfRendererModule.kt  ← native rendering (getName "CombinedColorPdfRenderer")
    │   └── ColorPdfRendererPackage.kt
    ├── build.gradle                  ← R8 minify on debug + keep-rules
    └── proguard-rules.pro            ← keep com.exportcolorpdfcombined.** / com.ratta.** / RN
```

---

## `src/exporter.js` — what each part does

### Constants / colour helpers
- `HIGHLIGHTER_HEXES` (Set) + `isHighlightColor(hex)` — the genuine highlighter shades that render as a translucent wash. Everything else renders opaque.
- `WASH_PEN_TYPES = {11}` — marker is the washable pen type.
- `deriveBaseName(notePath)` — sidecar base name. **Must equal CCP `_sanitizeBaseName` and MarkerSize `_baseName`.**
- `isArgbColor` / `greyFromPenColor` / `argbToHex` — native `penColor` int → grey / hex conversions for un-recoloured strokes.
- `NATIVE_MARKER_THICKNESS = 3800`, `NATIVE_MARKER_PX = 28` — native marker reference.
- `sizeThicknessToPx(thickness)` — recorded thickness → export stroke width in pixels (scaled off the native reference).

### Plumbing
- `settle(promise)` / `unpack(resp)` — normalise the SDK's `{ok,val,err}` responses.
- `pageElementCount` / `readExportState` / `writeExportState` / `exportStatePath` — the "new annotations since last export" baseline (incremental/"new only" mode).

### Geometry fingerprint
- `strokeGeomKey(el)` — async. `"{penColor}_{penType}|{n}|{≤9 sample points}|{bbox}"`. **Byte-identical to CCP `_strokeGeomKey` and MarkerSize `_strokeGeomKey`** — the shared key that lets a record resolve across orientations.

### Sidecar reads (consume CCP + MarkerSize output)
- `readSidecar(renderer, exportDir, base)` — reads `.ccp/{base}_colors.json` → `{byGeom, byUuid, byIndex}` (colours).
- `readSizeSidecar(renderer, exportDir, base)` — reads `.msz/{base}_sizes.json` → `{byGeom, byIndex}` (sizes).
- `resolveColor(el, page, sidecar, geomKey, allowIndex)` — geom → (uuid) → byIndex lookup, gated by `allowIndex`. Returns the hex or null.
- `resolveSize(el, page, sizeSidecar, geomKey, allowIndex)` — same resolution order for thickness. **Same gating as `resolveColor`** so colour and size stay in lock-step.

### Marker geometry
- `buildMarkerCenterline(el, pageSize, xform)` — async. Reads the stroke's EMR centerline (`stroke.points`), runs each point through `PointUtils.emrPoint2Android(point, pageSize)` (EMR→pixel, handles rotation), applies the page `xform` if present, returns a pixel polyline. This is the path the native renderer strokes for a sized/coloured marker. **Subsamples to ≤48 points** (`MAX_PTS`) — converting every raw point (~300/marker) through `emrPoint2Android` cost ~1.5 s per marker.

### Shape building (the core)
- `buildDocShapes(elements, page, sidecar, drawUncolored, xform=null, sizeSidecar=null, pageSize=null)` — async. For each stroke:
  - compute `geomKey`; `resolveColor` + `resolveSize`.
  - **markers (sized or coloured)** → push to `strokeLines[]`: `{ color: drawColor, wash: isHighlightColor(drawColor), width: sizeThicknessToPx(thickness), points: centerline }`. Regular colours are **opaque**; highlighter shades carry `wash:true`.
  - **pens / coloured non-markers** → push to `docShapes[]` (contour polygons via `readContourPolys`).
  - `drawUncolored=true` (notes) draws *every* stroke, recoloured or not; `hasGeom` triggers when there's a colour **or** size record.
  - Returns `{ docShapes, strokeLines, totalStrokes, coloredCount, annMaxX, annMaxY }`.
- `renderShapesAndStrokes(renderer, contentPng, docShapes, strokeLines, outPng)` — the **ordering rule**:
  1. `drawColoredStrokeLines(contentPng, strokeLines, tmp)` — **markers first** (transparent underneath),
  2. `drawColoredShapes(tmp, docShapes, outPng)` — **pens/colours over the top** (stay crisp).

### Page pipelines
- `colorNotePage(...)` — **render-like-docs**: base = `PluginFileAPI.generateNoteTemplatePng(notePath, page, contentPng)` (template only, no ink) → `buildDocShapes(..., drawUncolored=true, ...)` → `renderShapesAndStrokes`. Fallback: `generateNotePng` + `drawUncolored=false` if the template render fails. This is what makes every marker see-through on notes (the old `whiteOutMarkers` path is now dormant but kept).
- `colorDocPage(..., renderBase)` — for PDFs/EPUBs: base = the rendered page (`renderBase` callback: `renderDocPage` for pdf, `generateDocImage` for EPUB/doc), then the same `buildDocShapes` + `renderShapesAndStrokes` — with the landscape-shrink `xform` applied when the page overflowed (see **Landscape shrink** below; `xform` is `null` for a normal portrait page).

### Landscape shrink (every page exports portrait)
- `annotationExtent(elements, pageSize)` — async. Bounding box of every stroke's `contoursSrc` **plus every marker's centreline** (`buildMarkerCenterline(el, pageSize, null)` for `penType == 11`). Including the centreline is **load-bearing**: a marker draws from its EMR centreline, which on a shrunk page lands in a *different* pixel frame than its contour — leave it out and the centring box doesn't cover the marker, so it clips off the edge. *(This was the last and hardest landscape bug.)*
- `landscapeShrinkFactor(elements, size)` — async → `{ s, ext }`. `s = size.width / size.height` (≈0.75) when the extent overflows the page by >20 px **and** the page is portrait (`height > width`); otherwise `s = 1`. The 0.75 is the device's own portrait-reflow ratio — verified: held-portrait vs held-landscape extents differ by a uniform 0.75 on both axes.
- **Applied in `colorDocPage` (PDF/EPUB) and `colorNotePage` (note).** When `s < 1`: `scale = min(s, (W-2·PAD)/cw, (H-2·PAD)/ch)` (`PAD = 30`; `cw,ch` = content box from `ext`); `offX,offY` map the content box to the page centre; `xform = q → (q.x·scale+offX, q.y·scale+offY)`. Notes compose this with the template base-scale `sx/sy`. The factor is passed as `buildDocShapes(..., strokeWidthScale = widthScale)` so **sized markers thin to match** (`widthScale = scale` for docs, `scale·√(sx·sy)` for notes) — they no longer drop out when shrunk. Scale-to-FIT-and-CENTRE replaced an earlier scale-about-origin, which clipped left-overflowing writing.
- **Why not rotate / matte (both removed in v2.5):** *Rotate* (turn the base 90° + rotate every stroke) failed because the device reflows landscape geometry back to portrait the instant `getElements` reads it on a portrait-held export — destroying the orientation signal — while a landscape-held read needs no rotation at all. *Matte* (draw the page upright on a bigger landscape canvas, writing in the margin) failed because the landscape frame is wider than the portrait page, so right-side writing always landed past the doc edge. The dead JS (`colorDocPageLandscape`, `colorDocPageMatte`, `analyzeOrientation`, `classifyStroke`, `sampleStrokePoints`, `portraitEmrBounds`) was pruned; the native `rotatePng90` / `matteBitmap` methods are now unused.

### Orchestration
- `detectKind(notePath)` — `'note'` / `'pdf'` / `'doc'` (EPUB and other DOC-app formats → `generateDocImage`).
- `resolveTotal` / `resolveAnnotatedPages` / `parsePageSpec` — page count, which pages have ink, and page-spec parsing for the three modes.
- `runExport({ mode, format, pngMode, pageSpec, onProgress })` — the entry the UI calls:
  1. resolve renderer + export dir + `baseName`,
  2. `detectKind`, `resolveTotal`, build the page list (full / new-only / spec),
  3. read **both** sidecars once: `sidecar` (colours) + `sizeSidecar` (sizes),
  4. for each page → `colorNotePage` or `colorDocPage`,
  5. assemble (`assemblePdf` or per-page / `stitchPngVertical` PNG), refresh the export-state baseline, return a summary `{path, pages, totalStrokes, coloredCount, …}`.

---

## Native renderer (`ColorPdfRendererModule.kt`, `getName "CombinedColorPdfRenderer"`)
`@ReactMethod`s:
| Method | Role |
|---|---|
| `drawColoredStrokeLines(basePng, strokesArray, out)` | **markers** — `Canvas.drawPath`, `Paint.STROKE`, ROUND cap/join; `if (wash) paint.alpha = 115`; single-point stroke → `drawCircle`. Drawn first. |
| `drawColoredShapes(basePng, shapesArray, out)` | **pens / coloured contours** — fills contour polygons in their colour. Drawn over the strokes. |
| `whiteOutMarkers(base, templatePng, eraseContours, keepContours, out)` | DORMANT — old note path: BitmapShader(template) FILL of erase-path + 8px STROKE to dilate past the contour AA ring, keep-path `Region.Op.DIFFERENCE` to spare pens. Superseded by render-like-docs; kept for fallback. |
| `overlayColoredStrokes` | overlay helper. |
| `renderDocPage(notePath, page, w, h, out)` | rasterise a PDF page as the doc base. |
| `pngInfo` / `writeFile` / `readFile` | image dims + sidecar/file I/O. |
| `assemblePdf(pngPaths, out)` | stitch page PNGs into the final PDF. |
| `stitchPngVertical(pngPaths, out)` | combined-PNG mode. |
- `pathFromContours(ReadableArray): Path` — helper turning a contour array into an Android `Path`.

---

## SDK calls used
| Call | Why |
|---|---|
| `PluginFileAPI.getElements(page, notePath)` | read strokes for a page |
| `PluginFileAPI.generateNoteTemplatePng(...)` | note base = template only (render-like-docs) |
| `PluginNoteAPI.saveCurrentNote()` | flush pending ink before export |
| `PluginDocAPI.generateDocImage(...)` | EPUB/doc page base |
| `PointUtils.emrPoint2Android(point, pageSize)` | EMR→pixel for marker centerlines (handles rotation) |
| `el.stroke.points` / `el.contoursSrc` | centerline (markers) / outline (pens) |
| `FileUtils.getExportPath()` / `deleteFile` | export dir + temp cleanup |
| `NativeModules.CombinedColorPdfRenderer` | all native rendering + file I/O |

---

## Build & packaging
- `buildPlugin.sh` → Metro bundle + debug native APK → `ExportColorPDF.snplg` (the deliverable filename; `PLUGIN_KEY`/bundle/package stay `ExportColorPDFCombined`).
- **R8 minification ON** (`minifyEnabled true` + `shrinkResources true` on the debug build type). `proguard-rules.pro` keeps `com.exportcolorpdfcombined.**` (PluginHost loads the renderer package by FQN), `com.ratta.**`, and `@ReactMethod`/`@ReactModule` members. Native `.so` stripped at package time (PluginHost provides the RN runtime).
- Working non-minified build backed up at `/Users/laurienuzzo/supernote-github/_nonminified_backup/ExportColorPDFCombined.snplg.bak`.

---

## Key invariants (don't break)
1. `strokeGeomKey` ≡ CCP `_strokeGeomKey` ≡ MarkerSize `_strokeGeomKey` (byte-for-byte).
2. `deriveBaseName` ≡ CCP `_sanitizeBaseName` ≡ MarkerSize `_baseName`.
3. Read `.ccp/{base}_colors.json` `{byGeom,byUuid,byIndex}` and `.msz/{base}_sizes.json` `{byGeom,byIndex}` — these are the contracts.
4. **Render order is load-bearing:** strokeLines (markers) first, docShapes (pens) second.
5. `resolveColor` and `resolveSize` use the same geom→byIndex gating — keep them in step.
6. Never mutate the note or either sidecar; ECP is read-only on its inputs.
7. Keep `com.exportcolorpdfcombined.**` in the proguard keep-rules.
