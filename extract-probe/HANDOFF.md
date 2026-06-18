# DocAnnotationsToNote — Handoff / Status

Working notes for the planned **DocAnnotationsToNote** Supernote plugin (extract a
marked-up PDF/EPUB's annotations into a note). Captured so a fresh (local
Terminal) Claude Code session can pick up without the chat transcript.

## Goal
After annotating a PDF/EPUB, copy the marked material into a note:
- highlighted / underlined / circled / bracketed text, and free-written notes,
- in document (reading) order, each non-contiguous piece separated,
- same page-scope options as the ExportColorPDF plugin (current / pages / annotated / new / entire).

## Requirement updates (latest)
1. **Three blank lines between entries** (not one).
2. **Capture real Docs-highlighter text too**, in its own **alt-yellow** (distinct
   from marker-yellow `#FAEDCB`). In Docs the highlighter behaves like brackets:
   lifting it converts the highlighted text into a **digest** entry — so the
   underlying text should be readable from the digest (see open items).
3. (pending — user will provide.)

## What the probes proved (SDK = sn-plugin-lib 0.1.43, RN 0.79.2)
- **No `createNote` for us** — host-blocked (`code 102`). So the **user creates the
  note**; the plugin fills it.
- **Authoring into an existing note WORKS in note context** (the earlier 102s were
  because we ran from a PDF):
  - `insertNotePage({notePath,page,template})` OK — templates from
    `getNoteSystemTemplates()` (e.g. `style_white`, `style_blank`); each has
    `vUri`/`hUri` (portrait/landscape).
  - `insertImage(pngPath)` OK — **current page only**.
  - `insertText(textBox)` OK — current page; textBox passed **directly** (not wrapped).
  - **`insertElements(notePath,page,[el])` OK and path+page addressed** — works for
    **strokes AND PICTURE elements**, so we can place everything without the
    page-flip dance. (Set `pageNum >= 0`; a read-back element had `pageNum:-1` → 107.)
- **PICTURE element shape:** `{ type:200, picture:{ picturePath, rect /*EMR*/ }, ... }`,
  built via `PluginCommAPI.createElement(200)`. Page bounds ≈ EMR 15819 × 11864.
- **Text under marks is NOT positioned:** `getCurrentDocText(page)` returns a flat
  string (reading order, no coords). `getLassoText`/`getLastSelectedText` are
  interactive-only. So highlight/underline/circle → **image clips**, UNLESS digests
  give the text (open item).
- File picker exists: `RattaFileSelector.selectFile({selectType:1, suffixList:['pdf','epub'], maxNum:1, title})` → returns absolute path(s).

## Validated architecture
- **Run the plugin from the (user-created) target note.**
- File-pick the source PDF/EPUB; read it **by path** (`getElements`, `getMarkPages`,
  and our native `renderDocPage` all take an explicit path — cross-context read still
  to be confirmed, see open items).
- Lay out via `insertElements` in reading order, appending pages (`insertNotePage`,
  `style_white`) as needed:
  - handwriting → **stroke** elements (copied),
  - highlight/underline/circle/bracket text + figures → **picture** elements
    (render source region + crop → PNG), unless digest text is available.
- Needs its **own plugin identity** + a small **native module** (PDF render + region
  **crop** — ExportColorPDF's renderer has `renderDocPage` but no crop). Build on a
  machine with the Android SDK using `@supernote-plugin/sn-plugin-template`.

## Open items
1. **Digests (req #2 + brackets):** confirm bracket/highlighter content surfaces as
   `TYPE_TEXT_DIGEST_QUOTE(501)`/`502` elements (or `getKeyWords`) with
   `textBox.textContentFull`. `digestHuntProbe` is built for this — **must run with
   the bracketed PDF "How to do things you hate" OPEN** (a run against a blank note
   returned nothing). Page 6 has bracketed "you have to accept yourself unconditionally".
2. **Cross-context reads:** confirm `getElements(page, pdfPath)` / `getMarkPages` /
   `renderDocPage(pdfPath)` work while a NOTE is the current doc.
3. **File picker** wiring (`selectFile`).
4. Requirement #3 (pending).

## Probes (this folder: extract-probe/probes/)
Each is a JS module wired into a throwaway build. `ProbeApp.tsx` is the minimal UI
(runs one probe on open, shows summary, writes a report to EXPORT).
- `extractProbe.js` — getCurrentDocText shape, keywords, element field discovery.
- `authoringProbe.js` — createNote (blocked) + insert attempts.
- `insertProbe.js` — insert APIs on the current doc.
- `notePictureProbe.js` — note-context authoring + insertElements([picture]) (PASSED).
- `digestHuntProbe.js` — scans all pages for digest text (run on the bracketed PDF).

## Build recipe (no Android SDK needed for JS-only probe builds)
The probe builds reused ExportColorPDF's `app.npk` (it has the native `writeFile`),
swapping only the JS bundle:
```
# in a copy of the ExportColorPDFv2.2 source (npm ci first):
cp probes/<one>.js src/  &&  cp probes/ProbeApp.tsx src/App.tsx   # wire import+call
npx react-native bundle --platform android --dev false --entry-file index.js \
  --bundle-output build/gen/ExportColorPDFCombined.bundle --assets-dest build/gen
# then package: build/gen + app.npk (reused) + icon.png + PluginConfig.json (iconPath:/icon.png,
#   nativeCodePackage:/app.npk, reactPackages:[com.exportcolorpdfcombined.ColorPdfRendererPackage],
#   bump versionCode) → zip → DocAnnotationsToNote.snplg
```
The **real** plugin needs its own native module + identity and a proper SDK build.

## Reference
Inkling plugin (`AppendPageService.ts`, `LassoExtractor.ts`) is the model for
appending pages + inserting images/strokes/links into a note. Its `.claude/skills/inkling`
docs document the SDK well.
