//! Deterministic, GPU-handle-free graphics primitives.
//!
//! This crate deliberately owns no FontFace, canvas, or wgpu object. It is the
//! shared text/scene input boundary that can be replayed in a browser Worker,
//! service fixture, or future native renderer without mutating Canonical
//! Document state.

use std::collections::BTreeMap;
use std::collections::VecDeque;

use icu_segmenter::LineSegmenter;
use unicode_bidi::{BidiInfo, Level};
use unicode_segmentation::UnicodeSegmentation;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextDirection {
    LeftToRight,
    RightToLeft,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShapedGlyph {
    pub glyph_id: u32,
    /// Transient metric Style Run owner. Single-face shaping uses zero; the
    /// multi-run renderer uses this to select the exact font raster resource.
    pub run_index: u32,
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
    /// Legal grapheme stops in physical left-to-right order. `x_advance` is
    /// measured from the line origin in font units. A logical byte boundary
    /// may occur more than once at bidi run boundaries; those occurrences
    /// retain separate physical affinities.
    pub visual_carets: Vec<PositionedCaretStop>,
    pub glyphs: Vec<ShapedGlyph>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PositionedCaretStop {
    pub byte_offset: u32,
    pub x_advance: i32,
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
    InvalidStyleRun,
}

/// A declared OpenType variation coordinate. Four ASCII bytes match the
/// Canonical `FontReference` axis tag without involving platform font APIs.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FontVariation {
    pub tag: [u8; 4],
    pub value: f32,
}

/// Presentation-only synthesis requested when one explicit font resource must
/// cover a Canonical weight/style run. These values never rewrite font bytes
/// or enter document state; shaping preserves the face's authored advances,
/// while rasterization applies a deterministic bounded outline treatment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyntheticFontStyle {
    pub font_weight: u16,
    pub italic: bool,
}

impl Default for SyntheticFontStyle {
    fn default() -> Self {
        Self {
            font_weight: 400,
            italic: false,
        }
    }
}

impl SyntheticFontStyle {
    fn is_valid(self) -> bool {
        (1..=1_000).contains(&self.font_weight)
    }
}

