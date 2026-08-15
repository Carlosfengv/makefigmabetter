//! Deterministic f64 geometry primitives for document validation and hit testing.
//!
//! This module intentionally has no renderer dependency. Coordinates are finite `f64`,
//! `-0.0` is normalized at construction boundaries, and each operation uses a tolerance
//! appropriate to its own question rather than a shared global epsilon.

use crate::{BooleanOperation, FillRule as VectorFillRule, ParametricShape, VectorPath};
use clipper2_rust::{
    difference_d, intersect_d, union_subjects_d, xor_d, FillRule as ClipperFillRule,
    PathD as ClipperPath, PathsD as ClipperPaths, Point as ClipperPoint,
};

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
    ResourceLimit,
}

/// Stroke caps are geometric rather than paint metadata. Keeping this compact
/// type in `geometry` lets render, hit-test and export callers ask for exactly
/// the same outline without depending on a UI or protocol enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StrokeCapStyle {
    Butt,
    Round,
    Square,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StrokeJoinStyle {
    Miter,
    Bevel,
    Round,
}

/// Decorative endpoint caps for open Line nodes. Unlike [`StrokeCapStyle`],
/// these are markers whose geometry is independent of the stroke path — an
/// arrowhead, diamond or dot placed at a Line endpoint. Emitting them from this
/// module lets Canvas rendering, hit testing and SVG export share one outline
/// rather than each re-deriving the same arrowhead in its own coordinate math.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecorativeCapStyle {
    /// Two open strokes forming an unfilled `>` arrowhead.
    ArrowLines,
    /// Filled arrowhead whose base half-width is `size·√3/4` (equilateral).
    ArrowEquilateral,
    /// Filled arrowhead whose base half-width is `size·0.42` (slimmer).
    TriangleFilled,
    /// Filled diamond centred on the endpoint's outward axis.
    DiamondFilled,
    /// Filled dot of radius `size/2` centred on the endpoint.
    CircleFilled,
}

/// Alignment for an independently weighted rectangular edge. This belongs to
/// geometry rather than a renderer so every presentation target can share the
/// exact same centre-line placement before it tessellates each edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PerSideStrokeAlign {
    Inside,
    Center,
    Outside,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StrokeStyle {
    pub width: f64,
    pub cap: StrokeCapStyle,
    pub join: StrokeJoinStyle,
    pub miter_limit: f64,
}

/// A deterministic triangle-only representation of a stroked polyline.
/// Triangle overlap is intentional: it makes round joins and caps the exact
/// union of simple convex pieces, and allows callers to submit it directly to
/// a tessellator/GPU or use it for a precise inclusion test.
#[derive(Debug, Clone, PartialEq)]
pub struct StrokeMesh {
    pub triangles: Vec<[Point; 3]>,
    pub bounds: Option<Bounds>,
}

/// A VectorPath after deterministic cubic flattening in its local coordinate
/// space. The path model remains canonical; this is deliberately derived and
/// never persisted in a document snapshot.
#[derive(Debug, Clone, PartialEq)]
pub struct FlattenedVectorPath {
    pub subpaths: Vec<FlattenedVectorSubpath>,
    pub bounds: Option<Bounds>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FlattenedVectorSubpath {
    pub closed: bool,
    pub points: Vec<Point>,
}

/// One editable VectorPath segment nearest to a local-space pointer. The
/// parameter belongs to the original cubic, so callers can hand it directly
/// to `SplitVectorSegment` instead of deriving control handles in a renderer.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VectorSegmentHit {
    pub subpath_index: usize,
    pub after_point_index: usize,
    pub t: f64,
    pub distance: f64,
}

/// A conservative upper bound for derived render/hit geometry. Canonical path
/// limits protect durable data; this separate bound protects a small tolerance
/// from expanding a legal curve into unbounded transient memory.
pub const MAX_VECTOR_FLATTENED_POINTS: usize = 262_144;

/// Derives the local closed contour for ADR 0026 regular shapes. The durable
/// document stores only the bounded parameters; render, hit-test and export
/// consumers must request this outline rather than keeping their own Polygon
/// or Star formula. The first outer point is at 12 o'clock and winding is
/// clockwise in Canvas coordinates.
pub fn parametric_shape_outline(
    width: f64,
    height: f64,
    shape: ParametricShape,
) -> Result<Vec<Point>, GeometryError> {
    if !width.is_finite() || !height.is_finite() {
        return Err(GeometryError::NonFinite);
    }
    let (inner_ratio, vertex_count) = match shape {
        ParametricShape::Polygon { point_count } if (3..=100).contains(&point_count) => {
            (None, point_count)
        }
        ParametricShape::Star { point_count, inner_ratio }
            if (3..=100).contains(&point_count)
                && inner_ratio.is_finite()
                && (0.05..=0.95).contains(&inner_ratio) =>
        {
            (Some(inner_ratio), point_count * 2)
        }
        _ => return Err(GeometryError::InvalidBounds),
    };
    let center_x = width / 2.0;
    let center_y = height / 2.0;
    let outer_x = width.abs() / 2.0;
    let outer_y = height.abs() / 2.0;
    let mut points = Vec::with_capacity(vertex_count as usize);
    for index in 0..vertex_count {
        let scale = if inner_ratio.is_some() && index % 2 == 1 {
            inner_ratio.unwrap_or(1.0)
        } else {
            1.0
        };
        let angle = -std::f64::consts::FRAC_PI_2
            + f64::from(index) * std::f64::consts::TAU / f64::from(vertex_count);
        points.push(Point::new(
            center_x + angle.cos() * outer_x * scale,
            center_y + angle.sin() * outer_y * scale,
        )?);
    }
    Ok(points)
}

/// The clipping backend represents f64 coordinates internally as scaled i64
/// values. Six decimal places preserve document-pixel precision while keeping
/// the accepted finite coordinate range safely below its integer limit.
const BOOLEAN_CLIP_PRECISION: i32 = 6;
const MAX_BOOLEAN_CLIP_COORDINATE: f64 = 1_000_000_000_000.0;
const MIN_BOOLEAN_AREA: f64 = 1e-12;
/// Outline Stroke persists a normal VectorPath, so its derived mesh must fit
/// the durable VectorPath budget rather than merely the larger render budget.
const MAX_OUTLINE_STROKE_TRIANGLES: usize = 8_192;
const MAX_OUTLINE_VECTOR_SUBPATHS: usize = 64;
const MAX_OUTLINE_VECTOR_POINTS: usize = 8_192;

impl StrokeMesh {
    pub fn contains(&self, point: Point) -> bool {
        self.triangles
            .iter()
            .copied()
            .any(|triangle| point_in_triangle(point, triangle))
    }
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

    /// Same curve subdivision as [`Self::flatten`], with a caller-provided
    /// output budget for untrusted path geometry.
    pub fn flatten_with_limit(
        self,
        tolerance: f64,
        maximum_points: usize,
    ) -> Result<Vec<Point>, GeometryError> {
        if !tolerance.is_finite() || tolerance <= 0.0 {
            return Err(GeometryError::InvalidTolerance);
        }
        if maximum_points < 2 {
            return Err(GeometryError::ResourceLimit);
        }
        let mut points = Vec::new();
        if !flatten_with_limit(self, tolerance, 0, &mut points, maximum_points) {
            return Err(GeometryError::ResourceLimit);
        }
        Ok(points)
    }
}

/// Flattens all VectorPath cubic segments without altering the Canonical path.
/// Handles are relative to their anchor; a missing handle contributes the
/// anchor itself, producing a straight line when both are absent.
pub fn flatten_vector_path(
    path: &VectorPath,
    tolerance: f64,
) -> Result<FlattenedVectorPath, GeometryError> {
    if !tolerance.is_finite() || tolerance <= 0.0 {
        return Err(GeometryError::InvalidTolerance);
    }
    let mut subpaths = Vec::with_capacity(path.subpaths.len());
    let mut all_points = Vec::new();
    for subpath in &path.subpaths {
        let Some(first) = subpath.points.first() else { continue };
        let mut points = vec![first.position];
        let segment_count = if subpath.closed {
            subpath.points.len()
        } else {
            subpath.points.len().saturating_sub(1)
        };
        for index in 0..segment_count {
            let from = &subpath.points[index];
            let to = &subpath.points[(index + 1) % subpath.points.len()];
            let curve = match (from.handle_out, to.handle_in) {
                (None, None) => Bezier::Line { from: from.position, to: to.position },
                (handle_out, handle_in) => Bezier::Cubic {
                    from: from.position,
                    control1: handle_out.map(|handle| Point { x: from.position.x + handle.x, y: from.position.y + handle.y }).unwrap_or(from.position),
                    control2: handle_in.map(|handle| Point { x: to.position.x + handle.x, y: to.position.y + handle.y }).unwrap_or(to.position),
                    to: to.position,
                },
            };
            let remaining = MAX_VECTOR_FLATTENED_POINTS.saturating_sub(all_points.len() + points.len());
            let flattened = curve.flatten_with_limit(tolerance, remaining.max(2))?;
            points.extend(flattened.into_iter().skip(1));
            if all_points.len() + points.len() > MAX_VECTOR_FLATTENED_POINTS {
                return Err(GeometryError::ResourceLimit);
            }
        }
        if subpath.closed && points.len() > 1 && points.last() == points.first() {
            points.pop();
        }
        all_points.extend(points.iter().copied());
        subpaths.push(FlattenedVectorSubpath { closed: subpath.closed, points });
    }
    Ok(FlattenedVectorPath { bounds: Bounds::from_points(&all_points), subpaths })
}

/// Finds a bounded, deterministic nearest editable segment. Cubics are
/// recursively flattened only for picking, while the returned `t` remains in
/// the original curve's parameter space. This keeps direct canvas splitting
/// on the Core geometry path and lets the Canonical command perform the exact
/// de Casteljau subdivision.
pub fn nearest_vector_path_segment(
    path: &VectorPath,
    point: Point,
    tolerance: f64,
    max_distance: f64,
) -> Result<Option<VectorSegmentHit>, GeometryError> {
    if !point.x.is_finite() || !point.y.is_finite() || !tolerance.is_finite() || tolerance <= 0.0 || !max_distance.is_finite() || max_distance < 0.0 {
        return Err(GeometryError::InvalidTolerance);
    }
    let mut nearest: Option<VectorSegmentHit> = None;
    for (subpath_index, subpath) in path.subpaths.iter().enumerate() {
        let segment_count = if subpath.closed { subpath.points.len() } else { subpath.points.len().saturating_sub(1) };
        for after_point_index in 0..segment_count {
            let from = &subpath.points[after_point_index];
            let to = &subpath.points[(after_point_index + 1) % subpath.points.len()];
            let curve = match (from.handle_out, to.handle_in) {
                (None, None) => Bezier::Line { from: from.position, to: to.position },
                (handle_out, handle_in) => Bezier::Cubic {
                    from: from.position,
                    control1: handle_out.map(|handle| Point { x: from.position.x + handle.x, y: from.position.y + handle.y }).unwrap_or(from.position),
                    control2: handle_in.map(|handle| Point { x: to.position.x + handle.x, y: to.position.y + handle.y }).unwrap_or(to.position),
                    to: to.position,
                },
            };
            nearest_on_curve(curve, point, tolerance, 0.0, 1.0, 0, subpath_index, after_point_index, &mut nearest);
        }
    }
    Ok(nearest.filter(|hit| hit.distance <= max_distance && hit.t > 1e-6 && hit.t < 1.0 - 1e-6))
}

