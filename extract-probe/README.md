# Extract-to-note — SDK diagnostic probe

`extractProbe.js` is a **read-only** on-device probe. It creates/changes nothing.
It answers the one question that decides the scope of the "extract annotations
into a new note" plugin: **does `getCurrentDocText(page)` return positioned text
(word/line boxes) or just a flat string?** It also dumps the bracket-digest data,
titles, and every non-stroke element so we learn the real field names.

## What to test against
Open the PDF/EPUB **"How to Do Things You Hate"**, then on a page or two:
- highlight some text (highlighter colour),
- underline some text,
- circle some text,
- put some text in `[ square brackets ]`,
- write a note in a picked colour,
- **circle or box a graph/picture** (this exercises the image-clip branch).

Save, then run the probe with that document open.

## Wiring it in (laptop build)
The probe needs the same native module the plugin already loads
(`CombinedColorPdfRenderer`, for `writeFile`) and `sn-plugin-lib`. Two options:

**A. Quickest — temporarily hijack the export button.** In `src/exporter.js`
(or wherever the toolbar action calls `runExport`), swap the call for the probe:

```js
import { runExtractProbe } from '../extract-probe/extractProbe'; // adjust path
// ...where the button handler runs:
const summary = await runExtractProbe();   // returns the text summary too
console.log(summary);
```

**B. Cleaner — add a temporary second toolbar button** in `index.js` that calls
`runExtractProbe()` and shows the returned string.

Build/deploy exactly as the main plugin (`buildPlugin.sh` + adb push).

## Where the output lands
Two files in your EXPORT directory:
- `extractprobe_<base>_<stamp>.txt` — **read this first** (human summary).
- `extractprobe_<base>_<stamp>.json` — full dump for me to read.

The probe's return value is the same summary string, so if you wire it to a UI
toast/log you'll see the headline without pulling files off the device.

## How to read it
The first thing I'll look for in the `.txt`:

```
getCurrentDocText: ARRAY of N item(s); item keys = [...]. Positioned text: YES ✅
```
- **YES ✅** → highlight/underline/circle-of-text extraction AND the text-vs-image
  branch for enclosures are all in scope.
- **FLAT STRING … NO coordinates** → those fall back to region-only handling;
  brackets (digests) + handwriting + image-clipping still work.

Then I'll check the `TEXT_DIGEST_QUOTE(501)` / `GEO(700)` / `PICTURE(200)` element
field names in the JSON to confirm how we read bracket text and detect enclosures.

Send me the `.json` (or paste the `.txt`) and I'll lock down exactly what we can build.
