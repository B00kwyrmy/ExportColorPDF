package com.exportcolorpdfcombined

import android.graphics.*
import android.graphics.pdf.PdfDocument
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import com.facebook.react.bridge.*
import java.io.File
import java.io.FileOutputStream

/**
 * ColorPdfRenderer
 *
 * Provides two React Native methods:
 *
 * 1. overlayColoredStrokes(basePngPath, strokes, outputPath)
 *    Loads the base grayscale PNG produced by PluginFileAPI.generateNotePng
 *    (which correctly renders all content: handwriting, text boxes, shapes,
 *    images, etc.) then draws only the ARGB-colored strokes on top.
 *    Strokes that are still grayscale penColor are already correct in the
 *    base PNG and are NOT redrawn, avoiding double-draw artefacts.
 *
 * 2. assemblePdf(pagePngPaths, outputPdfPath)
 *    Combines per-page PNGs into a single multi-page PDF using Android's
 *    PdfDocument API.
 *
 * Coordinate system:
 *    index.js converts stroke points from EMR to pixel coordinates using
 *    PointUtils.emrPoint2Android BEFORE calling overlayColoredStrokes, so
 *    this module receives pixel-space coordinates that match the base PNG.
 *
 * Color format:
 *    Colors arrive as "#RRGGBB" strings already resolved by index.js from
 *    the 32-bit ARGB penColor stored by CustomColorPalette.
 */