/// Computes one derived Boolean outline from editable VectorPath operands.
///
/// The result is transient geometry only: callers must never store it back in
/// Canonical state. Each operand first resolves its own fill rule, then all
/// Boolean steps operate on the normalized non-zero outline. This preserves
/// even-odd holes and makes `Subtract`'s first operand rule explicit.
///
/// Only closed, non-zero-area contours participate. Open/empty/degenerate
/// operands deterministically contribute no filled geometry, as required by
/// ADR 0028. The returned contours retain winding orientation, so consumers
/// render them with non-zero fill rather than guessing hole direction.
pub fn boolean_vector_paths(
    operation: BooleanOperation,
    operands: &[VectorPath],
    tolerance: f64,
) -> Result<FlattenedVectorPath, GeometryError> {
    if operands.len() < 2 {
        return Err(GeometryError::InvalidBounds);
    }
    let normalized = operands
        .iter()
        .map(|operand| normalized_operand_paths(operand, tolerance))
        .collect::<Result<Vec<_>, _>>()?;
    let mut result = normalized.first().cloned().unwrap_or_default();
    match operation {
        BooleanOperation::Union => {
            result = union_subjects_d(
                &normalized.into_iter().flatten().collect(),
                ClipperFillRule::NonZero,
                BOOLEAN_CLIP_PRECISION,
            );
        }
        BooleanOperation::Intersect => {
            for operand in normalized.iter().skip(1) {
                result = intersect_d(&result, operand, ClipperFillRule::NonZero, BOOLEAN_CLIP_PRECISION);
                if result.is_empty() { break; }
            }
        }
        BooleanOperation::Subtract => {
            for operand in normalized.iter().skip(1) {
                result = difference_d(&result, operand, ClipperFillRule::NonZero, BOOLEAN_CLIP_PRECISION);
                if result.is_empty() { break; }
            }
        }
        BooleanOperation::Exclude => {
            for operand in normalized.iter().skip(1) {
                result = xor_d(&result, operand, ClipperFillRule::NonZero, BOOLEAN_CLIP_PRECISION);
            }
        }
    }
    clipped_paths_to_flattened(result)
}

fn normalized_operand_paths(path: &VectorPath, tolerance: f64) -> Result<ClipperPaths, GeometryError> {
    let flattened = flatten_vector_path(path, tolerance)?;
    let paths = flattened
        .subpaths
        .iter()
        .filter(|subpath| subpath.closed && polygon_area(&subpath.points).abs() > MIN_BOOLEAN_AREA)
        .map(|subpath| points_to_clipper_path(&subpath.points))
        .collect::<Result<ClipperPaths, _>>()?;
    if paths.is_empty() {
        return Ok(paths);
    }
    Ok(union_subjects_d(
        &paths,
        match path.fill_rule {
            VectorFillRule::EvenOdd => ClipperFillRule::EvenOdd,
            VectorFillRule::NonZero => ClipperFillRule::NonZero,
        },
        BOOLEAN_CLIP_PRECISION,
    ))
}

fn points_to_clipper_path(points: &[Point]) -> Result<ClipperPath, GeometryError> {
    points
        .iter()
        .map(|point| {
            if !point.x.is_finite()
                || !point.y.is_finite()
                || point.x.abs() > MAX_BOOLEAN_CLIP_COORDINATE
                || point.y.abs() > MAX_BOOLEAN_CLIP_COORDINATE
            {
                return Err(GeometryError::ResourceLimit);
            }
            Ok(ClipperPoint { x: point.x, y: point.y })
        })
        .collect()
}

fn clipped_paths_to_flattened(paths: ClipperPaths) -> Result<FlattenedVectorPath, GeometryError> {
    let mut subpaths = Vec::with_capacity(paths.len());
    let mut all_points = Vec::new();
    for path in paths {
        let mut points = path
            .into_iter()
            .map(|point| Point::new(point.x, point.y))
            .collect::<Result<Vec<_>, _>>()?;
        if points.len() > 1 && points.first() == points.last() {
            points.pop();
        }
        if points.len() < 3 || polygon_area(&points).abs() <= MIN_BOOLEAN_AREA {
            continue;
        }
        if all_points.len().saturating_add(points.len()) > MAX_VECTOR_FLATTENED_POINTS {
            return Err(GeometryError::ResourceLimit);
        }
        all_points.extend(points.iter().copied());
        subpaths.push(FlattenedVectorSubpath { closed: true, points });
    }
    Ok(FlattenedVectorPath {
        bounds: Bounds::from_points(&all_points),
        subpaths,
    })
}

fn polygon_area(points: &[Point]) -> f64 {
    if points.len() < 3 { return 0.0; }
    points
        .iter()
        .copied()
        .zip(points.iter().copied().cycle().skip(1))
        .take(points.len())
        .map(|(from, to)| from.x * to.y - to.x * from.y)
        .sum::<f64>()
        * 0.5
}

/// Fill containment across all closed Vector subpaths. The answer includes a
/// boundary hit and combines contours once using the path's canonical rule.
pub fn vector_path_contains(
    path: &VectorPath,
    point: Point,
    tolerance: f64,
) -> Result<bool, GeometryError> {
    let flattened = flatten_vector_path(path, tolerance)?;
    let mut winding = 0_i32;
    for subpath in flattened.subpaths.iter().filter(|subpath| subpath.closed) {
        let Some(value) = polygon_winding(point, &subpath.points) else { return Ok(true) };
        winding += value;
    }
    Ok(match path.fill_rule {
        VectorFillRule::EvenOdd => winding.rem_euclid(2) == 1,
        VectorFillRule::NonZero => winding != 0,
    })
}

/// Reuses the established polyline tessellator for every flattened subpath,
/// yielding one triangle mesh appropriate for Canvas fallback, hit tests or a
/// future GPU upload. Fill tessellation remains intentionally separate because
/// self-intersection classification is a later Boolean/G3 concern.
pub fn vector_path_stroke_mesh(
    path: &VectorPath,
    tolerance: f64,
    style: StrokeStyle,
) -> Result<StrokeMesh, GeometryError> {
    vector_path_stroke_mesh_with_caps(path, tolerance, style, style.cap, style.cap)
}

/// Expands every open subpath with independently selected standard endpoint
/// caps. This is intentionally one Core geometry operation so Canvas, hit
/// testing and Outline Stroke cannot diverge for asymmetric Line caps.
pub fn vector_path_stroke_mesh_with_caps(
    path: &VectorPath,
    tolerance: f64,
    style: StrokeStyle,
    start_cap: StrokeCapStyle,
    end_cap: StrokeCapStyle,
) -> Result<StrokeMesh, GeometryError> {
    let flattened = flatten_vector_path(path, tolerance)?;
    let mut triangles = Vec::new();
    for subpath in flattened.subpaths {
        if subpath.points.len() < 2 { continue; }
        let mesh = stroke_mesh_for_polyline_with_caps(&subpath.points, style, start_cap, end_cap, subpath.closed)?;
        triangles.extend(mesh.triangles);
    }
    let bounds = Bounds::from_points(&triangles.iter().flatten().copied().collect::<Vec<_>>());
    Ok(StrokeMesh { triangles, bounds })
}

/// Builds a deterministic dashed mesh for each flattened VectorPath subpath.
/// The dash phase intentionally restarts at every subpath, matching the
/// existing Canvas/SVG projection for independently editable contours.
pub fn vector_path_dashed_stroke_mesh(
    path: &VectorPath,
    tolerance: f64,
    style: StrokeStyle,
    dash_pattern: &[f64],
) -> Result<StrokeMesh, GeometryError> {
    let flattened = flatten_vector_path(path, tolerance)?;
    let mut triangles = Vec::new();
    for subpath in flattened.subpaths {
        if subpath.points.len() < 2 { continue; }
        let mesh = stroke_mesh_for_dashed_polyline(&subpath.points, style, dash_pattern, subpath.closed)?;
        triangles.extend(mesh.triangles);
    }
    let bounds = Bounds::from_points(&triangles.iter().flatten().copied().collect::<Vec<_>>());
    Ok(StrokeMesh { triangles, bounds })
}

/// Converts the exact shared stroke tessellation into a compact closed-path
/// fill. Triangle winding is normalized before Clipper unions the mesh, which
/// preserves overlapping round joins/caps and avoids persisting the renderer's
/// triangle decomposition as a fragile collection of fill subpaths.
pub fn outline_vector_path(
    path: &VectorPath,
    tolerance: f64,
    style: StrokeStyle,
) -> Result<FlattenedVectorPath, GeometryError> {
    outline_vector_path_with_caps(path, tolerance, style, style.cap, style.cap)
}

pub fn outline_vector_path_with_caps(
    path: &VectorPath,
    tolerance: f64,
    style: StrokeStyle,
    start_cap: StrokeCapStyle,
    end_cap: StrokeCapStyle,
) -> Result<FlattenedVectorPath, GeometryError> {
    let mesh = vector_path_stroke_mesh_with_caps(path, tolerance, style, start_cap, end_cap)?;
    outline_stroke_mesh(mesh)
}

/// Unions any finite derived stroke mesh into editable closed contours. Line
/// endpoint markers use this same boundary, so their triangles never leak into
/// a persisted VectorPath as independent overlapping pieces.
pub fn outline_stroke_mesh(mesh: StrokeMesh) -> Result<FlattenedVectorPath, GeometryError> {
    if mesh.triangles.len() > MAX_OUTLINE_STROKE_TRIANGLES {
        return Err(GeometryError::ResourceLimit);
    }
    let triangles = mesh.triangles.into_iter().map(|mut triangle| {
        if polygon_area(&triangle) < 0.0 {
            triangle.swap(1, 2);
        }
        points_to_clipper_path(&triangle)
    }).collect::<Result<ClipperPaths, _>>()?;
    let outlined = clipped_paths_to_flattened(union_subjects_d(
        &triangles,
        ClipperFillRule::NonZero,
        BOOLEAN_CLIP_PRECISION,
    ))?;
    let point_count = outlined.subpaths.iter().map(|subpath| subpath.points.len()).sum::<usize>();
    if outlined.subpaths.len() > MAX_OUTLINE_VECTOR_SUBPATHS || point_count > MAX_OUTLINE_VECTOR_POINTS {
        return Err(GeometryError::ResourceLimit);
    }
    Ok(outlined)
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
    let mesh = stroke_mesh_for_polyline(
        points,
        StrokeStyle {
            width,
            cap: StrokeCapStyle::Round,
            join: StrokeJoinStyle::Round,
            miter_limit: 4.0,
        },
        closed,
    )?;
    Ok(mesh.contains(point))
}

