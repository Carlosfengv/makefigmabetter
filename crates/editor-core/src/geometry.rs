//! Deterministic f64 geometry primitives for document validation and hit testing.
//!
//! This module intentionally has no renderer dependency. Coordinates are finite `f64`,
//! `-0.0` is normalized at construction boundaries, and each operation uses a tolerance
//! appropriate to its own question rather than a shared global epsilon.

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bounds {
    pub min: Point,
    pub max: Point,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AffineTransform {
    /// Canvas-style 2×3 matrix: x' = ax + cy + e; y' = bx + dy + f.
    pub a: f64,
    pub b: f64,
    pub c: f64,
    pub d: f64,
    pub e: f64,
    pub f: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Bezier {
    Line {
        from: Point,
        to: Point,
    },
    Quadratic {
        from: Point,
        control: Point,
        to: Point,
    },
    Cubic {
        from: Point,
        control1: Point,
        control2: Point,
        to: Point,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FillRule {
    EvenOdd,
    NonZero,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GeometryError {
    NonFinite,
    InvalidBounds,
    SingularTransform,
    InvalidTolerance,
}

impl Point {
    pub fn new(x: f64, y: f64) -> Result<Self, GeometryError> {
        if !x.is_finite() || !y.is_finite() {
            return Err(GeometryError::NonFinite);
        }
        Ok(Self {
            x: normalize_zero(x),
            y: normalize_zero(y),
        })
    }

    pub fn distance(self, other: Self) -> f64 {
        (self.x - other.x).hypot(self.y - other.y)
    }
}

impl Bounds {
    pub fn new(min: Point, max: Point) -> Result<Self, GeometryError> {
        if min.x > max.x || min.y > max.y {
            return Err(GeometryError::InvalidBounds);
        }
        Ok(Self { min, max })
    }

    pub fn from_points(points: &[Point]) -> Option<Self> {
        let first = *points.first()?;
        let (mut min_x, mut min_y, mut max_x, mut max_y) = (first.x, first.y, first.x, first.y);
        for point in &points[1..] {
            min_x = min_x.min(point.x);
            min_y = min_y.min(point.y);
            max_x = max_x.max(point.x);
            max_y = max_y.max(point.y);
        }
        Self::new(Point { x: min_x, y: min_y }, Point { x: max_x, y: max_y }).ok()
    }

    pub fn contains(self, point: Point) -> bool {
        point.x >= self.min.x
            && point.x <= self.max.x
            && point.y >= self.min.y
            && point.y <= self.max.y
    }

    pub fn union(self, other: Self) -> Self {
        Self {
            min: Point {
                x: self.min.x.min(other.min.x),
                y: self.min.y.min(other.min.y),
            },
            max: Point {
                x: self.max.x.max(other.max.x),
                y: self.max.y.max(other.max.y),
            },
        }
    }

    pub fn intersection(self, other: Self) -> Option<Self> {
        Self::new(
            Point {
                x: self.min.x.max(other.min.x),
                y: self.min.y.max(other.min.y),
            },
            Point {
                x: self.max.x.min(other.max.x),
                y: self.max.y.min(other.max.y),
            },
        )
        .ok()
    }

    /// Axis-aligned rectangle subtraction, returned as non-overlapping strips.
    /// It is the deterministic Phase 0 boolean baseline; arbitrary-path booleans
    /// remain a later backend choice.
    pub fn subtract(self, cut: Self) -> Vec<Self> {
        let Some(overlap) = self.intersection(cut) else {
            return vec![self];
        };
        let mut fragments = Vec::with_capacity(4);
        let mut push = |min: Point, max: Point| {
            if min.x < max.x && min.y < max.y {
                fragments.push(Self { min, max });
            }
        };
        push(
            self.min,
            Point {
                x: self.max.x,
                y: overlap.min.y,
            },
        );
        push(
            Point {
                x: self.min.x,
                y: overlap.max.y,
            },
            self.max,
        );
        push(
            Point {
                x: self.min.x,
                y: overlap.min.y,
            },
            Point {
                x: overlap.min.x,
                y: overlap.max.y,
            },
        );
        push(
            Point {
                x: overlap.max.x,
                y: overlap.min.y,
            },
            Point {
                x: self.max.x,
                y: overlap.max.y,
            },
        );
        fragments
    }
}

impl AffineTransform {
    pub const IDENTITY: Self = Self {
        a: 1.0,
        b: 0.0,
        c: 0.0,
        d: 1.0,
        e: 0.0,
        f: 0.0,
    };

    pub fn translation(x: f64, y: f64) -> Result<Self, GeometryError> {
        let point = Point::new(x, y)?;
        Ok(Self {
            e: point.x,
            f: point.y,
            ..Self::IDENTITY
        })
    }

    pub fn scale(x: f64, y: f64) -> Result<Self, GeometryError> {
        if !x.is_finite() || !y.is_finite() {
            return Err(GeometryError::NonFinite);
        }
        Ok(Self {
            a: normalize_zero(x),
            d: normalize_zero(y),
            ..Self::IDENTITY
        })
    }

    pub fn rotation(radians: f64) -> Result<Self, GeometryError> {
        if !radians.is_finite() {
            return Err(GeometryError::NonFinite);
        }
        let (sin, cos) = radians.sin_cos();
        Ok(Self {
            a: normalize_zero(cos),
            b: normalize_zero(sin),
            c: normalize_zero(-sin),
            d: normalize_zero(cos),
            e: 0.0,
            f: 0.0,
        })
    }

    /// `self.then(next)` applies `self` first and `next` second.
    pub fn then(self, next: Self) -> Self {
        Self {
            a: next.a * self.a + next.c * self.b,
            b: next.b * self.a + next.d * self.b,
            c: next.a * self.c + next.c * self.d,
            d: next.b * self.c + next.d * self.d,
            e: next.a * self.e + next.c * self.f + next.e,
            f: next.b * self.e + next.d * self.f + next.f,
        }
    }

    pub fn transform_point(self, point: Point) -> Point {
        Point {
            x: normalize_zero(self.a * point.x + self.c * point.y + self.e),
            y: normalize_zero(self.b * point.x + self.d * point.y + self.f),
        }
    }

    pub fn inverse(self) -> Result<Self, GeometryError> {
        let determinant = self.a * self.d - self.b * self.c;
        if !determinant.is_finite() || determinant.abs() <= 1e-12 {
            return Err(GeometryError::SingularTransform);
        }
        Ok(Self {
            a: self.d / determinant,
            b: -self.b / determinant,
            c: -self.c / determinant,
            d: self.a / determinant,
            e: (self.c * self.f - self.d * self.e) / determinant,
            f: (self.b * self.e - self.a * self.f) / determinant,
        })
    }
}

impl Bezier {
    pub fn evaluate(self, amount: f64) -> Result<Point, GeometryError> {
        if !amount.is_finite() {
            return Err(GeometryError::NonFinite);
        }
        let t = amount.clamp(0.0, 1.0);
        let point = match self {
            Self::Line { from, to } => lerp_point(from, to, t),
            Self::Quadratic { from, control, to } => {
                lerp_point(lerp_point(from, control, t), lerp_point(control, to, t), t)
            }
            Self::Cubic {
                from,
                control1,
                control2,
                to,
            } => {
                let first = lerp_point(
                    lerp_point(from, control1, t),
                    lerp_point(control1, control2, t),
                    t,
                );
                let second = lerp_point(
                    lerp_point(control1, control2, t),
                    lerp_point(control2, to, t),
                    t,
                );
                lerp_point(first, second, t)
            }
        };
        Ok(point)
    }

    /// Returns points from start through end. Flatness is measured as the control
    /// polygon's perpendicular deviation from its chord and bounds recursion.
    pub fn flatten(self, tolerance: f64) -> Result<Vec<Point>, GeometryError> {
        if !tolerance.is_finite() || tolerance <= 0.0 {
            return Err(GeometryError::InvalidTolerance);
        }
        let mut points = Vec::new();
        flatten(self, tolerance, 0, &mut points);
        Ok(points)
    }

    pub fn bounds(self, tolerance: f64) -> Result<Bounds, GeometryError> {
        let points = self.flatten(tolerance)?;
        Bounds::from_points(&points).ok_or(GeometryError::InvalidBounds)
    }
}

pub fn point_in_polygon(point: Point, polygon: &[Point], rule: FillRule) -> bool {
    if polygon.len() < 3 {
        return false;
    }
    let mut winding = 0_i32;
    for (left, right) in polygon
        .iter()
        .copied()
        .zip(polygon.iter().copied().cycle().skip(1))
        .take(polygon.len())
    {
        if point_on_segment(point, left, right, 1e-9) {
            return true;
        }
        if left.y <= point.y {
            if right.y > point.y && cross(left, right, point) > 0.0 {
                winding += 1;
            }
        } else if right.y <= point.y && cross(left, right, point) < 0.0 {
            winding -= 1;
        }
    }
    match rule {
        FillRule::EvenOdd => winding.rem_euclid(2) == 1,
        FillRule::NonZero => winding != 0,
    }
}

pub fn stroke_hits_polyline(
    point: Point,
    points: &[Point],
    width: f64,
    closed: bool,
) -> Result<bool, GeometryError> {
    if !width.is_finite() || width < 0.0 {
        return Err(GeometryError::InvalidTolerance);
    }
    if points.is_empty() {
        return Ok(false);
    }
    if points.len() == 1 {
        return Ok(point.distance(points[0]) <= width / 2.0);
    }
    let threshold = width / 2.0;
    let pairs = points.windows(2).map(|pair| (pair[0], pair[1]));
    if pairs
        .clone()
        .any(|(from, to)| distance_to_segment(point, from, to) <= threshold)
    {
        return Ok(true);
    }
    Ok(closed && distance_to_segment(point, *points.last().unwrap(), points[0]) <= threshold)
}

fn flatten(curve: Bezier, tolerance: f64, depth: u8, output: &mut Vec<Point>) {
    let (from, to, deviation) = match curve {
        Bezier::Line { from, to } => (from, to, 0.0),
        Bezier::Quadratic { from, control, to } => (from, to, distance_to_line(control, from, to)),
        Bezier::Cubic {
            from,
            control1,
            control2,
            to,
        } => (
            from,
            to,
            distance_to_line(control1, from, to).max(distance_to_line(control2, from, to)),
        ),
    };
    if depth >= 24 || deviation <= tolerance {
        if output.last().copied() != Some(from) {
            output.push(from);
        }
        output.push(to);
        return;
    }
    let (left, right) = split(curve);
    flatten(left, tolerance, depth + 1, output);
    flatten(right, tolerance, depth + 1, output);
}

fn split(curve: Bezier) -> (Bezier, Bezier) {
    match curve {
        Bezier::Line { from, to } => {
            let middle = lerp_point(from, to, 0.5);
            (
                Bezier::Line { from, to: middle },
                Bezier::Line { from: middle, to },
            )
        }
        Bezier::Quadratic { from, control, to } => {
            let first = lerp_point(from, control, 0.5);
            let second = lerp_point(control, to, 0.5);
            let middle = lerp_point(first, second, 0.5);
            (
                Bezier::Quadratic {
                    from,
                    control: first,
                    to: middle,
                },
                Bezier::Quadratic {
                    from: middle,
                    control: second,
                    to,
                },
            )
        }
        Bezier::Cubic {
            from,
            control1,
            control2,
            to,
        } => {
            let first = lerp_point(from, control1, 0.5);
            let second = lerp_point(control1, control2, 0.5);
            let third = lerp_point(control2, to, 0.5);
            let fourth = lerp_point(first, second, 0.5);
            let fifth = lerp_point(second, third, 0.5);
            let middle = lerp_point(fourth, fifth, 0.5);
            (
                Bezier::Cubic {
                    from,
                    control1: first,
                    control2: fourth,
                    to: middle,
                },
                Bezier::Cubic {
                    from: middle,
                    control1: fifth,
                    control2: third,
                    to,
                },
            )
        }
    }
}

fn distance_to_line(point: Point, from: Point, to: Point) -> f64 {
    let length = from.distance(to);
    if length <= 1e-12 {
        return point.distance(from);
    }
    cross(from, to, point).abs() / length
}

fn distance_to_segment(point: Point, from: Point, to: Point) -> f64 {
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    let length_squared = dx * dx + dy * dy;
    if length_squared <= 1e-24 {
        return point.distance(from);
    }
    let amount =
        (((point.x - from.x) * dx + (point.y - from.y) * dy) / length_squared).clamp(0.0, 1.0);
    point.distance(Point {
        x: from.x + dx * amount,
        y: from.y + dy * amount,
    })
}

fn point_on_segment(point: Point, from: Point, to: Point, tolerance: f64) -> bool {
    distance_to_segment(point, from, to) <= tolerance
}
fn cross(from: Point, to: Point, point: Point) -> f64 {
    (to.x - from.x) * (point.y - from.y) - (to.y - from.y) * (point.x - from.x)
}
fn lerp_point(from: Point, to: Point, amount: f64) -> Point {
    Point {
        x: normalize_zero(from.x + (to.x - from.x) * amount),
        y: normalize_zero(from.y + (to.y - from.y) * amount),
    }
}
fn normalize_zero(value: f64) -> f64 {
    if value == 0.0 { 0.0 } else { value }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(x: f64, y: f64) -> Point {
        Point::new(x, y).unwrap()
    }

    fn assert_point_near(actual: Point, expected: Point) {
        assert!(
            (actual.x - expected.x).abs() < 1e-12,
            "x: {actual:?} != {expected:?}"
        );
        assert!(
            (actual.y - expected.y).abs() < 1e-12,
            "y: {actual:?} != {expected:?}"
        );
    }

    #[test]
    fn affine_transform_round_trips_rotation_translation_and_normalizes_negative_zero() {
        let transform = AffineTransform::rotation(std::f64::consts::FRAC_PI_2)
            .unwrap()
            .then(AffineTransform::translation(10.0, -2.0).unwrap());
        let transformed = transform.transform_point(p(3.0, 4.0));
        assert_point_near(transformed, p(6.0, 1.0));
        assert_point_near(
            transform.inverse().unwrap().transform_point(transformed),
            p(3.0, 4.0),
        );
        assert_eq!(
            Point::new(-0.0, 0.0).unwrap().x.to_bits(),
            0.0_f64.to_bits()
        );
    }

    #[test]
    fn rejects_non_finite_and_singular_geometry() {
        assert_eq!(Point::new(f64::NAN, 0.0), Err(GeometryError::NonFinite));
        assert_eq!(
            AffineTransform::scale(0.0, 1.0).unwrap().inverse(),
            Err(GeometryError::SingularTransform)
        );
        assert_eq!(
            Bezier::Line {
                from: p(0.0, 0.0),
                to: p(1.0, 1.0)
            }
            .flatten(0.0),
            Err(GeometryError::InvalidTolerance)
        );
    }

    #[test]
    fn cubic_flattening_retains_endpoints_and_stable_bounds() {
        let curve = Bezier::Cubic {
            from: p(0.0, 0.0),
            control1: p(0.0, 100.0),
            control2: p(100.0, 100.0),
            to: p(100.0, 0.0),
        };
        let flattened = curve.flatten(0.25).unwrap();
        assert_eq!(flattened.first(), Some(&p(0.0, 0.0)));
        assert_eq!(flattened.last(), Some(&p(100.0, 0.0)));
        let bounds = curve.bounds(0.25).unwrap();
        assert!(bounds.min.y >= 0.0 && bounds.max.y > 74.0 && bounds.max.y < 76.0);
    }

    #[test]
    fn fill_and_stroke_hit_tests_cover_edges_degenerate_segments_and_winding() {
        let square = [p(0.0, 0.0), p(10.0, 0.0), p(10.0, 10.0), p(0.0, 10.0)];
        assert!(point_in_polygon(p(5.0, 5.0), &square, FillRule::EvenOdd));
        assert!(point_in_polygon(p(0.0, 6.0), &square, FillRule::NonZero));
        assert!(!point_in_polygon(p(12.0, 5.0), &square, FillRule::NonZero));
        assert!(
            stroke_hits_polyline(p(5.0, 1.0), &[p(0.0, 0.0), p(10.0, 0.0)], 2.0, false).unwrap()
        );
        assert!(
            stroke_hits_polyline(p(0.5, 0.0), &[p(0.0, 0.0), p(0.0, 0.0)], 2.0, false).unwrap()
        );
    }

    #[test]
    fn axis_aligned_boolean_baseline_is_non_overlapping_and_deterministic() {
        let source = Bounds::new(p(0.0, 0.0), p(10.0, 10.0)).unwrap();
        let cut = Bounds::new(p(3.0, 2.0), p(7.0, 8.0)).unwrap();
        assert_eq!(source.intersection(cut).unwrap(), cut);
        assert_eq!(source.union(cut), source);
        let fragments = source.subtract(cut);
        assert_eq!(fragments.len(), 4);
        assert_eq!(
            fragments
                .iter()
                .map(|bounds| (bounds.max.x - bounds.min.x) * (bounds.max.y - bounds.min.y))
                .sum::<f64>(),
            76.0
        );
    }
}
