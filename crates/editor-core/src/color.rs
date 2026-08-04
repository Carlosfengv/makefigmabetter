//! Explicit document color values. Components are always stored non-premultiplied;
//! premultiplication happens only at the renderer upload boundary.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorSpace {
    Srgb,
    DisplayP3,
    LinearSrgb,
}

/// The document-wide default profile for values that do not carry a more specific
/// asset profile. Individual Canonical `Color` values retain their own space.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentColorProfile {
    Srgb,
    DisplayP3,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Color {
    pub space: ColorSpace,
    pub components: [f32; 3],
    pub alpha: f32,
}

pub const MAX_GRADIENT_STOPS: usize = 16;

/// Canonical fill paint. CSS strings exist only at projection boundaries.
#[derive(Debug, Clone, PartialEq)]
pub enum Paint {
    Solid(Color),
    LinearGradient(LinearGradient),
}

#[derive(Debug, Clone, PartialEq)]
pub struct LinearGradient {
    /// Normalized coordinates in the node-local bounding box.
    pub start: [f32; 2],
    pub end: [f32; 2],
    pub stops: Vec<GradientStop>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GradientStop {
    pub position: f32,
    pub color: Color,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorError {
    InvalidComponent,
    InvalidInterpolation,
    InvalidCssColor,
    InvalidGradient,
}

impl Color {
    pub fn new(space: ColorSpace, components: [f32; 3], alpha: f32) -> Result<Self, ColorError> {
        if components.iter().any(|component| !component.is_finite() || !(0.0..=1.0).contains(component)) || !alpha.is_finite() || !(0.0..=1.0).contains(&alpha) {
            return Err(ColorError::InvalidComponent);
        }
        Ok(Self { space, components, alpha })
    }

    pub fn from_srgb_u8(rgb: [u8; 3], alpha: u8) -> Self {
        Self { space: ColorSpace::Srgb, components: rgb.map(|component| component as f32 / 255.0), alpha: alpha as f32 / 255.0 }
    }

    /// Parses the deliberately narrow legacy CSS bridge syntax used by the Canvas
    /// projection. The Canonical document itself never stores this string form.
    pub fn parse_css_hex(value: &str) -> Result<Self, ColorError> {
        let hex = value.strip_prefix('#').ok_or(ColorError::InvalidCssColor)?;
        if !hex.is_ascii() {
            return Err(ColorError::InvalidCssColor);
        }
        let expand = |value: u8| value * 17;
        let byte = |range: std::ops::Range<usize>| {
            u8::from_str_radix(&hex[range], 16).map_err(|_| ColorError::InvalidCssColor)
        };
        let rgba = match hex.len() {
            3 => [expand(byte(0..1)?), expand(byte(1..2)?), expand(byte(2..3)?), 255],
            4 => [expand(byte(0..1)?), expand(byte(1..2)?), expand(byte(2..3)?), expand(byte(3..4)?)],
            6 => [byte(0..2)?, byte(2..4)?, byte(4..6)?, 255],
            8 => [byte(0..2)?, byte(2..4)?, byte(4..6)?, byte(6..8)?],
            _ => return Err(ColorError::InvalidCssColor),
        };
        Ok(Self::from_srgb_u8([rgba[0], rgba[1], rgba[2]], rgba[3]))
    }

    /// Canvas/CSS is only a display bridge, so wide-gamut values are explicitly
    /// converted to deterministic sRGB before formatting.
    pub fn to_css_srgb_hex(self) -> String {
        let [red, green, blue, alpha] = self.to_srgb_u8();
        if alpha == 255 {
            format!("#{red:02x}{green:02x}{blue:02x}")
        } else {
            format!("#{red:02x}{green:02x}{blue:02x}{alpha:02x}")
        }
    }

    pub fn is_valid(self) -> bool {
        self.components.iter().all(|component| component.is_finite() && (0.0..=1.0).contains(component))
            && self.alpha.is_finite()
            && (0.0..=1.0).contains(&self.alpha)
    }

    pub fn to_srgb_u8(self) -> [u8; 4] {
        let encoded = self.to_srgb().components;
        [quantize(encoded[0]), quantize(encoded[1]), quantize(encoded[2]), quantize(self.alpha)]
    }

    /// Converts into a non-premultiplied encoded sRGB document color. Display P3
    /// values are transformed in linear light and clipped only at the destination gamut.
    pub fn to_srgb(self) -> Self {
        let linear = self.to_linear_srgb_components();
        Self { space: ColorSpace::Srgb, components: linear.map(encode_srgb), alpha: self.alpha }
    }

    pub fn to_linear_srgb(self) -> Self {
        Self { space: ColorSpace::LinearSrgb, components: self.to_linear_srgb_components(), alpha: self.alpha }
    }

    /// The GPU-facing form: linear sRGB and premultiplied alpha, derived without
    /// changing the persisted non-premultiplied document value.
    pub fn to_render_rgba(self) -> [f32; 4] {
        let linear = self.to_linear_srgb_components();
        [linear[0] * self.alpha, linear[1] * self.alpha, linear[2] * self.alpha, self.alpha]
    }

    /// Gradient interpolation is frozen to linear sRGB for this Phase 0 spike.
    pub fn interpolate_linear_srgb(self, other: Self, amount: f32) -> Result<Self, ColorError> {
        if !amount.is_finite() || !(0.0..=1.0).contains(&amount) {
            return Err(ColorError::InvalidInterpolation);
        }
        let left = self.to_linear_srgb_components();
        let right = other.to_linear_srgb_components();
        Self::new(
            ColorSpace::LinearSrgb,
            [
                left[0] + (right[0] - left[0]) * amount,
                left[1] + (right[1] - left[1]) * amount,
                left[2] + (right[2] - left[2]) * amount,
            ],
            self.alpha + (other.alpha - self.alpha) * amount,
        )
    }

    fn to_linear_srgb_components(self) -> [f32; 3] {
        match self.space {
            ColorSpace::Srgb => self.components.map(decode_srgb),
            ColorSpace::LinearSrgb => self.components,
            ColorSpace::DisplayP3 => {
                let p3 = self.components.map(decode_srgb);
                // Display P3 (D65) linear RGB -> linear sRGB, IEC 61966-2-1.
                [
                    clamp(1.224_745_5 * p3[0] - 0.224_904_45 * p3[1]),
                    clamp(-0.042_058_08 * p3[0] + 1.042_081 * p3[1]),
                    clamp(-0.019_642_26 * p3[0] - 0.078_654_88 * p3[1] + 1.098_537_2 * p3[2]),
                ]
            }
        }
    }
}

impl Paint {
    pub fn is_valid(&self) -> bool {
        match self {
            Self::Solid(color) => color.is_valid(),
            Self::LinearGradient(gradient) => gradient.is_valid(),
        }
    }

    /// Deterministic legacy CSS fallback. Gradient-aware projections use the full
    /// gradient payload instead of this representative first stop.
    pub fn to_css_srgb_hex(&self) -> String {
        match self {
            Self::Solid(color) => color.to_css_srgb_hex(),
            Self::LinearGradient(gradient) => gradient.stops[0].color.to_css_srgb_hex(),
        }
    }

    pub fn estimated_bytes(&self) -> usize {
        match self {
            Self::Solid(_) => std::mem::size_of::<Color>(),
            Self::LinearGradient(gradient) => {
                std::mem::size_of::<LinearGradient>()
                    + gradient.stops.len() * std::mem::size_of::<GradientStop>()
            }
        }
    }
}

impl LinearGradient {
    pub fn new(start: [f32; 2], end: [f32; 2], stops: Vec<GradientStop>) -> Result<Self, ColorError> {
        let gradient = Self { start, end, stops };
        if gradient.is_valid() { Ok(gradient) } else { Err(ColorError::InvalidGradient) }
    }

    pub fn is_valid(&self) -> bool {
        self.start.iter().chain(self.end.iter()).all(|value| value.is_finite())
            && self.start != self.end
            && (2..=MAX_GRADIENT_STOPS).contains(&self.stops.len())
            && self.stops.iter().all(|stop| {
                stop.position.is_finite()
                    && (0.0..=1.0).contains(&stop.position)
                    && stop.color.is_valid()
            })
            && self.stops.windows(2).all(|pair| pair[0].position <= pair[1].position)
    }
}

impl From<&str> for Color {
    fn from(value: &str) -> Self {
        Self::parse_css_hex(value).unwrap_or(Self {
            space: ColorSpace::Srgb,
            components: [f32::NAN, 0.0, 0.0],
            alpha: 1.0,
        })
    }
}

impl From<String> for Color {
    fn from(value: String) -> Self {
        value.as_str().into()
    }
}

impl From<&str> for Paint {
    fn from(value: &str) -> Self {
        Self::Solid(value.into())
    }
}

impl From<String> for Paint {
    fn from(value: String) -> Self {
        value.as_str().into()
    }
}

fn decode_srgb(value: f32) -> f32 {
    if value <= 0.04045 { value / 12.92 } else { ((value + 0.055) / 1.055).powf(2.4) }
}

fn encode_srgb(value: f32) -> f32 {
    let value = clamp(value);
    if value <= 0.003_130_8 { value * 12.92 } else { 1.055 * value.powf(1.0 / 2.4) - 0.055 }
}

fn clamp(value: f32) -> f32 { value.clamp(0.0, 1.0) }
fn quantize(value: f32) -> u8 { (clamp(value) * 255.0).round() as u8 }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_srgb_bytes_and_alpha_non_premultiplied_in_document_storage() {
        let color = Color::from_srgb_u8([255, 128, 0], 64);
        assert_eq!(color.to_srgb_u8(), [255, 128, 0, 64]);
        let gpu_rgba = color.to_render_rgba();
        assert!((gpu_rgba[0] - color.alpha).abs() < 0.000_001);
        assert!((gpu_rgba[1] - 0.054_176_763).abs() < 0.000_001);
        assert_eq!(gpu_rgba[2], 0.0);
        assert!((gpu_rgba[3] - color.alpha).abs() < 0.000_001);
        assert_eq!(color.components, [1.0, 128.0 / 255.0, 0.0]);
    }

    #[test]
    fn display_p3_has_a_deterministic_clipped_srgb_fallback() {
        let p3 = Color::new(ColorSpace::DisplayP3, [0.2, 0.8, 0.4], 1.0).unwrap();
        let converted = p3.to_srgb();
        assert_eq!(converted.space, ColorSpace::Srgb);
        assert!(converted.components.iter().all(|value| value.is_finite() && (0.0..=1.0).contains(value)));
        assert_eq!(converted.to_srgb_u8(), p3.to_srgb_u8());
    }

    #[test]
    fn gradients_interpolate_in_linear_light_not_encoded_srgb() {
        let black = Color::from_srgb_u8([0, 0, 0], 255);
        let white = Color::from_srgb_u8([255, 255, 255], 255);
        let midpoint = black.interpolate_linear_srgb(white, 0.5).unwrap().to_srgb_u8();
        assert_eq!(midpoint, [188, 188, 188, 255]);
    }

    #[test]
    fn rejects_nan_out_of_gamut_and_invalid_interpolation() {
        assert_eq!(Color::new(ColorSpace::Srgb, [f32::NAN, 0.0, 0.0], 1.0), Err(ColorError::InvalidComponent));
        assert_eq!(Color::new(ColorSpace::Srgb, [0.0, 0.0, 0.0], 1.1), Err(ColorError::InvalidComponent));
        assert_eq!(Color::from_srgb_u8([0, 0, 0], 255).interpolate_linear_srgb(Color::from_srgb_u8([255, 255, 255], 255), 1.1), Err(ColorError::InvalidInterpolation));
    }

    #[test]
    fn parses_legacy_css_only_at_the_projection_boundary() {
        assert_eq!(Color::parse_css_hex("#f80").unwrap().to_srgb_u8(), [255, 136, 0, 255]);
        assert_eq!(Color::parse_css_hex("#11223380").unwrap().to_srgb_u8(), [17, 34, 51, 128]);
        assert_eq!(Color::parse_css_hex("rgb(1, 2, 3)"), Err(ColorError::InvalidCssColor));
        assert_eq!(Color::parse_css_hex("#éab"), Err(ColorError::InvalidCssColor));
        assert_eq!(Color::from_srgb_u8([17, 34, 51], 128).to_css_srgb_hex(), "#11223380");
    }
}