/// Builds one reusable stroke outline from a polyline. `Round` joins are
/// represented by a disk at every vertex, which is the exact union semantics
/// of a round-joined stroke; miter/bevel joins add their deterministic outer
/// wedge. This is intentionally independent from Canvas and SVG APIs.
pub fn stroke_mesh_for_polyline(
    points: &[Point],
    style: StrokeStyle,
    closed: bool,
) -> Result<StrokeMesh, GeometryError> {
    stroke_mesh_for_polyline_with_caps(points, style, style.cap, style.cap, closed)
}

/// The same bounded tessellator as [`stroke_mesh_for_polyline`], with explicit
/// start/end caps for open paths. Closed contours deliberately ignore both.
pub fn stroke_mesh_for_polyline_with_caps(
    points: &[Point],
    style: StrokeStyle,
    start_cap: StrokeCapStyle,
    end_cap: StrokeCapStyle,
    closed: bool,
) -> Result<StrokeMesh, GeometryError> {
    if !style.width.is_finite()
        || style.width < 0.0
        || !style.miter_limit.is_finite()
        || style.miter_limit < 1.0
        || points.iter().any(|point| !point.x.is_finite() || !point.y.is_finite())
    {
        return Err(GeometryError::InvalidTolerance);
    }
    if style.width == 0.0 || points.is_empty() {
        return Ok(StrokeMesh { triangles: Vec::new(), bounds: None });
    }
    let mut clean = Vec::with_capacity(points.len());
    for point in points {
        if clean.last().copied() != Some(*point) {
            clean.push(*point);
        }
    }
    if closed && clean.len() > 1 && clean.first() == clean.last() {
        clean.pop();
    }
    let half = style.width / 2.0;
    let mut triangles = Vec::new();
    if clean.len() == 1 {
        if style.cap == StrokeCapStyle::Round {
            add_disk(&mut triangles, clean[0], half)?;
        } else if style.cap == StrokeCapStyle::Square {
            let center = clean[0];
            add_quad(
                &mut triangles,
                Point { x: center.x - half, y: center.y - half },
                Point { x: center.x + half, y: center.y - half },
                Point { x: center.x + half, y: center.y + half },
                Point { x: center.x - half, y: center.y + half },
            )?;
        }
        return Ok(stroke_mesh_from_triangles(triangles));
    }

    let mut segments = Vec::with_capacity(if closed { clean.len() } else { clean.len() - 1 });
    for index in 0..clean.len() - 1 {
        segments.push(segment(clean[index], clean[index + 1])?);
    }
    if closed {
        segments.push(segment(*clean.last().unwrap(), clean[0])?);
    }
    for segment in &segments {
        add_quad(
            &mut triangles,
            offset(segment.from, segment.normal, half),
            offset(segment.to, segment.normal, half),
            offset(segment.to, segment.normal, -half),
            offset(segment.from, segment.normal, -half),
        )?;
    }

    let join_start = if closed { 0 } else { 1 };
    let join_end = if closed { clean.len() } else { clean.len() - 1 };
    for index in join_start..join_end {
        let vertex_index = index % clean.len();
        let previous = &segments[(index + segments.len() - 1) % segments.len()];
        let next = &segments[index % segments.len()];
        add_join(&mut triangles, clean[vertex_index], previous, next, half, style)?;
    }
    if !closed {
        add_cap(&mut triangles, &segments[0], true, half, start_cap)?;
        add_cap(&mut triangles, segments.last().unwrap(), false, half, end_cap)?;
    }
    Ok(stroke_mesh_from_triangles(triangles))
}

/// Builds the decorative endpoint marker for an open Line, in the Line's local
/// space where the path runs along +x from the origin to `(length, 0)`. The
/// marker is placed at `endpoint` (`0.0` for the start, `length` for the end)
/// and points outward along `direction` (`-1.0` at the start, `+1.0` at the
/// end). `stroke_width` drives the marker size exactly as Canvas does:
/// `size = max(8, stroke_width·4)`. Filled markers (`ArrowEquilateral`,
/// `TriangleFilled`, `DiamondFilled`, `CircleFilled`) return solid triangle
/// fans; `ArrowLines` returns the two open barbs rendered as thin quads of the
/// stroke width so the same mesh drives Canvas, hit test and SVG.
pub fn decorative_cap_mesh(
    cap: DecorativeCapStyle,
    endpoint: f64,
    direction: f64,
    stroke_width: f64,
) -> Result<StrokeMesh, GeometryError> {
    if !endpoint.is_finite() || !stroke_width.is_finite() || stroke_width < 0.0
        || (direction != -1.0 && direction != 1.0)
    {
        return Err(GeometryError::InvalidTolerance);
    }
    let size = (stroke_width * 4.0).max(8.0);
    let tip = Point { x: endpoint, y: 0.0 };
    // The marker grows outward from the endpoint: +x at the end cap, -x at the
    // start cap. `back` is the far edge of an arrow/diamond along that axis.
    let back = Point { x: endpoint + direction * size, y: 0.0 };
    let mut triangles = Vec::new();
    match cap {
        DecorativeCapStyle::ArrowEquilateral | DecorativeCapStyle::TriangleFilled => {
            let half = if cap == DecorativeCapStyle::ArrowEquilateral {
                size * 3.0_f64.sqrt() / 4.0
            } else {
                size * 0.42
            };
            push_triangle(
                &mut triangles,
                tip,
                Point { x: back.x, y: half },
                Point { x: back.x, y: -half },
            )?;
        }
        DecorativeCapStyle::DiamondFilled => {
            let half = size / 2.0;
            let middle = Point { x: endpoint + direction * half, y: 0.0 };
            // Two triangles fanned from the tip cover the near half and far half
            // of the diamond, matching Canvas's four-point closed path.
            push_triangle(&mut triangles, tip, Point { x: middle.x, y: half }, back)?;
            push_triangle(&mut triangles, tip, back, Point { x: middle.x, y: -half })?;
        }
        DecorativeCapStyle::CircleFilled => {
            add_disk(&mut triangles, tip, size / 2.0)?;
        }
        DecorativeCapStyle::ArrowLines => {
            // Two open barbs spread ±π/6 from the inward direction. Canvas draws
            // them as strokes; represent each as a thin quad of the stroke width
            // so the union mesh reproduces the same painted pixels and lets the
            // hit test include the barbs.
            let spread = std::f64::consts::PI / 6.0;
            let half = (stroke_width / 2.0).max(0.5);
            // `direction` points outward (toward the tip); the barbs extend back
            // toward the shaft, i.e. along `-direction`.
            for sign in [1.0_f64, -1.0] {
                let angle = spread * sign;
                let barb = Point {
                    x: tip.x - direction * angle.cos() * size,
                    y: -angle.sin() * size,
                };
                add_thick_segment(&mut triangles, tip, barb, half)?;
            }
        }
    }
    Ok(stroke_mesh_from_triangles(triangles))
}

/// Tessellates the visible runs of a zero-offset dashed horizontal Line.
pub fn stroke_mesh_for_dashed_line(
    width: f64,
    style: StrokeStyle,
    dash_pattern: &[f64],
) -> Result<StrokeMesh, GeometryError> {
    if !width.is_finite() || width < 0.0 || dash_pattern.is_empty()
        || dash_pattern.iter().any(|segment| !segment.is_finite() || *segment < 0.0)
        || !dash_pattern.iter().any(|segment| *segment > 0.0)
    {
        return Err(GeometryError::InvalidTolerance);
    }
    const MAX_DASH_STEPS: usize = 16_384;
    let mut triangles = Vec::new();
    let mut cursor = 0.0;
    let mut index = 0usize;
    let mut draw = true;
    // Every iteration either advances the cursor or consumes one zero-length
    // dash entry. Cap the total rather than trusting hostile tiny values to
    // terminate in a reasonable amount of CPU or mesh memory.
    let mut steps = 0usize;
    while cursor < width {
        if steps >= MAX_DASH_STEPS {
            return Err(GeometryError::ResourceLimit);
        }
        steps += 1;
        let length = dash_pattern[index % dash_pattern.len()];
        index += 1;
        if length == 0.0 {
            draw = !draw;
            continue;
        }
        let end = (cursor + length).min(width);
        if draw && end > cursor {
            let mesh = stroke_mesh_for_polyline(
                &[Point { x: cursor, y: 0.0 }, Point { x: end, y: 0.0 }],
                style,
                false,
            )?;
            triangles.extend(mesh.triangles);
        }
        cursor = end;
        draw = !draw;
    }
    Ok(stroke_mesh_from_triangles(triangles))
}

