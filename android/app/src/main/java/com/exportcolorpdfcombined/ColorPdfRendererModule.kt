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
        // colour). The palette now uses SATURATED highlighter colours, so the
        // see-through effect comes from the wash itself: ~0.45 lightens the colour
        // before multiplying, giving visible colour you can still read through.
        // Raise for bolder highlights, lower for fainter.
        private const val HIGHLIGHT_ALPHA = 0.45f
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
    private fun pathFromContours(contours: ReadableArray): Path {
        val path = Path()
        for (i in 0 until contours.size()) {
            val poly = contours.getArray(i) ?: continue
            if (poly.size() < 3) continue
            for (j in 0 until poly.size()) {
                val p = poly.getMap(j) ?: continue
                val x = p.getDouble("x").toFloat()
                val y = p.getDouble("y").toFloat()
                if (j == 0) path.moveTo(x, y) else path.lineTo(x, y)
            }
            path.close()
        }
        return path
    }

    /**
     * whiteOutMarkers(basePngPath, templatePngPath, eraseContours, keepContours, outputPath)
     *
     * NOTE white-out (Path B): the note's base image has the fat native marker
     * baked in. We "erase" it by repainting the TEMPLATE (dots/lines) into the
     * marker's footprint — EXCEPT where a non-marker stroke also sits (keepContours),
     * so pen ink that overlaps a marker is preserved (not wiped). The caller then
     * draws the thin marker, and re-overlays coloured strokes on top.
     */
    @ReactMethod
    fun whiteOutMarkers(
        basePngPath:     String,
        templatePngPath: String,
        eraseContours:   ReadableArray,
        keepContours:    ReadableArray,
        outputPath:      String,
        promise:         Promise,
    ) {
        try {
            val base = BitmapFactory.decodeFile(basePngPath)
                ?: throw RuntimeException("Could not decode base PNG: $basePngPath")
            val result = base.copy(Bitmap.Config.ARGB_8888, true)
            base.recycle()

            val tpl0 = BitmapFactory.decodeFile(templatePngPath)
            val erasePath = pathFromContours(eraseContours)
            if (tpl0 != null && !erasePath.isEmpty) {
                // Scale the template to the result frame so a BitmapShader aligns 1:1.
                val tpl = if (tpl0.width == result.width && tpl0.height == result.height) tpl0
                          else Bitmap.createScaledBitmap(tpl0, result.width, result.height, true)

                val canvas = Canvas(result)
                val paint = Paint(Paint.ANTI_ALIAS_FLAG)
                paint.shader = BitmapShader(tpl, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP)
                paint.strokeJoin = Paint.Join.ROUND
                paint.strokeCap = Paint.Cap.ROUND

                canvas.save()
                // Preserve overlapping non-marker strokes (pen ink isn't wiped).
                val keepPath = pathFromContours(keepContours)
                if (!keepPath.isEmpty) canvas.clipPath(keepPath, Region.Op.DIFFERENCE)
                // Fill the marker footprint with template, THEN stroke its outline a few
                // px wide so the erase extends PAST the contour and swallows the native
                // marker's anti-aliased edge (the "shadow" ring). No erasePath clip here,
                // so the dilation stroke can reach beyond the contour.
                paint.style = Paint.Style.FILL
                canvas.drawPath(erasePath, paint)
                paint.style = Paint.Style.STROKE
                paint.strokeWidth = 8f   // dilation px (≈4px past the contour); raise if a shadow ring remains
                canvas.drawPath(erasePath, paint)
                canvas.restore()

                if (tpl !== tpl0) tpl.recycle()
            }
            tpl0?.recycle()

            FileOutputStream(outputPath).use { result.compress(Bitmap.CompressFormat.PNG, 100, it) }
            result.recycle()
            promise.resolve(true)
        } catch (t: Throwable) {
            promise.reject("EWHITEOUT", t.message ?: "whiteOutMarkers failed", t)
        }
    }

    /**
     * drawColoredStrokeLines(basePngPath, strokesArray, outputPath)
     *
     * Strokes each polyline (a sized marker's centreline, already in pixel coords)
     * onto the base PNG with Canvas.drawPath + a round-cap/round-join paint at the
     * given width — clean strokes at any width, no self-intersection artefacts (the
     * blobbiness of a JS-built ribbon polygon). Markers (wash=true) draw translucent
     * so underlying content shows through. Used by MarkerSize / Path B.
     */
    @ReactMethod
    fun drawColoredStrokeLines(
        basePngPath:  String,
        strokesArray: ReadableArray,
        outputPath:   String,
        promise:      Promise,
    ) {
        try {
            val base = BitmapFactory.decodeFile(basePngPath)
                ?: throw RuntimeException("Could not decode base PNG: $basePngPath")
            val bitmap = base.copy(Bitmap.Config.ARGB_8888, true)
            base.recycle()
            val canvas = Canvas(bitmap)

            for (i in 0 until strokesArray.size()) {
                val e = strokesArray.getMap(i) ?: continue
                val pts = e.getArray("points") ?: continue
                if (pts.size() < 1) continue
                val colorHex = e.getString("color") ?: continue
                val width = if (e.hasKey("width")) e.getDouble("width").toFloat() else 6f
                val wash  = e.hasKey("wash") && e.getBoolean("wash")

                val paint = Paint(Paint.ANTI_ALIAS_FLAG)
                paint.strokeWidth = width
                paint.strokeCap = Paint.Cap.ROUND
                paint.strokeJoin = Paint.Join.ROUND
                paint.color = Color.parseColor(colorHex)
                // Marker = translucent wash so page/text shows through. A single
                // drawPath blends the whole stroke once (uniform) even where it
                // overlaps itself — no compounding into a darker blob.
                if (wash) paint.alpha = 115

                if (pts.size() == 1) {
                    val p = pts.getMap(0)!!
                    paint.style = Paint.Style.FILL
                    canvas.drawCircle(p.getDouble("x").toFloat(), p.getDouble("y").toFloat(), width / 2f, paint)
                } else {
                    paint.style = Paint.Style.STROKE
                    val path = Path()
                    var started = false
                    for (j in 0 until pts.size()) {
                        val p = pts.getMap(j) ?: continue
                        val x = p.getDouble("x").toFloat()
                        val y = p.getDouble("y").toFloat()
                        if (!started) { path.moveTo(x, y); started = true } else path.lineTo(x, y)
                    }
                    if (started) canvas.drawPath(path, paint)
                }
            }

            FileOutputStream(outputPath).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
            promise.resolve(true)
        } catch (t: Throwable) {
            promise.reject("ESTROKE", t.message ?: "drawColoredStrokeLines failed", t)
        }
    }

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
     * Rotate a PNG 90° and overwrite it. Used by the landscape-page export path:
     * the PDF/EPUB page is rendered at its portrait size, then turned 90° so the
     * page reads landscape (matching how the user annotated it). A WxH bitmap
     * becomes HxW. clockwise=true → postRotate(90) (a portrait point (x,y) lands
     * at (H-1-y, x), which the JS side mirrors when rotating "portrait" strokes).
     */
    @ReactMethod
    fun rotatePng90(
        inPath:     String,
        outPath:    String,
        clockwise:  Boolean,
        promise:    Promise,
    ) {
        try {
            val src = BitmapFactory.decodeFile(inPath)
                ?: throw RuntimeException("Could not decode PNG: $inPath")
            val m = Matrix()
            m.postRotate(if (clockwise) 90f else -90f)
            val rot = Bitmap.createBitmap(src, 0, 0, src.width, src.height, m, true)
            src.recycle()
            File(outPath).parentFile?.mkdirs()
            FileOutputStream(outPath).use { out -> rot.compress(Bitmap.CompressFormat.PNG, 100, out) }
            rot.recycle()
            promise.resolve(outPath)
        } catch (t: Throwable) {
            promise.reject("EROT", t.message ?: "rotate failed", t)
        }
    }

    /**
     * Place [basePng] onto a larger white [canvasW]x[canvasH] canvas at
     * ([offsetX],[offsetY]) and write it out. Used by the landscape "matte" export:
     * the upright document page is composited into a bigger canvas so annotations
     * that run past the page edges have room to render (instead of being clipped).
     * Annotation contours are drawn afterward (by drawColoredShapes) shifted by the
     * same offset, so doc + ink stay aligned.
     */
    @ReactMethod
    fun matteBitmap(
        basePng:  String,
        canvasW:  Int,
        canvasH:  Int,
        offsetX:  Int,
        offsetY:  Int,
        outPath:  String,
        promise:  Promise,
    ) {
        try {
            val src = BitmapFactory.decodeFile(basePng)
                ?: throw RuntimeException("Could not decode base PNG: $basePng")
            val w = if (canvasW > 0) canvasW else src.width
            val h = if (canvasH > 0) canvasH else src.height
            val sw = src.width; val sh = src.height
            val canvasBmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(canvasBmp)
            canvas.drawColor(Color.WHITE)
            canvas.drawBitmap(src, offsetX.toFloat(), offsetY.toFloat(), null)
            src.recycle()
            // Outline the original page region so the doc edge reads against the margin.
            val border = Paint().apply {
                style = Paint.Style.STROKE; color = Color.rgb(150, 150, 150)
                strokeWidth = 2f; isAntiAlias = true
            }
            canvas.drawRect(offsetX.toFloat(), offsetY.toFloat(),
                            (offsetX + sw).toFloat(), (offsetY + sh).toFloat(), border)
            File(outPath).parentFile?.mkdirs()
            FileOutputStream(outPath).use { out -> canvasBmp.compress(Bitmap.CompressFormat.PNG, 100, out) }
            canvasBmp.recycle()
            promise.resolve(outPath)
        } catch (t: Throwable) {
            promise.reject("EMATTE", t.message ?: "matte failed", t)
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

                // Wash = translucent MULTIPLY so the highlighter reads see-through:
                // content underneath (incl. other coloured strokes) shows through
                // the tint, which is the whole point of a highlighter. (We tried
                // whitening the grey marker base first for a cleaner colour, but it
                // hid everything under the stroke — wrong for highlighting. Drawing
                // order: coloured strokes earlier in the page are already on the
                // canvas, so a wash drawn over them tints them rather than erasing.)
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

    /**
     * Stitch per-page PNGs vertically into ONE tall PNG, streamed so peak memory
     * stays at ~one page regardless of page count.
     *
     * We never build the full combined bitmap (which for many pages would be
     * hundreds of MB and OOM the plugin process). Instead we hand-write the PNG:
     * IHDR with the final width/height, then decode ONE source page at a time and
     * feed its rows (filter type 0 = None) into a single zlib Deflater whose
     * compressed output is flushed to disk as IDAT chunks as it accumulates. Pages
     * narrower than the widest are right-padded with white.
     *
     * @param pathsArray  PNG paths, one per page, top-to-bottom.
     * @param outputPath  Destination PNG path.
     */
    @ReactMethod
    fun stitchPngVertical(
        pathsArray: ReadableArray,
        outputPath: String,
        promise:    Promise,
    ) {
        try {
            val n = pathsArray.size()
            if (n == 0) throw RuntimeException("no pages to stitch")

            // Pass 1: dimensions only (no pixel decode) → final canvas size.
            var maxW = 0
            var totalH = 0
            for (i in 0 until n) {
                val p = pathsArray.getString(i) ?: throw RuntimeException("null path at index $i")
                val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeFile(p, opts)
                if (opts.outWidth <= 0 || opts.outHeight <= 0) throw RuntimeException("undecodable image: $p")
                if (opts.outWidth > maxW) maxW = opts.outWidth
                totalH += opts.outHeight
            }
            val width  = maxW
            val height = totalH

            File(outputPath).parentFile?.mkdirs()
            FileOutputStream(outputPath).use { fos ->
                val out = java.io.BufferedOutputStream(fos)

                // PNG signature.
                out.write(byteArrayOf(
                    0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))

                // IHDR: width, height, 8-bit, colour type 2 (RGB), no interlace.
                val ihdr = java.io.ByteArrayOutputStream()
                writeBE32(ihdr, width)
                writeBE32(ihdr, height)
                ihdr.write(8); ihdr.write(2); ihdr.write(0); ihdr.write(0); ihdr.write(0)
                writePngChunk(out, "IHDR", ihdr.toByteArray())

                // Streamed IDAT: deflate rows as we go, flush compressed bytes in chunks.
                val deflater = java.util.zip.Deflater(java.util.zip.Deflater.DEFAULT_COMPRESSION)
                val compBuf  = ByteArray(64 * 1024)
                val idatBuf  = java.io.ByteArrayOutputStream()
                val flushAt  = 32 * 1024
                val rowBytes = ByteArray(1 + width * 3)   // filter byte + RGB row

                fun pump(finishing: Boolean) {
                    while (true) {
                        val c = deflater.deflate(compBuf)
                        if (c > 0) {
                            idatBuf.write(compBuf, 0, c)
                            if (idatBuf.size() >= flushAt) {
                                writePngChunk(out, "IDAT", idatBuf.toByteArray()); idatBuf.reset()
                            }
                        } else if (finishing) {
                            if (deflater.finished()) break
                        } else {
                            if (deflater.needsInput()) break
                        }
                    }
                }

                for (i in 0 until n) {
                    val p = pathsArray.getString(i)!!
                    val bmp = BitmapFactory.decodeFile(p) ?: throw RuntimeException("decode failed: $p")
                    val pw = bmp.width
                    val ph = bmp.height
                    val rowPixels = IntArray(pw)
                    for (y in 0 until ph) {
                        bmp.getPixels(rowPixels, 0, pw, 0, y, pw, 1)
                        var o = 0
                        rowBytes[o++] = 0   // filter: None
                        for (x in 0 until width) {
                            if (x < pw) {
                                val px = rowPixels[x]
                                rowBytes[o++] = ((px shr 16) and 0xFF).toByte()
                                rowBytes[o++] = ((px shr 8)  and 0xFF).toByte()
                                rowBytes[o++] = (px and 0xFF).toByte()
                            } else {
                                rowBytes[o++] = 0xFF.toByte()
                                rowBytes[o++] = 0xFF.toByte()
                                rowBytes[o++] = 0xFF.toByte()
                            }
                        }
                        deflater.setInput(rowBytes, 0, o)
                        pump(false)
                    }
                    bmp.recycle()
                }

                deflater.finish()
                pump(true)
                if (idatBuf.size() > 0) { writePngChunk(out, "IDAT", idatBuf.toByteArray()); idatBuf.reset() }
                deflater.end()

                writePngChunk(out, "IEND", ByteArray(0))
                out.flush()
            }
            promise.resolve(outputPath)
        } catch (t: Throwable) {
            promise.reject("ESTITCH", t.message ?: "png stitch failed", t)
        }
    }

    /** Write a 32-bit big-endian integer. */
    private fun writeBE32(o: java.io.OutputStream, v: Int) {
        o.write((v ushr 24) and 0xFF)
        o.write((v ushr 16) and 0xFF)
        o.write((v ushr 8) and 0xFF)
        o.write(v and 0xFF)
    }

    /** Write one PNG chunk: length, 4-char type, data, CRC32(type+data). */
    private fun writePngChunk(o: java.io.OutputStream, type: String, data: ByteArray) {
        writeBE32(o, data.size)
        val t = type.toByteArray(Charsets.US_ASCII)
        o.write(t)
        o.write(data)
        val crc = java.util.zip.CRC32()
        crc.update(t)
        crc.update(data)
        writeBE32(o, crc.value.toInt())
    }
}
