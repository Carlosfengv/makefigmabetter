//! Deterministic, GPU-handle-free graphics primitives.
//!
//! This crate deliberately owns no FontFace, canvas, or wgpu object. It is the
//! shared text/scene input boundary that can be replayed in a browser Worker,
//! service fixture, or future native renderer without mutating Canonical
//! Document state.

use std::collections::BTreeMap;

use icu_segmenter::LineSegmenter;
use unicode_bidi::BidiInfo;
use unicode_segmentation::UnicodeSegmentation;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextDirection {
    LeftToRight,
    RightToLeft,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShapedGlyph {
    pub glyph_id: u32,
    /// UTF-8 byte offset to the source cluster start. Rustybuzz preserves the
    /// byte offset passed by its UnicodeBuffer, so this is compatible with the
    /// Canonical TextStyleRun/Caret coordinate system.
    pub cluster: u32,
    pub x_advance: i32,
    pub y_advance: i32,
    pub x_offset: i32,
    pub y_offset: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShapedText {
    pub direction: TextDirection,
    pub units_per_em: i32,
    pub glyphs: Vec<ShapedGlyph>,
}

/// A line selected by ICU4X break opportunities and shaped from explicit font
/// bytes. Offsets and clusters remain UTF-8 byte positions in the original
/// Canonical string so selection and style runs do not require a second index
/// coordinate system.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShapedTextLine {
    pub start: u32,
    pub end: u32,
    pub direction: TextDirection,
    /// Absolute magnitude in font units; it is independent of browser zoom.
    pub advance: i32,
    /// UAX #9 level runs in display order. Their byte ranges stay in the
    /// unmodified Canonical source coordinate system.
    pub visual_runs: Vec<VisualTextRun>,
    pub glyphs: Vec<ShapedGlyph>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VisualTextRun {
    pub start: u32,
    pub end: u32,
    pub direction: TextDirection,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShapedTextLayout {
    pub units_per_em: i32,
    pub lines: Vec<ShapedTextLine>,
    /// Visual line ownership for each legal UTF-8 grapheme caret stop.
    pub carets: Vec<CaretStop>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextShapingError {
    InvalidFont,
    InvalidVariation,
    InvalidLineWidth,
}

/// A declared OpenType variation coordinate. Four ASCII bytes match the
/// Canonical `FontReference` axis tag without involving platform font APIs.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FontVariation {
    pub tag: [u8; 4],
    pub value: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct GlyphKey {
    /// Stable digest-derived identity of font bytes, not a platform FontFace.
    pub font_key: u64,
    pub face_index: u32,
    pub glyph_id: u32,
    pub pixel_size: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GlyphAtlasEntry {
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GlyphAtlasError {
    InvalidGlyphBounds,
    AtlasFull,
}

/// A deterministic alpha mask produced from an explicit OpenType outline. It
/// is a recreatable presentation resource: Canonical Documents retain only
/// FontReference and text, never these pixels or an atlas location.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RasterizedGlyph {
    pub width: u16,
    pub height: u16,
    /// Horizontal pen-to-bitmap origin in device pixels.
    pub bearing_x: i16,
    /// Baseline-to-bitmap-top origin in device pixels.
    pub bearing_y: i16,
    /// Baseline-to-line-top ascent in device pixels, from the explicit font.
    pub ascent: i16,
    /// Horizontal pen advance in device pixels.
    pub advance_x: i16,
    /// One alpha byte per row-major pixel.
    pub pixels: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GlyphRasterError {
    InvalidFont,
    InvalidVariation,
    InvalidPixelSize,
    GlyphHasNoOutline,
    ResourceLimit,
}

const MAX_GLYPH_RASTER_DIMENSION: u16 = 512;
const GLYPH_RASTER_SAMPLES_PER_AXIS: usize = 4;

/// A deterministic shelf allocator for already-rasterized glyph bitmaps. It
/// stores no pixels and no GPU texture; callers may discard it on Device Lost
/// and rebuild from immutable font bytes and shaped glyph IDs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlyphAtlas {
    width: u16,
    height: u16,
    max_entries: usize,
    entries: BTreeMap<GlyphKey, GlyphAtlasEntry>,
    cursor_x: u16,
    cursor_y: u16,
    row_height: u16,
}

impl GlyphAtlas {
    pub fn new(width: u16, height: u16, max_entries: usize) -> Self {
        Self {
            width,
            height,
            max_entries,
            entries: BTreeMap::new(),
            cursor_x: 0,
            cursor_y: 0,
            row_height: 0,
        }
    }

    pub fn entry(&self, key: GlyphKey) -> Option<GlyphAtlasEntry> {
        self.entries.get(&key).copied()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn insert(
        &mut self,
        key: GlyphKey,
        width: u16,
        height: u16,
    ) -> Result<GlyphAtlasEntry, GlyphAtlasError> {
        if let Some(entry) = self.entry(key) {
            return Ok(entry);
        }
        if width == 0 || height == 0 || width > self.width || height > self.height {
            return Err(GlyphAtlasError::InvalidGlyphBounds);
        }
        if self.entries.len() >= self.max_entries {
            return Err(GlyphAtlasError::AtlasFull);
        }
        let (x, y, row_height) = if self.cursor_x.saturating_add(width) > self.width {
            (0, self.cursor_y.saturating_add(self.row_height), 0)
        } else {
            (self.cursor_x, self.cursor_y, self.row_height)
        };
        if y.saturating_add(height) > self.height {
            return Err(GlyphAtlasError::AtlasFull);
        }
        let entry = GlyphAtlasEntry {
            x,
            y,
            width,
            height,
        };
        self.entries.insert(key, entry);
        self.cursor_x = x.saturating_add(width);
        self.cursor_y = y;
        self.row_height = row_height.max(height);
        Ok(entry)
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.cursor_x = 0;
        self.cursor_y = 0;
        self.row_height = 0;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TextLine {
    /// UTF-8 byte offsets into the unmodified source text.
    pub start: u32,
    pub end: u32,
    pub direction: TextDirection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaretStop {
    /// UTF-8 byte offset at a Unicode grapheme boundary.
    pub byte_offset: u32,
    pub line_index: u32,
}

/// A transient visual selection. It intentionally lives outside Canonical
/// Document state: peers persist text operations, never another editor's caret.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TextSelection {
    /// UTF-8 byte offset of the fixed selection end.
    pub anchor: u32,
    /// UTF-8 byte offset of the actively moving selection end.
    pub focus: u32,
}

impl TextSelection {
    pub fn collapsed(offset: u32) -> Self {
        Self {
            anchor: offset,
            focus: offset,
        }
    }

    pub fn start(self) -> u32 {
        self.anchor.min(self.focus)
    }

    pub fn end(self) -> u32 {
        self.anchor.max(self.focus)
    }
}

/// The transient result of either a committed input edit or an IME preview.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextEditResult {
    pub text: String,
    pub selection: TextSelection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextEditError {
    SelectionIsNotAtAGraphemeBoundary,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextLayout {
    pub lines: Vec<TextLine>,
    pub carets: Vec<CaretStop>,
}

impl TextLayout {
    /// Snaps untrusted DOM/IME offsets to the closest legal visual caret. Ties
    /// choose the earlier byte offset so correction is stable across clients.
    pub fn snap_selection(&self, selection: TextSelection) -> TextSelection {
        TextSelection {
            anchor: self.nearest_caret(selection.anchor),
            focus: self.nearest_caret(selection.focus),
        }
    }

    fn contains_caret(&self, offset: u32) -> bool {
        self.carets.iter().any(|caret| caret.byte_offset == offset)
    }

    fn nearest_caret(&self, offset: u32) -> u32 {
        self.carets
            .iter()
            .map(|caret| caret.byte_offset)
            .min_by_key(|candidate| (candidate.abs_diff(offset), *candidate))
            .unwrap_or(0)
    }
}

/// Produces a deterministic fallback line model before font shaping. The width
/// is intentionally grapheme-count based: real advances are supplied by the
/// HarfBuzz stage later, while this map remains safe for IME/caret restoration
/// because it never splits a grapheme or rewrites source bytes.
pub fn fallback_text_layout(text: &str, max_graphemes_per_line: usize) -> TextLayout {
    let limit = max_graphemes_per_line.max(1);
    let mut lines = Vec::new();
    let mut carets = Vec::new();
    let mut paragraph_start = 0;

    for (separator_start, separator_len) in paragraph_boundaries(text) {
        append_paragraph(
            &text[paragraph_start..separator_start],
            byte_offset(text, paragraph_start),
            limit,
            &mut lines,
            &mut carets,
        );
        paragraph_start = separator_start + separator_len;
    }
    append_paragraph(
        &text[paragraph_start..],
        byte_offset(text, paragraph_start),
        limit,
        &mut lines,
        &mut carets,
    );

    TextLayout { lines, carets }
}

/// Shapes text from explicit, content-addressed font bytes. The function owns
/// no platform font handle and never calls Canvas/DOM measurement, allowing a
/// Worker, service fixture, and future renderer to consume the same glyph map.
/// ICU line breaking and FreeType rasterization are intentionally separate
/// stages; this is the deterministic shaping boundary between them.
pub fn shape_text(
    font_bytes: &[u8],
    face_index: u32,
    text: &str,
    direction: TextDirection,
) -> Result<ShapedText, TextShapingError> {
    shape_text_with_variations(font_bytes, face_index, &[], text, direction)
}

/// Shapes explicit font bytes at declared variable-font coordinates without
/// consulting platform font APIs.
pub fn shape_text_with_variations(
    font_bytes: &[u8],
    face_index: u32,
    variations: &[FontVariation],
    text: &str,
    direction: TextDirection,
) -> Result<ShapedText, TextShapingError> {
    let face = rustybuzz_face(font_bytes, face_index, variations)?;
    Ok(shape_text_with_face(&face, text, direction))
}

/// Resolves a single source range into UAX #9 display-order runs. It is public
/// so a future native renderer can use the exact same byte ranges as the WASM
/// projection without retaining a browser Bidi implementation.
pub fn bidi_visual_runs(text: &str) -> Vec<VisualTextRun> {
    if text.is_empty() {
        return Vec::new();
    }
    let bidi = BidiInfo::new(text, None);
    let Some(paragraph) = bidi.paragraphs.first() else {
        return Vec::new();
    };
    let (levels, runs) = bidi.visual_runs(paragraph, 0..text.len());
    runs.into_iter()
        .filter_map(|run| {
            let level = levels.get(run.start)?;
            Some(VisualTextRun {
                start: run.start as u32,
                end: run.end as u32,
                direction: if level.is_rtl() {
                    TextDirection::RightToLeft
                } else {
                    TextDirection::LeftToRight
                },
            })
        })
        .collect()
}

/// Rasterizes one glyph directly from the content-addressed OpenType bytes.
/// The fixed 4×4 even-odd supersampling rule makes the alpha mask deterministic
/// across browsers and independent of Canvas/DOM text APIs. It is deliberately
/// bounded so an untrusted font cannot turn a single glyph request into an
/// unbounded Worker or GPU allocation.
pub fn rasterize_glyph(
    font_bytes: &[u8],
    face_index: u32,
    glyph_id: u32,
    pixel_size: u16,
) -> Result<RasterizedGlyph, GlyphRasterError> {
    rasterize_glyph_with_variations(font_bytes, face_index, &[], glyph_id, pixel_size)
}

/// Rasterizes a glyph at the same variation coordinates as shaping. This keeps
/// advances, outlines and renderer cache entries one deterministic result.
pub fn rasterize_glyph_with_variations(
    font_bytes: &[u8],
    face_index: u32,
    variations: &[FontVariation],
    glyph_id: u32,
    pixel_size: u16,
) -> Result<RasterizedGlyph, GlyphRasterError> {
    if pixel_size == 0 || pixel_size > MAX_GLYPH_RASTER_DIMENSION {
        return Err(GlyphRasterError::InvalidPixelSize);
    }
    let mut face = ttf_parser::Face::parse(font_bytes, face_index)
        .map_err(|_| GlyphRasterError::InvalidFont)?;
    apply_ttf_variations(&mut face, variations).map_err(|_| GlyphRasterError::InvalidVariation)?;
    let glyph_id = u16::try_from(glyph_id).map_err(|_| GlyphRasterError::GlyphHasNoOutline)?;
    let mut outline = GlyphOutline::default();
    let bounds = face
        .outline_glyph(ttf_parser::GlyphId(glyph_id), &mut outline)
        .ok_or(GlyphRasterError::GlyphHasNoOutline)?;
    let units_per_em = face.units_per_em();
    if units_per_em == 0 {
        return Err(GlyphRasterError::InvalidFont);
    }
    let scale = f32::from(pixel_size) / f32::from(units_per_em);
    let width = scaled_dimension(bounds.x_max - bounds.x_min, scale)?;
    let height = scaled_dimension(bounds.y_max - bounds.y_min, scale)?;
    let pixel_count = usize::from(width)
        .checked_mul(usize::from(height))
        .ok_or(GlyphRasterError::ResourceLimit)?;
    let contours = outline.scaled_contours(scale, f32::from(bounds.x_min), f32::from(bounds.y_max));
    if contours.is_empty() {
        return Err(GlyphRasterError::GlyphHasNoOutline);
    }
    let mut pixels = vec![0; pixel_count];
    for y in 0..usize::from(height) {
        for x in 0..usize::from(width) {
            let mut covered = 0_u16;
            for sample_y in 0..GLYPH_RASTER_SAMPLES_PER_AXIS {
                for sample_x in 0..GLYPH_RASTER_SAMPLES_PER_AXIS {
                    let point = RasterPoint {
                        x: x as f32
                            + (sample_x as f32 + 0.5) / GLYPH_RASTER_SAMPLES_PER_AXIS as f32,
                        y: y as f32
                            + (sample_y as f32 + 0.5) / GLYPH_RASTER_SAMPLES_PER_AXIS as f32,
                    };
                    if point_in_outline(point, &contours) {
                        covered += 1;
                    }
                }
            }
            let sample_count =
                (GLYPH_RASTER_SAMPLES_PER_AXIS * GLYPH_RASTER_SAMPLES_PER_AXIS) as u16;
            pixels[y * usize::from(width) + x] =
                ((u32::from(covered) * 255) / u32::from(sample_count)) as u8;
        }
    }
    let bearing_x = rounded_i16(f32::from(bounds.x_min) * scale)?;
    let bearing_y = rounded_i16(f32::from(bounds.y_max) * scale)?;
    let ascent = rounded_i16(f32::from(face.ascender()) * scale)?;
    let advance_x = rounded_i16(
        f32::from(
            face.glyph_hor_advance(ttf_parser::GlyphId(glyph_id))
                .unwrap_or(0),
        ) * scale,
    )?;
    Ok(RasterizedGlyph {
        width,
        height,
        bearing_x,
        bearing_y,
        ascent,
        advance_x,
        pixels,
    })
}

fn scaled_dimension(units: i16, scale: f32) -> Result<u16, GlyphRasterError> {
    let pixels = (f32::from(units).abs() * scale).ceil();
    if !pixels.is_finite() || pixels <= 0.0 || pixels > f32::from(MAX_GLYPH_RASTER_DIMENSION) {
        return Err(GlyphRasterError::ResourceLimit);
    }
    Ok(pixels as u16)
}

fn rounded_i16(value: f32) -> Result<i16, GlyphRasterError> {
    let value = value.round();
    if !value.is_finite() || value < f32::from(i16::MIN) || value > f32::from(i16::MAX) {
        return Err(GlyphRasterError::ResourceLimit);
    }
    Ok(value as i16)
}

#[derive(Debug, Clone, Copy)]
struct RasterPoint {
    x: f32,
    y: f32,
}

#[derive(Debug, Default)]
struct GlyphOutline {
    contours: Vec<Vec<RasterPoint>>,
    current: Option<RasterPoint>,
}

impl GlyphOutline {
    fn push(&mut self, point: RasterPoint) {
        if let Some(contour) = self.contours.last_mut() {
            contour.push(point);
        }
        self.current = Some(point);
    }

    fn scaled_contours(&self, scale: f32, x_min: f32, y_max: f32) -> Vec<Vec<RasterPoint>> {
        self.contours
            .iter()
            .filter(|contour| contour.len() >= 3)
            .map(|contour| {
                contour
                    .iter()
                    .map(|point| RasterPoint {
                        x: (point.x - x_min) * scale,
                        y: (y_max - point.y) * scale,
                    })
                    .collect()
            })
            .collect()
    }
}

impl ttf_parser::OutlineBuilder for GlyphOutline {
    fn move_to(&mut self, x: f32, y: f32) {
        self.contours.push(vec![RasterPoint { x, y }]);
        self.current = Some(RasterPoint { x, y });
    }

    fn line_to(&mut self, x: f32, y: f32) {
        self.push(RasterPoint { x, y });
    }

    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        let start = self.current.unwrap_or(RasterPoint { x, y });
        let control = RasterPoint { x: x1, y: y1 };
        let end = RasterPoint { x, y };
        for step in 1..=8 {
            let t = step as f32 / 8.0;
            let inverse = 1.0 - t;
            self.push(RasterPoint {
                x: inverse * inverse * start.x + 2.0 * inverse * t * control.x + t * t * end.x,
                y: inverse * inverse * start.y + 2.0 * inverse * t * control.y + t * t * end.y,
            });
        }
    }

    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        let start = self.current.unwrap_or(RasterPoint { x, y });
        let first = RasterPoint { x: x1, y: y1 };
        let second = RasterPoint { x: x2, y: y2 };
        let end = RasterPoint { x, y };
        for step in 1..=12 {
            let t = step as f32 / 12.0;
            let inverse = 1.0 - t;
            self.push(RasterPoint {
                x: inverse.powi(3) * start.x
                    + 3.0 * inverse * inverse * t * first.x
                    + 3.0 * inverse * t * t * second.x
                    + t.powi(3) * end.x,
                y: inverse.powi(3) * start.y
                    + 3.0 * inverse * inverse * t * first.y
                    + 3.0 * inverse * t * t * second.y
                    + t.powi(3) * end.y,
            });
        }
    }

    fn close(&mut self) {}
}

fn point_in_outline(point: RasterPoint, contours: &[Vec<RasterPoint>]) -> bool {
    contours.iter().fold(false, |inside, contour| {
        inside ^ point_in_contour(point, contour)
    })
}

fn point_in_contour(point: RasterPoint, contour: &[RasterPoint]) -> bool {
    let mut inside = false;
    for index in 0..contour.len() {
        let left = contour[index];
        let right = contour[(index + 1) % contour.len()];
        let spans_y = (left.y > point.y) != (right.y > point.y);
        if !spans_y {
            continue;
        }
        let crossing_x = (right.x - left.x) * (point.y - left.y) / (right.y - left.y) + left.x;
        if point.x < crossing_x {
            inside = !inside;
        }
    }
    inside
}

/// Uses ICU4X line opportunities and Rustybuzz advances to produce a layout
/// without DOM/Canvas measurement. The width is specified in em so a worker
/// can reuse the same result at every zoom level.
pub fn layout_shaped_text(
    font_bytes: &[u8],
    face_index: u32,
    text: &str,
    max_width_em: f32,
) -> Result<ShapedTextLayout, TextShapingError> {
    layout_shaped_text_with_variations(font_bytes, face_index, &[], text, max_width_em)
}

/// Lays out explicit font bytes at declared variable-font coordinates. Callers
/// use this instead of CSS `font-variation-settings` so all replay paths share
/// the same shaping semantics.
pub fn layout_shaped_text_with_variations(
    font_bytes: &[u8],
    face_index: u32,
    variations: &[FontVariation],
    text: &str,
    max_width_em: f32,
) -> Result<ShapedTextLayout, TextShapingError> {
    if !max_width_em.is_finite() || max_width_em <= 0.0 {
        return Err(TextShapingError::InvalidLineWidth);
    }
    let face = rustybuzz_face(font_bytes, face_index, variations)?;
    let max_advance = (max_width_em * face.units_per_em() as f32).max(1.0) as i32;
    let segmenter = LineSegmenter::new_auto(Default::default());
    let mut lines = Vec::new();
    let mut carets = Vec::new();
    let mut paragraph_start = 0;

    for (separator_start, separator_len) in paragraph_boundaries(text) {
        append_shaped_paragraph(
            &face,
            &text[paragraph_start..separator_start],
            paragraph_start,
            max_advance,
            segmenter,
            &mut lines,
            &mut carets,
        );
        paragraph_start = separator_start + separator_len;
    }
    append_shaped_paragraph(
        &face,
        &text[paragraph_start..],
        paragraph_start,
        max_advance,
        segmenter,
        &mut lines,
        &mut carets,
    );
    Ok(ShapedTextLayout {
        units_per_em: face.units_per_em(),
        lines,
        carets,
    })
}

fn rustybuzz_face<'a>(
    font_bytes: &'a [u8],
    face_index: u32,
    variations: &[FontVariation],
) -> Result<rustybuzz::Face<'a>, TextShapingError> {
    let mut validation_face = ttf_parser::Face::parse(font_bytes, face_index)
        .map_err(|_| TextShapingError::InvalidFont)?;
    apply_ttf_variations(&mut validation_face, variations)
        .map_err(|_| TextShapingError::InvalidVariation)?;
    let mut face =
        rustybuzz::Face::from_slice(font_bytes, face_index).ok_or(TextShapingError::InvalidFont)?;
    let variations = variations
        .iter()
        .map(|variation| rustybuzz::Variation {
            tag: rustybuzz::ttf_parser::Tag::from_bytes(&variation.tag),
            value: variation.value,
        })
        .collect::<Vec<_>>();
    face.set_variations(&variations);
    Ok(face)
}

fn apply_ttf_variations(
    face: &mut ttf_parser::Face<'_>,
    variations: &[FontVariation],
) -> Result<(), ()> {
    let mut previous = None;
    for variation in variations {
        if !variation.value.is_finite()
            || !variation.tag.iter().all(|byte| byte.is_ascii_graphic())
            || previous.is_some_and(|tag| tag >= variation.tag)
        {
            return Err(());
        }
        let tag = ttf_parser::Tag::from_bytes(&variation.tag);
        if !face
            .variation_axes()
            .into_iter()
            .any(|axis| axis.tag == tag)
            || face.set_variation(tag, variation.value).is_none()
        {
            return Err(());
        }
        previous = Some(variation.tag);
    }
    Ok(())
}

fn shape_text_with_face(
    face: &rustybuzz::Face<'_>,
    text: &str,
    direction: TextDirection,
) -> ShapedText {
    let mut buffer = rustybuzz::UnicodeBuffer::new();
    buffer.push_str(text);
    buffer.set_direction(match direction {
        TextDirection::LeftToRight => rustybuzz::Direction::LeftToRight,
        TextDirection::RightToLeft => rustybuzz::Direction::RightToLeft,
    });
    let glyph_buffer = rustybuzz::shape(&face, &[], buffer);
    let glyphs = glyph_buffer
        .glyph_infos()
        .iter()
        .zip(glyph_buffer.glyph_positions())
        .map(|(info, position)| ShapedGlyph {
            glyph_id: info.glyph_id,
            cluster: info.cluster,
            x_advance: position.x_advance,
            y_advance: position.y_advance,
            x_offset: position.x_offset,
            y_offset: position.y_offset,
        })
        .collect();
    ShapedText {
        direction,
        units_per_em: face.units_per_em(),
        glyphs,
    }
}

/// Replaces a whole-grapheme selection without changing the Canonical Document.
/// IME uses this result as its display preview; on composition commit, callers
/// send the returned text through the existing atomic Document transaction.
pub fn replace_text_selection(
    text: &str,
    layout: &TextLayout,
    selection: TextSelection,
    replacement: &str,
) -> Result<TextEditResult, TextEditError> {
    if !layout.contains_caret(selection.anchor) || !layout.contains_caret(selection.focus) {
        return Err(TextEditError::SelectionIsNotAtAGraphemeBoundary);
    }
    let start = selection.start() as usize;
    let end = selection.end() as usize;
    let mut next = String::with_capacity(text.len() - (end - start) + replacement.len());
    next.push_str(&text[..start]);
    next.push_str(replacement);
    next.push_str(&text[end..]);
    let inserted_end = (start + replacement.len()) as u32;
    Ok(TextEditResult {
        text: next,
        selection: TextSelection::collapsed(inserted_end),
    })
}

fn append_paragraph(
    paragraph: &str,
    paragraph_byte_start: usize,
    limit: usize,
    lines: &mut Vec<TextLine>,
    carets: &mut Vec<CaretStop>,
) {
    let direction = paragraph_direction(paragraph);
    let graphemes = paragraph
        .grapheme_indices(true)
        .map(|(start, value)| (paragraph_byte_start + start, value.len()))
        .collect::<Vec<_>>();
    let line_index = lines.len() as u32;

    if graphemes.is_empty() {
        let byte_offset = paragraph_byte_start as u32;
        lines.push(TextLine {
            start: byte_offset,
            end: byte_offset,
            direction,
        });
        carets.push(CaretStop {
            byte_offset,
            line_index,
        });
        return;
    }

    for chunk in graphemes.chunks(limit) {
        let line_index = lines.len() as u32;
        let start = chunk[0].0;
        let end = chunk
            .last()
            .map(|(start, len)| start + len)
            .unwrap_or(start);
        lines.push(TextLine {
            start: start as u32,
            end: end as u32,
            direction,
        });
        carets.push(CaretStop {
            byte_offset: start as u32,
            line_index,
        });
        for (offset, length) in chunk {
            carets.push(CaretStop {
                byte_offset: (offset + length) as u32,
                line_index,
            });
        }
    }
}

fn append_shaped_paragraph(
    face: &rustybuzz::Face<'_>,
    paragraph: &str,
    paragraph_start: usize,
    max_advance: i32,
    segmenter: icu_segmenter::LineSegmenterBorrowed<'static>,
    lines: &mut Vec<ShapedTextLine>,
    carets: &mut Vec<CaretStop>,
) {
    let direction = paragraph_direction(paragraph);
    if paragraph.is_empty() {
        lines.push(ShapedTextLine {
            start: paragraph_start as u32,
            end: paragraph_start as u32,
            direction,
            advance: 0,
            visual_runs: Vec::new(),
            glyphs: Vec::new(),
        });
        carets.push(CaretStop {
            byte_offset: paragraph_start as u32,
            line_index: (lines.len() - 1) as u32,
        });
        return;
    }
    let mut breakpoints = segmenter
        .segment_str(paragraph)
        .filter(|offset| *offset > 0)
        .collect::<Vec<_>>();
    if breakpoints.last().copied() != Some(paragraph.len()) {
        breakpoints.push(paragraph.len());
    }
    let mut start = 0;
    while start < paragraph.len() {
        let mut fitted: Option<(usize, ShapedText, i32, Vec<VisualTextRun>)> = None;
        let mut first_overflow: Option<(usize, ShapedText, i32, Vec<VisualTextRun>)> = None;
        for end in breakpoints.iter().copied().filter(|end| *end > start) {
            let (shaped, visual_runs) = shape_visual_line(face, &paragraph[start..end]);
            let advance = shaped_advance(&shaped);
            if advance <= max_advance {
                fitted = Some((end, shaped, advance, visual_runs));
            } else {
                first_overflow = Some((end, shaped, advance, visual_runs));
                break;
            }
        }
        let (end, mut shaped, advance, mut visual_runs) = fitted
            .or(first_overflow)
            // ICU4X always emits the text end, but preserve a no-panic fallback
            // for future segmenter changes.
            .unwrap_or_else(|| {
                let (shaped, visual_runs) = shape_visual_line(face, &paragraph[start..]);
                let advance = shaped_advance(&shaped);
                (paragraph.len(), shaped, advance, visual_runs)
            });
        for glyph in &mut shaped.glyphs {
            glyph.cluster += (paragraph_start + start) as u32;
        }
        for visual_run in &mut visual_runs {
            visual_run.start += (paragraph_start + start) as u32;
            visual_run.end += (paragraph_start + start) as u32;
        }
        lines.push(ShapedTextLine {
            start: (paragraph_start + start) as u32,
            end: (paragraph_start + end) as u32,
            direction,
            advance,
            visual_runs,
            glyphs: shaped.glyphs,
        });
        let line_index = (lines.len() - 1) as u32;
        carets.push(CaretStop {
            byte_offset: (paragraph_start + start) as u32,
            line_index,
        });
        for (offset, grapheme) in paragraph[start..end].grapheme_indices(true) {
            carets.push(CaretStop {
                byte_offset: (paragraph_start + start + offset + grapheme.len()) as u32,
                line_index,
            });
        }
        start = end;
    }
}

/// Shapes each resolved UAX #9 run in its own direction, then flattens glyphs
/// in display order. The source range remains byte-for-byte unchanged: Rustybuzz
/// clusters are only offset after this function returns.
fn shape_visual_line(face: &rustybuzz::Face<'_>, text: &str) -> (ShapedText, Vec<VisualTextRun>) {
    let direction = paragraph_direction(text);
    let visual_runs = bidi_visual_runs(text);
    if visual_runs.is_empty() {
        return (shape_text_with_face(face, text, direction), visual_runs);
    }
    let mut glyphs = Vec::new();
    for run in &visual_runs {
        let start = run.start as usize;
        let end = run.end as usize;
        let mut shaped = shape_text_with_face(face, &text[start..end], run.direction);
        for glyph in &mut shaped.glyphs {
            glyph.cluster += run.start;
        }
        glyphs.extend(shaped.glyphs);
    }
    (
        ShapedText {
            direction,
            units_per_em: face.units_per_em(),
            glyphs,
        },
        visual_runs,
    )
}

fn shaped_advance(shaped: &ShapedText) -> i32 {
    shaped.glyphs.iter().fold(0_i32, |total, glyph| {
        total.saturating_add(glyph.x_advance.abs())
    })
}

fn paragraph_direction(value: &str) -> TextDirection {
    BidiInfo::new(value, None)
        .paragraphs
        .first()
        .is_some_and(|paragraph| paragraph.level.is_rtl())
        .then_some(TextDirection::RightToLeft)
        .unwrap_or(TextDirection::LeftToRight)
}

fn paragraph_boundaries(value: &str) -> Vec<(usize, usize)> {
    let bytes = value.as_bytes();
    let mut result = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        let len = match bytes[index] {
            b'\r' if bytes.get(index + 1) == Some(&b'\n') => 2,
            b'\r' | b'\n' => 1,
            0xE2 if bytes.get(index..index + 3) == Some(&[0xE2, 0x80, 0xA8])
                || bytes.get(index..index + 3) == Some(&[0xE2, 0x80, 0xA9]) =>
            {
                3
            }
            _ => {
                index += 1;
                continue;
            }
        };
        result.push((index, len));
        index += len;
    }
    result
}

fn byte_offset(value: &str, char_offset: usize) -> usize {
    value[..char_offset].len()
}

#[cfg(test)]
mod tests {
    use super::{
        CaretStop, FontVariation, GlyphAtlas, GlyphAtlasError, GlyphKey, GlyphRasterError,
        TextDirection, TextLine, TextSelection, bidi_visual_runs, fallback_text_layout,
        layout_shaped_text, layout_shaped_text_with_variations, rasterize_glyph,
        rasterize_glyph_with_variations, replace_text_selection, shape_text,
        shape_text_with_variations,
    };

    #[test]
    fn keeps_utf8_graphemes_and_caret_stops_together() {
        let layout = fallback_text_layout("A😀中", 2);
        assert_eq!(
            layout.lines,
            vec![
                TextLine {
                    start: 0,
                    end: 5,
                    direction: TextDirection::LeftToRight
                },
                TextLine {
                    start: 5,
                    end: 8,
                    direction: TextDirection::LeftToRight
                },
            ]
        );
        assert_eq!(
            layout.carets,
            vec![
                CaretStop {
                    byte_offset: 0,
                    line_index: 0
                },
                CaretStop {
                    byte_offset: 1,
                    line_index: 0
                },
                CaretStop {
                    byte_offset: 5,
                    line_index: 0
                },
                CaretStop {
                    byte_offset: 5,
                    line_index: 1
                },
                CaretStop {
                    byte_offset: 8,
                    line_index: 1
                },
            ]
        );
    }

    #[test]
    fn keeps_empty_lines_and_uses_unicode_bidi_direction() {
        let layout = fallback_text_layout("مرحبا\n\nHello", 20);
        assert_eq!(layout.lines.len(), 3);
        assert_eq!(layout.lines[0].direction, TextDirection::RightToLeft);
        assert_eq!(layout.lines[1].start, layout.lines[1].end);
        assert_eq!(layout.lines[2].direction, TextDirection::LeftToRight);
    }

    #[test]
    fn replacement_and_ime_preview_never_split_an_emoji_grapheme() {
        let layout = fallback_text_layout("A😀B", 80);
        let result = replace_text_selection(
            "A😀B",
            &layout,
            TextSelection {
                anchor: 1,
                focus: 5,
            },
            "中",
        )
        .unwrap();
        assert_eq!(result.text, "A中B");
        assert_eq!(result.selection, TextSelection::collapsed(4));
        assert!(
            replace_text_selection("A😀B", &layout, TextSelection::collapsed(2), "x",).is_err()
        );
    }

    #[test]
    fn snaps_untrusted_offsets_to_a_stable_caret_boundary() {
        let layout = fallback_text_layout("A😀B", 80);
        assert_eq!(
            layout.snap_selection(TextSelection {
                anchor: 2,
                focus: 4
            }),
            TextSelection {
                anchor: 1,
                focus: 5
            },
        );
    }

    #[test]
    fn shapes_explicit_font_bytes_without_platform_measurement() {
        let text = "office";
        let shaped = shape_text(
            font_test_data::NOTO_SERIF_DISPLAY_TRIMMED,
            0,
            text,
            TextDirection::LeftToRight,
        )
        .unwrap();
        assert_eq!(shaped.direction, TextDirection::LeftToRight);
        assert!(shaped.units_per_em > 0);
        assert!(!shaped.glyphs.is_empty());
        assert!(shaped.glyphs.iter().any(|glyph| glyph.glyph_id != 0));
        assert!(
            shaped
                .glyphs
                .iter()
                .all(|glyph| (glyph.cluster as usize) < text.len())
        );
        assert_eq!(
            shaped,
            shape_text(
                font_test_data::NOTO_SERIF_DISPLAY_TRIMMED,
                0,
                text,
                TextDirection::LeftToRight,
            )
            .unwrap()
        );
    }

    #[test]
    fn resolves_mixed_bidi_text_to_display_order_runs_without_rewriting_utf8() {
        let text = "office مرحبا office";
        let runs = bidi_visual_runs(text);
        assert!(runs.len() >= 3);
        assert!(
            runs.iter()
                .any(|run| run.direction == TextDirection::RightToLeft)
        );
        let mut logical = runs.clone();
        logical.sort_by_key(|run| run.start);
        assert_eq!(logical.first().map(|run| run.start), Some(0));
        assert_eq!(logical.last().map(|run| run.end), Some(text.len() as u32));
        assert!(logical.windows(2).all(|runs| runs[0].end == runs[1].start));

        let layout =
            layout_shaped_text(font_test_data::NOTO_SERIF_DISPLAY_TRIMMED, 0, text, 100.0).unwrap();
        let line = &layout.lines[0];
        assert_eq!(line.visual_runs, runs);
        assert!(
            line.glyphs
                .windows(2)
                .any(|glyphs| glyphs[0].cluster > glyphs[1].cluster)
        );
    }

    #[test]
    fn rejects_untrusted_non_font_bytes_before_shaping() {
        assert!(shape_text(&[0, 1, 2], 0, "text", TextDirection::LeftToRight).is_err());
    }

    #[test]
    fn rasterizes_a_font_outline_as_a_bounded_deterministic_alpha_mask() {
        // `font-test-data` deliberately keeps glyph 1 as an outlined fixture
        // independently of cmap coverage, making this raster boundary test
        // stable even if shaping test strings evolve.
        let first = rasterize_glyph(font_test_data::NOTO_SERIF_DISPLAY_TRIMMED, 0, 1, 32).unwrap();
        let second = rasterize_glyph(font_test_data::NOTO_SERIF_DISPLAY_TRIMMED, 0, 1, 32).unwrap();
        assert_eq!(first, second);
        assert!(first.width > 0 && first.height > 0);
        assert_eq!(
            first.pixels.len(),
            usize::from(first.width) * usize::from(first.height)
        );
        assert!(first.pixels.iter().any(|alpha| *alpha > 0));
        assert!(first.advance_x > 0);
    }

    #[test]
    fn variable_font_coordinates_are_validated_and_reach_shaping_and_rasterization() {
        let thin = [FontVariation {
            tag: *b"wght",
            value: 100.0,
        }];
        let bold = [FontVariation {
            tag: *b"wght",
            value: 800.0,
        }];
        let thin_shape = shape_text_with_variations(
            font_test_data::VAZIRMATN_VAR,
            0,
            &thin,
            "ا",
            TextDirection::LeftToRight,
        )
        .unwrap();
        let bold_shape = shape_text_with_variations(
            font_test_data::VAZIRMATN_VAR,
            0,
            &bold,
            "ا",
            TextDirection::LeftToRight,
        )
        .unwrap();
        assert_eq!(
            thin_shape,
            shape_text_with_variations(
                font_test_data::VAZIRMATN_VAR,
                0,
                &thin,
                "ا",
                TextDirection::LeftToRight
            )
            .unwrap()
        );
        // This fixture deliberately keeps glyph 1 as a simple variable glyf
        // outline even when the test string's cmap glyph is stripped.
        let glyph_id = 1;
        let thin_raster =
            rasterize_glyph_with_variations(font_test_data::VAZIRMATN_VAR, 0, &thin, glyph_id, 48)
                .unwrap();
        let bold_raster =
            rasterize_glyph_with_variations(font_test_data::VAZIRMATN_VAR, 0, &bold, glyph_id, 48)
                .unwrap();
        assert_ne!(thin_raster.pixels, bold_raster.pixels);
        assert!(!thin_shape.glyphs.is_empty());
        assert!(!bold_shape.glyphs.is_empty());
        assert!(
            layout_shaped_text_with_variations(
                font_test_data::VAZIRMATN_VAR,
                0,
                &bold,
                "ا ا",
                10.0
            )
            .is_ok()
        );
        assert!(
            shape_text_with_variations(
                font_test_data::VAZIRMATN_VAR,
                0,
                &[FontVariation {
                    tag: *b"wdth",
                    value: 100.0
                }],
                "ا",
                TextDirection::LeftToRight
            )
            .is_err()
        );
    }

    #[test]
    fn rejects_invalid_or_unbounded_glyph_raster_requests() {
        assert_eq!(
            rasterize_glyph(font_test_data::NOTO_SERIF_DISPLAY_TRIMMED, 0, 1, 0),
            Err(GlyphRasterError::InvalidPixelSize)
        );
        assert_eq!(
            rasterize_glyph(font_test_data::NOTO_SERIF_DISPLAY_TRIMMED, 0, 1, 513),
            Err(GlyphRasterError::InvalidPixelSize)
        );
        assert_eq!(
            rasterize_glyph(&[0, 1, 2], 0, 1, 16),
            Err(GlyphRasterError::InvalidFont)
        );
    }

    #[test]
    fn uses_icu4x_breaks_and_shaped_advances_without_splitting_ligatures() {
        let text = "office office";
        let layout =
            layout_shaped_text(font_test_data::NOTO_SERIF_DISPLAY_TRIMMED, 0, text, 3.0).unwrap();
        assert_eq!(layout.lines.len(), 2);
        assert_eq!((layout.lines[0].start, layout.lines[0].end), (0, 7));
        assert_eq!(
            (layout.lines[1].start, layout.lines[1].end),
            (7, text.len() as u32)
        );
        assert!(layout.lines.iter().all(|line| line.advance > 0));
        assert!(
            layout
                .lines
                .iter()
                .flat_map(|line| &line.glyphs)
                .all(|glyph| (glyph.cluster as usize) < text.len())
        );
    }

    #[test]
    fn lays_out_a_ten_thousand_character_fixture_from_font_bytes() {
        let mut text = "office ".repeat(1_667);
        text.truncate(10_000);
        assert_eq!(text.len(), 10_000);
        let layout =
            layout_shaped_text(font_test_data::NOTO_SERIF_DISPLAY_TRIMMED, 0, &text, 6.0).unwrap();
        assert!(!layout.lines.is_empty());
        assert!(layout.lines.iter().all(|line| {
            line.start <= line.end
                && (line.end as usize) <= text.len()
                && line.advance >= 0
                && line
                    .glyphs
                    .iter()
                    .all(|glyph| (glyph.cluster as usize) < text.len())
        }));
        assert!(
            layout
                .carets
                .iter()
                .all(|caret| (caret.byte_offset as usize) <= text.len())
        );
    }

    #[test]
    fn glyph_atlas_reuses_entries_and_can_be_rebuilt_after_loss() {
        let key = GlyphKey {
            font_key: 9,
            face_index: 0,
            glyph_id: 42,
            pixel_size: 16,
        };
        let mut atlas = GlyphAtlas::new(16, 16, 2);
        assert_eq!(
            atlas.insert(key, 8, 8).unwrap(),
            atlas.insert(key, 8, 8).unwrap()
        );
        assert_eq!(atlas.len(), 1);
        atlas
            .insert(
                GlyphKey {
                    glyph_id: 43,
                    ..key
                },
                8,
                8,
            )
            .unwrap();
        assert_eq!(
            atlas.insert(
                GlyphKey {
                    glyph_id: 44,
                    ..key
                },
                1,
                1
            ),
            Err(GlyphAtlasError::AtlasFull)
        );
        atlas.clear();
        assert_eq!(atlas.len(), 0);
        assert_eq!(atlas.insert(key, 8, 8).unwrap().x, 0);
    }
}
