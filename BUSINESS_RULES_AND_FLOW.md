# ExportColorPDF (ECP / ExportColorPDFCombined) — Business Rules & Process Flow

## Purpose
ExportColorPDF produces a **colour PDF** of a Supernote note, document, or EPUB — applying the colours recorded by **CustomColorPalette** and the marker sizes recorded by **MarkerSize**. The Supernote screen is grayscale; this plugin is where colour and custom marker width actually become visible.

It is the **rendering** member of the three cooperating plugins:
- **ExportColorPDF (ECP)** — reads both sidecars and renders the final coloured + sized export (this plugin).
- **CustomColorPalette (CCP)** — records each stroke's *colour* → `.ccp/{base}_colors.json`.
- **MarkerSize** — records each marker's *size* → `.msz/{base}_sizes.json`.

"Combined" = one plugin that handles three source types: native **notes**, imported **PDFs/docs**, and **EPUBs** (each detected and routed to its own pipeline).

---

## Business Rules

1. **Three source types, one chooser.** On launch the plugin detects the open file's type (note / PDF-doc / EPUB) and runs the matching pipeline. The output is always a colour PDF in the export folder.
2. **Colour is opt-in, native is the default.** A stroke is recoloured only if CCP recorded a colour for it. Strokes with no record render in their native (grey/black) pen colour.
3. **Resolve colour and size the same way.** For each stroke ECP looks up the sidecar by **geometry fingerprint** first, then by **position** (`byIndex = "page_numInPage"`). The geom key is byte-identical to CCP's and MarkerSize's, so a record made in one orientation still resolves after a landscape↔portrait export.
4. **Marker rendering — full intensity, except true highlighters.**
   - Regular marker colours render **opaque** (same intensity as a regular pen of that colour).
   - Only the genuine **highlighter** shades render as a translucent **wash** (so they read as a highlight, not a solid block). `isHighlightColor()` decides which.
5. **All markers are "transparent underneath."** Every marker — resized or native, recorded or not — is rendered so it does not paint a solid opaque slab. Markers are drawn **first**, then pens/colours are drawn **over the top**, so a pen stroke crossing a marker stays crisp and on top.
6. **Marker size comes from the sidecar.** A marker with a recorded size is drawn at that width (`thickness → export pixels`). With no record it draws at the native marker width. Size and colour are independent — a marker can be both resized and recoloured.
7. **No source mutation.** ECP only reads the note + the two sidecars and writes a new PDF/PNG. It never changes the note or the sidecars.
8. **Notes render like docs.** A note page is rebuilt from its **template only** (no baked-in ink) and then **all** annotations are drawn by ECP. This is what makes every marker see-through and lets colour/size apply uniformly (it replaced an older "white-out the markers" approach, now dormant).
9. **Filename contract.** ECP derives the sidecar base name with `deriveBaseName`, which must equal CCP's `_sanitizeBaseName` and MarkerSize's `_baseName`, or records won't be found.
10. **Landscape pages are shrunk to fit — every page exports portrait.** The device stores no per-page orientation flag. When a page was written with the device held **landscape**, its ink comes back in the page's landscape frame and overflows the portrait page. ECP detects that overflow and shrinks the writing by the page's short/long ratio (`pageW/pageH` ≈ 0.75 on A5X — the *same* ratio the device uses for its own portrait reflow), then **centres** the whole composition so nothing clips. The result matches what a portrait-held export produces, so **every page comes out portrait** either way; held-portrait pages already fit, so `s = 1` and nothing changes. **Sized markers are shrunk too** — their width scales by the same factor so they thin to match instead of dropping out. Portrait stays the recommended posture; landscape export is supported (this shrink is what makes a landscape-held export come out right), with minor anomalies in sized-marker placement. The overflow is only *visible* while the device is **held in landscape** during export — a portrait-held export has already let the device reflow the ink onto the page before ECP sees it.

---

## Data Read
- `{EXPORT}/.ccp/{base}_colors.json` — `{ byGeom, byUuid, byIndex }` → hex colours (from CCP).
- `{EXPORT}/.msz/{base}_sizes.json` — `{ byGeom, byIndex }` → thickness (from MarkerSize).
- The note/doc/EPUB itself (strokes, templates, pages).

## Data Written
- The colour PDF (and intermediate PNGs) in the export folder.

---

## Process Flow

### Top level
```
User runs ExportColorPDF
        │
        ▼
runExport(): detect file type ──► note / PDF-doc / EPUB pipeline
        │
        ├─ read colour sidecar  (.ccp/{base}_colors.json)
        ├─ read size sidecar    (.msz/{base}_sizes.json)
        ▼
For each page: render coloured + sized content ──► assemble PDF
```

