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
        add_cap(&mut triangles, &segments[0], true, half, style.cap)?;
        add_cap(&mut triangles, segments.last().unwrap(), false, half, style.cap)?;
    }
    Ok(stroke_mesh_from_triangles(triangles))
}

/// Tessellates the visible runs of a zero-offset dashed horizontal Line.
/// Keeping dash splitting next to the generic stroke tessellator gives Canvas
/// and hit/selection consumers the exact same cap geometry for every dash.
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
}