/// Tessellates the visible runs of a zero-offset dashed polyline. A run that
/// crosses a vertex remains one polyline, preserving the requested join; a
/// gap creates two independently capped runs. This is the shared outline for
/// rectilinear Frame/Rectangle dashes and future vector paths.
pub fn stroke_mesh_for_dashed_polyline(
    points: &[Point],
    style: StrokeStyle,
    dash_pattern: &[f64],
    closed: bool,
) -> Result<StrokeMesh, GeometryError> {
    const MAX_DASH_STEPS: usize = 16_384;
    if dash_pattern.is_empty()
        || dash_pattern.iter().any(|segment| !segment.is_finite() || *segment < 0.0)
        || !dash_pattern.iter().any(|segment| *segment > 0.0)
    {
        return Err(GeometryError::InvalidTolerance);
    }
    let mut clean = Vec::with_capacity(points.len());
    for point in points {
        if !point.x.is_finite() || !point.y.is_finite() {
            return Err(GeometryError::InvalidTolerance);
        }
        if clean.last().copied() != Some(*point) {
            clean.push(*point);
        }
    }
    if closed && clean.len() > 1 && clean.first() == clean.last() {
        clean.pop();
    }
    if clean.len() < 2 {
        return stroke_mesh_for_polyline(&clean, style, false);
    }
    let mut segments = clean.windows(2).map(|pair| (pair[0], pair[1])).collect::<Vec<_>>();
    if closed {
        segments.push((*clean.last().unwrap(), clean[0]));
    }
    let mut dash_index = 0usize;
    let mut draw = true;
    let mut remaining = next_nonzero_dash(dash_pattern, &mut dash_index, &mut draw)?;
    let mut steps = 0usize;
    let mut runs: Vec<Vec<Point>> = Vec::new();
    let mut active_run: Vec<Point> = Vec::new();
    for (from, to) in segments {
        let length = from.distance(to);
        if length == 0.0 {
            continue;
        }
        let mut travelled = 0.0;
        while travelled < length {
            if steps >= MAX_DASH_STEPS {
                return Err(GeometryError::ResourceLimit);
            }
            steps += 1;
            let next_distance = (travelled + remaining).min(length);
            let start = point_at_segment_distance(from, to, travelled, length);
            let end = point_at_segment_distance(from, to, next_distance, length);
            if draw && next_distance > travelled {
                if active_run.last().copied() != Some(start) {
                    active_run.push(start);
                }
                active_run.push(end);
            }
            let consumed = next_distance - travelled;
            travelled = next_distance;
            remaining -= consumed;
            if remaining <= 1e-12 {
                if draw && !active_run.is_empty() {
                    runs.push(std::mem::take(&mut active_run));
                }
                draw = !draw;
                remaining = next_nonzero_dash(dash_pattern, &mut dash_index, &mut draw)?;
            }
        }
    }
    if draw && !active_run.is_empty() {
        runs.push(active_run);
    }
    // A visible run can wrap around a closed contour's start point. Merge it
    // so that point owns a normal join rather than two artificial dash caps.
    if closed && runs.len() > 1 && runs[0].first() == clean.first() && runs.last().and_then(|run| run.last()) == clean.first() {
        let first = runs.remove(0);
        let mut last = runs.pop().unwrap();
        last.extend(first.into_iter().skip(1));
        runs.push(last);
    }
    let mut triangles = Vec::new();
    for run in runs {
        let is_closed_run = closed && run.len() > 2 && run.first() == run.last();
        let mesh = stroke_mesh_for_polyline(&run, style, is_closed_run)?;
        triangles.extend(mesh.triangles);
    }
    Ok(stroke_mesh_from_triangles(triangles))
}

fn next_nonzero_dash(
    pattern: &[f64],
    index: &mut usize,
    draw: &mut bool,
) -> Result<f64, GeometryError> {
    for _ in 0..pattern.len() {
        let value = pattern[*index % pattern.len()];
        *index += 1;
        if value > 0.0 {
            return Ok(value);
        }
        *draw = !*draw;
    }
    Err(GeometryError::InvalidTolerance)
}

fn point_at_segment_distance(from: Point, to: Point, distance: f64, length: f64) -> Point {
    let t = (distance / length).clamp(0.0, 1.0);
    Point { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }
}

/// Builds the canonical centre-line tessellation for a uniform rounded
/// rectangle. The generated polyline is bounded and deterministic, so Canvas,
/// GPU and export clients can share it through the normal stroke mesh boundary.
pub fn stroke_mesh_for_rounded_rectangle(
    width: f64,
    height: f64,
    radius: f64,
    style: StrokeStyle,
) -> Result<StrokeMesh, GeometryError> {
    if !width.is_finite() || !height.is_finite() || !radius.is_finite() || width <= 0.0 || height <= 0.0 || radius < 0.0 {
        return Err(GeometryError::InvalidBounds);
    }
    stroke_mesh_for_rounded_rectangle_with_radii(width, height, [radius; 4], style)
}

/// The independent-radius variant of the rounded-rectangle centre line.
/// Radii use TL/TR/BR/BL order and are normalized as one shape so adjacent
/// corners cannot overlap after a resize. This is the same geometric contract
/// used by the browser presentation layer.
pub fn stroke_mesh_for_rounded_rectangle_with_radii(
    width: f64,
    height: f64,
    radii: [f64; 4],
    style: StrokeStyle,
) -> Result<StrokeMesh, GeometryError> {
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 || radii.iter().any(|radius| !radius.is_finite() || *radius < 0.0) {
        return Err(GeometryError::InvalidBounds);
    }
    let radii = normalize_rounded_rectangle_radii(width, height, radii);
    let points = rounded_rectangle_points(width, height, radii);
    stroke_mesh_for_polyline(&points, style, true)
}

/// The dashed form of the independent-radius rounded rectangle. It shares
/// the exact normalized centre line with its solid counterpart, while the
/// generic dashed tessellator preserves joins for visible runs crossing an
/// arc segment and creates caps only at real gaps.
pub fn stroke_mesh_for_dashed_rounded_rectangle_with_radii(
    width: f64,
    height: f64,
    radii: [f64; 4],
    style: StrokeStyle,
    dash_pattern: &[f64],
) -> Result<StrokeMesh, GeometryError> {
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 || radii.iter().any(|radius| !radius.is_finite() || *radius < 0.0) {
        return Err(GeometryError::InvalidBounds);
    }
    let radii = normalize_rounded_rectangle_radii(width, height, radii);
    let points = rounded_rectangle_points(width, height, radii);
    stroke_mesh_for_dashed_polyline(&points, style, dash_pattern, true)
}

/// Tessellates the same superellipse approximation used for Figma-style
/// Corner Smoothing. Unlike a Canvas paint-ring fallback this can keep a
/// Dash pattern visible for Inside/Center/Outside aligned strokes.
pub fn stroke_mesh_for_continuous_rounded_rectangle_with_radii(
    width: f64,
    height: f64,
    radii: [f64; 4],
    smoothing: f64,
    style: StrokeStyle,
    dash_pattern: Option<&[f64]>,
) -> Result<StrokeMesh, GeometryError> {
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0
        || !smoothing.is_finite() || !(0.0..=1.0).contains(&smoothing)
        || radii.iter().any(|radius| !radius.is_finite() || *radius < 0.0)
    {
        return Err(GeometryError::InvalidBounds);
    }
    let radii = normalize_rounded_rectangle_radii(width, height, radii);
    let points = continuous_rounded_rectangle_points(width, height, radii, smoothing);
    match dash_pattern {
        Some(pattern) => stroke_mesh_for_dashed_polyline(&points, style, pattern, true),
        None => stroke_mesh_for_polyline(&points, style, true),
    }
}

/// Tessellates a square-corner rectangle with independently weighted edges.
/// Meshes deliberately remain separate and ordered Top/Right/Bottom/Left:
/// paint stacks can then preserve Canvas/Figma compositing order without
/// introducing corner joins that do not exist in the current per-side model.
pub fn stroke_meshes_for_per_side_rectangle(
    width: f64,
    height: f64,
    weights: [f64; 4],
    align: PerSideStrokeAlign,
) -> Result<Vec<StrokeMesh>, GeometryError> {
    stroke_meshes_for_per_side_rectangle_with_dash(width, height, weights, align, None)
}

/// The dashed counterpart preserves the existing independent-edge contract:
/// every Top/Right/Bottom/Left edge starts its own zero-offset dash cycle and
/// retains Butt ends at the corners. Keeping that policy in Core makes the
/// Canvas fallback, WASM mesh and future export consumers deterministic.
pub fn stroke_meshes_for_per_side_rectangle_with_dash(
    width: f64,
    height: f64,
    weights: [f64; 4],
    align: PerSideStrokeAlign,
    dash_pattern: Option<&[f64]>,
) -> Result<Vec<StrokeMesh>, GeometryError> {
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0
        || weights.iter().any(|weight| !weight.is_finite() || *weight < 0.0)
    {
        return Err(GeometryError::InvalidBounds);
    }
    let [top, right, bottom, left] = weights;
    let (top_y, right_x, bottom_y, left_x) = match align {
        PerSideStrokeAlign::Inside => (top / 2.0, width - right / 2.0, height - bottom / 2.0, left / 2.0),
        PerSideStrokeAlign::Center => (0.0, width, height, 0.0),
        PerSideStrokeAlign::Outside => (-top / 2.0, width + right / 2.0, height + bottom / 2.0, -left / 2.0),
    };
    let sides = [
        (top, [Point { x: 0.0, y: top_y }, Point { x: width, y: top_y }]),
        (right, [Point { x: right_x, y: 0.0 }, Point { x: right_x, y: height }]),
        (bottom, [Point { x: width, y: bottom_y }, Point { x: 0.0, y: bottom_y }]),
        (left, [Point { x: left_x, y: height }, Point { x: left_x, y: 0.0 }]),
    ];
    sides.into_iter()
        .filter(|(weight, _)| *weight > 0.0)
        .map(|(weight, points)| {
            let style = StrokeStyle {
                width: weight,
                cap: StrokeCapStyle::Butt,
                join: StrokeJoinStyle::Miter,
                miter_limit: 1.0,
            };
            match dash_pattern {
                Some(pattern) => stroke_mesh_for_dashed_polyline(&points, style, pattern, false),
                None => stroke_mesh_for_polyline(&points, style, false),
            }
        })
        .collect()
}

const ROUNDED_RECTANGLE_CORNER_SEGMENTS: usize = 16;

fn normalize_rounded_rectangle_radii(width: f64, height: f64, radii: [f64; 4]) -> [f64; 4] {
    let scale = 1.0_f64.min(
        (width / (radii[0] + radii[1]).max(1e-12))
            .min(width / (radii[3] + radii[2]).max(1e-12))
            .min(height / (radii[0] + radii[3]).max(1e-12))
            .min(height / (radii[1] + radii[2]).max(1e-12)),
    );
    radii.map(|radius| radius * scale)
}

fn rounded_rectangle_points(width: f64, height: f64, radii: [f64; 4]) -> Vec<Point> {
    let [top_left, top_right, bottom_right, bottom_left] = radii;
    if radii.iter().all(|radius| *radius <= 1e-12) {
        return vec![
            Point { x: 0.0, y: 0.0 },
            Point { x: width, y: 0.0 },
            Point { x: width, y: height },
            Point { x: 0.0, y: height },
        ];
    }
    let mut points = Vec::with_capacity(ROUNDED_RECTANGLE_CORNER_SEGMENTS * 4 + 4);
    points.push(Point { x: top_left, y: 0.0 });
    points.push(Point { x: width - top_right, y: 0.0 });
    rounded_rectangle_corner(&mut points, width - top_right, top_right, -std::f64::consts::FRAC_PI_2, 0.0, top_right);
    points.push(Point { x: width, y: height - bottom_right });
    rounded_rectangle_corner(&mut points, width - bottom_right, height - bottom_right, 0.0, std::f64::consts::FRAC_PI_2, bottom_right);
    points.push(Point { x: bottom_left, y: height });
    rounded_rectangle_corner(&mut points, bottom_left, height - bottom_left, std::f64::consts::FRAC_PI_2, std::f64::consts::PI, bottom_left);
    points.push(Point { x: 0.0, y: top_left });
    rounded_rectangle_corner(&mut points, top_left, top_left, std::f64::consts::PI, std::f64::consts::PI * 1.5, top_left);
    // Adjacent independent radii can consume an entire edge. Compact exact
    // and trigonometric near-duplicates before sending the closed contour to
    // the generic tessellator, which intentionally rejects zero segments.
    let mut compact = Vec::with_capacity(points.len());
    for point in points {
        let duplicate = compact.last().map(|previous: &Point| {
            (previous.x - point.x).abs() <= 1e-9 && (previous.y - point.y).abs() <= 1e-9
        }).unwrap_or(false);
        if !duplicate {
            compact.push(point);
        }
    }
    if compact.len() > 1 {
        let first = compact[0];
        let last = *compact.last().unwrap();
        if (first.x - last.x).abs() <= 1e-9 && (first.y - last.y).abs() <= 1e-9 {
            compact.pop();
        }
    }
    compact
}