### Per page (note pipeline — `colorNotePage`)
```
base image = template ONLY  (generateNoteTemplatePng — no ink)
        │
        ▼
buildDocShapes(elements, page, colorSidecar, drawUncolored=true, xform, sizeSidecar, pageSize)
   • for every stroke resolve colour (geom → byIndex) and size (geom → byIndex)
   • SIZED / coloured MARKERS  → strokeLines[]  (centerline + width + wash flag)
   • PENS and coloured non-markers → docShapes[]
        │
        ▼
renderShapesAndStrokes():
   1) drawColoredStrokeLines(base, strokeLines)   ← markers first (transparent underneath)
   2) drawColoredShapes(tmp, docShapes)           ← pens/colours OVER the top
        │
        ▼
coloured page PNG
```

### Per page (doc pipeline — `colorDocPage`)
```
base image = the rendered PDF page (already has its background)
        │
        ▼
same buildDocShapes + renderShapesAndStrokes
   (xform = the landscape-shrink transform when the page overflowed, else none)
```

### Landscape pages (shrink + centre — applies to both pipelines)
```
landscapeShrinkFactor(elements, size) → { s, ext }
   • ext = annotationExtent(...) = union of every stroke's contours
           AND every marker's centreline (emrPoint2Android).
           The centreline lands in a DIFFERENT pixel frame than its
           contour, so it MUST be in the box or markers clip off the edge.
   • overflow? (ext beyond the page by >20px, portrait pages only)
         → s = pageW / pageH   (≈0.75 — the device's own reflow ratio)
         → else  s = 1         (held portrait / already fits → no change)
        │
        ▼  (only when s < 1)
scale = min( s, (pageW-2·PAD)/cw, (pageH-2·PAD)/ch )   PAD = 30
offX,offY = centre the content's bounding box on the page
xform = q → (q.x·scale + offX,  q.y·scale + offY)
   • notes compose this with the template base-scale (·sx, ·sy)
   • sized markers stay ON: width scaled by the same factor (widthScale)
        │
        ▼
buildDocShapes(..., xform, ..., strokeWidthScale) → a normal PORTRAIT page
```

### Marker geometry (sized markers)
```
buildMarkerCenterline(el, pageSize, xform):
   stroke.points (EMR centerline)
        │  PointUtils.emrPoint2Android(point, pageSize)   ← EMR → pixels (handles rotation)
        ▼
   apply page xform (if any) ──► pixel polyline
        │
        ▼
   drawn natively with Canvas.drawPath (ROUND cap/join);
   single-point strokes → drawCircle;  highlighter shades → alpha 115
```

---

## Rendering precedence (why order matters)
1. **Markers first** (`drawColoredStrokeLines`) — laid down as translucent/coloured strokes underneath.
2. **Pens and coloured shapes second** (`drawColoredShapes`) — painted on top, so regular pen strokes always sit above marker fills and stay sharp.

This ordering is the mechanism behind rules 4 and 5: it gives every marker a see-through look while keeping pens crisp.

---

## What ECP does **not** do
- It does not record colours (CCP does) or sizes (MarkerSize does).
- It does not modify the note, the templates, or either sidecar.
- It does not change anything on the device screen — it only produces the export file.

## Landscape export — supported, with caveats
- **Verified working (2026-06-14).** Landscape-authored pages export correctly: the writing is shrunk-to-fit and centred on a normal portrait page, with sized markers included (see Rule 10 and the flow above).
- **Two earlier approaches were tried and abandoned** (their dead code was removed in v2.5):
  - **Rotate** — turn the base 90° and rotate every stroke into a landscape frame. Failed because the device reflows landscape geometry back to portrait the instant `getElements` reads it (on a portrait-held export), destroying the orientation signal; and a landscape-held read needs no rotation at all.
  - **Matte** — draw the page upright on a larger landscape canvas with the off-page writing in the margin. Failed because the landscape frame is wider than the portrait page, so right-side writing always landed past the doc edge — a frame mismatch no bigger canvas fixes.
- **Portrait is the recommended posture** — it renders correctly with no shrink needed. Landscape export is supported for users who hold the device that way; sized-marker placement/width can still drift slightly because they derive from `emrPoint2Android` + the shrink `xform`.
- **To export pages that contain landscape (off-page) writing, hold the device in landscape.** A portrait-held export lets the device squish that ink back onto the page before ECP reads it, so the overflow — and therefore the shrink — can't be detected (the device's own reflow still yields a readable portrait page).