class ColorPdfRendererModule(reactContext: ReactApplicationContext)
    : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "CombinedColorPdfRenderer"

    companion object {
        // Highlighter wash strength (0 = invisible, 1 = full multiply of the
        // colour). The wash only ever receives the (already-pale) highlighter
        // palette colours now, so full multiply = the true highlight colour over
        // white and dark text stays dark. Lower this only if a highlight reads
        // too strong; lowering too far makes the pale colours vanish.
        private const val HIGHLIGHT_ALPHA = 1.0f
    }

    /**
     * Load [basePngPath] (the device-rendered grayscale page), draw the
     * ARGB-colored strokes on top, and save the result to [outputPath].
     *
     * @param basePngPath   Path to the grayscale base PNG from generateNotePng
     * @param strokesArray  ReadableArray of { color: "#RRGGBB", thickness: number,
     *                      points: [{x,y},...] } — already in pixel coordinates
     * @param outputPath    Destination PNG path
     */
    /**
     * Tints dark pixels (strokes) in [basePngPath] to the chosen colors.
     *
     * WHY tinting instead of path drawing:
     *   Drawing a thick Path.lineTo() over handwriting creates filled blobs —
     *   adjacent stroke segments that fold back on themselves merge into solid
     *   shapes, obscuring the letterforms entirely. The base PNG already has
     *   the strokes rendered correctly by the device firmware; we only need to
     *   change their color, not re-draw them.
     *
     *   Tinting approach: for each pixel within half-width of a stroke segment,
     *   blend white toward the chosen color in proportion to the pixel's
     *   darkness (0=white → no change, 1=black → full color). This preserves
     *   every detail of the original rendering while changing the color.
     *
     *   Distance-based (not box-based): each entry is one line SEGMENT of a
     *   stroke. A pixel is tinted only if it is dark AND within [hw] of that
     *   segment. This hugs the actual ink path, so a stroke never bleeds its
     *   color onto a differently-coloured neighbour the way an axis-aligned
     *   bounding box would (a diagonal box covers far more than the ink).
     *
     * @param basePngPath   Grayscale page PNG from generateNotePng
     * @param strokesArray  Array of { color:"#RRGGBB", hw, ax, ay, bx, by, high }
     *                      line segments in pixel coordinates. ax/ay == bx/by
     *                      for a single-point dot. high=true marks a highlighter
     *                      segment (translucent multiply wash); false/absent is
     *                      an opaque pen segment.
     * @param outputPath    Destination PNG
     */
    @ReactMethod
    fun overlayColoredStrokes(
        basePngPath:   String,
        strokesArray:  ReadableArray,
        outputPath:    String,
        promise:       Promise,
    ) {
        try {
            val base = BitmapFactory.decodeFile(basePngPath)
                ?: throw RuntimeException("Could not decode base PNG: $basePngPath")

            val bitmap = base.copy(Bitmap.Config.ARGB_8888, true)
            base.recycle()

            val w = bitmap.width
            val h = bitmap.height

            // Fetch all pixels in one call — much faster than per-pixel getPixel().
            // src = original (read-only) base used to measure each pixel's
            //       darkness, so a pixel re-touched by a second segment is
            //       still tinted from its true ink shade, not an already-tinted
            //       value.
            // out = the result we write into.
            // best = squared distance from each pixel to the nearest stroke
            //        segment that has tinted it so far. A pixel always takes the
            //        colour of the CLOSEST stroke, not the last one drawn — so a
            //        stroke can never steal a pixel that sits on a neighbouring
            //        stroke's ink.
            val src  = IntArray(w * h)
            bitmap.getPixels(src, 0, w, 0, 0, w, h)
            val out  = src.copyOf()
            val best = FloatArray(w * h) { Float.MAX_VALUE }

            // ── Pass 1: PEN strokes — opaque, nearest-stroke-wins tint.
            //    Highlighter strokes are skipped here and washed in pass 2.
            for (i in 0 until strokesArray.size()) {
                val entry    = strokesArray.getMap(i) ?: continue
                if (entry.hasKey("high") && entry.getBoolean("high")) continue
                val colorHex = entry.getString("color") ?: continue
                val color    = Color.parseColor(colorHex)
                val cr = Color.red(color).toFloat()
                val cg = Color.green(color).toFloat()
                val cb = Color.blue(color).toFloat()

                // Segment endpoints + half-width (pixel coordinates)
                val ax = entry.getDouble("ax").toFloat()
                val ay = entry.getDouble("ay").toFloat()
                val bx = entry.getDouble("bx").toFloat()
                val by = entry.getDouble("by").toFloat()
                val hw = entry.getDouble("hw").toFloat()
                val hw2 = hw * hw

                // Visit only the segment's padded bounding box, then keep
                // pixels within [hw] of the segment itself (distance test).
                val x1 = (minOf(ax, bx) - hw).toInt().coerceIn(0, w - 1)
                val y1 = (minOf(ay, by) - hw).toInt().coerceIn(0, h - 1)
                val x2 = (maxOf(ax, bx) + hw).toInt().coerceIn(0, w - 1)
                val y2 = (maxOf(ay, by) + hw).toInt().coerceIn(0, h - 1)

                val dx  = bx - ax
                val dy  = by - ay
                val len2 = dx * dx + dy * dy   // 0 for a single-point dot

                for (y in y1..y2) {
                    val rowOff = y * w
                    for (x in x1..x2) {
                        // Squared distance from pixel centre to the segment.
                        val px = x.toFloat()
                        val py = y.toFloat()
                        val dist2: Float = if (len2 == 0f) {
                            val ddx = px - ax; val ddy = py - ay
                            ddx * ddx + ddy * ddy
                        } else {
                            var s = ((px - ax) * dx + (py - ay) * dy) / len2
                            if (s < 0f) s = 0f else if (s > 1f) s = 1f
                            val cxp = ax + s * dx; val cyp = ay + s * dy
                            val ddx = px - cxp; val ddy = py - cyp
                            ddx * ddx + ddy * ddy
                        }
                        if (dist2 > hw2) continue

                        val idx = rowOff + x
                        // Nearest-stroke-wins: skip if a closer segment already
                        // claimed this pixel.
                        if (dist2 >= best[idx]) continue

                        val p    = src[idx]
                        val gray = (Color.red(p) + Color.green(p) + Color.blue(p)) / 3
                        // t = 0 for white (skip), t = 1 for black (full color).
                        // Threshold 0.25 skips background dots (~gray 200) while
                        // catching anti-aliased stroke edges (~gray < 190).
                        val t = 1f - gray / 255f
                        if (t > 0.25f) {
                            out[idx] = Color.rgb(
                                (255f * (1f - t) + cr * t).toInt().coerceIn(0, 255),
                                (255f * (1f - t) + cg * t).toInt().coerceIn(0, 255),
                                (255f * (1f - t) + cb * t).toInt().coerceIn(0, 255)
                            )
                            best[idx] = dist2
                        }
                    }
                }
            }

            // ── Pass 2: HIGHLIGHTER strokes — translucent multiply wash over the
            //    pen-tinted result. Multiply keeps dark underlying ink dark (the
            //    script shows through) while colouring the page where it is
            //    light. Applied at most once per pixel (washed flag) so the many
            //    overlapping segments of a single stroke don't compound into a
            //    darker blotch.
            val washed = BooleanArray(w * h)
            for (i in 0 until strokesArray.size()) {
                val entry = strokesArray.getMap(i) ?: continue
                if (!(entry.hasKey("high") && entry.getBoolean("high"))) continue
                val colorHex = entry.getString("color") ?: continue
                val color = Color.parseColor(colorHex)
                // Translucent highlighter: lighten the colour toward white by
                // (1 - ALPHA), then multiply. A raw multiply paints a saturated
                // colour as a solid opaque blob (white * fullColour = fullColour);
                // lightening it first lays down a light, see-through wash for ANY
                // colour while the multiply still keeps dark underlying script
                // dark. ALPHA is the highlight strength (0 = invisible, 1 = solid).
                val cr = (255f - HIGHLIGHT_ALPHA * (255 - Color.red(color))).toInt().coerceIn(0, 255)
                val cg = (255f - HIGHLIGHT_ALPHA * (255 - Color.green(color))).toInt().coerceIn(0, 255)
                val cb = (255f - HIGHLIGHT_ALPHA * (255 - Color.blue(color))).toInt().coerceIn(0, 255)

                val ax = entry.getDouble("ax").toFloat()
                val ay = entry.getDouble("ay").toFloat()
                val bx = entry.getDouble("bx").toFloat()
                val by = entry.getDouble("by").toFloat()
                val hw = entry.getDouble("hw").toFloat()
                val hw2 = hw * hw

                val x1 = (minOf(ax, bx) - hw).toInt().coerceIn(0, w - 1)
                val y1 = (minOf(ay, by) - hw).toInt().coerceIn(0, h - 1)
                val x2 = (maxOf(ax, bx) + hw).toInt().coerceIn(0, w - 1)
                val y2 = (maxOf(ay, by) + hw).toInt().coerceIn(0, h - 1)

                val dx = bx - ax
                val dy = by - ay
                val len2 = dx * dx + dy * dy

                for (y in y1..y2) {
                    val rowOff = y * w
                    for (x in x1..x2) {
                        val px = x.toFloat()
                        val py = y.toFloat()
                        val dist2: Float = if (len2 == 0f) {
                            val ddx = px - ax; val ddy = py - ay
                            ddx * ddx + ddy * ddy
                        } else {
                            var s = ((px - ax) * dx + (py - ay) * dy) / len2
                            if (s < 0f) s = 0f else if (s > 1f) s = 1f
                            val cxp = ax + s * dx; val cyp = ay + s * dy
                            val ddx = px - cxp; val ddy = py - cyp
                            ddx * ddx + ddy * ddy
                        }
                        if (dist2 > hw2) continue

                        val idx = rowOff + x
                        if (washed[idx]) continue

                        val p = out[idx]
                        // Multiply base by the lightened (translucent) colour.
                        out[idx] = Color.rgb(
                            Color.red(p)   * cr / 255,
                            Color.green(p) * cg / 255,
                            Color.blue(p)  * cb / 255
                        )
                        washed[idx] = true
                    }
                }
            }

            bitmap.setPixels(out, 0, w, 0, 0, w, h)
            File(outputPath).parentFile?.mkdirs()
            FileOutputStream(outputPath).use { out ->
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
            }
            bitmap.recycle()
            promise.resolve(outputPath)

        } catch (t: Throwable) {
            promise.reject("EOVERLAY", t.message ?: "overlay failed", t)
        }
    }

    /**
     * Render a page of a source PDF to a PNG sized [width]×[height], used for
     * DOCUMENTS — the SDK's generateNotePng is note-only and rejects docs, so we
     * render the underlying PDF ourselves with Android's PdfRenderer, then draw
     * the colored annotation contours on top (via drawColoredShapes). The page
     * is scaled to fill the bitmap (matching the Supernote annotation canvas);
     * if annotations come out misaligned we switch to aspect-preserving fit.
     */
    @ReactMethod
    fun renderDocPage(
        pdfPath:    String,
        pageIndex:  Int,
        width:      Int,
        height:     Int,
        outputPath: String,
        promise:    Promise,
    ) {
        var pfd: ParcelFileDescriptor? = null
        var renderer: PdfRenderer? = null
        try {
            pfd = ParcelFileDescriptor.open(File(pdfPath), ParcelFileDescriptor.MODE_READ_ONLY)
            renderer = PdfRenderer(pfd)
            if (pageIndex < 0 || pageIndex >= renderer.pageCount) {
                throw RuntimeException("page $pageIndex out of range (count=${renderer.pageCount})")
            }
            val w = if (width  > 0) width  else 1404
            val h = if (height > 0) height else 1872
            val page = renderer.openPage(pageIndex)
            val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bmp)
            canvas.drawColor(Color.WHITE)
            // transform=null, destClip=null → page is scaled to fill the bitmap.
            page.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
            page.close()

            File(outputPath).parentFile?.mkdirs()
            FileOutputStream(outputPath).use { out ->
                bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
            }
            bmp.recycle()
            promise.resolve(outputPath)
        } catch (t: Throwable) {
            promise.reject("EPDF_RENDER", t.message ?: "pdf render failed", t)
        } finally {
            try { renderer?.close() } catch (_: Throwable) {}
            try { pfd?.close() } catch (_: Throwable) {}
        }
    }

    /**
     * Draw colored annotation shapes ON TOP of the base page from their pixel
     * contour geometry — used for DOCUMENTS, where the page already contains
     * printed text that must NOT be recolored. Because we fill each stroke's own
     * contour (rather than tinting dark pixels), printed text is never touched,
     * and because contours are already in pixel coordinates no EMR conversion is
     * needed.
     *
     * @param basePngPath   The rendered document page (printed text + ink), untouched.
     * @param shapesArray   Array of { color:"#RRGGBB", wash:bool, polys:[[{x,y},...],...] }.
     *                      wash=true → translucent multiply (highlighter); else opaque fill (pen).
     * @param outputPath    Destination PNG.
     */
    @ReactMethod
    fun drawColoredShapes(
        basePngPath:  String,
        shapesArray:  ReadableArray,
        outputPath:   String,
        promise:      Promise,
    ) {
        try {
            val base = BitmapFactory.decodeFile(basePngPath)
                ?: throw RuntimeException("Could not decode base PNG: $basePngPath")
            val bitmap = base.copy(Bitmap.Config.ARGB_8888, true)
            base.recycle()
            val canvas = Canvas(bitmap)

            for (i in 0 until shapesArray.size()) {
                val shape    = shapesArray.getMap(i) ?: continue
                val colorHex = shape.getString("color") ?: continue
                val wash     = shape.hasKey("wash") && shape.getBoolean("wash")
                val polys    = shape.getArray("polys") ?: continue

                val paint = Paint(Paint.ANTI_ALIAS_FLAG)
                paint.style = Paint.Style.FILL
                if (wash) {
                    // Highlighter: lighten the colour toward white then multiply,
                    // so the wash is see-through and dark text shows through.
                    val color = Color.parseColor(colorHex)
                    paint.color = Color.rgb(
                        (255f - HIGHLIGHT_ALPHA * (255 - Color.red(color))).toInt().coerceIn(0, 255),
                        (255f - HIGHLIGHT_ALPHA * (255 - Color.green(color))).toInt().coerceIn(0, 255),
                        (255f - HIGHLIGHT_ALPHA * (255 - Color.blue(color))).toInt().coerceIn(0, 255),
                    )
                    paint.xfermode = PorterDuffXfermode(PorterDuff.Mode.MULTIPLY)
                } else {
                    // Pen annotation: opaque, covers exactly its own ink footprint.
                    paint.color = Color.parseColor(colorHex)
                }

                val path = Path()
                for (p in 0 until polys.size()) {
                    val poly = polys.getArray(p) ?: continue
                    if (poly.size() < 3) continue
                    val first = poly.getMap(0) ?: continue
                    path.moveTo(first.getDouble("x").toFloat(), first.getDouble("y").toFloat())
                    for (q in 1 until poly.size()) {
                        val pt = poly.getMap(q) ?: continue
                        path.lineTo(pt.getDouble("x").toFloat(), pt.getDouble("y").toFloat())
                    }
                    path.close()
                }
                canvas.drawPath(path, paint)
            }

            File(outputPath).parentFile?.mkdirs()
            FileOutputStream(outputPath).use { out ->
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
            }
            bitmap.recycle()
            promise.resolve(outputPath)

        } catch (t: Throwable) {
            promise.reject("EDRAW", t.message ?: "draw shapes failed", t)
        }
    }

    /**
     * Write [content] string to [path], creating parent directories as needed.
     * Used by the probe to persist its diagnostic report to the EXPORT directory,
     * and (in the eventual export) to read/write the per-note color sidecar.
     */
    @ReactMethod
    fun writeFile(path: String, content: String, promise: Promise) {
        try {
            val file = File(path)
            file.parentFile?.mkdirs()
            file.writeText(content, Charsets.UTF_8)
            promise.resolve(true)
        } catch (t: Throwable) {
            promise.reject("EWRITE", t.message ?: "write failed", t)
        }
    }

    /**
     * Read the text content of [path].
     * Returns an empty string if the file does not exist.
     */
    @ReactMethod
    fun readFile(path: String, promise: Promise) {
        try {
            val file = File(path)
            promise.resolve(if (file.exists()) file.readText(Charsets.UTF_8) else "")
        } catch (t: Throwable) {
            promise.reject("EREAD", t.message ?: "read failed", t)
        }
    }

    /**
     * Report a PNG file's on-disk byte size and pixel dimensions WITHOUT
     * decoding the full bitmap (inJustDecodeBounds). Used by the EPUB probe to
     * (a) accumulate rendered bytes against the PROBE_MAX_BYTES cap and (b) log
     * the resolution Supernote's renderer produced for each page.
     *
     * @return { bytes: number, width: number, height: number }. bytes = -1 if
     *         the file is missing; width/height = -1 if it is not a decodable image.
     */
    @ReactMethod
    fun pngInfo(path: String, promise: Promise) {
        try {
            val file = File(path)
            val map = Arguments.createMap()
            if (!file.exists()) {
                map.putDouble("bytes", -1.0)
                map.putInt("width", -1)
                map.putInt("height", -1)
                promise.resolve(map)
                return
            }
            map.putDouble("bytes", file.length().toDouble())
            val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(path, opts)
            map.putInt("width", opts.outWidth)
            map.putInt("height", opts.outHeight)
            promise.resolve(map)
        } catch (t: Throwable) {
            promise.reject("EPNGINFO", t.message ?: "pngInfo failed", t)
        }
    }

    /**
     * Combine per-page PNGs into a single multi-page PDF.
     *
     * @param pathsArray     ReadableArray of PNG paths, one per page
     * @param outputPdfPath  Destination PDF file path
     */
    @ReactMethod
    fun assemblePdf(
        pathsArray:    ReadableArray,
        outputPdfPath: String,
        promise:       Promise,
    ) {
        val pdfDoc = PdfDocument()
        try {
            for (i in 0 until pathsArray.size()) {
                val pngPath = pathsArray.getString(i) ?: continue
                val bm      = BitmapFactory.decodeFile(pngPath) ?: continue

                val pageInfo = PdfDocument.PageInfo.Builder(bm.width, bm.height, i + 1).create()
                val page     = pdfDoc.startPage(pageInfo)
                page.canvas.drawBitmap(bm, 0f, 0f, null)
                pdfDoc.finishPage(page)
                bm.recycle()
            }

            File(outputPdfPath).parentFile?.mkdirs()
            FileOutputStream(outputPdfPath).use { out -> pdfDoc.writeTo(out) }
            promise.resolve(outputPdfPath)

        } catch (t: Throwable) {
            promise.reject("EPDF", t.message ?: "pdf assembly failed", t)
        } finally {
            pdfDoc.close()
        }
    }
}