fn continuous_rounded_rectangle_points(width: f64, height: f64, radii: [f64; 4], smoothing: f64) -> Vec<Point> {
    let [top_left, top_right, bottom_right, bottom_left] = radii;
    let exponent = 2.0 + smoothing * 6.0;
    let segments = (8.0 + smoothing * 8.0).round() as usize;
    let mut points = Vec::with_capacity(segments * 4 + 4);
    points.push(Point { x: top_left, y: 0.0 });
    points.push(Point { x: width - top_right, y: 0.0 });
    continuous_rounded_rectangle_corner(&mut points, width - top_right, top_right, top_right, -std::f64::consts::FRAC_PI_2, 0.0, exponent, segments);
    points.push(Point { x: width, y: height - bottom_right });
    continuous_rounded_rectangle_corner(&mut points, width - bottom_right, height - bottom_right, bottom_right, 0.0, std::f64::consts::FRAC_PI_2, exponent, segments);
    points.push(Point { x: bottom_left, y: height });
    continuous_rounded_rectangle_corner(&mut points, bottom_left, height - bottom_left, bottom_left, std::f64::consts::FRAC_PI_2, std::f64::consts::PI, exponent, segments);
    points.push(Point { x: 0.0, y: top_left });
    continuous_rounded_rectangle_corner(&mut points, top_left, top_left, top_left, std::f64::consts::PI, std::f64::consts::PI * 1.5, exponent, segments);
    points
}

fn continuous_rounded_rectangle_corner(points: &mut Vec<Point>, center_x: f64, center_y: f64, radius: f64, start: f64, end: f64, exponent: f64, segments: usize) {
    if radius <= 0.0 {
        points.push(Point { x: center_x, y: center_y });
        return;
    }
    for index in 1..=segments {
        let angle = start + (end - start) * index as f64 / segments as f64;
        let cosine = angle.cos();
        let sine = angle.sin();
        points.push(Point {
            x: center_x + cosine.signum() * cosine.abs().powf(2.0 / exponent) * radius,
            y: center_y + sine.signum() * sine.abs().powf(2.0 / exponent) * radius,
        });
    }
}

fn rounded_rectangle_corner(points: &mut Vec<Point>, center_x: f64, center_y: f64, start: f64, end: f64, radius: f64) {
    for index in 1..=ROUNDED_RECTANGLE_CORNER_SEGMENTS {
        let angle = start + (end - start) * index as f64 / ROUNDED_RECTANGLE_CORNER_SEGMENTS as f64;
        points.push(Point { x: center_x + radius * angle.cos(), y: center_y + radius * angle.sin() });
    }
}

const ROUND_STROKE_SEGMENTS: usize = 16;
const MAX_STROKE_TRIANGLES: usize = 1_000_000;

#[derive(Debug, Clone, Copy)]
struct StrokeSegment {
    from: Point,
    to: Point,
    tangent: Point,
    normal: Point,
}

fn segment(from: Point, to: Point) -> Result<StrokeSegment, GeometryError> {
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    let length = dx.hypot(dy);
    if !length.is_finite() || length <= 1e-12 {
        return Err(GeometryError::InvalidTolerance);
    }
    let tangent = Point { x: dx / length, y: dy / length };
    Ok(StrokeSegment {
        from,
        to,
        tangent,
        normal: Point { x: -tangent.y, y: tangent.x },
    })
}

fn add_join(
    triangles: &mut Vec<[Point; 3]>,
    vertex: Point,
    previous: &StrokeSegment,
    next: &StrokeSegment,
    half: f64,
    style: StrokeStyle,
) -> Result<(), GeometryError> {
    let turn = previous.tangent.x * next.tangent.y - previous.tangent.y * next.tangent.x;
    if turn.abs() <= 1e-12 {
        return Ok(());
    }
    if style.join == StrokeJoinStyle::Round {
        return add_disk(triangles, vertex, half);
    }
    // For a left turn the right side is outside; reverse for a right turn.
    let side = if turn > 0.0 { -1.0 } else { 1.0 };
    let previous_outer = offset(vertex, previous.normal, side * half);
    let next_outer = offset(vertex, next.normal, side * half);
    if style.join == StrokeJoinStyle::Miter {
        if let Some(miter) = offset_line_intersection(previous_outer, previous.tangent, next_outer, next.tangent) {
            if miter.distance(vertex) <= style.miter_limit * half + 1e-12 {
                return push_triangle(triangles, previous_outer, miter, next_outer);
            }
        }
    }
    push_triangle(triangles, previous_outer, vertex, next_outer)
}

fn add_cap(
    triangles: &mut Vec<[Point; 3]>,
    segment: &StrokeSegment,
    at_start: bool,
    half: f64,
    cap: StrokeCapStyle,
) -> Result<(), GeometryError> {
    match cap {
        StrokeCapStyle::Butt => Ok(()),
        StrokeCapStyle::Round => {
            let center = if at_start { segment.from } else { segment.to };
            let base = if at_start { segment.normal } else { Point { x: -segment.normal.x, y: -segment.normal.y } };
            add_semicircle(triangles, center, base, half)
        }
        StrokeCapStyle::Square => {
            let endpoint = if at_start { segment.from } else { segment.to };
            let direction = if at_start { Point { x: -segment.tangent.x, y: -segment.tangent.y } } else { segment.tangent };
            let outer = offset(endpoint, direction, half);
            add_quad(
                triangles,
                offset(endpoint, segment.normal, half),
                offset(outer, segment.normal, half),
                offset(outer, segment.normal, -half),
                offset(endpoint, segment.normal, -half),
            )
        }
    }
}

fn add_disk(triangles: &mut Vec<[Point; 3]>, center: Point, radius: f64) -> Result<(), GeometryError> {
    for index in 0..ROUND_STROKE_SEGMENTS {
        let start = std::f64::consts::TAU * index as f64 / ROUND_STROKE_SEGMENTS as f64;
        let end = std::f64::consts::TAU * (index + 1) as f64 / ROUND_STROKE_SEGMENTS as f64;
        push_triangle(
            triangles,
            center,
            Point { x: center.x + radius * start.cos(), y: center.y + radius * start.sin() },
            Point { x: center.x + radius * end.cos(), y: center.y + radius * end.sin() },
        )?;
    }
    Ok(())
}

fn add_semicircle(triangles: &mut Vec<[Point; 3]>, center: Point, normal: Point, radius: f64) -> Result<(), GeometryError> {
    let start = normal.y.atan2(normal.x);
    for index in 0..ROUND_STROKE_SEGMENTS / 2 {
        let left = start + std::f64::consts::PI * index as f64 / (ROUND_STROKE_SEGMENTS / 2) as f64;
        let right = start + std::f64::consts::PI * (index + 1) as f64 / (ROUND_STROKE_SEGMENTS / 2) as f64;
        push_triangle(
            triangles,
            center,
            Point { x: center.x + radius * left.cos(), y: center.y + radius * left.sin() },
            Point { x: center.x + radius * right.cos(), y: center.y + radius * right.sin() },
        )?;
    }
    Ok(())
}

fn add_quad(triangles: &mut Vec<[Point; 3]>, a: Point, b: Point, c: Point, d: Point) -> Result<(), GeometryError> {
    push_triangle(triangles, a, b, c)?;
    push_triangle(triangles, a, c, d)
}

/// Fills a straight segment as a butt-capped quad of half-width `half`. Used by
/// the open-barb decorative cap so its strokes share the union-mesh model.
fn add_thick_segment(triangles: &mut Vec<[Point; 3]>, from: Point, to: Point, half: f64) -> Result<(), GeometryError> {
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    let length = dx.hypot(dy);
    if !length.is_finite() || length <= 1e-12 || half <= 0.0 {
        return Ok(());
    }
    let normal = Point { x: -dy / length, y: dx / length };
    add_quad(
        triangles,
        offset(from, normal, half),
        offset(to, normal, half),
        offset(to, normal, -half),
        offset(from, normal, -half),
    )
}

fn push_triangle(triangles: &mut Vec<[Point; 3]>, a: Point, b: Point, c: Point) -> Result<(), GeometryError> {
    if triangles.len() >= MAX_STROKE_TRIANGLES {
        return Err(GeometryError::ResourceLimit);
    }
    if ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)).abs() > 1e-12 {
        triangles.push([a, b, c]);
    }
    Ok(())
}

fn stroke_mesh_from_triangles(triangles: Vec<[Point; 3]>) -> StrokeMesh {
    let points = triangles.iter().flatten().copied().collect::<Vec<_>>();
    StrokeMesh { bounds: Bounds::from_points(&points), triangles }
}

fn offset(point: Point, vector: Point, amount: f64) -> Point {
    Point { x: point.x + vector.x * amount, y: point.y + vector.y * amount }
}

fn offset_line_intersection(first: Point, first_direction: Point, second: Point, second_direction: Point) -> Option<Point> {
    let cross = first_direction.x * second_direction.y - first_direction.y * second_direction.x;
    if !cross.is_finite() || cross.abs() <= 1e-12 {
        return None;
    }
    let difference = Point { x: second.x - first.x, y: second.y - first.y };
    let amount = (difference.x * second_direction.y - difference.y * second_direction.x) / cross;
    let point = Point { x: first.x + first_direction.x * amount, y: first.y + first_direction.y * amount };
    (point.x.is_finite() && point.y.is_finite()).then_some(point)
}