/// One explicit metric-bearing style range for multi-run shaping. Ranges are
/// UTF-8 byte offsets in the supplied presentation string and must form one
/// contiguous, non-overlapping cover. Paint is intentionally absent: it does
/// not affect line breaks or caret geometry.
pub struct TextShapingRun<'a> {
    pub font_bytes: &'a [u8],
    pub face_index: u32,
    pub variations: &'a [FontVariation],
    pub start: u32,
    pub end: u32,
    pub font_size: f32,
    /// Synthetic style does not alter the explicit face's authored advances,
    /// but is validated here so shaping and raster run identities cannot drift.
    pub synthetic_style: SyntheticFontStyle,
    /// Figma PIXELS tracking. It is converted into the first run's font-unit
    /// coordinate system before line fitting and caret placement.
    pub letter_spacing: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct GlyphKey {
    /// Stable digest-derived identity of font bytes, not a platform FontFace.
    pub font_key: u64,
    pub face_index: u32,
    pub glyph_id: u32,
    pub pixel_size: u16,
    pub font_weight: u16,
    pub italic: bool,
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
    InvalidSyntheticStyle,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextLine {
    /// UTF-8 byte offsets into the unmodified source text.
    pub start: u32,
    pub end: u32,
    pub direction: TextDirection,
    /// UAX #9 level runs in physical display order. Their ranges retain the
    /// original UTF-8 offsets, so one logical boundary may intentionally
    /// occur at two different visual caret positions.
    pub visual_runs: Vec<VisualTextRun>,
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
    bidi_visual_runs_with_base(text, None)
}

fn bidi_visual_runs_with_base(
    text: &str,
    base_direction: Option<TextDirection>,
) -> Vec<VisualTextRun> {
    if text.is_empty() {
        return Vec::new();
    }
    let base_level = base_direction.map(|direction| match direction {
        TextDirection::LeftToRight => Level::ltr(),
        TextDirection::RightToLeft => Level::rtl(),
    });
    let bidi = BidiInfo::new(text, base_level);
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
    rasterize_glyph_with_variations_and_style(
        font_bytes,
        face_index,
        variations,
        glyph_id,
        pixel_size,
        SyntheticFontStyle::default(),
    )
}

/// Rasterizes one explicit glyph with deterministic synthetic bold/italic.
/// The face's advance and ascent remain unchanged; only the bounded alpha mask
/// and its bitmap bearings change, matching the usual font-synthesis contract.
pub fn rasterize_glyph_with_variations_and_style(
    font_bytes: &[u8],
    face_index: u32,
    variations: &[FontVariation],
    glyph_id: u32,
    pixel_size: u16,
    synthetic_style: SyntheticFontStyle,
) -> Result<RasterizedGlyph, GlyphRasterError> {
    if pixel_size == 0 || pixel_size > MAX_GLYPH_RASTER_DIMENSION {
        return Err(GlyphRasterError::InvalidPixelSize);
    }
    if !synthetic_style.is_valid() {
        return Err(GlyphRasterError::InvalidSyntheticStyle);
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
    apply_synthetic_font_style(
        RasterizedGlyph {
            width,
            height,
            bearing_x,
            bearing_y,
            ascent,
            advance_x,
            pixels,
        },
        synthetic_style,
        pixel_size,
    )
}

const SYNTHETIC_ITALIC_TANGENT: f32 = 0.212_556_56; // tan(12°)
const MAX_SYNTHETIC_EMBOLDEN_RADIUS: usize = 16;

fn apply_synthetic_font_style(
    mut raster: RasterizedGlyph,
    style: SyntheticFontStyle,
    pixel_size: u16,
) -> Result<RasterizedGlyph, GlyphRasterError> {
    if style.italic {
        raster = shear_raster(raster, SYNTHETIC_ITALIC_TANGENT)?;
    }
    let weight_excess = usize::from(style.font_weight.saturating_sub(400));
    if weight_excess > 0 {
        // 4% of the em at weight 1000, rounded upward so common 600/700
        // requests remain visibly distinct at UI text sizes.
        let numerator = usize::from(pixel_size)
            .checked_mul(weight_excess)
            .ok_or(GlyphRasterError::ResourceLimit)?;
        let radius = numerator
            .div_ceil(15_000)
            .clamp(1, MAX_SYNTHETIC_EMBOLDEN_RADIUS);
        raster = embolden_raster(raster, radius)?;
    }
    Ok(raster)
}

fn shear_raster(
    raster: RasterizedGlyph,
    tangent: f32,
) -> Result<RasterizedGlyph, GlyphRasterError> {
    let width = usize::from(raster.width);
    let height = usize::from(raster.height);
    let shifts = (0..height)
        .map(|row| {
            (f32::from(raster.bearing_y) - row as f32 - 0.5)
                .mul_add(tangent, 0.0)
                .round() as i32
        })
        .collect::<Vec<_>>();
    let min_shift = shifts.iter().copied().min().unwrap_or(0);
    let max_shift = shifts.iter().copied().max().unwrap_or(0);
    let shift_span =
        usize::try_from(max_shift - min_shift).map_err(|_| GlyphRasterError::ResourceLimit)?;
    let output_width = width
        .checked_add(shift_span)
        .filter(|value| *value <= usize::from(MAX_GLYPH_RASTER_DIMENSION))
        .ok_or(GlyphRasterError::ResourceLimit)?;
    let mut pixels = vec![0; output_width * height];
    for (row, shift) in shifts.into_iter().enumerate() {
        let destination =
            usize::try_from(shift - min_shift).map_err(|_| GlyphRasterError::ResourceLimit)?;
        let source_start = row * width;
        let destination_start = row * output_width + destination;
        pixels[destination_start..destination_start + width]
            .copy_from_slice(&raster.pixels[source_start..source_start + width]);
    }
    Ok(RasterizedGlyph {
        width: u16::try_from(output_width).map_err(|_| GlyphRasterError::ResourceLimit)?,
        bearing_x: i16::try_from(i32::from(raster.bearing_x) + min_shift)
            .map_err(|_| GlyphRasterError::ResourceLimit)?,
        pixels,
        ..raster
    })
}

fn embolden_raster(
    raster: RasterizedGlyph,
    radius: usize,
) -> Result<RasterizedGlyph, GlyphRasterError> {
    let width = usize::from(raster.width);
    let height = usize::from(raster.height);
    let padding = radius
        .checked_mul(2)
        .ok_or(GlyphRasterError::ResourceLimit)?;
    let output_width = width
        .checked_add(padding)
        .filter(|value| *value <= usize::from(MAX_GLYPH_RASTER_DIMENSION))
        .ok_or(GlyphRasterError::ResourceLimit)?;
    let output_height = height
        .checked_add(padding)
        .filter(|value| *value <= usize::from(MAX_GLYPH_RASTER_DIMENSION))
        .ok_or(GlyphRasterError::ResourceLimit)?;
    let mut padded = vec![0; output_width * output_height];
    for source_y in 0..height {
        let source_start = source_y * width;
        let destination_start = (source_y + radius) * output_width + radius;
        padded[destination_start..destination_start + width]
            .copy_from_slice(&raster.pixels[source_start..source_start + width]);
    }
    // A separable sliding maximum keeps synthesis O(bitmap pixels) even for
    // the largest admitted weight and glyph, rather than multiplying work by
    // the dilation radius for every covered sample.
    let mut horizontal = vec![0; padded.len()];
    for row in 0..output_height {
        max_filter_row(
            &padded[row * output_width..(row + 1) * output_width],
            &mut horizontal[row * output_width..(row + 1) * output_width],
            radius,
        );
    }
    let mut pixels = vec![0; padded.len()];
    for column in 0..output_width {
        max_filter_column(
            &horizontal,
            &mut pixels,
            output_width,
            output_height,
            column,
            radius,
        );
    }
    Ok(RasterizedGlyph {
        width: u16::try_from(output_width).map_err(|_| GlyphRasterError::ResourceLimit)?,
        height: u16::try_from(output_height).map_err(|_| GlyphRasterError::ResourceLimit)?,
        bearing_x: raster
            .bearing_x
            .checked_sub(i16::try_from(radius).map_err(|_| GlyphRasterError::ResourceLimit)?)
            .ok_or(GlyphRasterError::ResourceLimit)?,
        bearing_y: raster
            .bearing_y
            .checked_add(i16::try_from(radius).map_err(|_| GlyphRasterError::ResourceLimit)?)
            .ok_or(GlyphRasterError::ResourceLimit)?,
        pixels,
        ..raster
    })
}

fn max_filter_row(input: &[u8], output: &mut [u8], radius: usize) {
    let mut candidates = VecDeque::<usize>::new();
    let mut next = 0_usize;
    for center in 0..input.len() {
        let window_end = center.saturating_add(radius).min(input.len() - 1);
        while next <= window_end {
            while candidates
                .back()
                .is_some_and(|index| input[*index] <= input[next])
            {
                candidates.pop_back();
            }
            candidates.push_back(next);
            next += 1;
        }
        let window_start = center.saturating_sub(radius);
        while candidates
            .front()
            .is_some_and(|index| *index < window_start)
        {
            candidates.pop_front();
        }
        output[center] = candidates.front().map_or(0, |index| input[*index]);
    }
}

fn max_filter_column(
    input: &[u8],
    output: &mut [u8],
    width: usize,
    height: usize,
    column: usize,
    radius: usize,
) {
    let mut candidates = VecDeque::<usize>::new();
    let mut next = 0_usize;
    for center in 0..height {
        let window_end = center.saturating_add(radius).min(height - 1);
        while next <= window_end {
            let alpha = input[next * width + column];
            while candidates
                .back()
                .is_some_and(|row| input[*row * width + column] <= alpha)
            {
                candidates.pop_back();
            }
            candidates.push_back(next);
            next += 1;
        }
        let window_start = center.saturating_sub(radius);
        while candidates.front().is_some_and(|row| *row < window_start) {
            candidates.pop_front();
        }
        output[center * width + column] = candidates
            .front()
            .map_or(0, |row| input[*row * width + column]);
    }
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

struct PreparedTextShapingRun<'a> {
    face: rustybuzz::Face<'a>,
    start: usize,
    end: usize,
    index: u32,
    /// Converts this face's font units into the first run's font-unit
    /// coordinate system. Consumers keep using `primary_size / units_per_em`
    /// to recover document pixels for every run.
    scale: f64,
    /// Signed tracking in the first run's font-unit coordinate system.
    letter_spacing: i32,
}

/// Shapes contiguous explicit-font style runs as one paragraph layout. Each
/// UAX #9 visual run is intersected with the authored style ranges before
/// Rustybuzz shaping, and candidate line widths include the normalized advance
/// of every intersection. This preserves one physical caret coordinate system
/// even when faces have different units-per-em or runs use different sizes.
pub fn layout_shaped_text_runs(
    runs: &[TextShapingRun<'_>],
    text: &str,
    max_width_px: f32,
) -> Result<ShapedTextLayout, TextShapingError> {
    if !max_width_px.is_finite() || max_width_px <= 0.0 {
        return Err(TextShapingError::InvalidLineWidth);
    }
    if text.is_empty() || runs.is_empty() || runs.len() > 4_096 {
        return Err(TextShapingError::InvalidStyleRun);
    }
    let primary_size = runs[0].font_size;
    if !primary_size.is_finite() || primary_size <= 0.0 {
        return Err(TextShapingError::InvalidStyleRun);
    }
    let mut cursor = 0_usize;
    let mut prepared = Vec::with_capacity(runs.len());
    let mut primary_units = None;
    for (index, run) in runs.iter().enumerate() {
        let start = run.start as usize;
        let end = run.end as usize;
        if start != cursor
            || end <= start
            || end > text.len()
            || !text.is_char_boundary(start)
            || !text.is_char_boundary(end)
            || !run.font_size.is_finite()
            || run.font_size <= 0.0
            || !run.synthetic_style.is_valid()
            || !run.letter_spacing.is_finite()
            || !(-10_000.0..=10_000.0).contains(&run.letter_spacing)
        {
            return Err(TextShapingError::InvalidStyleRun);
        }
        let face = rustybuzz_face(run.font_bytes, run.face_index, run.variations)?;
        let units = face.units_per_em() as f64;
        let reference_units = *primary_units.get_or_insert(face.units_per_em());
        let scale = run.font_size as f64 * reference_units as f64 / (units * primary_size as f64);
        if !scale.is_finite() || scale <= 0.0 {
            return Err(TextShapingError::InvalidStyleRun);
        }
        let letter_spacing =
            run.letter_spacing as f64 * reference_units as f64 / primary_size as f64;
        if !letter_spacing.is_finite()
            || letter_spacing < i32::MIN as f64
            || letter_spacing > i32::MAX as f64
        {
            return Err(TextShapingError::InvalidStyleRun);
        }
        prepared.push(PreparedTextShapingRun {
            face,
            start,
            end,
            index: index as u32,
            scale,
            letter_spacing: letter_spacing.round() as i32,
        });
        cursor = end;
    }
    if cursor != text.len() {
        return Err(TextShapingError::InvalidStyleRun);
    }
    let units_per_em = primary_units.ok_or(TextShapingError::InvalidStyleRun)?;
    let max_advance = (max_width_px * units_per_em as f32 / primary_size)
        .max(1.0)
        .round() as i32;
    let segmenter = LineSegmenter::new_auto(Default::default());
    let mut lines = Vec::new();
    let mut carets = Vec::new();
    let mut paragraph_start = 0;
    for (separator_start, separator_len) in paragraph_boundaries(text) {
        append_shaped_run_paragraph(
            &prepared,
            &text[paragraph_start..separator_start],
            paragraph_start,
            max_advance,
            segmenter,
            units_per_em,
            &mut lines,
            &mut carets,
        )?;
        paragraph_start = separator_start + separator_len;
    }
    append_shaped_run_paragraph(
        &prepared,
        &text[paragraph_start..],
        paragraph_start,
        max_advance,
        segmenter,
        units_per_em,
        &mut lines,
        &mut carets,
    )?;
    Ok(ShapedTextLayout {
        units_per_em,
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
            run_index: 0,
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
            visual_runs: Vec::new(),
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
        let mut visual_runs = bidi_visual_runs_with_base(
            &paragraph[start - paragraph_byte_start..end - paragraph_byte_start],
            Some(direction),
        );
        for run in &mut visual_runs {
            run.start += start as u32;
            run.end += start as u32;
        }
        lines.push(TextLine {
            start: start as u32,
            end: end as u32,
            direction,
            visual_runs,
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
            visual_carets: vec![PositionedCaretStop {
                byte_offset: paragraph_start as u32,
                x_advance: 0,
            }],
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
        let mut fitted: Option<(
            usize,
            ShapedText,
            i32,
            Vec<VisualTextRun>,
            Vec<PositionedCaretStop>,
        )> = None;
        let mut first_overflow: Option<(
            usize,
            ShapedText,
            i32,
            Vec<VisualTextRun>,
            Vec<PositionedCaretStop>,
        )> = None;
        for end in breakpoints.iter().copied().filter(|end| *end > start) {
            let (shaped, visual_runs, visual_carets) =
                shape_visual_line(face, &paragraph[start..end]);
            let advance = shaped_advance(&shaped);
            if advance <= max_advance {
                fitted = Some((end, shaped, advance, visual_runs, visual_carets));
            } else {
                first_overflow = Some((end, shaped, advance, visual_runs, visual_carets));
                break;
            }
        }
        let (end, mut shaped, advance, mut visual_runs, mut visual_carets) = fitted
            .or(first_overflow)
            // ICU4X always emits the text end, but preserve a no-panic fallback
            // for future segmenter changes.
            .unwrap_or_else(|| {
                let (shaped, visual_runs, visual_carets) =
                    shape_visual_line(face, &paragraph[start..]);
                let advance = shaped_advance(&shaped);
                (paragraph.len(), shaped, advance, visual_runs, visual_carets)
            });
        for glyph in &mut shaped.glyphs {
            glyph.cluster += (paragraph_start + start) as u32;
        }
        for visual_run in &mut visual_runs {
            visual_run.start += (paragraph_start + start) as u32;
            visual_run.end += (paragraph_start + start) as u32;
        }
        for visual_caret in &mut visual_carets {
            visual_caret.byte_offset += (paragraph_start + start) as u32;
        }
        lines.push(ShapedTextLine {
            start: (paragraph_start + start) as u32,
            end: (paragraph_start + end) as u32,
            direction,
            advance,
            visual_runs,
            visual_carets,
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

#[allow(clippy::too_many_arguments)]
fn append_shaped_run_paragraph(
    runs: &[PreparedTextShapingRun<'_>],
    paragraph: &str,
    paragraph_start: usize,
    max_advance: i32,
    segmenter: icu_segmenter::LineSegmenterBorrowed<'static>,
    units_per_em: i32,
    lines: &mut Vec<ShapedTextLine>,
    carets: &mut Vec<CaretStop>,
) -> Result<(), TextShapingError> {
    let direction = paragraph_direction(paragraph);
    if paragraph.is_empty() {
        lines.push(ShapedTextLine {
            start: paragraph_start as u32,
            end: paragraph_start as u32,
            direction,
            advance: 0,
            visual_runs: Vec::new(),
            visual_carets: vec![PositionedCaretStop {
                byte_offset: paragraph_start as u32,
                x_advance: 0,
            }],
            glyphs: Vec::new(),
        });
        carets.push(CaretStop {
            byte_offset: paragraph_start as u32,
            line_index: (lines.len() - 1) as u32,
        });
        return Ok(());
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
        let mut fitted = None;
        let mut first_overflow = None;
        for end in breakpoints.iter().copied().filter(|end| *end > start) {
            let candidate = shape_styled_visual_line(
                runs,
                &paragraph[start..end],
                paragraph_start + start,
                units_per_em,
            )?;
            if candidate.2 <= max_advance {
                fitted = Some((end, candidate));
            } else {
                first_overflow = Some((end, candidate));
                break;
            }
        }
        let (end, (mut shaped, mut visual_runs, advance, mut visual_carets)) =
            match fitted.or(first_overflow) {
                Some(candidate) => candidate,
                None => (
                    paragraph.len(),
                    shape_styled_visual_line(
                        runs,
                        &paragraph[start..],
                        paragraph_start + start,
                        units_per_em,
                    )?,
                ),
            };
        let absolute_start = (paragraph_start + start) as u32;
        for glyph in &mut shaped.glyphs {
            glyph.cluster += absolute_start;
        }
        for visual_run in &mut visual_runs {
            visual_run.start += absolute_start;
            visual_run.end += absolute_start;
        }
        for visual_caret in &mut visual_carets {
            visual_caret.byte_offset += absolute_start;
        }
        lines.push(ShapedTextLine {
            start: absolute_start,
            end: (paragraph_start + end) as u32,
            direction,
            advance,
            visual_runs,
            visual_carets,
            glyphs: shaped.glyphs,
        });
        let line_index = (lines.len() - 1) as u32;
        carets.push(CaretStop {
            byte_offset: absolute_start,
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
    Ok(())
}

fn scale_font_metric(value: i32, scale: f64) -> i32 {
    (value as f64 * scale)
        .round()
        .clamp(i32::MIN as f64, i32::MAX as f64) as i32
}

/// Returns glyphs and physical carets in the first style run's font-unit
/// coordinate system. Style pieces inside an RTL visual run are visited in
/// reverse logical order so the flattened stream remains left-to-right.
fn shape_styled_visual_line(
    runs: &[PreparedTextShapingRun<'_>],
    text: &str,
    absolute_start: usize,
    units_per_em: i32,
) -> Result<
    (
        ShapedText,
        Vec<VisualTextRun>,
        i32,
        Vec<PositionedCaretStop>,
    ),
    TextShapingError,
> {
    let direction = paragraph_direction(text);
    let mut visual_runs = bidi_visual_runs(text);
    if visual_runs.is_empty() && !text.is_empty() {
        visual_runs.push(VisualTextRun {
            start: 0,
            end: text.len() as u32,
            direction,
        });
    }
    let mut glyphs = Vec::new();
    let mut visual_carets = Vec::new();
    let mut pen_x = 0_i32;
    for visual_run in &visual_runs {
        let visual_start = absolute_start + visual_run.start as usize;
        let visual_end = absolute_start + visual_run.end as usize;
        let mut pieces = runs
            .iter()
            .filter_map(|run| {
                let start = run.start.max(visual_start);
                let end = run.end.min(visual_end);
                (start < end).then_some((run, start, end))
            })
            .collect::<Vec<_>>();
        if visual_run.direction == TextDirection::RightToLeft {
            pieces.reverse();
        }
        for (run, piece_start, piece_end) in pieces {
            let relative_start = piece_start - absolute_start;
            let relative_end = piece_end - absolute_start;
            let piece_text = &text[relative_start..relative_end];
            let mut shaped = shape_text_with_face(&run.face, piece_text, visual_run.direction);
            let raw_carets = positioned_run_carets(
                &run.face,
                piece_text,
                visual_run.direction,
                &shaped.glyphs,
                0,
            );
            for glyph in &mut shaped.glyphs {
                glyph.run_index = run.index;
                glyph.x_advance = scale_font_metric(glyph.x_advance, run.scale);
                glyph.y_advance = scale_font_metric(glyph.y_advance, run.scale);
                glyph.x_offset = scale_font_metric(glyph.x_offset, run.scale);
                glyph.y_offset = scale_font_metric(glyph.y_offset, run.scale);
            }
            let base_piece_advance = shaped_advance(&shaped);
            let last_caret = raw_carets.len().saturating_sub(1);
            let tracked_advance = i64::from(base_piece_advance)
                .checked_add(i64::from(run.letter_spacing) * last_caret as i64)
                .filter(|advance| *advance > 0 && *advance <= i64::from(i32::MAX))
                .ok_or(TextShapingError::InvalidStyleRun)?;
            let piece_advance = tracked_advance as i32;
            apply_letter_spacing_to_glyph_advances(
                &mut shaped.glyphs,
                piece_text,
                run.letter_spacing,
                last_caret,
            )?;
            if shaped_advance(&shaped) != piece_advance {
                return Err(TextShapingError::InvalidStyleRun);
            }
            for glyph in &mut shaped.glyphs {
                glyph.cluster += relative_start as u32;
            }
            let mut previous_local_x = None;
            let mut piece_carets = Vec::with_capacity(raw_carets.len());
            for (index, caret) in raw_carets.into_iter().enumerate() {
                let base_x = if index == last_caret {
                    base_piece_advance
                } else {
                    scale_font_metric(caret.x_advance, run.scale).clamp(0, base_piece_advance)
                };
                let tracked_x = i64::from(base_x)
                    .checked_add(i64::from(run.letter_spacing) * index as i64)
                    .filter(|value| *value >= 0 && *value <= tracked_advance)
                    .ok_or(TextShapingError::InvalidStyleRun)?;
                let local_x = tracked_x as i32;
                if previous_local_x.is_some_and(|previous| previous > local_x) {
                    return Err(TextShapingError::InvalidStyleRun);
                }
                previous_local_x = Some(local_x);
                piece_carets.push(PositionedCaretStop {
                    byte_offset: caret.byte_offset + relative_start as u32,
                    x_advance: pen_x.saturating_add(local_x),
                });
            }
            for caret in piece_carets {
                // A metric style boundary owns one logical/physical caret.
                // Preserve duplicate byte offsets only when UAX #9 places
                // their affinities at different physical positions.
                if visual_carets
                    .last()
                    .is_some_and(|previous: &PositionedCaretStop| {
                        previous.byte_offset == caret.byte_offset
                            && previous.x_advance == caret.x_advance
                    })
                {
                    continue;
                }
                visual_carets.push(caret);
            }
            pen_x = pen_x.saturating_add(piece_advance);
            glyphs.extend(shaped.glyphs);
        }
    }
    Ok((
        ShapedText {
            direction,
            units_per_em,
            glyphs,
        },
        visual_runs,
        pen_x,
        visual_carets,
    ))
}

/** Assigns each grapheme's signed PIXELS tracking to the final glyph in its
 * HarfBuzz cluster. This keeps the glyph pen, line advance and physical caret
 * map in one coordinate system, including ligatures and RTL visual order. */
fn apply_letter_spacing_to_glyph_advances(
    glyphs: &mut [ShapedGlyph],
    text: &str,
    letter_spacing: i32,
    expected_graphemes: usize,
) -> Result<(), TextShapingError> {
    if letter_spacing == 0 {
        return Ok(());
    }
    if glyphs.is_empty() {
        return if expected_graphemes == 0 {
            Ok(())
        } else {
            Err(TextShapingError::InvalidStyleRun)
        };
    }
    let mut clusters = glyphs
        .iter()
        .map(|glyph| glyph.cluster as usize)
        .collect::<Vec<_>>();
    clusters.sort_unstable();
    clusters.dedup();
    if clusters.first().copied() != Some(0)
        || clusters
            .iter()
            .any(|cluster| *cluster >= text.len() || !text.is_char_boundary(*cluster))
    {
        return Err(TextShapingError::InvalidStyleRun);
    }
    let mut assigned = 0_usize;
    for (index, cluster) in clusters.iter().copied().enumerate() {
        let end = clusters.get(index + 1).copied().unwrap_or(text.len());
        if end <= cluster || !text.is_char_boundary(end) {
            return Err(TextShapingError::InvalidStyleRun);
        }
        let graphemes = text[cluster..end].graphemes(true).count();
        let glyph = glyphs
            .iter_mut()
            .rev()
            .find(|glyph| glyph.cluster as usize == cluster)
            .ok_or(TextShapingError::InvalidStyleRun)?;
        let tracking = i64::from(letter_spacing)
            .checked_mul(graphemes as i64)
            .ok_or(TextShapingError::InvalidStyleRun)?;
        glyph.x_advance = i64::from(glyph.x_advance)
            .checked_add(tracking)
            .filter(|advance| *advance >= i64::from(i32::MIN) && *advance <= i64::from(i32::MAX))
            .ok_or(TextShapingError::InvalidStyleRun)? as i32;
        assigned = assigned
            .checked_add(graphemes)
            .ok_or(TextShapingError::InvalidStyleRun)?;
    }
    if assigned != expected_graphemes {
        return Err(TextShapingError::InvalidStyleRun);
    }
    Ok(())
}

/// Shapes each resolved UAX #9 run in its own direction, then flattens glyphs
/// in display order. The source range remains byte-for-byte unchanged: Rustybuzz
/// clusters are only offset after this function returns.
fn shape_visual_line(
    face: &rustybuzz::Face<'_>,
    text: &str,
) -> (ShapedText, Vec<VisualTextRun>, Vec<PositionedCaretStop>) {
    let direction = paragraph_direction(text);
    let visual_runs = bidi_visual_runs(text);
    if visual_runs.is_empty() {
        let shaped = shape_text_with_face(face, text, direction);
        let visual_carets = positioned_run_carets(face, text, direction, &shaped.glyphs, 0);
        return (shaped, visual_runs, visual_carets);
    }
    let mut glyphs = Vec::new();
    let mut visual_carets = Vec::new();
    let mut pen_x = 0;
    for run in &visual_runs {
        let start = run.start as usize;
        let end = run.end as usize;
        let mut shaped = shape_text_with_face(face, &text[start..end], run.direction);
        visual_carets.extend(
            positioned_run_carets(
                face,
                &text[start..end],
                run.direction,
                &shaped.glyphs,
                pen_x,
            )
            .into_iter()
            .map(|mut caret| {
                caret.byte_offset += run.start;
                caret
            }),
        );
        pen_x = pen_x.saturating_add(shaped_advance(&shaped));
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
        visual_carets,
    )
}

/// Projects Rustybuzz cluster advances onto Unicode grapheme boundaries. Most
/// clusters map one-to-one to a grapheme. If shaping combines several legal
/// stops into one ligature cluster, valid OpenType GDEF ligature caret values
/// are preferred; unsupported or malformed tables fall back to deterministic
/// equal division. The cluster edges still match the shaped glyph pen positions
/// exactly.
fn positioned_run_carets(
    face: &rustybuzz::Face<'_>,
    text: &str,
    direction: TextDirection,
    glyphs: &[ShapedGlyph],
    origin_x: i32,
) -> Vec<PositionedCaretStop> {
    let grapheme_stops = std::iter::once(0_u32)
        .chain(
            text.grapheme_indices(true)
                .map(|(offset, grapheme)| (offset + grapheme.len()) as u32),
        )
        .collect::<Vec<_>>();
    if text.is_empty() || glyphs.is_empty() {
        return grapheme_stops
            .into_iter()
            .map(|byte_offset| PositionedCaretStop {
                byte_offset,
                x_advance: origin_x,
            })
            .collect();
    }

    let mut advances_by_cluster = BTreeMap::<u32, i32>::new();
    for glyph in glyphs {
        let advance = glyph.x_advance.saturating_abs();
        advances_by_cluster
            .entry(glyph.cluster)
            .and_modify(|total| *total = total.saturating_add(advance))
            .or_insert(advance);
    }
    let cluster_starts = advances_by_cluster.keys().copied().collect::<Vec<_>>();
    let mut physical_clusters = cluster_starts.clone();
    if direction == TextDirection::RightToLeft {
        physical_clusters.reverse();
    }
    let mut pen_x = origin_x;
    let mut result = Vec::new();
    for cluster_start in physical_clusters {
        let logical_index = cluster_starts
            .binary_search(&cluster_start)
            .expect("cluster originates in the same shaped run");
        let cluster_end = cluster_starts
            .get(logical_index + 1)
            .copied()
            .unwrap_or(text.len() as u32);
        let stops = grapheme_stops
            .iter()
            .copied()
            .filter(|stop| *stop >= cluster_start && *stop <= cluster_end)
            .collect::<Vec<_>>();
        let advance = advances_by_cluster[&cluster_start];
        let segments = stops.len().saturating_sub(1).max(1) as i64;
        let font_carets = (segments > 1)
            .then(|| {
                positioned_gdef_ligature_carets(
                    face,
                    glyphs.iter().filter(|glyph| glyph.cluster == cluster_start),
                    segments.saturating_sub(1) as usize,
                    advance,
                )
            })
            .flatten();
        for (index, byte_offset) in stops.into_iter().enumerate() {
            let logical_step = match index {
                0 => 0,
                index if index as i64 == segments => advance,
                index => font_carets
                    .as_ref()
                    .and_then(|carets| gdef_logical_caret_step(direction, carets, index, advance))
                    .unwrap_or_else(|| (i64::from(advance) * index as i64 / segments) as i32),
            };
            let x_advance = match direction {
                TextDirection::LeftToRight => pen_x.saturating_add(logical_step),
                TextDirection::RightToLeft => {
                    pen_x.saturating_add(advance).saturating_sub(logical_step)
                }
            };
            result.push(PositionedCaretStop {
                byte_offset,
                x_advance,
            });
        }
        pen_x = pen_x.saturating_add(advance);
    }
    result.sort_by_key(|caret| caret.x_advance);
    result.dedup();
    result
}

fn gdef_logical_caret_step(
    direction: TextDirection,
    physical_carets: &[i32],
    logical_index: usize,
    advance: i32,
) -> Option<i32> {
    match direction {
        TextDirection::LeftToRight => physical_carets.get(logical_index.checked_sub(1)?).copied(),
        TextDirection::RightToLeft => physical_carets
            .get(physical_carets.len().checked_sub(logical_index)?)
            .map(|physical| advance.saturating_sub(*physical)),
    }
}

/// Reads GDEF ligature caret values from the explicit face. `ttf-parser` 0.25
/// validates GDEF but intentionally does not expose LigCaretList, so this
/// narrow parser keeps all offsets checked and only accepts values that can be
/// resolved deterministically in the unhinted font-unit layout used here.
fn positioned_gdef_ligature_carets<'a>(
    face: &rustybuzz::Face<'_>,
    glyphs: impl Iterator<Item = &'a ShapedGlyph>,
    expected_count: usize,
    cluster_advance: i32,
) -> Option<Vec<i32>> {
    if expected_count == 0 || expected_count > 64 || cluster_advance <= 0 {
        return None;
    }
    let gdef = face
        .raw_face()
        .table(ttf_parser::Tag::from_bytes(b"GDEF"))?;
    let parsed_gdef = face.tables().gdef;
    let variation_coordinates = face.variation_coordinates();
    let mut pen_x = 0_i32;
    for glyph in glyphs {
        let mut contour_points_attempted = false;
        let mut contour_points = None;
        if let Some(mut carets) = gdef_ligature_carets(
            gdef,
            glyph.glyph_id,
            expected_count,
            |outer_index, inner_index| {
                parsed_gdef?
                    .glyph_variation_delta(outer_index, inner_index, variation_coordinates)
                    .and_then(rounded_gdef_variation_delta)
            },
            |glyph_id, point_index| {
                if !contour_points_attempted {
                    contour_points_attempted = true;
                    contour_points = font_contour_xs(face, glyph_id);
                }
                contour_points
                    .as_ref()?
                    .get(usize::from(point_index))
                    .copied()
            },
        ) {
            for caret in &mut carets {
                *caret = pen_x.saturating_add(glyph.x_offset).saturating_add(*caret);
            }
            if carets
                .iter()
                .copied()
                .all(|caret| caret > 0 && caret < cluster_advance)
                && carets.windows(2).all(|pair| pair[0] < pair[1])
            {
                return Some(carets);
            }
        }
        pen_x = pen_x.saturating_add(glyph.x_advance.saturating_abs());
    }
    None
}

fn gdef_ligature_carets(
    data: &[u8],
    glyph_id: u32,
    expected_count: usize,
    mut variation_delta: impl FnMut(u16, u16) -> Option<i32>,
    mut contour_x: impl FnMut(u16, u16) -> Option<i32>,
) -> Option<Vec<i32>> {
    let glyph_id = u16::try_from(glyph_id).ok()?;
    if expected_count == 0 || expected_count > 64 || read_u32(data, 0)? >> 16 != 1 {
        return None;
    }
    let ligature_list = usize::from(read_u16(data, 8)?);
    if ligature_list == 0 {
        return None;
    }
    let coverage = ligature_list.checked_add(usize::from(read_u16(data, ligature_list)?))?;
    let coverage_index = coverage_index(data, coverage, glyph_id)?;
    let glyph_count = usize::from(read_u16(data, ligature_list.checked_add(2)?)?);
    if coverage_index >= glyph_count {
        return None;
    }
    let glyph_offset_position = ligature_list
        .checked_add(4)?
        .checked_add(coverage_index.checked_mul(2)?)?;
    let ligature_glyph =
        ligature_list.checked_add(usize::from(read_u16(data, glyph_offset_position)?))?;
    let caret_count = usize::from(read_u16(data, ligature_glyph)?);
    if caret_count != expected_count {
        return None;
    }
    let offsets_start = ligature_glyph.checked_add(2)?;
    let offsets_end = offsets_start.checked_add(caret_count.checked_mul(2)?)?;
    data.get(offsets_start..offsets_end)?;
    let mut carets = Vec::with_capacity(caret_count);
    for index in 0..caret_count {
        let offset_position = offsets_start.checked_add(index.checked_mul(2)?)?;
        let caret_value =
            ligature_glyph.checked_add(usize::from(read_u16(data, offset_position)?))?;
        let format = read_u16(data, caret_value)?;
        match format {
            1 => carets.push(i32::from(read_i16(data, caret_value.checked_add(2)?)?)),
            2 => carets.push(contour_x(
                glyph_id,
                read_u16(data, caret_value.checked_add(2)?)?,
            )?),
            3 => {
                let mut coordinate = i32::from(read_i16(data, caret_value.checked_add(2)?)?);
                let device_offset = usize::from(read_u16(data, caret_value.checked_add(4)?)?);
                if device_offset != 0 {
                    let device = caret_value.checked_add(device_offset)?;
                    if let GdefDeviceAdjustment::VariationIndex {
                        outer_index,
                        inner_index,
                    } = validate_unhinted_device_table(data, device)?
                    {
                        coordinate =
                            coordinate.checked_add(variation_delta(outer_index, inner_index)?)?;
                    }
                }
                carets.push(coordinate);
            }
            _ => return None,
        }
    }
    carets
        .windows(2)
        .all(|pair| pair[0] < pair[1])
        .then_some(carets)
}

/// Resolves an unhinted CaretValue format-2 coordinate for a font outline.
/// Simple and bounded composite glyf point numbers plus CFF/CFF2 path points
/// are supported. Active gvar instances support simple glyphs and bounded
/// composites with XY offsets or point matching. The manually assembled default
/// instance must exactly match the independent static glyf parser; malformed or
/// incompatible outlines retain the deterministic cluster fallback.
#[cfg(test)]
fn font_contour_x(face: &rustybuzz::Face<'_>, glyph_id: u16, point_index: u16) -> Option<i32> {
    font_contour_xs(face, glyph_id)?
        .get(usize::from(point_index))
        .copied()
}

fn font_contour_xs(face: &rustybuzz::Face<'_>, glyph_id: u16) -> Option<Vec<i32>> {
    if face.tables().glyf.is_some() {
        if face.has_non_default_variation_coordinates() {
            varied_glyf_contour_xs(face, glyph_id)
        } else {
            glyf_contour_xs(face, glyph_id)
        }
    } else {
        cff_contour_xs(face, glyph_id)
    }
}

fn glyf_contour_xs(face: &rustybuzz::Face<'_>, glyph_id: u16) -> Option<Vec<i32>> {
    if face.has_non_default_variation_coordinates() {
        return None;
    }
    let raw = face.raw_face();
    glyf_contour_xs_from_tables(
        raw.table(ttf_parser::Tag::from_bytes(b"head"))?,
        raw.table(ttf_parser::Tag::from_bytes(b"loca"))?,
        raw.table(ttf_parser::Tag::from_bytes(b"glyf"))?,
        face.number_of_glyphs(),
        glyph_id,
    )
}

#[cfg(test)]
fn glyf_contour_x_from_tables(
    head: &[u8],
    loca: &[u8],
    glyf: &[u8],
    glyph_count: u16,
    glyph_id: u16,
    point_index: u16,
) -> Option<i32> {
    glyf_contour_xs_from_tables(head, loca, glyf, glyph_count, glyph_id)?
        .get(usize::from(point_index))
        .copied()
}

const MAX_COMPOSITE_GLYF_DEPTH: usize = 32;
const MAX_COMPOSITE_GLYF_COMPONENTS: usize = 32;
const MAX_GLYF_CONTOUR_POINTS: usize = u16::MAX as usize + 1;
const GLYF_ARG_1_AND_2_ARE_WORDS: u16 = 0x0001;
const GLYF_ARGS_ARE_XY_VALUES: u16 = 0x0002;
const GLYF_ROUND_XY_TO_GRID: u16 = 0x0004;
const GLYF_WE_HAVE_A_SCALE: u16 = 0x0008;
const GLYF_MORE_COMPONENTS: u16 = 0x0020;
const GLYF_WE_HAVE_AN_X_AND_Y_SCALE: u16 = 0x0040;
const GLYF_WE_HAVE_A_TWO_BY_TWO: u16 = 0x0080;
const GLYF_WE_HAVE_INSTRUCTIONS: u16 = 0x0100;
const GLYF_SCALED_COMPONENT_OFFSET: u16 = 0x0800;
const GLYF_UNSCALED_COMPONENT_OFFSET: u16 = 0x1000;
const GLYF_RESERVED_FLAGS: u16 = 0xe010;

#[derive(Clone, Copy)]
struct CompositeGlyfComponent {
    flags: u16,
    glyph_id: u16,
    argument_one: i32,
    argument_two: i32,
    matrix: [i32; 4],
}

impl CompositeGlyfComponent {
    fn uses_xy_arguments(self) -> bool {
        self.flags & GLYF_ARGS_ARE_XY_VALUES != 0
    }
}

#[derive(Default)]
struct CffContourXs {
    xs: Vec<i32>,
    valid: bool,
}

impl CffContourXs {
    fn new() -> Self {
        Self {
            xs: Vec::new(),
            valid: true,
        }
    }

    fn push(&mut self, x: f32) {
        if !self.valid || self.xs.len() >= MAX_GLYF_CONTOUR_POINTS || !x.is_finite() {
            self.valid = false;
            return;
        }
        let rounded = x.round();
        if rounded < i32::MIN as f32 || rounded > i32::MAX as f32 {
            self.valid = false;
            return;
        }
        self.xs.push(rounded as i32);
    }
}

impl ttf_parser::OutlineBuilder for CffContourXs {
    fn move_to(&mut self, x: f32, _y: f32) {
        self.push(x);
    }

    fn line_to(&mut self, x: f32, _y: f32) {
        self.push(x);
    }

    fn quad_to(&mut self, _x1: f32, _y1: f32, _x: f32, _y: f32) {
        // CFF/CFF2 outlines contain cubic curves. A quadratic callback means
        // this face is not the CFF-only topology admitted by this collector.
        self.valid = false;
    }

    fn curve_to(&mut self, x1: f32, _y1: f32, x2: f32, _y2: f32, x: f32, _y: f32) {
        self.push(x1);
        self.push(x2);
        self.push(x);
    }

    fn close(&mut self) {}
}

fn cff_contour_xs(face: &rustybuzz::Face<'_>, glyph_id: u16) -> Option<Vec<i32>> {
    let tables = face.tables();
    if tables.glyf.is_some() || (tables.cff.is_none() && tables.cff2.is_none()) {
        return None;
    }
    let mut contour = CffContourXs::new();
    face.outline_glyph(ttf_parser::GlyphId(glyph_id), &mut contour)?;
    (contour.valid && !contour.xs.is_empty()).then_some(contour.xs)
}

#[derive(Clone, Copy)]
enum GlyfOutlineEvent {
    Move(Option<usize>),
    Line(Option<usize>),
    Quad(Option<usize>, Option<usize>),
    Close,
}

fn simple_glyf_outline_events(contours: &[Vec<bool>]) -> Option<(Vec<GlyfOutlineEvent>, usize)> {
    let point_count = contours.iter().map(Vec::len).sum::<usize>();
    if point_count == 0 || point_count > MAX_GLYF_CONTOUR_POINTS {
        return None;
    }
    let mut events = Vec::new();
    let mut start = 0_usize;
    for contour in contours {
        if contour.is_empty() {
            return None;
        }
        let mut first_on_curve = None;
        let mut has_first_on_curve = false;
        let mut first_off_curve = None;
        let mut last_off_curve = None;
        for (local_index, on_curve) in contour.iter().copied().enumerate() {
            let index = start.checked_add(local_index)?;
            if !has_first_on_curve {
                if on_curve {
                    first_on_curve = Some(index);
                    has_first_on_curve = true;
                    events.push(GlyfOutlineEvent::Move(Some(index)));
                } else if first_off_curve.is_some() {
                    has_first_on_curve = true;
                    last_off_curve = Some(index);
                    events.push(GlyfOutlineEvent::Move(None));
                } else {
                    first_off_curve = Some(index);
                }
            } else {
                match (last_off_curve, on_curve) {
                    (Some(off_curve), true) => {
                        last_off_curve = None;
                        events.push(GlyfOutlineEvent::Quad(Some(off_curve), Some(index)));
                    }
                    (Some(off_curve), false) => {
                        last_off_curve = Some(index);
                        events.push(GlyfOutlineEvent::Quad(Some(off_curve), None));
                    }
                    (None, true) => events.push(GlyfOutlineEvent::Line(Some(index))),
                    (None, false) => last_off_curve = Some(index),
                }
            }
        }

        if let (Some(first_off), Some(last_off)) = (first_off_curve, last_off_curve) {
            events.push(GlyfOutlineEvent::Quad(Some(last_off), None));
            events.push(GlyfOutlineEvent::Quad(Some(first_off), first_on_curve));
        } else if let Some(first_off) = first_off_curve {
            events.push(GlyfOutlineEvent::Quad(Some(first_off), first_on_curve));
        } else if let Some(last_off) = last_off_curve {
            events.push(GlyfOutlineEvent::Quad(Some(last_off), first_on_curve));
        } else if has_first_on_curve {
            events.push(GlyfOutlineEvent::Line(first_on_curve));
        }
        events.push(GlyfOutlineEvent::Close);
        start = start.checked_add(contour.len())?;
    }
    Some((events, point_count))
}

#[derive(Clone, Copy, PartialEq)]
struct VariedGlyfPoint {
    x: f32,
    y: f32,
}

struct VariedGlyfContourPoints {
    events: Vec<GlyfOutlineEvent>,
    event_index: usize,
    points: Vec<Option<VariedGlyfPoint>>,
    valid: bool,
}

impl VariedGlyfContourPoints {
    fn new(contours: &[Vec<bool>]) -> Option<Self> {
        let (events, point_count) = simple_glyf_outline_events(contours)?;
        Some(Self {
            events,
            event_index: 0,
            points: vec![None; point_count],
            valid: true,
        })
    }

    fn next_event(&mut self) -> Option<GlyfOutlineEvent> {
        let event = self.events.get(self.event_index).copied();
        self.event_index = self.event_index.saturating_add(1);
        event
    }

    fn assign(&mut self, point_index: Option<usize>, x: f32, y: f32) {
        let Some(point_index) = point_index else {
            return;
        };
        if !valid_varied_glyf_coordinate(x) || !valid_varied_glyf_coordinate(y) {
            self.valid = false;
            return;
        }
        let point = VariedGlyfPoint { x, y };
        let Some(slot) = self.points.get_mut(point_index) else {
            self.valid = false;
            return;
        };
        if slot.is_some_and(|existing| existing != point) {
            self.valid = false;
        } else {
            *slot = Some(point);
        }
    }

    fn finish(self) -> Option<Vec<VariedGlyfPoint>> {
        if !self.valid || self.event_index != self.events.len() {
            return None;
        }
        self.points.into_iter().collect()
    }
}

impl ttf_parser::OutlineBuilder for VariedGlyfContourPoints {
    fn move_to(&mut self, x: f32, y: f32) {
        match self.next_event() {
            Some(GlyfOutlineEvent::Move(point)) => self.assign(point, x, y),
            _ => self.valid = false,
        }
    }

    fn line_to(&mut self, x: f32, y: f32) {
        match self.next_event() {
            Some(GlyfOutlineEvent::Line(point)) => self.assign(point, x, y),
            _ => self.valid = false,
        }
    }

    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        match self.next_event() {
            Some(GlyfOutlineEvent::Quad(control, end)) => {
                self.assign(control, x1, y1);
                self.assign(end, x, y);
            }
            _ => self.valid = false,
        }
    }

    fn curve_to(&mut self, _x1: f32, _y1: f32, _x2: f32, _y2: f32, _x: f32, _y: f32) {
        self.valid = false;
    }

    fn close(&mut self) {
        if !matches!(self.next_event(), Some(GlyfOutlineEvent::Close)) {
            self.valid = false;
        }
    }
}

fn valid_varied_glyf_coordinate(value: f32) -> bool {
    value.is_finite() && value.round() >= i32::MIN as f32 && value.round() <= i32::MAX as f32
}

fn round_varied_glyf_point(point: VariedGlyfPoint) -> Option<GlyfPoint> {
    if !valid_varied_glyf_coordinate(point.x) || !valid_varied_glyf_coordinate(point.y) {
        return None;
    }
    Some(GlyfPoint {
        x: point.x.round() as i32,
        y: point.y.round() as i32,
    })
}

fn outline_simple_glyf_contour_points(
    face: &rustybuzz::Face<'_>,
    glyph_id: u16,
    contours: &[Vec<bool>],
) -> Option<Vec<VariedGlyfPoint>> {
    let mut collector = VariedGlyfContourPoints::new(contours)?;
    face.outline_glyph(ttf_parser::GlyphId(glyph_id), &mut collector)?;
    collector.finish()
}

fn transform_varied_glyf_point(
    point: VariedGlyfPoint,
    matrix: [i32; 4],
) -> Option<VariedGlyfPoint> {
    let scale = 1.0 / 16_384.0;
    let transformed = VariedGlyfPoint {
        x: (matrix[0] as f32 * point.x + matrix[2] as f32 * point.y) * scale,
        y: (matrix[1] as f32 * point.x + matrix[3] as f32 * point.y) * scale,
    };
    (valid_varied_glyf_coordinate(transformed.x) && valid_varied_glyf_coordinate(transformed.y))
        .then_some(transformed)
}

const MAX_GVAR_TUPLES: usize = 4_095;
const MAX_GVAR_POINT_REFERENCES: usize = u16::MAX as usize;

fn parse_gvar_packed_points(
    data: &[u8],
    cursor: &mut usize,
    end: usize,
) -> Option<Option<Vec<u16>>> {
    let first = *data.get(*cursor..end)?.first()?;
    *cursor = cursor.checked_add(1)?;
    let count = if first & 0x80 != 0 {
        let second = *data.get(*cursor..end)?.first()?;
        *cursor = cursor.checked_add(1)?;
        (usize::from(first & 0x7f) << 8) | usize::from(second)
    } else {
        usize::from(first)
    };
    if count == 0 {
        return Some(None);
    }
    if count > MAX_GVAR_POINT_REFERENCES {
        return None;
    }
    let mut points = Vec::with_capacity(count);
    let mut point = 0_u16;
    while points.len() < count {
        if *cursor >= end {
            return None;
        }
        let control = *data.get(*cursor..end)?.first()?;
        *cursor = cursor.checked_add(1)?;
        let run_count = usize::from(control & 0x7f).checked_add(1)?;
        if points.len().checked_add(run_count)? > count {
            return None;
        }
        for _ in 0..run_count {
            let delta = if control & 0x80 != 0 {
                let delta = read_u16(data.get(..end)?, *cursor)?;
                *cursor = cursor.checked_add(2)?;
                delta
            } else {
                let delta = u16::from(*data.get(*cursor..end)?.first()?);
                *cursor = cursor.checked_add(1)?;
                delta
            };
            if *cursor > end {
                return None;
            }
            point = point.checked_add(delta)?;
            points.push(point);
        }
    }
    Some(Some(points))
}

fn parse_gvar_packed_deltas(
    data: &[u8],
    cursor: &mut usize,
    end: usize,
    count: usize,
) -> Option<Vec<i16>> {
    let mut deltas = Vec::with_capacity(count);
    while deltas.len() < count {
        if *cursor >= end {
            return None;
        }
        let control = *data.get(*cursor..end)?.first()?;
        *cursor = cursor.checked_add(1)?;
        let run_count = usize::from(control & 0x3f).checked_add(1)?;
        if deltas.len().checked_add(run_count)? > count {
            return None;
        }
        if control & 0x80 != 0 {
            deltas.extend(std::iter::repeat_n(0_i16, run_count));
            continue;
        }
        for _ in 0..run_count {
            let delta = if control & 0x40 != 0 {
                let delta = read_i16(data.get(..end)?, *cursor)?;
                *cursor = cursor.checked_add(2)?;
                delta
            } else {
                let delta = i16::from(*data.get(*cursor..end)?.first()? as i8);
                *cursor = cursor.checked_add(1)?;
                delta
            };
            if *cursor > end {
                return None;
            }
            deltas.push(delta);
        }
    }
    Some(deltas)
}

fn gvar_tuple_scalar(
    coordinates: &[ttf_parser::NormalizedCoordinate],
    peak: &[i16],
    intermediate: Option<(&[i16], &[i16])>,
) -> Option<f32> {
    if peak.len() != coordinates.len()
        || intermediate.is_some_and(|(start, end)| {
            start.len() != coordinates.len() || end.len() != coordinates.len()
        })
    {
        return None;
    }
    let mut scalar = 1.0_f32;
    for (axis, coordinate) in coordinates.iter().copied().enumerate() {
        let value = coordinate.get();
        let peak_value = peak[axis];
        if peak_value == 0 || value == peak_value {
            continue;
        }
        if let Some((start, end)) = intermediate {
            let start_value = start[axis];
            let end_value = end[axis];
            if start_value > peak_value
                || peak_value > end_value
                || (start_value < 0 && end_value > 0 && peak_value != 0)
            {
                continue;
            }
            if value < start_value || value > end_value {
                return Some(0.0);
            }
            if value < peak_value {
                if peak_value != start_value {
                    scalar *= f32::from(value - start_value) / f32::from(peak_value - start_value);
                }
            } else if peak_value != end_value {
                scalar *= f32::from(end_value - value) / f32::from(end_value - peak_value);
            }
        } else if value == 0 || value < 0_i16.min(peak_value) || value > 0_i16.max(peak_value) {
            return Some(0.0);
        } else {
            scalar *= f32::from(value) / f32::from(peak_value);
        }
    }
    scalar.is_finite().then_some(scalar)
}

fn read_gvar_tuple(data: &[u8], cursor: &mut usize, axis_count: usize) -> Option<Vec<i16>> {
    let byte_count = axis_count.checked_mul(2)?;
    let end = cursor.checked_add(byte_count)?;
    data.get(*cursor..end)?;
    let tuple = (0..axis_count)
        .map(|axis| read_i16(data, *cursor + axis * 2))
        .collect::<Option<Vec<_>>>()?;
    *cursor = end;
    Some(tuple)
}

fn gvar_component_deltas(
    face: &rustybuzz::Face<'_>,
    glyph_id: u16,
    component_count: usize,
) -> Option<Vec<VariedGlyfPoint>> {
    let mut result = vec![VariedGlyfPoint { x: 0.0, y: 0.0 }; component_count];
    let raw = face.raw_face();
    let Some(gvar) = raw.table(ttf_parser::Tag::from_bytes(b"gvar")) else {
        return Some(result);
    };
    if read_u32(gvar, 0)? != 0x0001_0000 {
        return None;
    }
    let axis_count = usize::from(read_u16(gvar, 4)?);
    let shared_tuple_count = usize::from(read_u16(gvar, 6)?);
    let shared_tuples_offset = usize::try_from(read_u32(gvar, 8)?).ok()?;
    let gvar_glyph_count = read_u16(gvar, 12)?;
    let flags = read_u16(gvar, 14)?;
    let variation_data_offset = usize::try_from(read_u32(gvar, 16)?).ok()?;
    let coordinates = face.variation_coordinates();
    if axis_count == 0
        || axis_count != coordinates.len()
        || gvar_glyph_count != face.number_of_glyphs()
        || glyph_id >= gvar_glyph_count
        || flags & !1 != 0
    {
        return None;
    }
    let shared_byte_count = shared_tuple_count.checked_mul(axis_count)?.checked_mul(2)?;
    gvar.get(shared_tuples_offset..shared_tuples_offset.checked_add(shared_byte_count)?)?;

    let offsets_start = 20_usize;
    let offset_entry_size = if flags & 1 != 0 { 4 } else { 2 };
    let read_offset = |index: usize| -> Option<usize> {
        let offset = offsets_start.checked_add(index.checked_mul(offset_entry_size)?)?;
        if offset_entry_size == 4 {
            usize::try_from(read_u32(gvar, offset)?).ok()
        } else {
            Some(usize::from(read_u16(gvar, offset)?).checked_mul(2)?)
        }
    };
    let start = read_offset(usize::from(glyph_id))?;
    let end = read_offset(usize::from(glyph_id).checked_add(1)?)?;
    if start > end {
        return None;
    }
    let glyph_data_start = variation_data_offset.checked_add(start)?;
    let glyph_data_end = variation_data_offset.checked_add(end)?;
    let glyph_data = gvar.get(glyph_data_start..glyph_data_end)?;
    if glyph_data.is_empty() {
        return Some(result);
    }

    let tuple_count_raw = read_u16(glyph_data, 0)?;
    let tuple_count = usize::from(tuple_count_raw & 0x0fff);
    if tuple_count == 0 || tuple_count > MAX_GVAR_TUPLES {
        return None;
    }
    let serialized_offset = usize::from(read_u16(glyph_data, 2)?);
    if serialized_offset > glyph_data.len() {
        return None;
    }
    let mut header_cursor = 4_usize;
    let mut serialized_cursor = serialized_offset;
    let shared_points = if tuple_count_raw & 0x8000 != 0 {
        parse_gvar_packed_points(glyph_data, &mut serialized_cursor, glyph_data.len())?
    } else {
        None
    };
    let points_len = component_count.checked_add(4)?;
    for _ in 0..tuple_count {
        let serialized_len = usize::from(read_u16(glyph_data, header_cursor)?);
        let tuple_index = read_u16(glyph_data, header_cursor.checked_add(2)?)?;
        header_cursor = header_cursor.checked_add(4)?;
        let peak = if tuple_index & 0x8000 != 0 {
            read_gvar_tuple(glyph_data, &mut header_cursor, axis_count)?
        } else {
            let shared_index = usize::from(tuple_index & 0x0fff);
            if shared_index >= shared_tuple_count {
                return None;
            }
            let mut cursor = shared_tuples_offset
                .checked_add(shared_index.checked_mul(axis_count)?.checked_mul(2)?)?;
            read_gvar_tuple(gvar, &mut cursor, axis_count)?
        };
        let intermediate = if tuple_index & 0x4000 != 0 {
            let start_tuple = read_gvar_tuple(glyph_data, &mut header_cursor, axis_count)?;
            let end_tuple = read_gvar_tuple(glyph_data, &mut header_cursor, axis_count)?;
            Some((start_tuple, end_tuple))
        } else {
            None
        };
        if header_cursor > serialized_offset {
            return None;
        }
        let scalar = gvar_tuple_scalar(
            coordinates,
            &peak,
            intermediate
                .as_ref()
                .map(|(start, end)| (start.as_slice(), end.as_slice())),
        )?;
        let block_start = serialized_cursor;
        let block_end = block_start.checked_add(serialized_len)?;
        if block_end > glyph_data.len() {
            return None;
        }
        if scalar > 0.0 {
            let mut block_cursor = block_start;
            let points = if tuple_index & 0x2000 != 0 {
                parse_gvar_packed_points(glyph_data, &mut block_cursor, block_end)?
            } else {
                shared_points.clone()
            };
            let delta_count = points.as_ref().map_or(points_len, Vec::len);
            let x_deltas =
                parse_gvar_packed_deltas(glyph_data, &mut block_cursor, block_end, delta_count)?;
            let y_deltas =
                parse_gvar_packed_deltas(glyph_data, &mut block_cursor, block_end, delta_count)?;
            if block_cursor != block_end {
                return None;
            }
            for delta_index in 0..delta_count {
                let point_index = points
                    .as_ref()
                    .map_or(delta_index, |points| usize::from(points[delta_index]));
                if point_index >= points_len {
                    return None;
                }
                if let Some(component) = result.get_mut(point_index) {
                    component.x += f32::from(x_deltas[delta_index]) * scalar;
                    component.y += f32::from(y_deltas[delta_index]) * scalar;
                    if !valid_varied_glyf_coordinate(component.x)
                        || !valid_varied_glyf_coordinate(component.y)
                    {
                        return None;
                    }
                }
            }
        }
        serialized_cursor = block_end;
    }
    Some(result)
}

fn varied_glyf_contour_points_inner(
    face: &rustybuzz::Face<'_>,
    tables: &GlyfTables<'_>,
    glyph_id: u16,
    stack: &mut Vec<u16>,
    remaining_points: &mut usize,
) -> Option<Vec<VariedGlyfPoint>> {
    if stack.len() >= MAX_COMPOSITE_GLYF_DEPTH || stack.contains(&glyph_id) {
        return None;
    }
    stack.push(glyph_id);
    let result = (|| {
        let glyph = tables.glyph_data(glyph_id)?;
        let contour_count = read_i16(glyph, 0)?;
        if contour_count > 0 {
            let contours = simple_glyf_topology(glyph)?;
            let point_count = contours.iter().map(Vec::len).sum::<usize>();
            *remaining_points = remaining_points.checked_sub(point_count)?;
            return outline_simple_glyf_contour_points(face, glyph_id, &contours);
        }
        if contour_count == 0 {
            return None;
        }

        let components = parse_composite_glyf_components(glyph)?;
        let component_deltas = gvar_component_deltas(face, glyph_id, components.len())?;
        let mut points: Vec<VariedGlyfPoint> = Vec::new();
        for (component_index, component) in components.into_iter().enumerate() {
            let child = varied_glyf_contour_points_inner(
                face,
                tables,
                component.glyph_id,
                stack,
                remaining_points,
            )?;
            let mut transformed = child
                .into_iter()
                .map(|point| transform_varied_glyf_point(point, component.matrix))
                .collect::<Option<Vec<_>>>()?;
            let (mut offset_x, mut offset_y) = if component.uses_xy_arguments() {
                let delta = component_deltas.get(component_index).copied()?;
                let offset = VariedGlyfPoint {
                    x: component.argument_one as f32 + delta.x,
                    y: component.argument_two as f32 + delta.y,
                };
                if component.flags & GLYF_SCALED_COMPONENT_OFFSET != 0 {
                    if component.flags & GLYF_UNSCALED_COMPONENT_OFFSET != 0 {
                        return None;
                    }
                    let offset = transform_varied_glyf_point(offset, component.matrix)?;
                    (offset.x, offset.y)
                } else {
                    (offset.x, offset.y)
                }
            } else {
                if component.flags
                    & (GLYF_ROUND_XY_TO_GRID
                        | GLYF_SCALED_COMPONENT_OFFSET
                        | GLYF_UNSCALED_COMPONENT_OFFSET)
                    != 0
                {
                    return None;
                }
                let parent_point = *points.get(usize::try_from(component.argument_one).ok()?)?;
                let component_point =
                    *transformed.get(usize::try_from(component.argument_two).ok()?)?;
                (
                    parent_point.x - component_point.x,
                    parent_point.y - component_point.y,
                )
            };
            if component.flags & GLYF_ROUND_XY_TO_GRID != 0 {
                offset_x = offset_x.round();
                offset_y = offset_y.round();
            }
            if !valid_varied_glyf_coordinate(offset_x) || !valid_varied_glyf_coordinate(offset_y) {
                return None;
            }
            for point in &mut transformed {
                point.x += offset_x;
                point.y += offset_y;
                if !valid_varied_glyf_coordinate(point.x) || !valid_varied_glyf_coordinate(point.y)
                {
                    return None;
                }
            }
            if points.len().checked_add(transformed.len())? > MAX_GLYF_CONTOUR_POINTS {
                return None;
            }
            points.extend(transformed);
        }
        (!points.is_empty()).then_some(points)
    })();
    stack.pop();
    result
}

fn varied_glyf_contour_points(
    face: &rustybuzz::Face<'_>,
    tables: &GlyfTables<'_>,
    glyph_id: u16,
) -> Option<Vec<VariedGlyfPoint>> {
    let mut stack = Vec::new();
    let mut remaining_points = MAX_GLYF_CONTOUR_POINTS;
    varied_glyf_contour_points_inner(face, tables, glyph_id, &mut stack, &mut remaining_points)
}

fn varied_glyf_contour_xs(face: &rustybuzz::Face<'_>, glyph_id: u16) -> Option<Vec<i32>> {
    let raw = face.raw_face();
    let tables = GlyfTables {
        loca: raw.table(ttf_parser::Tag::from_bytes(b"loca"))?,
        glyf: raw.table(ttf_parser::Tag::from_bytes(b"glyf"))?,
        glyph_count: face.number_of_glyphs(),
        index_to_loc_format: read_i16(raw.table(ttf_parser::Tag::from_bytes(b"head"))?, 50)?,
    };

    // Prove the manually assembled default instance agrees with the independent
    // static parser before using component gvar deltas or point matching.
    let mut default_face = face.clone();
    let default_axes = default_face
        .variation_axes()
        .into_iter()
        .map(|axis| (axis.tag, axis.def_value))
        .collect::<Vec<_>>();
    for (tag, value) in default_axes {
        default_face.set_variation(tag, value)?;
    }
    let assembled_default = varied_glyf_contour_points(&default_face, &tables, glyph_id)?
        .into_iter()
        .map(round_varied_glyf_point)
        .collect::<Option<Vec<_>>>()?;
    let mut static_stack = Vec::new();
    let mut static_remaining = MAX_GLYF_CONTOUR_POINTS;
    let static_points =
        glyf_contour_points(&tables, glyph_id, &mut static_stack, &mut static_remaining)?;
    if assembled_default != static_points {
        return None;
    }
    varied_glyf_contour_points(face, &tables, glyph_id)?
        .into_iter()
        .map(|point| round_varied_glyf_point(point).map(|point| point.x))
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct GlyfPoint {
    x: i32,
    y: i32,
}

struct GlyfTables<'a> {
    loca: &'a [u8],
    glyf: &'a [u8],
    glyph_count: u16,
    index_to_loc_format: i16,
}

impl GlyfTables<'_> {
    fn glyph_data(&self, glyph_id: u16) -> Option<&[u8]> {
        if glyph_id >= self.glyph_count {
            return None;
        }
        let glyph_offset = |index: usize| match self.index_to_loc_format {
            0 => read_u16(self.loca, index.checked_mul(2)?).map(|value| usize::from(value) * 2),
            1 => read_u32(self.loca, index.checked_mul(4)?)
                .and_then(|value| usize::try_from(value).ok()),
            _ => None,
        };
        let start = glyph_offset(usize::from(glyph_id))?;
        let end = glyph_offset(usize::from(glyph_id).checked_add(1)?)?;
        (start < end && end <= self.glyf.len()).then(|| &self.glyf[start..end])
    }
}

fn glyf_contour_xs_from_tables(
    head: &[u8],
    loca: &[u8],
    glyf: &[u8],
    glyph_count: u16,
    glyph_id: u16,
) -> Option<Vec<i32>> {
    let tables = GlyfTables {
        loca,
        glyf,
        glyph_count,
        index_to_loc_format: read_i16(head, 50)?,
    };
    let mut stack = Vec::new();
    let mut remaining_points = MAX_GLYF_CONTOUR_POINTS;
    glyf_contour_points(&tables, glyph_id, &mut stack, &mut remaining_points)
        .map(|points| points.into_iter().map(|point| point.x).collect())
}

fn glyf_contour_points(
    tables: &GlyfTables<'_>,
    glyph_id: u16,
    stack: &mut Vec<u16>,
    remaining_points: &mut usize,
) -> Option<Vec<GlyfPoint>> {
    if stack.len() >= MAX_COMPOSITE_GLYF_DEPTH || stack.contains(&glyph_id) {
        return None;
    }
    stack.push(glyph_id);
    let result = (|| {
        let glyph = tables.glyph_data(glyph_id)?;
        let contour_count = read_i16(glyph, 0)?;
        if contour_count > 0 {
            return parse_simple_glyf_points(
                glyph,
                usize::try_from(contour_count).ok()?,
                remaining_points,
            );
        }
        if contour_count == 0 {
            return None;
        }
        parse_composite_glyf_points(tables, glyph, stack, remaining_points)
    })();
    stack.pop();
    result
}

fn simple_glyf_topology(glyph: &[u8]) -> Option<Vec<Vec<bool>>> {
    let contour_count = usize::try_from(read_i16(glyph, 0)?).ok()?;
    if contour_count == 0 {
        return None;
    }
    let endpoints_start = 10_usize;
    let endpoints_end = endpoints_start.checked_add(contour_count.checked_mul(2)?)?;
    glyph.get(endpoints_start..endpoints_end)?;
    let mut endpoints = Vec::with_capacity(contour_count);
    for contour in 0..contour_count {
        let endpoint = usize::from(read_u16(glyph, endpoints_start + contour * 2)?);
        if endpoints
            .last()
            .is_some_and(|previous| endpoint <= *previous)
        {
            return None;
        }
        endpoints.push(endpoint);
    }
    let point_count = endpoints.last()?.checked_add(1)?;
    if point_count > MAX_GLYF_CONTOUR_POINTS {
        return None;
    }
    let instruction_length = usize::from(read_u16(glyph, endpoints_end)?);
    let mut cursor = endpoints_end
        .checked_add(2)?
        .checked_add(instruction_length)?;
    glyph.get(..cursor)?;
    let mut flags = Vec::with_capacity(point_count);
    while flags.len() < point_count {
        let flag = *glyph.get(cursor)?;
        cursor = cursor.checked_add(1)?;
        if flag & 0x80 != 0 {
            return None;
        }
        let copies = if flag & 0x08 != 0 {
            let repeats = usize::from(*glyph.get(cursor)?);
            cursor = cursor.checked_add(1)?;
            repeats.checked_add(1)?
        } else {
            1
        };
        if flags.len().checked_add(copies)? > point_count {
            return None;
        }
        flags.extend(std::iter::repeat_n(flag & 0x01 != 0, copies));
    }
    let mut start = 0_usize;
    endpoints
        .into_iter()
        .map(|end| {
            let end = end.checked_add(1)?;
            let contour = flags.get(start..end)?.to_vec();
            start = end;
            Some(contour)
        })
        .collect()
}

fn parse_simple_glyf_points(
    glyph: &[u8],
    contour_count: usize,
    remaining_points: &mut usize,
) -> Option<Vec<GlyfPoint>> {
    let encoded_contour_count = read_i16(glyph, 0)?;
    if encoded_contour_count <= 0 {
        return None;
    }
    if usize::try_from(encoded_contour_count).ok()? != contour_count {
        return None;
    }
    let endpoints_start = 10_usize;
    let endpoints_end = endpoints_start.checked_add(contour_count.checked_mul(2)?)?;
    glyph.get(endpoints_start..endpoints_end)?;
    let mut previous_endpoint = None;
    let mut final_endpoint = 0_u16;
    for contour in 0..contour_count {
        let endpoint = read_u16(glyph, endpoints_start + contour * 2)?;
        if previous_endpoint.is_some_and(|previous| endpoint <= previous) {
            return None;
        }
        previous_endpoint = Some(endpoint);
        final_endpoint = endpoint;
    }
    let point_count = usize::from(final_endpoint).checked_add(1)?;
    *remaining_points = remaining_points.checked_sub(point_count)?;
    let instruction_length = usize::from(read_u16(glyph, endpoints_end)?);
    let mut cursor = endpoints_end
        .checked_add(2)?
        .checked_add(instruction_length)?;
    glyph.get(..cursor)?;

    let mut flags = Vec::with_capacity(point_count);
    while flags.len() < point_count {
        let flag = *glyph.get(cursor)?;
        cursor = cursor.checked_add(1)?;
        if flag & 0x80 != 0 {
            return None;
        }
        let copies = if flag & 0x08 != 0 {
            let repeats = usize::from(*glyph.get(cursor)?);
            cursor = cursor.checked_add(1)?;
            repeats.checked_add(1)?
        } else {
            1
        };
        if flags.len().checked_add(copies)? > point_count {
            return None;
        }
        flags.extend(std::iter::repeat_n(flag, copies));
    }

    let mut x = 0_i32;
    let mut x_coordinates = Vec::with_capacity(point_count);
    for flag in flags.iter().copied() {
        let delta = if flag & 0x02 != 0 {
            let magnitude = i32::from(*glyph.get(cursor)?);
            cursor = cursor.checked_add(1)?;
            if flag & 0x10 != 0 {
                magnitude
            } else {
                -magnitude
            }
        } else if flag & 0x10 != 0 {
            0
        } else {
            let delta = i32::from(read_i16(glyph, cursor)?);
            cursor = cursor.checked_add(2)?;
            delta
        };
        x = x.checked_add(delta)?;
        x_coordinates.push(x);
    }

    // Validate the complete Y stream too, so a truncated outline cannot lend
    // a seemingly valid early X coordinate to GDEF.
    let mut y = 0_i32;
    let mut points = Vec::with_capacity(point_count);
    for (flag, x) in flags.into_iter().zip(x_coordinates) {
        let delta = if flag & 0x04 != 0 {
            let magnitude = i32::from(*glyph.get(cursor)?);
            cursor = cursor.checked_add(1)?;
            if flag & 0x20 != 0 {
                magnitude
            } else {
                -magnitude
            }
        } else if flag & 0x20 != 0 {
            0
        } else {
            let delta = i32::from(read_i16(glyph, cursor)?);
            cursor = cursor.checked_add(2)?;
            delta
        };
        y = y.checked_add(delta)?;
        points.push(GlyfPoint { x, y });
    }
    Some(points)
}

fn parse_composite_glyf_components(glyph: &[u8]) -> Option<Vec<CompositeGlyfComponent>> {
    if read_i16(glyph, 0)? >= 0 {
        return None;
    }
    let mut cursor = 10_usize;
    let mut components = Vec::new();
    let mut has_instructions = false;
    loop {
        if components.len() >= MAX_COMPOSITE_GLYF_COMPONENTS {
            return None;
        }
        let flags = read_u16(glyph, cursor)?;
        let glyph_id = read_u16(glyph, cursor.checked_add(2)?)?;
        cursor = cursor.checked_add(4)?;
        if flags & GLYF_RESERVED_FLAGS != 0 {
            return None;
        }
        let words = flags & GLYF_ARG_1_AND_2_ARE_WORDS != 0;
        let xy_arguments = flags & GLYF_ARGS_ARE_XY_VALUES != 0;
        let (argument_one, argument_two) = if words {
            let first = if xy_arguments {
                i32::from(read_i16(glyph, cursor)?)
            } else {
                i32::from(read_u16(glyph, cursor)?)
            };
            let second_offset = cursor.checked_add(2)?;
            let second = if xy_arguments {
                i32::from(read_i16(glyph, second_offset)?)
            } else {
                i32::from(read_u16(glyph, second_offset)?)
            };
            cursor = cursor.checked_add(4)?;
            (first, second)
        } else {
            let first = *glyph.get(cursor)?;
            let second = *glyph.get(cursor.checked_add(1)?)?;
            cursor = cursor.checked_add(2)?;
            if xy_arguments {
                (i32::from(first as i8), i32::from(second as i8))
            } else {
                (i32::from(first), i32::from(second))
            }
        };

        let transform_kind_count = usize::from(flags & GLYF_WE_HAVE_A_SCALE != 0)
            + usize::from(flags & GLYF_WE_HAVE_AN_X_AND_Y_SCALE != 0)
            + usize::from(flags & GLYF_WE_HAVE_A_TWO_BY_TWO != 0);
        if transform_kind_count > 1 {
            return None;
        }
        let mut matrix = [16_384_i32, 0, 0, 16_384_i32];
        if flags & GLYF_WE_HAVE_A_SCALE != 0 {
            let scale = i32::from(read_i16(glyph, cursor)?);
            cursor = cursor.checked_add(2)?;
            matrix = [scale, 0, 0, scale];
        } else if flags & GLYF_WE_HAVE_AN_X_AND_Y_SCALE != 0 {
            matrix[0] = i32::from(read_i16(glyph, cursor)?);
            matrix[3] = i32::from(read_i16(glyph, cursor.checked_add(2)?)?);
            cursor = cursor.checked_add(4)?;
        } else if flags & GLYF_WE_HAVE_A_TWO_BY_TWO != 0 {
            for value in &mut matrix {
                *value = i32::from(read_i16(glyph, cursor)?);
                cursor = cursor.checked_add(2)?;
            }
        }
        let determinant = i64::from(matrix[0]) * i64::from(matrix[3])
            - i64::from(matrix[1]) * i64::from(matrix[2]);
        if determinant == 0 {
            return None;
        }

        components.push(CompositeGlyfComponent {
            flags,
            glyph_id,
            argument_one,
            argument_two,
            matrix,
        });
        has_instructions |= flags & GLYF_WE_HAVE_INSTRUCTIONS != 0;
        if flags & GLYF_MORE_COMPONENTS == 0 {
            break;
        }
    }
    if has_instructions {
        let instruction_length = usize::from(read_u16(glyph, cursor)?);
        cursor = cursor.checked_add(2)?.checked_add(instruction_length)?;
        glyph.get(..cursor)?;
    }
    Some(components)
}

fn parse_composite_glyf_points(
    tables: &GlyfTables<'_>,
    glyph: &[u8],
    stack: &mut Vec<u16>,
    remaining_points: &mut usize,
) -> Option<Vec<GlyfPoint>> {
    let mut points: Vec<GlyfPoint> = Vec::new();
    for component_record in parse_composite_glyf_components(glyph)? {
        let flags = component_record.flags;
        let xy_arguments = component_record.uses_xy_arguments();
        let component =
            glyf_contour_points(tables, component_record.glyph_id, stack, remaining_points)?;
        let mut transformed = component
            .into_iter()
            .map(|point| transform_glyf_point(point, component_record.matrix))
            .collect::<Option<Vec<_>>>()?;
        let (offset_x, offset_y) = if xy_arguments {
            let scaled = flags & GLYF_SCALED_COMPONENT_OFFSET != 0;
            let unscaled = flags & GLYF_UNSCALED_COMPONENT_OFFSET != 0;
            if scaled && unscaled {
                return None;
            }
            if scaled {
                let offset = transform_glyf_point(
                    GlyfPoint {
                        x: component_record.argument_one,
                        y: component_record.argument_two,
                    },
                    component_record.matrix,
                )?;
                (offset.x, offset.y)
            } else {
                // OpenType recommends unscaled offsets when neither mode flag
                // is set; current Microsoft and Apple behavior matches it.
                (component_record.argument_one, component_record.argument_two)
            }
        } else {
            if flags
                & (GLYF_ROUND_XY_TO_GRID
                    | GLYF_SCALED_COMPONENT_OFFSET
                    | GLYF_UNSCALED_COMPONENT_OFFSET)
                != 0
            {
                return None;
            }
            let parent_index = usize::try_from(component_record.argument_one).ok()?;
            let component_index = usize::try_from(component_record.argument_two).ok()?;
            let parent_point = *points.get(parent_index)?;
            let component_point = *transformed.get(component_index)?;
            (
                parent_point.x.checked_sub(component_point.x)?,
                parent_point.y.checked_sub(component_point.y)?,
            )
        };
        for point in &mut transformed {
            point.x = point.x.checked_add(offset_x)?;
            point.y = point.y.checked_add(offset_y)?;
        }
        if points.len().checked_add(transformed.len())? > MAX_GLYF_CONTOUR_POINTS {
            return None;
        }
        points.extend(transformed);
    }
    (!points.is_empty()).then_some(points)
}

fn transform_glyf_point(point: GlyfPoint, matrix: [i32; 4]) -> Option<GlyfPoint> {
    Some(GlyfPoint {
        x: round_f2dot14(
            i64::from(matrix[0]) * i64::from(point.x) + i64::from(matrix[2]) * i64::from(point.y),
        )?,
        y: round_f2dot14(
            i64::from(matrix[1]) * i64::from(point.x) + i64::from(matrix[3]) * i64::from(point.y),
        )?,
    })
}

fn round_f2dot14(value: i64) -> Option<i32> {
    let rounded = if value >= 0 {
        value.checked_add(8_192)?.checked_div(16_384)?
    } else {
        value
            .checked_neg()?
            .checked_add(8_192)?
            .checked_div(16_384)?
            .checked_neg()?
    };
    i32::try_from(rounded).ok()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GdefDeviceAdjustment {
    /// Device deltas apply only after a pixel-per-em hinting scale is selected.
    /// This renderer lays out in unhinted design units, so the base coordinate
    /// is already the exact value for its coordinate space.
    HintingOnly,
    VariationIndex {
        outer_index: u16,
        inner_index: u16,
    },
}

fn validate_unhinted_device_table(data: &[u8], offset: usize) -> Option<GdefDeviceAdjustment> {
    let start_size = read_u16(data, offset)?;
    let end_size = read_u16(data, offset.checked_add(2)?)?;
    let delta_format = read_u16(data, offset.checked_add(4)?)?;
    if delta_format == 0x8000 {
        return Some(GdefDeviceAdjustment::VariationIndex {
            outer_index: start_size,
            inner_index: end_size,
        });
    }
    if end_size < start_size {
        return None;
    }
    let bits_per_value = match delta_format {
        1 => 2_usize,
        2 => 4,
        3 => 8,
        _ => return None,
    };
    let value_count = usize::from(end_size - start_size).checked_add(1)?;
    let word_count = value_count.checked_mul(bits_per_value)?.checked_add(15)? / 16;
    let values_start = offset.checked_add(6)?;
    let values_end = values_start.checked_add(word_count.checked_mul(2)?)?;
    data.get(values_start..values_end)?;
    Some(GdefDeviceAdjustment::HintingOnly)
}

fn rounded_gdef_variation_delta(delta: f32) -> Option<i32> {
    let rounded = f64::from(delta).round();
    (rounded.is_finite() && rounded >= f64::from(i32::MIN) && rounded <= f64::from(i32::MAX))
        .then_some(rounded as i32)
}

fn coverage_index(data: &[u8], offset: usize, glyph_id: u16) -> Option<usize> {
    match read_u16(data, offset)? {
        1 => {
            let count = usize::from(read_u16(data, offset.checked_add(2)?)?);
            let start = offset.checked_add(4)?;
            let end = start.checked_add(count.checked_mul(2)?)?;
            data.get(start..end)?;
            let mut low = 0;
            let mut high = count;
            while low < high {
                let middle = low + (high - low) / 2;
                match read_u16(data, start + middle * 2)?.cmp(&glyph_id) {
                    std::cmp::Ordering::Less => low = middle + 1,
                    std::cmp::Ordering::Greater => high = middle,
                    std::cmp::Ordering::Equal => return Some(middle),
                }
            }
            None
        }
        2 => {
            let count = usize::from(read_u16(data, offset.checked_add(2)?)?);
            let start = offset.checked_add(4)?;
            let end = start.checked_add(count.checked_mul(6)?)?;
            data.get(start..end)?;
            for index in 0..count {
                let record = start + index * 6;
                let first = read_u16(data, record)?;
                let last = read_u16(data, record + 2)?;
                if glyph_id >= first && glyph_id <= last {
                    return usize::from(read_u16(data, record + 4)?)
                        .checked_add(usize::from(glyph_id - first));
                }
            }
            None
        }
        _ => None,
    }
}

fn read_u16(data: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_be_bytes(
        data.get(offset..offset.checked_add(2)?)?.try_into().ok()?,
    ))
}

fn read_i16(data: &[u8], offset: usize) -> Option<i16> {
    Some(i16::from_be_bytes(
        data.get(offset..offset.checked_add(2)?)?.try_into().ok()?,
    ))
}

fn read_u32(data: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_be_bytes(
        data.get(offset..offset.checked_add(4)?)?.try_into().ok()?,
    ))
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
    use unicode_segmentation::UnicodeSegmentation;

    use super::{
        CaretStop, FontVariation, GlyphAtlas, GlyphAtlasError, GlyphKey, GlyphRasterError,
        SyntheticFontStyle, TextDirection, TextLine, TextSelection, TextShapingError,
        TextShapingRun, bidi_visual_runs, fallback_text_layout, font_contour_x,
        gdef_ligature_carets, gdef_logical_caret_step, glyf_contour_x_from_tables,
        layout_shaped_text, layout_shaped_text_runs, layout_shaped_text_with_variations,
        rasterize_glyph, rasterize_glyph_with_variations,
        rasterize_glyph_with_variations_and_style, replace_text_selection, shape_text,
        shape_text_with_variations,
    };

    fn latin_ligature_fixture() -> (&'static [u8], &'static str, super::ShapedText) {
        [
            font_test_data::NOTO_SERIF_DISPLAY_TRIMMED,
            font_test_data::NOTOSERIF_AUTOHINT_SHAPING,
            font_test_data::CANTARELL_VF_TRIMMED,
            font_test_data::TINOS_SUBSET,
        ]
        .into_iter()
        .flat_map(|font| {
            ["ffi", "fi", "ff"]
                .into_iter()
                .map(move |text| (font, text))
        })
        .find_map(|(font, text)| {
            let shaped = shape_text(font, 0, text, TextDirection::LeftToRight).ok()?;
            (shaped.glyphs.len() == 1).then_some((font, text, shaped))
        })
        .expect("locked font fixtures must include one Latin ligature")
    }

    fn replace_sfnt_table(font_bytes: &[u8], tag: &[u8; 4], table: &[u8]) -> Vec<u8> {
        let mut font = font_bytes.to_vec();
        let table_count = usize::from(u16::from_be_bytes(font[4..6].try_into().unwrap()));
        let record = (0..table_count)
            .map(|index| 12 + index * 16)
            .find(|record| &font[*record..*record + 4] == tag);
        let Some(record) = record else {
            let mut tables = (0..table_count)
                .map(|index| {
                    let record = 12 + index * 16;
                    let tag: [u8; 4] = font_bytes[record..record + 4].try_into().unwrap();
                    let offset = usize::try_from(u32::from_be_bytes(
                        font_bytes[record + 8..record + 12].try_into().unwrap(),
                    ))
                    .unwrap();
                    let length = usize::try_from(u32::from_be_bytes(
                        font_bytes[record + 12..record + 16].try_into().unwrap(),
                    ))
                    .unwrap();
                    (tag, font_bytes[offset..offset + length].to_vec())
                })
                .collect::<Vec<_>>();
            tables.push((*tag, table.to_vec()));
            tables.sort_unstable_by_key(|(tag, _)| *tag);
            let count = u16::try_from(tables.len()).unwrap();
            let max_power = 1_u16 << count.ilog2();
            let search_range = max_power * 16;
            let entry_selector = u16::try_from(max_power.ilog2()).unwrap();
            let range_shift = count * 16 - search_range;
            let mut rebuilt = vec![0_u8; 12 + tables.len() * 16];
            rebuilt[0..4].copy_from_slice(&font_bytes[0..4]);
            write_u16(&mut rebuilt, 4, count);
            write_u16(&mut rebuilt, 6, search_range);
            write_u16(&mut rebuilt, 8, entry_selector);
            write_u16(&mut rebuilt, 10, range_shift);
            for (index, (tag, table)) in tables.iter().enumerate() {
                let offset = rebuilt.len().next_multiple_of(4);
                rebuilt.resize(offset, 0);
                rebuilt.extend_from_slice(table);
                let record = 12 + index * 16;
                rebuilt[record..record + 4].copy_from_slice(tag);
                write_u32(&mut rebuilt, record + 4, sfnt_checksum(table));
                write_u32(&mut rebuilt, record + 8, u32::try_from(offset).unwrap());
                write_u32(
                    &mut rebuilt,
                    record + 12,
                    u32::try_from(table.len()).unwrap(),
                );
            }
            return rebuilt;
        };
        let table_offset = font.len().next_multiple_of(4);
        font.resize(table_offset, 0);
        font.extend_from_slice(table);
        font[record + 4..record + 8].fill(0); // Checksums are not used by the parser.
        font[record + 8..record + 12]
            .copy_from_slice(&u32::try_from(table_offset).unwrap().to_be_bytes());
        font[record + 12..record + 16]
            .copy_from_slice(&u32::try_from(table.len()).unwrap().to_be_bytes());
        font
    }

    fn sfnt_checksum(table: &[u8]) -> u32 {
        table
            .chunks(4)
            .map(|chunk| {
                let mut bytes = [0_u8; 4];
                bytes[..chunk.len()].copy_from_slice(chunk);
                u32::from_be_bytes(bytes)
            })
            .fold(0_u32, u32::wrapping_add)
    }

    fn replace_glyf_with_cff(font_bytes: &[u8], cff: &[u8], glyph_count: u16) -> Vec<u8> {
        let table_count = usize::from(u16::from_be_bytes(font_bytes[4..6].try_into().unwrap()));
        let mut tables = (0..table_count)
            .filter_map(|index| {
                let record = 12 + index * 16;
                let tag: [u8; 4] = font_bytes[record..record + 4].try_into().unwrap();
                if matches!(&tag, b"glyf" | b"loca" | b"CFF " | b"CFF2" | b"maxp") {
                    return None;
                }
                let offset = usize::try_from(u32::from_be_bytes(
                    font_bytes[record + 8..record + 12].try_into().unwrap(),
                ))
                .unwrap();
                let length = usize::try_from(u32::from_be_bytes(
                    font_bytes[record + 12..record + 16].try_into().unwrap(),
                ))
                .unwrap();
                Some((tag, font_bytes[offset..offset + length].to_vec()))
            })
            .collect::<Vec<_>>();
        let mut maxp = vec![0_u8; 6];
        write_u32(&mut maxp, 0, 0x0000_5000);
        write_u16(&mut maxp, 4, glyph_count);
        tables.push((*b"maxp", maxp));
        tables.push((*b"CFF ", cff.to_vec()));
        tables.sort_unstable_by_key(|(tag, _)| *tag);

        let count = u16::try_from(tables.len()).unwrap();
        let max_power = 1_u16 << count.ilog2();
        let search_range = max_power * 16;
        let entry_selector = u16::try_from(max_power.ilog2()).unwrap();
        let range_shift = count * 16 - search_range;
        let directory_len = 12 + tables.len() * 16;
        let mut font = vec![0_u8; directory_len];
        font[0..4].copy_from_slice(b"OTTO");
        write_u16(&mut font, 4, count);
        write_u16(&mut font, 6, search_range);
        write_u16(&mut font, 8, entry_selector);
        write_u16(&mut font, 10, range_shift);
        for (index, (tag, table)) in tables.iter().enumerate() {
            let offset = font.len().next_multiple_of(4);
            font.resize(offset, 0);
            font.extend_from_slice(table);
            let record = 12 + index * 16;
            font[record..record + 4].copy_from_slice(tag);
            write_u32(&mut font, record + 4, sfnt_checksum(table));
            write_u32(&mut font, record + 8, u32::try_from(offset).unwrap());
            write_u32(&mut font, record + 12, u32::try_from(table.len()).unwrap());
        }
        font
    }

    fn cff_index(objects: &[Vec<u8>]) -> Vec<u8> {
        let mut index = Vec::new();
        index.extend_from_slice(&u16::try_from(objects.len()).unwrap().to_be_bytes());
        if objects.is_empty() {
            return index;
        }
        let data_len = objects.iter().map(Vec::len).sum::<usize>();
        let last_offset = data_len + 1;
        let off_size = if last_offset <= u8::MAX as usize {
            1
        } else if last_offset <= u16::MAX as usize {
            2
        } else if last_offset <= 0x00ff_ffff {
            3
        } else {
            4
        };
        index.push(off_size);
        let mut offset = 1_usize;
        for length in objects.iter().map(Vec::len).chain(std::iter::once(0_usize)) {
            let encoded = u32::try_from(offset).unwrap().to_be_bytes();
            index.extend_from_slice(&encoded[4 - usize::from(off_size)..]);
            offset += length;
        }
        for object in objects {
            index.extend_from_slice(object);
        }
        index
    }

    fn cff_fixture(glyph_count: u16, outlined_glyph: u16) -> Vec<u8> {
        let name = cff_index(&[b"Test".to_vec()]);
        let top_index_len = 11_usize; // one six-byte Top DICT object
        let charstrings_offset = 4 + name.len() + top_index_len + 2 + 2;
        let mut top_dict = vec![29];
        top_dict.extend_from_slice(&u32::try_from(charstrings_offset).unwrap().to_be_bytes());
        top_dict.push(17); // CharStrings operator
        let top = cff_index(&[top_dict]);

        let mut charstrings = vec![vec![14_u8]; usize::from(glyph_count)];
        charstrings[usize::from(outlined_glyph)] = vec![
            189, 139, 21, // 50 0 rmoveto
            239, 139, 5, // 100 0 rlineto => x=150
            239, 139, 189, 189, 89, 189, 8,  // rrcurveto => x=250,300,250
            14, // endchar
        ];

        let mut cff = vec![1, 0, 4, 1];
        cff.extend_from_slice(&name);
        cff.extend_from_slice(&top);
        cff.extend_from_slice(&cff_index(&[])); // String INDEX
        cff.extend_from_slice(&cff_index(&[])); // Global Subr INDEX
        assert_eq!(cff.len(), charstrings_offset);
        cff.extend_from_slice(&cff_index(&charstrings));
        cff
    }

    fn write_u16(target: &mut [u8], offset: usize, value: u16) {
        target[offset..offset + 2].copy_from_slice(&value.to_be_bytes());
    }

    fn write_i16(target: &mut [u8], offset: usize, value: i16) {
        target[offset..offset + 2].copy_from_slice(&value.to_be_bytes());
    }

    fn write_u32(target: &mut [u8], offset: usize, value: u32) {
        target[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
    }

    fn simple_and_composite_glyf_fixture() -> (Vec<u8>, [u8; 6], Vec<u8>) {
        let mut head = vec![0_u8; 54];
        write_i16(&mut head, 50, 0); // short loca offsets

        let mut simple = vec![0_u8; 22];
        write_i16(&mut simple, 0, 1); // one simple contour
        write_u16(&mut simple, 10, 2); // final point index
        write_u16(&mut simple, 12, 0); // no instructions
        simple[14..17].copy_from_slice(&[0x33, 0x21, 0x23]);
        simple[17] = 100; // x = 100, positive short delta
        write_i16(&mut simple, 18, 300); // x = 400, signed long delta
        simple[20] = 100; // x = 300, negative short delta

        let mut composite = vec![0_u8; 28];
        write_i16(&mut composite, 0, -1);
        write_u16(&mut composite, 10, 0x0023); // words, XY, more components
        write_u16(&mut composite, 12, 0); // simple glyph
        write_i16(&mut composite, 14, 50);
        write_i16(&mut composite, 16, 10);
        write_u16(&mut composite, 18, 0x0009); // words, point match, 0.5 scale
        write_u16(&mut composite, 20, 0); // simple glyph
        write_u16(&mut composite, 22, 1); // parent point
        write_u16(&mut composite, 24, 0); // component point
        write_i16(&mut composite, 26, 8_192);

        let mut glyf = simple;
        glyf.extend_from_slice(&composite);
        let loca = [0_u8, 0, 0, 11, 0, 25];
        (head, loca, glyf)
    }

    fn replace_glyf_glyph(font_bytes: &[u8], glyph_id: u16, replacement: &[u8]) -> Vec<u8> {
        let face = super::rustybuzz_face(font_bytes, 0, &[]).unwrap();
        let raw = face.raw_face();
        let original_head = raw.table(ttf_parser::Tag::from_bytes(b"head")).unwrap();
        let original_loca = raw.table(ttf_parser::Tag::from_bytes(b"loca")).unwrap();
        let original_glyf = raw.table(ttf_parser::Tag::from_bytes(b"glyf")).unwrap();
        let glyph_count = face.number_of_glyphs();
        let index_to_loc_format = super::read_i16(original_head, 50).unwrap();
        let glyph_offset = |index: usize| match index_to_loc_format {
            0 => usize::from(super::read_u16(original_loca, index * 2).unwrap()) * 2,
            1 => usize::try_from(super::read_u32(original_loca, index * 4).unwrap()).unwrap(),
            _ => panic!("fixture head must use a supported loca format"),
        };

        let mut glyf = Vec::new();
        let mut offsets = Vec::with_capacity(usize::from(glyph_count) + 1);
        for current in 0..glyph_count {
            offsets.push(u32::try_from(glyf.len()).unwrap());
            if current == glyph_id {
                glyf.extend_from_slice(replacement);
            } else {
                let start = glyph_offset(usize::from(current));
                let end = glyph_offset(usize::from(current) + 1);
                glyf.extend_from_slice(&original_glyf[start..end]);
            }
            glyf.resize(glyf.len().next_multiple_of(4), 0);
        }
        offsets.push(u32::try_from(glyf.len()).unwrap());
        let loca = offsets
            .into_iter()
            .flat_map(u32::to_be_bytes)
            .collect::<Vec<_>>();
        let mut head = original_head.to_vec();
        write_i16(&mut head, 50, 1);

        let font = replace_sfnt_table(font_bytes, b"head", &head);
        let font = replace_sfnt_table(&font, b"loca", &loca);
        replace_sfnt_table(&font, b"glyf", &glyf)
    }

    fn point_matched_vazirmatn_font() -> (Vec<u8>, u16) {
        const COMPOSITE_GLYPH: u16 = 2;
        let base = font_test_data::VAZIRMATN_VAR;
        let face = super::rustybuzz_face(base, 0, &[]).unwrap();
        let raw = face.raw_face();
        let tables = super::GlyfTables {
            loca: raw.table(ttf_parser::Tag::from_bytes(b"loca")).unwrap(),
            glyf: raw.table(ttf_parser::Tag::from_bytes(b"glyf")).unwrap(),
            glyph_count: face.number_of_glyphs(),
            index_to_loc_format: super::read_i16(
                raw.table(ttf_parser::Tag::from_bytes(b"head")).unwrap(),
                50,
            )
            .unwrap(),
        };
        let mut composite = tables.glyph_data(COMPOSITE_GLYPH).unwrap().to_vec();
        assert_eq!(super::read_i16(&composite, 0), Some(-1));
        assert_eq!(super::read_u16(&composite, 16), Some(0x0507));
        assert_eq!(super::read_u16(&composite, 18), Some(3));

        // Keep the second component and component count from the real variable
        // font, but align its point zero to point zero of the first component.
        write_u16(&mut composite, 16, 0x0501);
        write_u16(&mut composite, 20, 0);
        write_u16(&mut composite, 22, 0);
        (
            replace_glyf_glyph(base, COMPOSITE_GLYPH, &composite),
            COMPOSITE_GLYPH,
        )
    }

    fn glyf_topology_for_test(
        tables: &super::GlyfTables<'_>,
        glyph_id: u16,
        stack: &mut Vec<u16>,
        remaining_points: &mut usize,
    ) -> Option<Vec<Vec<bool>>> {
        if stack.len() >= super::MAX_COMPOSITE_GLYF_DEPTH || stack.contains(&glyph_id) {
            return None;
        }
        stack.push(glyph_id);
        let result = (|| {
            let glyph = tables.glyph_data(glyph_id)?;
            let contour_count = super::read_i16(glyph, 0)?;
            if contour_count > 0 {
                let contours = super::simple_glyf_topology(glyph)?;
                let point_count = contours.iter().map(Vec::len).sum::<usize>();
                *remaining_points = remaining_points.checked_sub(point_count)?;
                return Some(contours);
            }
            if contour_count == 0 {
                return None;
            }
            let components = super::parse_composite_glyf_components(glyph)?;
            let mut contours = Vec::new();
            for component in components {
                contours.extend(glyf_topology_for_test(
                    tables,
                    component.glyph_id,
                    stack,
                    remaining_points,
                )?);
            }
            (!contours.is_empty()).then_some(contours)
        })();
        stack.pop();
        result
    }

    #[test]
    fn keeps_utf8_graphemes_and_caret_stops_together() {
        let layout = fallback_text_layout("A😀中", 2);
        assert_eq!(
            layout.lines,
            vec![
                TextLine {
                    start: 0,
                    end: 5,
                    direction: TextDirection::LeftToRight,
                    visual_runs: vec![super::VisualTextRun {
                        start: 0,
                        end: 5,
                        direction: TextDirection::LeftToRight,
                    }],
                },
                TextLine {
                    start: 5,
                    end: 8,
                    direction: TextDirection::LeftToRight,
                    visual_runs: vec![super::VisualTextRun {
                        start: 5,
                        end: 8,
                        direction: TextDirection::LeftToRight,
                    }],
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
    fn fallback_layout_retains_mixed_bidi_runs_in_visual_order() {
        let text = "AאבB";
        let layout = fallback_text_layout(text, 20);
        assert_eq!(layout.lines.len(), 1);
        let line = &layout.lines[0];
        assert_eq!(line.direction, TextDirection::LeftToRight);
        assert_eq!(line.visual_runs.len(), 3);
        assert_eq!(line.visual_runs[0].direction, TextDirection::LeftToRight);
        assert_eq!(line.visual_runs[1].direction, TextDirection::RightToLeft);
        assert_eq!(line.visual_runs[2].direction, TextDirection::LeftToRight);
        let mut logical = line.visual_runs.clone();
        logical.sort_by_key(|run| run.start);
        assert_eq!(logical.first().map(|run| run.start), Some(0));
        assert_eq!(logical.last().map(|run| run.end), Some(text.len() as u32));
        assert!(logical.windows(2).all(|runs| runs[0].end == runs[1].start));
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
    fn reads_bounded_gdef_ligature_carets_for_coverage_formats_one_and_two() {
        // GDEF 1.0 -> LigCaretList -> Coverage format 1 -> glyph 42 ->
        // two CaretValueFormat1 coordinates at 300 and 700 design units.
        let coverage_one = [
            0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x00, 0x00, 0x00, 0x08,
            0x00, 0x01, 0x00, 0x0e, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x2a, 0x00, 0x02,
            0x00, 0x06, 0x00, 0x0a, 0x00, 0x01, 0x01, 0x2c, 0x00, 0x01, 0x02, 0xbc,
        ];
        assert_eq!(
            gdef_ligature_carets(&coverage_one, 42, 2, |_, _| None, |_, _| None),
            Some(vec![300, 700])
        );
        assert_eq!(
            gdef_ligature_carets(&coverage_one, 41, 2, |_, _| None, |_, _| None),
            None
        );
        assert_eq!(
            gdef_ligature_carets(&coverage_one, 42, 1, |_, _| None, |_, _| None),
            None
        );
        assert_eq!(
            gdef_ligature_carets(
                &coverage_one[..coverage_one.len() - 1],
                42,
                2,
                |_, _| None,
                |_, _| None,
            ),
            None
        );
        let mut unordered = coverage_one;
        unordered[34..36].copy_from_slice(&700_i16.to_be_bytes());
        unordered[38..40].copy_from_slice(&300_i16.to_be_bytes());
        assert_eq!(
            gdef_ligature_carets(&unordered, 42, 2, |_, _| None, |_, _| None),
            None
        );

        let coverage_two = [
            0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x00, 0x00, 0x00, 0x08,
            0x00, 0x01, 0x00, 0x12, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0x00, 0x2a, 0x00, 0x2a,
            0x00, 0x00, 0x00, 0x02, 0x00, 0x06, 0x00, 0x0a, 0x00, 0x01, 0x01, 0x2c, 0x00, 0x01,
            0x02, 0xbc,
        ];
        assert_eq!(
            gdef_ligature_carets(&coverage_two, 42, 2, |_, _| None, |_, _| None),
            Some(vec![300, 700])
        );
    }

    #[test]
    fn accepts_unhinted_gdef_format_three_and_resolves_variation_indices() {
        let unadjusted = [
            0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x00, 0x00, 0x00, 0x08,
            0x00, 0x01, 0x00, 0x0e, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x2a, 0x00, 0x02,
            0x00, 0x06, 0x00, 0x0c, 0x00, 0x03, 0x01, 0x2c, 0x00, 0x00, 0x00, 0x01, 0x02, 0xbc,
        ];
        assert_eq!(
            gdef_ligature_carets(&unadjusted, 42, 2, |_, _| None, |_, _| None),
            Some(vec![300, 700])
        );

        let variation_index = [
            0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x00, 0x00, 0x00, 0x08,
            0x00, 0x01, 0x00, 0x0e, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x2a, 0x00, 0x01,
            0x00, 0x04, 0x00, 0x03, 0x01, 0x2c, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x80, 0x00,
        ];
        assert_eq!(
            gdef_ligature_carets(&variation_index, 42, 1, |_, _| None, |_, _| None),
            None
        );
        assert_eq!(
            gdef_ligature_carets(
                &variation_index,
                42,
                1,
                |outer, inner| { (outer == 0 && inner == 0).then_some(40) },
                |_, _| None
            ),
            Some(vec![340])
        );
        assert_eq!(
            gdef_ligature_carets(&variation_index, 42, 1, |_, _| Some(i32::MAX), |_, _| None,),
            None
        );
        let mut device_adjusted = variation_index.to_vec();
        device_adjusted[40..42].copy_from_slice(&1_u16.to_be_bytes());
        assert_eq!(
            gdef_ligature_carets(&device_adjusted, 42, 1, |_, _| None, |_, _| None),
            None
        );
        device_adjusted.extend_from_slice(&0_u16.to_be_bytes());
        assert_eq!(
            gdef_ligature_carets(&device_adjusted, 42, 1, |_, _| None, |_, _| None),
            Some(vec![300])
        );
    }

    #[test]
    fn reads_bounded_simple_glyf_contour_point_coordinates() {
        let (head, _, glyf_with_composite) = simple_and_composite_glyf_fixture();
        let glyf = &glyf_with_composite[..22];
        let loca = [0_u8, 0, 0, 11]; // glyph 0 occupies 22 bytes

        assert_eq!(
            glyf_contour_x_from_tables(&head, &loca, &glyf, 1, 0, 0),
            Some(100)
        );
        assert_eq!(
            glyf_contour_x_from_tables(&head, &loca, &glyf, 1, 0, 1),
            Some(400)
        );
        assert_eq!(
            glyf_contour_x_from_tables(&head, &loca, &glyf, 1, 0, 2),
            Some(300)
        );
        assert_eq!(
            glyf_contour_x_from_tables(&head, &loca, &glyf, 1, 0, 3),
            None
        );
        assert_eq!(
            glyf_contour_x_from_tables(&head, &loca, &glyf[..20], 1, 0, 1),
            None
        );
        let mut overlapping = glyf.to_vec();
        overlapping[14] |= 0x40;
        assert_eq!(
            glyf_contour_x_from_tables(&head, &loca, &overlapping, 1, 0, 0),
            Some(100)
        );
        let mut reserved_flag = glyf.to_vec();
        reserved_flag[14] |= 0x80;
        assert_eq!(
            glyf_contour_x_from_tables(&head, &loca, &reserved_flag, 1, 0, 0),
            None
        );
    }

    #[test]
    fn resolves_bounded_composite_glyf_points_and_gdef_format_two_carets() {
        let (head, loca, glyf) = simple_and_composite_glyf_fixture();
        let coordinates = (0..6)
            .map(|point| glyf_contour_x_from_tables(&head, &loca, &glyf, 2, 1, point).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(coordinates, vec![150, 450, 350, 450, 600, 550]);

        let mut gdef = [0_u8; 48];
        write_u32(&mut gdef, 0, 0x0001_0000);
        write_u16(&mut gdef, 8, 12); // LigCaretList
        write_u16(&mut gdef, 12, 8); // Coverage from LigCaretList
        write_u16(&mut gdef, 14, 1); // LigGlyph count
        write_u16(&mut gdef, 16, 14); // LigGlyph from LigCaretList
        write_u16(&mut gdef, 20, 1); // Coverage format 1
        write_u16(&mut gdef, 22, 1);
        write_u16(&mut gdef, 24, 1); // composite glyph
        write_u16(&mut gdef, 26, 2); // caretCount
        write_u16(&mut gdef, 28, 6);
        write_u16(&mut gdef, 30, 10);
        write_u16(&mut gdef, 32, 2); // CaretValue format 2
        write_u16(&mut gdef, 34, 0);
        write_u16(&mut gdef, 36, 2);
        write_u16(&mut gdef, 38, 4);

        assert_eq!(
            gdef_ligature_carets(
                &gdef,
                1,
                2,
                |_, _| None,
                |glyph_id, point_index| glyf_contour_x_from_tables(
                    &head,
                    &loca,
                    &glyf,
                    2,
                    glyph_id,
                    point_index,
                ),
            ),
            Some(vec![150, 600])
        );
    }

    #[test]
    fn applies_composite_transform_variants_and_nested_component_offsets() {
        let (head, _, base_glyf) = simple_and_composite_glyf_fixture();
        let simple = &base_glyf[..22];
        let mut transformed = vec![0_u8; 40];
        write_i16(&mut transformed, 0, -1);

        write_u16(&mut transformed, 10, 0x0022); // byte XY, more components
        write_u16(&mut transformed, 12, 0);
        transformed[14] = (-10_i8).to_be_bytes()[0];
        transformed[15] = 5;

        write_u16(&mut transformed, 16, 0x1062); // byte XY, separate scale, unscaled offset
        write_u16(&mut transformed, 18, 0);
        transformed[20] = 20;
        transformed[21] = 0;
        write_i16(&mut transformed, 22, 8_192);
        write_i16(&mut transformed, 24, 16_384);

        write_u16(&mut transformed, 26, 0x1082); // byte XY, 2x2, unscaled offset
        write_u16(&mut transformed, 28, 0);
        transformed[30] = 0;
        transformed[31] = 0;
        write_i16(&mut transformed, 32, 0);
        write_i16(&mut transformed, 34, 16_384);
        write_i16(&mut transformed, 36, -16_384);
        write_i16(&mut transformed, 38, 0);

        let mut nested = vec![0_u8; 18];
        write_i16(&mut nested, 0, -1);
        write_u16(&mut nested, 10, 0x0003); // word XY
        write_u16(&mut nested, 12, 1);
        write_i16(&mut nested, 14, 5);
        write_i16(&mut nested, 16, 0);

        let mut glyf = simple.to_vec();
        glyf.extend_from_slice(&transformed);
        glyf.extend_from_slice(&nested);
        let loca = [0_u8, 0, 0, 11, 0, 31, 0, 40];
        let transformed_xs = (0..9)
            .map(|point| glyf_contour_x_from_tables(&head, &loca, &glyf, 3, 1, point).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(transformed_xs, vec![90, 390, 290, 70, 220, 170, 0, 0, 0]);
        let nested_xs = (0..9)
            .map(|point| glyf_contour_x_from_tables(&head, &loca, &glyf, 3, 2, point).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(nested_xs, vec![95, 395, 295, 75, 225, 175, 5, 5, 5]);
    }

    #[test]
    fn accepts_default_unscaled_offsets_and_rejects_invalid_composite_glyf_data() {
        let (head, loca, glyf) = simple_and_composite_glyf_fixture();

        let mut invalid_point_match = glyf.clone();
        write_u16(&mut invalid_point_match, 44, 9);
        assert_eq!(
            glyf_contour_x_from_tables(&head, &loca, &invalid_point_match, 2, 1, 0),
            None
        );

        let mut cycle = glyf.clone();
        write_u16(&mut cycle, 34, 1);
        assert_eq!(
            glyf_contour_x_from_tables(&head, &loca, &cycle, 2, 1, 0),
            None
        );

        let mut default_offset = glyf.clone();
        write_u16(&mut default_offset, 40, 0x000b); // transformed XY, default unscaled offset
        assert_eq!(
            glyf_contour_x_from_tables(&head, &loca, &default_offset, 2, 1, 3),
            Some(51)
        );

        let mut conflicting_offset = glyf;
        write_u16(&mut conflicting_offset, 40, 0x180b); // scaled and unscaled
        assert_eq!(
            glyf_contour_x_from_tables(&head, &loca, &conflicting_offset, 2, 1, 0),
            None
        );
    }

    #[test]
    fn preserves_true_type_point_numbers_while_applying_active_gvar_deltas() {
        let font = font_test_data::VAZIRMATN_VAR;
        let default = super::rustybuzz_face(font, 0, &[]).unwrap();
        let bold = super::rustybuzz_face(
            font,
            0,
            &[FontVariation {
                tag: *b"wght",
                value: 800.0,
            }],
        )
        .unwrap();
        assert!(default.tables().glyf.is_some());
        assert!(default.tables().gvar.is_some());
        let mut simple_glyphs = 0_usize;
        let mut varied_glyphs = 0_usize;
        for glyph_id in 0..default.number_of_glyphs() {
            let Some(default_points) = super::varied_glyf_contour_xs(&default, glyph_id) else {
                continue;
            };
            let raw_points = super::glyf_contour_xs(&default, glyph_id).unwrap();
            assert_eq!(default_points, raw_points);
            simple_glyphs += 1;
            if super::varied_glyf_contour_xs(&bold, glyph_id)
                .is_some_and(|points| points != raw_points)
            {
                varied_glyphs += 1;
            }
        }
        assert!(simple_glyphs > 0);
        assert!(varied_glyphs > 0);
    }

    #[test]
    fn resolves_bounded_xy_composite_gvar_points() {
        let font = font_test_data::VAZIRMATN_VAR;
        let default = super::rustybuzz_face(font, 0, &[]).unwrap();
        let bold = super::rustybuzz_face(
            font,
            0,
            &[FontVariation {
                tag: *b"wght",
                value: 800.0,
            }],
        )
        .unwrap();
        let raw = default.raw_face();
        let tables = super::GlyfTables {
            loca: raw.table(ttf_parser::Tag::from_bytes(b"loca")).unwrap(),
            glyf: raw.table(ttf_parser::Tag::from_bytes(b"glyf")).unwrap(),
            glyph_count: default.number_of_glyphs(),
            index_to_loc_format: super::read_i16(
                raw.table(ttf_parser::Tag::from_bytes(b"head")).unwrap(),
                50,
            )
            .unwrap(),
        };
        let mut admitted = 0_usize;
        let mut varied = 0_usize;
        for glyph_id in 0..default.number_of_glyphs() {
            let Some(glyph) = tables.glyph_data(glyph_id) else {
                continue;
            };
            if super::read_i16(glyph, 0).unwrap_or_default() >= 0 {
                continue;
            }
            let Some(default_points) = super::varied_glyf_contour_xs(&default, glyph_id) else {
                continue;
            };
            let static_points = super::glyf_contour_xs(&default, glyph_id).unwrap();
            assert_eq!(default_points, static_points);
            admitted += 1;
            if super::varied_glyf_contour_xs(&bold, glyph_id)
                .is_some_and(|points| points != static_points)
            {
                varied += 1;
            }
        }
        assert!(
            admitted > 0,
            "fixture must contain an admitted XY composite"
        );
        assert!(varied > 0, "active gvar must move an admitted composite");
    }

    #[test]
    fn matches_ttf_parser_for_active_xy_composite_gvar_points() {
        const COMPOSITE_GLYPH: u16 = 2;
        let bold = super::rustybuzz_face(
            font_test_data::VAZIRMATN_VAR,
            0,
            &[FontVariation {
                tag: *b"wght",
                value: 800.0,
            }],
        )
        .unwrap();
        let raw = bold.raw_face();
        let tables = super::GlyfTables {
            loca: raw.table(ttf_parser::Tag::from_bytes(b"loca")).unwrap(),
            glyf: raw.table(ttf_parser::Tag::from_bytes(b"glyf")).unwrap(),
            glyph_count: bold.number_of_glyphs(),
            index_to_loc_format: super::read_i16(
                raw.table(ttf_parser::Tag::from_bytes(b"head")).unwrap(),
                50,
            )
            .unwrap(),
        };
        let components =
            super::parse_composite_glyf_components(tables.glyph_data(COMPOSITE_GLYPH).unwrap())
                .unwrap();
        assert!(
            components
                .iter()
                .all(|component| component.uses_xy_arguments())
        );

        let mut stack = Vec::new();
        let mut remaining_points = super::MAX_GLYF_CONTOUR_POINTS;
        let topology =
            glyf_topology_for_test(&tables, COMPOSITE_GLYPH, &mut stack, &mut remaining_points)
                .unwrap();
        let engine_points =
            super::outline_simple_glyf_contour_points(&bold, COMPOSITE_GLYPH, &topology)
                .unwrap()
                .into_iter()
                .map(super::round_varied_glyf_point)
                .collect::<Option<Vec<_>>>()
                .unwrap();
        let assembled_points = super::varied_glyf_contour_points(&bold, &tables, COMPOSITE_GLYPH)
            .unwrap()
            .into_iter()
            .map(super::round_varied_glyf_point)
            .collect::<Option<Vec<_>>>()
            .unwrap();

        assert_eq!(assembled_points, engine_points);
    }

    #[test]
    fn rejects_invalid_gvar_header_for_composite_points() {
        const COMPOSITE_GLYPH: u16 = 2;
        let base = font_test_data::VAZIRMATN_VAR;
        let face = super::rustybuzz_face(base, 0, &[]).unwrap();
        let mut gvar = face
            .raw_face()
            .table(ttf_parser::Tag::from_bytes(b"gvar"))
            .unwrap()
            .to_vec();
        write_u16(&mut gvar, 14, 2); // only bit zero is defined by gvar v1
        let font = replace_sfnt_table(base, b"gvar", &gvar);
        let bold = super::rustybuzz_face(
            &font,
            0,
            &[FontVariation {
                tag: *b"wght",
                value: 800.0,
            }],
        )
        .unwrap();

        assert_eq!(super::varied_glyf_contour_xs(&bold, COMPOSITE_GLYPH), None);
    }

    #[test]
    fn resolves_active_gvar_point_matched_composite_points() {
        let (font, glyph_id) = point_matched_vazirmatn_font();
        let default = super::rustybuzz_face(&font, 0, &[]).unwrap();
        let bold = super::rustybuzz_face(
            &font,
            0,
            &[FontVariation {
                tag: *b"wght",
                value: 800.0,
            }],
        )
        .unwrap();
        let static_points = super::glyf_contour_xs(&default, glyph_id).unwrap();
        let default_points = super::varied_glyf_contour_xs(&default, glyph_id).unwrap();
        let bold_points = super::varied_glyf_contour_xs(&bold, glyph_id).unwrap();

        assert_eq!(default_points, static_points);
        assert_ne!(bold_points, static_points);
    }

    #[test]
    fn maps_asymmetric_gdef_carets_from_physical_to_rtl_logical_order() {
        let carets = [250, 600];
        assert_eq!(
            gdef_logical_caret_step(TextDirection::LeftToRight, &carets, 1, 1_000),
            Some(250)
        );
        assert_eq!(
            gdef_logical_caret_step(TextDirection::LeftToRight, &carets, 2, 1_000),
            Some(600)
        );
        // RTL logical boundary 1 is the right physical boundary (x=600), so
        // its distance from the logical right edge is 1000 - 600 = 400.
        assert_eq!(
            gdef_logical_caret_step(TextDirection::RightToLeft, &carets, 1, 1_000),
            Some(400)
        );
        assert_eq!(
            gdef_logical_caret_step(TextDirection::RightToLeft, &carets, 2, 1_000),
            Some(750)
        );
    }

    #[test]
    fn uses_gdef_ligature_carets_in_the_public_shaped_layout() {
        let (base_font, text, baseline) = latin_ligature_fixture();
        let glyph = &baseline.glyphs[0];
        assert_eq!(glyph.cluster, 0);
        assert!(glyph.x_advance > 4);

        let first = i16::try_from(glyph.x_advance / 5).unwrap();
        let second = i16::try_from(glyph.x_advance * 3 / 5).unwrap();
        let mut gdef = [0_u8; 48];
        gdef[0..4].copy_from_slice(&0x0001_0000_u32.to_be_bytes());
        gdef[8..10].copy_from_slice(&12_u16.to_be_bytes());
        gdef[12..14].copy_from_slice(&8_u16.to_be_bytes());
        gdef[14..16].copy_from_slice(&1_u16.to_be_bytes());
        gdef[16..18].copy_from_slice(&14_u16.to_be_bytes());
        gdef[20..22].copy_from_slice(&1_u16.to_be_bytes());
        gdef[22..24].copy_from_slice(&1_u16.to_be_bytes());
        gdef[24..26].copy_from_slice(&u16::try_from(glyph.glyph_id).unwrap().to_be_bytes());
        gdef[26..28].copy_from_slice(&2_u16.to_be_bytes());
        gdef[28..30].copy_from_slice(&6_u16.to_be_bytes());
        gdef[30..32].copy_from_slice(&10_u16.to_be_bytes());
        gdef[32..34].copy_from_slice(&1_u16.to_be_bytes());
        gdef[34..36].copy_from_slice(&first.to_be_bytes());
        gdef[36..38].copy_from_slice(&1_u16.to_be_bytes());
        gdef[38..40].copy_from_slice(&second.to_be_bytes());

        let font = replace_sfnt_table(base_font, b"GDEF", &gdef);

        let layout = layout_shaped_text(&font, 0, text, 100.0).unwrap();
        let line = &layout.lines[0];
        assert_eq!(line.glyphs.len(), 1);
        assert_eq!(
            line.visual_carets,
            vec![
                super::PositionedCaretStop {
                    byte_offset: 0,
                    x_advance: 0
                },
                super::PositionedCaretStop {
                    byte_offset: 1,
                    x_advance: i32::from(first) + line.glyphs[0].x_offset,
                },
                super::PositionedCaretStop {
                    byte_offset: 2,
                    x_advance: i32::from(second) + line.glyphs[0].x_offset,
                },
                super::PositionedCaretStop {
                    byte_offset: 3,
                    x_advance: line.advance,
                },
            ]
        );
    }

    #[test]
    fn applies_gdef_simple_contour_points_in_the_public_shaped_layout() {
        let (base_font, text, baseline) = latin_ligature_fixture();
        let glyph = &baseline.glyphs[0];
        let face = super::rustybuzz_face(base_font, 0, &[]).unwrap();
        let mut points = (0..=u16::MAX)
            .map_while(|point_index| {
                font_contour_x(&face, u16::try_from(glyph.glyph_id).unwrap(), point_index)
                    .map(|x| (x, point_index))
            })
            .filter(|(x, _)| *x > 0 && *x < glyph.x_advance)
            .collect::<Vec<_>>();
        points.sort_unstable();
        points.dedup_by_key(|(x, _)| *x);
        assert!(points.len() >= 2);
        let (first_x, first_point) = points[0];
        let (second_x, second_point) = *points.last().unwrap();
        assert!(first_x < second_x);

        let mut gdef = [0_u8; 48];
        write_u32(&mut gdef, 0, 0x0001_0000);
        write_u16(&mut gdef, 8, 12); // LigCaretList
        write_u16(&mut gdef, 12, 8); // Coverage from LigCaretList
        write_u16(&mut gdef, 14, 1); // LigGlyph count
        write_u16(&mut gdef, 16, 14); // LigGlyph from LigCaretList
        write_u16(&mut gdef, 20, 1); // Coverage format 1
        write_u16(&mut gdef, 22, 1);
        write_u16(&mut gdef, 24, u16::try_from(glyph.glyph_id).unwrap());
        write_u16(&mut gdef, 26, 2); // caretCount
        write_u16(&mut gdef, 28, 6);
        write_u16(&mut gdef, 30, 10);
        write_u16(&mut gdef, 32, 2);
        write_u16(&mut gdef, 34, first_point);
        write_u16(&mut gdef, 36, 2);
        write_u16(&mut gdef, 38, second_point);

        let font = replace_sfnt_table(base_font, b"GDEF", &gdef);
        let line = &layout_shaped_text(&font, 0, text, 100.0).unwrap().lines[0];
        assert_eq!(
            line.visual_carets[1].x_advance,
            first_x + line.glyphs[0].x_offset
        );
        assert_eq!(
            line.visual_carets[2].x_advance,
            second_x + line.glyphs[0].x_offset
        );
    }

    fn assert_active_gvar_gdef_caret_pipeline(
        base_font: &[u8],
        expected_glyph: Option<u16>,
        expect_composite: bool,
    ) {
        let variations = [FontVariation {
            tag: *b"wght",
            value: 800.0,
        }];
        let default = super::rustybuzz_face(base_font, 0, &[]).unwrap();
        let bold = super::rustybuzz_face(base_font, 0, &variations).unwrap();
        let raw = default.raw_face();
        let tables = super::GlyfTables {
            loca: raw.table(ttf_parser::Tag::from_bytes(b"loca")).unwrap(),
            glyf: raw.table(ttf_parser::Tag::from_bytes(b"glyf")).unwrap(),
            glyph_count: default.number_of_glyphs(),
            index_to_loc_format: super::read_i16(
                raw.table(ttf_parser::Tag::from_bytes(b"head")).unwrap(),
                50,
            )
            .unwrap(),
        };
        let (glyph_id, point_index, caret_x) = (0..bold.number_of_glyphs())
            .find_map(|glyph_id| {
                if expected_glyph.is_some_and(|expected| glyph_id != expected) {
                    return None;
                }
                let composite = super::read_i16(tables.glyph_data(glyph_id)?, 0)? < 0;
                if composite != expect_composite {
                    return None;
                }
                let default_points = super::varied_glyf_contour_xs(&default, glyph_id)?;
                let bold_points = super::varied_glyf_contour_xs(&bold, glyph_id)?;
                default_points
                    .into_iter()
                    .zip(bold_points)
                    .enumerate()
                    .find(|(_, (default_x, bold_x))| bold_x > &0 && default_x != bold_x)
                    .map(|(point, (_, x))| (glyph_id, u16::try_from(point).unwrap(), x))
            })
            .expect("locked variable font must move one positive admitted point");
        let advance = caret_x.checked_add(100).unwrap();

        let mut gdef = [0_u8; 40];
        write_u32(&mut gdef, 0, 0x0001_0000);
        write_u16(&mut gdef, 8, 12);
        write_u16(&mut gdef, 12, 8);
        write_u16(&mut gdef, 14, 1);
        write_u16(&mut gdef, 16, 14);
        write_u16(&mut gdef, 20, 1);
        write_u16(&mut gdef, 22, 1);
        write_u16(&mut gdef, 24, glyph_id);
        write_u16(&mut gdef, 26, 1);
        write_u16(&mut gdef, 28, 4);
        write_u16(&mut gdef, 30, 2);
        write_u16(&mut gdef, 32, point_index);

        let font = replace_sfnt_table(base_font, b"GDEF", &gdef);
        let face = super::rustybuzz_face(&font, 0, &variations).unwrap();
        let glyphs = [super::ShapedGlyph {
            glyph_id: u32::from(glyph_id),
            run_index: 0,
            cluster: 0,
            x_advance: advance,
            y_advance: 0,
            x_offset: 0,
            y_offset: 0,
        }];
        let carets =
            super::positioned_run_carets(&face, "ab", TextDirection::LeftToRight, &glyphs, 0);
        assert_eq!(carets.len(), 3);
        assert_eq!(
            carets,
            vec![
                super::PositionedCaretStop {
                    byte_offset: 0,
                    x_advance: 0,
                },
                super::PositionedCaretStop {
                    byte_offset: 1,
                    x_advance: caret_x,
                },
                super::PositionedCaretStop {
                    byte_offset: 2,
                    x_advance: advance,
                },
            ]
        );
    }

    #[test]
    fn applies_active_gvar_simple_points_in_the_gdef_caret_pipeline() {
        assert_active_gvar_gdef_caret_pipeline(font_test_data::VAZIRMATN_VAR, None, false);
    }

    #[test]
    fn applies_active_gvar_xy_composite_points_in_the_gdef_caret_pipeline() {
        assert_active_gvar_gdef_caret_pipeline(font_test_data::VAZIRMATN_VAR, None, true);
    }

    #[test]
    fn applies_active_gvar_point_matched_composite_points_in_the_gdef_caret_pipeline() {
        let (font, glyph_id) = point_matched_vazirmatn_font();
        assert_active_gvar_gdef_caret_pipeline(&font, Some(glyph_id), true);
    }

    #[test]
    fn applies_gdef_composite_contour_points_in_the_public_shaped_layout() {
        let (base_font, text, baseline) = latin_ligature_fixture();
        let ligature = &baseline.glyphs[0];
        let component = shape_text(base_font, 0, "f", TextDirection::LeftToRight)
            .unwrap()
            .glyphs[0]
            .glyph_id;
        let step = i16::try_from(ligature.x_advance / 3).unwrap();
        let mut composite = vec![0_u8; 34];
        write_i16(&mut composite, 0, -1);
        for index in 0..3_usize {
            let offset = 10 + index * 8;
            write_u16(
                &mut composite,
                offset,
                if index < 2 { 0x1023 } else { 0x1003 },
            );
            write_u16(
                &mut composite,
                offset + 2,
                u16::try_from(component).unwrap(),
            );
            write_i16(
                &mut composite,
                offset + 4,
                step.checked_mul(i16::try_from(index).unwrap()).unwrap(),
            );
            write_i16(&mut composite, offset + 6, 0);
        }
        let font = replace_glyf_glyph(
            base_font,
            u16::try_from(ligature.glyph_id).unwrap(),
            &composite,
        );
        let face = super::rustybuzz_face(&font, 0, &[]).unwrap();
        let mut candidates =
            super::glyf_contour_xs(&face, u16::try_from(ligature.glyph_id).unwrap())
                .unwrap()
                .into_iter()
                .enumerate()
                .filter(|(_, x)| *x > 0 && *x < ligature.x_advance)
                .map(|(point, x)| (x, u16::try_from(point).unwrap()))
                .collect::<Vec<_>>();
        candidates.sort_unstable();
        candidates.dedup_by_key(|(x, _)| *x);
        assert!(candidates.len() >= 2);
        let (first_x, first_point) = candidates[0];
        let (second_x, second_point) = *candidates.last().unwrap();

        let mut gdef = [0_u8; 48];
        write_u32(&mut gdef, 0, 0x0001_0000);
        write_u16(&mut gdef, 8, 12);
        write_u16(&mut gdef, 12, 8);
        write_u16(&mut gdef, 14, 1);
        write_u16(&mut gdef, 16, 14);
        write_u16(&mut gdef, 20, 1);
        write_u16(&mut gdef, 22, 1);
        write_u16(&mut gdef, 24, u16::try_from(ligature.glyph_id).unwrap());
        write_u16(&mut gdef, 26, 2);
        write_u16(&mut gdef, 28, 6);
        write_u16(&mut gdef, 30, 10);
        write_u16(&mut gdef, 32, 2);
        write_u16(&mut gdef, 34, first_point);
        write_u16(&mut gdef, 36, 2);
        write_u16(&mut gdef, 38, second_point);

        let font = replace_sfnt_table(&font, b"GDEF", &gdef);
        let line = &layout_shaped_text(&font, 0, text, 100.0).unwrap().lines[0];
        assert_eq!(line.glyphs.len(), 1);
        assert_eq!(
            line.visual_carets[1].x_advance,
            first_x + line.glyphs[0].x_offset
        );
        assert_eq!(
            line.visual_carets[2].x_advance,
            second_x + line.glyphs[0].x_offset
        );
    }

    #[test]
    fn collects_cff_path_points_without_close_duplicates() {
        let mut contour = super::CffContourXs::new();
        ttf_parser::OutlineBuilder::move_to(&mut contour, 10.4, 0.0);
        ttf_parser::OutlineBuilder::line_to(&mut contour, 100.6, 0.0);
        ttf_parser::OutlineBuilder::curve_to(&mut contour, 150.2, 10.0, 200.8, 20.0, 240.0, 30.0);
        ttf_parser::OutlineBuilder::close(&mut contour);
        assert!(contour.valid);
        assert_eq!(contour.xs, vec![10, 101, 150, 201, 240]);

        ttf_parser::OutlineBuilder::quad_to(&mut contour, 1.0, 1.0, 2.0, 2.0);
        assert!(!contour.valid);
    }

    #[test]
    fn resolves_cff2_points_at_active_variation_coordinates() {
        let font = font_test_data::ift::CFF2_FONT;
        let default = super::rustybuzz_face(font, 0, &[]).unwrap();
        let bold = super::rustybuzz_face(
            font,
            0,
            &[FontVariation {
                tag: *b"wght",
                value: 900.0,
            }],
        )
        .unwrap();
        assert!(default.tables().glyf.is_none());
        assert!(default.tables().cff2.is_some());
        let varied = (0..default.number_of_glyphs()).find_map(|glyph_id| {
            let default_points = super::cff_contour_xs(&default, glyph_id)?;
            let bold_points = super::cff_contour_xs(&bold, glyph_id)?;
            (default_points != bold_points).then_some((default_points, bold_points))
        });
        assert!(
            varied.is_some(),
            "locked CFF2 variable fixture must change at least one contour"
        );
    }

    #[test]
    fn applies_gdef_cff_contour_points_in_the_public_shaped_layout() {
        let (base_font, text, baseline) = latin_ligature_fixture();
        let ligature = &baseline.glyphs[0];
        assert!(ligature.x_advance > 250);
        let glyph_id = u16::try_from(ligature.glyph_id).unwrap();
        let glyph_count = super::rustybuzz_face(base_font, 0, &[])
            .unwrap()
            .number_of_glyphs();
        let cff = cff_fixture(glyph_count, glyph_id);
        let font = replace_glyf_with_cff(base_font, &cff, glyph_count);
        let face = super::rustybuzz_face(&font, 0, &[]).unwrap();
        assert!(face.tables().glyf.is_none());
        assert!(face.tables().cff.is_some());
        assert_eq!(
            super::cff_contour_xs(&face, glyph_id),
            Some(vec![50, 150, 250, 300, 250])
        );

        let mut gdef = [0_u8; 48];
        write_u32(&mut gdef, 0, 0x0001_0000);
        write_u16(&mut gdef, 8, 12);
        write_u16(&mut gdef, 12, 8);
        write_u16(&mut gdef, 14, 1);
        write_u16(&mut gdef, 16, 14);
        write_u16(&mut gdef, 20, 1);
        write_u16(&mut gdef, 22, 1);
        write_u16(&mut gdef, 24, glyph_id);
        write_u16(&mut gdef, 26, 2);
        write_u16(&mut gdef, 28, 6);
        write_u16(&mut gdef, 30, 10);
        write_u16(&mut gdef, 32, 2);
        write_u16(&mut gdef, 34, 0); // CFF rmoveto point, x=50
        write_u16(&mut gdef, 36, 2);
        write_u16(&mut gdef, 38, 2); // first cubic control point, x=250

        let font = replace_sfnt_table(&font, b"GDEF", &gdef);
        let line = &layout_shaped_text(&font, 0, text, 100.0).unwrap().lines[0];
        assert_eq!(line.glyphs.len(), 1);
        assert_eq!(line.glyphs[0].glyph_id, u32::from(glyph_id));
        assert_eq!(
            line.visual_carets[1].x_advance,
            50 + line.glyphs[0].x_offset
        );
        assert_eq!(
            line.visual_carets[2].x_advance,
            250 + line.glyphs[0].x_offset
        );
    }

    #[test]
    fn applies_gdef_variation_index_in_the_public_shaped_layout() {
        let (base_font, text, baseline) = latin_ligature_fixture();
        let glyph = &baseline.glyphs[0];
        let first = i16::try_from(glyph.x_advance / 5).unwrap();
        let second = i16::try_from(glyph.x_advance * 3 / 5).unwrap();
        let delta = i16::try_from((glyph.x_advance / 20).max(1)).unwrap();

        // GDEF 1.3 with two format-3 carets. Both VariationIndex records point
        // to outer=0/inner=0 in an axis-free ItemVariationStore whose one delta
        // row applies in full. This isolates the GDEF resolver from fvar/gvar.
        let mut gdef = vec![0_u8; 88];
        write_u32(&mut gdef, 0, 0x0001_0003);
        write_u16(&mut gdef, 8, 18); // LigCaretList
        write_u32(&mut gdef, 14, 62); // ItemVariationStore
        write_u16(&mut gdef, 18, 8); // Coverage from LigCaretList
        write_u16(&mut gdef, 20, 1); // LigGlyph count
        write_u16(&mut gdef, 22, 14); // LigGlyph from LigCaretList
        write_u16(&mut gdef, 26, 1); // Coverage format 1
        write_u16(&mut gdef, 28, 1);
        write_u16(&mut gdef, 30, u16::try_from(glyph.glyph_id).unwrap());
        write_u16(&mut gdef, 32, 2); // caretCount
        write_u16(&mut gdef, 34, 6);
        write_u16(&mut gdef, 36, 18);
        for (caret, coordinate) in [(38, first), (50, second)] {
            write_u16(&mut gdef, caret, 3);
            write_i16(&mut gdef, caret + 2, coordinate);
            write_u16(&mut gdef, caret + 4, 6);
            write_u16(&mut gdef, caret + 6, 0); // outer index
            write_u16(&mut gdef, caret + 8, 0); // inner index
            write_u16(&mut gdef, caret + 10, 0x8000);
        }
        write_u16(&mut gdef, 62, 1); // ItemVariationStore format
        write_u32(&mut gdef, 64, 12); // VariationRegionList offset
        write_u16(&mut gdef, 68, 1); // ItemVariationData count
        write_u32(&mut gdef, 70, 16); // ItemVariationData offset
        write_u16(&mut gdef, 74, 0); // axis count
        write_u16(&mut gdef, 76, 1); // region count
        write_u16(&mut gdef, 78, 1); // item count
        write_u16(&mut gdef, 80, 1); // short delta count
        write_u16(&mut gdef, 82, 1); // region index count
        write_u16(&mut gdef, 84, 0); // region index
        write_i16(&mut gdef, 86, delta);

        let font = replace_sfnt_table(base_font, b"GDEF", &gdef);
        let line = &layout_shaped_text(&font, 0, text, 100.0).unwrap().lines[0];
        assert_eq!(
            line.visual_carets[1].x_advance,
            i32::from(first) + i32::from(delta) + line.glyphs[0].x_offset
        );
        assert_eq!(
            line.visual_carets[2].x_advance,
            i32::from(second) + i32::from(delta) + line.glyphs[0].x_offset
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
        assert_eq!(
            line.visual_carets.first().map(|caret| caret.x_advance),
            Some(0)
        );
        assert_eq!(
            line.visual_carets.last().map(|caret| caret.x_advance),
            Some(line.advance)
        );
        assert!(
            line.visual_carets
                .windows(2)
                .all(|carets| carets[0].x_advance <= carets[1].x_advance)
        );
        let logical_stops = layout
            .carets
            .iter()
            .filter(|caret| caret.line_index == 0)
            .map(|caret| caret.byte_offset)
            .collect::<std::collections::BTreeSet<_>>();
        let positioned_stops = line
            .visual_carets
            .iter()
            .map(|caret| caret.byte_offset)
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(positioned_stops, logical_stops);
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
    fn synthesizes_bold_and_italic_masks_without_changing_authored_metrics() {
        let font = font_test_data::NOTO_SERIF_DISPLAY_TRIMMED;
        let regular = rasterize_glyph_with_variations_and_style(
            font,
            0,
            &[],
            1,
            48,
            SyntheticFontStyle::default(),
        )
        .unwrap();
        let bold = rasterize_glyph_with_variations_and_style(
            font,
            0,
            &[],
            1,
            48,
            SyntheticFontStyle {
                font_weight: 700,
                italic: false,
            },
        )
        .unwrap();
        let italic = rasterize_glyph_with_variations_and_style(
            font,
            0,
            &[],
            1,
            48,
            SyntheticFontStyle {
                font_weight: 400,
                italic: true,
            },
        )
        .unwrap();
        let bold_italic = rasterize_glyph_with_variations_and_style(
            font,
            0,
            &[],
            1,
            48,
            SyntheticFontStyle {
                font_weight: 700,
                italic: true,
            },
        )
        .unwrap();

        for styled in [&bold, &italic, &bold_italic] {
            assert_eq!(styled.advance_x, regular.advance_x);
            assert_eq!(styled.ascent, regular.ascent);
            assert_eq!(
                styled.pixels.len(),
                usize::from(styled.width) * usize::from(styled.height)
            );
            assert_ne!(styled.pixels, regular.pixels);
        }
        assert!(bold.width > regular.width && bold.height > regular.height);
        assert!(italic.width > regular.width);
        assert!(bold_italic.width >= bold.width && bold_italic.height >= bold.height);
        assert_eq!(
            rasterize_glyph_with_variations_and_style(
                font,
                0,
                &[],
                1,
                48,
                SyntheticFontStyle {
                    font_weight: 0,
                    italic: false,
                },
            ),
            Err(GlyphRasterError::InvalidSyntheticStyle)
        );
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
    fn multi_run_layout_normalizes_font_sizes_before_line_breaking() {
        let font = font_test_data::NOTO_SERIF_DISPLAY_TRIMMED;
        let text = "office office";
        let boundary = "office ".len() as u32;
        let first = layout_shaped_text(font, 0, "office ", 100.0).unwrap();
        let first_width_px = first.lines[0].advance as f32 * 16.0 / first.units_per_em as f32;
        let runs = [
            TextShapingRun {
                font_bytes: font,
                face_index: 0,
                variations: &[],
                start: 0,
                end: boundary,
                font_size: 16.0,
                synthetic_style: super::SyntheticFontStyle::default(),
                letter_spacing: 0.0,
            },
            TextShapingRun {
                font_bytes: font,
                face_index: 0,
                variations: &[],
                start: boundary,
                end: text.len() as u32,
                font_size: 32.0,
                synthetic_style: super::SyntheticFontStyle::default(),
                letter_spacing: 0.0,
            },
        ];
        let layout = layout_shaped_text_runs(&runs, text, first_width_px + 1.0).unwrap();

        assert_eq!(layout.units_per_em, first.units_per_em);
        assert_eq!(layout.lines.len(), 2);
        assert_eq!((layout.lines[0].start, layout.lines[0].end), (0, boundary));
        assert_eq!(
            (layout.lines[1].start, layout.lines[1].end),
            (boundary, text.len() as u32)
        );
        assert!(layout.lines[1].advance > layout.lines[0].advance);
        assert!(
            layout.lines[0]
                .glyphs
                .iter()
                .all(|glyph| glyph.run_index == 0)
        );
        assert!(
            layout.lines[1]
                .glyphs
                .iter()
                .all(|glyph| glyph.run_index == 1)
        );
        assert_eq!(
            layout.carets.first().map(|caret| caret.byte_offset),
            Some(0)
        );
        assert_eq!(
            layout.carets.last().map(|caret| caret.byte_offset),
            Some(text.len() as u32)
        );
        assert!(layout.lines.iter().all(|line| {
            line.visual_carets
                .windows(2)
                .all(|pair| pair[0].x_advance <= pair[1].x_advance)
                && line.visual_carets.windows(2).all(|pair| pair[0] != pair[1])
                && line
                    .visual_carets
                    .first()
                    .is_some_and(|caret| caret.x_advance == 0)
                && line
                    .visual_carets
                    .last()
                    .is_some_and(|caret| caret.x_advance == line.advance)
        }));
    }

    #[test]
    fn multi_run_layout_applies_signed_tracking_to_line_fitting_and_physical_carets() {
        let font = font_test_data::NOTO_SERIF_DISPLAY_TRIMMED;
        let word = "office";
        let untracked = layout_shaped_text_runs(
            &[TextShapingRun {
                font_bytes: font,
                face_index: 0,
                variations: &[],
                start: 0,
                end: word.len() as u32,
                font_size: 16.0,
                synthetic_style: super::SyntheticFontStyle::default(),
                letter_spacing: 0.0,
            }],
            word,
            1_000.0,
        )
        .unwrap();
        let tracked = layout_shaped_text_runs(
            &[TextShapingRun {
                font_bytes: font,
                face_index: 0,
                variations: &[],
                start: 0,
                end: word.len() as u32,
                font_size: 16.0,
                synthetic_style: super::SyntheticFontStyle::default(),
                letter_spacing: 2.0,
            }],
            word,
            1_000.0,
        )
        .unwrap();
        let tracking_units = (2.0 * tracked.units_per_em as f32 / 16.0).round() as i32;
        assert_eq!(
            tracked.lines[0].advance,
            untracked.lines[0].advance + tracking_units * word.graphemes(true).count() as i32
        );
        assert_eq!(
            tracked.lines[0]
                .glyphs
                .iter()
                .map(|glyph| glyph.x_advance)
                .sum::<i32>(),
            tracked.lines[0].advance
        );
        assert_eq!(
            tracked.lines[0]
                .glyphs
                .iter()
                .map(|glyph| glyph.x_advance)
                .sum::<i32>(),
            untracked.lines[0]
                .glyphs
                .iter()
                .map(|glyph| glyph.x_advance)
                .sum::<i32>()
                + tracking_units * word.graphemes(true).count() as i32
        );
        assert_eq!(
            tracked.lines[0].visual_carets.len(),
            untracked.lines[0].visual_carets.len()
        );
        for (index, (tracked, untracked)) in tracked.lines[0]
            .visual_carets
            .iter()
            .zip(&untracked.lines[0].visual_carets)
            .enumerate()
        {
            assert_eq!(
                tracked.x_advance,
                untracked.x_advance + tracking_units * index as i32
            );
        }

        let source = "office office";
        let base = layout_shaped_text_runs(
            &[TextShapingRun {
                font_bytes: font,
                face_index: 0,
                variations: &[],
                start: 0,
                end: source.len() as u32,
                font_size: 16.0,
                synthetic_style: super::SyntheticFontStyle::default(),
                letter_spacing: 0.0,
            }],
            source,
            1_000.0,
        )
        .unwrap();
        let base_width_px = base.lines[0].advance as f32 * 16.0 / base.units_per_em as f32;
        let wrapped = layout_shaped_text_runs(
            &[TextShapingRun {
                font_bytes: font,
                face_index: 0,
                variations: &[],
                start: 0,
                end: source.len() as u32,
                font_size: 16.0,
                synthetic_style: super::SyntheticFontStyle::default(),
                letter_spacing: 2.0,
            }],
            source,
            base_width_px + 0.5,
        )
        .unwrap();
        assert_eq!(wrapped.lines.len(), 2);
        assert_eq!((wrapped.lines[0].start, wrapped.lines[0].end), (0, 7));

        let tightened = layout_shaped_text_runs(
            &[TextShapingRun {
                font_bytes: font,
                face_index: 0,
                variations: &[],
                start: 0,
                end: word.len() as u32,
                font_size: 16.0,
                synthetic_style: super::SyntheticFontStyle::default(),
                letter_spacing: -0.25,
            }],
            word,
            1_000.0,
        )
        .unwrap();
        assert!(tightened.lines[0].advance < untracked.lines[0].advance);
        assert_eq!(
            layout_shaped_text_runs(
                &[TextShapingRun {
                    font_bytes: font,
                    face_index: 0,
                    variations: &[],
                    start: 0,
                    end: word.len() as u32,
                    font_size: 16.0,
                    synthetic_style: super::SyntheticFontStyle::default(),
                    letter_spacing: -10_000.0,
                }],
                word,
                1_000.0,
            ),
            Err(TextShapingError::InvalidStyleRun)
        );
    }

    #[test]
    fn multi_run_layout_keeps_bidi_visual_order_across_style_boundaries() {
        let font = font_test_data::NOTO_SERIF_DISPLAY_TRIMMED;
        let text = "AאבB";
        let runs = [
            TextShapingRun {
                font_bytes: font,
                face_index: 0,
                variations: &[],
                start: 0,
                end: 1,
                font_size: 16.0,
                synthetic_style: super::SyntheticFontStyle::default(),
                letter_spacing: 0.0,
            },
            TextShapingRun {
                font_bytes: font,
                face_index: 0,
                variations: &[],
                start: 1,
                end: 5,
                font_size: 24.0,
                synthetic_style: super::SyntheticFontStyle::default(),
                letter_spacing: 0.0,
            },
            TextShapingRun {
                font_bytes: font,
                face_index: 0,
                variations: &[],
                start: 5,
                end: 6,
                font_size: 16.0,
                synthetic_style: super::SyntheticFontStyle::default(),
                letter_spacing: 0.0,
            },
        ];
        let layout = layout_shaped_text_runs(&runs, text, 1_000.0).unwrap();
        let line = &layout.lines[0];

        assert_eq!(line.visual_runs.len(), 3);
        assert_eq!(line.visual_runs[1].direction, TextDirection::RightToLeft);
        assert_eq!(
            line.glyphs
                .iter()
                .map(|glyph| glyph.run_index)
                .collect::<std::collections::BTreeSet<_>>(),
            [0, 1, 2].into_iter().collect()
        );
        assert!(
            line.visual_carets
                .windows(2)
                .all(|pair| pair[0].x_advance <= pair[1].x_advance)
        );
        let stops = line
            .visual_carets
            .iter()
            .map(|caret| caret.byte_offset)
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(stops, [0, 1, 3, 5, 6].into_iter().collect());
    }

    #[test]
    fn rtl_layout_emits_a_left_to_right_physical_glyph_stream() {
        let text = "בדכה";
        let runs = [TextShapingRun {
            font_bytes: font_test_data::NOTOSERIFHEBREW_AUTOHINT_METRICS,
            face_index: 0,
            variations: &[],
            start: 0,
            end: text.len() as u32,
            font_size: 48.0,
            synthetic_style: super::SyntheticFontStyle::default(),
            letter_spacing: 1.0,
        }];
        let layout = layout_shaped_text_runs(&runs, text, 1_000.0).unwrap();
        let line = &layout.lines[0];

        assert_eq!(line.direction, TextDirection::RightToLeft);
        assert!(line.glyphs.iter().all(|glyph| glyph.glyph_id != 0));
        assert!(
            line.glyphs
                .windows(2)
                .all(|pair| pair[0].cluster >= pair[1].cluster),
            "RTL clusters must descend while the glyph pen advances physically left to right"
        );
        assert!(line.glyphs.iter().all(|glyph| glyph.x_advance >= 0));
        assert_eq!(
            line.glyphs.iter().map(|glyph| glyph.x_advance).sum::<i32>(),
            line.advance
        );
        assert!(
            line.visual_carets
                .windows(2)
                .all(|pair| pair[0].x_advance <= pair[1].x_advance)
        );
        assert_eq!(
            line.visual_carets
                .iter()
                .map(|caret| caret.byte_offset)
                .collect::<Vec<_>>(),
            vec![text.len() as u32, 6, 4, 2, 0]
        );
    }

    #[test]
    fn multi_run_layout_rejects_gaps_and_non_scalar_boundaries() {
        let font = font_test_data::NOTO_SERIF_DISPLAY_TRIMMED;
        let text = "A😀B";
        let gap = [
            TextShapingRun {
                font_bytes: font,
                face_index: 0,
                variations: &[],
                start: 0,
                end: 1,
                font_size: 16.0,
                synthetic_style: super::SyntheticFontStyle::default(),
                letter_spacing: 0.0,
            },
            TextShapingRun {
                font_bytes: font,
                face_index: 0,
                variations: &[],
                start: 5,
                end: 6,
                font_size: 16.0,
                synthetic_style: super::SyntheticFontStyle::default(),
                letter_spacing: 0.0,
            },
        ];
        let split_scalar = [TextShapingRun {
            font_bytes: font,
            face_index: 0,
            variations: &[],
            start: 0,
            end: 2,
            font_size: 16.0,
            synthetic_style: super::SyntheticFontStyle::default(),
            letter_spacing: 0.0,
        }];
        assert_eq!(
            layout_shaped_text_runs(&gap, text, 100.0),
            Err(super::TextShapingError::InvalidStyleRun)
        );
        assert_eq!(
            layout_shaped_text_runs(&split_scalar, text, 100.0),
            Err(super::TextShapingError::InvalidStyleRun)
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
            font_weight: 400,
            italic: false,
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