fn point_in_triangle(point: Point, [a, b, c]: [Point; 3]) -> bool {
    let first = cross(a, b, point);
    let second = cross(b, c, point);
    let third = cross(c, a, point);
    (first >= -1e-9 && second >= -1e-9 && third >= -1e-9)
        || (first <= 1e-9 && second <= 1e-9 && third <= 1e-9)
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

fn flatten_with_limit(
    curve: Bezier,
    tolerance: f64,
    depth: u8,
    output: &mut Vec<Point>,
    maximum_points: usize,
) -> bool {
    let (from, to, deviation) = match curve {
        Bezier::Line { from, to } => (from, to, 0.0),
        Bezier::Quadratic { from, control, to } => (from, to, distance_to_line(control, from, to)),
        Bezier::Cubic { from, control1, control2, to } => (
            from,
            to,
            distance_to_line(control1, from, to).max(distance_to_line(control2, from, to)),
        ),
    };
    if depth >= 24 || deviation <= tolerance {
        let needed = usize::from(output.last().copied() != Some(from)) + 1;
        if output.len().saturating_add(needed) > maximum_points { return false; }
        if output.last().copied() != Some(from) { output.push(from); }
        output.push(to);
        return true;
    }
    let (left, right) = split(curve);
    flatten_with_limit(left, tolerance, depth + 1, output, maximum_points)
        && flatten_with_limit(right, tolerance, depth + 1, output, maximum_points)
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

fn nearest_on_curve(
    curve: Bezier,
    point: Point,
    tolerance: f64,
    t_start: f64,
    t_end: f64,
    depth: u8,
    subpath_index: usize,
    after_point_index: usize,
    nearest: &mut Option<VectorSegmentHit>,
) {
    let deviation = match curve {
        Bezier::Line { .. } => 0.0,
        Bezier::Quadratic { from, control, to } => distance_to_line(control, from, to),
        Bezier::Cubic { from, control1, control2, to } => distance_to_line(control1, from, to).max(distance_to_line(control2, from, to)),
    };
    if depth < 24 && deviation > tolerance {
        let (left, right) = split(curve);
        let middle = (t_start + t_end) * 0.5;
        nearest_on_curve(left, point, tolerance, t_start, middle, depth + 1, subpath_index, after_point_index, nearest);
        nearest_on_curve(right, point, tolerance, middle, t_end, depth + 1, subpath_index, after_point_index, nearest);
        return;
    }
    let (from, to) = match curve {
        Bezier::Line { from, to } | Bezier::Quadratic { from, to, .. } | Bezier::Cubic { from, to, .. } => (from, to),
    };
    let (distance, local_t) = distance_to_segment_with_amount(point, from, to);
    let candidate = VectorSegmentHit {
        subpath_index,
        after_point_index,
        t: t_start + (t_end - t_start) * local_t,
        distance,
    };
    // Stable iteration order resolves an equidistant pointer deterministically.
    if nearest.map(|current| candidate.distance < current.distance - 1e-12).unwrap_or(true) {
        *nearest = Some(candidate);
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
    distance_to_segment_with_amount(point, from, to).0
}

fn distance_to_segment_with_amount(point: Point, from: Point, to: Point) -> (f64, f64) {
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    let length_squared = dx * dx + dy * dy;
    if length_squared <= 1e-24 {
        return (point.distance(from), 0.0);
    }
    let amount =
        (((point.x - from.x) * dx + (point.y - from.y) * dy) / length_squared).clamp(0.0, 1.0);
    (point.distance(Point {
        x: from.x + dx * amount,
        y: from.y + dy * amount,
    }), amount)
}

fn point_on_segment(point: Point, from: Point, to: Point, tolerance: f64) -> bool {
    distance_to_segment(point, from, to) <= tolerance
}

/// `None` indicates a boundary hit; otherwise the signed winding contribution
/// of the contour is returned for use across a multi-subpath VectorPath.
fn polygon_winding(point: Point, polygon: &[Point]) -> Option<i32> {
    if polygon.len() < 3 { return Some(0); }
    let mut winding = 0_i32;
    for (from, to) in polygon.iter().copied().zip(polygon.iter().copied().cycle().skip(1)).take(polygon.len()) {
        if point_on_segment(point, from, to, 1e-9) { return None; }
        if from.y <= point.y {
            if to.y > point.y && cross(from, to, point) > 0.0 { winding += 1; }
        } else if to.y <= point.y && cross(from, to, point) < 0.0 {
            winding -= 1;
        }
    }
    Some(winding)
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
    use crate::{ParametricShape, PointId, VectorPoint, VectorPointType, VectorSubpath};

    fn p(x: f64, y: f64) -> Point {
        Point::new(x, y).unwrap()
    }

    fn closed_path(id: u128, points: &[(f64, f64)]) -> VectorPath {
        VectorPath {
            fill_rule: VectorFillRule::NonZero,
            subpaths: vec![VectorSubpath {
                closed: true,
                points: points
                    .iter()
                    .enumerate()
                    .map(|(index, &(x, y))| VectorPoint {
                        id: PointId(id + index as u128),
                        position: p(x, y),
                        handle_in: None,
                        handle_out: None,
                        point_type: VectorPointType::Corner,
                    })
                    .collect(),
            }],
        }
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
    fn parametric_outlines_are_top_anchored_clockwise_and_bounded() {
        let polygon = parametric_shape_outline(100.0, 80.0, ParametricShape::Polygon { point_count: 5 }).unwrap();
        assert_eq!(polygon.len(), 5);
        assert_point_near(polygon[0], p(50.0, 0.0));
        assert!(cross(polygon[0], polygon[1], polygon[2]) > 0.0, "Canvas-space winding must be clockwise");

        let star = parametric_shape_outline(100.0, 80.0, ParametricShape::Star { point_count: 5, inner_ratio: 0.4 }).unwrap();
        assert_eq!(star.len(), 10);
        assert_point_near(star[0], p(50.0, 0.0));
        assert!(star[1].y > star[0].y);
        assert!(Bounds::from_points(&star).is_some_and(|bounds| bounds.contains(p(50.0, 0.0))));
    }

    #[test]
    fn parametric_outline_rejects_untrusted_parameters_and_non_finite_bounds() {
        assert_eq!(
            parametric_shape_outline(f64::NAN, 80.0, ParametricShape::Polygon { point_count: 5 }),
            Err(GeometryError::NonFinite),
        );
        assert_eq!(
            parametric_shape_outline(100.0, 80.0, ParametricShape::Polygon { point_count: 2 }),
            Err(GeometryError::InvalidBounds),
        );
        assert_eq!(
            parametric_shape_outline(100.0, 80.0, ParametricShape::Star { point_count: 5, inner_ratio: 0.01 }),
            Err(GeometryError::InvalidBounds),
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
    fn vector_path_flattens_relative_handles_and_combines_fill_rules() {
        let triangle = crate::VectorPath {
            fill_rule: crate::FillRule::NonZero,
            subpaths: vec![crate::VectorSubpath { closed: true, points: vec![
                crate::VectorPoint { id: crate::PointId(1), position: p(0.0, 0.0), handle_in: None, handle_out: Some(p(25.0, 30.0)), point_type: crate::VectorPointType::Corner },
                crate::VectorPoint { id: crate::PointId(2), position: p(100.0, 0.0), handle_in: Some(p(-25.0, 30.0)), handle_out: None, point_type: crate::VectorPointType::Corner },
                crate::VectorPoint { id: crate::PointId(3), position: p(50.0, 100.0), handle_in: None, handle_out: None, point_type: crate::VectorPointType::Corner },
            ] }],
        };
        let flattened = flatten_vector_path(&triangle, 0.25).unwrap();
        assert!(flattened.subpaths[0].points.len() > 3);
        assert_eq!(flattened.subpaths[0].points.first(), Some(&p(0.0, 0.0)));
        assert_eq!(flattened.subpaths[0].points.last(), Some(&p(50.0, 100.0)));
        assert_eq!(flattened.bounds, Some(Bounds::new(p(0.0, 0.0), p(100.0, 100.0)).unwrap()));
        assert!(vector_path_contains(&triangle, p(50.0, 70.0), 0.25).unwrap());
        assert!(!vector_path_contains(&triangle, p(105.0, 20.0), 0.25).unwrap());
        let stroke = vector_path_stroke_mesh(&triangle, 0.25, StrokeStyle { width: 4.0, cap: StrokeCapStyle::Round, join: StrokeJoinStyle::Round, miter_limit: 4.0 }).unwrap();
        assert!(stroke.triangles.len() >= 6);

        let mut hole = triangle.clone();
        hole.fill_rule = crate::FillRule::EvenOdd;
        hole.subpaths.push(crate::VectorSubpath { closed: true, points: vec![
            crate::VectorPoint { id: crate::PointId(4), position: p(35.0, 40.0), handle_in: None, handle_out: None, point_type: crate::VectorPointType::Corner },
            crate::VectorPoint { id: crate::PointId(5), position: p(65.0, 40.0), handle_in: None, handle_out: None, point_type: crate::VectorPointType::Corner },
            crate::VectorPoint { id: crate::PointId(6), position: p(50.0, 70.0), handle_in: None, handle_out: None, point_type: crate::VectorPointType::Corner },
        ] });
        assert!(!vector_path_contains(&hole, p(50.0, 50.0), 0.25).unwrap());
    }

    #[test]
    fn vector_flattening_enforces_a_transient_point_budget() {
        let curve = Bezier::Cubic { from: p(0.0, 0.0), control1: p(0.0, 100.0), control2: p(100.0, 100.0), to: p(100.0, 0.0) };
        assert_eq!(curve.flatten_with_limit(0.001, 2), Err(GeometryError::ResourceLimit));
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
    fn stroke_mesh_matches_round_butt_and_square_cap_extents() {
        let points = [p(0.0, 0.0), p(10.0, 0.0)];
        let round = stroke_mesh_for_polyline(&points, StrokeStyle {
            width: 4.0, cap: StrokeCapStyle::Round, join: StrokeJoinStyle::Round, miter_limit: 4.0,
        }, false).unwrap();
        assert_eq!(round.bounds, Some(Bounds::new(p(-2.0, -2.0), p(12.0, 2.0)).unwrap()));
        assert!(round.contains(p(-1.5, 0.0)));
        assert!(!round.contains(p(-2.1, 0.0)));

        let butt = stroke_mesh_for_polyline(&points, StrokeStyle {
            width: 4.0, cap: StrokeCapStyle::Butt, join: StrokeJoinStyle::Bevel, miter_limit: 4.0,
        }, false).unwrap();
        assert!(!butt.contains(p(-0.5, 0.0)));

        let square = stroke_mesh_for_polyline(&points, StrokeStyle {
            width: 4.0, cap: StrokeCapStyle::Square, join: StrokeJoinStyle::Bevel, miter_limit: 4.0,
        }, false).unwrap();
        assert!(square.contains(p(-1.5, 0.0)));
    }

    #[test]
    fn stroke_mesh_and_outline_allow_independent_open_path_caps() {
        let points = [p(0.0, 0.0), p(10.0, 0.0)];
        let style = StrokeStyle { width: 4.0, cap: StrokeCapStyle::Butt, join: StrokeJoinStyle::Round, miter_limit: 4.0 };
        let mesh = stroke_mesh_for_polyline_with_caps(&points, style, StrokeCapStyle::Round, StrokeCapStyle::Square, false).unwrap();
        assert_eq!(mesh.bounds, Some(Bounds::new(p(-2.0, -2.0), p(12.0, 2.0)).unwrap()));
        let mut path = closed_path(1, &[(0.0, 0.0), (10.0, 0.0), (10.0, 1.0)]);
        path.subpaths[0].points.pop();
        path.subpaths[0].closed = false;
        let outline = outline_vector_path_with_caps(&path, 0.25, style, StrokeCapStyle::Round, StrokeCapStyle::Square).unwrap();
        assert_eq!(outline.bounds, mesh.bounds);
        assert!(outline.subpaths.iter().all(|subpath| subpath.closed && subpath.points.len() >= 3));
    }

    #[test]
    fn stroke_mesh_uses_miter_limit_and_round_join_union() {
        let points = [p(0.0, 0.0), p(10.0, 0.0), p(10.0, 10.0)];
        let miter = stroke_mesh_for_polyline(&points, StrokeStyle {
            width: 4.0, cap: StrokeCapStyle::Butt, join: StrokeJoinStyle::Miter, miter_limit: 4.0,
        }, false).unwrap();
        // The outer 90° corner reaches the true offset-line intersection.
        assert!(miter.contains(p(11.5, -1.5)));

        let limited = stroke_mesh_for_polyline(&points, StrokeStyle {
            width: 4.0, cap: StrokeCapStyle::Butt, join: StrokeJoinStyle::Miter, miter_limit: 1.0,
        }, false).unwrap();
        assert!(!limited.contains(p(11.5, -1.5)));

        let round = stroke_mesh_for_polyline(&points, StrokeStyle {
            width: 4.0, cap: StrokeCapStyle::Butt, join: StrokeJoinStyle::Round, miter_limit: 4.0,
        }, false).unwrap();
        assert!(round.contains(p(11.0, -1.0)));
        assert!(round.triangles.len() > miter.triangles.len());
    }

    #[test]
    fn stroke_mesh_canonicalizes_duplicate_points_and_closed_paths() {
        let duplicate = stroke_mesh_for_polyline(&[p(0.0, 0.0), p(0.0, 0.0), p(10.0, 0.0)], StrokeStyle {
            width: 2.0, cap: StrokeCapStyle::Round, join: StrokeJoinStyle::Round, miter_limit: 4.0,
        }, false).unwrap();
        let clean = stroke_mesh_for_polyline(&[p(0.0, 0.0), p(10.0, 0.0)], StrokeStyle {
            width: 2.0, cap: StrokeCapStyle::Round, join: StrokeJoinStyle::Round, miter_limit: 4.0,
        }, false).unwrap();
        assert_eq!(duplicate, clean);

        let closed = stroke_mesh_for_polyline(&[p(0.0, 0.0), p(10.0, 0.0), p(10.0, 10.0), p(0.0, 10.0), p(0.0, 0.0)], StrokeStyle {
            width: 2.0, cap: StrokeCapStyle::Butt, join: StrokeJoinStyle::Round, miter_limit: 4.0,
        }, true).unwrap();
        assert!(closed.contains(p(-0.5, 0.0)));
        assert!(closed.contains(p(10.5, 10.0)));
    }

    #[test]
    fn dashed_line_mesh_preserves_each_visible_cap_and_omits_terminal_gaps() {
        let mesh = stroke_mesh_for_dashed_line(94.0, StrokeStyle {
            width: 10.0, cap: StrokeCapStyle::Square, join: StrokeJoinStyle::Miter, miter_limit: 4.0,
        }, &[8.0, 4.0]).unwrap();
        // The final 2px are a gap, so the last visible square cap ends at 97,
        // not at the document endpoint plus one half-width (99).
        assert_eq!(mesh.bounds, Some(Bounds::new(p(-5.0, -5.0), p(97.0, 5.0)).unwrap()));
        assert!(mesh.contains(p(96.0, 0.0)));
        assert!(!mesh.contains(p(98.0, 0.0)));
    }

    #[test]
    fn dashed_line_mesh_rejects_an_unbounded_number_of_tiny_runs() {
        let error = stroke_mesh_for_dashed_line(1.0, StrokeStyle {
            width: 1.0, cap: StrokeCapStyle::Butt, join: StrokeJoinStyle::Miter, miter_limit: 4.0,
        }, &[1e-9, 1e-9]).unwrap_err();
        assert_eq!(error, GeometryError::ResourceLimit);
    }

    #[test]
    fn dashed_closed_polyline_preserves_corner_joins_and_gap_bounds() {
        let mesh = stroke_mesh_for_dashed_polyline(
            &[p(0.0, 0.0), p(100.0, 0.0), p(100.0, 60.0), p(0.0, 60.0)],
            StrokeStyle { width: 4.0, cap: StrokeCapStyle::Butt, join: StrokeJoinStyle::Miter, miter_limit: 4.0 },
            &[120.0, 20.0],
            true,
        ).unwrap();
        // The first visible run crosses the top-right corner, therefore its
        // outer miter is still painted while the later left edge remains gap.
        assert!(mesh.contains(p(101.5, -1.5)));
        assert!(!mesh.contains(p(-1.0, 50.0)));
    }

    #[test]
    fn rounded_rectangle_stroke_mesh_has_stable_outer_bounds_and_inner_hole() {
        let mesh = stroke_mesh_for_rounded_rectangle(100.0, 60.0, 12.0, StrokeStyle {
            width: 8.0, cap: StrokeCapStyle::Butt, join: StrokeJoinStyle::Round, miter_limit: 4.0,
        }).unwrap();
        assert_eq!(mesh.bounds, Some(Bounds::new(p(-4.0, -4.0), p(104.0, 64.0)).unwrap()));
        assert!(mesh.contains(p(50.0, 1.0)));
        assert!(!mesh.contains(p(50.0, 30.0)));
        assert!(!mesh.contains(p(-4.1, 30.0)));
    }

    #[test]
    fn independent_rounded_rectangle_radii_normalize_before_tessellation() {
        let mesh = stroke_mesh_for_rounded_rectangle_with_radii(100.0, 60.0, [80.0, 40.0, 30.0, 60.0], StrokeStyle {
            width: 8.0, cap: StrokeCapStyle::Butt, join: StrokeJoinStyle::Round, miter_limit: 4.0,
        }).unwrap();
        // Top radii scale together to fit the 100px edge; the full mesh still
        // has the expected Stroke envelope and leaves its centre open.
        assert_eq!(mesh.bounds, Some(Bounds::new(p(-4.0, -4.0), p(104.0, 64.0)).unwrap()));
        assert!(mesh.contains(p(0.0, 28.0)));
        assert!(!mesh.contains(p(50.0, 30.0)));
    }

    #[test]
    fn per_side_rectangle_meshes_share_alignment_and_paint_order_contract() {
        let inside = stroke_meshes_for_per_side_rectangle(100.0, 80.0, [6.0, 2.0, 4.0, 8.0], PerSideStrokeAlign::Inside).unwrap();
        assert_eq!(inside.len(), 4);
        assert_eq!(inside[0].bounds, Some(Bounds::new(p(0.0, 0.0), p(100.0, 6.0)).unwrap()));
        assert_eq!(inside[1].bounds, Some(Bounds::new(p(98.0, 0.0), p(100.0, 80.0)).unwrap()));
        assert_eq!(inside[2].bounds, Some(Bounds::new(p(0.0, 76.0), p(100.0, 80.0)).unwrap()));
        assert_eq!(inside[3].bounds, Some(Bounds::new(p(0.0, 0.0), p(8.0, 80.0)).unwrap()));

        let outside = stroke_meshes_for_per_side_rectangle(100.0, 80.0, [6.0, 2.0, 4.0, 8.0], PerSideStrokeAlign::Outside).unwrap();
        assert_eq!(outside[0].bounds, Some(Bounds::new(p(0.0, -6.0), p(100.0, 0.0)).unwrap()));
        assert_eq!(outside[1].bounds, Some(Bounds::new(p(100.0, 0.0), p(102.0, 80.0)).unwrap()));
        assert_eq!(outside[2].bounds, Some(Bounds::new(p(0.0, 80.0), p(100.0, 84.0)).unwrap()));
        assert_eq!(outside[3].bounds, Some(Bounds::new(p(-8.0, 0.0), p(0.0, 80.0)).unwrap()));
    }

    #[test]
    fn dashed_per_side_rectangle_keeps_each_edge_dash_cycle_and_alignment() {
        let meshes = stroke_meshes_for_per_side_rectangle_with_dash(
            100.0, 80.0, [6.0, 2.0, 4.0, 8.0], PerSideStrokeAlign::Outside, Some(&[12.0, 8.0]),
        ).unwrap();

        assert_eq!(meshes.len(), 4);
        assert_eq!(meshes[0].bounds, Some(Bounds::new(p(0.0, -6.0), p(92.0, 0.0)).unwrap()));
        assert_eq!(meshes[1].bounds, Some(Bounds::new(p(100.0, 0.0), p(102.0, 72.0)).unwrap()));
        assert_eq!(meshes[2].bounds, Some(Bounds::new(p(8.0, 80.0), p(100.0, 84.0)).unwrap()));
        assert_eq!(meshes[3].bounds, Some(Bounds::new(p(-8.0, 8.0), p(0.0, 80.0)).unwrap()));
    }

    #[test]
    fn dashed_rounded_rectangle_uses_the_same_normalized_contour_as_solid_stroke() {
        let style = StrokeStyle { width: 8.0, cap: StrokeCapStyle::Butt, join: StrokeJoinStyle::Round, miter_limit: 4.0 };
        let solid = stroke_mesh_for_rounded_rectangle_with_radii(100.0, 60.0, [12.0, 24.0, 8.0, 16.0], style).unwrap();
        let dashed = stroke_mesh_for_dashed_rounded_rectangle_with_radii(100.0, 60.0, [12.0, 24.0, 8.0, 16.0], style, &[18.0, 8.0]).unwrap();

        assert_eq!(solid.bounds, Some(Bounds::new(p(-4.0, -4.0), p(104.0, 64.0)).unwrap()));
        assert!(dashed.bounds.is_some_and(|bounds| bounds.min.x <= -4.0 && bounds.max.x >= 104.0));
        assert!(!dashed.triangles.is_empty());
    }

    #[test]
    fn continuous_rounded_rectangle_preserves_dash_and_rejects_invalid_smoothing() {
        let style = StrokeStyle { width: 8.0, cap: StrokeCapStyle::Butt, join: StrokeJoinStyle::Round, miter_limit: 4.0 };
        let mesh = stroke_mesh_for_continuous_rounded_rectangle_with_radii(
            100.0, 60.0, [12.0, 24.0, 8.0, 16.0], 0.5, style, Some(&[18.0, 8.0]),
        ).unwrap();
        assert!(!mesh.triangles.is_empty());
        assert!(mesh.bounds.is_some());
        assert_eq!(
            stroke_mesh_for_continuous_rounded_rectangle_with_radii(100.0, 60.0, [12.0; 4], 1.1, style, Some(&[18.0, 8.0])),
            Err(GeometryError::InvalidBounds),
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

    #[test]
    fn vector_boolean_clipping_is_deterministic_for_all_four_operations() {
        let left = closed_path(1, &[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]);
        let right = closed_path(10, &[(5.0, 0.0), (15.0, 0.0), (15.0, 10.0), (5.0, 10.0)]);
        let bounds = |operation| {
            boolean_vector_paths(operation, &[left.clone(), right.clone()], 0.25)
                .unwrap()
                .bounds
                .unwrap()
        };

        assert_eq!(bounds(BooleanOperation::Union), Bounds::new(p(0.0, 0.0), p(15.0, 10.0)).unwrap());
        assert_eq!(bounds(BooleanOperation::Intersect), Bounds::new(p(5.0, 0.0), p(10.0, 10.0)).unwrap());
        assert_eq!(bounds(BooleanOperation::Subtract), Bounds::new(p(0.0, 0.0), p(5.0, 10.0)).unwrap());
        let exclude = boolean_vector_paths(BooleanOperation::Exclude, &[left.clone(), right.clone()], 0.25).unwrap();
        assert_eq!(exclude.bounds, Some(Bounds::new(p(0.0, 0.0), p(15.0, 10.0)).unwrap()));
        assert_eq!(exclude.subpaths.len(), 2);

        assert_eq!(
            boolean_vector_paths(BooleanOperation::Subtract, &[left, right], 0.25),
            boolean_vector_paths(
                BooleanOperation::Subtract,
                &[
                    closed_path(1, &[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]),
                    closed_path(10, &[(5.0, 0.0), (15.0, 0.0), (15.0, 10.0), (5.0, 10.0)]),
                ],
                0.25,
            ),
        );
    }

    #[test]
    fn vector_boolean_clipping_ignores_open_and_zero_area_operands() {
        let closed = closed_path(1, &[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]);
        let mut open = closed_path(10, &[(20.0, 0.0), (30.0, 0.0), (30.0, 10.0)]);
        open.subpaths[0].closed = false;
        let union = boolean_vector_paths(BooleanOperation::Union, &[closed, open], 0.25).unwrap();
        assert_eq!(union.bounds, Some(Bounds::new(p(0.0, 0.0), p(10.0, 10.0)).unwrap()));
    }

    #[test]
    fn vector_boolean_degenerate_fixture_is_repeatable_for_tangency_overlap_and_self_intersection() {
        let left = closed_path(1, &[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]);
        let touching = closed_path(10, &[(10.0, 0.0), (20.0, 0.0), (20.0, 10.0), (10.0, 10.0)]);
        assert!(boolean_vector_paths(BooleanOperation::Intersect, &[left.clone(), touching], 0.25).unwrap().subpaths.is_empty());

        let contained = closed_path(20, &[(3.0, 3.0), (7.0, 3.0), (7.0, 7.0), (3.0, 7.0)]);
        assert_eq!(boolean_vector_paths(BooleanOperation::Union, &[left.clone(), contained.clone()], 0.25).unwrap().bounds, Some(Bounds::new(p(0.0, 0.0), p(10.0, 10.0)).unwrap()));
        assert_eq!(boolean_vector_paths(BooleanOperation::Intersect, &[left.clone(), contained.clone()], 0.25).unwrap().bounds, Some(Bounds::new(p(3.0, 3.0), p(7.0, 7.0)).unwrap()));

        let identical = boolean_vector_paths(BooleanOperation::Exclude, &[left.clone(), left.clone()], 0.25).unwrap();
        assert!(identical.subpaths.is_empty());

        let zero_area = closed_path(30, &[(0.0, 0.0), (5.0, 0.0), (10.0, 0.0)]);
        assert!(boolean_vector_paths(BooleanOperation::Union, &[zero_area.clone(), zero_area], 0.25).unwrap().subpaths.is_empty());

        let bow_tie = closed_path(40, &[(0.0, 0.0), (10.0, 10.0), (0.0, 10.0), (10.0, 0.0)]);
        let first = boolean_vector_paths(BooleanOperation::Union, &[bow_tie.clone(), left.clone()], 0.25).unwrap();
        let second = boolean_vector_paths(BooleanOperation::Union, &[bow_tie, left], 0.25).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn outline_vector_path_unions_the_exact_stroke_mesh_into_closed_fill_contours() {
        let path = closed_path(1, &[(0.0, 0.0), (20.0, 0.0), (20.0, 10.0), (0.0, 10.0)]);
        let style = StrokeStyle { width: 4.0, cap: StrokeCapStyle::Round, join: StrokeJoinStyle::Round, miter_limit: 4.0 };
        let mesh = vector_path_stroke_mesh(&path, 0.25, style).unwrap();
        let outline = outline_vector_path(&path, 0.25, style).unwrap();
        assert_eq!(outline.bounds, mesh.bounds);
        assert!(!outline.subpaths.is_empty());
        assert!(outline.subpaths.iter().all(|subpath| subpath.closed && subpath.points.len() >= 3));
    }

    #[test]
    fn decorative_arrow_meshes_point_outward_and_size_from_stroke_width() {
        // size = max(8, width·4); width 3 → 12.
        let end = decorative_cap_mesh(DecorativeCapStyle::ArrowEquilateral, 100.0, 1.0, 3.0).unwrap();
        let bounds = end.bounds.unwrap();
        // Tip sits at the endpoint, base is `size` outward (+x) from it.
        assert!((bounds.max.x - 112.0).abs() < 1e-9, "max x {bounds:?}");
        assert!((bounds.min.x - 100.0).abs() < 1e-9, "min x {bounds:?}");
        // Equilateral half-width is size·√3/4 = 12·√3/4 ≈ 5.196.
        let half = 12.0 * 3.0_f64.sqrt() / 4.0;
        assert!((bounds.max.y - half).abs() < 1e-9, "max y {bounds:?}");
        assert!((bounds.min.y + half).abs() < 1e-9, "min y {bounds:?}");
        assert!(end.contains(Point { x: 101.0, y: 0.0 }));

        // The start cap mirrors along -x from its endpoint.
        let start = decorative_cap_mesh(DecorativeCapStyle::TriangleFilled, 0.0, -1.0, 3.0).unwrap();
        let start_bounds = start.bounds.unwrap();
        assert!((start_bounds.min.x + 12.0).abs() < 1e-9, "start min x {start_bounds:?}");
        assert!((start_bounds.max.x - 0.0).abs() < 1e-9, "start max x {start_bounds:?}");
    }

    #[test]
    fn decorative_diamond_and_circle_span_full_marker_size() {
        let diamond = decorative_cap_mesh(DecorativeCapStyle::DiamondFilled, 50.0, 1.0, 4.0).unwrap();
        let bounds = diamond.bounds.unwrap();
        // size = 16; diamond reaches from the endpoint to size outward and ±size/2.
        assert!((bounds.max.x - 66.0).abs() < 1e-9, "{bounds:?}");
        assert!((bounds.min.x - 50.0).abs() < 1e-9, "{bounds:?}");
        assert!((bounds.max.y - 8.0).abs() < 1e-9, "{bounds:?}");
        assert!((bounds.min.y + 8.0).abs() < 1e-9, "{bounds:?}");
        // The middle of the diamond is filled.
        assert!(diamond.contains(Point { x: 58.0, y: 0.0 }));

        let circle = decorative_cap_mesh(DecorativeCapStyle::CircleFilled, 20.0, 1.0, 4.0).unwrap();
        assert!(circle.contains(Point { x: 20.0, y: 0.0 }));
        assert!(circle.contains(Point { x: 20.0, y: 7.0 }));
        assert!(!circle.contains(Point { x: 20.0, y: 9.0 }));
    }

    #[test]
    fn decorative_arrow_lines_barbs_are_thin_and_reach_backward() {
        // Open-barb arrow: barbs extend back from the tip along -direction.
        let mesh = decorative_cap_mesh(DecorativeCapStyle::ArrowLines, 100.0, 1.0, 2.0).unwrap();
        let bounds = mesh.bounds.unwrap();
        // size = max(8, 8) = 8; barbs go inward (−x from the tip at 100). The
        // quad corners at the tip extend at most half a stroke width past it.
        assert!(bounds.max.x <= 100.0 + 1.0 + 1e-6, "barbs stay near the tip: {bounds:?}");
        assert!(bounds.min.x < 100.0 - 4.0, "barbs reach backward: {bounds:?}");
        assert!(!mesh.triangles.is_empty());
    }

    #[test]
    fn decorative_cap_rejects_invalid_direction_and_non_finite_input() {
        assert_eq!(
            decorative_cap_mesh(DecorativeCapStyle::CircleFilled, 0.0, 0.0, 3.0),
            Err(GeometryError::InvalidTolerance),
        );
        assert_eq!(
            decorative_cap_mesh(DecorativeCapStyle::CircleFilled, f64::NAN, 1.0, 3.0),
            Err(GeometryError::InvalidTolerance),
        );
    }

    #[test]
    fn nearest_vector_segment_returns_the_original_cubic_parameter() {
        use crate::{FillRule as CoreFillRule, PointId, VectorPoint, VectorPointType, VectorSubpath};

        let path = VectorPath {
            fill_rule: CoreFillRule::NonZero,
            subpaths: vec![VectorSubpath {
                closed: false,
                points: vec![
                    VectorPoint { id: PointId(1), position: Point { x: 0.0, y: 0.0 }, handle_in: None, handle_out: Some(Point { x: 0.0, y: 10.0 }), point_type: VectorPointType::Asymmetric },
                    VectorPoint { id: PointId(2), position: Point { x: 10.0, y: 0.0 }, handle_in: Some(Point { x: 0.0, y: 10.0 }), handle_out: None, point_type: VectorPointType::Asymmetric },
                ],
            }],
        };

        let hit = nearest_vector_path_segment(&path, Point { x: 5.0, y: 7.5 }, 0.01, 1.0).unwrap().unwrap();
        assert_eq!((hit.subpath_index, hit.after_point_index), (0, 0));
        assert!((hit.t - 0.5).abs() < 0.01, "{hit:?}");
        assert!(hit.distance < 0.01, "{hit:?}");
        assert_eq!(nearest_vector_path_segment(&path, Point { x: 5.0, y: 30.0 }, 0.01, 1.0).unwrap(), None);
    }
}
