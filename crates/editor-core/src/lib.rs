//! Canonical document and transaction primitives shared by browser and server runtimes.
//!
//! The crate deliberately contains no rendering cache, UI state, or transport types.
//! A document is the only source of truth; consumers derive scene and GPU state after a
//! transaction has been accepted.

pub mod authz;
pub mod color;
pub mod geometry;

use std::collections::{BTreeMap, BTreeSet};
use std::ops::{Deref, DerefMut};
use std::sync::Arc;

use crate::color::{
    Color, ColorSpace, DocumentColorProfile, GradientPaintKind, ImageScaleMode, Paint,
    PaintLayerKind, PaintStack,
};
use crate::geometry::{AffineTransform, Point};
use im::{OrdMap as SharedOrdMap, OrdSet as SharedOrdSet, Vector as SharedVector};
use sha2::{Digest, Sha256};
use unicode_segmentation::UnicodeSegmentation;

pub const MAX_TRANSACTION_COMMANDS: usize = 10_000;
pub const MAX_TRANSACTION_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_HISTORY_ITEMS: usize = 256;
pub const MAX_HISTORY_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_DEDUPE_ITEMS: usize = 4_096;
pub const MAX_DEDUPE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_OPERATION_DEDUPE_ITEMS: usize = 4_096;
pub const MAX_OPERATION_DEDUPE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_DOCUMENT_NODES: usize = 100_000;
pub const MAX_DOCUMENT_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_TEXT_BYTES: usize = 1 * 1024 * 1024;
pub const MAX_TEXT_STYLE_RUNS: usize = 4_096;
pub const MAX_TEXT_FALLBACK_FONTS: usize = 32;
pub const MAX_TEXT_HYPERLINK_BYTES: usize = 2_048;
pub const MAX_FONT_VARIATION_AXES: usize = 16;
pub const MAX_OPEN_TYPE_FEATURES: usize = 128;
pub const MAX_STYLE_ID_BYTES: usize = 2_048;
pub const MAX_TEXT_STYLE_RESOURCES: usize = 4_096;
pub const MAX_TEXT_STYLE_RESOURCE_BYTES: usize = 64 * 1024;
pub const MAX_TEXT_STYLE_CATALOG_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_PAINT_STYLE_RESOURCES: usize = 4_096;
pub const MAX_PAINT_STYLE_RESOURCE_BYTES: usize = 256 * 1024;
pub const MAX_PAINT_STYLE_CATALOG_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_STYLE_NAME_BYTES: usize = 1_024;
pub const MAX_STYLE_DESCRIPTION_BYTES: usize = 32 * 1024;
pub const MAX_STYLE_KEY_BYTES: usize = 2_048;
pub const MAX_STYLE_DOCUMENTATION_LINKS: usize = 1;
pub const MAX_STYLE_DOCUMENTATION_URI_BYTES: usize = 2_048;
pub const MAX_VARIABLE_COLLECTIONS: usize = 1_024;
pub const MAX_VARIABLES: usize = 8_192;
pub const MAX_VARIABLE_MODES: usize = 40;
pub const MAX_VARIABLE_SCOPES: usize = 32;
pub const MAX_VARIABLE_CODE_SYNTAX_BYTES: usize = 32 * 1024;
pub const MAX_VARIABLE_STRING_BYTES: usize = 32 * 1024;
pub const MAX_VARIABLE_CATALOG_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct DocumentId(pub u128);

/// Stable identity for a canvas page. Page IDs never depend on their display name
/// or on their position in the sidebar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PageId(pub u128);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ActorId(pub u128);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct OperationId(pub u128);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct NodeId(pub u128);

/// Stable identity for one editable VectorPath anchor. Point order may change
/// through future edit commands; identity never depends on that order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PointId(pub u128);

/// Stable content-addressed resource identity. Raw image/font bytes never live
/// in the Document; the resource service owns those bytes and the Document keeps
/// only this verified reference.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct AssetId(pub u128);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TransactionId(pub u128);

/// A stable sibling-order key. `key` provides a dense local ordering space while
/// `actor` deterministically breaks concurrent allocations at the same midpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PositionId {
    pub key: u128,
    pub actor: ActorId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PositionError {
    NoSpaceBetween,
}

impl PositionId {
    pub fn for_node(id: NodeId) -> Self {
        Self {
            key: id.0,
            actor: ActorId(0),
        }
    }

    pub fn between(
        left: Option<Self>,
        right: Option<Self>,
        actor: ActorId,
    ) -> Result<Self, PositionError> {
        let lower = left.map(|position| position.key).unwrap_or(0);
        let upper = right.map(|position| position.key).unwrap_or(u128::MAX);
        if lower >= upper.saturating_sub(1) {
            return Err(PositionError::NoSpaceBetween);
        }
        Ok(Self {
            key: lower + (upper - lower) / 2,
            actor,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeKind {
    Frame,
    Rectangle,
    Ellipse,
    Text,
    Image,
    /// Figma-compatible open segment. Its height is canonically zero; visual
    /// extent comes from its stroke and endpoint decorations in Phase 2.
    Line,
    /// Structural container. Unlike Frame, Group has no paint, clip, or
    /// layout semantics; its bounds are derived from its children.
    Group,
    /// Canvas organization container. It can hide descendants without
    /// becoming invisible itself, matching Figma's Section semantics.
    Section,
    /// Editable regular polygon. Its point count, rather than a flattened path,
    /// is the durable source of the generated outline (ADR 0026).
    Polygon,
    /// Editable regular star. The durable inner ratio retains its concavity
    /// instead of reducing creation to a one-way Vector conversion (ADR 0026).
    Star,
    /// Editable multi-subpath cubic path (ADR 0027).
    Vector,
    /// FigJam source-code block. Source uses the existing bounded `text`
    /// storage; language is a forward-compatible extension payload.
    CodeBlock,
    /// Reusable design component. Its Frame-like hierarchy is Canonical;
    /// library metadata remains forward-compatible extension data.
    Component,
    /// Linked component use. Instance-specific linkage and overrides are
    /// forward-compatible extensions, while its rendered subtree is Canonical.
    Instance,
    /// Component-property slot. Its property identity is extension metadata.
    Slot,
    /// Variant container. Its direct-child restriction is enforced at the
    /// Canonical parent boundary; library metadata is extension data.
    ComponentSet,
    /// FigJam relationship connector. Endpoint and routing data is extension
    /// metadata while the line geometry remains Canonical.
    Connector,
    /// FigJam iframe preview. The immutable source data is extension metadata.
    Embed,
    /// FigJam highlighter stroke. Canonical path data remains vector-shaped.
    Highlight,
    /// Read-only interactive Slides content; type data lives in extensions.
    InteractiveSlideElement,
    /// FigJam rich link preview. Resolved link data is retained as extensions.
    LinkUnfurl,
    /// FigJam media item. Asset binding and media hash are extension-backed.
    Media,
    /// FigJam shape with embedded text. The shape selector is extension data.
    ShapeWithText,
    /// Figma Slides' imported-only root container. Its direct children are
    /// SlideRows and Plugin API mutation is intentionally rejected upstream.
    SlideGrid,
    /// Fixed-size Figma Slides canvas. Slide-specific metadata lives in
    /// extensions while its children remain ordinary SceneNodes.
    Slide,
    /// Imported-only structural row between a SlideGrid and its Slides.
    SlideRow,
    /// FigJam stamp. The official stamp subtype is carried by its name.
    Stamp,
    /// FigJam sticky note. Text and author presentation live in extensions.
    Sticky,
    /// Structured FigJam table; grid metadata is extension-backed.
    Table,
    /// One Table child carrying immutable row/column coordinates.
    TableCell,
    /// Beta text that follows a durable vector path; text-specific settings
    /// are extension-backed while geometry uses the ordinary vector path.
    TextPath,
    /// Beta Group variant that applies extension-backed child transforms.
    TransformGroup,
    WashiTape,
    Widget,
    /// Live boolean structure. Its direct children remain the durable operands
    /// and the derived result is intentionally never persisted (ADR 0028).
    BooleanOperation,
    /// Non-painting export region. Slice keeps ordinary world geometry so it
    /// can be selected and transformed, but never contributes to page paint.
    Slice,
}

/// The durable operation applied to a BooleanOperation node's ordered direct
/// children. Geometry is derived elsewhere; this enum is the only Canonical
/// Boolean result input stored on the node.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BooleanOperation {
    Union,
    Intersect,
    Subtract,
    Exclude,
}

/// Reserved Canonical extension for G4's sole Phase 2 mask mode. A present
/// byte `1` means the node alpha-masks its following siblings at the same
/// hierarchy level. Keeping the flag in the extensibility channel preserves
/// historical snapshot wire shape while making the relationship hashed and
/// replayable like every other node extension.
const ALPHA_MASK_EXTENSION_KEY: &str = "makefigma.mask.alpha.v1";
const PROTOTYPE_REACTIONS_EXTENSION_KEY: &str = "makefigma.prototype.reactions.v1";
const PROTOTYPE_METADATA_EXTENSION_KEY: &str = "makefigma.prototype.metadata.v1";

/// Endpoint decorations shared by Figma-compatible open paths. Arrow is a
/// Line preset, never a separate document node kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum StrokeCap {
    #[default]
    None,
    Round,
    Square,
    ArrowLines,
    ArrowEquilateral,
    DiamondFilled,
    TriangleFilled,
    CircleFilled,
}

/// Corner treatment for stroked paths. `Miter` and a limit of `10.0` retain
/// the browser canvas defaults used by historical documents.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum StrokeJoin {
    #[default]
    Miter,
    Bevel,
    Round,
}

/// Alignment for closed-shape strokes. Open paths retain center geometry in
/// rendering while preserving the value for future import/export reporting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum StrokeAlign {
    Center,
    #[default]
    Inside,
    Outside,
}

/// E1's supported compositing modes. `Normal` remains the durable default so
/// older snapshots and operation payloads retain their historical result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BlendMode {
    #[default]
    Normal,
    Multiply,
    Screen,
    Overlay,
    Darken,
    Lighten,
    ColorDodge,
    ColorBurn,
    HardLight,
    SoftLight,
    Difference,
    Exclusion,
    Hue,
    Saturation,
    Color,
    Luminosity,
    PassThrough,
    LinearBurn,
    LinearDodge,
}

impl BlendMode {
    pub fn requires_advanced_blend_semantics(self) -> bool {
        matches!(
            self,
            Self::ColorDodge
                | Self::ColorBurn
                | Self::HardLight
                | Self::SoftLight
                | Self::Difference
                | Self::Exclusion
                | Self::Hue
                | Self::Saturation
                | Self::Color
                | Self::Luminosity
        )
    }

    pub fn requires_pass_through_semantics(self) -> bool {
        self == Self::PassThrough
    }

    pub fn requires_linear_blend_semantics(self) -> bool {
        matches!(self, Self::LinearBurn | Self::LinearDodge)
    }
}

/// Figma-compatible per-axis response to a containing Frame resize. A missing
/// wire value is retained for old Snapshot compatibility and executes as the
/// Figma default `Min/Min` when the node is in an applicable Frame context.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConstraintType {
    Min,
    Center,
    Max,
    Stretch,
    Scale,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Constraints {
    pub horizontal: ConstraintType,
    pub vertical: ConstraintType,
}

/// Phase 2's persisted Auto Layout direction. `None` retains existing Frame
/// behavior so legacy documents have no implicit layout migration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LayoutMode {
    #[default]
    None,
    Horizontal,
    Vertical,
    Grid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LayoutAlignment {
    #[default]
    Start,
    Center,
    End,
    SpaceBetween,
    /// Figma's horizontal Auto Layout counter-axis text-baseline alignment.
    /// It is invalid for a primary axis, vertical frame, or child override.
    Baseline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LayoutSizing {
    #[default]
    Fixed,
    Hug,
    Fill,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WrapTrackAlignment {
    #[default]
    Auto,
    SpaceBetween,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum GridTrack {
    Flex(f64),
    Fixed(f64),
    Hug,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum GridItemsPositioning {
    #[default]
    RowAutoFlow,
    Manual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum GridAutoTracks {
    #[default]
    None,
    Rows,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum GridChildAlignment {
    #[default]
    Auto,
    Min,
    Center,
    Max,
}

/// Container and child inputs live in a separate canonical table, which keeps
/// legacy Node snapshots byte-compatible while still making layout semantic.
#[derive(Debug, Clone, PartialEq)]
pub struct AutoLayout {
    pub mode: LayoutMode,
    pub padding: [f64; 4],
    pub item_spacing: f64,
    /// Counter-axis gap between wrap tracks. Omission retains legacy snapshots'
    /// behavior of using `item_spacing` for both axes.
    pub track_spacing: Option<f64>,
    /// Figma's counterAxisAlignContent subset for wrapped rows/columns.
    pub track_alignment: WrapTrackAlignment,
    pub wrap: bool,
    pub primary_alignment: LayoutAlignment,
    pub counter_alignment: LayoutAlignment,
    pub primary_sizing: LayoutSizing,
    pub counter_sizing: LayoutSizing,
    /// A flow child's cross-axis override. `None` inherits its Frame's
    /// `counter_alignment`; `SpaceBetween` and `Baseline` are deliberately
    /// invalid here.
    pub align_self: Option<LayoutAlignment>,
    pub min_width: Option<f64>,
    pub max_width: Option<f64>,
    pub min_height: Option<f64>,
    pub max_height: Option<f64>,
    pub absolute: bool,
    /// Grid Auto Layout v1: non-empty row/column tracks and independent gaps.
    /// Children are assigned in deterministic row-major document order.
    pub grid_rows: Vec<GridTrack>,
    pub grid_columns: Vec<GridTrack>,
    pub grid_row_gap: Option<f64>,
    pub grid_column_gap: Option<f64>,
    /// Direct-child span in a row-auto-flow Grid. Omission is the canonical
    /// one-track default; explicit one is rejected at the protocol boundary.
    pub grid_row_span: Option<u32>,
    pub grid_column_span: Option<u32>,
    /// Grid container placement policy. Row auto-flow is the legacy default.
    pub grid_items_positioning: GridItemsPositioning,
    /// Automatic rows keep one authored row track as the first-row template;
    /// later FLEX rows are derived from child placement and never enter hash or
    /// history as reflow side effects.
    pub grid_auto_tracks: GridAutoTracks,
    pub grid_child_horizontal_align: GridChildAlignment,
    pub grid_child_vertical_align: GridChildAlignment,
    /// Direct-child manual Grid anchors. Both values are present together and
    /// are interpreted only while the parent Grid uses manual positioning.
    pub grid_row_anchor: Option<u32>,
    pub grid_column_anchor: Option<u32>,
}

impl Default for AutoLayout {
    fn default() -> Self {
        Self {
            mode: LayoutMode::None,
            padding: [0.0; 4],
            item_spacing: 0.0,
            track_spacing: None,
            track_alignment: WrapTrackAlignment::Auto,
            wrap: false,
            primary_alignment: LayoutAlignment::Start,
            counter_alignment: LayoutAlignment::Start,
            primary_sizing: LayoutSizing::Fixed,
            counter_sizing: LayoutSizing::Fixed,
            align_self: None,
            min_width: None,
            max_width: None,
            min_height: None,
            max_height: None,
            absolute: false,
            grid_rows: Vec::new(),
            grid_columns: Vec::new(),
            grid_row_gap: None,
            grid_column_gap: None,
            grid_row_span: None,
            grid_column_span: None,
            grid_items_positioning: GridItemsPositioning::RowAutoFlow,
            grid_auto_tracks: GridAutoTracks::None,
            grid_child_horizontal_align: GridChildAlignment::Auto,
            grid_child_vertical_align: GridChildAlignment::Auto,
            grid_row_anchor: None,
            grid_column_anchor: None,
        }
    }
}

/// Figma-compatible Ellipse arc/donut parameters. Angles are degrees in the
/// local clockwise Canvas coordinate space; the full ellipse is represented
/// by `None` to retain historical snapshots and hashes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ArcData {
    pub starting_angle: f64,
    pub ending_angle: f64,
    pub inner_radius: f64,
}

/// Durable parameters for the two G0 regular-shape node kinds. Geometry comes
/// from the Node bounds; this record is deliberately small so regular shapes
/// cannot become an unbounded alternate VectorPath representation.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ParametricShape {
    Polygon { point_count: u32 },
    Star { point_count: u32, inner_ratio: f64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VectorPointType {
    Corner,
    Mirrored,
    Asymmetric,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FillRule {
    NonZero,
    EvenOdd,
}

#[derive(Debug, Clone, PartialEq)]
pub struct VectorPoint {
    pub id: PointId,
    pub position: Point,
    /// Tangent offsets are relative to `position`, retaining editable cubic
    /// semantics without baking absolute coordinates into two places.
    pub handle_in: Option<Point>,
    pub handle_out: Option<Point>,
    pub point_type: VectorPointType,
}

#[derive(Debug, Clone, PartialEq)]
pub struct VectorSubpath {
    pub closed: bool,
    pub points: Vec<VectorPoint>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct VectorPath {
    pub fill_rule: FillRule,
    pub subpaths: Vec<VectorSubpath>,
}

/// A drop shadow entry in the ordered Effect Stack. Coordinates, blur and
/// spread are in document pixels; color stays in the same explicit
/// non-premultiplied space as paints.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DropShadow {
    pub offset_x: f64,
    pub offset_y: f64,
    pub blur_radius: f64,
    pub spread: f64,
    pub color: Color,
    pub visible: bool,
}

/// A blur applied to the isolated source surface before it is composited.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LayerBlur {
    pub radius: f64,
    pub visible: bool,
}

/// A shadow composited only within the isolated source alpha.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct InnerShadow {
    pub offset_x: f64,
    pub offset_y: f64,
    pub blur_radius: f64,
    pub spread: f64,
    pub color: Color,
    pub visible: bool,
}

/// A blur of previously composited backdrop pixels, clipped to the source.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BackgroundBlur {
    pub radius: f64,
    pub visible: bool,
}

/// Phase 2's extensible, ordered effect model.  The first rollout has one
/// effect kind, but uses the final stack-shaped storage so documents never
/// need a lossy schema migration when Inner Shadow, Blur or Blend arrive.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Effect {
    DropShadow(DropShadow),
    LayerBlur(LayerBlur),
    InnerShadow(InnerShadow),
    BackgroundBlur(BackgroundBlur),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Node {
    pub id: NodeId,
    pub parent_id: Option<NodeId>,
    /// Canonical sibling order. Parent/position pairs, rather than UI array order,
    /// determine traversal and future concurrent child insertion.
    pub position: PositionId,
    pub name: String,
    pub kind: NodeKind,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub rotation: f64,
    /// Explicit non-premultiplied document color; CSS is only a projection detail.
    pub fill: Paint,
    /// Canonical stroke paint. Rendering projections may choose a CSS fallback,
    /// but stroke semantics belong to the document just like fill semantics.
    pub stroke: Paint,
    /// Empty retains the legacy singular `fill`; otherwise paints composite in
    /// order and become the authoritative Figma-compatible fill stack.
    pub fills: Vec<Paint>,
    /// Empty retains the legacy singular `stroke`; otherwise paints composite
    /// in order and become the authoritative stroke stack.
    pub strokes: Vec<Paint>,
    pub stroke_width: f64,
    pub stroke_cap_start: StrokeCap,
    pub stroke_cap_end: StrokeCap,
    pub stroke_join: StrokeJoin,
    pub stroke_miter_limit: f64,
    /// Alternating painted/gap lengths in document pixels. Odd-length arrays
    /// are normalized to an even cycle at the Core boundary.
    pub stroke_dash_pattern: Vec<f64>,
    /// Empty retains `stroke_width` as a uniform weight. Four entries are the
    /// Frame/Rectangle top, right, bottom and left weights respectively.
    pub stroke_weights: Vec<f64>,
    pub stroke_align: StrokeAlign,
    pub arc_data: Option<ArcData>,
    pub parametric_shape: Option<ParametricShape>,
    pub vector_path: Option<VectorPath>,
    /// Present exactly for `NodeKind::BooleanOperation` (ADR 0028).
    pub boolean_operation: Option<BooleanOperation>,
    /// Optional during Dual-read migration. A present value is an authoritative
    /// parent-relative 2×3 matrix; absent records retain legacy world x/y/rotation.
    pub relative_transform: Option<AffineTransform>,
    pub opacity: f64,
    pub blend_mode: BlendMode,
    /// Legacy R3 compatibility projection of the first drop shadow. New writes
    /// must keep it equal to the first Effect Stack item when the stack is set.
    pub drop_shadow: Option<DropShadow>,
    /// Empty retains the legacy R3 `drop_shadow`; otherwise this ordered stack
    /// is authoritative. The legacy field remains for old-client round trips.
    pub effect_stack: Vec<Effect>,
    pub corner_radius: f64,
    /// Empty retains `corner_radius`; four values are TL/TR/BR/BL.
    pub corner_radii: Vec<f64>,
    /// 0 retains circular arcs; 1 is the maximally continuous corner curve.
    pub corner_smoothing: f64,
    /// Optional while the Phase 2 constraints migration is introduced. A
    /// present value controls this layer when its containing Frame resizes.
    pub constraints: Option<Constraints>,
    /// Canonical plain text. Rich style runs and shaping belong to the future text engine.
    pub text: String,
    pub visible: bool,
    pub locked: bool,
    pub contents_hidden: bool,
    /// Frame-only. A decoded legacy Frame defaults this to true; false is an
    /// explicit user choice to let descendants paint outside its bounds.
    pub clips_content: bool,
    /// Forward-compatibility payloads owned by newer engine versions. Keys are
    /// preserved byte-for-byte across load/save and operation replay so a node
    /// authored by a future client round-trips through this one unrewritten. A
    /// `BTreeMap` keeps ordering (and therefore the canonical hash) deterministic.
    pub extensions: BTreeMap<String, Vec<u8>>,
}

/// A top-level canvas container. Scene nodes belong to exactly one Page while
/// `parent_id` continues to describe the hierarchy *within* that page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Page {
    pub id: PageId,
    pub name: String,
    pub position: PositionId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FontNameAlias {
    pub family: String,
    pub style: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FontFaceMetadata {
    pub face_index: u32,
    pub family: String,
    pub style: String,
    /// Sorted, unique localized identities for the same immutable face. The
    /// preferred family/style above is excluded to avoid duplicate state.
    pub aliases: Vec<FontNameAlias>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetReference {
    pub asset_id: AssetId,
    pub content_hash: [u8; 32],
    pub media_type: String,
    pub byte_length: u64,
    /// Raster dimensions are present only for image resources; fonts retain
    /// `None` for both dimensions.
    pub dimensions: Option<[u32; 2]>,
    /// Stable OpenType name-table projection, ordered by face index. Empty is
    /// retained for legacy font resources created before semantics v40.
    pub font_faces: Vec<FontFaceMetadata>,
}

/// A content-addressed font face. Font bytes stay in the Asset Service; the
/// document records the exact face and variation coordinates it expects.
#[derive(Debug, Clone, PartialEq)]
pub struct FontReference {
    pub asset_id: AssetId,
    pub face_index: u32,
    pub variation_axes: BTreeMap<String, f32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextAlign {
    Left,
    Center,
    Right,
    Justify,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextAutoSize {
    Fixed,
    Height,
    WidthAndHeight,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextCase {
    Original,
    Upper,
    Lower,
    Title,
    SmallCaps,
    SmallCapsForced,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextDecoration {
    Underline,
    Strikethrough,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeadingTrim {
    CapHeight,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextDecorationStyle {
    Wavy,
    Dotted,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TextDecorationOffset {
    Pixels(f64),
    Percent(f64),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TextDecorationThickness {
    Pixels(f64),
    Percent(f64),
}

/// Figma TextDecorationColor's explicit SolidPaint value. AUTO is represented
/// by absence on TextStyleRun so pre-existing documents retain their hashes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TextDecorationColor {
    pub color: Color,
    pub visible: bool,
    pub opacity: f32,
    pub blend_mode: BlendMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HyperlinkType {
    Url,
    Node,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HyperlinkTarget {
    pub kind: HyperlinkType,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenTypeFeature {
    /// Four uppercase ASCII bytes matching Figma's public feature keys.
    pub tag: String,
    /// Explicit override. `false` is retained because several features are on
    /// by default in OpenType shaping engines.
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TextStyleRun {
    /// UTF-8 byte offsets. Boundaries must coincide with Unicode scalar value
    /// boundaries; grapheme-level editing belongs to the text engine layer.
    pub start: u32,
    pub end: u32,
    pub font: Option<FontReference>,
    pub font_size: f64,
    pub font_weight: u16,
    pub italic: bool,
    pub letter_spacing: f64,
    /// Optional per-run text color. Omission inherits the Text node's legacy
    /// fill, preserving existing documents and their canonical hashes.
    pub color: Option<Color>,
    /// Presence-bearing Figma range fills. A present empty stack suppresses
    /// glyph paint; omission retains the legacy color/node-fill fallback.
    pub fill_stack: Option<PaintStack>,
    /// Absence retains the legacy Original behavior and old canonical hash.
    pub text_case: Option<TextCase>,
    /// Range hyperlink metadata. Absence retains legacy hashes.
    pub hyperlink: Option<HyperlinkTarget>,
    /// Omission is Figma NONE and preserves legacy hashes. Advanced
    /// decoration styling remains in separate append-only capability slices.
    pub text_decoration: Option<TextDecoration>,
    /// Omission is Figma SOLID when decoration is active. WAVY/DOTTED are
    /// versioned separately so existing decorated documents keep their hash.
    pub text_decoration_style: Option<TextDecorationStyle>,
    /// Omission is Figma AUTO. Explicit pixels and percentages are versioned
    /// separately so existing decorated documents retain their hash.
    pub text_decoration_offset: Option<TextDecorationOffset>,
    /// Omission is Figma AUTO. Explicit pixels and percentages are versioned
    /// separately so existing decorated documents retain their hash.
    pub text_decoration_thickness: Option<TextDecorationThickness>,
    /// Omission is Figma AUTO. Explicit values retain the admitted SolidPaint
    /// color, visibility, opacity and paint blend fields.
    pub text_decoration_color: Option<TextDecorationColor>,
    /// Omission preserves the legacy continuous underline. `Some(true)` opts
    /// into Figma's descender-aware skip-ink behavior.
    pub text_decoration_skip_ink: Option<bool>,
    /// Omission is Figma NONE and preserves legacy line boxes and hashes.
    /// CAP_HEIGHT removes only the outer leading of the text block.
    pub leading_trim: Option<LeadingTrim>,
    /// Sorted, unique explicit OpenType feature overrides. An empty list keeps
    /// the font's defaults and preserves all legacy hashes.
    pub open_type_features: Vec<OpenTypeFeature>,
    /// Stable Figma TextStyle link identity. This does not imply that the
    /// referenced style resource is locally editable or resolvable.
    pub text_style_id: Option<String>,
    /// Stable Figma PaintStyle identity for this text range's fills. The
    /// resolved PaintStack remains embedded so rendering never depends on a
    /// mutable external resource lookup.
    pub paint_style_id: Option<String>,
    /// Sorted bindings for Figma's eight Variable-bindable text fields. Values
    /// remain materialized in this run and its paragraph records.
    pub variable_bindings: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParagraphStyle {
    pub alignment: TextAlign,
    pub line_height: Option<f64>,
    /// Omission preserves the legacy pixel interpretation and canonical hash.
    /// Explicit relative units require a newer engine semantics version.
    pub line_height_unit: Option<LineHeightUnit>,
    pub paragraph_spacing: f64,
    /// Presence-bearing first-line inset. Omission preserves legacy hashes.
    pub paragraph_indent: Option<f64>,
    /// Omission is Figma AUTO and preserves legacy hashes.
    pub text_wrap_style: Option<TextWrapStyle>,
    /// Omission is Figma NONE and preserves legacy hashes. Explicit list
    /// markers apply to the first visual line of each hard-break paragraph.
    pub list_type: Option<TextListType>,
    /// Omission is Figma's zero spacing between authored list items.
    pub list_spacing: Option<f64>,
    /// False keeps the marker column inside the text box. True hangs the first
    /// marker column outside it. Only true is serialized and hashed.
    pub hanging_list: bool,
    /// False preserves legacy wrapping. True permits one leading/trailing
    /// punctuation grapheme to hang outside each visual line.
    pub hanging_punctuation: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParagraphStyleRun {
    /// UTF-8 byte offset at an authored paragraph boundary.
    pub start: u32,
    /// Figma list nesting level. None inherits the effective list default.
    pub indentation: Option<u32>,
    /// None inherits the global list type; `ParagraphListType::None`
    /// explicitly disables it for this paragraph.
    pub list_type: Option<ParagraphListType>,
    /// None inherits the global spacing; explicit zero disables spacing after
    /// this authored list item.
    pub list_spacing: Option<f64>,
    /// None inherits the global paragraph spacing; explicit zero disables the
    /// gap after this authored paragraph.
    pub paragraph_spacing: Option<f64>,
    /// None inherits the global first-line indent; explicit zero disables it
    /// for this authored paragraph.
    pub paragraph_indent: Option<f64>,
    /// Per-paragraph line-height value. `None` plus `Auto` is explicit AUTO;
    /// both fields absent inherit the global paragraph style.
    pub line_height: Option<f64>,
    pub line_height_unit: Option<LineHeightUnit>,
    /// None inherits the global wrap style. Explicit Auto disables an
    /// inherited Balance/Pretty value for this paragraph.
    pub text_wrap_style: Option<TextWrapStyle>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineHeightUnit {
    Percent,
    Auto,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextWrapStyle {
    Auto,
    Balance,
    Pretty,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextListType {
    Ordered,
    Unordered,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParagraphListType {
    None,
    Ordered,
    Unordered,
}

impl ParagraphStyle {
    pub fn effective_line_height(&self, font_size: f64) -> f64 {
        let safe_font_size = if font_size.is_finite() && font_size > 0.0 {
            font_size
        } else {
            20.0
        };
        match self.line_height_unit {
            None => self.line_height.unwrap_or(20.0),
            Some(LineHeightUnit::Percent) => {
                safe_font_size * self.line_height.unwrap_or(100.0) / 100.0
            }
            // The font-independent Core cannot inspect browser FontFace metrics.
            // A 1.2em line box is deterministic and shared by every executor.
            Some(LineHeightUnit::Auto) => safe_font_size * 1.2,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TextProperties {
    pub runs: Vec<TextStyleRun>,
    pub paragraph: ParagraphStyle,
    /// Sparse per-paragraph overrides. Absence retains the legacy global
    /// paragraph record and its canonical hash.
    pub paragraph_style_runs: Vec<ParagraphStyleRun>,
    pub auto_size: TextAutoSize,
    pub fallback_fonts: Vec<FontReference>,
    pub text_truncation: TextTruncation,
    pub max_lines: Option<u32>,
    /// Persistent insertion style. Its range fields are always zero and it is
    /// stored outside `runs`, whose entries continue to cover non-empty text.
    pub base_style: Option<TextStyleRun>,
}

/// A complete, document-owned Figma TextStyle resource. IDs are strings so
/// imported Figma identities such as `S:…` survive without lossy remapping.
/// `style.start/end` are always zero because this value is independent of a
/// text node's UTF-8 coordinate space.
#[derive(Debug, Clone, PartialEq)]
pub struct TextStyleResource {
    pub id: String,
    /// Published library key. Local unpublished styles retain an empty key.
    pub key: String,
    pub name: String,
    pub description: String,
    pub description_markdown: String,
    pub documentation_links: Vec<String>,
    pub remote: bool,
    pub style: TextStyleRun,
    /// Absence preserves the legacy PIXELS unit and existing resource hashes.
    pub letter_spacing_unit: Option<TextStyleLetterSpacingUnit>,
    pub variable_bindings: BTreeMap<String, String>,
    pub paragraph: ParagraphStyle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextStyleLetterSpacingUnit {
    Percent,
}

/// A complete, document-owned Figma PaintStyle resource. The ordered paint
/// stack retains presence-bearing empty styles and every admitted paint layer.
#[derive(Debug, Clone, PartialEq)]
pub struct PaintStyleResource {
    pub id: String,
    pub key: String,
    pub name: String,
    pub description: String,
    pub description_markdown: String,
    pub documentation_links: Vec<String>,
    pub remote: bool,
    pub paints: PaintStack,
    pub variable_bindings: Vec<PaintStyleVariableBinding>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaintStyleVariableBinding {
    pub paint_index: u32,
    pub stop_index: Option<u32>,
    pub variable_id: String,
}

impl PaintStyleVariableBinding {
    pub fn target_key(&self) -> (u32, Option<u32>) {
        (self.paint_index, self.stop_index)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VariableMode {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VariableCollectionResource {
    pub id: String,
    pub key: String,
    pub name: String,
    pub remote: bool,
    pub hidden_from_publishing: bool,
    pub modes: Vec<VariableMode>,
    pub default_mode_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VariableResolvedType {
    Boolean,
    Color,
    Float,
    String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum VariableValue {
    Boolean(bool),
    Color(Color),
    Float(f64),
    String(String),
    Alias(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct VariableResource {
    pub id: String,
    pub key: String,
    pub name: String,
    pub description: String,
    pub remote: bool,
    pub hidden_from_publishing: bool,
    pub collection_id: String,
    pub resolved_type: VariableResolvedType,
    pub values_by_mode: BTreeMap<String, VariableValue>,
    pub scopes: Vec<String>,
    pub code_syntax: BTreeMap<String, String>,
}

/// Stable node-level PaintStyle link identities. Background is retained as a
/// deprecated Frame alias and must match fill when both are present.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PaintStyleLinks {
    pub fill: Option<String>,
    pub stroke: Option<String>,
    pub background: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TextTruncation {
    #[default]
    Disabled,
    Ending,
}

impl Default for TextProperties {
    fn default() -> Self {
        Self {
            runs: Vec::new(),
            paragraph: ParagraphStyle {
                alignment: TextAlign::Left,
                line_height: Some(20.0),
                line_height_unit: None,
                paragraph_spacing: 0.0,
                paragraph_indent: None,
                text_wrap_style: None,
                list_type: None,
                list_spacing: None,
                hanging_list: false,
                hanging_punctuation: false,
            },
            paragraph_style_runs: Vec::new(),
            auto_size: TextAutoSize::Fixed,
            fallback_fonts: Vec::new(),
            text_truncation: TextTruncation::Disabled,
            max_lines: None,
            base_style: None,
        }
    }
}

pub const DEFAULT_PAGE_ID: PageId = PageId(1);

const SMALL_CHILD_BUCKET_LIMIT: usize = 8;

/**
 * Most design nodes have only a handful of direct children. Allocating one
 * B-tree node for every Group/Boolean parent made a 100k structural document
 * exceed the browser's WASM heap budget. Keep small sibling sets in one sorted
 * allocation and promote only genuinely wide parents to a persistent OrdSet.
 */
#[derive(Debug, Clone, PartialEq, Eq)]
enum ChildBucket {
    Small(Vec<(PositionId, NodeId)>),
    Tree(SharedOrdSet<(PositionId, NodeId)>),
}

impl Default for ChildBucket {
    fn default() -> Self {
        Self::Small(Vec::new())
    }
}

impl ChildBucket {
    fn insert(&mut self, value: (PositionId, NodeId)) -> bool {
        match self {
            Self::Small(children) => match children.binary_search(&value) {
                Ok(_) => false,
                Err(index) if children.len() < SMALL_CHILD_BUCKET_LIMIT => {
                    children.insert(index, value);
                    true
                }
                Err(_) => {
                    let mut tree = children.iter().copied().collect::<SharedOrdSet<_>>();
                    let inserted = tree.insert(value).is_none();
                    *self = Self::Tree(tree);
                    inserted
                }
            },
            Self::Tree(children) => children.insert(value).is_none(),
        }
    }

    fn remove(&mut self, value: &(PositionId, NodeId)) -> bool {
        let removed = match self {
            Self::Small(children) => children
                .binary_search(value)
                .map(|index| {
                    children.remove(index);
                })
                .is_ok(),
            Self::Tree(children) => children.remove(value).is_some(),
        };
        if let Self::Tree(children) = self
            && children.len() <= SMALL_CHILD_BUCKET_LIMIT
        {
            *self = Self::Small(children.iter().copied().collect());
        }
        removed
    }

    fn len(&self) -> usize {
        match self {
            Self::Small(children) => children.len(),
            Self::Tree(children) => children.len(),
        }
    }

    fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn contains_position(&self, position: PositionId) -> bool {
        match self {
            Self::Small(children) => children
                .binary_search_by_key(&position, |(candidate, _)| *candidate)
                .is_ok(),
            Self::Tree(children) => children
                .range((position, NodeId(0))..=(position, NodeId(u128::MAX)))
                .next()
                .is_some(),
        }
    }

    fn iter(&self) -> ChildBucketIter<'_> {
        match self {
            Self::Small(children) => ChildBucketIter::Small(children.iter()),
            Self::Tree(children) => ChildBucketIter::Tree(children.iter()),
        }
    }
}

enum ChildBucketIter<'a> {
    Small(std::slice::Iter<'a, (PositionId, NodeId)>),
    Tree(im::ordset::Iter<'a, (PositionId, NodeId)>),
}

impl<'a> Iterator for ChildBucketIter<'a> {
    type Item = &'a (PositionId, NodeId);

    fn next(&mut self) -> Option<Self::Item> {
        match self {
            Self::Small(children) => children.next(),
            Self::Tree(children) => children.next(),
        }
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        match self {
            Self::Small(children) => children.size_hint(),
            Self::Tree(children) => children.size_hint(),
        }
    }
}

impl ExactSizeIterator for ChildBucketIter<'_> {}

impl<'a> IntoIterator for &'a ChildBucket {
    type Item = &'a (PositionId, NodeId);
    type IntoIter = ChildBucketIter<'a>;

    fn into_iter(self) -> Self::IntoIter {
        self.iter()
    }
}

#[derive(Debug, Clone, PartialEq)]
struct SharedNode(Arc<Node>);

impl SharedNode {
    fn as_ref(&self) -> &Node {
        self.0.as_ref()
    }

    fn into_node(self) -> Node {
        Arc::unwrap_or_clone(self.0)
    }
}

impl From<Node> for SharedNode {
    fn from(node: Node) -> Self {
        Self(Arc::new(node))
    }
}

impl Deref for SharedNode {
    type Target = Node;

    fn deref(&self) -> &Self::Target {
        self.as_ref()
    }
}

impl DerefMut for SharedNode {
    fn deref_mut(&mut self) -> &mut Self::Target {
        Arc::make_mut(&mut self.0)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Document {
    id: DocumentId,
    pub revision: u64,
    color_profile: DocumentColorProfile,
    pages: SharedOrdMap<PageId, Page>,
    /// Kept separately from `Node` during the Phase 0 → Phase 1 migration so the
    /// public node construction contract remains source-compatible. The mapping is
    /// nevertheless canonical state and participates in hashing and snapshots.
    node_pages: SharedOrdMap<NodeId, PageId>,
    /// Derived structural index. This is intentionally excluded from snapshots
    /// and canonical hashing: it is rebuilt by the same mutation paths that own
    /// `nodes` and `node_pages`, and only accelerates ordered child traversal.
    children_by_parent: SharedOrdMap<(PageId, Option<NodeId>), ChildBucket>,
    /// Structural containers whose minimum-child invariant may have changed.
    /// Hydration may temporarily leave entries here; a successful transaction or
    /// explicit hydration validation drains the set.
    structural_validation_pending: BTreeSet<NodeId>,
    node_assets: SharedOrdMap<NodeId, AssetId>,
    node_text_properties: SharedOrdMap<NodeId, TextProperties>,
    /// Presence-bearing Paint Stack records. A map entry with zero layers is
    /// canonical explicit-empty state; no entry selects the legacy fields.
    node_paint_stacks: SharedOrdMap<(NodeId, bool), PaintStack>,
    node_paint_style_links: SharedOrdMap<NodeId, PaintStyleLinks>,
    /// Explicit entries only; omitted records are exactly `AutoLayout::default`.
    node_auto_layout: SharedOrdMap<NodeId, AutoLayout>,
    /// Retained page membership for node tombstones; undo/redo therefore restores
    /// a node to the page it came from.
    retired_node_pages: SharedOrdMap<NodeId, PageId>,
    retired_node_assets: SharedOrdMap<NodeId, AssetId>,
    retired_node_text_properties: SharedOrdMap<NodeId, TextProperties>,
    retired_node_auto_layout: SharedOrdMap<NodeId, AutoLayout>,
    retired_node_paint_stacks: SharedOrdMap<(NodeId, bool), PaintStack>,
    retired_node_paint_style_links: SharedOrdMap<NodeId, PaintStyleLinks>,
    nodes: SharedOrdMap<NodeId, SharedNode>,
    /// Versioned Resource Index. Asset references are canonical state even before
    /// an Image/Text node consumes them, so cache eviction cannot alter a document.
    assets: SharedOrdMap<AssetId, AssetReference>,
    /// Complete TextStyle values keyed by their stable Figma-compatible ID.
    text_styles: SharedOrdMap<String, TextStyleResource>,
    text_style_bytes: usize,
    /// Complete PaintStyle values keyed by their stable Figma-compatible ID.
    paint_styles: SharedOrdMap<String, PaintStyleResource>,
    paint_style_bytes: usize,
    variable_collections: SharedOrdMap<String, VariableCollectionResource>,
    variables: SharedOrdMap<String, VariableResource>,
    variable_catalog_bytes: usize,
    node_bytes: usize,
    /// IDs are never allocated to an unrelated new node after deletion.
    retired_ids: SharedOrdSet<NodeId>,
    undo_stack: SharedVector<Arc<HistoryItem>>,
    redo_stack: SharedVector<Arc<HistoryItem>>,
    undo_bytes: usize,
    redo_bytes: usize,
    /// Dedupe state belongs to the canonical document: retrying an already accepted
    /// transaction must not create a second revision or history item.
    accepted_transactions: SharedOrdMap<TransactionId, Arc<AcceptedTransactionRecord>>,
    accepted_transaction_order: SharedVector<TransactionId>,
    accepted_transaction_bytes: usize,
    /// Operation delivery is at-least-once. This independent cache ensures a reused
    /// operation ID cannot either mutate twice or silently carry a different payload.
    accepted_operations: SharedOrdMap<OperationId, Arc<AcceptedOperationRecord>>,
    accepted_operation_order: SharedVector<OperationId>,
    accepted_operation_bytes: usize,
}

#[derive(Debug, Clone, PartialEq)]
struct AcceptedTransactionRecord {
    transaction: Transaction,
    applied: AppliedTransaction,
}

#[derive(Debug, Clone, PartialEq)]
struct AcceptedOperationRecord {
    fingerprint: [u8; 32],
    applied: AppliedOperation,
    estimated_bytes: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    CreatePage(Page),
    CreateInPage {
        page_id: PageId,
        node: Node,
    },
    CreateImageInPage {
        page_id: PageId,
        node: Node,
        asset_id: AssetId,
    },
    /// Restores a node that was retired by a prior canonical delete. This is a
    /// history operation, not a second allocation of the node ID.
    RestoreNode {
        page_id: PageId,
        node: Node,
        asset_id: Option<AssetId>,
        text_properties: Option<TextProperties>,
    },
    Create(Node),
    UpdateGeometry {
        id: NodeId,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        rotation: f64,
    },
    /// Updates the container geometry without propagating Constraints to its
    /// descendants. This is the durable form of Figma's Command/Ctrl resize
    /// modifier and Plugin API `resizeWithoutConstraints` method.
    UpdateGeometryWithoutConstraints {
        id: NodeId,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        rotation: f64,
    },
    Rename {
        id: NodeId,
        name: String,
    },
    SetAppearance {
        id: NodeId,
        appearance: Appearance,
    },
    /// Replaces the presence-bearing Paint Stack records without rewriting
    /// legacy paint mirrors. `None` removes the new record and restores legacy
    /// fallback; `Some(empty)` is an explicit no-paint stack.
    SetPaintStacks {
        id: NodeId,
        fill_stack: Option<PaintStack>,
        stroke_stack: Option<PaintStack>,
    },
    SetPaintStyleLinks {
        id: NodeId,
        links: PaintStyleLinks,
    },
    /// Replaces a complete validated VectorPath in one history/replication
    /// unit. This remains the import/snapshot escape hatch for vector edits.
    SetVectorPath {
        id: NodeId,
        path: VectorPath,
    },
    /// Converts one live vector-like shape to Figma's immutable-base TextPath
    /// while retaining its NodeId, page, parent and sibling position. The
    /// resolved path is carried by the command so replicas never derive shape
    /// geometry independently.
    ConvertToTextPath {
        id: NodeId,
        path: VectorPath,
    },
    /// Changes the durable reducer selector of a live BooleanOperation without
    /// flattening or rewriting its ordered operand children.
    SetBooleanOperation {
        id: NodeId,
        operation: BooleanOperation,
    },
    /// Marks a paintable layer, or a Group whose descendants provide alpha,
    /// as an alpha mask for its following siblings.
    /// The relationship is intentionally expressed by durable sibling order;
    /// the mask flag itself is stored in the reserved Phase 2 extension key so
    /// snapshots predating G4 remain byte-for-byte compatible.
    SetMask {
        id: NodeId,
        enabled: bool,
    },
    /// Replaces a node's forward-compatible Canonical extension map. This is
    /// used by M3 prototype data and preserves unknown imported fields exactly.
    SetNodeExtensions {
        id: NodeId,
        extensions: BTreeMap<String, Vec<u8>>,
    },
    /// Moves one existing vector anchor without rewriting unrelated path data.
    MoveVectorPoint {
        id: NodeId,
        point_id: PointId,
        position: Point,
    },
    /// Opens or closes one existing vector subpath. Closing is validated against
    /// the same canonical path invariants as a complete replacement.
    SetVectorSubpathClosed {
        id: NodeId,
        subpath_index: u32,
        closed: bool,
    },
    /// Inserts a stable PointId into one existing Vector subpath. The caller
    /// supplies the resolved predecessor so replicas never infer placement.
    InsertVectorPoint {
        id: NodeId,
        subpath_index: u32,
        after_point_id: Option<PointId>,
        point: VectorPoint,
    },
    /// Splits the directed segment after one anchor at an exact normalized
    /// parameter. Curved segments use de Casteljau subdivision so the visible
    /// curve is invariant; replicas never infer control handles locally.
    SplitVectorSegment {
        id: NodeId,
        subpath_index: u32,
        after_point_id: PointId,
        t: f64,
        point_id: PointId,
    },
    /// Joins two endpoint anchors from one VectorPath. Distinct open subpaths
    /// are oriented so `first_point_id` becomes the preceding endpoint and
    /// `second_point_id` becomes the following endpoint; opposite endpoints of
    /// the same subpath close it. Replicas never infer orientation locally.
    ConnectVectorEndpoints {
        id: NodeId,
        first_subpath_index: u32,
        first_point_id: PointId,
        second_subpath_index: u32,
        second_point_id: PointId,
    },
    /// Removes one anchor while preserving the canonical minimum-point rules
    /// for open and closed subpaths.
    DeleteVectorPoint {
        id: NodeId,
        point_id: PointId,
    },
    /// Replaces both relative handles and the tangent classification of one
    /// anchor as one atomic curve-editing intent.
    SetVectorPointHandles {
        id: NodeId,
        point_id: PointId,
        handle_in: Option<Point>,
        handle_out: Option<Point>,
        point_type: VectorPointType,
    },
    /// Associates an admitted raster Asset with a fill-capable node. The image
    /// bytes remain outside Canonical state; this stable reference participates
    /// in snapshots, hashes, undo/redo and remote Operations.
    SetNodeAsset {
        id: NodeId,
        asset_id: Option<AssetId>,
    },
    SetText {
        id: NodeId,
        text: String,
    },
    SetTextProperties {
        id: NodeId,
        properties: TextProperties,
    },
    /// Sets either a Frame container mode or a direct child's sizing intent.
    SetAutoLayout {
        id: NodeId,
        layout: AutoLayout,
    },
    /// Replaces a canonical sibling-order key without changing geometry or
    /// hierarchy. Positions are resolved before this command crosses the
    /// collaboration boundary, making a reorder deterministic to replay.
    SetNodePosition {
        id: NodeId,
        position: PositionId,
    },
    /// Atomically moves a node into or out of a structural container while
    /// preserving world-relative geometry. The caller supplies a resolved
    /// sibling key so collaboration replay cannot depend on UI array order.
    SetNodeParent {
        id: NodeId,
        parent_id: Option<NodeId>,
        position: PositionId,
    },
    SetDocumentColorProfile {
        profile: DocumentColorProfile,
    },
    RegisterAsset {
        asset: AssetReference,
    },
    RegisterTextStyle {
        style: TextStyleResource,
    },
    RegisterPaintStyle {
        style: PaintStyleResource,
    },
    SetTextStyle {
        style: TextStyleResource,
    },
    DeleteTextStyle {
        id: String,
    },
    SetPaintStyle {
        style: PaintStyleResource,
    },
    DeletePaintStyle {
        id: String,
    },
    RegisterVariableCollection {
        collection: VariableCollectionResource,
    },
    RegisterVariable {
        variable: VariableResource,
    },
    SetVariable {
        variable: VariableResource,
    },
    DeleteVariable {
        id: String,
    },
    SetVariableCollection {
        collection: VariableCollectionResource,
        variables: Vec<VariableResource>,
    },
    DeleteVariableCollection {
        id: String,
    },
    Delete {
        id: NodeId,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Transaction {
    pub id: TransactionId,
    pub base_revision: u64,
    pub commands: Vec<Command>,
}

/// Stable, serializable collaboration boundary. `Transaction` remains a local
/// intent/reducer unit; an Operation contains only resolved, concrete commands.
#[derive(Debug, Clone, PartialEq)]
pub struct OperationEnvelope {
    pub schema_version: u32,
    pub document_id: DocumentId,
    pub operation_id: OperationId,
    pub transaction_id: TransactionId,
    pub actor_id: ActorId,
    pub base_revision: u64,
    pub causal_parents: Vec<OperationId>,
    pub transaction: Transaction,
    pub payload_hash: [u8; 32],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    LocalUser,
    RemoteOperation,
    Import,
    SystemRepair,
}

#[derive(Debug, Clone, PartialEq)]
pub enum AppliedChange {
    /// A single canonical command may update a structural relation and the
    /// Group bounds derived from that relation. Keeping those leaf changes in
    /// one history entry preserves transaction atomicity and exact undo.
    Composite {
        changes: Vec<AppliedChange>,
    },
    PageCreated {
        page: Page,
    },
    NodeCreated {
        node: Node,
    },
    GeometryChanged {
        id: NodeId,
        before: Geometry,
        after: Geometry,
    },
    NameChanged {
        id: NodeId,
        before: String,
        after: String,
    },
    AppearanceChanged {
        id: NodeId,
        before: Appearance,
        after: Appearance,
    },
    PaintStacksChanged {
        id: NodeId,
        before_fill: Option<PaintStack>,
        before_stroke: Option<PaintStack>,
        after_fill: Option<PaintStack>,
        after_stroke: Option<PaintStack>,
    },
    PaintStyleLinksChanged {
        id: NodeId,
        before: Option<PaintStyleLinks>,
        after: Option<PaintStyleLinks>,
    },
    AutoLayoutChanged {
        id: NodeId,
        before: Option<AutoLayout>,
        after: Option<AutoLayout>,
    },
    VectorPathChanged {
        id: NodeId,
        before: VectorPath,
        after: VectorPath,
    },
    NodeRecordChanged {
        id: NodeId,
        before: Node,
        after: Node,
    },
    BooleanOperationChanged {
        id: NodeId,
        before: BooleanOperation,
        after: BooleanOperation,
    },
    MaskChanged {
        id: NodeId,
        before: bool,
        after: bool,
    },
    ExtensionsChanged {
        id: NodeId,
        before: BTreeMap<String, Vec<u8>>,
        after: BTreeMap<String, Vec<u8>>,
    },
    NodeAssetChanged {
        id: NodeId,
        before: Option<AssetId>,
        after: Option<AssetId>,
    },
    TextChanged {
        id: NodeId,
        before: String,
        after: String,
        before_properties: Option<TextProperties>,
        after_properties: Option<TextProperties>,
    },
    TextPropertiesChanged {
        id: NodeId,
        before: Option<TextProperties>,
        after: Option<TextProperties>,
    },
    NodePositionChanged {
        id: NodeId,
        before: PositionId,
        after: PositionId,
    },
    NodeParentChanged {
        id: NodeId,
        before_parent_id: Option<NodeId>,
        before_position: PositionId,
        after_parent_id: Option<NodeId>,
        after_position: PositionId,
    },
    DocumentColorProfileChanged {
        before: DocumentColorProfile,
        after: DocumentColorProfile,
    },
    AssetRegistered {
        asset: AssetReference,
    },
    TextStyleRegistered {
        style: TextStyleResource,
    },
    PaintStyleRegistered {
        style: PaintStyleResource,
    },
    TextStyleChanged {
        before: TextStyleResource,
        after: TextStyleResource,
    },
    TextStyleDeleted {
        style: TextStyleResource,
    },
    PaintStyleChanged {
        before: PaintStyleResource,
        after: PaintStyleResource,
    },
    PaintStyleDeleted {
        style: PaintStyleResource,
    },
    VariableCollectionRegistered {
        collection: VariableCollectionResource,
    },
    VariableRegistered {
        variable: VariableResource,
    },
    VariableChanged {
        before: VariableResource,
        after: VariableResource,
    },
    VariableDeleted {
        variable: VariableResource,
    },
    VariableCollectionChanged {
        before: VariableCollectionResource,
        after: VariableCollectionResource,
        before_variables: Vec<VariableResource>,
        after_variables: Vec<VariableResource>,
    },
    VariableCollectionDeleted {
        collection: VariableCollectionResource,
        variables: Vec<VariableResource>,
    },
    NodeDeleted {
        node: Node,
    },
    NodeRestored {
        node: Node,
    },
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Geometry {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub rotation: f64,
}

#[derive(Clone, Copy)]
struct Bounds {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Appearance {
    pub fill: Paint,
    pub stroke: Paint,
    pub fills: Vec<Paint>,
    pub strokes: Vec<Paint>,
    pub stroke_width: f64,
    pub stroke_cap_start: StrokeCap,
    pub stroke_cap_end: StrokeCap,
    pub stroke_join: StrokeJoin,
    pub stroke_miter_limit: f64,
    pub stroke_dash_pattern: Vec<f64>,
    pub stroke_weights: Vec<f64>,
    pub stroke_align: StrokeAlign,
    pub arc_data: Option<ArcData>,
    pub parametric_shape: Option<ParametricShape>,
    pub relative_transform: Option<AffineTransform>,
    pub opacity: f64,
    pub blend_mode: BlendMode,
    pub drop_shadow: Option<DropShadow>,
    pub effect_stack: Vec<Effect>,
    pub corner_radius: f64,
    pub corner_radii: Vec<f64>,
    pub corner_smoothing: f64,
    pub constraints: Option<Constraints>,
    pub visible: bool,
    pub locked: bool,
    pub contents_hidden: bool,
    pub clips_content: Option<bool>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HistoryItem {
    pub transaction_id: TransactionId,
    pub origin: Origin,
    pub base_revision: u64,
    pub accepted_revision: u64,
    pub changes: Vec<AppliedChange>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AppliedTransaction {
    pub transaction_id: TransactionId,
    pub accepted_revision: u64,
    pub history_item: HistoryItem,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppliedOperation {
    pub operation_id: OperationId,
    pub transaction_id: TransactionId,
    pub accepted_revision: u64,
    pub payload_hash: [u8; 32],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MemoryStats {
    pub node_count: usize,
    pub node_bytes: usize,
    pub undo_items: usize,
    pub undo_bytes: usize,
    pub redo_items: usize,
    pub redo_bytes: usize,
    pub dedupe_items: usize,
    pub dedupe_bytes: usize,
    pub operation_dedupe_items: usize,
    pub operation_dedupe_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandError {
    RevisionConflict {
        expected: u64,
        actual: u64,
    },
    EmptyTransaction,
    MissingNode {
        id: NodeId,
    },
    DuplicateNode {
        id: NodeId,
    },
    RetiredNodeId {
        id: NodeId,
    },
    MissingRetiredNode {
        id: NodeId,
    },
    InvalidGeometry,
    InvalidName,
    InvalidAppearance,
    InvalidText,
    InvalidTextProperties,
    InvalidAutoLayout,
    AutoLayoutUnsupported,
    AutoLayoutLimit,
    MissingParent {
        id: NodeId,
    },
    InvalidParent {
        id: NodeId,
    },
    /// Groups are structural containers whose rectangle is derived from at
    /// least one child. A transaction may construct a Group before reparenting
    /// its children, but it must not commit an empty Group as Canonical state.
    EmptyGroup {
        id: NodeId,
    },
    /// A live Boolean result is defined by an ordered set of at least two
    /// direct operands. As with Groups, construction can be temporary within
    /// one transaction, but an accepted Canonical document never contains a
    /// one-operand Boolean shell.
    InsufficientBooleanOperands {
        id: NodeId,
    },
    EffectivelyLocked {
        id: NodeId,
    },
    DuplicatePosition {
        parent_id: Option<NodeId>,
        position: PositionId,
    },
    MissingPage {
        id: PageId,
    },
    DuplicatePage {
        id: PageId,
    },
    InvalidPageName,
    NodeHasChildren {
        id: NodeId,
    },
    TransactionIdConflict {
        id: TransactionId,
    },
    OperationIdConflict {
        id: OperationId,
    },
    UnsupportedOperationSchema {
        found: u32,
    },
    OperationDocumentMismatch {
        expected: DocumentId,
        actual: DocumentId,
    },
    OperationTransactionMismatch,
    OperationPayloadHashMismatch,
    ResourceLimit,
    PositionExhausted,
    DuplicateAsset {
        id: AssetId,
    },
    InvalidAsset,
    DuplicateTextStyle {
        id: String,
    },
    InvalidTextStyle,
    DuplicatePaintStyle {
        id: String,
    },
    InvalidPaintStyle,
    InvalidPaintStyleLinks,
    DuplicateVariableCollection {
        id: String,
    },
    DuplicateVariable {
        id: String,
    },
    InvalidVariableCollection,
    InvalidVariable,
}

impl Document {
    pub fn empty() -> Self {
        Self::with_id(DocumentId(0))
    }

    pub fn with_id(id: DocumentId) -> Self {
        Self {
            id,
            revision: 0,
            color_profile: DocumentColorProfile::Srgb,
            pages: [(
                DEFAULT_PAGE_ID,
                Page {
                    id: DEFAULT_PAGE_ID,
                    name: "Page 1".into(),
                    position: PositionId::for_node(NodeId(DEFAULT_PAGE_ID.0)),
                },
            )]
            .into_iter()
            .collect(),
            node_pages: SharedOrdMap::new(),
            children_by_parent: SharedOrdMap::new(),
            structural_validation_pending: BTreeSet::new(),
            node_assets: SharedOrdMap::new(),
            node_text_properties: SharedOrdMap::new(),
            node_paint_stacks: SharedOrdMap::new(),
            node_paint_style_links: SharedOrdMap::new(),
            node_auto_layout: SharedOrdMap::new(),
            retired_node_pages: SharedOrdMap::new(),
            retired_node_assets: SharedOrdMap::new(),
            retired_node_text_properties: SharedOrdMap::new(),
            retired_node_auto_layout: SharedOrdMap::new(),
            retired_node_paint_stacks: SharedOrdMap::new(),
            retired_node_paint_style_links: SharedOrdMap::new(),
            nodes: SharedOrdMap::new(),
            assets: SharedOrdMap::new(),
            text_styles: SharedOrdMap::new(),
            text_style_bytes: 0,
            paint_styles: SharedOrdMap::new(),
            paint_style_bytes: 0,
            variable_collections: SharedOrdMap::new(),
            variables: SharedOrdMap::new(),
            variable_catalog_bytes: 0,
            node_bytes: 0,
            retired_ids: SharedOrdSet::new(),
            undo_stack: SharedVector::new(),
            redo_stack: SharedVector::new(),
            undo_bytes: 0,
            redo_bytes: 0,
            accepted_transactions: SharedOrdMap::new(),
            accepted_transaction_order: SharedVector::new(),
            accepted_transaction_bytes: 0,
            accepted_operations: SharedOrdMap::new(),
            accepted_operation_order: SharedVector::new(),
            accepted_operation_bytes: 0,
        }
    }

    pub fn id(&self) -> DocumentId {
        self.id
    }

    /// Installs the durable identity before trusted hydration begins. This is
    /// intentionally narrower than an edit: once any canonical or derived
    /// document state exists, identity changes are rejected rather than
    /// rebuilding the complete document under a second ID.
    pub fn seed_document_id(&mut self, id: DocumentId) -> bool {
        let pristine = self.revision == 0
            && self.nodes.is_empty()
            && self.node_pages.is_empty()
            && self.children_by_parent.is_empty()
            && self.structural_validation_pending.is_empty()
            && self.node_assets.is_empty()
            && self.node_text_properties.is_empty()
            && self.node_paint_stacks.is_empty()
            && self.node_paint_style_links.is_empty()
            && self.node_auto_layout.is_empty()
            && self.retired_node_pages.is_empty()
            && self.retired_node_assets.is_empty()
            && self.retired_node_text_properties.is_empty()
            && self.retired_node_auto_layout.is_empty()
            && self.retired_node_paint_stacks.is_empty()
            && self.retired_node_paint_style_links.is_empty()
            && self.assets.is_empty()
            && self.text_styles.is_empty()
            && self.paint_styles.is_empty()
            && self.variable_collections.is_empty()
            && self.variables.is_empty()
            && self.retired_ids.is_empty()
            && self.undo_stack.is_empty()
            && self.redo_stack.is_empty()
            && self.accepted_transactions.is_empty()
            && self.accepted_operations.is_empty();
        if !pristine {
            return false;
        }
        self.id = id;
        true
    }

    pub fn nodes(&self) -> impl Iterator<Item = &Node> {
        self.nodes.values().map(SharedNode::as_ref)
    }

    pub fn pages(&self) -> impl Iterator<Item = &Page> {
        self.pages.values()
    }

    pub fn page(&self, id: PageId) -> Option<&Page> {
        self.pages.get(&id)
    }

    pub fn page_for_node(&self, id: NodeId) -> Option<PageId> {
        self.node_pages.get(&id).copied()
    }

    pub fn asset_for_node(&self, id: NodeId) -> Option<AssetId> {
        self.node_assets.get(&id).copied()
    }

    /// Returns explicit properties only. An absent record means the stable
    /// default text semantics, preserving snapshots written before rich text.
    pub fn text_properties_for_node(&self, id: NodeId) -> Option<&TextProperties> {
        self.node_text_properties.get(&id)
    }

    pub fn fill_stack_for_node(&self, id: NodeId) -> Option<&PaintStack> {
        self.node_paint_stacks.get(&(id, false))
    }

    pub fn stroke_stack_for_node(&self, id: NodeId) -> Option<&PaintStack> {
        self.node_paint_stacks.get(&(id, true))
    }

    pub fn paint_style_links_for_node(&self, id: NodeId) -> Option<&PaintStyleLinks> {
        self.node_paint_style_links.get(&id)
    }

    /// An absent record is exactly the stable Auto Layout default.
    pub fn auto_layout_for_node(&self, id: NodeId) -> AutoLayout {
        self.node_auto_layout.get(&id).cloned().unwrap_or_default()
    }

    /// A Frame that owns Auto Layout describes its own width and height using
    /// its primary/counter axes. Map those physical axes to the parent's axes
    /// before the parent lays it out; this keeps nested Frame sizing stable
    /// when the two containers use different directions.
    fn auto_layout_child_sizing(
        &self,
        node: &Node,
        parent_horizontal: bool,
    ) -> (LayoutSizing, LayoutSizing) {
        let layout = self.auto_layout_for_node(node.id);
        if is_frame_like(&node.kind) && layout.mode != LayoutMode::None {
            let (width, height) = match layout.mode {
                LayoutMode::Horizontal => (layout.primary_sizing, layout.counter_sizing),
                LayoutMode::Vertical => (layout.counter_sizing, layout.primary_sizing),
                LayoutMode::Grid => (layout.primary_sizing, layout.counter_sizing),
                LayoutMode::None => unreachable!("active layout has a direction"),
            };
            return if parent_horizontal {
                (width, height)
            } else {
                (height, width)
            };
        }
        (layout.primary_sizing, layout.counter_sizing)
    }

    pub fn ordered_nodes_on_page(&self, page_id: PageId) -> Result<Vec<&Node>, CommandError> {
        if !self.pages.contains_key(&page_id) {
            return Err(CommandError::MissingPage { id: page_id });
        }
        Ok(self
            .children_by_parent
            .range((page_id, None)..=(page_id, Some(NodeId(u128::MAX))))
            .flat_map(|(_, children)| children)
            .filter_map(|(_, id)| self.nodes.get(id).map(SharedNode::as_ref))
            .collect())
    }

    /// Returns the direct children of one page-local parent in canonical sibling
    /// order. Root nodes use `None` as the parent.
    pub fn ordered_children(
        &self,
        page_id: PageId,
        parent_id: Option<NodeId>,
    ) -> Result<Vec<&Node>, CommandError> {
        if !self.pages.contains_key(&page_id) {
            return Err(CommandError::MissingPage { id: page_id });
        }
        if let Some(parent_id) = parent_id {
            if self.node_pages.get(&parent_id) != Some(&page_id) {
                return Err(CommandError::MissingParent { id: parent_id });
            }
        }
        Ok(self
            .children_by_parent
            .get(&(page_id, parent_id))
            .into_iter()
            .flatten()
            .filter_map(|(_, id)| self.nodes.get(id).map(SharedNode::as_ref))
            .collect())
    }

    pub fn ordered_nodes(&self) -> Vec<&Node> {
        let mut nodes = self
            .nodes
            .values()
            .map(SharedNode::as_ref)
            .collect::<Vec<_>>();
        nodes.sort_unstable_by_key(|node| (node.parent_id, node.position, node.id));
        nodes
    }

    pub fn position_between(
        &self,
        parent_id: Option<NodeId>,
        left_id: Option<NodeId>,
        right_id: Option<NodeId>,
        actor: ActorId,
    ) -> Result<PositionId, CommandError> {
        let sibling_position = |id: NodeId| {
            self.nodes
                .get(&id)
                .filter(|node| node.parent_id == parent_id)
                .map(|node| node.position)
                .ok_or(CommandError::MissingNode { id })
        };
        let left = left_id.map(sibling_position).transpose()?;
        let right = right_id.map(sibling_position).transpose()?;
        if let (Some(left), Some(right)) = (left, right) {
            if left >= right {
                return Err(CommandError::PositionExhausted);
            }
        }
        PositionId::between(left, right, actor).map_err(|_| CommandError::PositionExhausted)
    }

    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    pub fn color_profile(&self) -> DocumentColorProfile {
        self.color_profile
    }

    /// Snapshot hydration is trusted only after the caller verifies its schema and
    /// Canonical hash. It does not create a user-visible history item.
    pub fn seed_color_profile(&mut self, profile: DocumentColorProfile) {
        self.color_profile = profile;
    }

    pub fn node(&self, id: NodeId) -> Option<&Node> {
        self.nodes.get(&id).map(SharedNode::as_ref)
    }

    /// A lock on any ancestor makes a descendant read-only. The visited set
    /// also makes this safe while inspecting malformed, legacy hierarchy data.
    pub fn is_effectively_locked(&self, id: NodeId) -> bool {
        let mut current = Some(id);
        let mut visited = BTreeSet::new();
        while let Some(node_id) = current {
            if !visited.insert(node_id) {
                return true;
            }
            let Some(node) = self.nodes.get(&node_id) else {
                return false;
            };
            if node.locked {
                return true;
            }
            current = node.parent_id;
        }
        false
    }

    pub fn assets(&self) -> impl Iterator<Item = &AssetReference> {
        self.assets.values()
    }

    pub fn text_styles(&self) -> impl Iterator<Item = &TextStyleResource> {
        self.text_styles.values()
    }

    pub fn text_style(&self, id: &str) -> Option<&TextStyleResource> {
        self.text_styles.get(id)
    }

    pub fn paint_styles(&self) -> impl Iterator<Item = &PaintStyleResource> {
        self.paint_styles.values()
    }

    pub fn paint_style(&self, id: &str) -> Option<&PaintStyleResource> {
        self.paint_styles.get(id)
    }

    pub fn variable_collections(&self) -> impl Iterator<Item = &VariableCollectionResource> {
        self.variable_collections.values()
    }

    pub fn variable_collection(&self, id: &str) -> Option<&VariableCollectionResource> {
        self.variable_collections.get(id)
    }

    pub fn variables(&self) -> impl Iterator<Item = &VariableResource> {
        self.variables.values()
    }

    pub fn variable(&self, id: &str) -> Option<&VariableResource> {
        self.variables.get(id)
    }

    pub fn asset(&self, id: AssetId) -> Option<&AssetReference> {
        self.assets.get(&id)
    }

    pub fn retired_ids(&self) -> impl Iterator<Item = &NodeId> {
        self.retired_ids.iter()
    }

    pub fn can_undo(&self) -> bool {
        !self.undo_stack.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo_stack.is_empty()
    }

    /// Returns the newest local history record without exposing or mutating
    /// the persistent history collection. Disposable preview engines use this
    /// to project only reducer-derived changes instead of scanning every node.
    pub fn latest_undo_item(&self) -> Option<&HistoryItem> {
        self.undo_stack.back().map(AsRef::as_ref)
    }

    pub fn memory_stats(&self) -> MemoryStats {
        MemoryStats {
            node_count: self.nodes.len(),
            node_bytes: self.node_bytes,
            undo_items: self.undo_stack.len(),
            undo_bytes: self.undo_bytes,
            redo_items: self.redo_stack.len(),
            redo_bytes: self.redo_bytes,
            dedupe_items: self.accepted_transactions.len(),
            dedupe_bytes: self.accepted_transaction_bytes,
            operation_dedupe_items: self.accepted_operations.len(),
            operation_dedupe_bytes: self.accepted_operation_bytes,
        }
    }

    /// SHA-256 of the canonical semantic state. It deliberately excludes revision,
    /// undo and dedupe caches so different valid delivery paths with the same document
    /// compare equal; retained IDs are included because reuse is an invariant.
    pub fn canonical_hash(&self) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update(b"makefigma/editor-core/canonical-v1");
        hash_document_color_profile(&mut hasher, self.color_profile);
        hash_len(&mut hasher, self.pages.len());
        for page in self.pages.values() {
            hasher.update(page.id.0.to_be_bytes());
            hasher.update(page.position.key.to_be_bytes());
            hasher.update(page.position.actor.0.to_be_bytes());
            hash_text(&mut hasher, &page.name);
        }
        hash_len(&mut hasher, self.nodes.len());
        for node in self.nodes.values() {
            // A missing mapping can only appear transiently while loading a legacy
            // snapshot. Persisted and accepted documents always assign Page 1.
            hasher.update(
                self.node_pages
                    .get(&node.id)
                    .copied()
                    .unwrap_or(DEFAULT_PAGE_ID)
                    .0
                    .to_be_bytes(),
            );
            hash_node(&mut hasher, node);
        }
        // Keep every pre-image canonical hash valid: documents without image
        // bindings retain their original byte stream. Once the first binding is
        // present, a domain separator and the ordered mapping become semantic
        // state alongside the nodes themselves.
        if !self.node_assets.is_empty() {
            hasher.update(b"makefigma/editor-core/node-assets-v1");
            hash_len(&mut hasher, self.node_assets.len());
            for (node_id, asset_id) in &self.node_assets {
                hasher.update(node_id.0.to_be_bytes());
                hasher.update(asset_id.0.to_be_bytes());
            }
        }
        if !self.node_text_properties.is_empty() {
            hasher.update(b"makefigma/editor-core/text-properties-v1");
            hash_len(&mut hasher, self.node_text_properties.len());
            for (node_id, properties) in &self.node_text_properties {
                hasher.update(node_id.0.to_be_bytes());
                hash_text_properties(&mut hasher, properties);
            }
        }
        hash_document_paint_stacks(&mut hasher, &self.node_paint_stacks);
        if !self.node_paint_style_links.is_empty() {
            hasher.update(b"makefigma/editor-core/node-paint-style-links-v1");
            hash_len(&mut hasher, self.node_paint_style_links.len());
            for (node_id, links) in &self.node_paint_style_links {
                hasher.update(node_id.0.to_be_bytes());
                hash_optional_style_id(&mut hasher, links.fill.as_deref());
                hash_optional_style_id(&mut hasher, links.stroke.as_deref());
                hash_optional_style_id(&mut hasher, links.background.as_deref());
            }
        }
        if !self.node_auto_layout.is_empty() {
            hasher.update(b"makefigma/editor-core/auto-layout-v1");
            hash_len(&mut hasher, self.node_auto_layout.len());
            for (node_id, layout) in &self.node_auto_layout {
                hasher.update(node_id.0.to_be_bytes());
                hash_auto_layout(&mut hasher, layout);
            }
        }
        hash_len(&mut hasher, self.assets.len());
        for asset in self.assets.values() {
            hasher.update(asset.asset_id.0.to_be_bytes());
            hasher.update(asset.content_hash);
            hash_text(&mut hasher, &asset.media_type);
            hasher.update(asset.byte_length.to_be_bytes());
            match asset.dimensions {
                Some([width, height]) => {
                    hasher.update([1]);
                    hasher.update(width.to_be_bytes());
                    hasher.update(height.to_be_bytes());
                }
                None => hasher.update([0]),
            }
            if !asset.font_faces.is_empty() {
                hasher.update(b"makefigma/editor-core/font-face-metadata-v1");
                hash_len(&mut hasher, asset.font_faces.len());
                for face in &asset.font_faces {
                    hasher.update(face.face_index.to_be_bytes());
                    hash_text(&mut hasher, &face.family);
                    hash_text(&mut hasher, &face.style);
                    if !face.aliases.is_empty() {
                        hasher.update(b"makefigma/editor-core/font-name-aliases-v1");
                        hash_len(&mut hasher, face.aliases.len());
                        for alias in &face.aliases {
                            hash_text(&mut hasher, &alias.family);
                            hash_text(&mut hasher, &alias.style);
                        }
                    }
                }
            }
        }
        if !self.text_styles.is_empty() {
            hasher.update(b"makefigma/editor-core/text-style-catalog-v1");
            hash_len(&mut hasher, self.text_styles.len());
            for style in self.text_styles.values() {
                hash_text_style_resource(&mut hasher, style);
            }
        }
        if !self.paint_styles.is_empty() {
            hasher.update(b"makefigma/editor-core/paint-style-catalog-v1");
            hash_len(&mut hasher, self.paint_styles.len());
            for style in self.paint_styles.values() {
                hash_paint_style_resource(&mut hasher, style);
            }
        }
        if !self.variable_collections.is_empty() || !self.variables.is_empty() {
            hasher.update(b"makefigma/editor-core/variable-catalog-v1");
            hash_len(&mut hasher, self.variable_collections.len());
            for collection in self.variable_collections.values() {
                hash_variable_collection(&mut hasher, collection);
            }
            hash_len(&mut hasher, self.variables.len());
            for variable in self.variables.values() {
                hash_variable_resource(&mut hasher, variable);
            }
        }
        hash_len(&mut hasher, self.retired_ids.len());
        for id in &self.retired_ids {
            hasher.update(id.0.to_be_bytes());
        }
        hasher.finalize().into()
    }

    pub fn canonical_hash_hex(&self) -> String {
        self.canonical_hash()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    /// Installs a trusted persisted node while constructing a document projection.
    /// Hydration is not a user edit and therefore does not advance the revision or
    /// enter the local undo history.
    pub fn seed_node(&mut self, node: Node) -> Result<(), CommandError> {
        self.apply(&Command::Create(node)).map(|_| ())
    }

    /// Trusted snapshot hydration entrypoint for Phase 1 records. Legacy callers
    /// use `seed_node`, which deterministically migrates every node to Page 1.
    pub fn seed_node_on_page(&mut self, page_id: PageId, node: Node) -> Result<(), CommandError> {
        self.create_node_in_page(page_id, node).map(|_| ())
    }

    pub fn seed_image_node_on_page(
        &mut self,
        page_id: PageId,
        node: Node,
        asset_id: AssetId,
    ) -> Result<(), CommandError> {
        self.create_image_node_in_page(page_id, node, asset_id)
            .map(|_| ())
    }

    /// Trusted hydration counterpart to `Command::SetMask`. Snapshot and
    /// fixture loaders create every structural sibling first, then apply mask
    /// identities without creating history or advancing the document revision.
    /// Keeping the same reducer validation prevents a legacy projection from
    /// bypassing the ordinary mask-kind, following-sibling, lock, or budget
    /// invariants simply because it is being hydrated.
    pub fn seed_mask(&mut self, id: NodeId, enabled: bool) -> Result<(), CommandError> {
        self.apply(&Command::SetMask { id, enabled }).map(|_| ())
    }

    /// Trusted snapshot hydration for explicit rich-text semantics. Legacy text
    /// nodes intentionally omit this record and use `TextProperties::default()`.
    pub fn seed_text_properties(
        &mut self,
        id: NodeId,
        properties: TextProperties,
    ) -> Result<(), CommandError> {
        let node = self
            .nodes
            .get(&id)
            .ok_or(CommandError::MissingNode { id })?;
        if !supports_text_properties(&node.kind)
            || !self.valid_text_properties(&node.text, &properties)
        {
            return Err(CommandError::InvalidTextProperties);
        }
        self.replace_text_properties(id, properties);
        Ok(())
    }

    /// Trusted Snapshot hydration for the versioned presence-bearing Paint
    /// Stack. This path does not create history, but applies the same validation
    /// and document budget rules as an ordinary command.
    pub fn seed_paint_stacks(
        &mut self,
        id: NodeId,
        fill_stack: Option<PaintStack>,
        stroke_stack: Option<PaintStack>,
    ) -> Result<(), CommandError> {
        self.validate_paint_stacks(id, fill_stack.as_ref(), stroke_stack.as_ref())?;
        self.replace_paint_stacks(id, fill_stack, stroke_stack)?;
        Ok(())
    }

    pub fn seed_paint_style_links(
        &mut self,
        id: NodeId,
        links: PaintStyleLinks,
    ) -> Result<(), CommandError> {
        self.validate_paint_style_links(id, &links)?;
        self.replace_paint_style_links(id, links)?;
        Ok(())
    }

    /// Trusted snapshot hydration for explicit Auto Layout input. Omitted
    /// records remain the stable default and are not materialized in the map.
    pub fn seed_auto_layout(&mut self, id: NodeId, layout: AutoLayout) -> Result<(), CommandError> {
        let node = self
            .nodes
            .get(&id)
            .ok_or(CommandError::MissingNode { id })?;
        if !valid_auto_layout(&layout)
            || (layout.mode != LayoutMode::None && !is_frame_like(&node.kind))
        {
            return Err(CommandError::InvalidAutoLayout);
        }
        self.replace_auto_layout_option(id, (layout != AutoLayout::default()).then_some(layout));
        Ok(())
    }

    /// Completes trusted projection hydration after every node and layout
    /// record has been installed.  Seed operations intentionally do not create
    /// history or advance the revision, but a newly created Auto Layout tree
    /// still needs the same deterministic geometry pass as a user transaction.
    /// Persisted snapshots deliberately do not call this: their stored geometry
    /// is already canonical and must continue to verify byte-for-byte.
    pub fn reflow_seeded_auto_layout(&mut self) -> Result<(), CommandError> {
        let dirty_frames = self
            .node_auto_layout
            .iter()
            .filter_map(|(id, layout)| (layout.mode != LayoutMode::None).then_some(*id))
            .collect();
        self.reflow_auto_layout(dirty_frames).map(|_| ())
    }

    pub fn seed_page(&mut self, page: Page) -> Result<(), CommandError> {
        if page.name.trim().is_empty() {
            return Err(CommandError::InvalidPageName);
        }
        if self.pages.contains_key(&page.id) {
            return Err(CommandError::DuplicatePage { id: page.id });
        }
        self.pages.insert(page.id, page);
        Ok(())
    }

    /// Closes the temporary structural-invariant window used while a trusted
    /// snapshot or seed batch is installed parent-before-child.
    pub fn validate_seeded_structure(&mut self) -> Result<(), CommandError> {
        self.ensure_non_empty_groups()
    }

    /// Replaces the deterministic default Page metadata while hydrating a
    /// trusted snapshot. The identity remains stable, but imported documents
    /// can preserve the source page name and ordering key without retaining a
    /// synthetic extra Page 1.
    pub fn seed_default_page(&mut self, page: Page) -> Result<(), CommandError> {
        if page.id != DEFAULT_PAGE_ID || page.name.trim().is_empty() {
            return Err(CommandError::InvalidPageName);
        }
        self.pages.insert(DEFAULT_PAGE_ID, page);
        Ok(())
    }

    /// Inserts a resource record while hydrating a verified snapshot. Attachment
    /// operations will be added with Image/Text node semantics; this registry is
    /// deliberately separate from raw bytes and cache lifetime.
    pub fn seed_asset(&mut self, asset: AssetReference) -> Result<(), CommandError> {
        self.insert_asset(asset)
    }

    /// Installs one verified style while hydrating a trusted snapshot.
    pub fn seed_text_style(&mut self, style: TextStyleResource) -> Result<(), CommandError> {
        self.insert_text_style(style)
    }

    /// Installs one verified PaintStyle while hydrating a trusted snapshot.
    pub fn seed_paint_style(&mut self, style: PaintStyleResource) -> Result<(), CommandError> {
        self.insert_paint_style(style)
    }

    pub fn seed_variable_collection(
        &mut self,
        collection: VariableCollectionResource,
    ) -> Result<(), CommandError> {
        self.insert_variable_collection(collection)
    }

    fn insert_variable_collection(
        &mut self,
        collection: VariableCollectionResource,
    ) -> Result<(), CommandError> {
        if self.variable_collections.contains_key(&collection.id) {
            return Err(CommandError::DuplicateVariableCollection { id: collection.id });
        }
        let bytes = collection.estimated_bytes();
        let mut mode_ids = BTreeSet::new();
        let valid = valid_resource_identity(
            &collection.id,
            &collection.key,
            &collection.name,
            collection.remote,
        ) && !collection.modes.is_empty()
            && collection.modes.len() <= MAX_VARIABLE_MODES
            && collection.modes.iter().all(|mode| {
                !mode.id.is_empty()
                    && mode.id.len() <= MAX_STYLE_ID_BYTES
                    && !mode.id.contains('\0')
                    && !mode.name.trim().is_empty()
                    && mode.name.len() <= MAX_STYLE_NAME_BYTES
                    && !mode.name.contains('\0')
                    && mode_ids.insert(mode.id.clone())
            })
            && mode_ids.contains(&collection.default_mode_id)
            && self.variable_collections.len() < MAX_VARIABLE_COLLECTIONS
            && self.variable_catalog_bytes.saturating_add(bytes) <= MAX_VARIABLE_CATALOG_BYTES;
        if !valid {
            return Err(CommandError::InvalidVariableCollection);
        }
        self.variable_catalog_bytes += bytes;
        self.variable_collections
            .insert(collection.id.clone(), collection);
        Ok(())
    }

    pub fn seed_variable(&mut self, variable: VariableResource) -> Result<(), CommandError> {
        self.insert_variable(variable, false)
    }

    fn insert_variable(
        &mut self,
        variable: VariableResource,
        require_resolved_aliases: bool,
    ) -> Result<(), CommandError> {
        if self.variables.contains_key(&variable.id) {
            return Err(CommandError::DuplicateVariable { id: variable.id });
        }
        let Some(collection) = self.variable_collections.get(&variable.collection_id) else {
            return Err(CommandError::InvalidVariable);
        };
        let bytes = variable.estimated_bytes();
        let modes: BTreeSet<&str> = collection
            .modes
            .iter()
            .map(|mode| mode.id.as_str())
            .collect();
        let values_valid = variable.values_by_mode.len() == modes.len()
            && variable.values_by_mode.iter().all(|(mode_id, value)| {
                modes.contains(mode_id.as_str())
                    && variable_value_matches(value, variable.resolved_type)
            });
        let scopes_valid = variable.scopes.len() <= MAX_VARIABLE_SCOPES
            && variable
                .scopes
                .iter()
                .all(|scope| !scope.is_empty() && scope.len() <= 128 && !scope.contains('\0'));
        let code_syntax_valid = variable.code_syntax.len() <= 3
            && variable.code_syntax.iter().all(|(platform, value)| {
                matches!(platform.as_str(), "WEB" | "ANDROID" | "iOS")
                    && !value.is_empty()
                    && !value.contains('\0')
            })
            && variable
                .code_syntax
                .iter()
                .map(|(platform, value)| platform.len() + value.len())
                .sum::<usize>()
                <= MAX_VARIABLE_CODE_SYNTAX_BYTES;
        let valid =
            valid_resource_identity(&variable.id, &variable.key, &variable.name, variable.remote)
                && variable.description.len() <= MAX_STYLE_DESCRIPTION_BYTES
                && !variable.description.contains('\0')
                && values_valid
                && scopes_valid
                && code_syntax_valid
                && self.variables.len() < MAX_VARIABLES
                && self.variable_catalog_bytes.saturating_add(bytes) <= MAX_VARIABLE_CATALOG_BYTES;
        if !valid {
            return Err(CommandError::InvalidVariable);
        }
        if require_resolved_aliases
            && variable.values_by_mode.values().any(|value| match value {
                VariableValue::Alias(target_id) => self
                    .variables
                    .get(target_id)
                    .is_none_or(|target| target.resolved_type != variable.resolved_type),
                _ => false,
            })
        {
            return Err(CommandError::InvalidVariable);
        }
        self.variable_catalog_bytes += bytes;
        self.variables.insert(variable.id.clone(), variable);
        Ok(())
    }

    fn replace_variable(
        &mut self,
        variable: VariableResource,
    ) -> Result<VariableResource, CommandError> {
        let Some(before) = self.variables.get(&variable.id).cloned() else {
            return Err(CommandError::InvalidVariable);
        };
        if before.remote
            || before.key != variable.key
            || before.remote != variable.remote
            || before.collection_id != variable.collection_id
            || before.resolved_type != variable.resolved_type
        {
            return Err(CommandError::InvalidVariable);
        }
        self.variables.remove(&before.id);
        self.variable_catalog_bytes = self
            .variable_catalog_bytes
            .saturating_sub(before.estimated_bytes());
        if let Err(error) = self.insert_variable(variable, true) {
            self.variable_catalog_bytes += before.estimated_bytes();
            self.variables.insert(before.id.clone(), before);
            return Err(error);
        }
        if let Err(error) = self.validate_variable_catalog() {
            let inserted = self
                .variables
                .remove(&before.id)
                .expect("inserted variable");
            self.variable_catalog_bytes = self
                .variable_catalog_bytes
                .saturating_sub(inserted.estimated_bytes());
            self.variable_catalog_bytes += before.estimated_bytes();
            self.variables.insert(before.id.clone(), before);
            return Err(error);
        }
        Ok(before)
    }

    fn remove_variable(&mut self, id: &str) -> Result<VariableResource, CommandError> {
        let Some(variable) = self.variables.get(id).cloned() else {
            return Err(CommandError::InvalidVariable);
        };
        if variable.remote {
            return Err(CommandError::InvalidVariable);
        }
        if self.variables.values().any(|candidate| {
            candidate.id != id
                && candidate.values_by_mode.values().any(
                    |value| matches!(value, VariableValue::Alias(target_id) if target_id == id),
                )
        }) {
            return Err(CommandError::InvalidVariable);
        }
        if self
            .text_styles
            .values()
            .any(|style| style.variable_bindings.values().any(|value| value == id))
        {
            return Err(CommandError::InvalidVariable);
        }
        if self.paint_styles.values().any(|style| {
            style
                .variable_bindings
                .iter()
                .any(|binding| binding.variable_id == id)
        }) {
            return Err(CommandError::InvalidVariable);
        }
        if self.node_text_properties.values().any(|properties| {
            properties.runs.iter().any(|run| {
                run.variable_bindings
                    .values()
                    .any(|variable_id| variable_id == id)
            }) || properties.base_style.as_ref().is_some_and(|style| {
                style
                    .variable_bindings
                    .values()
                    .any(|variable_id| variable_id == id)
            })
        }) {
            return Err(CommandError::InvalidVariable);
        }
        self.variables.remove(id);
        self.variable_catalog_bytes = self
            .variable_catalog_bytes
            .saturating_sub(variable.estimated_bytes());
        Ok(variable)
    }

    fn replace_variable_collection(
        &mut self,
        collection: VariableCollectionResource,
        variables: Vec<VariableResource>,
    ) -> Result<(VariableCollectionResource, Vec<VariableResource>), CommandError> {
        let Some(before) = self.variable_collections.get(&collection.id).cloned() else {
            return Err(CommandError::InvalidVariableCollection);
        };
        if before.remote
            || before.key != collection.key
            || before.remote != collection.remote
            || collection.remote
        {
            return Err(CommandError::InvalidVariableCollection);
        }
        let before_variables = self
            .variables
            .values()
            .filter(|variable| variable.collection_id == collection.id)
            .cloned()
            .collect::<Vec<_>>();
        let expected = before_variables
            .iter()
            .map(|variable| variable.id.as_str())
            .collect::<BTreeSet<_>>();
        let supplied = variables
            .iter()
            .map(|variable| variable.id.as_str())
            .collect::<BTreeSet<_>>();
        if expected != supplied
            || variables.len() != expected.len()
            || variables.iter().any(|variable| {
                let Some(previous) = before_variables.iter().find(|item| item.id == variable.id)
                else {
                    return true;
                };
                variable.key != previous.key
                    || variable.remote != previous.remote
                    || variable.collection_id != collection.id
                    || variable.resolved_type != previous.resolved_type
            })
        {
            return Err(CommandError::InvalidVariableCollection);
        }
        self.variable_collections.remove(&before.id);
        self.variable_catalog_bytes = self
            .variable_catalog_bytes
            .saturating_sub(before.estimated_bytes());
        for variable in &before_variables {
            self.variables.remove(&variable.id);
            self.variable_catalog_bytes = self
                .variable_catalog_bytes
                .saturating_sub(variable.estimated_bytes());
        }
        self.insert_variable_collection(collection)?;
        for variable in variables {
            self.insert_variable(variable, false)?;
        }
        self.validate_variable_catalog()?;
        Ok((before, before_variables))
    }

    fn remove_variable_collection(
        &mut self,
        id: &str,
    ) -> Result<(VariableCollectionResource, Vec<VariableResource>), CommandError> {
        let Some(collection) = self.variable_collections.get(id).cloned() else {
            return Err(CommandError::InvalidVariableCollection);
        };
        if collection.remote {
            return Err(CommandError::InvalidVariableCollection);
        }
        let variables = self
            .variables
            .values()
            .filter(|variable| variable.collection_id == id)
            .cloned()
            .collect::<Vec<_>>();
        let removed_ids = variables
            .iter()
            .map(|variable| variable.id.as_str())
            .collect::<BTreeSet<_>>();
        if self.variables.values().any(|candidate| {
            candidate.collection_id != id
                && candidate.values_by_mode.values().any(
                    |value| matches!(value, VariableValue::Alias(target_id) if removed_ids.contains(target_id.as_str())),
                )
        }) {
            return Err(CommandError::InvalidVariableCollection);
        }
        if self.text_styles.values().any(|style| {
            style
                .variable_bindings
                .values()
                .any(|value| removed_ids.contains(value.as_str()))
        }) {
            return Err(CommandError::InvalidVariableCollection);
        }
        if self.paint_styles.values().any(|style| {
            style
                .variable_bindings
                .iter()
                .any(|binding| removed_ids.contains(binding.variable_id.as_str()))
        }) {
            return Err(CommandError::InvalidVariableCollection);
        }
        if self.node_text_properties.values().any(|properties| {
            properties.runs.iter().any(|run| {
                run.variable_bindings
                    .values()
                    .any(|variable_id| removed_ids.contains(variable_id.as_str()))
            }) || properties.base_style.as_ref().is_some_and(|style| {
                style
                    .variable_bindings
                    .values()
                    .any(|variable_id| removed_ids.contains(variable_id.as_str()))
            })
        }) {
            return Err(CommandError::InvalidVariableCollection);
        }
        for variable in &variables {
            self.variables.remove(&variable.id);
            self.variable_catalog_bytes = self
                .variable_catalog_bytes
                .saturating_sub(variable.estimated_bytes());
        }
        self.variable_collections.remove(id);
        self.variable_catalog_bytes = self
            .variable_catalog_bytes
            .saturating_sub(collection.estimated_bytes());
        Ok((collection, variables))
    }

    fn restore_variable_collection_state(
        &mut self,
        old_collection: &VariableCollectionResource,
        old_variables: &[VariableResource],
        collection: &VariableCollectionResource,
        variables: &[VariableResource],
    ) {
        self.remove_variable_collection_state(old_collection, old_variables);
        self.install_variable_collection_state(collection, variables);
    }

    fn install_variable_collection_state(
        &mut self,
        collection: &VariableCollectionResource,
        variables: &[VariableResource],
    ) {
        self.variable_catalog_bytes += collection.estimated_bytes();
        self.variable_collections
            .insert(collection.id.clone(), collection.clone());
        for variable in variables {
            self.variable_catalog_bytes += variable.estimated_bytes();
            self.variables.insert(variable.id.clone(), variable.clone());
        }
    }

    fn remove_variable_collection_state(
        &mut self,
        collection: &VariableCollectionResource,
        variables: &[VariableResource],
    ) {
        self.variable_collections.remove(&collection.id);
        self.variable_catalog_bytes = self
            .variable_catalog_bytes
            .saturating_sub(collection.estimated_bytes());
        for variable in variables {
            self.variables.remove(&variable.id);
            self.variable_catalog_bytes = self
                .variable_catalog_bytes
                .saturating_sub(variable.estimated_bytes());
        }
    }

    pub fn validate_variable_catalog(&self) -> Result<(), CommandError> {
        for variable in self.variables.values() {
            for value in variable.values_by_mode.values() {
                let VariableValue::Alias(target_id) = value else {
                    continue;
                };
                let Some(target) = self.variables.get(target_id) else {
                    return Err(CommandError::InvalidVariable);
                };
                if target.resolved_type != variable.resolved_type {
                    return Err(CommandError::InvalidVariable);
                }
            }
        }
        let mut colors = BTreeMap::<&str, u8>::new();
        for start in self.variables.keys() {
            let mut stack = vec![(start.as_str(), false)];
            while let Some((id, exiting)) = stack.pop() {
                if exiting {
                    colors.insert(id, 2);
                    continue;
                }
                match colors.get(id).copied().unwrap_or(0) {
                    2 => continue,
                    1 => return Err(CommandError::InvalidVariable),
                    _ => {}
                }
                colors.insert(id, 1);
                stack.push((id, true));
                let variable = self
                    .variables
                    .get(id)
                    .ok_or(CommandError::InvalidVariable)?;
                for value in variable.values_by_mode.values() {
                    if let VariableValue::Alias(target_id) = value {
                        stack.push((target_id.as_str(), false));
                    }
                }
            }
        }
        Ok(())
    }

    fn insert_paint_style(&mut self, style: PaintStyleResource) -> Result<(), CommandError> {
        if self.paint_styles.contains_key(&style.id) {
            return Err(CommandError::DuplicatePaintStyle { id: style.id });
        }
        if self.text_styles.contains_key(&style.id) {
            return Err(CommandError::InvalidPaintStyle);
        }
        let bytes = style.estimated_bytes();
        let valid_identity = !style.id.is_empty()
            && style.id.len() <= MAX_STYLE_ID_BYTES
            && !style.id.contains('\0')
            && style.key.len() <= MAX_STYLE_KEY_BYTES
            && !style.key.contains('\0')
            && (!style.remote || !style.key.is_empty())
            && !style.name.trim().is_empty()
            && style.name.len() <= MAX_STYLE_NAME_BYTES
            && !style.name.contains('\0')
            && style.description.len() <= MAX_STYLE_DESCRIPTION_BYTES
            && !style.description.contains('\0')
            && style.description_markdown.len() <= MAX_STYLE_DESCRIPTION_BYTES
            && !style.description_markdown.contains('\0')
            && valid_style_documentation_links(&style.documentation_links);
        let valid_assets = style.paints.layers.iter().all(|layer| match layer.paint {
            PaintLayerKind::Image(image) => self
                .assets
                .get(&image.asset_id)
                .is_some_and(|asset| asset.media_type.starts_with("image/")),
            _ => true,
        });
        if !valid_identity
            || !style.paints.is_valid()
            || !valid_assets
            || !self.valid_paint_style_variable_bindings(&style)
            || bytes > MAX_PAINT_STYLE_RESOURCE_BYTES
            || self.paint_styles.len() >= MAX_PAINT_STYLE_RESOURCES
            || self.paint_style_bytes.saturating_add(bytes) > MAX_PAINT_STYLE_CATALOG_BYTES
        {
            return Err(CommandError::InvalidPaintStyle);
        }
        self.paint_style_bytes += bytes;
        self.paint_styles.insert(style.id.clone(), style);
        Ok(())
    }

    fn valid_text_style_resource(&self, style: &TextStyleResource) -> bool {
        let mut properties = TextProperties::default();
        properties.paragraph = style.paragraph.clone();
        properties.base_style = Some(style.style.clone());
        let valid_identity = !style.id.is_empty()
            && style.id.len() <= MAX_STYLE_ID_BYTES
            && !style.id.contains('\0')
            && style.key.len() <= MAX_STYLE_KEY_BYTES
            && !style.key.contains('\0')
            && (!style.remote || !style.key.is_empty())
            && !style.name.trim().is_empty()
            && style.name.len() <= MAX_STYLE_NAME_BYTES
            && !style.name.contains('\0')
            && style.description.len() <= MAX_STYLE_DESCRIPTION_BYTES
            && !style.description.contains('\0')
            && style.description_markdown.len() <= MAX_STYLE_DESCRIPTION_BYTES
            && !style.description_markdown.contains('\0')
            && valid_style_documentation_links(&style.documentation_links);
        valid_identity
            && style.style.start == 0
            && style.style.end == 0
            && style.style.text_style_id.is_none()
            && style.style.paint_style_id.is_none()
            && style.style.hyperlink.is_none()
            && (style.letter_spacing_unit != Some(TextStyleLetterSpacingUnit::Percent)
                || (-100.0..=10_000.0).contains(&style.style.letter_spacing))
            && self.valid_text_style_variable_bindings(&style.variable_bindings)
            && self.valid_text_properties("", &properties)
    }

    fn insert_text_style(&mut self, style: TextStyleResource) -> Result<(), CommandError> {
        if self.text_styles.contains_key(&style.id) {
            return Err(CommandError::DuplicateTextStyle { id: style.id });
        }
        if self.paint_styles.contains_key(&style.id) {
            return Err(CommandError::InvalidTextStyle);
        }
        let bytes = style.estimated_bytes();
        if !self.valid_text_style_resource(&style)
            || bytes > MAX_TEXT_STYLE_RESOURCE_BYTES
            || self.text_styles.len() >= MAX_TEXT_STYLE_RESOURCES
            || self.text_style_bytes.saturating_add(bytes) > MAX_TEXT_STYLE_CATALOG_BYTES
        {
            return Err(CommandError::InvalidTextStyle);
        }
        self.text_style_bytes += bytes;
        self.text_styles.insert(style.id.clone(), style);
        Ok(())
    }

    fn replace_text_style(
        &mut self,
        style: TextStyleResource,
    ) -> Result<TextStyleResource, CommandError> {
        let before = self
            .text_styles
            .get(&style.id)
            .cloned()
            .ok_or(CommandError::InvalidTextStyle)?;
        if before.remote || style.remote || before.key != style.key {
            return Err(CommandError::InvalidTextStyle);
        }
        let bytes = style.estimated_bytes();
        let next_catalog_bytes = self
            .text_style_bytes
            .saturating_sub(before.estimated_bytes())
            .saturating_add(bytes);
        if !self.valid_text_style_resource(&style)
            || bytes > MAX_TEXT_STYLE_RESOURCE_BYTES
            || next_catalog_bytes > MAX_TEXT_STYLE_CATALOG_BYTES
        {
            return Err(CommandError::InvalidTextStyle);
        }
        self.text_style_bytes = next_catalog_bytes;
        self.text_styles.insert(style.id.clone(), style);
        Ok(before)
    }

    fn remove_text_style(&mut self, id: &str) -> Result<TextStyleResource, CommandError> {
        let style = self
            .text_styles
            .get(id)
            .cloned()
            .ok_or(CommandError::InvalidTextStyle)?;
        if style.remote || self.text_style_is_referenced(id) {
            return Err(CommandError::InvalidTextStyle);
        }
        self.text_styles.remove(id);
        self.text_style_bytes = self
            .text_style_bytes
            .saturating_sub(style.estimated_bytes());
        Ok(style)
    }

    fn replace_paint_style(
        &mut self,
        style: PaintStyleResource,
    ) -> Result<PaintStyleResource, CommandError> {
        let before = self
            .paint_styles
            .get(&style.id)
            .cloned()
            .ok_or(CommandError::InvalidPaintStyle)?;
        if before.remote || style.remote || before.key != style.key {
            return Err(CommandError::InvalidPaintStyle);
        }
        self.paint_styles.remove(&style.id);
        self.paint_style_bytes = self
            .paint_style_bytes
            .saturating_sub(before.estimated_bytes());
        self.insert_paint_style(style)?;
        Ok(before)
    }

    fn remove_paint_style(&mut self, id: &str) -> Result<PaintStyleResource, CommandError> {
        let style = self
            .paint_styles
            .get(id)
            .cloned()
            .ok_or(CommandError::InvalidPaintStyle)?;
        if style.remote || self.paint_style_is_referenced(id) {
            return Err(CommandError::InvalidPaintStyle);
        }
        self.paint_styles.remove(id);
        self.paint_style_bytes = self
            .paint_style_bytes
            .saturating_sub(style.estimated_bytes());
        Ok(style)
    }

    fn text_style_is_referenced(&self, id: &str) -> bool {
        self.node_text_properties.values().any(|properties| {
            properties
                .runs
                .iter()
                .any(|run| run.text_style_id.as_deref() == Some(id))
                || properties
                    .base_style
                    .as_ref()
                    .is_some_and(|style| style.text_style_id.as_deref() == Some(id))
        })
    }

    fn paint_style_is_referenced(&self, id: &str) -> bool {
        self.node_paint_style_links.values().any(|links| {
            links.fill.as_deref() == Some(id)
                || links.stroke.as_deref() == Some(id)
                || links.background.as_deref() == Some(id)
        }) || self.node_text_properties.values().any(|properties| {
            properties
                .runs
                .iter()
                .any(|run| run.paint_style_id.as_deref() == Some(id))
                || properties
                    .base_style
                    .as_ref()
                    .is_some_and(|style| style.paint_style_id.as_deref() == Some(id))
        })
    }

    fn insert_asset(&mut self, asset: AssetReference) -> Result<(), CommandError> {
        let valid_font_faces = asset.font_faces.len() <= 16
            && asset.font_faces.iter().enumerate().all(|(index, face)| {
                face.face_index as usize == index
                    && valid_font_metadata_name(&face.family)
                    && valid_font_metadata_name(&face.style)
                    && face.aliases.len() <= 64
                    && face.aliases.iter().all(|alias| {
                        valid_font_metadata_name(&alias.family)
                            && valid_font_metadata_name(&alias.style)
                            && (alias.family.as_str(), alias.style.as_str())
                                != (face.family.as_str(), face.style.as_str())
                    })
                    && face.aliases.windows(2).all(|pair| {
                        (pair[0].family.as_str(), pair[0].style.as_str())
                            < (pair[1].family.as_str(), pair[1].style.as_str())
                    })
            });
        if asset.media_type.trim().is_empty()
            || asset.byte_length == 0
            || asset.content_hash == [0; 32]
            || matches!(asset.dimensions, Some([0, _] | [_, 0]))
            || !valid_font_faces
            || (!asset.font_faces.is_empty() && !asset.media_type.starts_with("font/"))
        {
            return Err(CommandError::InvalidAsset);
        }
        if self.assets.contains_key(&asset.asset_id) {
            return Err(CommandError::DuplicateAsset { id: asset.asset_id });
        }
        self.assets.insert(asset.asset_id, asset);
        Ok(())
    }

    /// Restores an ID tombstone from a trusted snapshot. A tombstone is semantic
    /// document state: omitting it would let a refresh silently reuse a deleted ID.
    pub fn seed_retired_id(&mut self, id: NodeId) -> Result<(), CommandError> {
        if self.nodes.contains_key(&id) {
            return Err(CommandError::DuplicateNode { id });
        }
        self.retired_ids.insert(id);
        Ok(())
    }

    /// Resolves and applies a user intent atomically. Any rejected command leaves the
    /// document, revision and emitted history untouched.
    pub fn submit(
        &mut self,
        transaction: Transaction,
        origin: Origin,
    ) -> Result<AppliedTransaction, CommandError> {
        if let Some(applied) = self.validate_transaction_request(&transaction)? {
            return Ok(applied);
        }
        let mut next = self.clone();
        let applied = next.apply_transaction_in_place(transaction, origin, self)?;
        *self = next;
        Ok(applied)
    }

    fn validate_transaction_request(
        &self,
        transaction: &Transaction,
    ) -> Result<Option<AppliedTransaction>, CommandError> {
        if let Some(previous) = self.accepted_transactions.get(&transaction.id) {
            return if &previous.transaction == transaction {
                Ok(Some(previous.applied.clone()))
            } else {
                Err(CommandError::TransactionIdConflict { id: transaction.id })
            };
        }
        if transaction.base_revision != self.revision {
            return Err(CommandError::RevisionConflict {
                expected: self.revision,
                actual: transaction.base_revision,
            });
        }
        if transaction.commands.is_empty() {
            return Err(CommandError::EmptyTransaction);
        }
        if transaction.commands.len() > MAX_TRANSACTION_COMMANDS
            || transaction.estimated_bytes() > MAX_TRANSACTION_BYTES
        {
            return Err(CommandError::ResourceLimit);
        }
        Ok(None)
    }

    /// Mutates only a private candidate owned by `submit` or `submit_operation`.
    /// Any error discards that candidate before it can become observable.
    fn apply_transaction_in_place(
        &mut self,
        transaction: Transaction,
        origin: Origin,
        confirmed: &Document,
    ) -> Result<AppliedTransaction, CommandError> {
        let mut changes = Vec::with_capacity(transaction.commands.len());
        for command in &transaction.commands {
            changes.push(self.apply(command)?);
        }
        changes.extend(
            self.reflow_auto_layout(
                self.auto_layout_dirty_frames(&transaction.commands, confirmed),
            )?,
        );
        self.ensure_non_empty_groups()?;
        self.revision += 1;
        let accepted_revision = self.revision;
        let history_item = HistoryItem {
            transaction_id: transaction.id,
            origin,
            base_revision: transaction.base_revision,
            accepted_revision,
            changes,
        };
        if origin == Origin::LocalUser && history_item.estimated_bytes() > MAX_HISTORY_BYTES {
            return Err(CommandError::ResourceLimit);
        }
        if origin == Origin::LocalUser {
            self.push_undo(history_item.clone());
            self.clear_redo();
        }
        let applied = AppliedTransaction {
            transaction_id: transaction.id,
            accepted_revision,
            history_item,
        };
        self.insert_accepted_transaction(
            transaction.id,
            AcceptedTransactionRecord {
                transaction,
                applied: applied.clone(),
            },
        );
        Ok(applied)
    }

    /// Applies a resolved collaboration operation through the exact same reducer as
    /// a local transaction. A retry with an identical operation ID is a no-op; a
    /// reused ID with a different envelope is rejected before any mutation.
    pub fn submit_operation(
        &mut self,
        operation: OperationEnvelope,
        origin: Origin,
    ) -> Result<AppliedOperation, CommandError> {
        let operation = operation.canonicalized();
        operation.validate_for(self.id)?;
        let fingerprint = operation.fingerprint();
        if let Some(previous) = self.accepted_operations.get(&operation.operation_id) {
            return if previous.fingerprint == fingerprint {
                Ok(previous.applied.clone())
            } else {
                Err(CommandError::OperationIdConflict {
                    id: operation.operation_id,
                })
            };
        }
        if operation.estimated_bytes() > MAX_OPERATION_DEDUPE_BYTES {
            return Err(CommandError::ResourceLimit);
        }

        let accepted_transaction = self.validate_transaction_request(&operation.transaction)?;
        let mut next = self.clone();
        let accepted_transaction = match accepted_transaction {
            Some(applied) => applied,
            None => next.apply_transaction_in_place(operation.transaction.clone(), origin, self)?,
        };
        let applied = AppliedOperation {
            operation_id: operation.operation_id,
            transaction_id: operation.transaction_id,
            accepted_revision: accepted_transaction.accepted_revision,
            payload_hash: operation.payload_hash,
        };
        let operation_bytes = operation.estimated_bytes();
        next.insert_accepted_operation(
            operation.operation_id,
            AcceptedOperationRecord {
                fingerprint,
                applied: applied.clone(),
                estimated_bytes: operation_bytes,
            },
        );
        *self = next;
        Ok(applied)
    }

    /// Replays the inverse of the latest local user intent. Revisions remain monotonic:
    /// undo and redo are new accepted document states, never a rewind of revision.
    pub fn undo(&mut self) -> Option<u64> {
        let item = self.undo_stack.pop_back()?;
        self.undo_bytes = self.undo_bytes.saturating_sub(item.estimated_bytes());
        for change in item.changes.iter().rev() {
            self.apply_inverse(change);
        }
        self.ensure_non_empty_groups()
            .expect("accepted history must restore a valid structure");
        self.revision += 1;
        self.push_redo(item);
        Some(self.revision)
    }

    pub fn redo(&mut self) -> Option<u64> {
        let item = self.redo_stack.pop_back()?;
        self.redo_bytes = self.redo_bytes.saturating_sub(item.estimated_bytes());
        for change in &item.changes {
            self.apply_forward(change);
        }
        self.ensure_non_empty_groups()
            .expect("accepted history must replay a valid structure");
        self.revision += 1;
        self.push_undo(item);
        Some(self.revision)
    }

    fn clear_redo(&mut self) {
        self.redo_stack.clear();
        self.redo_bytes = 0;
    }

    fn push_undo(&mut self, item: impl Into<Arc<HistoryItem>>) {
        let item = item.into();
        self.undo_bytes += item.estimated_bytes();
        self.undo_stack.push_back(item);
        while self.undo_stack.len() > MAX_HISTORY_ITEMS || self.undo_bytes > MAX_HISTORY_BYTES {
            if let Some(discarded) = self.undo_stack.front() {
                self.undo_bytes = self.undo_bytes.saturating_sub(discarded.estimated_bytes());
            }
            self.undo_stack.pop_front();
        }
    }

    fn push_redo(&mut self, item: impl Into<Arc<HistoryItem>>) {
        let item = item.into();
        self.redo_bytes += item.estimated_bytes();
        self.redo_stack.push_back(item);
        while self.redo_stack.len() > MAX_HISTORY_ITEMS || self.redo_bytes > MAX_HISTORY_BYTES {
            if let Some(discarded) = self.redo_stack.front() {
                self.redo_bytes = self.redo_bytes.saturating_sub(discarded.estimated_bytes());
            }
            self.redo_stack.pop_front();
        }
    }

    fn insert_accepted_transaction(
        &mut self,
        id: TransactionId,
        record: AcceptedTransactionRecord,
    ) {
        self.accepted_transaction_bytes += record.estimated_bytes();
        self.accepted_transactions.insert(id, Arc::new(record));
        self.accepted_transaction_order.push_back(id);
        while self.accepted_transactions.len() > MAX_DEDUPE_ITEMS
            || self.accepted_transaction_bytes > MAX_DEDUPE_BYTES
        {
            let Some(expired_id) = self.accepted_transaction_order.pop_front() else {
                break;
            };
            if let Some(expired) = self.accepted_transactions.remove(&expired_id) {
                self.accepted_transaction_bytes = self
                    .accepted_transaction_bytes
                    .saturating_sub(expired.estimated_bytes());
            }
        }
    }

    fn insert_accepted_operation(&mut self, id: OperationId, record: AcceptedOperationRecord) {
        self.accepted_operation_bytes += record.estimated_bytes;
        self.accepted_operations.insert(id, Arc::new(record));
        self.accepted_operation_order.push_back(id);
        while self.accepted_operations.len() > MAX_OPERATION_DEDUPE_ITEMS
            || self.accepted_operation_bytes > MAX_OPERATION_DEDUPE_BYTES
        {
            let Some(expired_id) = self.accepted_operation_order.pop_front() else {
                break;
            };
            if let Some(expired) = self.accepted_operations.remove(&expired_id) {
                self.accepted_operation_bytes = self
                    .accepted_operation_bytes
                    .saturating_sub(expired.estimated_bytes);
            }
        }
    }

    fn apply(&mut self, command: &Command) -> Result<AppliedChange, CommandError> {
        match command {
            Command::RegisterTextStyle { style } => {
                self.insert_text_style(style.clone())?;
                Ok(AppliedChange::TextStyleRegistered {
                    style: style.clone(),
                })
            }
            Command::RegisterPaintStyle { style } => {
                self.insert_paint_style(style.clone())?;
                Ok(AppliedChange::PaintStyleRegistered {
                    style: style.clone(),
                })
            }
            Command::SetTextStyle { style } => {
                let before = self.replace_text_style(style.clone())?;
                Ok(AppliedChange::TextStyleChanged {
                    before,
                    after: style.clone(),
                })
            }
            Command::DeleteTextStyle { id } => {
                let style = self.remove_text_style(id)?;
                Ok(AppliedChange::TextStyleDeleted { style })
            }
            Command::SetPaintStyle { style } => {
                let before = self.replace_paint_style(style.clone())?;
                Ok(AppliedChange::PaintStyleChanged {
                    before,
                    after: style.clone(),
                })
            }
            Command::DeletePaintStyle { id } => {
                let style = self.remove_paint_style(id)?;
                Ok(AppliedChange::PaintStyleDeleted { style })
            }
            _ => self.apply_non_style_command(command),
        }
    }

    fn apply_non_style_command(
        &mut self,
        command: &Command,
    ) -> Result<AppliedChange, CommandError> {
        match command {
            Command::CreatePage(page) => {
                if page.name.trim().is_empty() {
                    return Err(CommandError::InvalidPageName);
                }
                if self.pages.contains_key(&page.id) {
                    return Err(CommandError::DuplicatePage { id: page.id });
                }
                self.pages.insert(page.id, page.clone());
                Ok(AppliedChange::PageCreated { page: page.clone() })
            }
            Command::CreateInPage { page_id, node } => {
                self.assert_parent_mutable(node.parent_id)?;
                self.create_node_in_page(*page_id, node.clone())
            }
            Command::CreateImageInPage {
                page_id,
                node,
                asset_id,
            } => {
                self.assert_parent_mutable(node.parent_id)?;
                self.create_image_node_in_page(*page_id, node.clone(), *asset_id)
            }
            Command::RestoreNode {
                page_id,
                node,
                asset_id,
                text_properties,
            } => {
                self.assert_parent_mutable(node.parent_id)?;
                self.restore_tombstoned_node(
                    *page_id,
                    node.clone(),
                    *asset_id,
                    text_properties.clone(),
                )
            }
            Command::Create(node) => {
                self.assert_parent_mutable(node.parent_id)?;
                self.create_node_in_page(DEFAULT_PAGE_ID, node.clone())
            }
            command @ (Command::UpdateGeometry {
                id,
                x,
                y,
                width,
                height,
                rotation,
            }
            | Command::UpdateGeometryWithoutConstraints {
                id,
                x,
                y,
                width,
                height,
                rotation,
            }) => {
                let ignore_constraints =
                    matches!(command, Command::UpdateGeometryWithoutConstraints { .. });
                self.assert_mutable(*id)?;
                let after = Geometry {
                    x: *x,
                    y: *y,
                    width: *width,
                    height: *height,
                    rotation: *rotation,
                };
                let kind = self
                    .nodes
                    .get(id)
                    .map(|node| node.kind.clone())
                    .ok_or(CommandError::MissingNode { id: *id })?;
                // A Group's dimensions remain derived from its children, but a
                // direct translation is the canonical way to move a modern
                // Relative-v1 Group subtree. Resizing or rotating a Group is
                // still invalid: it would turn derived bounds into authored
                // geometry.
                let group_translation = if kind == NodeKind::Group {
                    // Relative-v1 Groups receive their content-derived bounds
                    // together with their authoritative matrix in one complete
                    // worker payload. Their scalar geometry is the compatibility
                    // projection of that matrix, so width/height may legitimately
                    // change while a child is moved. Legacy Groups retain the
                    // historical translation-only gate until they are migrated.
                    let relative_group_bounds = self
                        .nodes
                        .get(id)
                        .is_some_and(|node| node.relative_transform.is_some())
                        && after.x.is_finite()
                        && after.y.is_finite()
                        && after.width.is_finite()
                        && after.height.is_finite()
                        && after.width > 0.0
                        && after.height > 0.0
                        && after.rotation.is_finite();
                    relative_group_bounds
                        || self.geometry_for(*id).is_some_and(|before| {
                            after.x.is_finite()
                                && after.y.is_finite()
                                && after.width == before.width
                                && after.height == before.height
                                && after.rotation == 0.0
                        })
                } else {
                    false
                };
                if !(group_translation || valid_geometry(&kind, after)) {
                    return Err(CommandError::InvalidGeometry);
                }
                let frame_before = self.geometry_for(*id);
                let constrained_children = if is_frame_like(&kind)
                    && !ignore_constraints
                    && after.rotation == 0.0
                    && self.nodes.get(id).is_some_and(|node| {
                        node.relative_transform.is_none() && node.rotation == 0.0
                    }) {
                    let before = frame_before.expect("existing node has geometry");
                    self.nodes
                        .values()
                        .filter(|child| {
                            if !self.constraints_apply_for_child(*id, child.id) {
                                return false;
                            }
                            if child.relative_transform.is_some() {
                                return false;
                            }
                            let mut parent_id = child.parent_id;
                            while let Some(ancestor_id) = parent_id {
                                if ancestor_id == *id {
                                    return true;
                                }
                                let Some(ancestor) = self.nodes.get(&ancestor_id) else {
                                    return false;
                                };
                                if !is_structural_container(&ancestor.kind) {
                                    return false;
                                }
                                parent_id = ancestor.parent_id;
                            }
                            false
                        })
                        .filter_map(|child| {
                            effective_constraints(child).map(|constraints| {
                                geometry_for_constraints(
                                    before,
                                    after,
                                    Geometry {
                                        x: child.x,
                                        y: child.y,
                                        width: child.width,
                                        height: child.height,
                                        rotation: child.rotation,
                                    },
                                    constraints,
                                    &child.kind,
                                )
                                .map(|geometry| (child.id, geometry))
                            })
                        })
                        .collect::<Result<Vec<_>, _>>()?
                } else {
                    Vec::new()
                };
                // Relative-v1 nodes already live in their Frame's local space,
                // including below one or more transformed Groups. Unlike legacy
                // world-space coordinates, their constraints remain correct when
                // the Frame itself is rotated or has an arbitrary affine matrix.
                let mut matrix_constrained_children = if is_frame_like(&kind) && !ignore_constraints
                {
                    let frame_before_local = Geometry {
                        x: 0.0,
                        y: 0.0,
                        width: frame_before.expect("existing node has geometry").width,
                        height: frame_before.expect("existing node has geometry").height,
                        rotation: 0.0,
                    };
                    let frame_after_local = Geometry {
                        x: 0.0,
                        y: 0.0,
                        width: after.width,
                        height: after.height,
                        rotation: 0.0,
                    };
                    self.nodes
                        .values()
                        .filter_map(|child| {
                            if !self.constraints_apply_for_child(*id, child.id) {
                                return None;
                            }
                            let constraints = effective_constraints(child)?;
                            let (child_to_frame, parent_to_frame) =
                                self.relative_transform_to_frame(child.id, *id)?;
                            let child_before = Geometry {
                                x: child_to_frame.e,
                                y: child_to_frame.f,
                                width: child.width,
                                height: child.height,
                                rotation: child.rotation,
                            };
                            Some(
                                geometry_for_constraints(
                                    frame_before_local,
                                    frame_after_local,
                                    child_before,
                                    constraints,
                                    &child.kind,
                                )
                                .and_then(|child_after_local| {
                                    let child_to_frame_after = AffineTransform {
                                        e: child_after_local.x,
                                        f: child_after_local.y,
                                        ..child_to_frame
                                    };
                                    let child_after_transform = child_to_frame_after.then(
                                        parent_to_frame
                                            .inverse()
                                            .map_err(|_| CommandError::InvalidGeometry)?,
                                    );
                                    let child_after_geometry = geometry_for_relative_transform(
                                        child_after_transform,
                                        child_after_local.width,
                                        child_after_local.height,
                                        &child.kind,
                                    )?;
                                    Ok((child.id, child_after_geometry, child_after_transform))
                                }),
                            )
                        })
                        .collect::<Result<Vec<_>, _>>()?
                } else {
                    Vec::new()
                };
                // Legacy direct Frame children historically store world-space
                // geometry.  Leaving them on that projection when a Frame is
                // rotated or matrix-backed silently made an Inspector-visible
                // constraint a no-op.  At this transaction boundary their
                // current world transform is unambiguous, so migrate it once
                // into the Frame's local Relative-v1 space and apply exactly
                // the same per-axis rule as modern children.  Group paths are
                // intentionally not guessed here: a legacy Group has derived
                // world bounds and must be migrated as a complete subtree.
                if is_frame_like(&kind) && !ignore_constraints && constrained_children.is_empty() {
                    let frame_before_transform = self
                        .node_world_transform(*id)
                        .ok_or(CommandError::InvalidGeometry)?;
                    let frame_inverse = frame_before_transform
                        .inverse()
                        .map_err(|_| CommandError::InvalidGeometry)?;
                    let frame_before_local = Geometry {
                        x: 0.0,
                        y: 0.0,
                        width: frame_before.expect("existing node has geometry").width,
                        height: frame_before.expect("existing node has geometry").height,
                        rotation: 0.0,
                    };
                    let frame_after_local = Geometry {
                        x: 0.0,
                        y: 0.0,
                        width: after.width,
                        height: after.height,
                        rotation: 0.0,
                    };
                    let legacy_direct = self
                        .child_ids_for(*id)
                        .into_iter()
                        .filter_map(|child_id| {
                            if !self.constraints_apply_for_child(*id, child_id) {
                                return None;
                            }
                            let child = self.nodes.get(&child_id)?;
                            let constraints = effective_constraints(child)?;
                            child
                                .relative_transform
                                .is_none()
                                .then_some((child, constraints))
                        })
                        .map(|(child, constraints)| {
                            let child_to_frame = node_legacy_transform(child)
                                .ok_or(CommandError::InvalidGeometry)?
                                .then(frame_inverse);
                            let child_before = Geometry {
                                x: child_to_frame.e,
                                y: child_to_frame.f,
                                width: child.width,
                                height: child.height,
                                rotation: child_to_frame.b.atan2(child_to_frame.a).to_degrees(),
                            };
                            let child_after_local = geometry_for_constraints(
                                frame_before_local,
                                frame_after_local,
                                child_before,
                                constraints,
                                &child.kind,
                            )?;
                            let child_after_transform = AffineTransform {
                                e: child_after_local.x,
                                f: child_after_local.y,
                                ..child_to_frame
                            };
                            let child_after_geometry = geometry_for_relative_transform(
                                child_after_transform,
                                child_after_local.width,
                                child_after_local.height,
                                &child.kind,
                            )?;
                            Ok((child.id, child_after_geometry, child_after_transform))
                        })
                        .collect::<Result<Vec<_>, CommandError>>()?;
                    matrix_constrained_children.extend(legacy_direct);

                    // A legacy Group's scalar geometry is a derived world-space
                    // envelope, so treating only its constrained leaf as a direct
                    // Frame child would break the relationship as soon as the
                    // Frame is rotated. Migrate every legacy Group subtree in
                    // parent-before-child order. Each legacy link first becomes
                    // Frame-local from its old world transform; it is then made
                    // relative to its immediate (possibly just-migrated) Group.
                    // This preserves unconstrained siblings while allowing a
                    // constrained leaf to use the same Frame-local rule as a
                    // modern Relative-v1 subtree.
                    let mut local_to_frame = BTreeMap::new();
                    local_to_frame.insert(*id, AffineTransform::IDENTITY);
                    let mut pending = self
                        .child_ids_for(*id)
                        .into_iter()
                        .filter(|child_id| {
                            self.constraints_apply_for_child(*id, *child_id)
                                && self.nodes.get(child_id).is_some_and(|node| {
                                    node.kind == NodeKind::Group
                                        && node.relative_transform.is_none()
                                })
                        })
                        .collect::<Vec<_>>();
                    let mut legacy_group_subtree = Vec::new();
                    while let Some(child_id) = pending.pop() {
                        let child = self
                            .nodes
                            .get(&child_id)
                            .ok_or(CommandError::MissingNode { id: child_id })?;
                        // A nested Frame/Section/Boolean owns a fresh layout or
                        // structural context. Its legacy descendants are not a
                        // transparent Group chain, so an outer Frame resize must
                        // leave that boundary untouched until its own migration
                        // transaction has an unambiguous local coordinate space.
                        if matches!(
                            child.kind,
                            NodeKind::Frame | NodeKind::Section | NodeKind::BooleanOperation
                        ) && self.has_children(child_id)
                        {
                            continue;
                        }
                        let parent_id = child.parent_id.ok_or(CommandError::InvalidGeometry)?;
                        let parent_to_frame = *local_to_frame
                            .get(&parent_id)
                            .ok_or(CommandError::InvalidGeometry)?;
                        let child_to_frame = match child.relative_transform {
                            Some(local) => local.then(parent_to_frame),
                            None => node_legacy_transform(child)
                                .ok_or(CommandError::InvalidGeometry)?
                                .then(frame_inverse),
                        };
                        let child_before = Geometry {
                            x: child_to_frame.e,
                            y: child_to_frame.f,
                            width: child.width,
                            height: child.height,
                            rotation: child_to_frame.b.atan2(child_to_frame.a).to_degrees(),
                        };
                        let child_after_local = effective_constraints(child)
                            .map(|constraints| {
                                geometry_for_constraints(
                                    frame_before_local,
                                    frame_after_local,
                                    child_before,
                                    constraints,
                                    &child.kind,
                                )
                            })
                            .transpose()?
                            .unwrap_or(child_before);
                        let child_to_frame_after = AffineTransform {
                            e: child_after_local.x,
                            f: child_after_local.y,
                            ..child_to_frame
                        };
                        let child_after_transform = child_to_frame_after.then(
                            parent_to_frame
                                .inverse()
                                .map_err(|_| CommandError::InvalidGeometry)?,
                        );
                        local_to_frame.insert(child_id, child_to_frame_after);
                        // A modern leaf below a legacy Group retains its local
                        // matrix unless the Frame resize changed its constrained
                        // Frame-local placement. Legacy links always need their
                        // one-time Relative-v1 conversion.
                        if child.relative_transform.is_none()
                            || effective_constraints(child).is_some()
                        {
                            let child_after_geometry = geometry_for_relative_transform(
                                child_after_transform,
                                child_after_local.width,
                                child_after_local.height,
                                &child.kind,
                            )?;
                            legacy_group_subtree.push((
                                child_id,
                                child_after_geometry,
                                child_after_transform,
                            ));
                        }
                        if child.kind == NodeKind::Group {
                            pending.extend(self.child_ids_for(child_id));
                        }
                    }
                    matrix_constrained_children.extend(legacy_group_subtree);
                }
                let parent_id = self.nodes.get(id).and_then(|node| node.parent_id);
                let mut affected_groups = self.group_ancestor_ids([parent_id]);
                if is_structural_container(&kind) {
                    affected_groups.insert(0, *id);
                }
                for group_id in
                    self.group_ancestor_ids(constrained_children.iter().map(|(child_id, _)| {
                        self.nodes.get(child_id).and_then(|child| child.parent_id)
                    }))
                {
                    if !affected_groups.contains(&group_id) {
                        affected_groups.push(group_id);
                    }
                }
                for group_id in self.group_ancestor_ids(matrix_constrained_children.iter().map(
                    |(child_id, _, _)| self.nodes.get(child_id).and_then(|child| child.parent_id),
                )) {
                    if !affected_groups.contains(&group_id) {
                        affected_groups.push(group_id);
                    }
                }
                let before_bounds = affected_groups
                    .iter()
                    .filter_map(|group_id| {
                        self.geometry_for(*group_id)
                            .map(|geometry| (*group_id, geometry))
                    })
                    .collect::<Vec<_>>();
                let node = self
                    .nodes
                    .get_mut(id)
                    .ok_or(CommandError::MissingNode { id: *id })?;
                let before = Geometry {
                    x: node.x,
                    y: node.y,
                    width: node.width,
                    height: node.height,
                    rotation: node.rotation,
                };
                (node.x, node.y, node.width, node.height, node.rotation) =
                    (after.x, after.y, after.width, after.height, after.rotation);
                let mut changes = vec![AppliedChange::GeometryChanged {
                    id: *id,
                    before,
                    after,
                }];
                for (child_id, child_after) in constrained_children {
                    let child = self
                        .nodes
                        .get_mut(&child_id)
                        .ok_or(CommandError::MissingNode { id: child_id })?;
                    let child_before = Geometry {
                        x: child.x,
                        y: child.y,
                        width: child.width,
                        height: child.height,
                        rotation: child.rotation,
                    };
                    if child_before != child_after {
                        (child.x, child.y, child.width, child.height, child.rotation) = (
                            child_after.x,
                            child_after.y,
                            child_after.width,
                            child_after.height,
                            child_after.rotation,
                        );
                        changes.push(AppliedChange::GeometryChanged {
                            id: child_id,
                            before: child_before,
                            after: child_after,
                        });
                    }
                }
                for (child_id, child_after_geometry, child_after_transform) in
                    matrix_constrained_children
                {
                    let child = self
                        .nodes
                        .get_mut(&child_id)
                        .ok_or(CommandError::MissingNode { id: child_id })?;
                    let child_before_geometry = Geometry {
                        x: child.x,
                        y: child.y,
                        width: child.width,
                        height: child.height,
                        rotation: child.rotation,
                    };
                    let before_appearance = appearance_for_node(child);
                    let after_appearance = Appearance {
                        relative_transform: Some(child_after_transform),
                        ..before_appearance.clone()
                    };
                    if child_before_geometry != child_after_geometry {
                        (child.x, child.y, child.width, child.height, child.rotation) = (
                            child_after_geometry.x,
                            child_after_geometry.y,
                            child_after_geometry.width,
                            child_after_geometry.height,
                            child_after_geometry.rotation,
                        );
                        changes.push(AppliedChange::GeometryChanged {
                            id: child_id,
                            before: child_before_geometry,
                            after: child_after_geometry,
                        });
                    }
                    if before_appearance != after_appearance {
                        child.relative_transform = after_appearance.relative_transform;
                        changes.push(AppliedChange::AppearanceChanged {
                            id: child_id,
                            before: before_appearance,
                            after: after_appearance,
                        });
                    }
                }
                self.refresh_group_bounds(parent_id);
                for group_id in affected_groups.iter().copied() {
                    if Some(group_id) != parent_id {
                        self.refresh_group_bounds(Some(group_id));
                    }
                }
                changes.extend(before_bounds.into_iter().filter_map(|(group_id, before)| {
                    let after = self.geometry_for(group_id)?;
                    (before != after).then_some(AppliedChange::GeometryChanged {
                        id: group_id,
                        before,
                        after,
                    })
                }));
                Ok(if changes.len() == 1 {
                    changes.remove(0)
                } else {
                    AppliedChange::Composite { changes }
                })
            }
            Command::Rename { id, name } => {
                self.assert_mutable(*id)?;
                if name.trim().is_empty() {
                    return Err(CommandError::InvalidName);
                }
                let node = self
                    .nodes
                    .get_mut(id)
                    .ok_or(CommandError::MissingNode { id: *id })?;
                let before_bytes = node.estimated_bytes();
                let after_bytes = before_bytes - node.name.len() + name.len();
                if self
                    .node_bytes
                    .saturating_sub(before_bytes)
                    .saturating_add(after_bytes)
                    > MAX_DOCUMENT_BYTES
                {
                    return Err(CommandError::ResourceLimit);
                }
                let before = std::mem::replace(&mut node.name, name.clone());
                self.node_bytes = self
                    .node_bytes
                    .saturating_sub(before_bytes)
                    .saturating_add(after_bytes);
                Ok(AppliedChange::NameChanged {
                    id: *id,
                    before,
                    after: name.clone(),
                })
            }
            Command::SetAppearance { id, appearance } => {
                if !valid_appearance(appearance) {
                    return Err(CommandError::InvalidAppearance);
                }
                let mut after = appearance.clone();
                after.stroke_dash_pattern = canonical_dash_pattern(&after.stroke_dash_pattern);
                if !valid_stroke_weights(&after.stroke_weights) {
                    return Err(CommandError::InvalidAppearance);
                }
                if !valid_paint_stack(&after.fills) || !valid_paint_stack(&after.strokes) {
                    return Err(CommandError::InvalidAppearance);
                }
                let existing = self
                    .nodes
                    .get(id)
                    .ok_or(CommandError::MissingNode { id: *id })?;
                if self.is_effectively_locked(*id) {
                    let mut unlock_only = appearance_for_node(existing);
                    unlock_only.locked = false;
                    if !existing.locked || after != unlock_only {
                        return Err(CommandError::EffectivelyLocked { id: *id });
                    }
                }
                let node = self
                    .nodes
                    .get_mut(id)
                    .ok_or(CommandError::MissingNode { id: *id })?;
                if after.contents_hidden && node.kind != NodeKind::Section {
                    return Err(CommandError::InvalidAppearance);
                }
                if after.clips_content == Some(true) && !is_frame_like(&node.kind) {
                    return Err(CommandError::InvalidAppearance);
                }
                if !after.corner_radii.is_empty()
                    && !matches!(
                        node.kind,
                        NodeKind::Frame | NodeKind::Rectangle | NodeKind::Section
                    )
                {
                    return Err(CommandError::InvalidAppearance);
                }
                if after.corner_smoothing != 0.0
                    && !matches!(
                        node.kind,
                        NodeKind::Frame | NodeKind::Rectangle | NodeKind::Section
                    )
                {
                    return Err(CommandError::InvalidAppearance);
                }
                if after.constraints.is_some()
                    && matches!(
                        node.kind,
                        NodeKind::Group | NodeKind::BooleanOperation | NodeKind::Section
                    )
                {
                    return Err(CommandError::InvalidAppearance);
                }
                if !after.stroke_weights.is_empty()
                    && !matches!(node.kind, NodeKind::Frame | NodeKind::Rectangle)
                {
                    return Err(CommandError::InvalidAppearance);
                }
                if after.stroke_align != StrokeAlign::Inside
                    && (!matches!(
                        node.kind,
                        NodeKind::Frame
                            | NodeKind::Rectangle
                            | NodeKind::Ellipse
                            | NodeKind::Polygon
                            | NodeKind::Star
                    ) || after.arc_data.is_some())
                {
                    return Err(CommandError::InvalidAppearance);
                }
                if after.arc_data.is_some() && node.kind != NodeKind::Ellipse {
                    return Err(CommandError::InvalidAppearance);
                }
                if !valid_parametric_shape(&node.kind, after.parametric_shape) {
                    return Err(CommandError::InvalidAppearance);
                }
                if (after.drop_shadow.is_some() || !after.effect_stack.is_empty())
                    && node.kind == NodeKind::BooleanOperation
                {
                    return Err(CommandError::InvalidAppearance);
                }
                if node.kind == NodeKind::Slice && !valid_slice_appearance(&after) {
                    return Err(CommandError::InvalidAppearance);
                }
                if !valid_relative_transform(after.relative_transform) {
                    return Err(CommandError::InvalidAppearance);
                }
                let before_bytes = node.estimated_bytes();
                let after_bytes = before_bytes
                    .saturating_sub(node.fill.estimated_bytes())
                    .saturating_sub(node.stroke.estimated_bytes())
                    .saturating_sub(paint_stack_bytes(&node.fills))
                    .saturating_sub(paint_stack_bytes(&node.strokes))
                    .saturating_add(after.fill.estimated_bytes())
                    .saturating_add(after.stroke.estimated_bytes())
                    .saturating_add(paint_stack_bytes(&after.fills))
                    .saturating_add(paint_stack_bytes(&after.strokes))
                    .saturating_sub(effect_stack_bytes(&node.effect_stack))
                    .saturating_add(effect_stack_bytes(&after.effect_stack))
                    .saturating_sub(node.stroke_dash_pattern.len() * std::mem::size_of::<f64>())
                    .saturating_add(after.stroke_dash_pattern.len() * std::mem::size_of::<f64>())
                    .saturating_sub(node.stroke_weights.len() * std::mem::size_of::<f64>())
                    .saturating_add(after.stroke_weights.len() * std::mem::size_of::<f64>());
                if self
                    .node_bytes
                    .saturating_sub(before_bytes)
                    .saturating_add(after_bytes)
                    > MAX_DOCUMENT_BYTES
                {
                    return Err(CommandError::ResourceLimit);
                }
                let before = Appearance {
                    fill: node.fill.clone(),
                    stroke: node.stroke.clone(),
                    fills: node.fills.clone(),
                    strokes: node.strokes.clone(),
                    stroke_width: node.stroke_width,
                    stroke_cap_start: node.stroke_cap_start,
                    stroke_cap_end: node.stroke_cap_end,
                    stroke_join: node.stroke_join,
                    stroke_miter_limit: node.stroke_miter_limit,
                    stroke_dash_pattern: node.stroke_dash_pattern.clone(),
                    stroke_weights: node.stroke_weights.clone(),
                    stroke_align: node.stroke_align,
                    arc_data: node.arc_data,
                    parametric_shape: node.parametric_shape,
                    relative_transform: node.relative_transform,
                    opacity: node.opacity,
                    blend_mode: node.blend_mode,
                    drop_shadow: node.drop_shadow,
                    effect_stack: node.effect_stack.clone(),
                    corner_radius: node.corner_radius,
                    corner_radii: node.corner_radii.clone(),
                    corner_smoothing: node.corner_smoothing,
                    constraints: node.constraints,
                    visible: node.visible,
                    locked: node.locked,
                    contents_hidden: node.contents_hidden,
                    clips_content: Some(node.clips_content),
                };
                node.fill = after.fill.clone();
                node.stroke = after.stroke.clone();
                node.fills = after.fills.clone();
                node.strokes = after.strokes.clone();
                node.stroke_width = after.stroke_width;
                node.stroke_cap_start = after.stroke_cap_start;
                node.stroke_cap_end = after.stroke_cap_end;
                node.stroke_join = after.stroke_join;
                node.stroke_miter_limit = after.stroke_miter_limit;
                node.stroke_dash_pattern = after.stroke_dash_pattern.clone();
                node.stroke_weights = after.stroke_weights.clone();
                node.stroke_align = after.stroke_align;
                node.arc_data = after.arc_data;
                node.parametric_shape = after.parametric_shape;
                node.relative_transform = after.relative_transform;
                node.opacity = after.opacity;
                node.blend_mode = after.blend_mode;
                node.drop_shadow = after.drop_shadow;
                node.effect_stack = after.effect_stack.clone();
                node.corner_radius = after.corner_radius;
                node.corner_radii = after.corner_radii.clone();
                node.corner_smoothing = after.corner_smoothing;
                node.constraints = after.constraints;
                node.visible = after.visible;
                node.locked = after.locked;
                node.contents_hidden = after.contents_hidden;
                node.clips_content = after.clips_content.unwrap_or(is_frame_like(&node.kind));
                self.node_bytes = self
                    .node_bytes
                    .saturating_sub(before_bytes)
                    .saturating_add(after_bytes);
                let appearance_change = AppliedChange::AppearanceChanged {
                    id: *id,
                    before: before.clone(),
                    after: after.clone(),
                };
                // A moved Relative-v1 child reaches Core through SetAppearance
                // (its transform is part of its appearance), and storing the new
                // relative_transform is all that is required to move it. Its
                // ancestor Group's box is intentionally NOT recomputed here: a
                // Group's legacy x/y is the parent frame origin every relative
                // child is anchored to (see `moving_one_relative_group`), so
                // shifting that origin to the child's new bounds would drag the
                // child a second time. Keeping the box in sync with children that
                // have moved away from the anchor requires rebasing every sibling
                // and is handled where that structural math already lives (the
                // group/ungroup batch), not on an appearance edit.
                Ok(appearance_change)
            }
            Command::SetPaintStacks {
                id,
                fill_stack,
                stroke_stack,
            } => {
                self.assert_mutable(*id)?;
                self.validate_paint_stacks(*id, fill_stack.as_ref(), stroke_stack.as_ref())?;
                let before_fill = self.node_paint_stacks.get(&(*id, false)).cloned();
                let before_stroke = self.node_paint_stacks.get(&(*id, true)).cloned();
                self.replace_paint_stacks(*id, fill_stack.clone(), stroke_stack.clone())?;
                Ok(AppliedChange::PaintStacksChanged {
                    id: *id,
                    before_fill,
                    before_stroke,
                    after_fill: fill_stack.clone(),
                    after_stroke: stroke_stack.clone(),
                })
            }
            Command::SetPaintStyleLinks { id, links } => {
                self.assert_mutable(*id)?;
                self.validate_paint_style_links(*id, links)?;
                let before = self.node_paint_style_links.get(id).cloned();
                self.replace_paint_style_links(*id, links.clone())?;
                Ok(AppliedChange::PaintStyleLinksChanged {
                    id: *id,
                    before,
                    after: (!links.is_empty()).then_some(links.clone()),
                })
            }
            Command::SetVectorPath { id, path } => {
                self.assert_mutable(*id)?;
                self.replace_vector_path(*id, path.clone())
            }
            Command::ConvertToTextPath { id, path } => {
                self.assert_mutable(*id)?;
                self.convert_to_text_path(*id, path.clone())
            }
            Command::SetBooleanOperation { id, operation } => {
                self.assert_mutable(*id)?;
                let node = self
                    .nodes
                    .get_mut(id)
                    .ok_or(CommandError::MissingNode { id: *id })?;
                if node.kind != NodeKind::BooleanOperation {
                    return Err(CommandError::InvalidGeometry);
                }
                let before = node
                    .boolean_operation
                    .ok_or(CommandError::InvalidGeometry)?;
                node.boolean_operation = Some(*operation);
                Ok(AppliedChange::BooleanOperationChanged {
                    id: *id,
                    before,
                    after: *operation,
                })
            }
            Command::SetMask { id, enabled } => {
                self.assert_mutable(*id)?;
                let (before, before_bytes, after_bytes) = {
                    let node = self
                        .nodes
                        .get(id)
                        .ok_or(CommandError::MissingNode { id: *id })?;
                    let invalid_boolean_mask = node.kind == NodeKind::BooleanOperation && {
                        let operands = self.child_ids_for(*id);
                        operands.len() < 2
                            || operands.iter().any(|operand_id| {
                                self.nodes.get(operand_id).is_none_or(|operand| {
                                    operand.kind != NodeKind::Vector
                                        || operand.vector_path.is_none()
                                })
                            })
                    };
                    if *enabled
                        && (matches!(node.kind, NodeKind::Section | NodeKind::Slice)
                            || (matches!(node.kind, NodeKind::Group | NodeKind::TransformGroup)
                                && !self.has_children(*id))
                            || invalid_boolean_mask)
                    {
                        return Err(CommandError::InvalidGeometry);
                    }
                    let before = is_alpha_mask(node);
                    let before_bytes = node.estimated_bytes();
                    let mut after = node.clone();
                    if *enabled {
                        after
                            .extensions
                            .insert(ALPHA_MASK_EXTENSION_KEY.into(), vec![1]);
                    } else {
                        after.extensions.remove(ALPHA_MASK_EXTENSION_KEY);
                    }
                    (before, before_bytes, after.estimated_bytes())
                };
                if *enabled && !self.has_following_sibling(*id) {
                    return Err(CommandError::InvalidGeometry);
                }
                if self
                    .node_bytes
                    .saturating_sub(before_bytes)
                    .saturating_add(after_bytes)
                    > MAX_DOCUMENT_BYTES
                {
                    return Err(CommandError::ResourceLimit);
                }
                self.set_mask(*id, *enabled);
                Ok(AppliedChange::MaskChanged {
                    id: *id,
                    before,
                    after: *enabled,
                })
            }
            Command::SetNodeExtensions { id, extensions } => {
                self.assert_mutable(*id)?;
                if !valid_extensions(extensions) || !self.valid_prototype_extensions(extensions) {
                    return Err(CommandError::InvalidAppearance);
                }
                let node = self
                    .nodes
                    .get(id)
                    .ok_or(CommandError::MissingNode { id: *id })?;
                let before_bytes = node.estimated_bytes();
                let mut candidate = node.clone();
                candidate.extensions = extensions.clone();
                let after_bytes = candidate.estimated_bytes();
                if self
                    .node_bytes
                    .saturating_sub(before_bytes)
                    .saturating_add(after_bytes)
                    > MAX_DOCUMENT_BYTES
                {
                    return Err(CommandError::ResourceLimit);
                }
                let node = self
                    .nodes
                    .get_mut(id)
                    .ok_or(CommandError::MissingNode { id: *id })?;
                let before = std::mem::replace(&mut node.extensions, extensions.clone());
                self.node_bytes = self
                    .node_bytes
                    .saturating_sub(before_bytes)
                    .saturating_add(after_bytes);
                Ok(AppliedChange::ExtensionsChanged {
                    id: *id,
                    before,
                    after: extensions.clone(),
                })
            }
            Command::MoveVectorPoint {
                id,
                point_id,
                position,
            } => {
                self.assert_mutable(*id)?;
                let mut path = self.vector_path_for_node(*id)?;
                let point = path
                    .subpaths
                    .iter_mut()
                    .flat_map(|subpath| subpath.points.iter_mut())
                    .find(|point| point.id == *point_id)
                    .ok_or(CommandError::InvalidGeometry)?;
                point.position = *position;
                self.replace_vector_path(*id, path)
            }
            Command::SetVectorSubpathClosed {
                id,
                subpath_index,
                closed,
            } => {
                self.assert_mutable(*id)?;
                let mut path = self.vector_path_for_node(*id)?;
                let subpath = path
                    .subpaths
                    .get_mut(*subpath_index as usize)
                    .ok_or(CommandError::InvalidGeometry)?;
                subpath.closed = *closed;
                self.replace_vector_path(*id, path)
            }
            Command::InsertVectorPoint {
                id,
                subpath_index,
                after_point_id,
                point,
            } => {
                self.assert_mutable(*id)?;
                let mut path = self.vector_path_for_node(*id)?;
                if path
                    .subpaths
                    .iter()
                    .flat_map(|subpath| &subpath.points)
                    .any(|candidate| candidate.id == point.id)
                {
                    return Err(CommandError::InvalidGeometry);
                }
                let subpath = path
                    .subpaths
                    .get_mut(*subpath_index as usize)
                    .ok_or(CommandError::InvalidGeometry)?;
                let insertion_index = match after_point_id {
                    Some(after_point_id) => subpath
                        .points
                        .iter()
                        .position(|candidate| candidate.id == *after_point_id)
                        .map(|index| index + 1)
                        .ok_or(CommandError::InvalidGeometry)?,
                    None => 0,
                };
                subpath.points.insert(insertion_index, point.clone());
                self.replace_vector_path(*id, path)
            }
            Command::SplitVectorSegment {
                id,
                subpath_index,
                after_point_id,
                t,
                point_id,
            } => {
                self.assert_mutable(*id)?;
                if !t.is_finite() || *t <= 0.0 || *t >= 1.0 {
                    return Err(CommandError::InvalidGeometry);
                }
                let mut path = self.vector_path_for_node(*id)?;
                if path
                    .subpaths
                    .iter()
                    .flat_map(|subpath| &subpath.points)
                    .any(|candidate| candidate.id == *point_id)
                {
                    return Err(CommandError::InvalidGeometry);
                }
                let subpath = path
                    .subpaths
                    .get_mut(*subpath_index as usize)
                    .ok_or(CommandError::InvalidGeometry)?;
                let after_index = subpath
                    .points
                    .iter()
                    .position(|candidate| candidate.id == *after_point_id)
                    .ok_or(CommandError::InvalidGeometry)?;
                let next_index = if after_index + 1 < subpath.points.len() {
                    after_index + 1
                } else if subpath.closed {
                    0
                } else {
                    return Err(CommandError::InvalidGeometry);
                };
                let from = subpath.points[after_index].clone();
                let to = subpath.points[next_index].clone();
                let control_from = from
                    .handle_out
                    .map(|handle| Point {
                        x: from.position.x + handle.x,
                        y: from.position.y + handle.y,
                    })
                    .unwrap_or(from.position);
                let control_to = to
                    .handle_in
                    .map(|handle| Point {
                        x: to.position.x + handle.x,
                        y: to.position.y + handle.y,
                    })
                    .unwrap_or(to.position);
                let interpolate = |left: Point, right: Point| Point {
                    x: left.x + (right.x - left.x) * *t,
                    y: left.y + (right.y - left.y) * *t,
                };
                let first = interpolate(from.position, control_from);
                let second = interpolate(control_from, control_to);
                let third = interpolate(control_to, to.position);
                let fourth = interpolate(first, second);
                let fifth = interpolate(second, third);
                let position = interpolate(fourth, fifth);
                let curved = from.handle_out.is_some() || to.handle_in.is_some();
                subpath.points[after_index].handle_out = curved.then_some(Point {
                    x: first.x - from.position.x,
                    y: first.y - from.position.y,
                });
                subpath.points[next_index].handle_in = curved.then_some(Point {
                    x: third.x - to.position.x,
                    y: third.y - to.position.y,
                });
                subpath.points.insert(
                    after_index + 1,
                    VectorPoint {
                        id: *point_id,
                        position,
                        handle_in: curved.then_some(Point {
                            x: fourth.x - position.x,
                            y: fourth.y - position.y,
                        }),
                        handle_out: curved.then_some(Point {
                            x: fifth.x - position.x,
                            y: fifth.y - position.y,
                        }),
                        point_type: if curved {
                            VectorPointType::Asymmetric
                        } else {
                            VectorPointType::Corner
                        },
                    },
                );
                self.replace_vector_path(*id, path)
            }
            Command::ConnectVectorEndpoints {
                id,
                first_subpath_index,
                first_point_id,
                second_subpath_index,
                second_point_id,
            } => {
                self.assert_mutable(*id)?;
                let mut path = self.vector_path_for_node(*id)?;
                let first_index = *first_subpath_index as usize;
                let second_index = *second_subpath_index as usize;
                let first = path
                    .subpaths
                    .get(first_index)
                    .ok_or(CommandError::InvalidGeometry)?;
                let second = path
                    .subpaths
                    .get(second_index)
                    .ok_or(CommandError::InvalidGeometry)?;
                let endpoint = |subpath: &VectorSubpath, point_id: PointId| {
                    if subpath.closed || subpath.points.is_empty() {
                        return None;
                    }
                    if subpath
                        .points
                        .first()
                        .is_some_and(|point| point.id == point_id)
                    {
                        Some(true)
                    } else if subpath
                        .points
                        .last()
                        .is_some_and(|point| point.id == point_id)
                    {
                        Some(false)
                    } else {
                        None
                    }
                };
                let first_at_start =
                    endpoint(first, *first_point_id).ok_or(CommandError::InvalidGeometry)?;
                let second_at_start =
                    endpoint(second, *second_point_id).ok_or(CommandError::InvalidGeometry)?;
                if first_index == second_index {
                    if first_point_id == second_point_id
                        || first_at_start == second_at_start
                        || first.points.len() < 3
                    {
                        return Err(CommandError::InvalidGeometry);
                    }
                    path.subpaths[first_index].closed = true;
                    return self.replace_vector_path(*id, path);
                }
                let mut first = path.subpaths[first_index].clone();
                let mut second = path.subpaths[second_index].clone();
                let reverse = |subpath: &mut VectorSubpath| {
                    subpath.points.reverse();
                    for point in &mut subpath.points {
                        std::mem::swap(&mut point.handle_in, &mut point.handle_out);
                    }
                };
                if first_at_start {
                    reverse(&mut first);
                }
                if !second_at_start {
                    reverse(&mut second);
                }
                if first.points.last().is_some_and(|left| {
                    second
                        .points
                        .first()
                        .is_some_and(|right| left.position == right.position)
                }) {
                    let joined = second.points.remove(0);
                    let last = first
                        .points
                        .last_mut()
                        .ok_or(CommandError::InvalidGeometry)?;
                    last.handle_out = joined.handle_out;
                    last.point_type = if last.handle_in.is_some() || last.handle_out.is_some() {
                        VectorPointType::Asymmetric
                    } else {
                        VectorPointType::Corner
                    };
                }
                first.points.extend(second.points);
                let insertion_index = first_index.min(second_index);
                let higher_index = first_index.max(second_index);
                path.subpaths.remove(higher_index);
                path.subpaths.remove(insertion_index);
                path.subpaths.insert(insertion_index, first);
                self.replace_vector_path(*id, path)
            }
            Command::DeleteVectorPoint { id, point_id } => {
                self.assert_mutable(*id)?;
                let mut path = self.vector_path_for_node(*id)?;
                let subpath = path
                    .subpaths
                    .iter_mut()
                    .find(|subpath| {
                        subpath
                            .points
                            .iter()
                            .any(|candidate| candidate.id == *point_id)
                    })
                    .ok_or(CommandError::InvalidGeometry)?;
                if subpath.points.len() <= if subpath.closed { 3 } else { 1 } {
                    return Err(CommandError::InvalidGeometry);
                }
                let point_index = subpath
                    .points
                    .iter()
                    .position(|candidate| candidate.id == *point_id)
                    .ok_or(CommandError::InvalidGeometry)?;
                subpath.points.remove(point_index);
                self.replace_vector_path(*id, path)
            }
            Command::SetVectorPointHandles {
                id,
                point_id,
                handle_in,
                handle_out,
                point_type,
            } => {
                self.assert_mutable(*id)?;
                let mut path = self.vector_path_for_node(*id)?;
                let point = path
                    .subpaths
                    .iter_mut()
                    .flat_map(|subpath| subpath.points.iter_mut())
                    .find(|candidate| candidate.id == *point_id)
                    .ok_or(CommandError::InvalidGeometry)?;
                point.handle_in = *handle_in;
                point.handle_out = *handle_out;
                point.point_type = *point_type;
                self.replace_vector_path(*id, path)
            }
            Command::SetNodeAsset { id, asset_id } => {
                self.assert_mutable(*id)?;
                let node = self
                    .nodes
                    .get(id)
                    .ok_or(CommandError::MissingNode { id: *id })?;
                if !image_fill_supported(&node.kind)
                    || asset_id.is_some_and(|asset_id| {
                        !self
                            .assets
                            .get(&asset_id)
                            .is_some_and(|asset| asset.media_type.starts_with("image/"))
                    })
                {
                    return Err(CommandError::InvalidAsset);
                }
                let before = self.node_assets.get(id).copied();
                match asset_id {
                    Some(asset_id) => {
                        self.node_assets.insert(*id, *asset_id);
                    }
                    None => {
                        self.node_assets.remove(id);
                    }
                }
                Ok(AppliedChange::NodeAssetChanged {
                    id: *id,
                    before,
                    after: *asset_id,
                })
            }
            Command::SetText { id, text } => {
                self.assert_mutable(*id)?;
                if text.len() > MAX_TEXT_BYTES {
                    return Err(CommandError::InvalidText);
                }
                let before_properties = self.node_text_properties.get(id).cloned();
                let after_properties = before_properties.as_ref().and_then(|properties| {
                    let mut next = properties.clone();
                    next.runs.clear();
                    next.paragraph_style_runs.clear();
                    (next != TextProperties::default()).then_some(next)
                });
                let node = self
                    .nodes
                    .get_mut(id)
                    .ok_or(CommandError::MissingNode { id: *id })?;
                if !matches!(
                    node.kind,
                    NodeKind::Text
                        | NodeKind::CodeBlock
                        | NodeKind::ShapeWithText
                        | NodeKind::Sticky
                        | NodeKind::TableCell
                        | NodeKind::TextPath
                ) {
                    return Err(CommandError::InvalidText);
                }
                let before_bytes = node.estimated_bytes();
                let after_bytes = before_bytes - node.text.len() + text.len();
                if self
                    .node_bytes
                    .saturating_sub(before_bytes)
                    .saturating_add(after_bytes)
                    > MAX_DOCUMENT_BYTES
                {
                    return Err(CommandError::ResourceLimit);
                }
                let before = std::mem::replace(&mut node.text, text.clone());
                self.node_bytes = self
                    .node_bytes
                    .saturating_sub(before_bytes)
                    .saturating_add(after_bytes);
                self.replace_text_properties_option(*id, after_properties.clone());
                Ok(AppliedChange::TextChanged {
                    id: *id,
                    before,
                    after: text.clone(),
                    before_properties,
                    after_properties,
                })
            }
            Command::SetTextProperties { id, properties } => {
                self.assert_mutable(*id)?;
                let node = self
                    .nodes
                    .get(id)
                    .ok_or(CommandError::MissingNode { id: *id })?;
                if !supports_text_properties(&node.kind)
                    || !self.valid_text_properties(&node.text, properties)
                {
                    return Err(CommandError::InvalidTextProperties);
                }
                let before = self.node_text_properties.get(id).cloned();
                let after =
                    (properties != &TextProperties::default()).then_some(properties.clone());
                self.replace_text_properties_option(*id, after.clone());
                Ok(AppliedChange::TextPropertiesChanged {
                    id: *id,
                    before,
                    after,
                })
            }
            Command::SetAutoLayout { id, layout } => {
                self.assert_mutable(*id)?;
                let node = self
                    .nodes
                    .get(id)
                    .ok_or(CommandError::MissingNode { id: *id })?;
                if !valid_auto_layout(layout)
                    || (layout.mode != LayoutMode::None && !is_frame_like(&node.kind))
                {
                    return Err(CommandError::InvalidAutoLayout);
                }
                let before = self.node_auto_layout.get(id).cloned();
                let after = (layout != &AutoLayout::default()).then_some(layout.clone());
                match &after {
                    Some(layout) => {
                        self.node_auto_layout.insert(*id, layout.clone());
                    }
                    None => {
                        self.node_auto_layout.remove(id);
                    }
                }
                Ok(AppliedChange::AutoLayoutChanged {
                    id: *id,
                    before,
                    after,
                })
            }
            Command::SetNodePosition { id, position } => {
                self.assert_mutable(*id)?;
                let (parent_id, page_id, before) = self
                    .nodes
                    .get(id)
                    .map(|node| {
                        (
                            node.parent_id,
                            self.node_pages.get(id).copied().unwrap_or(DEFAULT_PAGE_ID),
                            node.position,
                        )
                    })
                    .ok_or(CommandError::MissingNode { id: *id })?;
                if *position != before && self.has_child_position(page_id, parent_id, *position) {
                    return Err(CommandError::DuplicatePosition {
                        parent_id,
                        position: *position,
                    });
                }
                let node = self
                    .nodes
                    .get_mut(id)
                    .ok_or(CommandError::MissingNode { id: *id })?;
                let before = node.position;
                node.position = *position;
                self.unindex_child(page_id, parent_id, before, *id);
                self.index_child(page_id, parent_id, *position, *id);
                Ok(AppliedChange::NodePositionChanged {
                    id: *id,
                    before,
                    after: *position,
                })
            }
            Command::SetNodeParent {
                id,
                parent_id,
                position,
            } => {
                self.assert_mutable(*id)?;
                let node = self
                    .nodes
                    .get(id)
                    .ok_or(CommandError::MissingNode { id: *id })?;
                let page_id = self.node_pages.get(id).copied().unwrap_or(DEFAULT_PAGE_ID);
                let before_parent_id = node.parent_id;
                let before_position = node.position;
                if *parent_id == Some(*id) {
                    return Err(CommandError::InvalidParent { id: *id });
                }
                if parent_id.is_none() && matches!(node.kind, NodeKind::Slide | NodeKind::SlideRow)
                {
                    return Err(CommandError::InvalidParent { id: *id });
                }
                if let Some(next_parent_id) = parent_id {
                    let parent =
                        self.nodes
                            .get(next_parent_id)
                            .ok_or(CommandError::MissingParent {
                                id: *next_parent_id,
                            })?;
                    if self.is_effectively_locked(*next_parent_id) {
                        return Err(CommandError::EffectivelyLocked {
                            id: *next_parent_id,
                        });
                    }
                    if self
                        .node_pages
                        .get(next_parent_id)
                        .copied()
                        .unwrap_or(DEFAULT_PAGE_ID)
                        != page_id
                        || !can_parent_contain_child(&parent.kind, &node.kind)
                    {
                        return Err(CommandError::InvalidParent {
                            id: *next_parent_id,
                        });
                    }
                    let mut ancestor = parent.parent_id;
                    while let Some(ancestor_id) = ancestor {
                        if ancestor_id == *id {
                            return Err(CommandError::InvalidParent {
                                id: *next_parent_id,
                            });
                        }
                        ancestor = self
                            .nodes
                            .get(&ancestor_id)
                            .and_then(|candidate| candidate.parent_id);
                    }
                }
                if (*parent_id != before_parent_id || *position != before_position)
                    && self.has_child_position(page_id, *parent_id, *position)
                {
                    return Err(CommandError::DuplicatePosition {
                        parent_id: *parent_id,
                        position: *position,
                    });
                }
                let affected_groups = self.group_ancestor_ids([before_parent_id, *parent_id]);
                let before_bounds = affected_groups
                    .iter()
                    .filter_map(|id| self.geometry_for(*id).map(|geometry| (*id, geometry)))
                    .collect::<Vec<_>>();
                self.unindex_child(page_id, before_parent_id, before_position, *id);
                self.index_child(page_id, *parent_id, *position, *id);
                let node = self
                    .nodes
                    .get_mut(id)
                    .ok_or(CommandError::MissingNode { id: *id })?;
                node.parent_id = *parent_id;
                node.position = *position;
                self.refresh_group_bounds(before_parent_id);
                self.refresh_group_bounds(*parent_id);
                let dissolved_containers =
                    self.dissolve_empty_groups_and_component_sets_from(before_parent_id);
                let mut changes = vec![AppliedChange::NodeParentChanged {
                    id: *id,
                    before_parent_id,
                    before_position,
                    after_parent_id: *parent_id,
                    after_position: *position,
                }];
                changes.extend(before_bounds.into_iter().filter_map(|(id, before)| {
                    let after = self.geometry_for(id)?;
                    (before != after).then_some(AppliedChange::GeometryChanged {
                        id,
                        before,
                        after,
                    })
                }));
                changes.extend(
                    dissolved_containers
                        .into_iter()
                        .map(|node| AppliedChange::NodeDeleted { node }),
                );
                Ok(if changes.len() == 1 {
                    changes.remove(0)
                } else {
                    AppliedChange::Composite { changes }
                })
            }
            Command::Delete { id } => {
                self.assert_mutable(*id)?;
                if self.has_children(*id) {
                    return Err(CommandError::NodeHasChildren { id: *id });
                }
                let node = self
                    .nodes
                    .get(id)
                    .cloned()
                    .map(SharedNode::into_node)
                    .ok_or(CommandError::MissingNode { id: *id })?;
                let affected_groups = self.group_ancestor_ids([node.parent_id]);
                let before_bounds = affected_groups
                    .iter()
                    .filter_map(|group_id| {
                        self.geometry_for(*group_id)
                            .map(|geometry| (*group_id, geometry))
                    })
                    .collect::<Vec<_>>();
                let reference_changes = self.clear_prototype_destination(*id);
                self.nodes.remove(id);
                self.structural_validation_pending.remove(id);
                self.node_bytes = self.node_bytes.saturating_sub(node.estimated_bytes());
                if let Some(properties) = self.node_text_properties.remove(id) {
                    self.node_bytes = self.node_bytes.saturating_sub(properties.estimated_bytes());
                    self.retired_node_text_properties.insert(*id, properties);
                }
                for stroke in [false, true] {
                    if let Some(stack) = self.node_paint_stacks.remove(&(*id, stroke)) {
                        self.node_bytes = self.node_bytes.saturating_sub(stack.estimated_bytes());
                        self.retired_node_paint_stacks.insert((*id, stroke), stack);
                    }
                }
                if let Some(links) = self.node_paint_style_links.remove(id) {
                    self.node_bytes = self.node_bytes.saturating_sub(links.estimated_bytes());
                    self.retired_node_paint_style_links.insert(*id, links);
                }
                let page_id = self.node_pages.remove(id).unwrap_or(DEFAULT_PAGE_ID);
                self.unindex_child(page_id, node.parent_id, node.position, node.id);
                self.retired_node_pages.insert(*id, page_id);
                if let Some(asset_id) = self.node_assets.remove(id) {
                    self.retired_node_assets.insert(*id, asset_id);
                }
                self.retired_ids.insert(*id);
                self.refresh_group_bounds(node.parent_id);
                let dissolved_containers =
                    self.dissolve_empty_groups_and_component_sets_from(node.parent_id);
                let mut changes = vec![AppliedChange::NodeDeleted { node }];
                changes.extend(reference_changes);
                changes.extend(before_bounds.into_iter().filter_map(|(group_id, before)| {
                    let after = self.geometry_for(group_id)?;
                    (before != after).then_some(AppliedChange::GeometryChanged {
                        id: group_id,
                        before,
                        after,
                    })
                }));
                changes.extend(
                    dissolved_containers
                        .into_iter()
                        .map(|node| AppliedChange::NodeDeleted { node }),
                );
                Ok(if changes.len() == 1 {
                    changes.remove(0)
                } else {
                    AppliedChange::Composite { changes }
                })
            }
            Command::SetDocumentColorProfile { profile } => {
                let before = self.color_profile;
                self.color_profile = *profile;
                Ok(AppliedChange::DocumentColorProfileChanged {
                    before,
                    after: *profile,
                })
            }
            Command::RegisterAsset { asset } => {
                self.insert_asset(asset.clone())?;
                Ok(AppliedChange::AssetRegistered {
                    asset: asset.clone(),
                })
            }
            Command::RegisterTextStyle { .. }
            | Command::RegisterPaintStyle { .. }
            | Command::SetTextStyle { .. }
            | Command::DeleteTextStyle { .. }
            | Command::SetPaintStyle { .. }
            | Command::DeletePaintStyle { .. } => {
                unreachable!("style commands are dispatched first")
            }
            Command::RegisterVariableCollection { collection } => {
                self.insert_variable_collection(collection.clone())?;
                Ok(AppliedChange::VariableCollectionRegistered {
                    collection: collection.clone(),
                })
            }
            Command::RegisterVariable { variable } => {
                self.insert_variable(variable.clone(), true)?;
                Ok(AppliedChange::VariableRegistered {
                    variable: variable.clone(),
                })
            }
            Command::SetVariable { variable } => {
                let before = self.replace_variable(variable.clone())?;
                Ok(AppliedChange::VariableChanged {
                    before,
                    after: variable.clone(),
                })
            }
            Command::DeleteVariable { id } => {
                let variable = self.remove_variable(id)?;
                Ok(AppliedChange::VariableDeleted { variable })
            }
            Command::SetVariableCollection {
                collection,
                variables,
            } => {
                let (before, before_variables) =
                    self.replace_variable_collection(collection.clone(), variables.clone())?;
                Ok(AppliedChange::VariableCollectionChanged {
                    before,
                    after: collection.clone(),
                    before_variables,
                    after_variables: variables.clone(),
                })
            }
            Command::DeleteVariableCollection { id } => {
                let (collection, variables) = self.remove_variable_collection(id)?;
                Ok(AppliedChange::VariableCollectionDeleted {
                    collection,
                    variables,
                })
            }
        }
    }

    fn apply_inverse(&mut self, change: &AppliedChange) {
        match change {
            AppliedChange::Composite { changes } => {
                for change in changes.iter().rev() {
                    self.apply_inverse(change);
                }
            }
            AppliedChange::PageCreated { page } => {
                self.pages.remove(&page.id);
            }
            AppliedChange::NodeCreated { node } => self.retire_node(node.id),
            AppliedChange::GeometryChanged { id, before, .. } => {
                if let Some(node) = self.nodes.get_mut(id) {
                    (node.x, node.y, node.width, node.height, node.rotation) = (
                        before.x,
                        before.y,
                        before.width,
                        before.height,
                        before.rotation,
                    );
                }
            }
            AppliedChange::NameChanged { id, before, .. } => self.set_name(*id, before),
            AppliedChange::AppearanceChanged { id, before, .. } => self.set_appearance(*id, before),
            AppliedChange::PaintStacksChanged {
                id,
                before_fill,
                before_stroke,
                ..
            } => {
                let _ = self.replace_paint_stacks(*id, before_fill.clone(), before_stroke.clone());
            }
            AppliedChange::PaintStyleLinksChanged { id, before, .. } => {
                let _ = self.replace_paint_style_links(*id, before.clone().unwrap_or_default());
            }
            AppliedChange::AutoLayoutChanged { id, before, .. } => {
                self.replace_auto_layout_option(*id, before.clone());
            }
            AppliedChange::VectorPathChanged { id, before, .. } => {
                self.set_vector_path(*id, before)
            }
            AppliedChange::NodeRecordChanged { id, before, .. } => {
                self.set_node_record(*id, before)
            }
            AppliedChange::BooleanOperationChanged { id, before, .. } => {
                if let Some(node) = self.nodes.get_mut(id) {
                    node.boolean_operation = Some(*before);
                }
            }
            AppliedChange::MaskChanged { id, before, .. } => self.set_mask(*id, *before),
            AppliedChange::ExtensionsChanged { id, before, .. } => self.set_extensions(*id, before),
            AppliedChange::NodeAssetChanged { id, before, .. } => self.set_node_asset(*id, *before),
            AppliedChange::TextChanged {
                id,
                before,
                before_properties,
                ..
            } => {
                self.set_text(*id, before);
                self.replace_text_properties_option(*id, before_properties.clone());
            }
            AppliedChange::TextPropertiesChanged { id, before, .. } => {
                self.replace_text_properties_option(*id, before.clone());
            }
            AppliedChange::NodePositionChanged { id, before, .. } => {
                self.set_node_position(*id, *before)
            }
            AppliedChange::NodeParentChanged {
                id,
                before_parent_id,
                before_position,
                ..
            } => self.set_node_parent(*id, *before_parent_id, *before_position),
            AppliedChange::DocumentColorProfileChanged { before, .. } => {
                self.color_profile = *before
            }
            AppliedChange::AssetRegistered { asset } => {
                self.assets.remove(&asset.asset_id);
            }
            AppliedChange::TextStyleRegistered { style } => {
                self.text_styles.remove(&style.id);
                self.text_style_bytes = self
                    .text_style_bytes
                    .saturating_sub(style.estimated_bytes());
            }
            AppliedChange::PaintStyleRegistered { style } => {
                self.paint_styles.remove(&style.id);
                self.paint_style_bytes = self
                    .paint_style_bytes
                    .saturating_sub(style.estimated_bytes());
            }
            AppliedChange::TextStyleChanged { before, after } => {
                self.text_styles.insert(before.id.clone(), before.clone());
                self.text_style_bytes = self
                    .text_style_bytes
                    .saturating_sub(after.estimated_bytes())
                    .saturating_add(before.estimated_bytes());
            }
            AppliedChange::TextStyleDeleted { style } => {
                self.text_style_bytes = self
                    .text_style_bytes
                    .saturating_add(style.estimated_bytes());
                self.text_styles.insert(style.id.clone(), style.clone());
            }
            AppliedChange::PaintStyleChanged { before, after } => {
                self.paint_styles.insert(before.id.clone(), before.clone());
                self.paint_style_bytes = self
                    .paint_style_bytes
                    .saturating_sub(after.estimated_bytes())
                    .saturating_add(before.estimated_bytes());
            }
            AppliedChange::PaintStyleDeleted { style } => {
                self.paint_style_bytes = self
                    .paint_style_bytes
                    .saturating_add(style.estimated_bytes());
                self.paint_styles.insert(style.id.clone(), style.clone());
            }
            AppliedChange::VariableCollectionRegistered { collection } => {
                self.variable_collections.remove(&collection.id);
                self.variable_catalog_bytes = self
                    .variable_catalog_bytes
                    .saturating_sub(collection.estimated_bytes());
            }
            AppliedChange::VariableRegistered { variable } => {
                self.variables.remove(&variable.id);
                self.variable_catalog_bytes = self
                    .variable_catalog_bytes
                    .saturating_sub(variable.estimated_bytes());
            }
            AppliedChange::VariableChanged { before, after } => {
                self.variables.insert(before.id.clone(), before.clone());
                self.variable_catalog_bytes = self
                    .variable_catalog_bytes
                    .saturating_sub(after.estimated_bytes())
                    .saturating_add(before.estimated_bytes());
            }
            AppliedChange::VariableDeleted { variable } => {
                self.variables.insert(variable.id.clone(), variable.clone());
                self.variable_catalog_bytes = self
                    .variable_catalog_bytes
                    .saturating_add(variable.estimated_bytes());
            }
            AppliedChange::VariableCollectionChanged {
                before,
                after,
                before_variables,
                after_variables,
            } => self.restore_variable_collection_state(
                after,
                after_variables,
                before,
                before_variables,
            ),
            AppliedChange::VariableCollectionDeleted {
                collection,
                variables,
            } => self.install_variable_collection_state(collection, variables),
            AppliedChange::NodeDeleted { node } => self.restore_node(node),
            AppliedChange::NodeRestored { node } => self.retire_node(node.id),
        }
    }

    fn apply_forward(&mut self, change: &AppliedChange) {
        match change {
            AppliedChange::Composite { changes } => {
                for change in changes {
                    self.apply_forward(change);
                }
            }
            AppliedChange::PageCreated { page } => {
                self.pages.insert(page.id, page.clone());
            }
            AppliedChange::NodeCreated { node } => self.restore_node(node),
            AppliedChange::GeometryChanged { id, after, .. } => {
                if let Some(node) = self.nodes.get_mut(id) {
                    (node.x, node.y, node.width, node.height, node.rotation) =
                        (after.x, after.y, after.width, after.height, after.rotation);
                }
            }
            AppliedChange::NameChanged { id, after, .. } => self.set_name(*id, after),
            AppliedChange::AppearanceChanged { id, after, .. } => self.set_appearance(*id, after),
            AppliedChange::PaintStacksChanged {
                id,
                after_fill,
                after_stroke,
                ..
            } => {
                let _ = self.replace_paint_stacks(*id, after_fill.clone(), after_stroke.clone());
            }
            AppliedChange::PaintStyleLinksChanged { id, after, .. } => {
                let _ = self.replace_paint_style_links(*id, after.clone().unwrap_or_default());
            }
            AppliedChange::AutoLayoutChanged { id, after, .. } => {
                self.replace_auto_layout_option(*id, after.clone());
            }
            AppliedChange::VectorPathChanged { id, after, .. } => self.set_vector_path(*id, after),
            AppliedChange::NodeRecordChanged { id, after, .. } => self.set_node_record(*id, after),
            AppliedChange::BooleanOperationChanged { id, after, .. } => {
                if let Some(node) = self.nodes.get_mut(id) {
                    node.boolean_operation = Some(*after);
                }
            }
            AppliedChange::MaskChanged { id, after, .. } => self.set_mask(*id, *after),
            AppliedChange::ExtensionsChanged { id, after, .. } => self.set_extensions(*id, after),
            AppliedChange::NodeAssetChanged { id, after, .. } => self.set_node_asset(*id, *after),
            AppliedChange::TextChanged {
                id,
                after,
                after_properties,
                ..
            } => {
                self.set_text(*id, after);
                self.replace_text_properties_option(*id, after_properties.clone());
            }
            AppliedChange::TextPropertiesChanged { id, after, .. } => {
                self.replace_text_properties_option(*id, after.clone());
            }
            AppliedChange::NodePositionChanged { id, after, .. } => {
                self.set_node_position(*id, *after)
            }
            AppliedChange::NodeParentChanged {
                id,
                after_parent_id,
                after_position,
                ..
            } => self.set_node_parent(*id, *after_parent_id, *after_position),
            AppliedChange::DocumentColorProfileChanged { after, .. } => self.color_profile = *after,
            AppliedChange::AssetRegistered { asset } => {
                self.assets.insert(asset.asset_id, asset.clone());
            }
            AppliedChange::TextStyleRegistered { style } => {
                self.text_style_bytes = self
                    .text_style_bytes
                    .saturating_add(style.estimated_bytes());
                self.text_styles.insert(style.id.clone(), style.clone());
            }
            AppliedChange::PaintStyleRegistered { style } => {
                self.paint_style_bytes = self
                    .paint_style_bytes
                    .saturating_add(style.estimated_bytes());
                self.paint_styles.insert(style.id.clone(), style.clone());
            }
            AppliedChange::TextStyleChanged { before, after } => {
                self.text_styles.insert(after.id.clone(), after.clone());
                self.text_style_bytes = self
                    .text_style_bytes
                    .saturating_sub(before.estimated_bytes())
                    .saturating_add(after.estimated_bytes());
            }
            AppliedChange::TextStyleDeleted { style } => {
                self.text_styles.remove(&style.id);
                self.text_style_bytes = self
                    .text_style_bytes
                    .saturating_sub(style.estimated_bytes());
            }
            AppliedChange::PaintStyleChanged { before, after } => {
                self.paint_styles.insert(after.id.clone(), after.clone());
                self.paint_style_bytes = self
                    .paint_style_bytes
                    .saturating_sub(before.estimated_bytes())
                    .saturating_add(after.estimated_bytes());
            }
            AppliedChange::PaintStyleDeleted { style } => {
                self.paint_styles.remove(&style.id);
                self.paint_style_bytes = self
                    .paint_style_bytes
                    .saturating_sub(style.estimated_bytes());
            }
            AppliedChange::VariableCollectionRegistered { collection } => {
                self.variable_catalog_bytes = self
                    .variable_catalog_bytes
                    .saturating_add(collection.estimated_bytes());
                self.variable_collections
                    .insert(collection.id.clone(), collection.clone());
            }
            AppliedChange::VariableRegistered { variable } => {
                self.variable_catalog_bytes = self
                    .variable_catalog_bytes
                    .saturating_add(variable.estimated_bytes());
                self.variables.insert(variable.id.clone(), variable.clone());
            }
            AppliedChange::VariableChanged { before, after } => {
                self.variables.insert(after.id.clone(), after.clone());
                self.variable_catalog_bytes = self
                    .variable_catalog_bytes
                    .saturating_sub(before.estimated_bytes())
                    .saturating_add(after.estimated_bytes());
            }
            AppliedChange::VariableDeleted { variable } => {
                self.variables.remove(&variable.id);
                self.variable_catalog_bytes = self
                    .variable_catalog_bytes
                    .saturating_sub(variable.estimated_bytes());
            }
            AppliedChange::VariableCollectionChanged {
                before,
                after,
                before_variables,
                after_variables,
            } => self.restore_variable_collection_state(
                before,
                before_variables,
                after,
                after_variables,
            ),
            AppliedChange::VariableCollectionDeleted {
                collection,
                variables,
            } => self.remove_variable_collection_state(collection, variables),
            AppliedChange::NodeDeleted { node } => self.retire_node(node.id),
            AppliedChange::NodeRestored { node } => self.restore_node(node),
        }
    }

    fn set_appearance(&mut self, id: NodeId, appearance: &Appearance) {
        if let Some(node) = self.nodes.get_mut(&id) {
            let before_bytes = node.estimated_bytes();
            let after_bytes = before_bytes
                .saturating_sub(node.fill.estimated_bytes())
                .saturating_sub(node.stroke.estimated_bytes())
                .saturating_sub(paint_stack_bytes(&node.fills))
                .saturating_sub(paint_stack_bytes(&node.strokes))
                .saturating_add(appearance.fill.estimated_bytes())
                .saturating_add(appearance.stroke.estimated_bytes())
                .saturating_add(paint_stack_bytes(&appearance.fills))
                .saturating_add(paint_stack_bytes(&appearance.strokes))
                .saturating_sub(effect_stack_bytes(&node.effect_stack))
                .saturating_add(effect_stack_bytes(&appearance.effect_stack));
            node.fill = appearance.fill.clone();
            node.stroke = appearance.stroke.clone();
            node.fills = appearance.fills.clone();
            node.strokes = appearance.strokes.clone();
            node.stroke_width = appearance.stroke_width;
            node.stroke_cap_start = appearance.stroke_cap_start;
            node.stroke_cap_end = appearance.stroke_cap_end;
            node.stroke_join = appearance.stroke_join;
            node.stroke_miter_limit = appearance.stroke_miter_limit;
            node.stroke_dash_pattern = appearance.stroke_dash_pattern.clone();
            node.stroke_weights = appearance.stroke_weights.clone();
            node.stroke_align = appearance.stroke_align;
            node.arc_data = appearance.arc_data;
            node.parametric_shape = appearance.parametric_shape;
            node.relative_transform = appearance.relative_transform;
            node.opacity = appearance.opacity;
            node.blend_mode = appearance.blend_mode;
            node.drop_shadow = appearance.drop_shadow;
            node.effect_stack = appearance.effect_stack.clone();
            node.corner_radius = appearance.corner_radius;
            node.corner_radii = appearance.corner_radii.clone();
            node.corner_smoothing = appearance.corner_smoothing;
            node.constraints = appearance.constraints;
            node.visible = appearance.visible;
            node.locked = appearance.locked;
            node.contents_hidden = appearance.contents_hidden;
            node.clips_content = appearance
                .clips_content
                .unwrap_or(is_frame_like(&node.kind));
            self.node_bytes = self
                .node_bytes
                .saturating_sub(before_bytes)
                .saturating_add(after_bytes);
        }
    }

    fn replace_auto_layout_option(&mut self, id: NodeId, layout: Option<AutoLayout>) {
        match layout {
            Some(layout) => {
                self.node_auto_layout.insert(id, layout);
            }
            None => {
                self.node_auto_layout.remove(&id);
            }
        }
    }

    fn validate_paint_stacks(
        &self,
        id: NodeId,
        fill_stack: Option<&PaintStack>,
        stroke_stack: Option<&PaintStack>,
    ) -> Result<(), CommandError> {
        let node = self
            .nodes
            .get(&id)
            .ok_or(CommandError::MissingNode { id })?;
        if is_structural_container(&node.kind)
            && (fill_stack.is_some_and(|stack| !stack.layers.is_empty())
                || stroke_stack.is_some_and(|stack| !stack.layers.is_empty()))
        {
            return Err(CommandError::InvalidAppearance);
        }
        for stack in [fill_stack, stroke_stack].into_iter().flatten() {
            if !stack.is_valid()
                || stack.layers.iter().any(|layer| match layer.paint {
                    PaintLayerKind::Image(image) => !self
                        .assets
                        .get(&image.asset_id)
                        .is_some_and(|asset| asset.media_type.starts_with("image/")),
                    _ => false,
                })
            {
                return Err(CommandError::InvalidAppearance);
            }
        }
        Ok(())
    }

    fn replace_paint_stacks(
        &mut self,
        id: NodeId,
        fill_stack: Option<PaintStack>,
        stroke_stack: Option<PaintStack>,
    ) -> Result<(), CommandError> {
        let before_bytes = self
            .node_paint_stacks
            .get(&(id, false))
            .map(PaintStack::estimated_bytes)
            .unwrap_or(0)
            + self
                .node_paint_stacks
                .get(&(id, true))
                .map(PaintStack::estimated_bytes)
                .unwrap_or(0);
        let after_bytes = fill_stack
            .as_ref()
            .map(PaintStack::estimated_bytes)
            .unwrap_or(0)
            + stroke_stack
                .as_ref()
                .map(PaintStack::estimated_bytes)
                .unwrap_or(0);
        let next_document_bytes = self
            .node_bytes
            .saturating_sub(before_bytes)
            .saturating_add(after_bytes);
        if next_document_bytes > MAX_DOCUMENT_BYTES {
            return Err(CommandError::ResourceLimit);
        }
        match fill_stack {
            Some(stack) => {
                self.node_paint_stacks.insert((id, false), stack);
            }
            None => {
                self.node_paint_stacks.remove(&(id, false));
            }
        }
        match stroke_stack {
            Some(stack) => {
                self.node_paint_stacks.insert((id, true), stack);
            }
            None => {
                self.node_paint_stacks.remove(&(id, true));
            }
        }
        self.node_bytes = next_document_bytes;
        Ok(())
    }

    fn validate_paint_style_links(
        &self,
        id: NodeId,
        links: &PaintStyleLinks,
    ) -> Result<(), CommandError> {
        let node = self
            .nodes
            .get(&id)
            .ok_or(CommandError::MissingNode { id })?;
        let valid_id = |value: &Option<String>| {
            value.as_ref().is_none_or(|value| {
                !value.is_empty() && value.len() <= MAX_STYLE_ID_BYTES && !value.contains('\0')
            })
        };
        if !valid_id(&links.fill)
            || !valid_id(&links.stroke)
            || !valid_id(&links.background)
            || (links.background.is_some() && !is_frame_like(&node.kind))
            || (links.fill.is_some()
                && links.background.is_some()
                && links.fill != links.background)
        {
            return Err(CommandError::InvalidPaintStyleLinks);
        }
        Ok(())
    }

    fn replace_paint_style_links(
        &mut self,
        id: NodeId,
        links: PaintStyleLinks,
    ) -> Result<(), CommandError> {
        let before_bytes = self
            .node_paint_style_links
            .get(&id)
            .map(PaintStyleLinks::estimated_bytes)
            .unwrap_or(0);
        let after_bytes = links.estimated_bytes();
        let next_document_bytes = self
            .node_bytes
            .saturating_sub(before_bytes)
            .saturating_add(after_bytes);
        if next_document_bytes > MAX_DOCUMENT_BYTES {
            return Err(CommandError::ResourceLimit);
        }
        if links.is_empty() {
            self.node_paint_style_links.remove(&id);
        } else {
            self.node_paint_style_links.insert(id, links);
        }
        self.node_bytes = next_document_bytes;
        Ok(())
    }

    /// The dirty set follows touched nodes only through their ancestor chain;
    /// it never defaults to an all-page layout scan.
    fn auto_layout_dirty_frames(
        &self,
        commands: &[Command],
        before_transaction: &Document,
    ) -> Vec<NodeId> {
        let mut touched = BTreeSet::new();
        for command in commands {
            match command {
                Command::Create(node) => {
                    touched.insert(node.id);
                }
                Command::CreateInPage { node, .. }
                | Command::CreateImageInPage { node, .. }
                | Command::RestoreNode { node, .. } => {
                    touched.insert(node.id);
                }
                Command::UpdateGeometry { id, .. }
                | Command::UpdateGeometryWithoutConstraints { id, .. }
                | Command::Rename { id, .. }
                | Command::SetAppearance { id, .. }
                | Command::SetPaintStacks { id, .. }
                | Command::SetPaintStyleLinks { id, .. }
                | Command::SetVectorPath { id, .. }
                | Command::ConvertToTextPath { id, .. }
                | Command::SetBooleanOperation { id, .. }
                | Command::SetMask { id, .. }
                | Command::SetNodeExtensions { id, .. }
                | Command::MoveVectorPoint { id, .. }
                | Command::SetVectorSubpathClosed { id, .. }
                | Command::InsertVectorPoint { id, .. }
                | Command::SplitVectorSegment { id, .. }
                | Command::ConnectVectorEndpoints { id, .. }
                | Command::DeleteVectorPoint { id, .. }
                | Command::SetVectorPointHandles { id, .. }
                | Command::SetNodeAsset { id, .. }
                | Command::SetText { id, .. }
                | Command::SetTextProperties { id, .. }
                | Command::SetAutoLayout { id, .. }
                | Command::SetNodePosition { id, .. }
                | Command::SetNodeParent { id, .. }
                | Command::Delete { id } => {
                    touched.insert(*id);
                }
                Command::CreatePage(_)
                | Command::SetDocumentColorProfile { .. }
                | Command::RegisterAsset { .. }
                | Command::RegisterTextStyle { .. }
                | Command::RegisterPaintStyle { .. }
                | Command::SetTextStyle { .. }
                | Command::DeleteTextStyle { .. }
                | Command::SetPaintStyle { .. }
                | Command::DeletePaintStyle { .. }
                | Command::RegisterVariableCollection { .. }
                | Command::RegisterVariable { .. }
                | Command::SetVariable { .. }
                | Command::DeleteVariable { .. }
                | Command::SetVariableCollection { .. }
                | Command::DeleteVariableCollection { .. } => {}
            }
        }
        let mut frames = BTreeSet::new();
        for id in touched {
            // Reparent and delete remove the node from its old ancestry before
            // this pass. Follow both snapshots so the old container closes its
            // gap as well as the new container accepting the child.
            for document in [self, before_transaction] {
                let mut current = Some(id);
                let mut visited = BTreeSet::new();
                while let Some(id) = current {
                    if !visited.insert(id) {
                        break;
                    }
                    let Some(node) = document.nodes.get(&id) else {
                        break;
                    };
                    if self
                        .nodes
                        .get(&id)
                        .is_some_and(|current_node| is_frame_like(&current_node.kind))
                        && self.auto_layout_for_node(id).mode != LayoutMode::None
                    {
                        frames.insert(id);
                    }
                    current = node.parent_id;
                }
            }
        }
        // A parent reflow can change a nested Frame's available Fill axis.
        // That Frame then owns a second layout pass for its own descendants;
        // walking ancestors alone misses it because the nested container was
        // not directly touched by the user command. Expand only the affected
        // layout subtrees, then the convergence loop below resolves deepest
        // containers before their parents and repeats if a parent resized one.
        let dirty_roots = frames.iter().copied().collect::<Vec<_>>();
        for root_id in dirty_roots {
            for candidate in self.nodes.values() {
                if candidate.id == root_id
                    || !is_frame_like(&candidate.kind)
                    || self.auto_layout_for_node(candidate.id).mode == LayoutMode::None
                {
                    continue;
                }
                let mut current = candidate.parent_id;
                let mut visited = BTreeSet::new();
                while let Some(parent_id) = current {
                    if !visited.insert(parent_id) {
                        break;
                    }
                    if parent_id == root_id {
                        frames.insert(candidate.id);
                        break;
                    }
                    current = self.nodes.get(&parent_id).and_then(|node| node.parent_id);
                }
            }
        }
        let mut frames = frames.into_iter().collect::<Vec<_>>();
        frames.sort_by_key(|id| std::cmp::Reverse(self.node_depth(*id)));
        frames
    }

    fn node_depth(&self, id: NodeId) -> usize {
        let mut current = Some(id);
        let mut visited = BTreeSet::new();
        let mut depth = 0;
        while let Some(id) = current {
            if !visited.insert(id) {
                return usize::MAX;
            }
            current = self.nodes.get(&id).and_then(|node| node.parent_id);
            if current.is_some() {
                depth += 1;
            }
        }
        depth
    }

    /// The layout engine cannot rely on a browser FontFace being present during
    /// snapshot replay. This deliberately small metric model keeps Auto Layout
    /// deterministic across Core, service and WASM while the canvas may refine
    /// glyph painting with an available font.
    fn auto_layout_text_size(&self, node: &Node) -> (f64, f64) {
        let properties = self.node_text_properties.get(&node.id);
        let paragraph_font_size = properties
            .and_then(|value| {
                value
                    .runs
                    .iter()
                    .map(|run| run.font_size)
                    .filter(|size| size.is_finite() && *size > 0.0)
                    .max_by(f64::total_cmp)
                    .or_else(|| value.base_style.as_ref().map(|style| style.font_size))
            })
            .unwrap_or(31.0);
        let paragraph_spacing = properties
            .map(|value| value.paragraph.paragraph_spacing)
            .unwrap_or(0.0);
        let paragraph_starts = paragraph_start_offsets(&node.text);
        let paragraph_list_types = paragraph_starts
            .iter()
            .map(|start| properties.and_then(|value| paragraph_list_type_at(value, *start)))
            .collect::<Vec<_>>();
        let has_ordered_list = paragraph_list_types
            .iter()
            .any(|value| *value == Some(TextListType::Ordered));
        let has_unordered_list = paragraph_list_types
            .iter()
            .any(|value| *value == Some(TextListType::Unordered));
        let hanging_list = properties.is_some_and(|value| {
            value.paragraph.hanging_list && (has_ordered_list || has_unordered_list)
        });
        let hanging_punctuation =
            properties.is_some_and(|value| value.paragraph.hanging_punctuation);
        let runs = properties.map(|value| value.runs.as_slice()).unwrap_or(&[]);
        // Height-auto text keeps its authored width. Measure its soft wraps in
        // Core as well, so snapshot replay does not depend on a browser font
        // layout pass to decide an Auto Layout row's height.
        let wrap_width = properties
            .filter(|value| value.auto_size == TextAutoSize::Height)
            .map(|_| node.width)
            .filter(|width| width.is_finite() && *width > 0.0);
        let ordered_marker_width = if has_ordered_list {
            // Canvas/SVG reserve one stable gutter for the complete block.
            // Use the largest authored number here as well so paragraph 10
            // cannot change width between Core replay and browser layout.
            let marker_columns = paragraph_starts.len().to_string().len() as f64 + 2.0;
            paragraph_font_size * 0.6 * marker_columns
        } else {
            0.0
        };
        let unordered_marker_width = if has_unordered_list {
            paragraph_font_size * 1.2
        } else {
            0.0
        };
        let list_marker_width = ordered_marker_width.max(unordered_marker_width);
        let indentation_offset = |paragraph_start: usize| {
            let level = properties
                .map(|value| paragraph_indentation_at(value, paragraph_start))
                .unwrap_or(0);
            level.saturating_sub(1) as f64 * list_marker_width
        };
        let first_line_width = |paragraph_start: usize| {
            let has_list = properties
                .and_then(|value| paragraph_list_type_at(value, paragraph_start))
                .is_some();
            properties
                .map(|value| paragraph_indent_at(value, paragraph_start))
                .unwrap_or(0.0)
                + if has_list && !hanging_list {
                    list_marker_width
                } else {
                    0.0
                }
                + indentation_offset(paragraph_start)
        };
        let mut paragraph_start = 0usize;
        let mut line_width = first_line_width(0);
        let mut widest = 0.0_f64;
        let mut line_height_total = 0.0_f64;
        let mut paragraph_spacing_total = 0.0_f64;
        let mut list_spacing_total = 0.0_f64;
        let mut glyphs_on_line = 0usize;
        let mut hanging_leading_width = 0.0_f64;
        let mut hanging_trailing_width = 0.0_f64;
        for (offset, grapheme) in node.text.grapheme_indices(true) {
            if matches!(grapheme, "\n" | "\r" | "\r\n" | "\u{2028}" | "\u{2029}") {
                // CRLF is one grapheme and one paragraph boundary, matching
                // DOM editing/export semantics without splitting source bytes.
                widest = widest.max(line_width - hanging_leading_width - hanging_trailing_width);
                line_height_total += properties
                    .map(|value| {
                        paragraph_line_height_at(value, paragraph_start, paragraph_font_size)
                    })
                    .unwrap_or(20.0);
                let next_paragraph_start = offset + grapheme.len();
                paragraph_spacing_total += properties
                    .map(|value| paragraph_spacing_at(value, paragraph_start))
                    .unwrap_or(paragraph_spacing);
                let current_list =
                    properties.and_then(|value| paragraph_list_type_at(value, paragraph_start));
                let next_list = properties
                    .and_then(|value| paragraph_list_type_at(value, next_paragraph_start));
                if current_list.is_some() && next_list.is_some() {
                    list_spacing_total += properties
                        .map(|value| paragraph_list_spacing_at(value, paragraph_start))
                        .unwrap_or(0.0);
                }
                paragraph_start = next_paragraph_start;
                line_width = first_line_width(paragraph_start);
                glyphs_on_line = 0;
                hanging_leading_width = 0.0;
                hanging_trailing_width = 0.0;
                continue;
            }
            let run = runs
                .iter()
                .find(|run| (run.start as usize) <= offset && offset < run.end as usize);
            let font_size = run.map(|run| run.font_size).unwrap_or(31.0);
            let letter_spacing = run.map(|run| run.letter_spacing).unwrap_or(0.0);
            // A fallback advance is attributed to one legal editing grapheme,
            // so combining marks and Emoji ZWJ sequences cannot manufacture
            // soft-wrap lines that the text editor cannot address.
            let advance = font_size * 0.6;
            let spacing = (glyphs_on_line > 0)
                .then_some(letter_spacing)
                .unwrap_or(0.0);
            let hangs_at_end = hanging_punctuation && is_hanging_end_punctuation(grapheme);
            let candidate_effective_width = line_width + spacing + advance
                - hanging_leading_width
                - if hangs_at_end { advance } else { 0.0 };
            if glyphs_on_line > 0
                && wrap_width.is_some_and(|width| candidate_effective_width > width)
            {
                widest = widest.max(line_width - hanging_leading_width - hanging_trailing_width);
                line_height_total += properties
                    .map(|value| {
                        paragraph_line_height_at(value, paragraph_start, paragraph_font_size)
                    })
                    .unwrap_or(20.0);
                line_width = indentation_offset(paragraph_start);
                glyphs_on_line = 0;
                hanging_leading_width = 0.0;
            }
            if glyphs_on_line > 0 {
                line_width += letter_spacing;
            }
            line_width += advance;
            if glyphs_on_line == 0 && hanging_punctuation && is_hanging_start_punctuation(grapheme)
            {
                hanging_leading_width = advance;
            }
            hanging_trailing_width = if hanging_punctuation && is_hanging_end_punctuation(grapheme)
            {
                advance
            } else {
                0.0
            };
            glyphs_on_line += 1;
        }
        widest = widest.max(line_width - hanging_leading_width - hanging_trailing_width);
        line_height_total += properties
            .map(|value| paragraph_line_height_at(value, paragraph_start, paragraph_font_size))
            .unwrap_or(20.0);
        let first_style =
            properties.and_then(|value| value.runs.first().or(value.base_style.as_ref()));
        let last_style =
            properties.and_then(|value| value.runs.last().or(value.base_style.as_ref()));
        let first_line_height = properties
            .map(|value| paragraph_line_height_at(value, 0, paragraph_font_size))
            .unwrap_or(20.0);
        let last_line_height = properties
            .map(|value| paragraph_line_height_at(value, paragraph_start, paragraph_font_size))
            .unwrap_or(20.0);
        let top_trim = first_style
            .filter(|style| style.leading_trim == Some(LeadingTrim::CapHeight))
            .map(|style| {
                ((first_line_height - style.font_size) / 2.0 + style.font_size * 0.1).max(0.0)
            })
            .unwrap_or(0.0);
        let bottom_trim = last_style
            .filter(|style| style.leading_trim == Some(LeadingTrim::CapHeight))
            .map(|style| {
                let baseline = (last_line_height - style.font_size) / 2.0 + style.font_size * 0.8;
                (last_line_height - baseline).max(0.0)
            })
            .unwrap_or(0.0);
        (
            normalize_layout_number(widest.max(1.0)),
            normalize_layout_number(
                (line_height_total + paragraph_spacing_total + list_spacing_total
                    - top_trim
                    - bottom_trim)
                    .max(1.0),
            ),
        )
    }

    /// Core has no platform font dependency during snapshot replay. Its
    /// baseline therefore mirrors Canvas' deterministic `cssLineBoxBaseline`
    /// fallback: center the nominal font box in the declared line box and put
    /// the alphabetic baseline at 80% of the nominal font size. A non-text
    /// layer contributes its lower edge, matching Figma's documented
    /// text-baseline behavior when it shares a horizontal row with text.
    fn auto_layout_baseline_offset(&self, node: &Node, counter_extent: f64) -> f64 {
        if node.kind != NodeKind::Text {
            return counter_extent.max(0.0);
        }
        let properties = self.node_text_properties.get(&node.id);
        let font_size = properties
            .and_then(|value| value.runs.first())
            .map(|run| run.font_size)
            .unwrap_or(31.0);
        let line_height = properties
            .map(|value| value.paragraph.effective_line_height(font_size))
            .unwrap_or(20.0);
        let leading_trim = properties
            .and_then(|value| value.runs.first().or(value.base_style.as_ref()))
            .and_then(|style| style.leading_trim);
        normalize_layout_number(if leading_trim == Some(LeadingTrim::CapHeight) {
            font_size * 0.7
        } else {
            (line_height - font_size) / 2.0 + font_size * 0.8
        })
    }

    fn reflow_auto_layout(
        &mut self,
        dirty_frames: Vec<NodeId>,
    ) -> Result<Vec<AppliedChange>, CommandError> {
        const MAX_LAYOUT_NODES: usize = 10_000;
        const MAX_LAYOUT_ITERATIONS: usize = 32;
        let mut changes = Vec::new();
        let mut visited_nodes = BTreeSet::new();
        for _iteration in 0..MAX_LAYOUT_ITERATIONS {
            let changes_before_iteration = changes.len();
            for frame_id in dirty_frames.iter().copied() {
                let layout = self.auto_layout_for_node(frame_id);
                if layout.mode == LayoutMode::None {
                    continue;
                }
                let frame = self
                    .nodes
                    .get(&frame_id)
                    .cloned()
                    .ok_or(CommandError::MissingNode { id: frame_id })?;
                if !is_frame_like(&frame.kind) || frame.relative_transform.is_some() {
                    return Err(CommandError::AutoLayoutUnsupported);
                }
                let children = self
                    .child_ids_for(frame_id)
                    .into_iter()
                    .filter_map(|id| self.nodes.get(&id).map(|node| node.as_ref().clone()))
                    .collect::<Vec<_>>();
                visited_nodes.extend(children.iter().map(|child| child.id));
                if visited_nodes.len() > MAX_LAYOUT_NODES {
                    return Err(CommandError::AutoLayoutLimit);
                }
                let flow = children
                    .into_iter()
                    .filter(|node| !self.auto_layout_for_node(node.id).absolute)
                    .collect::<Vec<_>>();
                if flow.iter().any(|node| node.relative_transform.is_some()) {
                    return Err(CommandError::AutoLayoutUnsupported);
                }
                if layout.mode == LayoutMode::Grid {
                    let [top, right, bottom, left] = layout.padding;
                    let row_gap = layout.grid_row_gap.unwrap_or(0.0);
                    let column_gap = layout.grid_column_gap.unwrap_or(0.0);
                    let mut grid_rows = layout.grid_rows.clone();
                    let column_count = layout.grid_columns.len();
                    let max_row_count = 128_usize.min(4096 / column_count);
                    let mut cell_count = grid_rows.len().saturating_mul(column_count);
                    if layout.grid_auto_tracks == GridAutoTracks::None && flow.len() > cell_count {
                        return Err(CommandError::AutoLayoutUnsupported);
                    }
                    let clamp_size = |value: f64, min: Option<f64>, max: Option<f64>| {
                        max.map(|limit| value.min(limit))
                            .unwrap_or(value)
                            .max(min.unwrap_or(0.0))
                    };
                    let mut hug_rows = vec![0.0_f64; grid_rows.len()];
                    let mut hug_columns = vec![0.0_f64; layout.grid_columns.len()];
                    let mut occupied = vec![false; cell_count];
                    let mut prepared = Vec::with_capacity(flow.len());
                    for child in flow {
                        let child_layout = self.auto_layout_for_node(child.id);
                        let (width_sizing, height_sizing) =
                            self.auto_layout_child_sizing(&child, true);
                        if width_sizing == LayoutSizing::Hug
                            || height_sizing == LayoutSizing::Hug
                            || child_layout.wrap
                            || child_layout.align_self.is_some()
                        {
                            return Err(CommandError::AutoLayoutUnsupported);
                        }
                        let row_span = child_layout.grid_row_span.unwrap_or(1) as usize;
                        let column_span = child_layout.grid_column_span.unwrap_or(1) as usize;
                        if (layout.grid_auto_tracks == GridAutoTracks::None
                            && row_span > grid_rows.len())
                            || row_span > max_row_count
                            || column_span > layout.grid_columns.len()
                        {
                            return Err(CommandError::AutoLayoutUnsupported);
                        }
                        let mut placement = match layout.grid_items_positioning {
                            GridItemsPositioning::Manual => child_layout
                                .grid_row_anchor
                                .zip(child_layout.grid_column_anchor)
                                .map(|(row, column)| (row as usize, column as usize)),
                            GridItemsPositioning::RowAutoFlow => {
                                if child_layout.grid_row_anchor.is_some()
                                    || child_layout.grid_column_anchor.is_some()
                                {
                                    return Err(CommandError::InvalidAutoLayout);
                                }
                                None
                            }
                        };
                        if layout.grid_items_positioning == GridItemsPositioning::RowAutoFlow {
                            loop {
                                'cells: for index in 0..cell_count {
                                    let row = index / column_count;
                                    let column = index % column_count;
                                    if row + row_span > grid_rows.len()
                                        || column + column_span > column_count
                                    {
                                        continue;
                                    }
                                    for occupied_row in row..row + row_span {
                                        for occupied_column in column..column + column_span {
                                            if occupied
                                                [occupied_row * column_count + occupied_column]
                                            {
                                                continue 'cells;
                                            }
                                        }
                                    }
                                    placement = Some((row, column));
                                    break 'cells;
                                }
                                if placement.is_some()
                                    || layout.grid_auto_tracks != GridAutoTracks::Rows
                                    || grid_rows.len() >= max_row_count
                                {
                                    break;
                                }
                                grid_rows.push(GridTrack::Flex(1.0));
                                hug_rows.push(0.0);
                                occupied.extend(std::iter::repeat_n(false, column_count));
                                cell_count += column_count;
                            }
                        }
                        let (row, column) = placement.ok_or(CommandError::AutoLayoutUnsupported)?;
                        if row + row_span > grid_rows.len() || column + column_span > column_count {
                            return Err(CommandError::AutoLayoutUnsupported);
                        }
                        for occupied_row in row..row + row_span {
                            for occupied_column in column..column + column_span {
                                let index = occupied_row * column_count + occupied_column;
                                if occupied[index] {
                                    return Err(CommandError::AutoLayoutUnsupported);
                                }
                                occupied[index] = true;
                            }
                        }

                        let measure_hug_tracks =
                            |tracks: &[GridTrack],
                             hug_sizes: &mut [f64],
                             start: usize,
                             span: usize,
                             sizing: LayoutSizing,
                             child_size: f64,
                             min: Option<f64>,
                             max: Option<f64>,
                             gap: f64|
                             -> Result<(), CommandError> {
                                let selected = &tracks[start..start + span];
                                let hug_indices = selected
                                    .iter()
                                    .enumerate()
                                    .filter_map(|(index, track)| {
                                        (*track == GridTrack::Hug).then_some(start + index)
                                    })
                                    .collect::<Vec<_>>();
                                if hug_indices.is_empty() {
                                    return Ok(());
                                }
                                if sizing == LayoutSizing::Fill {
                                    return Err(CommandError::AutoLayoutUnsupported);
                                }
                                let measured = clamp_size(child_size, min, max);
                                if span == 1 {
                                    hug_sizes[start] = hug_sizes[start].max(measured);
                                    return Ok(());
                                }
                                if selected
                                    .iter()
                                    .any(|track| matches!(track, GridTrack::Flex(_)))
                                {
                                    return Ok(());
                                }
                                let fixed = selected
                                    .iter()
                                    .map(|track| match track {
                                        GridTrack::Fixed(value) => *value,
                                        GridTrack::Flex(_) | GridTrack::Hug => 0.0,
                                    })
                                    .sum::<f64>()
                                    + gap * span.saturating_sub(1) as f64;
                                let existing = hug_indices
                                    .iter()
                                    .map(|index| hug_sizes[*index])
                                    .sum::<f64>();
                                let addition = (measured - fixed - existing).max(0.0)
                                    / hug_indices.len() as f64;
                                for index in hug_indices {
                                    hug_sizes[index] += addition;
                                }
                                Ok(())
                            };
                        measure_hug_tracks(
                            &layout.grid_columns,
                            &mut hug_columns,
                            column,
                            column_span,
                            width_sizing,
                            child.width,
                            child_layout.min_width,
                            child_layout.max_width,
                            column_gap,
                        )?;
                        measure_hug_tracks(
                            &grid_rows,
                            &mut hug_rows,
                            row,
                            row_span,
                            height_sizing,
                            child.height,
                            child_layout.min_height,
                            child_layout.max_height,
                            row_gap,
                        )?;
                        prepared.push((
                            child,
                            row,
                            column,
                            row_span,
                            column_span,
                            child_layout,
                            width_sizing,
                            height_sizing,
                        ));
                    }
                    let intrinsic_tracks = |tracks: &[GridTrack], hug_sizes: &[f64], gap: f64| {
                        tracks
                            .iter()
                            .enumerate()
                            .map(|(index, track)| match track {
                                GridTrack::Fixed(value) => *value,
                                GridTrack::Hug => hug_sizes[index],
                                GridTrack::Flex(_) => 0.0,
                            })
                            .sum::<f64>()
                            + gap * tracks.len().saturating_sub(1) as f64
                    };
                    let candidate_width = clamp_size(
                        if layout.primary_sizing == LayoutSizing::Hug {
                            left + intrinsic_tracks(&layout.grid_columns, &hug_columns, column_gap)
                                + right
                        } else {
                            frame.width
                        },
                        layout.min_width,
                        layout.max_width,
                    );
                    let candidate_height = clamp_size(
                        if layout.counter_sizing == LayoutSizing::Hug {
                            top + intrinsic_tracks(&grid_rows, &hug_rows, row_gap) + bottom
                        } else {
                            frame.height
                        },
                        layout.min_height,
                        layout.max_height,
                    );
                    if frame.width != candidate_width || frame.height != candidate_height {
                        let before = Geometry {
                            x: frame.x,
                            y: frame.y,
                            width: frame.width,
                            height: frame.height,
                            rotation: frame.rotation,
                        };
                        let after = Geometry {
                            x: frame.x,
                            y: frame.y,
                            width: normalize_layout_number(candidate_width),
                            height: normalize_layout_number(candidate_height),
                            rotation: frame.rotation,
                        };
                        let node = self.nodes.get_mut(&frame_id).expect("grid frame exists");
                        (node.width, node.height) = (after.width, after.height);
                        changes.push(AppliedChange::GeometryChanged {
                            id: frame_id,
                            before,
                            after,
                        });
                    }
                    let frame = self
                        .nodes
                        .get(&frame_id)
                        .cloned()
                        .expect("grid frame exists");
                    let content_width = frame.width - left - right;
                    let content_height = frame.height - top - bottom;
                    if content_width < 0.0 || content_height < 0.0 {
                        return Err(CommandError::InvalidAutoLayout);
                    }
                    let resolve_tracks =
                        |tracks: &[GridTrack], hug_sizes: &[f64], extent: f64, gap: f64| {
                            let gaps = gap * tracks.len().saturating_sub(1) as f64;
                            let fixed = tracks
                                .iter()
                                .enumerate()
                                .map(|(index, track)| match track {
                                    GridTrack::Fixed(value) => *value,
                                    GridTrack::Flex(_) => 0.0,
                                    GridTrack::Hug => hug_sizes[index],
                                })
                                .sum::<f64>();
                            let flex = tracks
                                .iter()
                                .map(|track| match track {
                                    GridTrack::Flex(value) => *value,
                                    GridTrack::Fixed(_) | GridTrack::Hug => 0.0,
                                })
                                .sum::<f64>();
                            if fixed + gaps > extent {
                                return Err(CommandError::InvalidAutoLayout);
                            }
                            let remaining = (extent - fixed - gaps).max(0.0);
                            Ok(tracks
                                .iter()
                                .enumerate()
                                .map(|(index, track)| match track {
                                    GridTrack::Fixed(value) => *value,
                                    GridTrack::Flex(value) => remaining * *value / flex,
                                    GridTrack::Hug => hug_sizes[index],
                                })
                                .collect::<Vec<_>>())
                        };
                    let row_sizes = resolve_tracks(&grid_rows, &hug_rows, content_height, row_gap)?;
                    let column_sizes = resolve_tracks(
                        &layout.grid_columns,
                        &hug_columns,
                        content_width,
                        column_gap,
                    )?;
                    let offsets = |sizes: &[f64], gap: f64| {
                        let mut cursor = 0.0;
                        sizes
                            .iter()
                            .map(|size| {
                                let offset = cursor;
                                cursor += *size + gap;
                                offset
                            })
                            .collect::<Vec<_>>()
                    };
                    let row_offsets = offsets(&row_sizes, row_gap);
                    let column_offsets = offsets(&column_sizes, column_gap);
                    let span_extent = |sizes: &[f64], start: usize, span: usize, gap: f64| {
                        sizes[start..start + span].iter().sum::<f64>()
                            + gap * span.saturating_sub(1) as f64
                    };
                    for (
                        child,
                        row,
                        column,
                        row_span,
                        column_span,
                        child_layout,
                        width_sizing,
                        height_sizing,
                    ) in prepared
                    {
                        let cell_width =
                            span_extent(&column_sizes, column, column_span, column_gap);
                        let cell_height = span_extent(&row_sizes, row, row_span, row_gap);
                        let width = clamp_size(
                            if width_sizing == LayoutSizing::Fill {
                                cell_width
                            } else {
                                child.width
                            },
                            child_layout.min_width,
                            child_layout.max_width,
                        );
                        let height = clamp_size(
                            if height_sizing == LayoutSizing::Fill {
                                cell_height
                            } else {
                                child.height
                            },
                            child_layout.min_height,
                            child_layout.max_height,
                        );
                        if (width_sizing == LayoutSizing::Fill && width > cell_width)
                            || (height_sizing == LayoutSizing::Fill && height > cell_height)
                        {
                            return Err(CommandError::InvalidAutoLayout);
                        }
                        let before = Geometry {
                            x: child.x,
                            y: child.y,
                            width: child.width,
                            height: child.height,
                            rotation: child.rotation,
                        };
                        let after = Geometry {
                            x: normalize_layout_number(
                                frame.x
                                    + left
                                    + column_offsets[column]
                                    + match child_layout.grid_child_horizontal_align {
                                        GridChildAlignment::Auto | GridChildAlignment::Min => 0.0,
                                        GridChildAlignment::Center => (cell_width - width) / 2.0,
                                        GridChildAlignment::Max => cell_width - width,
                                    },
                            ),
                            y: normalize_layout_number(
                                frame.y
                                    + top
                                    + row_offsets[row]
                                    + match child_layout.grid_child_vertical_align {
                                        GridChildAlignment::Auto | GridChildAlignment::Min => 0.0,
                                        GridChildAlignment::Center => (cell_height - height) / 2.0,
                                        GridChildAlignment::Max => cell_height - height,
                                    },
                            ),
                            width: normalize_layout_number(width),
                            height: normalize_layout_number(height),
                            rotation: child.rotation,
                        };
                        if before != after {
                            let node = self.nodes.get_mut(&child.id).expect("grid child exists");
                            (node.x, node.y, node.width, node.height) =
                                (after.x, after.y, after.width, after.height);
                            changes.push(AppliedChange::GeometryChanged {
                                id: child.id,
                                before,
                                after,
                            });
                        }
                    }
                    continue;
                }
                let horizontal = layout.mode == LayoutMode::Horizontal;
                if flow.iter().any(|node| {
                    let child = self.auto_layout_for_node(node.id);
                    let (primary_sizing, counter_sizing) =
                        self.auto_layout_child_sizing(node, horizontal);
                    let text_auto_size = self
                        .node_text_properties
                        .get(&node.id)
                        .map(|properties| properties.auto_size);
                    let text_supports_primary_hug = node.kind == NodeKind::Text
                        && (matches!(text_auto_size, Some(TextAutoSize::WidthAndHeight))
                            || (!horizontal
                                && matches!(text_auto_size, Some(TextAutoSize::Height))));
                    let text_supports_counter_hug = node.kind == NodeKind::Text
                        && (matches!(text_auto_size, Some(TextAutoSize::WidthAndHeight))
                            || (horizontal
                                && matches!(text_auto_size, Some(TextAutoSize::Height))));
                    (primary_sizing == LayoutSizing::Hug
                        && !is_frame_like(&node.kind)
                        && !text_supports_primary_hug)
                        || (counter_sizing == LayoutSizing::Hug
                            && !is_frame_like(&node.kind)
                            && !text_supports_counter_hug)
                        || child.wrap
                }) {
                    return Err(CommandError::AutoLayoutUnsupported);
                }
                let [top, right, bottom, left] = layout.padding;
                let intrinsic_primary = flow
                    .iter()
                    .map(|node| {
                        let (primary_sizing, _) = self.auto_layout_child_sizing(node, horizontal);
                        let (text_width, text_height) = (node.kind == NodeKind::Text)
                            .then(|| self.auto_layout_text_size(node))
                            .unwrap_or((node.width, node.height));
                        if primary_sizing == LayoutSizing::Hug {
                            if horizontal { text_width } else { text_height }
                        } else if horizontal {
                            node.width
                        } else {
                            node.height
                        }
                    })
                    .sum::<f64>()
                    + layout.item_spacing * flow.len().saturating_sub(1) as f64;
                let intrinsic_counter = flow
                    .iter()
                    .map(|node| {
                        let (_, counter_sizing) = self.auto_layout_child_sizing(node, horizontal);
                        let (text_width, text_height) = (node.kind == NodeKind::Text)
                            .then(|| self.auto_layout_text_size(node))
                            .unwrap_or((node.width, node.height));
                        if counter_sizing == LayoutSizing::Hug {
                            if horizontal { text_height } else { text_width }
                        } else if horizontal {
                            node.height
                        } else {
                            node.width
                        }
                    })
                    .fold(0.0, f64::max);
                let clamp_size = |value: f64, min: Option<f64>, max: Option<f64>| {
                    max.map(|limit| value.min(limit))
                        .unwrap_or(value)
                        .max(min.unwrap_or(0.0))
                };
                let (candidate_width, candidate_height) = if horizontal {
                    (
                        clamp_size(
                            if layout.primary_sizing == LayoutSizing::Hug {
                                left + intrinsic_primary + right
                            } else {
                                frame.width
                            },
                            layout.min_width,
                            layout.max_width,
                        ),
                        clamp_size(
                            if layout.counter_sizing == LayoutSizing::Hug && !layout.wrap {
                                top + intrinsic_counter + bottom
                            } else {
                                frame.height
                            },
                            layout.min_height,
                            layout.max_height,
                        ),
                    )
                } else {
                    (
                        clamp_size(
                            if layout.counter_sizing == LayoutSizing::Hug {
                                left + intrinsic_counter + right
                            } else {
                                frame.width
                            },
                            layout.min_width,
                            layout.max_width,
                        ),
                        clamp_size(
                            if layout.primary_sizing == LayoutSizing::Hug {
                                top + intrinsic_primary + bottom
                            } else {
                                frame.height
                            },
                            layout.min_height,
                            layout.max_height,
                        ),
                    )
                };
                if frame.width != candidate_width || frame.height != candidate_height {
                    let before = Geometry {
                        x: frame.x,
                        y: frame.y,
                        width: frame.width,
                        height: frame.height,
                        rotation: frame.rotation,
                    };
                    let after = Geometry {
                        x: frame.x,
                        y: frame.y,
                        width: normalize_layout_number(candidate_width),
                        height: normalize_layout_number(candidate_height),
                        rotation: frame.rotation,
                    };
                    let node = self.nodes.get_mut(&frame_id).expect("layout frame exists");
                    (node.width, node.height) = (after.width, after.height);
                    changes.push(AppliedChange::GeometryChanged {
                        id: frame_id,
                        before,
                        after,
                    });
                }
                let mut frame = self
                    .nodes
                    .get(&frame_id)
                    .cloned()
                    .expect("layout frame exists");
                let primary_extent = if horizontal {
                    frame.width - left - right
                } else {
                    frame.height - top - bottom
                };
                let mut counter_extent = if horizontal {
                    frame.height - top - bottom
                } else {
                    frame.width - left - right
                };
                if primary_extent < 0.0
                    || (counter_extent < 0.0
                        && !(layout.wrap && layout.counter_sizing == LayoutSizing::Hug))
                {
                    return Err(CommandError::InvalidAutoLayout);
                }
                if layout.wrap {
                    if layout.primary_sizing != LayoutSizing::Fixed
                        || layout.counter_sizing == LayoutSizing::Fill
                    {
                        return Err(CommandError::AutoLayoutUnsupported);
                    }
                    struct WrapItem {
                        node: Node,
                        primary_sizing: LayoutSizing,
                        primary: f64,
                        primary_max: Option<f64>,
                        counter_sizing: LayoutSizing,
                        counter: f64,
                        counter_max: Option<f64>,
                    }
                    let mut lines = Vec::<Vec<WrapItem>>::new();
                    let mut line_primary = 0.0;
                    for child in flow {
                        let child_layout = self.auto_layout_for_node(child.id);
                        let (primary_sizing, counter_sizing) =
                            self.auto_layout_child_sizing(&child, horizontal);
                        let (text_width, text_height) = (child.kind == NodeKind::Text)
                            .then(|| self.auto_layout_text_size(&child))
                            .unwrap_or((child.width, child.height));
                        let (primary_min, primary_max, counter_min, counter_max) = if horizontal {
                            (
                                child_layout.min_width,
                                child_layout.max_width,
                                child_layout.min_height,
                                child_layout.max_height,
                            )
                        } else {
                            (
                                child_layout.min_height,
                                child_layout.max_height,
                                child_layout.min_width,
                                child_layout.max_width,
                            )
                        };
                        // Wrapped FILL items use their declared minimum as the
                        // stable flex basis. This avoids feeding a prior
                        // reflow's expanded geometry back into line breaking;
                        // the remaining primary extent is distributed per row
                        // after the row membership is fixed.
                        let primary = match primary_sizing {
                            LayoutSizing::Fill => primary_min.unwrap_or(0.0),
                            LayoutSizing::Hug => clamp_size(
                                if horizontal { text_width } else { text_height },
                                primary_min,
                                primary_max,
                            ),
                            LayoutSizing::Fixed => clamp_size(
                                if horizontal {
                                    child.width
                                } else {
                                    child.height
                                },
                                primary_min,
                                primary_max,
                            ),
                        };
                        let counter = match counter_sizing {
                            LayoutSizing::Fill => counter_min.unwrap_or(0.0),
                            LayoutSizing::Hug => clamp_size(
                                if horizontal { text_height } else { text_width },
                                counter_min,
                                counter_max,
                            ),
                            LayoutSizing::Fixed => clamp_size(
                                if horizontal {
                                    child.height
                                } else {
                                    child.width
                                },
                                counter_min,
                                counter_max,
                            ),
                        };
                        let next_primary = if lines.last().is_some_and(|line| !line.is_empty()) {
                            line_primary + layout.item_spacing + primary
                        } else {
                            primary
                        };
                        if next_primary > primary_extent
                            && lines.last().is_some_and(|line| !line.is_empty())
                        {
                            lines.push(Vec::new());
                            line_primary = 0.0;
                        }
                        if lines.is_empty() {
                            lines.push(Vec::new());
                        }
                        let line = lines.last_mut().expect("wrap line exists");
                        line_primary = if line.is_empty() {
                            primary
                        } else {
                            line_primary + layout.item_spacing + primary
                        };
                        line.push(WrapItem {
                            node: child,
                            primary_sizing,
                            primary,
                            primary_max,
                            counter_sizing,
                            counter,
                            counter_max,
                        });
                    }
                    // Each row owns an independent FILL distribution. Maximum
                    // constraints retire saturated items before the remaining
                    // width is shared by the rest, matching the non-wrap path.
                    for line in &mut lines {
                        let regular_spacing =
                            layout.item_spacing * line.len().saturating_sub(1) as f64;
                        let fixed_content_extent = line
                            .iter()
                            .filter(|item| item.primary_sizing != LayoutSizing::Fill)
                            .map(|item| item.primary)
                            .sum::<f64>();
                        let mut fill_indices = line
                            .iter()
                            .enumerate()
                            .filter_map(|(index, item)| {
                                (item.primary_sizing == LayoutSizing::Fill).then_some(index)
                            })
                            .collect::<Vec<_>>();
                        let available_fill_extent =
                            primary_extent - fixed_content_extent - regular_spacing;
                        let minimum_fill_extent = fill_indices
                            .iter()
                            .map(|index| line[*index].primary)
                            .sum::<f64>();
                        if !fill_indices.is_empty()
                            && minimum_fill_extent > available_fill_extent + 1e-6
                        {
                            return Err(CommandError::InvalidAutoLayout);
                        }
                        let mut remaining_fill_extent =
                            (available_fill_extent - minimum_fill_extent).max(0.0);
                        while remaining_fill_extent > 1e-6 && !fill_indices.is_empty() {
                            let share = remaining_fill_extent / fill_indices.len() as f64;
                            let constrained = fill_indices
                                .iter()
                                .copied()
                                .filter(|index| {
                                    line[*index].primary_max.is_some_and(|maximum| {
                                        maximum - line[*index].primary < share
                                    })
                                })
                                .collect::<Vec<_>>();
                            if constrained.is_empty() {
                                for index in fill_indices {
                                    line[index].primary += share;
                                }
                                break;
                            }
                            for index in constrained {
                                let maximum = line[index]
                                    .primary_max
                                    .expect("constrained wrapped fill has a maximum");
                                remaining_fill_extent -= maximum - line[index].primary;
                                line[index].primary = maximum;
                            }
                            fill_indices.retain(|index| {
                                !line[*index].primary_max.is_some_and(|maximum| {
                                    (maximum - line[*index].primary).abs() <= 1e-6
                                })
                            });
                        }
                    }
                    let mut track_extents = lines
                        .iter()
                        .map(|line| line.iter().map(|item| item.counter).fold(0.0, f64::max))
                        .collect::<Vec<_>>();
                    let automatic_track_spacing =
                        layout.track_spacing.unwrap_or(layout.item_spacing);
                    let has_counter_fill = lines
                        .iter()
                        .flatten()
                        .any(|item| item.counter_sizing == LayoutSizing::Fill);
                    let all_counter_fill = has_counter_fill
                        && lines
                            .iter()
                            .flatten()
                            .all(|item| item.counter_sizing == LayoutSizing::Fill);
                    if layout.counter_sizing == LayoutSizing::Hug {
                        if has_counter_fill {
                            return Err(CommandError::AutoLayoutUnsupported);
                        }
                        let intrinsic_spacing = match layout.track_alignment {
                            WrapTrackAlignment::Auto => {
                                automatic_track_spacing
                                    * track_extents.len().saturating_sub(1) as f64
                            }
                            WrapTrackAlignment::SpaceBetween => 0.0,
                        };
                        let intrinsic_counter_extent =
                            track_extents.iter().sum::<f64>() + intrinsic_spacing;
                        let candidate_counter = if horizontal {
                            clamp_size(
                                top + intrinsic_counter_extent + bottom,
                                layout.min_height,
                                layout.max_height,
                            )
                        } else {
                            clamp_size(
                                left + intrinsic_counter_extent + right,
                                layout.min_width,
                                layout.max_width,
                            )
                        };
                        let current_counter = if horizontal {
                            frame.height
                        } else {
                            frame.width
                        };
                        if current_counter != candidate_counter {
                            let before = Geometry {
                                x: frame.x,
                                y: frame.y,
                                width: frame.width,
                                height: frame.height,
                                rotation: frame.rotation,
                            };
                            if horizontal {
                                frame.height = normalize_layout_number(candidate_counter);
                            } else {
                                frame.width = normalize_layout_number(candidate_counter);
                            }
                            let after = Geometry {
                                x: frame.x,
                                y: frame.y,
                                width: frame.width,
                                height: frame.height,
                                rotation: frame.rotation,
                            };
                            let stored =
                                self.nodes.get_mut(&frame_id).expect("layout frame exists");
                            (stored.width, stored.height) = (after.width, after.height);
                            changes.push(AppliedChange::GeometryChanged {
                                id: frame_id,
                                before,
                                after,
                            });
                            counter_extent = if horizontal {
                                frame.height - top - bottom
                            } else {
                                frame.width - left - right
                            };
                        }
                    }
                    // Figma's AUTO track alignment stretches the tracks only
                    // when every flow child is STRETCH. Child max constraints
                    // may cap the painted child while the track itself still
                    // consumes its equal share of the container.
                    if layout.track_alignment == WrapTrackAlignment::Auto && all_counter_fill {
                        let available_track_extent = counter_extent
                            - automatic_track_spacing
                                * track_extents.len().saturating_sub(1) as f64;
                        let minimum_track_extent = track_extents.iter().sum::<f64>();
                        if minimum_track_extent > available_track_extent + 1e-6 {
                            return Err(CommandError::InvalidAutoLayout);
                        }
                        let extra = (available_track_extent - minimum_track_extent).max(0.0)
                            / track_extents.len() as f64;
                        track_extents.iter_mut().for_each(|extent| *extent += extra);
                    }
                    let total_track_extent = track_extents.iter().sum::<f64>();
                    let track_spacing = match layout.track_alignment {
                        WrapTrackAlignment::Auto => automatic_track_spacing,
                        WrapTrackAlignment::SpaceBetween if lines.len() > 1 => {
                            ((counter_extent - total_track_extent).max(0.0))
                                / (lines.len() - 1) as f64
                        }
                        WrapTrackAlignment::SpaceBetween => 0.0,
                    };
                    let mut counter_cursor = 0.0;
                    for (line_index, line) in lines.iter().enumerate() {
                        let content_primary = line.iter().map(|item| item.primary).sum::<f64>();
                        let regular_spacing =
                            layout.item_spacing * line.len().saturating_sub(1) as f64;
                        let (mut primary_cursor, spacing) = match layout.primary_alignment {
                            LayoutAlignment::Start => (0.0, layout.item_spacing),
                            LayoutAlignment::Center => (
                                ((primary_extent - content_primary - regular_spacing).max(0.0))
                                    / 2.0,
                                layout.item_spacing,
                            ),
                            LayoutAlignment::End => (
                                (primary_extent - content_primary - regular_spacing).max(0.0),
                                layout.item_spacing,
                            ),
                            LayoutAlignment::SpaceBetween if line.len() > 1 => (
                                0.0,
                                ((primary_extent - content_primary).max(0.0))
                                    / (line.len() - 1) as f64,
                            ),
                            LayoutAlignment::SpaceBetween => (0.0, 0.0),
                            LayoutAlignment::Baseline => {
                                return Err(CommandError::InvalidAutoLayout);
                            }
                        };
                        let line_counter = track_extents[line_index];
                        let line_baseline = (horizontal
                            && layout.counter_alignment == LayoutAlignment::Baseline)
                            .then(|| {
                                line.iter()
                                    .filter(|item| {
                                        item.counter_sizing != LayoutSizing::Fill
                                            && self
                                                .auto_layout_for_node(item.node.id)
                                                .align_self
                                                .is_none()
                                    })
                                    .map(|item| {
                                        self.auto_layout_baseline_offset(&item.node, item.counter)
                                    })
                                    .fold(0.0, f64::max)
                            })
                            .unwrap_or(0.0);
                        for item in line {
                            let child = &item.node;
                            let primary = item.primary;
                            let counter = if item.counter_sizing == LayoutSizing::Fill {
                                clamp_size(line_counter, Some(item.counter), item.counter_max)
                            } else {
                                item.counter
                            };
                            let counter_alignment = self
                                .auto_layout_for_node(child.id)
                                .align_self
                                .unwrap_or(layout.counter_alignment);
                            let counter_offset = if item.counter_sizing == LayoutSizing::Fill {
                                0.0
                            } else {
                                match counter_alignment {
                                    LayoutAlignment::Start | LayoutAlignment::SpaceBetween => 0.0,
                                    LayoutAlignment::Center => {
                                        ((line_counter - counter).max(0.0)) / 2.0
                                    }
                                    LayoutAlignment::End => (line_counter - counter).max(0.0),
                                    LayoutAlignment::Baseline => {
                                        line_baseline
                                            - self.auto_layout_baseline_offset(child, counter)
                                    }
                                }
                            };
                            let (x, y) = if horizontal {
                                (
                                    frame.x + left + primary_cursor,
                                    frame.y + top + counter_cursor + counter_offset,
                                )
                            } else {
                                (
                                    frame.x + left + counter_cursor + counter_offset,
                                    frame.y + top + primary_cursor,
                                )
                            };
                            primary_cursor += primary + spacing;
                            let after = Geometry {
                                x: normalize_layout_number(x),
                                y: normalize_layout_number(y),
                                width: normalize_layout_number(if horizontal {
                                    primary
                                } else {
                                    counter
                                }),
                                height: normalize_layout_number(if horizontal {
                                    counter
                                } else {
                                    primary
                                }),
                                rotation: child.rotation,
                            };
                            let before = Geometry {
                                x: child.x,
                                y: child.y,
                                width: child.width,
                                height: child.height,
                                rotation: child.rotation,
                            };
                            if before != after {
                                let node =
                                    self.nodes.get_mut(&child.id).expect("layout child exists");
                                (node.x, node.y, node.width, node.height) =
                                    (after.x, after.y, after.width, after.height);
                                changes.push(AppliedChange::GeometryChanged {
                                    id: child.id,
                                    before,
                                    after,
                                });
                            }
                        }
                        counter_cursor += line_counter;
                        if line_index + 1 < lines.len() {
                            counter_cursor += track_spacing;
                        }
                    }
                    continue;
                }
                let regular_spacing = layout.item_spacing * flow.len().saturating_sub(1) as f64;
                let mut sized = flow
                    .into_iter()
                    .map(|child| {
                        let child_layout = self.auto_layout_for_node(child.id);
                        let (primary_sizing, counter_sizing) =
                            self.auto_layout_child_sizing(&child, horizontal);
                        let (text_width, text_height) = (child.kind == NodeKind::Text)
                            .then(|| self.auto_layout_text_size(&child))
                            .unwrap_or((child.width, child.height));
                        let (primary_min, primary_max, counter_min, counter_max) = if horizontal {
                            (
                                child_layout.min_width,
                                child_layout.max_width,
                                child_layout.min_height,
                                child_layout.max_height,
                            )
                        } else {
                            (
                                child_layout.min_height,
                                child_layout.max_height,
                                child_layout.min_width,
                                child_layout.max_width,
                            )
                        };
                        let primary = if primary_sizing == LayoutSizing::Fill {
                            primary_min.unwrap_or(0.0)
                        } else if primary_sizing == LayoutSizing::Hug {
                            clamp_size(
                                if horizontal { text_width } else { text_height },
                                primary_min,
                                primary_max,
                            )
                        } else {
                            clamp_size(
                                if horizontal {
                                    child.width
                                } else {
                                    child.height
                                },
                                primary_min,
                                primary_max,
                            )
                        };
                        let counter = if counter_sizing == LayoutSizing::Fill {
                            if counter_min.is_some_and(|minimum| minimum > counter_extent) {
                                return Err(CommandError::InvalidAutoLayout);
                            }
                            clamp_size(counter_extent, counter_min, counter_max)
                        } else if counter_sizing == LayoutSizing::Hug {
                            clamp_size(
                                if horizontal { text_height } else { text_width },
                                counter_min,
                                counter_max,
                            )
                        } else {
                            clamp_size(
                                if horizontal {
                                    child.height
                                } else {
                                    child.width
                                },
                                counter_min,
                                counter_max,
                            )
                        };
                        Ok((child, primary_sizing, primary, counter, primary_max))
                    })
                    .collect::<Result<Vec<_>, CommandError>>()?;
                let fixed_content_extent = sized
                    .iter()
                    .filter(|(_, primary_sizing, _, _, _)| *primary_sizing != LayoutSizing::Fill)
                    .map(|(_, _, primary, _, _)| *primary)
                    .sum::<f64>();
                let fill_indices = sized
                    .iter()
                    .enumerate()
                    .filter_map(|(index, (_, primary_sizing, _, _, _))| {
                        (*primary_sizing == LayoutSizing::Fill).then_some(index)
                    })
                    .collect::<Vec<_>>();
                let available_fill_extent = primary_extent - fixed_content_extent - regular_spacing;
                let minimum_fill_extent = fill_indices
                    .iter()
                    .map(|index| sized[*index].2)
                    .sum::<f64>();
                if !fill_indices.is_empty() && minimum_fill_extent > available_fill_extent + 1e-6 {
                    return Err(CommandError::InvalidAutoLayout);
                }
                let mut remaining_fill_extent =
                    (available_fill_extent - minimum_fill_extent).max(0.0);
                let mut active_fill_indices = fill_indices;
                while remaining_fill_extent > 1e-6 && !active_fill_indices.is_empty() {
                    let share = remaining_fill_extent / active_fill_indices.len() as f64;
                    let constrained = active_fill_indices
                        .iter()
                        .copied()
                        .filter(|index| {
                            sized[*index]
                                .4
                                .is_some_and(|maximum| maximum - sized[*index].2 < share)
                        })
                        .collect::<Vec<_>>();
                    if constrained.is_empty() {
                        for index in active_fill_indices {
                            sized[index].2 += share;
                        }
                        break;
                    }
                    for index in constrained {
                        let maximum = sized[index].4.expect("constrained fill has a maximum");
                        remaining_fill_extent -= maximum - sized[index].2;
                        sized[index].2 = maximum;
                    }
                    active_fill_indices.retain(|index| {
                        !sized[*index]
                            .4
                            .is_some_and(|maximum| (maximum - sized[*index].2).abs() <= 1e-6)
                    });
                }
                let content_extent = sized
                    .iter()
                    .map(|(_, _, primary, _, _)| *primary)
                    .sum::<f64>();
                let (start_offset, spacing) = match layout.primary_alignment {
                    LayoutAlignment::Start => (0.0, layout.item_spacing),
                    LayoutAlignment::Center => (
                        ((primary_extent - content_extent - regular_spacing).max(0.0)) / 2.0,
                        layout.item_spacing,
                    ),
                    LayoutAlignment::End => (
                        (primary_extent - content_extent - regular_spacing).max(0.0),
                        layout.item_spacing,
                    ),
                    LayoutAlignment::SpaceBetween if sized.len() > 1 => (
                        0.0,
                        ((primary_extent - content_extent).max(0.0)) / (sized.len() - 1) as f64,
                    ),
                    LayoutAlignment::SpaceBetween => (0.0, 0.0),
                    LayoutAlignment::Baseline => return Err(CommandError::InvalidAutoLayout),
                };
                let baseline = (horizontal
                    && layout.counter_alignment == LayoutAlignment::Baseline)
                    .then(|| {
                        sized
                            .iter()
                            .filter(|(child, _, _, _, _)| {
                                self.auto_layout_for_node(child.id).align_self.is_none()
                            })
                            .map(|(child, _, _, counter, _)| {
                                self.auto_layout_baseline_offset(child, *counter)
                            })
                            .fold(0.0, f64::max)
                    })
                    .unwrap_or(0.0);
                let mut cursor = start_offset;
                for (child, _primary_sizing, primary, counter, _) in sized {
                    let counter_alignment = self
                        .auto_layout_for_node(child.id)
                        .align_self
                        .unwrap_or(layout.counter_alignment);
                    let counter_offset = match counter_alignment {
                        LayoutAlignment::Start | LayoutAlignment::SpaceBetween => 0.0,
                        LayoutAlignment::Center => ((counter_extent - counter).max(0.0)) / 2.0,
                        LayoutAlignment::End => (counter_extent - counter).max(0.0),
                        LayoutAlignment::Baseline => {
                            baseline - self.auto_layout_baseline_offset(&child, counter)
                        }
                    };
                    let (x, y) = if horizontal {
                        (frame.x + left + cursor, frame.y + top + counter_offset)
                    } else {
                        (frame.x + left + counter_offset, frame.y + top + cursor)
                    };
                    cursor += primary + spacing;
                    let after = Geometry {
                        x: normalize_layout_number(x),
                        y: normalize_layout_number(y),
                        width: normalize_layout_number(if horizontal { primary } else { counter }),
                        height: normalize_layout_number(if horizontal { counter } else { primary }),
                        rotation: child.rotation,
                    };
                    let before = Geometry {
                        x: child.x,
                        y: child.y,
                        width: child.width,
                        height: child.height,
                        rotation: child.rotation,
                    };
                    if before != after {
                        let node = self.nodes.get_mut(&child.id).expect("layout child exists");
                        (node.x, node.y, node.width, node.height) =
                            (after.x, after.y, after.width, after.height);
                        changes.push(AppliedChange::GeometryChanged {
                            id: child.id,
                            before,
                            after,
                        });
                    }
                }
            }
            if changes.len() == changes_before_iteration {
                return Ok(changes);
            }
        }
        return Err(CommandError::AutoLayoutLimit);
    }

    fn has_following_sibling(&self, id: NodeId) -> bool {
        let Some(node) = self.nodes.get(&id) else {
            return false;
        };
        let page_id = self.node_pages.get(&id).copied().unwrap_or(DEFAULT_PAGE_ID);
        self.nodes.values().any(|candidate| {
            candidate.id != id
                && self
                    .node_pages
                    .get(&candidate.id)
                    .copied()
                    .unwrap_or(DEFAULT_PAGE_ID)
                    == page_id
                && candidate.parent_id == node.parent_id
                && candidate.position > node.position
        })
    }

    /// M3's concrete Core gate for the prototype JSON extension mirror. The
    /// protobuf messages carry the same vocabulary, but extensions remain the
    /// forward-compatible storage until every older engine can preserve unknown
    /// `oneof` variants. Only P0 playable values are accepted on mutation.
    fn valid_prototype_extensions(&self, extensions: &BTreeMap<String, Vec<u8>>) -> bool {
        let Some(bytes) = extensions.get(PROTOTYPE_REACTIONS_EXTENSION_KEY) else {
            return valid_prototype_metadata_extension(
                extensions.get(PROTOTYPE_METADATA_EXTENSION_KEY),
            );
        };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) else {
            return false;
        };
        let Some(reactions) = value.as_array() else {
            return false;
        };
        if reactions.len() > 128 {
            return false;
        }
        for reaction in reactions {
            let Some(reaction) = reaction.as_object() else {
                return false;
            };
            let Some(trigger) = reaction
                .get("trigger")
                .and_then(serde_json::Value::as_object)
            else {
                return false;
            };
            let Some(trigger_type) = trigger.get("type").and_then(serde_json::Value::as_str) else {
                return false;
            };
            match trigger_type {
                "ON_CLICK" | "ON_PRESS" | "ON_HOVER" => {}
                "AFTER_TIMEOUT" => {
                    if !prototype_duration(trigger.get("timeout")) {
                        return false;
                    }
                }
                _ => return false,
            }
            let Some(actions) = reaction
                .get("actions")
                .and_then(serde_json::Value::as_array)
            else {
                return false;
            };
            if actions.is_empty() || actions.len() > 16 {
                return false;
            }
            for action in actions {
                let Some(action) = action.as_object() else {
                    return false;
                };
                match action.get("type").and_then(serde_json::Value::as_str) {
                    Some("BACK") | Some("CLOSE") => {}
                    Some("URL") => {
                        let Some(url) = action.get("url").and_then(serde_json::Value::as_str)
                        else {
                            return false;
                        };
                        if url.len() > 2_048 || !url.starts_with("https://") {
                            return false;
                        }
                    }
                    Some("NODE") => {
                        if !matches!(
                            action.get("navigation").and_then(serde_json::Value::as_str),
                            Some("NAVIGATE") | Some("OVERLAY")
                        ) {
                            return false;
                        }
                        match action.get("destinationId") {
                            Some(serde_json::Value::String(destination)) => {
                                let Some(destination) = prototype_node_id(destination) else {
                                    return false;
                                };
                                if !self.nodes.contains_key(&destination) {
                                    return false;
                                }
                            }
                            // A null target is only produced by Canonical delete
                            // cleanup; it is retained as an unresolved reference.
                            Some(serde_json::Value::Null) => {}
                            _ => return false,
                        }
                        if let Some(transition) = action.get("transition") {
                            if !transition.is_null() && !valid_prototype_transition(transition) {
                                return false;
                            }
                        }
                    }
                    _ => return false,
                }
            }
        }
        valid_prototype_metadata_extension(extensions.get(PROTOTYPE_METADATA_EXTENSION_KEY))
    }

    fn clear_prototype_destination(&mut self, target: NodeId) -> Vec<AppliedChange> {
        let ids = self.nodes.keys().copied().collect::<Vec<_>>();
        let mut changes = Vec::new();
        for id in ids {
            let Some(node) = self.nodes.get(&id) else {
                continue;
            };
            let before = node.extensions.clone();
            let Some(bytes) = before.get(PROTOTYPE_REACTIONS_EXTENSION_KEY) else {
                continue;
            };
            let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(bytes) else {
                continue;
            };
            if !clear_prototype_destination_value(&mut value, target) {
                continue;
            }
            let Ok(bytes) = serde_json::to_vec(&value) else {
                continue;
            };
            let mut after = before.clone();
            after.insert(PROTOTYPE_REACTIONS_EXTENSION_KEY.into(), bytes);
            self.set_extensions(id, &after);
            changes.push(AppliedChange::ExtensionsChanged { id, before, after });
        }
        changes
    }

    fn set_mask(&mut self, id: NodeId, enabled: bool) {
        let Some((before_bytes, after_bytes)) = self.nodes.get_mut(&id).map(|node| {
            let before_bytes = node.estimated_bytes();
            if enabled {
                node.extensions
                    .insert(ALPHA_MASK_EXTENSION_KEY.into(), vec![1]);
            } else {
                node.extensions.remove(ALPHA_MASK_EXTENSION_KEY);
            }
            (before_bytes, node.estimated_bytes())
        }) else {
            return;
        };
        self.node_bytes = self
            .node_bytes
            .saturating_sub(before_bytes)
            .saturating_add(after_bytes);
    }

    fn set_extensions(&mut self, id: NodeId, extensions: &BTreeMap<String, Vec<u8>>) {
        let Some((before_bytes, after_bytes)) = self.nodes.get_mut(&id).map(|node| {
            let before_bytes = node.estimated_bytes();
            node.extensions = extensions.clone();
            (before_bytes, node.estimated_bytes())
        }) else {
            return;
        };
        self.node_bytes = self
            .node_bytes
            .saturating_sub(before_bytes)
            .saturating_add(after_bytes);
    }

    fn set_vector_path(&mut self, id: NodeId, path: &VectorPath) {
        if let Some(node) = self.nodes.get_mut(&id) {
            let before_bytes = node.estimated_bytes();
            let after_bytes = before_bytes
                .saturating_sub(
                    node.vector_path
                        .as_ref()
                        .map(VectorPath::estimated_bytes)
                        .unwrap_or(0),
                )
                .saturating_add(path.estimated_bytes());
            node.vector_path = Some(path.clone());
            self.node_bytes = self
                .node_bytes
                .saturating_sub(before_bytes)
                .saturating_add(after_bytes);
        }
    }

    fn set_node_record(&mut self, id: NodeId, node: &Node) {
        if let Some(before) = self.nodes.get(&id) {
            let before_bytes = before.estimated_bytes();
            let after_bytes = node.estimated_bytes();
            self.nodes.insert(id, node.clone().into());
            self.node_bytes = self
                .node_bytes
                .saturating_sub(before_bytes)
                .saturating_add(after_bytes);
        }
    }

    fn convert_to_text_path(
        &mut self,
        id: NodeId,
        path: VectorPath,
    ) -> Result<AppliedChange, CommandError> {
        if !valid_vector_path(&path) {
            return Err(CommandError::InvalidGeometry);
        }
        let before = self
            .nodes
            .get(&id)
            .map(|node| node.as_ref().clone())
            .ok_or(CommandError::MissingNode { id })?;
        if !matches!(
            before.kind,
            NodeKind::Vector
                | NodeKind::Rectangle
                | NodeKind::Ellipse
                | NodeKind::Polygon
                | NodeKind::Star
                | NodeKind::Line
        ) || self.has_children(id)
        {
            return Err(CommandError::InvalidGeometry);
        }
        let mut after = before.clone();
        after.kind = NodeKind::TextPath;
        after.vector_path = Some(path);
        after.arc_data = None;
        after.parametric_shape = None;
        after.boolean_operation = None;
        after.corner_radius = 0.0;
        after.corner_radii.clear();
        after.corner_smoothing = 0.0;
        after.stroke_weights.clear();
        after.text.clear();
        after.contents_hidden = false;
        after.clips_content = false;
        if !valid_geometry(
            &after.kind,
            Geometry {
                x: after.x,
                y: after.y,
                width: after.width,
                height: after.height,
                rotation: after.rotation,
            },
        ) || !valid_vector_path_for_kind(&after.kind, after.vector_path.as_ref())
        {
            return Err(CommandError::InvalidGeometry);
        }
        let before_bytes = before.estimated_bytes();
        let after_bytes = after.estimated_bytes();
        if self
            .node_bytes
            .saturating_sub(before_bytes)
            .saturating_add(after_bytes)
            > MAX_DOCUMENT_BYTES
        {
            return Err(CommandError::ResourceLimit);
        }
        self.nodes.insert(id, after.clone().into());
        self.node_bytes = self
            .node_bytes
            .saturating_sub(before_bytes)
            .saturating_add(after_bytes);
        Ok(AppliedChange::NodeRecordChanged { id, before, after })
    }

    fn vector_path_for_node(&self, id: NodeId) -> Result<VectorPath, CommandError> {
        let node = self
            .nodes
            .get(&id)
            .ok_or(CommandError::MissingNode { id })?;
        if !matches!(node.kind, NodeKind::Vector | NodeKind::Highlight) {
            return Err(CommandError::InvalidGeometry);
        }
        node.vector_path
            .clone()
            .ok_or(CommandError::InvalidGeometry)
    }

    fn replace_vector_path(
        &mut self,
        id: NodeId,
        path: VectorPath,
    ) -> Result<AppliedChange, CommandError> {
        if !valid_vector_path(&path) {
            return Err(CommandError::InvalidGeometry);
        }
        let node = self
            .nodes
            .get_mut(&id)
            .ok_or(CommandError::MissingNode { id })?;
        if !matches!(node.kind, NodeKind::Vector | NodeKind::Highlight) {
            return Err(CommandError::InvalidGeometry);
        }
        let before_bytes = node.estimated_bytes();
        let after_bytes = before_bytes
            .saturating_sub(
                node.vector_path
                    .as_ref()
                    .map(VectorPath::estimated_bytes)
                    .unwrap_or(0),
            )
            .saturating_add(path.estimated_bytes());
        if self
            .node_bytes
            .saturating_sub(before_bytes)
            .saturating_add(after_bytes)
            > MAX_DOCUMENT_BYTES
        {
            return Err(CommandError::ResourceLimit);
        }
        let before = std::mem::replace(&mut node.vector_path, Some(path.clone()))
            .ok_or(CommandError::InvalidGeometry)?;
        self.node_bytes = self
            .node_bytes
            .saturating_sub(before_bytes)
            .saturating_add(after_bytes);
        Ok(AppliedChange::VectorPathChanged {
            id,
            before,
            after: path,
        })
    }

    fn set_node_position(&mut self, id: NodeId, position: PositionId) {
        if let Some(node) = self.nodes.get(&id) {
            let page_id = self.node_pages.get(&id).copied().unwrap_or(DEFAULT_PAGE_ID);
            let parent_id = node.parent_id;
            let before = node.position;
            self.unindex_child(page_id, parent_id, before, id);
            self.index_child(page_id, parent_id, position, id);
        }
        if let Some(node) = self.nodes.get_mut(&id) {
            node.position = position;
        }
    }

    fn set_node_parent(&mut self, id: NodeId, parent_id: Option<NodeId>, position: PositionId) {
        if let Some(node) = self.nodes.get(&id) {
            let page_id = self.node_pages.get(&id).copied().unwrap_or(DEFAULT_PAGE_ID);
            let before_parent_id = node.parent_id;
            let before_position = node.position;
            self.unindex_child(page_id, before_parent_id, before_position, id);
            self.index_child(page_id, parent_id, position, id);
        }
        if let Some(node) = self.nodes.get_mut(&id) {
            node.parent_id = parent_id;
            node.position = position;
        }
    }

    fn geometry_for(&self, id: NodeId) -> Option<Geometry> {
        self.nodes.get(&id).map(|node| Geometry {
            x: node.x,
            y: node.y,
            width: node.width,
            height: node.height,
            rotation: node.rotation,
        })
    }

    fn group_ancestor_ids(&self, parents: impl IntoIterator<Item = Option<NodeId>>) -> Vec<NodeId> {
        let mut ids = Vec::new();
        for mut current in parents.into_iter().flatten() {
            loop {
                let Some(node) = self.nodes.get(&current) else {
                    break;
                };
                if is_structural_container(&node.kind) && !ids.contains(&current) {
                    ids.push(current);
                }
                let Some(parent_id) = node.parent_id else {
                    break;
                };
                current = parent_id;
            }
        }
        ids
    }

    /// Structural containers derive their rectangle from the world-space union
    /// of their direct children. Boolean results will later use the shared
    /// clipping engine for their exact visible outline; the operand union is a
    /// stable conservative bound in the meantime. The Dual-read transform rule
    /// is deliberately applied here as well as in the Worker: legacy children
    /// use their historical world x/y/rotation while a child with
    /// `relative_transform` inherits its parent's world matrix.
    fn refresh_group_bounds(&mut self, mut group_id: Option<NodeId>) {
        while let Some(id) = group_id {
            let Some(group) = self.nodes.get(&id).map(|node| node.as_ref().clone()) else {
                break;
            };
            if !is_structural_container(&group.kind) {
                break;
            }
            // A Relative-v1 Group has already been normalized by the shared
            // matrix resolver before its complete batch crosses into Core.
            // Recomputing it from world AABBs here would overwrite its local
            // transform and move every relative child a second time. Legacy
            // Groups continue through the historical path during migration.
            if group.relative_transform.is_some() {
                group_id = group.parent_id;
                continue;
            }
            let children = self.child_ids_for(id);
            if children.is_empty() {
                break;
            }
            let bounds = children
                .into_iter()
                .filter_map(|child_id| self.node_world_visual_bounds(child_id))
                .reduce(|left, right| Bounds {
                    left: left.left.min(right.left),
                    top: left.top.min(right.top),
                    right: left.right.max(right.right),
                    bottom: left.bottom.max(right.bottom),
                });
            if let Some(bounds) = bounds {
                if let Some(node) = self.nodes.get_mut(&id) {
                    node.x = bounds.left;
                    node.y = bounds.top;
                    node.width = (bounds.right - bounds.left).max(1.0);
                    node.height = (bounds.bottom - bounds.top).max(1.0);
                    node.rotation = 0.0;
                }
            }
            group_id = group.parent_id;
        }
    }

    fn node_world_transform(&self, id: NodeId) -> Option<AffineTransform> {
        self.node_world_transform_inner(id, &mut BTreeSet::new())
    }

    /// Constraints belong to the closest Frame-like ancestor. An active Auto
    /// Layout Frame suspends them for flow children, but an absolute direct
    /// child—and descendants reached only through its structural Group or
    /// Boolean subtree—continues to use the Frame's Constraints contract.
    fn constraints_apply_for_child(&self, frame_id: NodeId, child_id: NodeId) -> bool {
        if self.auto_layout_for_node(frame_id).mode == LayoutMode::None {
            return true;
        }
        let mut current_id = child_id;
        let mut visited = BTreeSet::new();
        while visited.insert(current_id) {
            let Some(current) = self.nodes.get(&current_id) else {
                return false;
            };
            let Some(parent_id) = current.parent_id else {
                return false;
            };
            if parent_id == frame_id {
                return self.auto_layout_for_node(current_id).absolute;
            }
            let Some(parent) = self.nodes.get(&parent_id) else {
                return false;
            };
            if !is_structural_container(&parent.kind) {
                return false;
            }
            current_id = parent_id;
        }
        false
    }

    /// Resolves a Relative-v1 node and its immediate parent into the local
    /// coordinate space of an enclosing Frame. Constraints intentionally stop
    /// at a non-Group ancestor: Section and nested Frame ownership defines a
    /// new layout context, while Group is transparent in Figma's constraint
    /// model. Every link must be relative-matrix based; a legacy world-space
    /// link cannot be mixed into this local calculation without guessing.
    fn relative_transform_to_frame(
        &self,
        id: NodeId,
        frame_id: NodeId,
    ) -> Option<(AffineTransform, AffineTransform)> {
        let node = self.nodes.get(&id)?;
        let local = node.relative_transform?;
        let parent_to_frame = match node.parent_id {
            Some(parent_id) if parent_id == frame_id => AffineTransform::IDENTITY,
            Some(parent_id) => {
                let parent = self.nodes.get(&parent_id)?;
                if !is_structural_container(&parent.kind) || parent.relative_transform.is_none() {
                    return None;
                }
                self.relative_transform_to_frame(parent_id, frame_id)?.0
            }
            None => return None,
        };
        Some((local.then(parent_to_frame), parent_to_frame))
    }

    fn node_world_transform_inner(
        &self,
        id: NodeId,
        visiting: &mut BTreeSet<NodeId>,
    ) -> Option<AffineTransform> {
        if !visiting.insert(id) {
            return None;
        }
        let node = self.nodes.get(&id)?;
        let local = node
            .relative_transform
            .unwrap_or(node_legacy_transform(node)?);
        let world = if node.relative_transform.is_some() {
            match node.parent_id {
                Some(parent_id) => {
                    local.then(self.node_world_transform_inner(parent_id, visiting)?)
                }
                None => local,
            }
        } else {
            local
        };
        visiting.remove(&id);
        Some(world)
    }

    fn node_world_visual_bounds(&self, id: NodeId) -> Option<Bounds> {
        let node = self.nodes.get(&id)?;
        let transform = self.node_world_transform(id)?;
        let corners = [
            Point { x: 0.0, y: 0.0 },
            Point {
                x: node.width,
                y: 0.0,
            },
            Point {
                x: node.width,
                y: node.height,
            },
            Point {
                x: 0.0,
                y: node.height,
            },
        ]
        .map(|point| transform.transform_point(point));
        Some(Bounds {
            left: corners
                .iter()
                .map(|point| point.x)
                .fold(f64::INFINITY, f64::min),
            top: corners
                .iter()
                .map(|point| point.y)
                .fold(f64::INFINITY, f64::min),
            right: corners
                .iter()
                .map(|point| point.x)
                .fold(f64::NEG_INFINITY, f64::max),
            bottom: corners
                .iter()
                .map(|point| point.y)
                .fold(f64::NEG_INFINITY, f64::max),
        })
    }

    fn dissolve_empty_groups_and_component_sets_from(
        &mut self,
        mut container_id: Option<NodeId>,
    ) -> Vec<Node> {
        let mut dissolved = Vec::new();
        while let Some(id) = container_id {
            let Some(container) = self.nodes.get(&id).map(|node| node.as_ref().clone()) else {
                break;
            };
            if !matches!(container.kind, NodeKind::Group | NodeKind::ComponentSet)
                || self.has_children(id)
            {
                break;
            }
            container_id = container.parent_id;
            self.retire_node(id);
            self.refresh_group_bounds(container_id);
            dissolved.push(container);
        }
        dissolved
    }

    /// A Group or BooleanOperation may be temporarily incomplete while commands
    /// in one transaction are being applied (Create followed by Reparent is
    /// the normal construction path). The atomic boundary, not an individual
    /// command, owns the invariant so alternate clients and operation replay
    /// cannot persist an invalid structural shell.
    fn ensure_non_empty_groups(&mut self) -> Result<(), CommandError> {
        for id in self.structural_validation_pending.iter().copied() {
            let Some(node) = self.nodes.get(&id) else {
                continue;
            };
            match node.kind {
                NodeKind::Group if !self.has_children(id) => {
                    return Err(CommandError::EmptyGroup { id });
                }
                NodeKind::BooleanOperation if self.child_count_for(id) < 2 => {
                    return Err(CommandError::InsufficientBooleanOperands { id });
                }
                _ => {}
            }
        }
        self.structural_validation_pending.clear();
        Ok(())
    }

    fn set_node_asset(&mut self, id: NodeId, asset_id: Option<AssetId>) {
        match asset_id {
            Some(asset_id) => {
                self.node_assets.insert(id, asset_id);
            }
            None => {
                self.node_assets.remove(&id);
            }
        }
    }

    fn set_name(&mut self, id: NodeId, name: &str) {
        if let Some(node) = self.nodes.get_mut(&id) {
            let before_bytes = node.estimated_bytes();
            let after_bytes = before_bytes - node.name.len() + name.len();
            node.name = name.into();
            self.node_bytes = self
                .node_bytes
                .saturating_sub(before_bytes)
                .saturating_add(after_bytes);
        }
    }

    fn set_text(&mut self, id: NodeId, text: &str) {
        if let Some(node) = self.nodes.get_mut(&id) {
            let before_bytes = node.estimated_bytes();
            let after_bytes = before_bytes - node.text.len() + text.len();
            node.text = text.into();
            self.node_bytes = self
                .node_bytes
                .saturating_sub(before_bytes)
                .saturating_add(after_bytes);
        }
    }

    fn replace_text_properties(&mut self, id: NodeId, properties: TextProperties) {
        self.replace_text_properties_option(
            id,
            (properties != TextProperties::default()).then_some(properties),
        );
    }

    fn replace_text_properties_option(&mut self, id: NodeId, properties: Option<TextProperties>) {
        let before = self.node_text_properties.remove(&id);
        self.node_bytes = self.node_bytes.saturating_sub(
            before
                .as_ref()
                .map(TextProperties::estimated_bytes)
                .unwrap_or(0),
        );
        if let Some(properties) = properties {
            self.node_bytes = self.node_bytes.saturating_add(properties.estimated_bytes());
            self.node_text_properties.insert(id, properties);
        }
    }

    fn valid_text_properties(&self, text: &str, properties: &TextProperties) -> bool {
        if properties.runs.len() > MAX_TEXT_STYLE_RUNS
            || properties.paragraph_style_runs.len() > MAX_TEXT_STYLE_RUNS
            || properties.fallback_fonts.len() > MAX_TEXT_FALLBACK_FONTS
            || (properties.max_lines.is_some()
                && (properties.text_truncation != TextTruncation::Ending
                    || properties.max_lines == Some(0)))
            || !properties.paragraph.paragraph_spacing.is_finite()
            || properties.paragraph.paragraph_spacing < 0.0
            || properties
                .paragraph
                .paragraph_indent
                .is_some_and(|value| !value.is_finite() || value < 0.0)
            || properties
                .paragraph
                .list_spacing
                .is_some_and(|value| !value.is_finite() || value <= 0.0)
            || properties
                .paragraph
                .line_height
                .is_some_and(|value| !value.is_finite() || value <= 0.0)
            || properties.paragraph.text_wrap_style == Some(TextWrapStyle::Auto)
            || match properties.paragraph.line_height_unit {
                None => false,
                Some(LineHeightUnit::Percent) => properties.paragraph.line_height.is_none(),
                Some(LineHeightUnit::Auto) => properties.paragraph.line_height.is_some(),
            }
            || properties.base_style.as_ref().is_some_and(|style| {
                style.start != 0 || style.end != 0 || !self.valid_text_style_payload(style)
            })
        {
            return false;
        }
        let mut expected_start = 0usize;
        for run in &properties.runs {
            let start = run.start as usize;
            let end = run.end as usize;
            if start != expected_start
                || start >= end
                || end > text.len()
                || !text.is_char_boundary(start)
                || !text.is_char_boundary(end)
                || !self.valid_text_style_payload(run)
            {
                return false;
            }
            expected_start = end;
        }
        if !properties.runs.is_empty() && expected_start != text.len() {
            return false;
        }
        let paragraph_starts = paragraph_start_offsets(text);
        let mut previous_paragraph_start = None;
        if !properties.paragraph_style_runs.iter().all(|run| {
            let start = run.start as usize;
            let ordered = previous_paragraph_start.is_none_or(|previous| previous < start);
            previous_paragraph_start = Some(start);
            let inherited_list_type = properties.paragraph.list_type;
            let effective_list_type = run
                .list_type
                .map(paragraph_list_type_value)
                .unwrap_or(inherited_list_type);
            let list_override_is_canonical = run
                .list_type
                .is_none_or(|value| paragraph_list_type_value(value) != inherited_list_type);
            let inherited_list_spacing = properties.paragraph.list_spacing.unwrap_or(0.0);
            let list_spacing_override_is_canonical = run.list_spacing.is_none_or(|value| {
                value.is_finite() && value >= 0.0 && value != inherited_list_spacing
            });
            let paragraph_spacing_override_is_canonical =
                run.paragraph_spacing.is_none_or(|value| {
                    value.is_finite()
                        && value >= 0.0
                        && value != properties.paragraph.paragraph_spacing
                });
            let inherited_paragraph_indent = properties.paragraph.paragraph_indent.unwrap_or(0.0);
            let paragraph_indent_override_is_canonical = run.paragraph_indent.is_none_or(|value| {
                value.is_finite() && value >= 0.0 && value != inherited_paragraph_indent
            });
            let line_height_override_present =
                run.line_height.is_some() || run.line_height_unit.is_some();
            let line_height_override_is_valid = match (run.line_height, run.line_height_unit) {
                (None, None) => true,
                (Some(value), None | Some(LineHeightUnit::Percent)) => {
                    value.is_finite() && value > 0.0
                }
                (None, Some(LineHeightUnit::Auto)) => true,
                (Some(_), Some(LineHeightUnit::Auto)) | (None, Some(LineHeightUnit::Percent)) => {
                    false
                }
            };
            let line_height_override_is_canonical = !line_height_override_present
                || run.line_height != properties.paragraph.line_height
                || run.line_height_unit != properties.paragraph.line_height_unit;
            let inherited_text_wrap_style = properties.paragraph.text_wrap_style;
            let text_wrap_style_override_is_canonical = run.text_wrap_style.is_none_or(|value| {
                paragraph_text_wrap_style_value(value) != inherited_text_wrap_style
            });
            let default_indentation = u32::from(effective_list_type.is_some());
            ordered
                && paragraph_starts.binary_search(&start).is_ok()
                && (run.indentation.is_some()
                    || run.list_type.is_some()
                    || run.list_spacing.is_some()
                    || run.paragraph_spacing.is_some()
                    || run.paragraph_indent.is_some()
                    || line_height_override_present
                    || run.text_wrap_style.is_some())
                && list_override_is_canonical
                && list_spacing_override_is_canonical
                && paragraph_spacing_override_is_canonical
                && paragraph_indent_override_is_canonical
                && line_height_override_is_valid
                && line_height_override_is_canonical
                && text_wrap_style_override_is_canonical
                && run
                    .indentation
                    .is_none_or(|value| value <= 100 && value != default_indentation)
        }) {
            return false;
        }
        let mut seen_fonts = BTreeSet::new();
        properties
            .fallback_fonts
            .iter()
            .all(|font| seen_fonts.insert(font.asset_id) && self.valid_font_reference(font))
    }

    fn valid_text_style_payload(&self, style: &TextStyleRun) -> bool {
        style.font_size.is_finite()
            && (0.1..=10_000.0).contains(&style.font_size)
            && style.font_weight > 0
            && style.font_weight <= 1_000
            && style.letter_spacing.is_finite()
            && (-10_000.0..=10_000.0).contains(&style.letter_spacing)
            && style.color.is_none_or(Color::is_valid)
            && style.fill_stack.as_ref().is_none_or(PaintStack::is_valid)
            && style.text_case != Some(TextCase::Original)
            && style.text_decoration_offset.is_none_or(|offset| {
                let value = match offset {
                    TextDecorationOffset::Pixels(value) | TextDecorationOffset::Percent(value) => {
                        value
                    }
                };
                value.is_finite() && (-10_000.0..=10_000.0).contains(&value)
            })
            && style.text_decoration_thickness.is_none_or(|thickness| {
                let value = match thickness {
                    TextDecorationThickness::Pixels(value)
                    | TextDecorationThickness::Percent(value) => value,
                };
                value.is_finite() && (0.0..=10_000.0).contains(&value)
            })
            && style.text_decoration_color.is_none_or(|decoration| {
                decoration.color.is_valid()
                    && decoration.color.alpha == 1.0
                    && decoration.opacity.is_finite()
                    && (0.0..=1.0).contains(&decoration.opacity)
                    && !matches!(decoration.blend_mode, BlendMode::PassThrough)
            })
            && style.text_decoration_skip_ink != Some(false)
            && style.open_type_features.len() <= MAX_OPEN_TYPE_FEATURES
            && style.open_type_features.iter().all(|feature| {
                feature.tag.len() == 4
                    && feature
                        .tag
                        .bytes()
                        .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
            })
            && style
                .open_type_features
                .windows(2)
                .all(|pair| pair[0].tag < pair[1].tag)
            && style.text_style_id.as_ref().is_none_or(|id| {
                !id.is_empty() && id.len() <= MAX_STYLE_ID_BYTES && !id.contains('\0')
            })
            && style.paint_style_id.as_ref().is_none_or(|id| {
                !id.is_empty() && id.len() <= MAX_STYLE_ID_BYTES && !id.contains('\0')
            })
            && self.valid_text_style_variable_bindings(&style.variable_bindings)
            && style.hyperlink.as_ref().is_none_or(|hyperlink| {
                !hyperlink.value.is_empty()
                    && hyperlink.value.len() <= MAX_TEXT_HYPERLINK_BYTES
                    && !hyperlink.value.contains('\0')
            })
            && !(style.color.is_some() && style.fill_stack.is_some())
            && !style.fill_stack.as_ref().is_some_and(|stack| {
                stack.layers.iter().any(|layer| match layer.paint {
                    PaintLayerKind::Image(image) => !self
                        .assets
                        .get(&image.asset_id)
                        .is_some_and(|asset| asset.media_type.starts_with("image/")),
                    _ => false,
                })
            })
            && style
                .font
                .as_ref()
                .is_none_or(|font| self.valid_font_reference(font))
    }

    fn valid_font_reference(&self, font: &FontReference) -> bool {
        self.assets
            .get(&font.asset_id)
            .is_some_and(|asset| asset.media_type.starts_with("font/"))
            && font.variation_axes.len() <= MAX_FONT_VARIATION_AXES
            && font
                .variation_axes
                .iter()
                .all(|(tag, value)| tag.len() == 4 && tag.is_ascii() && value.is_finite())
    }

    fn index_child(
        &mut self,
        page_id: PageId,
        parent_id: Option<NodeId>,
        position: PositionId,
        id: NodeId,
    ) {
        self.children_by_parent
            .entry((page_id, parent_id))
            .or_default()
            .insert((position, id));
        if let Some(parent_id) = parent_id {
            self.mark_structural_validation(parent_id);
        }
    }

    fn unindex_child(
        &mut self,
        page_id: PageId,
        parent_id: Option<NodeId>,
        position: PositionId,
        id: NodeId,
    ) {
        let key = (page_id, parent_id);
        let remove_key = self
            .children_by_parent
            .get_mut(&key)
            .is_some_and(|children| {
                children.remove(&(position, id));
                children.is_empty()
            });
        if remove_key {
            self.children_by_parent.remove(&key);
        }
        if let Some(parent_id) = parent_id {
            self.mark_structural_validation(parent_id);
        }
    }

    fn mark_structural_validation(&mut self, id: NodeId) {
        if self
            .nodes
            .get(&id)
            .is_some_and(|node| matches!(node.kind, NodeKind::Group | NodeKind::BooleanOperation))
        {
            self.structural_validation_pending.insert(id);
        }
    }

    fn child_ids(&self, page_id: PageId, parent_id: Option<NodeId>) -> Vec<NodeId> {
        self.children_by_parent
            .get(&(page_id, parent_id))
            .into_iter()
            .flatten()
            .map(|(_, id)| *id)
            .collect()
    }

    fn child_ids_for(&self, parent_id: NodeId) -> Vec<NodeId> {
        let page_id = self
            .node_pages
            .get(&parent_id)
            .copied()
            .unwrap_or(DEFAULT_PAGE_ID);
        self.child_ids(page_id, Some(parent_id))
    }

    fn child_count_for(&self, parent_id: NodeId) -> usize {
        let page_id = self
            .node_pages
            .get(&parent_id)
            .copied()
            .unwrap_or(DEFAULT_PAGE_ID);
        self.children_by_parent
            .get(&(page_id, Some(parent_id)))
            .map_or(0, ChildBucket::len)
    }

    fn has_children(&self, parent_id: NodeId) -> bool {
        self.child_count_for(parent_id) != 0
    }

    fn has_child_position(
        &self,
        page_id: PageId,
        parent_id: Option<NodeId>,
        position: PositionId,
    ) -> bool {
        self.children_by_parent
            .get(&(page_id, parent_id))
            .is_some_and(|children| children.contains_position(position))
    }

    fn retire_node(&mut self, id: NodeId) {
        let page_id = self.node_pages.remove(&id).unwrap_or(DEFAULT_PAGE_ID);
        if let Some(node) = self.nodes.remove(&id) {
            self.unindex_child(page_id, node.parent_id, node.position, node.id);
            self.node_bytes = self.node_bytes.saturating_sub(node.estimated_bytes());
        }
        self.structural_validation_pending.remove(&id);
        if let Some(properties) = self.node_text_properties.remove(&id) {
            self.node_bytes = self.node_bytes.saturating_sub(properties.estimated_bytes());
            self.retired_node_text_properties.insert(id, properties);
        }
        for stroke in [false, true] {
            if let Some(stack) = self.node_paint_stacks.remove(&(id, stroke)) {
                self.node_bytes = self.node_bytes.saturating_sub(stack.estimated_bytes());
                self.retired_node_paint_stacks.insert((id, stroke), stack);
            }
        }
        if let Some(links) = self.node_paint_style_links.remove(&id) {
            self.node_bytes = self.node_bytes.saturating_sub(links.estimated_bytes());
            self.retired_node_paint_style_links.insert(id, links);
        }
        self.retired_node_pages.insert(id, page_id);
        if let Some(asset_id) = self.node_assets.remove(&id) {
            self.retired_node_assets.insert(id, asset_id);
        }
        self.retired_ids.insert(id);
    }

    fn create_node_in_page(
        &mut self,
        page_id: PageId,
        node: Node,
    ) -> Result<AppliedChange, CommandError> {
        if node.kind == NodeKind::Image {
            return Err(CommandError::InvalidAsset);
        }
        self.create_node_in_page_with_asset(page_id, node, None)
    }

    fn assert_mutable(&self, id: NodeId) -> Result<(), CommandError> {
        if !self.nodes.contains_key(&id) {
            return Err(CommandError::MissingNode { id });
        }
        if self.is_effectively_locked(id) {
            return Err(CommandError::EffectivelyLocked { id });
        }
        Ok(())
    }

    fn assert_parent_mutable(&self, parent_id: Option<NodeId>) -> Result<(), CommandError> {
        if parent_id.is_some_and(|id| self.is_effectively_locked(id)) {
            return Err(CommandError::EffectivelyLocked {
                id: parent_id.expect("checked above"),
            });
        }
        Ok(())
    }

    fn create_image_node_in_page(
        &mut self,
        page_id: PageId,
        node: Node,
        asset_id: AssetId,
    ) -> Result<AppliedChange, CommandError> {
        if !image_fill_supported(&node.kind)
            || !self
                .assets
                .get(&asset_id)
                .is_some_and(|asset| asset.media_type.starts_with("image/"))
        {
            return Err(CommandError::InvalidAsset);
        }
        self.create_node_in_page_with_asset(page_id, node, Some(asset_id))
    }

    fn create_node_in_page_with_asset(
        &mut self,
        page_id: PageId,
        mut node: Node,
        asset_id: Option<AssetId>,
    ) -> Result<AppliedChange, CommandError> {
        if self.nodes.len() >= MAX_DOCUMENT_NODES {
            return Err(CommandError::ResourceLimit);
        }
        if !valid_dash_pattern(&node.stroke_dash_pattern)
            || !valid_stroke_weights(&node.stroke_weights)
        {
            return Err(CommandError::InvalidAppearance);
        }
        if !node.stroke_weights.is_empty()
            && !matches!(node.kind, NodeKind::Frame | NodeKind::Rectangle)
        {
            return Err(CommandError::InvalidAppearance);
        }
        if node.stroke_align != StrokeAlign::Inside
            && (!matches!(
                node.kind,
                NodeKind::Frame
                    | NodeKind::Rectangle
                    | NodeKind::Ellipse
                    | NodeKind::Polygon
                    | NodeKind::Star
            ) || node.arc_data.is_some())
        {
            return Err(CommandError::InvalidAppearance);
        }
        if node.arc_data.is_some() && node.kind != NodeKind::Ellipse {
            return Err(CommandError::InvalidAppearance);
        }
        if !valid_parametric_shape(&node.kind, node.parametric_shape) {
            return Err(CommandError::InvalidAppearance);
        }
        if !valid_vector_path_for_kind(&node.kind, node.vector_path.as_ref()) {
            return Err(CommandError::InvalidGeometry);
        }
        if !valid_boolean_operation(&node.kind, node.boolean_operation) {
            return Err(CommandError::InvalidGeometry);
        }
        if !valid_boolean_operation(&node.kind, node.boolean_operation) {
            return Err(CommandError::InvalidGeometry);
        }
        if !valid_relative_transform(node.relative_transform) {
            return Err(CommandError::InvalidAppearance);
        }
        node.stroke_dash_pattern = canonical_dash_pattern(&node.stroke_dash_pattern);
        self.validate_node_page(page_id, &node)?;
        if self.node_bytes.saturating_add(node.estimated_bytes()) > MAX_DOCUMENT_BYTES {
            return Err(CommandError::ResourceLimit);
        }
        if self.nodes.contains_key(&node.id) {
            return Err(CommandError::DuplicateNode { id: node.id });
        }
        if self.retired_ids.contains(&node.id) {
            return Err(CommandError::RetiredNodeId { id: node.id });
        }
        self.nodes.insert(node.id, node.clone().into());
        self.node_pages.insert(node.id, page_id);
        self.index_child(page_id, node.parent_id, node.position, node.id);
        self.mark_structural_validation(node.id);
        if let Some(asset_id) = asset_id {
            self.node_assets.insert(node.id, asset_id);
        }
        self.retired_node_pages.remove(&node.id);
        self.retired_node_assets.remove(&node.id);
        self.retired_node_text_properties.remove(&node.id);
        self.retired_node_paint_stacks.remove(&(node.id, false));
        self.retired_node_paint_stacks.remove(&(node.id, true));
        self.retired_node_paint_style_links.remove(&node.id);
        self.node_bytes += node.estimated_bytes();
        Ok(AppliedChange::NodeCreated { node })
    }

    fn restore_node(&mut self, node: &Node) {
        self.nodes.insert(node.id, node.clone().into());
        let page_id = self
            .retired_node_pages
            .remove(&node.id)
            .unwrap_or(DEFAULT_PAGE_ID);
        self.node_pages.insert(node.id, page_id);
        self.index_child(page_id, node.parent_id, node.position, node.id);
        self.mark_structural_validation(node.id);
        if let Some(asset_id) = self.retired_node_assets.remove(&node.id) {
            self.node_assets.insert(node.id, asset_id);
        }
        if let Some(properties) = self.retired_node_text_properties.remove(&node.id) {
            self.node_bytes = self.node_bytes.saturating_add(properties.estimated_bytes());
            self.node_text_properties.insert(node.id, properties);
        }
        for stroke in [false, true] {
            if let Some(stack) = self.retired_node_paint_stacks.remove(&(node.id, stroke)) {
                self.node_bytes = self.node_bytes.saturating_add(stack.estimated_bytes());
                self.node_paint_stacks.insert((node.id, stroke), stack);
            }
        }
        if let Some(links) = self.retired_node_paint_style_links.remove(&node.id) {
            self.node_bytes = self.node_bytes.saturating_add(links.estimated_bytes());
            self.node_paint_style_links.insert(node.id, links);
        }
        self.node_bytes += node.estimated_bytes();
        self.retired_ids.remove(&node.id);
    }

    /// Reconstitutes one explicit tombstone from a resolved remote history
    /// operation. The tombstone check prevents this from becoming a backdoor
    /// for reusing arbitrary deleted IDs as new nodes.
    fn restore_tombstoned_node(
        &mut self,
        page_id: PageId,
        node: Node,
        asset_id: Option<AssetId>,
        text_properties: Option<TextProperties>,
    ) -> Result<AppliedChange, CommandError> {
        if self.nodes.contains_key(&node.id) {
            return Err(CommandError::DuplicateNode { id: node.id });
        }
        if !self.retired_ids.contains(&node.id) {
            return Err(CommandError::MissingRetiredNode { id: node.id });
        }
        if self.nodes.len() >= MAX_DOCUMENT_NODES {
            return Err(CommandError::ResourceLimit);
        }
        self.validate_node_page(page_id, &node)?;
        if node.kind == NodeKind::Image && asset_id.is_none() {
            return Err(CommandError::InvalidAsset);
        }
        if let Some(asset_id) = asset_id {
            if !image_fill_supported(&node.kind)
                || !self
                    .assets
                    .get(&asset_id)
                    .is_some_and(|asset| asset.media_type.starts_with("image/"))
            {
                return Err(CommandError::InvalidAsset);
            }
        }
        if text_properties.as_ref().is_some_and(|properties| {
            !supports_text_properties(&node.kind)
                || !self.valid_text_properties(&node.text, properties)
        }) {
            return Err(CommandError::InvalidTextProperties);
        }
        let text_property_bytes = text_properties
            .as_ref()
            .map(TextProperties::estimated_bytes)
            .unwrap_or(0);
        if self
            .node_bytes
            .saturating_add(node.estimated_bytes())
            .saturating_add(text_property_bytes)
            > MAX_DOCUMENT_BYTES
        {
            return Err(CommandError::ResourceLimit);
        }
        self.nodes.insert(node.id, node.clone().into());
        self.node_pages.insert(node.id, page_id);
        self.index_child(page_id, node.parent_id, node.position, node.id);
        self.mark_structural_validation(node.id);
        if let Some(asset_id) = asset_id {
            self.node_assets.insert(node.id, asset_id);
        }
        if let Some(properties) = text_properties {
            self.node_text_properties.insert(node.id, properties);
        }
        self.retired_node_pages.remove(&node.id);
        self.retired_node_assets.remove(&node.id);
        self.retired_node_text_properties.remove(&node.id);
        self.retired_node_paint_stacks.remove(&(node.id, false));
        self.retired_node_paint_stacks.remove(&(node.id, true));
        self.retired_node_paint_style_links.remove(&node.id);
        self.retired_ids.remove(&node.id);
        self.node_bytes = self
            .node_bytes
            .saturating_add(node.estimated_bytes())
            .saturating_add(text_property_bytes);
        Ok(AppliedChange::NodeRestored { node })
    }

    fn validate_node_page(&self, page_id: PageId, node: &Node) -> Result<(), CommandError> {
        if !self.pages.contains_key(&page_id) {
            return Err(CommandError::MissingPage { id: page_id });
        }
        if node.name.trim().is_empty() {
            return Err(CommandError::InvalidName);
        }
        if !valid_geometry(
            &node.kind,
            Geometry {
                x: node.x,
                y: node.y,
                width: node.width,
                height: node.height,
                rotation: node.rotation,
            },
        ) {
            return Err(CommandError::InvalidGeometry);
        }
        if !valid_appearance(&Appearance {
            fill: node.fill.clone(),
            stroke: node.stroke.clone(),
            fills: node.fills.clone(),
            strokes: node.strokes.clone(),
            stroke_width: node.stroke_width,
            stroke_cap_start: node.stroke_cap_start,
            stroke_cap_end: node.stroke_cap_end,
            stroke_join: node.stroke_join,
            stroke_miter_limit: node.stroke_miter_limit,
            stroke_dash_pattern: node.stroke_dash_pattern.clone(),
            stroke_weights: node.stroke_weights.clone(),
            stroke_align: node.stroke_align,
            arc_data: node.arc_data,
            parametric_shape: node.parametric_shape,
            relative_transform: node.relative_transform,
            opacity: node.opacity,
            blend_mode: node.blend_mode,
            drop_shadow: node.drop_shadow,
            effect_stack: node.effect_stack.clone(),
            corner_radius: node.corner_radius,
            corner_radii: node.corner_radii.clone(),
            corner_smoothing: node.corner_smoothing,
            constraints: node.constraints,
            visible: node.visible,
            locked: node.locked,
            contents_hidden: node.contents_hidden,
            clips_content: Some(node.clips_content),
        }) {
            return Err(CommandError::InvalidAppearance);
        }
        if node.contents_hidden && node.kind != NodeKind::Section {
            return Err(CommandError::InvalidAppearance);
        }
        if node.clips_content && !is_frame_like(&node.kind) {
            return Err(CommandError::InvalidAppearance);
        }
        if (node.drop_shadow.is_some() || !node.effect_stack.is_empty())
            && node.kind == NodeKind::BooleanOperation
        {
            return Err(CommandError::InvalidAppearance);
        }
        if node.kind == NodeKind::Slice && !valid_slice_node(node) {
            return Err(CommandError::InvalidAppearance);
        }
        if !valid_vector_path_for_kind(&node.kind, node.vector_path.as_ref()) {
            return Err(CommandError::InvalidGeometry);
        }
        if node.text.len() > MAX_TEXT_BYTES
            || (!matches!(
                node.kind,
                NodeKind::Text
                    | NodeKind::CodeBlock
                    | NodeKind::ShapeWithText
                    | NodeKind::Sticky
                    | NodeKind::TableCell
                    | NodeKind::TextPath
            ) && !node.text.is_empty())
        {
            return Err(CommandError::InvalidText);
        }
        if node.kind == NodeKind::SlideGrid
            && (node.parent_id.is_some()
                || self.nodes.values().any(|candidate| {
                    candidate.kind == NodeKind::SlideGrid
                        && self
                            .node_pages
                            .get(&candidate.id)
                            .copied()
                            .unwrap_or(DEFAULT_PAGE_ID)
                            == page_id
                }))
        {
            return Err(CommandError::InvalidParent { id: node.id });
        }
        if matches!(node.kind, NodeKind::Slide | NodeKind::SlideRow) && node.parent_id.is_none() {
            return Err(CommandError::InvalidParent { id: node.id });
        }
        if let Some(parent_id) = node.parent_id {
            let parent = self
                .nodes
                .get(&parent_id)
                .ok_or(CommandError::MissingParent { id: parent_id })?;
            if !can_parent_contain_child(&parent.kind, &node.kind) {
                return Err(CommandError::InvalidParent { id: parent_id });
            }
            if self
                .node_pages
                .get(&parent_id)
                .copied()
                .unwrap_or(DEFAULT_PAGE_ID)
                != page_id
            {
                return Err(CommandError::MissingParent { id: parent_id });
            }
        }
        if self.has_child_position(page_id, node.parent_id, node.position) {
            return Err(CommandError::DuplicatePosition {
                parent_id: node.parent_id,
                position: node.position,
            });
        }
        Ok(())
    }
}

fn valid_font_metadata_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn valid_resource_identity(id: &str, key: &str, name: &str, remote: bool) -> bool {
    !id.is_empty()
        && id.len() <= MAX_STYLE_ID_BYTES
        && !id.contains('\0')
        && key.len() <= MAX_STYLE_KEY_BYTES
        && !key.contains('\0')
        && (!remote || !key.is_empty())
        && !name.trim().is_empty()
        && name.len() <= MAX_STYLE_NAME_BYTES
        && !name.contains('\0')
}

fn variable_value_matches(value: &VariableValue, resolved_type: VariableResolvedType) -> bool {
    match (value, resolved_type) {
        (VariableValue::Boolean(_), VariableResolvedType::Boolean) => true,
        (VariableValue::Color(color), VariableResolvedType::Color) => color.is_valid(),
        (VariableValue::Float(value), VariableResolvedType::Float) => value.is_finite(),
        (VariableValue::String(value), VariableResolvedType::String) => {
            value.len() <= MAX_VARIABLE_STRING_BYTES && !value.contains('\0')
        }
        (VariableValue::Alias(id), _) => {
            !id.is_empty() && id.len() <= MAX_STYLE_ID_BYTES && !id.contains('\0')
        }
        _ => false,
    }
}

impl Transaction {
    fn estimated_bytes(&self) -> usize {
        std::mem::size_of::<TransactionId>()
            + std::mem::size_of::<u64>()
            + self
                .commands
                .iter()
                .map(Command::estimated_bytes)
                .sum::<usize>()
    }
}

impl OperationEnvelope {
    pub const SCHEMA_VERSION: u32 = 1;

    pub fn new(
        document_id: DocumentId,
        operation_id: OperationId,
        actor_id: ActorId,
        causal_parents: Vec<OperationId>,
        transaction: Transaction,
    ) -> Self {
        let payload_hash = Self::payload_hash_for(&transaction);
        Self {
            schema_version: Self::SCHEMA_VERSION,
            document_id,
            operation_id,
            transaction_id: transaction.id,
            actor_id,
            base_revision: transaction.base_revision,
            causal_parents,
            transaction,
            payload_hash,
        }
        .canonicalized()
    }

    pub fn payload_hash_for(transaction: &Transaction) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update(b"makefigma/editor-core/operation-payload-v1");
        hash_len(&mut hasher, transaction.commands.len());
        for command in &transaction.commands {
            hash_command(&mut hasher, command);
        }
        hasher.finalize().into()
    }

    fn canonicalized(mut self) -> Self {
        self.causal_parents.sort_unstable();
        self.causal_parents.dedup();
        self
    }

    fn validate_for(&self, document_id: DocumentId) -> Result<(), CommandError> {
        if self.schema_version != Self::SCHEMA_VERSION {
            return Err(CommandError::UnsupportedOperationSchema {
                found: self.schema_version,
            });
        }
        if self.document_id != document_id {
            return Err(CommandError::OperationDocumentMismatch {
                expected: document_id,
                actual: self.document_id,
            });
        }
        if self.transaction_id != self.transaction.id
            || self.base_revision != self.transaction.base_revision
        {
            return Err(CommandError::OperationTransactionMismatch);
        }
        if self.payload_hash != Self::payload_hash_for(&self.transaction) {
            return Err(CommandError::OperationPayloadHashMismatch);
        }
        Ok(())
    }

    fn fingerprint(&self) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update(b"makefigma/editor-core/operation-envelope-v1");
        hasher.update(self.schema_version.to_be_bytes());
        hasher.update(self.document_id.0.to_be_bytes());
        hasher.update(self.operation_id.0.to_be_bytes());
        hasher.update(self.transaction_id.0.to_be_bytes());
        hasher.update(self.actor_id.0.to_be_bytes());
        hasher.update(self.base_revision.to_be_bytes());
        hash_len(&mut hasher, self.causal_parents.len());
        for parent in &self.causal_parents {
            hasher.update(parent.0.to_be_bytes());
        }
        hasher.update(self.payload_hash);
        hasher.finalize().into()
    }

    fn estimated_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self.causal_parents.len() * std::mem::size_of::<OperationId>()
            + self.transaction.estimated_bytes()
    }
}

impl Command {
    fn estimated_bytes(&self) -> usize {
        match self {
            Command::CreatePage(page) => std::mem::size_of::<Page>() + page.name.len(),
            Command::CreateInPage { node, .. } => {
                std::mem::size_of::<PageId>() + node.estimated_bytes()
            }
            Command::CreateImageInPage { node, .. } => {
                std::mem::size_of::<PageId>()
                    + std::mem::size_of::<AssetId>()
                    + node.estimated_bytes()
            }
            Command::RestoreNode {
                node,
                text_properties,
                ..
            } => {
                std::mem::size_of::<PageId>()
                    + std::mem::size_of::<Option<AssetId>>()
                    + node.estimated_bytes()
                    + text_properties
                        .as_ref()
                        .map(TextProperties::estimated_bytes)
                        .unwrap_or(0)
            }
            Command::SetPaintStyleLinks { links, .. } => {
                std::mem::size_of::<NodeId>() + links.estimated_bytes()
            }
            Command::Create(node) => node.estimated_bytes(),
            Command::UpdateGeometry { .. } | Command::UpdateGeometryWithoutConstraints { .. } => {
                std::mem::size_of::<Geometry>() + std::mem::size_of::<NodeId>()
            }
            Command::Rename { name, .. } => std::mem::size_of::<NodeId>() + name.len(),
            Command::SetAppearance { appearance, .. } => {
                std::mem::size_of::<NodeId>() + appearance.estimated_bytes()
            }
            Command::SetPaintStacks {
                fill_stack,
                stroke_stack,
                ..
            } => {
                std::mem::size_of::<NodeId>()
                    + fill_stack
                        .as_ref()
                        .map(PaintStack::estimated_bytes)
                        .unwrap_or(0)
                    + stroke_stack
                        .as_ref()
                        .map(PaintStack::estimated_bytes)
                        .unwrap_or(0)
            }
            Command::SetVectorPath { path, .. } | Command::ConvertToTextPath { path, .. } => {
                std::mem::size_of::<NodeId>() + path.estimated_bytes()
            }
            Command::SetBooleanOperation { .. } => {
                std::mem::size_of::<NodeId>() + std::mem::size_of::<BooleanOperation>()
            }
            Command::SetMask { .. } => std::mem::size_of::<NodeId>() + std::mem::size_of::<bool>(),
            Command::SetNodeExtensions { extensions, .. } => {
                std::mem::size_of::<NodeId>()
                    + extensions
                        .iter()
                        .map(|(key, value)| key.len() + value.len())
                        .sum::<usize>()
            }
            Command::MoveVectorPoint { .. } => {
                std::mem::size_of::<NodeId>()
                    + std::mem::size_of::<PointId>()
                    + std::mem::size_of::<Point>()
            }
            Command::SetVectorSubpathClosed { .. } => {
                std::mem::size_of::<NodeId>()
                    + std::mem::size_of::<u32>()
                    + std::mem::size_of::<bool>()
            }
            Command::InsertVectorPoint { point, .. } => {
                std::mem::size_of::<NodeId>()
                    + std::mem::size_of::<u32>()
                    + std::mem::size_of::<Option<PointId>>()
                    + std::mem::size_of_val(point)
            }
            Command::SplitVectorSegment { .. } => {
                std::mem::size_of::<NodeId>()
                    + std::mem::size_of::<u32>()
                    + std::mem::size_of::<PointId>() * 2
                    + std::mem::size_of::<f64>()
            }
            Command::ConnectVectorEndpoints { .. } => {
                std::mem::size_of::<NodeId>()
                    + std::mem::size_of::<u32>() * 2
                    + std::mem::size_of::<PointId>() * 2
            }
            Command::DeleteVectorPoint { .. } => {
                std::mem::size_of::<NodeId>() + std::mem::size_of::<PointId>()
            }
            Command::SetVectorPointHandles { .. } => {
                std::mem::size_of::<NodeId>()
                    + std::mem::size_of::<PointId>()
                    + std::mem::size_of::<Option<Point>>() * 2
                    + std::mem::size_of::<VectorPointType>()
            }
            Command::SetNodeAsset { .. } => {
                std::mem::size_of::<NodeId>() + std::mem::size_of::<Option<AssetId>>()
            }
            Command::SetText { text, .. } => std::mem::size_of::<NodeId>() + text.len(),
            Command::SetTextProperties { properties, .. } => {
                std::mem::size_of::<NodeId>() + properties.estimated_bytes()
            }
            Command::SetAutoLayout { .. } => {
                std::mem::size_of::<NodeId>() + std::mem::size_of::<AutoLayout>()
            }
            Command::SetNodePosition { .. } => {
                std::mem::size_of::<NodeId>() + std::mem::size_of::<PositionId>()
            }
            Command::SetNodeParent { .. } => {
                std::mem::size_of::<NodeId>()
                    + std::mem::size_of::<Option<NodeId>>()
                    + std::mem::size_of::<PositionId>()
            }
            Command::SetDocumentColorProfile { .. } => std::mem::size_of::<DocumentColorProfile>(),
            Command::RegisterAsset { asset } => {
                std::mem::size_of::<AssetReference>()
                    + asset.media_type.len()
                    + asset
                        .font_faces
                        .iter()
                        .map(|face| {
                            std::mem::size_of::<FontFaceMetadata>()
                                + face.family.len()
                                + face.style.len()
                                + face
                                    .aliases
                                    .iter()
                                    .map(|alias| {
                                        std::mem::size_of::<FontNameAlias>()
                                            + alias.family.len()
                                            + alias.style.len()
                                    })
                                    .sum::<usize>()
                        })
                        .sum::<usize>()
            }
            Command::RegisterTextStyle { style } => style.estimated_bytes(),
            Command::RegisterPaintStyle { style } => style.estimated_bytes(),
            Command::SetTextStyle { style } => style.estimated_bytes(),
            Command::DeleteTextStyle { id } => id.len(),
            Command::SetPaintStyle { style } => style.estimated_bytes(),
            Command::DeletePaintStyle { id } => id.len(),
            Command::RegisterVariableCollection { collection } => collection.estimated_bytes(),
            Command::RegisterVariable { variable } => variable.estimated_bytes(),
            Command::SetVariable { variable } => variable.estimated_bytes(),
            Command::DeleteVariable { id } => id.len(),
            Command::SetVariableCollection {
                collection,
                variables,
            } => {
                collection.estimated_bytes()
                    + variables
                        .iter()
                        .map(VariableResource::estimated_bytes)
                        .sum::<usize>()
            }
            Command::DeleteVariableCollection { id } => id.len(),
            Command::Delete { .. } => std::mem::size_of::<NodeId>(),
        }
    }
}

impl Node {
    fn estimated_bytes(&self) -> usize {
        std::mem::size_of::<Node>()
            + self.name.len()
            + self.text.len()
            + self.fill.estimated_bytes()
            + self.stroke.estimated_bytes()
            + paint_stack_bytes(&self.fills)
            + paint_stack_bytes(&self.strokes)
            + self.stroke_dash_pattern.len() * std::mem::size_of::<f64>()
            + self.stroke_weights.len() * std::mem::size_of::<f64>()
            + self
                .extensions
                .iter()
                .map(|(key, value)| key.len() + value.len())
                .sum::<usize>()
            + self
                .vector_path
                .as_ref()
                .map(VectorPath::estimated_bytes)
                .unwrap_or(0)
    }
}

impl VectorPath {
    fn estimated_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self
                .subpaths
                .iter()
                .map(|subpath| {
                    std::mem::size_of::<VectorSubpath>()
                        + subpath.points.len() * std::mem::size_of::<VectorPoint>()
                })
                .sum::<usize>()
    }
}

impl Appearance {
    fn estimated_bytes(&self) -> usize {
        std::mem::size_of::<Appearance>()
            + self.fill.estimated_bytes()
            + self.stroke.estimated_bytes()
            + paint_stack_bytes(&self.fills)
            + paint_stack_bytes(&self.strokes)
            + self.stroke_dash_pattern.len() * std::mem::size_of::<f64>()
            + self.stroke_weights.len() * std::mem::size_of::<f64>()
    }
}

impl TextProperties {
    fn estimated_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self
                .runs
                .iter()
                .map(|run| {
                    std::mem::size_of::<TextStyleRun>()
                        + run
                            .font
                            .as_ref()
                            .map(FontReference::estimated_bytes)
                            .unwrap_or(0)
                        + run
                            .fill_stack
                            .as_ref()
                            .map(PaintStack::estimated_bytes)
                            .unwrap_or(0)
                        + run.hyperlink.as_ref().map_or(0, |value| value.value.len())
                        + run
                            .open_type_features
                            .iter()
                            .map(|feature| {
                                std::mem::size_of::<OpenTypeFeature>() + feature.tag.len()
                            })
                            .sum::<usize>()
                        + run.text_style_id.as_ref().map_or(0, String::len)
                        + run.paint_style_id.as_ref().map_or(0, String::len)
                        + run
                            .variable_bindings
                            .iter()
                            .map(|(field, id)| field.len() + id.len())
                            .sum::<usize>()
                })
                .sum::<usize>()
            + self.paragraph_style_runs.len() * std::mem::size_of::<ParagraphStyleRun>()
            + self
                .base_style
                .as_ref()
                .map(|style| {
                    std::mem::size_of::<TextStyleRun>()
                        + style
                            .font
                            .as_ref()
                            .map(FontReference::estimated_bytes)
                            .unwrap_or(0)
                        + style
                            .fill_stack
                            .as_ref()
                            .map(PaintStack::estimated_bytes)
                            .unwrap_or(0)
                        + style
                            .hyperlink
                            .as_ref()
                            .map_or(0, |value| value.value.len())
                        + style
                            .open_type_features
                            .iter()
                            .map(|feature| {
                                std::mem::size_of::<OpenTypeFeature>() + feature.tag.len()
                            })
                            .sum::<usize>()
                        + style.text_style_id.as_ref().map_or(0, String::len)
                        + style.paint_style_id.as_ref().map_or(0, String::len)
                        + style
                            .variable_bindings
                            .iter()
                            .map(|(field, id)| field.len() + id.len())
                            .sum::<usize>()
                })
                .unwrap_or(0)
            + self
                .fallback_fonts
                .iter()
                .map(FontReference::estimated_bytes)
                .sum::<usize>()
    }
}

impl TextStyleResource {
    pub fn estimated_bytes(&self) -> usize {
        let mut properties = TextProperties::default();
        properties.paragraph = self.paragraph.clone();
        properties.base_style = Some(self.style.clone());
        std::mem::size_of::<Self>()
            + self.id.len()
            + self.key.len()
            + self.name.len()
            + self.description.len()
            + self.description_markdown.len()
            + self
                .documentation_links
                .iter()
                .map(String::len)
                .sum::<usize>()
            + self
                .variable_bindings
                .iter()
                .map(|(field, id)| field.len() + id.len())
                .sum::<usize>()
            + properties.estimated_bytes()
    }
}

impl PaintStyleResource {
    pub fn estimated_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self.id.len()
            + self.key.len()
            + self.name.len()
            + self.description.len()
            + self.description_markdown.len()
            + self
                .documentation_links
                .iter()
                .map(String::len)
                .sum::<usize>()
            + self
                .variable_bindings
                .iter()
                .map(|binding| {
                    std::mem::size_of::<PaintStyleVariableBinding>() + binding.variable_id.len()
                })
                .sum::<usize>()
            + self.paints.estimated_bytes()
    }
}

fn valid_style_documentation_links(links: &[String]) -> bool {
    links.len() <= MAX_STYLE_DOCUMENTATION_LINKS
        && links.iter().all(|uri| {
            !uri.is_empty()
                && uri.len() <= MAX_STYLE_DOCUMENTATION_URI_BYTES
                && !uri.contains('\0')
                && !uri.bytes().any(|byte| byte.is_ascii_whitespace())
                && (uri.starts_with("https://") || uri.starts_with("http://"))
        })
}

impl Document {
    fn valid_text_style_variable_bindings(&self, bindings: &BTreeMap<String, String>) -> bool {
        bindings.len() <= 8
            && bindings.iter().all(|(field, id)| {
                let expected = match field.as_str() {
                    "fontFamily" | "fontStyle" => VariableResolvedType::String,
                    "fontSize" | "fontWeight" | "letterSpacing" | "lineHeight"
                    | "paragraphSpacing" | "paragraphIndent" => VariableResolvedType::Float,
                    _ => return false,
                };
                self.variables
                    .get(id)
                    .is_some_and(|variable| variable.resolved_type == expected)
            })
    }

    fn valid_paint_style_variable_bindings(&self, style: &PaintStyleResource) -> bool {
        style.variable_bindings.len() <= 16 * color::MAX_GRADIENT_STOPS
            && style
                .variable_bindings
                .windows(2)
                .all(|pair| pair[0].target_key() < pair[1].target_key())
            && style.variable_bindings.iter().all(|binding| {
                let Some(layer) = style.paints.layers.get(binding.paint_index as usize) else {
                    return false;
                };
                let target_exists = match (&layer.paint, binding.stop_index) {
                    (PaintLayerKind::Solid(_), None) => true,
                    (PaintLayerKind::LinearGradient(gradient), Some(index)) => {
                        gradient.stops.get(index as usize).is_some()
                    }
                    (PaintLayerKind::Gradient(gradient), Some(index)) => {
                        gradient.stops.get(index as usize).is_some()
                    }
                    _ => false,
                };
                target_exists
                    && self
                        .variables
                        .get(&binding.variable_id)
                        .is_some_and(|variable| {
                            variable.resolved_type == VariableResolvedType::Color
                        })
            })
    }
}

impl VariableCollectionResource {
    pub fn estimated_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self.id.len()
            + self.key.len()
            + self.name.len()
            + self.default_mode_id.len()
            + self
                .modes
                .iter()
                .map(|mode| mode.id.len() + mode.name.len())
                .sum::<usize>()
    }
}

impl VariableValue {
    fn estimated_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + match self {
                Self::String(value) | Self::Alias(value) => value.len(),
                _ => 0,
            }
    }
}

impl VariableResource {
    pub fn estimated_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self.id.len()
            + self.key.len()
            + self.name.len()
            + self.description.len()
            + self.collection_id.len()
            + self
                .values_by_mode
                .iter()
                .map(|(mode, value)| mode.len() + value.estimated_bytes())
                .sum::<usize>()
            + self.scopes.iter().map(String::len).sum::<usize>()
            + self
                .code_syntax
                .iter()
                .map(|(platform, value)| platform.len() + value.len())
                .sum::<usize>()
    }
}

impl PaintStyleLinks {
    pub fn is_empty(&self) -> bool {
        self.fill.is_none() && self.stroke.is_none() && self.background.is_none()
    }

    fn estimated_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self.fill.as_ref().map_or(0, String::len)
            + self.stroke.as_ref().map_or(0, String::len)
            + self.background.as_ref().map_or(0, String::len)
    }
}

impl FontReference {
    fn estimated_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self
                .variation_axes
                .iter()
                .map(|(tag, _)| tag.len() + std::mem::size_of::<f32>())
                .sum::<usize>()
    }
}

impl AppliedChange {
    fn estimated_bytes(&self) -> usize {
        match self {
            AppliedChange::Composite { changes } => {
                changes.iter().map(AppliedChange::estimated_bytes).sum()
            }
            AppliedChange::PageCreated { page } => std::mem::size_of::<Page>() + page.name.len(),
            AppliedChange::NodeCreated { node }
            | AppliedChange::NodeDeleted { node }
            | AppliedChange::NodeRestored { node } => node.estimated_bytes(),
            AppliedChange::GeometryChanged { .. } => {
                std::mem::size_of::<Geometry>() * 2 + std::mem::size_of::<NodeId>()
            }
            AppliedChange::NameChanged { before, after, .. } => {
                std::mem::size_of::<NodeId>() + before.len() + after.len()
            }
            AppliedChange::AppearanceChanged { before, after, .. } => {
                std::mem::size_of::<NodeId>() + before.estimated_bytes() + after.estimated_bytes()
            }
            AppliedChange::PaintStacksChanged {
                before_fill,
                before_stroke,
                after_fill,
                after_stroke,
                ..
            } => {
                std::mem::size_of::<NodeId>()
                    + [before_fill, before_stroke, after_fill, after_stroke]
                        .into_iter()
                        .flatten()
                        .map(PaintStack::estimated_bytes)
                        .sum::<usize>()
            }
            AppliedChange::PaintStyleLinksChanged { before, after, .. } => {
                std::mem::size_of::<NodeId>()
                    + before.as_ref().map_or(0, PaintStyleLinks::estimated_bytes)
                    + after.as_ref().map_or(0, PaintStyleLinks::estimated_bytes)
            }
            AppliedChange::AutoLayoutChanged { .. } => {
                std::mem::size_of::<NodeId>() + std::mem::size_of::<Option<AutoLayout>>() * 2
            }
            AppliedChange::VectorPathChanged { before, after, .. } => {
                std::mem::size_of::<NodeId>() + before.estimated_bytes() + after.estimated_bytes()
            }
            AppliedChange::NodeRecordChanged { before, after, .. } => {
                std::mem::size_of::<NodeId>() + before.estimated_bytes() + after.estimated_bytes()
            }
            AppliedChange::BooleanOperationChanged { .. } => {
                std::mem::size_of::<NodeId>() + std::mem::size_of::<BooleanOperation>() * 2
            }
            AppliedChange::MaskChanged { .. } => {
                std::mem::size_of::<NodeId>() + std::mem::size_of::<bool>() * 2
            }
            AppliedChange::ExtensionsChanged { before, after, .. } => {
                std::mem::size_of::<NodeId>()
                    + before
                        .iter()
                        .map(|(key, value)| key.len() + value.len())
                        .sum::<usize>()
                    + after
                        .iter()
                        .map(|(key, value)| key.len() + value.len())
                        .sum::<usize>()
            }
            AppliedChange::NodeAssetChanged { .. } => {
                std::mem::size_of::<NodeId>() + std::mem::size_of::<Option<AssetId>>() * 2
            }
            AppliedChange::TextChanged {
                before,
                after,
                before_properties,
                after_properties,
                ..
            } => {
                std::mem::size_of::<NodeId>()
                    + before.len()
                    + after.len()
                    + before_properties
                        .as_ref()
                        .map(TextProperties::estimated_bytes)
                        .unwrap_or(0)
                    + after_properties
                        .as_ref()
                        .map(TextProperties::estimated_bytes)
                        .unwrap_or(0)
            }
            AppliedChange::TextPropertiesChanged { before, after, .. } => {
                std::mem::size_of::<NodeId>()
                    + before
                        .as_ref()
                        .map(TextProperties::estimated_bytes)
                        .unwrap_or(0)
                    + after
                        .as_ref()
                        .map(TextProperties::estimated_bytes)
                        .unwrap_or(0)
            }
            AppliedChange::NodePositionChanged { .. } => {
                std::mem::size_of::<NodeId>() + std::mem::size_of::<PositionId>() * 2
            }
            AppliedChange::NodeParentChanged { .. } => {
                std::mem::size_of::<NodeId>()
                    + std::mem::size_of::<Option<NodeId>>() * 2
                    + std::mem::size_of::<PositionId>() * 2
            }
            AppliedChange::DocumentColorProfileChanged { .. } => {
                std::mem::size_of::<DocumentColorProfile>() * 2
            }
            AppliedChange::AssetRegistered { asset } => {
                std::mem::size_of::<AssetReference>()
                    + asset.media_type.len()
                    + asset
                        .font_faces
                        .iter()
                        .map(|face| {
                            std::mem::size_of::<FontFaceMetadata>()
                                + face.family.len()
                                + face.style.len()
                                + face
                                    .aliases
                                    .iter()
                                    .map(|alias| {
                                        std::mem::size_of::<FontNameAlias>()
                                            + alias.family.len()
                                            + alias.style.len()
                                    })
                                    .sum::<usize>()
                        })
                        .sum::<usize>()
            }
            AppliedChange::TextStyleRegistered { style } => style.estimated_bytes(),
            AppliedChange::PaintStyleRegistered { style } => style.estimated_bytes(),
            AppliedChange::TextStyleChanged { before, after } => {
                before.estimated_bytes() + after.estimated_bytes()
            }
            AppliedChange::TextStyleDeleted { style } => style.estimated_bytes(),
            AppliedChange::PaintStyleChanged { before, after } => {
                before.estimated_bytes() + after.estimated_bytes()
            }
            AppliedChange::PaintStyleDeleted { style } => style.estimated_bytes(),
            AppliedChange::VariableCollectionRegistered { collection } => {
                collection.estimated_bytes()
            }
            AppliedChange::VariableRegistered { variable } => variable.estimated_bytes(),
            AppliedChange::VariableChanged { before, after } => {
                before.estimated_bytes() + after.estimated_bytes()
            }
            AppliedChange::VariableDeleted { variable } => variable.estimated_bytes(),
            AppliedChange::VariableCollectionChanged {
                before,
                after,
                before_variables,
                after_variables,
            } => {
                before.estimated_bytes()
                    + after.estimated_bytes()
                    + before_variables
                        .iter()
                        .map(VariableResource::estimated_bytes)
                        .sum::<usize>()
                    + after_variables
                        .iter()
                        .map(VariableResource::estimated_bytes)
                        .sum::<usize>()
            }
            AppliedChange::VariableCollectionDeleted {
                collection,
                variables,
            } => {
                collection.estimated_bytes()
                    + variables
                        .iter()
                        .map(VariableResource::estimated_bytes)
                        .sum::<usize>()
            }
        }
    }
}

impl HistoryItem {
    /// Conservative heap-size estimate used by the history admission budget and
    /// performance evidence. This excludes allocator bookkeeping and shared
    /// persistent-tree nodes, so it must not be reported as process RSS.
    pub fn estimated_bytes(&self) -> usize {
        std::mem::size_of::<HistoryItem>()
            + self
                .changes
                .iter()
                .map(AppliedChange::estimated_bytes)
                .sum::<usize>()
    }
}

impl AcceptedTransactionRecord {
    fn estimated_bytes(&self) -> usize {
        self.transaction.estimated_bytes() + self.applied.history_item.estimated_bytes()
    }
}

fn hash_len(hasher: &mut Sha256, length: usize) {
    hasher.update((length as u64).to_be_bytes());
}

fn hash_text(hasher: &mut Sha256, value: &str) {
    hash_len(hasher, value.len());
    hasher.update(value.as_bytes());
}

fn hash_number(hasher: &mut Sha256, value: f64) {
    // Document validation rules rule out NaN/Infinity. Normalizing signed zero keeps
    // a harmless transport representation detail from splitting canonical hashes.
    hasher.update(
        (if value == 0.0 { 0.0 } else { value })
            .to_bits()
            .to_be_bytes(),
    );
}

fn normalize_layout_number(value: f64) -> f64 {
    (value * 1_000_000.0).round() / 1_000_000.0
}

fn hash_auto_layout(hasher: &mut Sha256, layout: &AutoLayout) {
    hasher.update([match layout.mode {
        LayoutMode::None => 0,
        LayoutMode::Horizontal => 1,
        LayoutMode::Vertical => 2,
        LayoutMode::Grid => 3,
    }]);
    for value in layout.padding {
        hash_number(hasher, value);
    }
    hash_number(hasher, layout.item_spacing);
    hasher.update([u8::from(layout.wrap)]);
    hasher.update([match layout.primary_alignment {
        LayoutAlignment::Start => 0,
        LayoutAlignment::Center => 1,
        LayoutAlignment::End => 2,
        LayoutAlignment::SpaceBetween => 3,
        LayoutAlignment::Baseline => 4,
    }]);
    hasher.update([match layout.counter_alignment {
        LayoutAlignment::Start => 0,
        LayoutAlignment::Center => 1,
        LayoutAlignment::End => 2,
        LayoutAlignment::SpaceBetween => 3,
        LayoutAlignment::Baseline => 4,
    }]);
    hasher.update([match layout.primary_sizing {
        LayoutSizing::Fixed => 0,
        LayoutSizing::Hug => 1,
        LayoutSizing::Fill => 2,
    }]);
    hasher.update([match layout.counter_sizing {
        LayoutSizing::Fixed => 0,
        LayoutSizing::Hug => 1,
        LayoutSizing::Fill => 2,
    }]);
    // Append only when the v21 child override is present so every pre-v21
    // snapshot retains its established canonical hash.
    if let Some(align_self) = layout.align_self {
        hasher.update([
            0xa1,
            match align_self {
                LayoutAlignment::Start => 0,
                LayoutAlignment::Center => 1,
                LayoutAlignment::End => 2,
                LayoutAlignment::SpaceBetween => 3,
                LayoutAlignment::Baseline => 4,
            },
        ]);
    }
    for value in [
        layout.min_width,
        layout.max_width,
        layout.min_height,
        layout.max_height,
    ] {
        match value {
            Some(value) => {
                hasher.update([1]);
                hash_number(hasher, value);
            }
            None => hasher.update([0]),
        }
    }
    hasher.update([u8::from(layout.absolute)]);
    // Added after Snapshot v21. Omission keeps all pre-track-spacing hashes
    // byte-identical while an explicit zero remains distinguishable.
    match layout.track_spacing {
        Some(value) => {
            hasher.update([1]);
            hash_number(hasher, value);
        }
        None => hasher.update([0]),
    }
    if layout.track_alignment != WrapTrackAlignment::Auto {
        hasher.update([match layout.track_alignment {
            WrapTrackAlignment::Auto => 0,
            WrapTrackAlignment::SpaceBetween => 1,
        }]);
    }
    if layout.mode == LayoutMode::Grid {
        hasher.update(b"makefigma/editor-core/grid-layout-v1");
        for tracks in [&layout.grid_rows, &layout.grid_columns] {
            hash_len(hasher, tracks.len());
            for track in tracks {
                match track {
                    GridTrack::Flex(_) => hasher.update([0]),
                    GridTrack::Fixed(_) => hasher.update([1]),
                    GridTrack::Hug => hasher.update([2]),
                }
                match track {
                    GridTrack::Flex(value) | GridTrack::Fixed(value) => hash_number(hasher, *value),
                    GridTrack::Hug => hash_number(hasher, 0.0),
                }
            }
        }
        for gap in [layout.grid_row_gap, layout.grid_column_gap] {
            match gap {
                Some(value) => {
                    hasher.update([1]);
                    hash_number(hasher, value);
                }
                None => hasher.update([0]),
            }
        }
    }
    if layout.grid_row_span.is_some() || layout.grid_column_span.is_some() {
        hasher.update(b"makefigma/editor-core/grid-span-v1");
        hasher.update(layout.grid_row_span.unwrap_or(1).to_be_bytes());
        hasher.update(layout.grid_column_span.unwrap_or(1).to_be_bytes());
    }
    if layout.grid_items_positioning == GridItemsPositioning::Manual
        || layout.grid_row_anchor.is_some()
        || layout.grid_column_anchor.is_some()
    {
        hasher.update(b"makefigma/editor-core/grid-manual-placement-v1");
        hasher.update([u8::from(
            layout.grid_items_positioning == GridItemsPositioning::Manual,
        )]);
        for anchor in [layout.grid_row_anchor, layout.grid_column_anchor] {
            match anchor {
                Some(value) => {
                    hasher.update([1]);
                    hasher.update(value.to_be_bytes());
                }
                None => hasher.update([0]),
            }
        }
    }
    if layout.grid_auto_tracks == GridAutoTracks::Rows {
        hasher.update(b"makefigma/editor-core/grid-auto-rows-v1");
    }
    if layout.grid_child_horizontal_align != GridChildAlignment::Auto
        || layout.grid_child_vertical_align != GridChildAlignment::Auto
    {
        hasher.update(b"makefigma/editor-core/grid-child-alignment-v1");
        for alignment in [
            layout.grid_child_horizontal_align,
            layout.grid_child_vertical_align,
        ] {
            hasher.update([match alignment {
                GridChildAlignment::Auto => 0,
                GridChildAlignment::Min => 1,
                GridChildAlignment::Center => 2,
                GridChildAlignment::Max => 3,
            }]);
        }
    }
}

fn valid_auto_layout(layout: &AutoLayout) -> bool {
    let grid_tracks_valid = |tracks: &[GridTrack]| {
        !tracks.is_empty()
            && tracks.len() <= 128
            && tracks.iter().all(|track| match track {
                GridTrack::Flex(value) => value.is_finite() && *value > 0.0,
                GridTrack::Fixed(value) => value.is_finite() && *value >= 0.0,
                GridTrack::Hug => true,
            })
    };
    let grid_valid = if layout.mode == LayoutMode::Grid {
        grid_tracks_valid(&layout.grid_rows)
            && grid_tracks_valid(&layout.grid_columns)
            && layout
                .grid_rows
                .len()
                .saturating_mul(layout.grid_columns.len())
                <= 4096
            && matches!(
                layout.primary_sizing,
                LayoutSizing::Fixed | LayoutSizing::Hug
            )
            && matches!(
                layout.counter_sizing,
                LayoutSizing::Fixed | LayoutSizing::Hug
            )
            && (layout.primary_sizing != LayoutSizing::Hug
                || !layout
                    .grid_columns
                    .iter()
                    .any(|track| matches!(track, GridTrack::Flex(_))))
            && (layout.counter_sizing != LayoutSizing::Hug
                || (layout.grid_auto_tracks == GridAutoTracks::None
                    && !layout
                        .grid_rows
                        .iter()
                        .any(|track| matches!(track, GridTrack::Flex(_)))))
            && !layout.wrap
            && layout.track_spacing.is_none()
            && layout.track_alignment == WrapTrackAlignment::Auto
            && layout.primary_alignment == LayoutAlignment::Start
            && layout.counter_alignment == LayoutAlignment::Start
            && (layout.grid_auto_tracks == GridAutoTracks::None
                || (layout.grid_auto_tracks == GridAutoTracks::Rows
                    && layout.grid_rows.len() == 1
                    && layout.grid_items_positioning == GridItemsPositioning::RowAutoFlow))
            && layout
                .grid_row_gap
                .is_none_or(|value| value.is_finite() && value >= 0.0)
            && layout
                .grid_column_gap
                .is_none_or(|value| value.is_finite() && value >= 0.0)
    } else {
        layout.grid_rows.is_empty()
            && layout.grid_columns.is_empty()
            && layout.grid_row_gap.is_none()
            && layout.grid_column_gap.is_none()
            && layout.grid_auto_tracks == GridAutoTracks::None
    };
    layout
        .padding
        .into_iter()
        .all(|value| value.is_finite() && value >= 0.0)
        && layout.item_spacing.is_finite()
        && layout
            .track_spacing
            .is_none_or(|value| value.is_finite() && value >= 0.0)
        && (layout.wrap || layout.track_alignment == WrapTrackAlignment::Auto)
        && [
            layout.min_width,
            layout.max_width,
            layout.min_height,
            layout.max_height,
        ]
        .into_iter()
        .flatten()
        .all(|value| value.is_finite() && value >= 0.0)
        && layout
            .min_width
            .zip(layout.max_width)
            .is_none_or(|(min, max)| min <= max)
        && layout
            .min_height
            .zip(layout.max_height)
            .is_none_or(|(min, max)| min <= max)
        && !matches!(layout.primary_alignment, LayoutAlignment::Baseline)
        && !matches!(layout.counter_alignment, LayoutAlignment::SpaceBetween)
        && !(layout.counter_alignment == LayoutAlignment::Baseline
            && layout.mode != LayoutMode::Horizontal)
        && !matches!(
            layout.align_self,
            Some(LayoutAlignment::SpaceBetween | LayoutAlignment::Baseline)
        )
        && layout
            .grid_row_span
            .is_none_or(|value| (2..=128).contains(&value))
        && layout
            .grid_column_span
            .is_none_or(|value| (2..=128).contains(&value))
        && (layout.grid_row_anchor.is_some() == layout.grid_column_anchor.is_some())
        && layout.grid_row_anchor.is_none_or(|value| value < 128)
        && layout.grid_column_anchor.is_none_or(|value| value < 128)
        && (layout.mode == LayoutMode::Grid
            || layout.grid_items_positioning == GridItemsPositioning::RowAutoFlow)
        && grid_valid
}

fn hash_color(hasher: &mut Sha256, color: Color) {
    hasher.update([match color.space {
        ColorSpace::Srgb => 0,
        ColorSpace::DisplayP3 => 1,
        ColorSpace::LinearSrgb => 2,
    }]);
    for component in color.components {
        hasher.update(
            (if component == 0.0 { 0.0 } else { component })
                .to_bits()
                .to_be_bytes(),
        );
    }
    hasher.update(
        (if color.alpha == 0.0 { 0.0 } else { color.alpha })
            .to_bits()
            .to_be_bytes(),
    );
}

fn hash_drop_shadow(hasher: &mut Sha256, shadow: DropShadow) {
    for value in [
        shadow.offset_x,
        shadow.offset_y,
        shadow.blur_radius,
        shadow.spread,
    ] {
        hash_number(hasher, value);
    }
    hash_color(hasher, shadow.color);
    hasher.update([u8::from(shadow.visible)]);
}

fn hash_effect_stack(hasher: &mut Sha256, effects: &[Effect]) {
    if effects.is_empty() {
        return;
    }
    hasher.update(b"makefigma/editor-core/effect-stack-v1");
    hash_len(hasher, effects.len());
    for effect in effects {
        match effect {
            Effect::DropShadow(shadow) => {
                hasher.update([0]);
                hash_drop_shadow(hasher, *shadow);
            }
            Effect::LayerBlur(blur) => {
                hasher.update([1]);
                hash_number(hasher, blur.radius);
                hasher.update([u8::from(blur.visible)]);
            }
            Effect::InnerShadow(shadow) => {
                hasher.update([2]);
                hash_drop_shadow(
                    hasher,
                    DropShadow {
                        offset_x: shadow.offset_x,
                        offset_y: shadow.offset_y,
                        blur_radius: shadow.blur_radius,
                        spread: shadow.spread,
                        color: shadow.color,
                        visible: shadow.visible,
                    },
                );
            }
            Effect::BackgroundBlur(blur) => {
                hasher.update([3]);
                hash_number(hasher, blur.radius);
                hasher.update([u8::from(blur.visible)]);
            }
        }
    }
}

fn hash_paint(hasher: &mut Sha256, paint: &Paint) {
    match paint {
        Paint::Solid(color) => {
            hasher.update([0]);
            hash_color(hasher, *color);
        }
        Paint::LinearGradient(gradient) => {
            hasher.update([1]);
            for value in gradient.start.into_iter().chain(gradient.end) {
                hasher.update(
                    (if value == 0.0 { 0.0 } else { value })
                        .to_bits()
                        .to_be_bytes(),
                );
            }
            hash_len(hasher, gradient.stops.len());
            for stop in &gradient.stops {
                hasher.update(
                    (if stop.position == 0.0 {
                        0.0
                    } else {
                        stop.position
                    })
                    .to_bits()
                    .to_be_bytes(),
                );
                hash_color(hasher, stop.color);
            }
        }
    }
}

fn hash_paint_stack(hasher: &mut Sha256, paints: &[Paint], marker: u8) {
    if paints.is_empty() {
        return;
    }
    hasher.update([marker]);
    hash_len(hasher, paints.len());
    for paint in paints {
        hash_paint(hasher, paint);
    }
}

fn hash_versioned_paint_stack(hasher: &mut Sha256, stack: &PaintStack) {
    hash_len(hasher, stack.layers.len());
    for layer in &stack.layers {
        hasher.update([u8::from(layer.visible)]);
        hasher.update(layer.opacity.to_bits().to_be_bytes());
        hasher.update([match layer.blend_mode {
            BlendMode::Normal => 0,
            BlendMode::Multiply => 1,
            BlendMode::Screen => 2,
            BlendMode::Overlay => 3,
            BlendMode::Darken => 4,
            BlendMode::Lighten => 5,
            BlendMode::ColorDodge => 6,
            BlendMode::ColorBurn => 7,
            BlendMode::HardLight => 8,
            BlendMode::SoftLight => 9,
            BlendMode::Difference => 10,
            BlendMode::Exclusion => 11,
            BlendMode::Hue => 12,
            BlendMode::Saturation => 13,
            BlendMode::Color => 14,
            BlendMode::Luminosity => 15,
            BlendMode::PassThrough => 16,
            BlendMode::LinearBurn => 17,
            BlendMode::LinearDodge => 18,
        }]);
        match &layer.paint {
            PaintLayerKind::Solid(color) => {
                hasher.update([0]);
                hash_color(hasher, *color);
            }
            PaintLayerKind::LinearGradient(gradient) => {
                hasher.update([1]);
                hash_paint(hasher, &Paint::LinearGradient(gradient.clone()));
            }
            PaintLayerKind::Image(image) => {
                hasher.update([2]);
                hasher.update(image.asset_id.0.to_be_bytes());
                hasher.update([match image.scale_mode {
                    ImageScaleMode::Fill => 0,
                    ImageScaleMode::Fit => 1,
                    ImageScaleMode::Crop => 2,
                    ImageScaleMode::Tile => 3,
                }]);
                for value in [
                    image.transform.a,
                    image.transform.b,
                    image.transform.c,
                    image.transform.d,
                    image.transform.e,
                    image.transform.f,
                ] {
                    hash_number(hasher, value);
                }
                hasher.update(image.rotation_degrees.to_be_bytes());
                hash_image_filters(hasher, image.filters);
            }
            PaintLayerKind::Gradient(gradient) => {
                hasher.update([3]);
                hasher.update([match gradient.kind {
                    GradientPaintKind::Radial => 0,
                    GradientPaintKind::Angular => 1,
                    GradientPaintKind::Diamond => 2,
                }]);
                for value in [
                    gradient.transform.a,
                    gradient.transform.b,
                    gradient.transform.c,
                    gradient.transform.d,
                    gradient.transform.e,
                    gradient.transform.f,
                ] {
                    hash_number(hasher, value);
                }
                hash_len(hasher, gradient.stops.len());
                for stop in &gradient.stops {
                    hasher.update(stop.position.to_bits().to_be_bytes());
                    hash_color(hasher, stop.color);
                }
            }
        }
    }
}

fn hash_image_filters(hasher: &mut Sha256, filters: Option<crate::color::ImageFilters>) {
    let Some(filters) = filters else {
        hasher.update([0]);
        return;
    };
    hasher.update([1]);
    for value in [
        filters.exposure,
        filters.contrast,
        filters.saturation,
        filters.temperature,
        filters.tint,
        filters.highlights,
        filters.shadows,
    ] {
        match value {
            Some(value) => {
                hasher.update([1]);
                hash_number(hasher, f64::from(value));
            }
            None => hasher.update([0]),
        }
    }
}

fn hash_document_paint_stacks(
    hasher: &mut Sha256,
    stacks: &SharedOrdMap<(NodeId, bool), PaintStack>,
) {
    if stacks.is_empty() {
        return;
    }
    hasher.update(b"document-paint-stacks-v1");
    hash_len(hasher, stacks.len());
    for ((node_id, stroke), stack) in stacks {
        hasher.update(node_id.0.to_be_bytes());
        hasher.update([u8::from(*stroke)]);
        hash_versioned_paint_stack(hasher, stack);
    }
}

fn hash_stroke_cap(hasher: &mut Sha256, cap: StrokeCap) {
    hasher.update([match cap {
        StrokeCap::None => 0,
        StrokeCap::Round => 1,
        StrokeCap::Square => 2,
        StrokeCap::ArrowLines => 3,
        StrokeCap::ArrowEquilateral => 4,
        StrokeCap::DiamondFilled => 5,
        StrokeCap::TriangleFilled => 6,
        StrokeCap::CircleFilled => 7,
    }]);
}

fn hash_document_color_profile(hasher: &mut Sha256, profile: DocumentColorProfile) {
    hasher.update([match profile {
        DocumentColorProfile::Srgb => 0,
        DocumentColorProfile::DisplayP3 => 1,
    }]);
}

fn hash_font_reference(hasher: &mut Sha256, font: &FontReference) {
    hasher.update(font.asset_id.0.to_be_bytes());
    hasher.update(font.face_index.to_be_bytes());
    hash_len(hasher, font.variation_axes.len());
    for (tag, value) in &font.variation_axes {
        hash_text(hasher, tag);
        hasher.update(
            (if *value == 0.0 { 0.0 } else { *value })
                .to_bits()
                .to_be_bytes(),
        );
    }
}

fn hash_text_style_payload(hasher: &mut Sha256, style: &TextStyleRun) {
    match &style.font {
        Some(font) => {
            hasher.update([1]);
            hash_font_reference(hasher, font);
        }
        None => hasher.update([0]),
    }
    hash_number(hasher, style.font_size);
    hasher.update(style.font_weight.to_be_bytes());
    hasher.update([u8::from(style.italic)]);
    hash_number(hasher, style.letter_spacing);
    match style.color {
        Some(color) => {
            hasher.update([1]);
            hash_color(hasher, color);
        }
        None => hasher.update([0]),
    }
    match &style.fill_stack {
        Some(stack) => {
            hasher.update([1]);
            hash_versioned_paint_stack(hasher, stack);
        }
        None => hasher.update([0]),
    }
}

fn hash_text_style_resource(hasher: &mut Sha256, resource: &TextStyleResource) {
    hash_text(hasher, &resource.id);
    hash_text(hasher, &resource.key);
    hash_text(hasher, &resource.name);
    hash_text(hasher, &resource.description);
    hasher.update([u8::from(resource.remote)]);
    let mut properties = TextProperties::default();
    properties.paragraph = resource.paragraph.clone();
    properties.base_style = Some(resource.style.clone());
    hash_text_properties(hasher, &properties);
    if resource.letter_spacing_unit == Some(TextStyleLetterSpacingUnit::Percent) {
        hasher.update(b"makefigma/editor-core/text-style-letter-spacing-percent-v1");
    }
    if !resource.variable_bindings.is_empty() {
        hasher.update(b"makefigma/editor-core/text-style-variable-bindings-v1");
        hash_len(hasher, resource.variable_bindings.len());
        for (field, id) in &resource.variable_bindings {
            hash_text(hasher, field);
            hash_text(hasher, id);
        }
    }
    hash_style_publishable_metadata(
        hasher,
        &resource.description_markdown,
        &resource.documentation_links,
    );
}

fn hash_paint_style_resource(hasher: &mut Sha256, resource: &PaintStyleResource) {
    hash_text(hasher, &resource.id);
    hash_text(hasher, &resource.key);
    hash_text(hasher, &resource.name);
    hash_text(hasher, &resource.description);
    hasher.update([u8::from(resource.remote)]);
    hash_versioned_paint_stack(hasher, &resource.paints);
    if !resource.variable_bindings.is_empty() {
        hasher.update(b"makefigma/editor-core/paint-style-variable-bindings-v1");
        hash_len(hasher, resource.variable_bindings.len());
        for binding in &resource.variable_bindings {
            hasher.update(binding.paint_index.to_be_bytes());
            match binding.stop_index {
                Some(index) => {
                    hasher.update([1]);
                    hasher.update(index.to_be_bytes());
                }
                None => hasher.update([0]),
            }
            hash_text(hasher, &binding.variable_id);
        }
    }
    hash_style_publishable_metadata(
        hasher,
        &resource.description_markdown,
        &resource.documentation_links,
    );
}

fn hash_style_publishable_metadata(
    hasher: &mut Sha256,
    description_markdown: &str,
    documentation_links: &[String],
) {
    if description_markdown.is_empty() && documentation_links.is_empty() {
        return;
    }
    hasher.update(b"makefigma/editor-core/style-publishable-metadata-v1");
    hash_text(hasher, description_markdown);
    hash_len(hasher, documentation_links.len());
    for uri in documentation_links {
        hash_text(hasher, uri);
    }
}

fn hash_variable_collection(hasher: &mut Sha256, collection: &VariableCollectionResource) {
    hash_text(hasher, &collection.id);
    hash_text(hasher, &collection.key);
    hash_text(hasher, &collection.name);
    hasher.update([
        u8::from(collection.remote),
        u8::from(collection.hidden_from_publishing),
    ]);
    hash_len(hasher, collection.modes.len());
    for mode in &collection.modes {
        hash_text(hasher, &mode.id);
        hash_text(hasher, &mode.name);
    }
    hash_text(hasher, &collection.default_mode_id);
}

fn hash_variable_resource(hasher: &mut Sha256, variable: &VariableResource) {
    hash_text(hasher, &variable.id);
    hash_text(hasher, &variable.key);
    hash_text(hasher, &variable.name);
    hash_text(hasher, &variable.description);
    hasher.update([
        u8::from(variable.remote),
        u8::from(variable.hidden_from_publishing),
    ]);
    hash_text(hasher, &variable.collection_id);
    hasher.update([match variable.resolved_type {
        VariableResolvedType::Boolean => 1,
        VariableResolvedType::Color => 2,
        VariableResolvedType::Float => 3,
        VariableResolvedType::String => 4,
    }]);
    hash_len(hasher, variable.values_by_mode.len());
    for (mode, value) in &variable.values_by_mode {
        hash_text(hasher, mode);
        match value {
            VariableValue::Boolean(value) => hasher.update([1, u8::from(*value)]),
            VariableValue::Color(value) => {
                hasher.update([2]);
                hash_color(hasher, *value);
            }
            VariableValue::Float(value) => {
                hasher.update([3]);
                hash_number(hasher, *value);
            }
            VariableValue::String(value) => {
                hasher.update([4]);
                hash_text(hasher, value);
            }
            VariableValue::Alias(value) => {
                hasher.update([5]);
                hash_text(hasher, value);
            }
        }
    }
    hash_len(hasher, variable.scopes.len());
    for scope in &variable.scopes {
        hash_text(hasher, scope);
    }
    if !variable.code_syntax.is_empty() {
        hash_len(hasher, variable.code_syntax.len());
        for (platform, value) in &variable.code_syntax {
            hash_text(hasher, platform);
            hash_text(hasher, value);
        }
    }
}

fn hash_optional_style_id(hasher: &mut Sha256, value: Option<&str>) {
    match value {
        Some(value) => {
            hasher.update([1]);
            hash_text(hasher, value);
        }
        None => hasher.update([0]),
    }
}

fn hash_text_properties(hasher: &mut Sha256, properties: &TextProperties) {
    hash_len(hasher, properties.runs.len());
    for run in &properties.runs {
        hasher.update(run.start.to_be_bytes());
        hasher.update(run.end.to_be_bytes());
        match &run.font {
            Some(font) => {
                hasher.update([1]);
                hash_font_reference(hasher, font);
            }
            None => hasher.update([0]),
        }
        hash_number(hasher, run.font_size);
        hasher.update(run.font_weight.to_be_bytes());
        hasher.update([u8::from(run.italic)]);
        hash_number(hasher, run.letter_spacing);
    }
    // Append the extension only when any run uses it so pre-L1 documents retain
    // their existing Canonical Hashes byte-for-byte.
    if properties.runs.iter().any(|run| run.color.is_some()) {
        hasher.update(b"makefigma/editor-core/text-run-color-v1");
        for run in &properties.runs {
            match run.color {
                Some(color) => {
                    hasher.update([1]);
                    hash_color(hasher, color);
                }
                None => hasher.update([0]),
            }
        }
    }
    // Append only when a run uses the versioned stack so every legacy text
    // hash, including color-bearing semantics-13 documents, stays unchanged.
    if properties.runs.iter().any(|run| run.fill_stack.is_some()) {
        hasher.update(b"makefigma/editor-core/text-run-paint-stack-v1");
        for run in &properties.runs {
            match &run.fill_stack {
                Some(stack) => {
                    hasher.update([1]);
                    hash_versioned_paint_stack(hasher, stack);
                }
                None => hasher.update([0]),
            }
        }
    }
    if properties
        .runs
        .iter()
        .any(|run| !run.variable_bindings.is_empty())
        || properties
            .base_style
            .as_ref()
            .is_some_and(|style| !style.variable_bindings.is_empty())
    {
        hasher.update(b"makefigma/editor-core/text-range-variable-bindings-v1");
        hash_len(hasher, properties.runs.len());
        for run in &properties.runs {
            hash_len(hasher, run.variable_bindings.len());
            for (field, id) in &run.variable_bindings {
                hash_text(hasher, field);
                hash_text(hasher, id);
            }
        }
        match &properties.base_style {
            Some(style) => {
                hasher.update([1]);
                hash_len(hasher, style.variable_bindings.len());
                for (field, id) in &style.variable_bindings {
                    hash_text(hasher, field);
                    hash_text(hasher, id);
                }
            }
            None => hasher.update([0]),
        }
    }
    hasher.update([match properties.paragraph.alignment {
        TextAlign::Left => 0,
        TextAlign::Center => 1,
        TextAlign::Right => 2,
        TextAlign::Justify => 3,
    }]);
    match properties.paragraph.line_height {
        Some(value) => {
            hasher.update([1]);
            hash_number(hasher, value);
        }
        None => hasher.update([0]),
    }
    hash_number(hasher, properties.paragraph.paragraph_spacing);
    if let Some(unit) = properties.paragraph.line_height_unit {
        hasher.update(b"makefigma/editor-core/line-height-unit-v1");
        hasher.update([match unit {
            LineHeightUnit::Percent => 1,
            LineHeightUnit::Auto => 2,
        }]);
    }
    if let Some(indent) = properties.paragraph.paragraph_indent {
        hasher.update(b"makefigma/editor-core/paragraph-indent-v1");
        hash_number(hasher, indent);
    }
    if let Some(style) = properties.paragraph.text_wrap_style {
        hasher.update(b"makefigma/editor-core/text-wrap-style-v1");
        hasher.update([match style {
            TextWrapStyle::Auto => 0,
            TextWrapStyle::Balance => 1,
            TextWrapStyle::Pretty => 2,
        }]);
    }
    if let Some(list_type) = properties.paragraph.list_type {
        hasher.update(b"makefigma/editor-core/text-list-type-v1");
        hasher.update([match list_type {
            TextListType::Ordered => 1,
            TextListType::Unordered => 2,
        }]);
    }
    if let Some(spacing) = properties.paragraph.list_spacing {
        hasher.update(b"makefigma/editor-core/text-list-spacing-v1");
        hash_number(hasher, spacing);
    }
    if properties.paragraph.hanging_list {
        hasher.update(b"makefigma/editor-core/text-hanging-list-v1");
    }
    if properties.paragraph.hanging_punctuation {
        hasher.update(b"makefigma/editor-core/text-hanging-punctuation-v1");
    }
    if !properties.paragraph_style_runs.is_empty() {
        hasher.update(b"makefigma/editor-core/paragraph-style-runs-v1");
        hash_len(hasher, properties.paragraph_style_runs.len());
        for run in &properties.paragraph_style_runs {
            hasher.update(run.start.to_be_bytes());
            match run.indentation {
                Some(value) => {
                    hasher.update([1]);
                    hasher.update(value.to_be_bytes());
                }
                None => hasher.update([0]),
            }
        }
    }
    // Keep semantics-31 indentation hashes byte-for-byte stable. The new
    // field receives its own conditional domain only when an override exists.
    if properties
        .paragraph_style_runs
        .iter()
        .any(|run| run.list_type.is_some())
    {
        hasher.update(b"makefigma/editor-core/paragraph-list-options-v1");
        hash_len(hasher, properties.paragraph_style_runs.len());
        for run in &properties.paragraph_style_runs {
            hasher.update(run.start.to_be_bytes());
            match run.list_type {
                Some(value) => {
                    hasher.update([1]);
                    hasher.update([match value {
                        ParagraphListType::None => 0,
                        ParagraphListType::Ordered => 1,
                        ParagraphListType::Unordered => 2,
                    }]);
                }
                None => hasher.update([0]),
            }
        }
    }
    // Preserve every earlier paragraph-run hash. Per-paragraph paragraph
    // spacing receives a conditional domain only when an override exists.
    if properties
        .paragraph_style_runs
        .iter()
        .any(|run| run.paragraph_spacing.is_some())
    {
        hasher.update(b"makefigma/editor-core/paragraph-spacing-run-v1");
        hash_len(hasher, properties.paragraph_style_runs.len());
        for run in &properties.paragraph_style_runs {
            hasher.update(run.start.to_be_bytes());
            match run.paragraph_spacing {
                Some(value) => {
                    hasher.update([1]);
                    hash_number(hasher, value);
                }
                None => hasher.update([0]),
            }
        }
    }
    // Preserve every earlier paragraph-run hash. Per-paragraph first-line
    // indent receives a conditional domain only when an override exists.
    if properties
        .paragraph_style_runs
        .iter()
        .any(|run| run.paragraph_indent.is_some())
    {
        hasher.update(b"makefigma/editor-core/paragraph-indent-run-v1");
        hash_len(hasher, properties.paragraph_style_runs.len());
        for run in &properties.paragraph_style_runs {
            hasher.update(run.start.to_be_bytes());
            match run.paragraph_indent {
                Some(value) => {
                    hasher.update([1]);
                    hash_number(hasher, value);
                }
                None => hasher.update([0]),
            }
        }
    }
    // Preserve every earlier paragraph-run hash. The structured line-height
    // override enters one conditional domain only when either member exists.
    if properties
        .paragraph_style_runs
        .iter()
        .any(|run| run.line_height.is_some() || run.line_height_unit.is_some())
    {
        hasher.update(b"makefigma/editor-core/paragraph-line-height-run-v1");
        hash_len(hasher, properties.paragraph_style_runs.len());
        for run in &properties.paragraph_style_runs {
            hasher.update(run.start.to_be_bytes());
            match run.line_height {
                Some(value) => {
                    hasher.update([1]);
                    hash_number(hasher, value);
                }
                None => hasher.update([0]),
            }
            match run.line_height_unit {
                Some(LineHeightUnit::Percent) => hasher.update([1]),
                Some(LineHeightUnit::Auto) => hasher.update([2]),
                None => hasher.update([0]),
            }
        }
    }
    // Preserve every earlier paragraph-run hash. A range wrap override gets
    // its own domain and keeps explicit AUTO distinct from inheritance.
    if properties
        .paragraph_style_runs
        .iter()
        .any(|run| run.text_wrap_style.is_some())
    {
        hasher.update(b"makefigma/editor-core/paragraph-text-wrap-style-v1");
        hash_len(hasher, properties.paragraph_style_runs.len());
        for run in &properties.paragraph_style_runs {
            hasher.update(run.start.to_be_bytes());
            match run.text_wrap_style {
                Some(TextWrapStyle::Auto) => hasher.update([0]),
                Some(TextWrapStyle::Balance) => hasher.update([1]),
                Some(TextWrapStyle::Pretty) => hasher.update([2]),
                None => hasher.update([255]),
            }
        }
    }
    // Keep semantics-31 indentation and semantics-33 list-option hashes stable.
    // Per-paragraph spacing enters a separate domain only when it is present.
    if properties
        .paragraph_style_runs
        .iter()
        .any(|run| run.list_spacing.is_some())
    {
        hasher.update(b"makefigma/editor-core/paragraph-list-spacing-v1");
        hash_len(hasher, properties.paragraph_style_runs.len());
        for run in &properties.paragraph_style_runs {
            hasher.update(run.start.to_be_bytes());
            match run.list_spacing {
                Some(value) => {
                    hasher.update([1]);
                    hash_number(hasher, value);
                }
                None => hasher.update([0]),
            }
        }
    }
    hasher.update([match properties.auto_size {
        TextAutoSize::Fixed => 0,
        TextAutoSize::Height => 1,
        TextAutoSize::WidthAndHeight => 2,
    }]);
    hash_len(hasher, properties.fallback_fonts.len());
    for font in &properties.fallback_fonts {
        hash_font_reference(hasher, font);
    }
    // Append only for the new behavior so legacy TextProperties retain their
    // pre-truncation canonical hash byte-for-byte.
    if properties.text_truncation == TextTruncation::Ending || properties.max_lines.is_some() {
        hasher.update(b"makefigma/editor-core/text-truncation-v1");
        hasher.update([match properties.text_truncation {
            TextTruncation::Disabled => 0,
            TextTruncation::Ending => 1,
        }]);
        match properties.max_lines {
            Some(value) => {
                hasher.update([1]);
                hasher.update(value.to_be_bytes());
            }
            None => hasher.update([0]),
        }
    }
    if let Some(style) = &properties.base_style {
        hasher.update(b"makefigma/editor-core/text-base-style-v1");
        hash_text_style_payload(hasher, style);
    }
    if properties
        .runs
        .iter()
        .any(|run| !run.open_type_features.is_empty())
        || properties
            .base_style
            .as_ref()
            .is_some_and(|style| !style.open_type_features.is_empty())
    {
        hasher.update(b"makefigma/editor-core/open-type-features-v1");
        for run in &properties.runs {
            hash_open_type_features(hasher, &run.open_type_features);
        }
        if let Some(style) = &properties.base_style {
            hash_open_type_features(hasher, &style.open_type_features);
        } else {
            hash_len(hasher, 0);
        }
    }
    if properties
        .runs
        .iter()
        .any(|run| run.text_style_id.is_some())
        || properties
            .base_style
            .as_ref()
            .is_some_and(|style| style.text_style_id.is_some())
    {
        hasher.update(b"makefigma/editor-core/text-style-link-v1");
        for run in &properties.runs {
            hash_optional_text(hasher, run.text_style_id.as_deref());
        }
        hash_optional_text(
            hasher,
            properties
                .base_style
                .as_ref()
                .and_then(|style| style.text_style_id.as_deref()),
        );
    }
    if properties
        .runs
        .iter()
        .any(|run| run.paint_style_id.is_some())
        || properties
            .base_style
            .as_ref()
            .is_some_and(|style| style.paint_style_id.is_some())
    {
        hasher.update(b"makefigma/editor-core/text-paint-style-link-v1");
        for run in &properties.runs {
            hash_optional_text(hasher, run.paint_style_id.as_deref());
        }
        hash_optional_text(
            hasher,
            properties
                .base_style
                .as_ref()
                .and_then(|style| style.paint_style_id.as_deref()),
        );
    }
    if properties.runs.iter().any(|run| run.text_case.is_some())
        || properties
            .base_style
            .as_ref()
            .is_some_and(|style| style.text_case.is_some())
    {
        hasher.update(b"makefigma/editor-core/text-case-v1");
        for run in &properties.runs {
            hash_optional_text_case(hasher, run.text_case);
        }
        hash_optional_text_case(
            hasher,
            properties
                .base_style
                .as_ref()
                .and_then(|style| style.text_case),
        );
    }
    if properties.runs.iter().any(|run| run.hyperlink.is_some())
        || properties
            .base_style
            .as_ref()
            .is_some_and(|style| style.hyperlink.is_some())
    {
        hasher.update(b"makefigma/editor-core/text-hyperlink-v1");
        for run in &properties.runs {
            hash_optional_hyperlink(hasher, run.hyperlink.as_ref());
        }
        hash_optional_hyperlink(
            hasher,
            properties
                .base_style
                .as_ref()
                .and_then(|style| style.hyperlink.as_ref()),
        );
    }
    if properties
        .runs
        .iter()
        .any(|run| run.text_decoration.is_some())
        || properties
            .base_style
            .as_ref()
            .is_some_and(|style| style.text_decoration.is_some())
    {
        hasher.update(b"makefigma/editor-core/text-decoration-v1");
        for run in &properties.runs {
            hash_optional_text_decoration(hasher, run.text_decoration);
        }
        hash_optional_text_decoration(
            hasher,
            properties
                .base_style
                .as_ref()
                .and_then(|style| style.text_decoration),
        );
    }
    if properties
        .runs
        .iter()
        .any(|run| run.text_decoration_style.is_some())
        || properties
            .base_style
            .as_ref()
            .is_some_and(|style| style.text_decoration_style.is_some())
    {
        hasher.update(b"makefigma/editor-core/text-decoration-style-v1");
        for run in &properties.runs {
            hash_optional_text_decoration_style(hasher, run.text_decoration_style);
        }
        hash_optional_text_decoration_style(
            hasher,
            properties
                .base_style
                .as_ref()
                .and_then(|style| style.text_decoration_style),
        );
    }
    if properties
        .runs
        .iter()
        .any(|run| run.text_decoration_offset.is_some())
        || properties
            .base_style
            .as_ref()
            .is_some_and(|style| style.text_decoration_offset.is_some())
    {
        hasher.update(b"makefigma/editor-core/text-decoration-offset-v1");
        for run in &properties.runs {
            hash_optional_text_decoration_offset(hasher, run.text_decoration_offset);
        }
        hash_optional_text_decoration_offset(
            hasher,
            properties
                .base_style
                .as_ref()
                .and_then(|style| style.text_decoration_offset),
        );
    }
    if properties
        .runs
        .iter()
        .any(|run| run.text_decoration_thickness.is_some())
        || properties
            .base_style
            .as_ref()
            .is_some_and(|style| style.text_decoration_thickness.is_some())
    {
        hasher.update(b"makefigma/editor-core/text-decoration-thickness-v1");
        for run in &properties.runs {
            hash_optional_text_decoration_thickness(hasher, run.text_decoration_thickness);
        }
        hash_optional_text_decoration_thickness(
            hasher,
            properties
                .base_style
                .as_ref()
                .and_then(|style| style.text_decoration_thickness),
        );
    }
    if properties
        .runs
        .iter()
        .any(|run| run.text_decoration_color.is_some())
        || properties
            .base_style
            .as_ref()
            .is_some_and(|style| style.text_decoration_color.is_some())
    {
        hasher.update(b"makefigma/editor-core/text-decoration-color-v1");
        for run in &properties.runs {
            hash_optional_text_decoration_color(hasher, run.text_decoration_color);
        }
        hash_optional_text_decoration_color(
            hasher,
            properties
                .base_style
                .as_ref()
                .and_then(|style| style.text_decoration_color),
        );
    }
    if properties
        .runs
        .iter()
        .any(|run| run.text_decoration_skip_ink.is_some())
        || properties
            .base_style
            .as_ref()
            .is_some_and(|style| style.text_decoration_skip_ink.is_some())
    {
        hasher.update(b"makefigma/editor-core/text-decoration-skip-ink-v1");
        for run in &properties.runs {
            hasher.update([u8::from(run.text_decoration_skip_ink == Some(true))]);
        }
        hasher.update([u8::from(
            properties
                .base_style
                .as_ref()
                .and_then(|style| style.text_decoration_skip_ink)
                == Some(true),
        )]);
    }
    if properties.runs.iter().any(|run| run.leading_trim.is_some())
        || properties
            .base_style
            .as_ref()
            .is_some_and(|style| style.leading_trim.is_some())
    {
        hasher.update(b"makefigma/editor-core/leading-trim-v1");
        for run in &properties.runs {
            hasher.update([u8::from(run.leading_trim == Some(LeadingTrim::CapHeight))]);
        }
        hasher.update([u8::from(
            properties
                .base_style
                .as_ref()
                .and_then(|style| style.leading_trim)
                == Some(LeadingTrim::CapHeight),
        )]);
    }
}

fn hash_optional_text(hasher: &mut Sha256, value: Option<&str>) {
    match value {
        Some(value) => {
            hasher.update([1]);
            hash_text(hasher, value);
        }
        None => hasher.update([0]),
    }
}

fn hash_optional_text_decoration_offset(hasher: &mut Sha256, value: Option<TextDecorationOffset>) {
    match value {
        None => hasher.update([0]),
        Some(TextDecorationOffset::Pixels(value)) => {
            hasher.update([1]);
            hash_number(hasher, value);
        }
        Some(TextDecorationOffset::Percent(value)) => {
            hasher.update([2]);
            hash_number(hasher, value);
        }
    }
}

fn hash_open_type_features(hasher: &mut Sha256, features: &[OpenTypeFeature]) {
    hash_len(hasher, features.len());
    for feature in features {
        hash_text(hasher, &feature.tag);
        hasher.update([u8::from(feature.enabled)]);
    }
}

fn hash_optional_text_decoration_thickness(
    hasher: &mut Sha256,
    value: Option<TextDecorationThickness>,
) {
    match value {
        None => hasher.update([0]),
        Some(TextDecorationThickness::Pixels(value)) => {
            hasher.update([1]);
            hash_number(hasher, value);
        }
        Some(TextDecorationThickness::Percent(value)) => {
            hasher.update([2]);
            hash_number(hasher, value);
        }
    }
}

fn hash_optional_text_decoration_color(hasher: &mut Sha256, value: Option<TextDecorationColor>) {
    match value {
        None => hasher.update([0]),
        Some(value) => {
            hasher.update([1]);
            hash_color(hasher, value.color);
            hasher.update([u8::from(value.visible)]);
            hasher.update(value.opacity.to_bits().to_be_bytes());
            hasher.update([match value.blend_mode {
                BlendMode::Normal => 0,
                BlendMode::Multiply => 1,
                BlendMode::Screen => 2,
                BlendMode::Overlay => 3,
                BlendMode::Darken => 4,
                BlendMode::Lighten => 5,
                BlendMode::ColorDodge => 6,
                BlendMode::ColorBurn => 7,
                BlendMode::HardLight => 8,
                BlendMode::SoftLight => 9,
                BlendMode::Difference => 10,
                BlendMode::Exclusion => 11,
                BlendMode::Hue => 12,
                BlendMode::Saturation => 13,
                BlendMode::Color => 14,
                BlendMode::Luminosity => 15,
                BlendMode::PassThrough => 16,
                BlendMode::LinearBurn => 17,
                BlendMode::LinearDodge => 18,
            }]);
        }
    }
}

fn hash_optional_text_decoration_style(hasher: &mut Sha256, value: Option<TextDecorationStyle>) {
    hasher.update([match value {
        None => 0,
        Some(TextDecorationStyle::Wavy) => 1,
        Some(TextDecorationStyle::Dotted) => 2,
    }]);
}

fn hash_optional_text_decoration(hasher: &mut Sha256, value: Option<TextDecoration>) {
    hasher.update([match value {
        None => 0,
        Some(TextDecoration::Underline) => 1,
        Some(TextDecoration::Strikethrough) => 2,
    }]);
}

fn hash_optional_hyperlink(hasher: &mut Sha256, value: Option<&HyperlinkTarget>) {
    match value {
        Some(value) => {
            hasher.update([
                1,
                match value.kind {
                    HyperlinkType::Url => 1,
                    HyperlinkType::Node => 2,
                },
            ]);
            hash_text(hasher, &value.value);
        }
        None => hasher.update([0]),
    }
}

fn hash_optional_text_case(hasher: &mut Sha256, value: Option<TextCase>) {
    match value {
        Some(value) => hasher.update([
            1,
            match value {
                TextCase::Original => 0,
                TextCase::Upper => 1,
                TextCase::Lower => 2,
                TextCase::Title => 3,
                TextCase::SmallCaps => 4,
                TextCase::SmallCapsForced => 5,
            },
        ]),
        None => hasher.update([0]),
    }
}

fn hash_node(hasher: &mut Sha256, node: &Node) {
    hasher.update(node.id.0.to_be_bytes());
    match node.parent_id {
        Some(parent_id) => {
            hasher.update([1]);
            hasher.update(parent_id.0.to_be_bytes());
        }
        None => hasher.update([0]),
    }
    hasher.update(node.position.key.to_be_bytes());
    hasher.update(node.position.actor.0.to_be_bytes());
    hash_text(hasher, &node.name);
    hasher.update([match node.kind {
        NodeKind::Frame => 0,
        NodeKind::Rectangle => 1,
        NodeKind::Ellipse => 2,
        NodeKind::Text => 3,
        NodeKind::Image => 4,
        NodeKind::Line => 5,
        NodeKind::Group => 6,
        NodeKind::Section => 7,
        NodeKind::Polygon => 8,
        NodeKind::Star => 9,
        NodeKind::Vector => 10,
        NodeKind::BooleanOperation => 11,
        NodeKind::Slice => 12,
        NodeKind::CodeBlock => 13,
        NodeKind::Component => 14,
        NodeKind::Instance => 15,
        NodeKind::Slot => 16,
        NodeKind::ComponentSet => 17,
        NodeKind::Connector => 18,
        NodeKind::Embed => 19,
        NodeKind::Highlight => 20,
        NodeKind::InteractiveSlideElement => 21,
        NodeKind::LinkUnfurl => 22,
        NodeKind::Media => 23,
        NodeKind::ShapeWithText => 24,
        NodeKind::SlideGrid => 25,
        NodeKind::Slide => 26,
        NodeKind::SlideRow => 27,
        NodeKind::Stamp => 28,
        NodeKind::Sticky => 29,
        NodeKind::Table => 30,
        NodeKind::TableCell => 31,
        NodeKind::TextPath => 32,
        NodeKind::TransformGroup => 33,
        NodeKind::WashiTape => 34,
        NodeKind::Widget => 35,
    }]);
    for value in [
        node.x,
        node.y,
        node.width,
        node.height,
        node.rotation,
        node.stroke_width,
        node.opacity,
        node.corner_radius,
    ] {
        hash_number(hasher, value);
    }
    if !node.corner_radii.is_empty() {
        hasher.update([3]);
        hash_len(hasher, node.corner_radii.len());
        for radius in &node.corner_radii {
            hash_number(hasher, *radius);
        }
    }
    if node.corner_smoothing != 0.0 {
        hasher.update([4]);
        hash_number(hasher, node.corner_smoothing);
    }
    hash_constraints(hasher, node.constraints);
    hash_paint(hasher, &node.fill);
    hash_paint(hasher, &node.stroke);
    hash_paint_stack(hasher, &node.fills, 5);
    hash_paint_stack(hasher, &node.strokes, 6);
    if let Some(path) = &node.vector_path {
        hasher.update(b"makefigma/editor-core/vector-path-v1");
        hash_vector_path(hasher, path);
    }
    if let Some(operation) = node.boolean_operation {
        hasher.update(b"makefigma/editor-core/boolean-operation-v1");
        hasher.update([match operation {
            BooleanOperation::Union => 0,
            BooleanOperation::Intersect => 1,
            BooleanOperation::Subtract => 2,
            BooleanOperation::Exclude => 3,
        }]);
    }
    if let Some(shadow) = node.drop_shadow {
        // Existing no-effect documents keep their historical digest exactly.
        hasher.update(b"makefigma/editor-core/drop-shadow-v1");
        hash_drop_shadow(hasher, shadow);
    }
    hash_effect_stack(hasher, &node.effect_stack);
    if node.blend_mode != BlendMode::Normal {
        hasher.update(b"makefigma/editor-core/blend-mode-v1");
        hasher.update([match node.blend_mode {
            BlendMode::Normal => unreachable!(),
            BlendMode::Multiply => 1,
            BlendMode::Screen => 2,
            BlendMode::Overlay => 3,
            BlendMode::Darken => 4,
            BlendMode::Lighten => 5,
            BlendMode::ColorDodge => 6,
            BlendMode::ColorBurn => 7,
            BlendMode::HardLight => 8,
            BlendMode::SoftLight => 9,
            BlendMode::Difference => 10,
            BlendMode::Exclusion => 11,
            BlendMode::Hue => 12,
            BlendMode::Saturation => 13,
            BlendMode::Color => 14,
            BlendMode::Luminosity => 15,
            BlendMode::PassThrough => 16,
            BlendMode::LinearBurn => 17,
            BlendMode::LinearDodge => 18,
        }]);
    }
    if let Some(shape) = node.parametric_shape {
        hasher.update(b"makefigma/editor-core/parametric-shape-v1");
        hash_parametric_shape(hasher, shape);
    }
    hash_stroke_cap(hasher, node.stroke_cap_start);
    hash_stroke_cap(hasher, node.stroke_cap_end);
    hash_stroke_style(
        hasher,
        node.stroke_join,
        node.stroke_miter_limit,
        &node.stroke_dash_pattern,
        &node.stroke_weights,
        node.stroke_align,
        node.arc_data,
        node.relative_transform,
    );
    hash_text(hasher, &node.text);
    hasher.update([u8::from(node.visible), u8::from(node.locked)]);
    if node.contents_hidden {
        // Keep hashes of historical false-by-default snapshots stable while
        // still making the newly meaningful Section state canonical.
        hasher.update([1]);
    }
    if is_frame_like(&node.kind) && !node.clips_content {
        hasher.update([2]);
    }
    if !node.extensions.is_empty() {
        // Empty maps are skipped so snapshots authored before extensions
        // existed keep their historical hashes. BTreeMap iteration is ordered,
        // so the digest is independent of insertion order.
        hasher.update([5]);
        hash_len(hasher, node.extensions.len());
        for (key, value) in &node.extensions {
            hash_text(hasher, key);
            hash_len(hasher, value.len());
            hasher.update(value);
        }
    }
}

fn hash_command(hasher: &mut Sha256, command: &Command) {
    match command {
        Command::CreatePage(page) => {
            hasher.update([0]);
            hasher.update(page.id.0.to_be_bytes());
            hasher.update(page.position.key.to_be_bytes());
            hasher.update(page.position.actor.0.to_be_bytes());
            hash_text(hasher, &page.name);
        }
        Command::CreateInPage { page_id, node } => {
            hasher.update([8]);
            hasher.update(page_id.0.to_be_bytes());
            hash_node(hasher, node);
        }
        Command::CreateImageInPage {
            page_id,
            node,
            asset_id,
        } => {
            hasher.update([10]);
            hasher.update(page_id.0.to_be_bytes());
            hasher.update(asset_id.0.to_be_bytes());
            hash_node(hasher, node);
        }
        Command::RestoreNode {
            page_id,
            node,
            asset_id,
            text_properties,
        } => {
            hasher.update([14]);
            hasher.update(page_id.0.to_be_bytes());
            hash_node(hasher, node);
            match asset_id {
                Some(asset_id) => {
                    hasher.update([1]);
                    hasher.update(asset_id.0.to_be_bytes());
                }
                None => hasher.update([0]),
            }
            match text_properties {
                Some(properties) => {
                    hasher.update([1]);
                    hash_text_properties(hasher, properties);
                }
                None => hasher.update([0]),
            }
        }
        Command::Create(node) => {
            hasher.update([1]);
            hash_node(hasher, node);
        }
        Command::UpdateGeometry {
            id,
            x,
            y,
            width,
            height,
            rotation,
        } => {
            hasher.update([2]);
            hasher.update(id.0.to_be_bytes());
            for value in [*x, *y, *width, *height, *rotation] {
                hash_number(hasher, value);
            }
        }
        Command::UpdateGeometryWithoutConstraints {
            id,
            x,
            y,
            width,
            height,
            rotation,
        } => {
            hasher.update([36]);
            hasher.update(id.0.to_be_bytes());
            for value in [*x, *y, *width, *height, *rotation] {
                hash_number(hasher, value);
            }
        }
        Command::Rename { id, name } => {
            hasher.update([3]);
            hasher.update(id.0.to_be_bytes());
            hash_text(hasher, name);
        }
        Command::SetAppearance { id, appearance } => {
            hasher.update([4]);
            hasher.update(id.0.to_be_bytes());
            hash_paint(hasher, &appearance.fill);
            hash_paint(hasher, &appearance.stroke);
            hash_paint_stack(hasher, &appearance.fills, 5);
            hash_paint_stack(hasher, &appearance.strokes, 6);
            if let Some(shadow) = appearance.drop_shadow {
                hasher.update(b"makefigma/editor-core/drop-shadow-v1");
                hash_drop_shadow(hasher, shadow);
            }
            hash_effect_stack(hasher, &appearance.effect_stack);
            if appearance.blend_mode != BlendMode::Normal {
                hasher.update(b"makefigma/editor-core/blend-mode-v1");
                hasher.update([match appearance.blend_mode {
                    BlendMode::Normal => unreachable!(),
                    BlendMode::Multiply => 1,
                    BlendMode::Screen => 2,
                    BlendMode::Overlay => 3,
                    BlendMode::Darken => 4,
                    BlendMode::Lighten => 5,
                    BlendMode::ColorDodge => 6,
                    BlendMode::ColorBurn => 7,
                    BlendMode::HardLight => 8,
                    BlendMode::SoftLight => 9,
                    BlendMode::Difference => 10,
                    BlendMode::Exclusion => 11,
                    BlendMode::Hue => 12,
                    BlendMode::Saturation => 13,
                    BlendMode::Color => 14,
                    BlendMode::Luminosity => 15,
                    BlendMode::PassThrough => 16,
                    BlendMode::LinearBurn => 17,
                    BlendMode::LinearDodge => 18,
                }]);
            }
            if let Some(shape) = appearance.parametric_shape {
                hasher.update(b"makefigma/editor-core/parametric-shape-v1");
                hash_parametric_shape(hasher, shape);
            }
            hash_number(hasher, appearance.stroke_width);
            hash_stroke_cap(hasher, appearance.stroke_cap_start);
            hash_stroke_cap(hasher, appearance.stroke_cap_end);
            hash_stroke_style(
                hasher,
                appearance.stroke_join,
                appearance.stroke_miter_limit,
                &canonical_dash_pattern(&appearance.stroke_dash_pattern),
                &appearance.stroke_weights,
                appearance.stroke_align,
                appearance.arc_data,
                appearance.relative_transform,
            );
            hash_number(hasher, appearance.opacity);
            hash_number(hasher, appearance.corner_radius);
            if !appearance.corner_radii.is_empty() {
                hasher.update([3]);
                hash_len(hasher, appearance.corner_radii.len());
                for radius in &appearance.corner_radii {
                    hash_number(hasher, *radius);
                }
            }
            if appearance.corner_smoothing != 0.0 {
                hasher.update([4]);
                hash_number(hasher, appearance.corner_smoothing);
            }
            hash_constraints(hasher, appearance.constraints);
            hasher.update([u8::from(appearance.visible), u8::from(appearance.locked)]);
            if appearance.contents_hidden {
                hasher.update([1]);
            }
            if appearance.clips_content == Some(false) {
                hasher.update([2]);
            }
        }
        Command::SetPaintStacks {
            id,
            fill_stack,
            stroke_stack,
        } => {
            hasher.update(b"makefigma/editor-core/set-paint-stacks-v1");
            hasher.update(id.0.to_be_bytes());
            for stack in [fill_stack, stroke_stack] {
                match stack {
                    Some(stack) => {
                        hasher.update([1]);
                        hash_versioned_paint_stack(hasher, stack);
                    }
                    None => hasher.update([0]),
                }
            }
        }
        Command::SetPaintStyleLinks { id, links } => {
            hasher.update(b"makefigma/editor-core/set-paint-style-links-v1");
            hasher.update(id.0.to_be_bytes());
            hash_optional_style_id(hasher, links.fill.as_deref());
            hash_optional_style_id(hasher, links.stroke.as_deref());
            hash_optional_style_id(hasher, links.background.as_deref());
        }
        Command::SetVectorPath { id, path } => {
            hasher.update([16]);
            hasher.update(id.0.to_be_bytes());
            hash_vector_path(hasher, path);
        }
        Command::ConvertToTextPath { id, path } => {
            hasher.update(b"makefigma/editor-core/convert-to-text-path-v1");
            hasher.update(id.0.to_be_bytes());
            hash_vector_path(hasher, path);
        }
        Command::SetBooleanOperation { id, operation } => {
            hasher.update([22]);
            hasher.update(id.0.to_be_bytes());
            hasher.update([match operation {
                BooleanOperation::Union => 0,
                BooleanOperation::Intersect => 1,
                BooleanOperation::Subtract => 2,
                BooleanOperation::Exclude => 3,
            }]);
        }
        Command::SetMask { id, enabled } => {
            hasher.update([24]);
            hasher.update(id.0.to_be_bytes());
            hasher.update([u8::from(*enabled)]);
        }
        Command::SetNodeExtensions { id, extensions } => {
            hasher.update([26]);
            hasher.update(id.0.to_be_bytes());
            hash_len(hasher, extensions.len());
            for (key, value) in extensions {
                hash_text(hasher, key);
                hash_len(hasher, value.len());
                hasher.update(value);
            }
        }
        Command::MoveVectorPoint {
            id,
            point_id,
            position,
        } => {
            hasher.update([17]);
            hasher.update(id.0.to_be_bytes());
            hasher.update(point_id.0.to_be_bytes());
            hash_number(hasher, position.x);
            hash_number(hasher, position.y);
        }
        Command::SetVectorSubpathClosed {
            id,
            subpath_index,
            closed,
        } => {
            hasher.update([18]);
            hasher.update(id.0.to_be_bytes());
            hasher.update(subpath_index.to_be_bytes());
            hasher.update([u8::from(*closed)]);
        }
        Command::InsertVectorPoint {
            id,
            subpath_index,
            after_point_id,
            point,
        } => {
            hasher.update([19]);
            hasher.update(id.0.to_be_bytes());
            hasher.update(subpath_index.to_be_bytes());
            match after_point_id {
                Some(point_id) => {
                    hasher.update([1]);
                    hasher.update(point_id.0.to_be_bytes());
                }
                None => hasher.update([0]),
            }
            hasher.update(point.id.0.to_be_bytes());
            hash_number(hasher, point.position.x);
            hash_number(hasher, point.position.y);
            for handle in [point.handle_in, point.handle_out] {
                match handle {
                    Some(handle) => {
                        hasher.update([1]);
                        hash_number(hasher, handle.x);
                        hash_number(hasher, handle.y);
                    }
                    None => hasher.update([0]),
                }
            }
            hasher.update([match point.point_type {
                VectorPointType::Corner => 0,
                VectorPointType::Mirrored => 1,
                VectorPointType::Asymmetric => 2,
            }]);
        }
        Command::DeleteVectorPoint { id, point_id } => {
            hasher.update([20]);
            hasher.update(id.0.to_be_bytes());
            hasher.update(point_id.0.to_be_bytes());
        }
        Command::SplitVectorSegment {
            id,
            subpath_index,
            after_point_id,
            t,
            point_id,
        } => {
            hasher.update([23]);
            hasher.update(id.0.to_be_bytes());
            hasher.update(subpath_index.to_be_bytes());
            hasher.update(after_point_id.0.to_be_bytes());
            hash_number(hasher, *t);
            hasher.update(point_id.0.to_be_bytes());
        }
        Command::ConnectVectorEndpoints {
            id,
            first_subpath_index,
            first_point_id,
            second_subpath_index,
            second_point_id,
        } => {
            hasher.update([25]);
            hasher.update(id.0.to_be_bytes());
            hasher.update(first_subpath_index.to_be_bytes());
            hasher.update(first_point_id.0.to_be_bytes());
            hasher.update(second_subpath_index.to_be_bytes());
            hasher.update(second_point_id.0.to_be_bytes());
        }
        Command::SetVectorPointHandles {
            id,
            point_id,
            handle_in,
            handle_out,
            point_type,
        } => {
            hasher.update([21]);
            hasher.update(id.0.to_be_bytes());
            hasher.update(point_id.0.to_be_bytes());
            for handle in [handle_in, handle_out] {
                match handle {
                    Some(handle) => {
                        hasher.update([1]);
                        hash_number(hasher, handle.x);
                        hash_number(hasher, handle.y);
                    }
                    None => hasher.update([0]),
                }
            }
            hasher.update([match point_type {
                VectorPointType::Corner => 0,
                VectorPointType::Mirrored => 1,
                VectorPointType::Asymmetric => 2,
            }]);
        }
        Command::SetNodeAsset { id, asset_id } => {
            hasher.update([12]);
            hasher.update(id.0.to_be_bytes());
            match asset_id {
                Some(asset_id) => {
                    hasher.update([1]);
                    hasher.update(asset_id.0.to_be_bytes());
                }
                None => hasher.update([0]),
            }
        }
        Command::SetText { id, text } => {
            hasher.update([5]);
            hasher.update(id.0.to_be_bytes());
            hash_text(hasher, text);
        }
        Command::SetTextProperties { id, properties } => {
            hasher.update([11]);
            hasher.update(id.0.to_be_bytes());
            hash_text_properties(hasher, properties);
        }
        Command::SetAutoLayout { id, layout } => {
            hasher.update([25]);
            hasher.update(id.0.to_be_bytes());
            hash_auto_layout(hasher, layout);
        }
        Command::SetNodePosition { id, position } => {
            hasher.update([13]);
            hasher.update(id.0.to_be_bytes());
            hasher.update(position.key.to_be_bytes());
            hasher.update(position.actor.0.to_be_bytes());
        }
        Command::SetNodeParent {
            id,
            parent_id,
            position,
        } => {
            hasher.update([15]);
            hasher.update(id.0.to_be_bytes());
            match parent_id {
                Some(parent_id) => {
                    hasher.update([1]);
                    hasher.update(parent_id.0.to_be_bytes());
                }
                None => hasher.update([0]),
            }
            hasher.update(position.key.to_be_bytes());
            hasher.update(position.actor.0.to_be_bytes());
        }
        Command::RegisterAsset { asset } => {
            hasher.update([9]);
            hasher.update(asset.asset_id.0.to_be_bytes());
            hasher.update(asset.content_hash);
            hash_text(hasher, &asset.media_type);
            hasher.update(asset.byte_length.to_be_bytes());
            match asset.dimensions {
                Some([width, height]) => {
                    hasher.update([1]);
                    hasher.update(width.to_be_bytes());
                    hasher.update(height.to_be_bytes());
                }
                None => hasher.update([0]),
            }
            if !asset.font_faces.is_empty() {
                hasher.update(b"makefigma/editor-core/font-face-metadata-v1");
                hash_len(hasher, asset.font_faces.len());
                for face in &asset.font_faces {
                    hasher.update(face.face_index.to_be_bytes());
                    hash_text(hasher, &face.family);
                    hash_text(hasher, &face.style);
                    if !face.aliases.is_empty() {
                        hasher.update(b"makefigma/editor-core/font-name-aliases-v1");
                        hash_len(hasher, face.aliases.len());
                        for alias in &face.aliases {
                            hash_text(hasher, &alias.family);
                            hash_text(hasher, &alias.style);
                        }
                    }
                }
            }
        }
        Command::RegisterTextStyle { style } => {
            hasher.update([26]);
            hash_text_style_resource(hasher, style);
        }
        Command::RegisterPaintStyle { style } => {
            hasher.update([27]);
            hash_paint_style_resource(hasher, style);
        }
        Command::SetTextStyle { style } => {
            hasher.update(b"makefigma/editor-core/set-text-style-v1");
            hash_text_style_resource(hasher, style);
        }
        Command::DeleteTextStyle { id } => {
            hasher.update(b"makefigma/editor-core/delete-text-style-v1");
            hash_text(hasher, id);
        }
        Command::SetPaintStyle { style } => {
            hasher.update(b"makefigma/editor-core/set-paint-style-v1");
            hash_paint_style_resource(hasher, style);
        }
        Command::DeletePaintStyle { id } => {
            hasher.update(b"makefigma/editor-core/delete-paint-style-v1");
            hash_text(hasher, id);
        }
        Command::RegisterVariableCollection { collection } => {
            hasher.update([28]);
            hash_variable_collection(hasher, collection);
        }
        Command::RegisterVariable { variable } => {
            hasher.update([29]);
            hash_variable_resource(hasher, variable);
        }
        Command::SetVariable { variable } => {
            hasher.update([30]);
            hash_variable_resource(hasher, variable);
        }
        Command::DeleteVariable { id } => {
            hasher.update([31]);
            hash_text(hasher, id);
        }
        Command::SetVariableCollection {
            collection,
            variables,
        } => {
            hasher.update([32]);
            hash_variable_collection(hasher, collection);
            hash_len(hasher, variables.len());
            let mut variables = variables.iter().collect::<Vec<_>>();
            variables.sort_by(|left, right| left.id.cmp(&right.id));
            for variable in variables {
                hash_variable_resource(hasher, variable);
            }
        }
        Command::DeleteVariableCollection { id } => {
            hasher.update([33]);
            hash_text(hasher, id);
        }
        Command::SetDocumentColorProfile { profile } => {
            hasher.update([6]);
            hash_document_color_profile(hasher, *profile);
        }
        Command::Delete { id } => {
            hasher.update([7]);
            hasher.update(id.0.to_be_bytes());
        }
    }
}

fn image_fill_supported(kind: &NodeKind) -> bool {
    matches!(
        kind,
        NodeKind::Frame
            | NodeKind::Section
            | NodeKind::Rectangle
            | NodeKind::Ellipse
            | NodeKind::Image
    )
}

/// Canonical text style records are owned by Text, by the embedded TextSublayer
/// of ShapeWithText, and by Figma's non-resizable TextPath text surface.
fn supports_text_properties(kind: &NodeKind) -> bool {
    matches!(
        kind,
        NodeKind::Text | NodeKind::ShapeWithText | NodeKind::TextPath
    )
}

fn paragraph_start_offsets(text: &str) -> Vec<usize> {
    let mut starts = vec![0];
    for (offset, grapheme) in text.grapheme_indices(true) {
        if matches!(grapheme, "\n" | "\r" | "\r\n" | "\u{2028}" | "\u{2029}") {
            starts.push(offset + grapheme.len());
        }
    }
    starts
}

fn paragraph_indentation_at(properties: &TextProperties, paragraph_start: usize) -> u32 {
    properties
        .paragraph_style_runs
        .binary_search_by_key(&(paragraph_start as u32), |run| run.start)
        .ok()
        .and_then(|index| properties.paragraph_style_runs[index].indentation)
        .unwrap_or_else(|| u32::from(paragraph_list_type_at(properties, paragraph_start).is_some()))
}

fn paragraph_list_type_at(
    properties: &TextProperties,
    paragraph_start: usize,
) -> Option<TextListType> {
    properties
        .paragraph_style_runs
        .binary_search_by_key(&(paragraph_start as u32), |run| run.start)
        .ok()
        .and_then(|index| properties.paragraph_style_runs[index].list_type)
        .map(paragraph_list_type_value)
        .unwrap_or(properties.paragraph.list_type)
}

fn paragraph_list_spacing_at(properties: &TextProperties, paragraph_start: usize) -> f64 {
    properties
        .paragraph_style_runs
        .binary_search_by_key(&(paragraph_start as u32), |run| run.start)
        .ok()
        .and_then(|index| properties.paragraph_style_runs[index].list_spacing)
        .or(properties.paragraph.list_spacing)
        .unwrap_or(0.0)
}

fn paragraph_spacing_at(properties: &TextProperties, paragraph_start: usize) -> f64 {
    properties
        .paragraph_style_runs
        .binary_search_by_key(&(paragraph_start as u32), |run| run.start)
        .ok()
        .and_then(|index| properties.paragraph_style_runs[index].paragraph_spacing)
        .unwrap_or(properties.paragraph.paragraph_spacing)
}

fn paragraph_indent_at(properties: &TextProperties, paragraph_start: usize) -> f64 {
    properties
        .paragraph_style_runs
        .binary_search_by_key(&(paragraph_start as u32), |run| run.start)
        .ok()
        .and_then(|index| properties.paragraph_style_runs[index].paragraph_indent)
        .or(properties.paragraph.paragraph_indent)
        .unwrap_or(0.0)
}

fn is_hanging_start_punctuation(grapheme: &str) -> bool {
    matches!(
        grapheme,
        "\"" | "'"
            | "“"
            | "‘"
            | "«"
            | "‹"
            | "「"
            | "『"
            | "《"
            | "〈"
            | "【"
            | "〔"
            | "〖"
            | "〘"
            | "〚"
            | "（"
            | "［"
            | "｛"
    )
}

fn is_hanging_end_punctuation(grapheme: &str) -> bool {
    matches!(
        grapheme,
        "\"" | "'"
            | ","
            | "."
            | "!"
            | "?"
            | ":"
            | ";"
            | "”"
            | "’"
            | "»"
            | "›"
            | "」"
            | "』"
            | "》"
            | "〉"
            | "】"
            | "〕"
            | "〗"
            | "〙"
            | "〛"
            | "）"
            | "］"
            | "｝"
            | "、"
            | "。"
            | "，"
            | "．"
            | "！"
            | "？"
            | "："
            | "；"
            | "…"
    )
}

fn paragraph_line_height_at(
    properties: &TextProperties,
    paragraph_start: usize,
    font_size: f64,
) -> f64 {
    let run = properties
        .paragraph_style_runs
        .binary_search_by_key(&(paragraph_start as u32), |run| run.start)
        .ok()
        .map(|index| &properties.paragraph_style_runs[index]);
    match run.map(|run| (run.line_height, run.line_height_unit)) {
        Some((Some(value), Some(LineHeightUnit::Percent))) => font_size * value / 100.0,
        Some((None, Some(LineHeightUnit::Auto))) => font_size * 1.2,
        Some((Some(value), None)) => value,
        _ => properties.paragraph.effective_line_height(font_size),
    }
}

fn paragraph_list_type_value(value: ParagraphListType) -> Option<TextListType> {
    match value {
        ParagraphListType::None => None,
        ParagraphListType::Ordered => Some(TextListType::Ordered),
        ParagraphListType::Unordered => Some(TextListType::Unordered),
    }
}

fn paragraph_text_wrap_style_value(value: TextWrapStyle) -> Option<TextWrapStyle> {
    match value {
        TextWrapStyle::Auto => None,
        TextWrapStyle::Balance => Some(TextWrapStyle::Balance),
        TextWrapStyle::Pretty => Some(TextWrapStyle::Pretty),
    }
}

fn node_legacy_transform(node: &Node) -> Option<AffineTransform> {
    if !valid_geometry(
        &node.kind,
        Geometry {
            x: node.x,
            y: node.y,
            width: node.width,
            height: node.height,
            rotation: node.rotation,
        },
    ) {
        return None;
    }
    let radians = node.rotation.to_radians();
    let (sin, cos) = radians.sin_cos();
    let center_x = node.width / 2.0;
    let center_y = node.height / 2.0;
    Some(AffineTransform {
        a: cos,
        b: sin,
        c: -sin,
        d: cos,
        e: node.x + center_x - cos * center_x + sin * center_y,
        f: node.y + center_y - sin * center_x - cos * center_y,
    })
}

fn valid_geometry(kind: &NodeKind, geometry: Geometry) -> bool {
    geometry.x.is_finite()
        && geometry.y.is_finite()
        && geometry.width.is_finite()
        && geometry.height.is_finite()
        && geometry.rotation.is_finite()
        && geometry.width > 0.0
        && match kind {
            NodeKind::Line | NodeKind::Connector => geometry.height == 0.0,
            NodeKind::TextPath => geometry.height >= 0.0,
            NodeKind::Slide => {
                geometry.width == 1920.0 && geometry.height == 1080.0 && geometry.rotation == 0.0
            }
            _ => geometry.height > 0.0,
        }
}

fn can_contain_children(kind: &NodeKind) -> bool {
    matches!(
        kind,
        NodeKind::Frame
            | NodeKind::Component
            | NodeKind::Instance
            | NodeKind::Slot
            | NodeKind::ComponentSet
            | NodeKind::Group
            | NodeKind::TransformGroup
            | NodeKind::BooleanOperation
            | NodeKind::Section
            | NodeKind::Slide
            | NodeKind::SlideGrid
            | NodeKind::SlideRow
            | NodeKind::Table
    )
}

pub fn can_parent_contain_child(parent: &NodeKind, child: &NodeKind) -> bool {
    match parent {
        NodeKind::ComponentSet => *child == NodeKind::Component,
        NodeKind::SlideGrid => *child == NodeKind::SlideRow,
        NodeKind::SlideRow => *child == NodeKind::Slide,
        NodeKind::Table => *child == NodeKind::TableCell,
        _ => {
            can_contain_children(parent)
                && *child != NodeKind::Slide
                && *child != NodeKind::SlideRow
                && *child != NodeKind::SlideGrid
        }
    }
}

/// Components inherit the full Frame container contract, including clipping,
/// constraints, and Auto Layout.
fn is_frame_like(kind: &NodeKind) -> bool {
    matches!(
        kind,
        NodeKind::Frame
            | NodeKind::Component
            | NodeKind::Instance
            | NodeKind::Slot
            | NodeKind::ComponentSet
    )
}

fn is_structural_container(kind: &NodeKind) -> bool {
    matches!(kind, NodeKind::Group | NodeKind::BooleanOperation)
}

/// Slice is an editing/export boundary, not an invisible shape.  Its world
/// geometry, parent transform, visibility and lock state are meaningful, while
/// every paint-bearing field stays at a transparent/default value. Keeping this
/// invariant in Core prevents a newer client from accidentally turning a Slice
/// into a paintable rectangle that older projections would silently omit.
fn valid_slice_appearance(appearance: &Appearance) -> bool {
    matches!(&appearance.fill, Paint::Solid(color) if color.alpha == 0.0)
        && matches!(&appearance.stroke, Paint::Solid(color) if color.alpha == 0.0)
        && appearance.fills.is_empty()
        && appearance.strokes.is_empty()
        && appearance.stroke_width == 0.0
        && appearance.stroke_cap_start == StrokeCap::None
        && appearance.stroke_cap_end == StrokeCap::None
        && appearance.stroke_join == StrokeJoin::Miter
        && appearance.stroke_miter_limit == DEFAULT_STROKE_MITER_LIMIT
        && appearance.stroke_dash_pattern.is_empty()
        && appearance.stroke_weights.is_empty()
        && appearance.stroke_align == StrokeAlign::Inside
        && appearance.arc_data.is_none()
        && appearance.parametric_shape.is_none()
        && valid_relative_transform(appearance.relative_transform)
        && appearance.opacity == 1.0
        && appearance.blend_mode == BlendMode::Normal
        && appearance.drop_shadow.is_none()
        && appearance.effect_stack.is_empty()
        && appearance.corner_radius == 0.0
        && appearance.corner_radii.is_empty()
        && appearance.corner_smoothing == 0.0
        && !appearance.contents_hidden
        && appearance.clips_content == Some(false)
}

fn valid_slice_node(node: &Node) -> bool {
    valid_slice_appearance(&appearance_for_node(node))
        && node.vector_path.is_none()
        && node.boolean_operation.is_none()
        && node.text.is_empty()
        && !is_alpha_mask(node)
}

fn geometry_for_constraints(
    parent_before: Geometry,
    parent_after: Geometry,
    child: Geometry,
    constraints: Constraints,
    kind: &NodeKind,
) -> Result<Geometry, CommandError> {
    fn axis(
        position: f64,
        size: f64,
        old_parent: f64,
        new_parent: f64,
        constraint: ConstraintType,
        preserve_zero: bool,
    ) -> Result<(f64, f64), CommandError> {
        let delta = new_parent - old_parent;
        Ok(match constraint {
            ConstraintType::Min => (position, size),
            ConstraintType::Center => (position + delta / 2.0, size),
            ConstraintType::Max => (position + delta, size),
            ConstraintType::Stretch => (position, if preserve_zero { 0.0 } else { size + delta }),
            ConstraintType::Scale => {
                if old_parent == 0.0 {
                    return Err(CommandError::InvalidGeometry);
                }
                let ratio = new_parent / old_parent;
                (
                    position * ratio,
                    if preserve_zero { 0.0 } else { size * ratio },
                )
            }
        })
    }
    let (x, width) = axis(
        child.x - parent_before.x,
        child.width,
        parent_before.width,
        parent_after.width,
        constraints.horizontal,
        false,
    )?;
    let (y, height) = axis(
        child.y - parent_before.y,
        child.height,
        parent_before.height,
        parent_after.height,
        constraints.vertical,
        *kind == NodeKind::Line,
    )?;
    let after = Geometry {
        x: parent_after.x + x,
        y: parent_after.y + y,
        width,
        height,
        rotation: child.rotation,
    };
    if valid_geometry(kind, after) {
        Ok(after)
    } else {
        Err(CommandError::InvalidGeometry)
    }
}

fn effective_constraints(node: &Node) -> Option<Constraints> {
    if matches!(
        node.kind,
        NodeKind::Group | NodeKind::BooleanOperation | NodeKind::Section | NodeKind::Slide
    ) {
        return None;
    }
    Some(node.constraints.unwrap_or(Constraints {
        horizontal: ConstraintType::Min,
        vertical: ConstraintType::Min,
    }))
}

/// Keeps the historical x/y/rotation projection populated for a Relative-v1
/// node. The matrix is authoritative for painting and hit testing; this
/// projection deliberately only represents the translation/rotation subset,
/// matching the Web worker's dual-read fallback for skewed or reflected nodes.
fn geometry_for_relative_transform(
    transform: AffineTransform,
    width: f64,
    height: f64,
    kind: &NodeKind,
) -> Result<Geometry, CommandError> {
    if !valid_relative_transform(Some(transform)) {
        return Err(CommandError::InvalidGeometry);
    }
    let rotation = transform.b.atan2(transform.a).to_degrees();
    let radians = rotation.to_radians();
    let (sin, cos) = radians.sin_cos();
    let center_x = width / 2.0;
    let center_y = height / 2.0;
    let geometry = Geometry {
        x: transform.e - center_x + cos * center_x - sin * center_y,
        y: transform.f - center_y + sin * center_x + cos * center_y,
        width,
        height,
        rotation,
    };
    valid_geometry(kind, geometry)
        .then_some(geometry)
        .ok_or(CommandError::InvalidGeometry)
}

fn appearance_for_node(node: &Node) -> Appearance {
    Appearance {
        fill: node.fill.clone(),
        stroke: node.stroke.clone(),
        fills: node.fills.clone(),
        strokes: node.strokes.clone(),
        stroke_width: node.stroke_width,
        stroke_cap_start: node.stroke_cap_start,
        stroke_cap_end: node.stroke_cap_end,
        stroke_join: node.stroke_join,
        stroke_miter_limit: node.stroke_miter_limit,
        stroke_dash_pattern: node.stroke_dash_pattern.clone(),
        stroke_weights: node.stroke_weights.clone(),
        stroke_align: node.stroke_align,
        arc_data: node.arc_data,
        parametric_shape: node.parametric_shape,
        relative_transform: node.relative_transform,
        opacity: node.opacity,
        blend_mode: node.blend_mode,
        drop_shadow: node.drop_shadow,
        effect_stack: node.effect_stack.clone(),
        corner_radius: node.corner_radius,
        corner_radii: node.corner_radii.clone(),
        corner_smoothing: node.corner_smoothing,
        constraints: node.constraints,
        visible: node.visible,
        locked: node.locked,
        contents_hidden: node.contents_hidden,
        clips_content: Some(node.clips_content),
    }
}

fn valid_extensions(extensions: &BTreeMap<String, Vec<u8>>) -> bool {
    const MAX_EXTENSION_ENTRIES: usize = 256;
    const MAX_EXTENSION_KEY_BYTES: usize = 256;
    const MAX_EXTENSION_VALUE_BYTES: usize = 256 * 1024;
    extensions.len() <= MAX_EXTENSION_ENTRIES
        && extensions.iter().all(|(key, value)| {
            !key.is_empty()
                && key.len() <= MAX_EXTENSION_KEY_BYTES
                && value.len() <= MAX_EXTENSION_VALUE_BYTES
        })
}

fn prototype_duration(value: Option<&serde_json::Value>) -> bool {
    value
        .and_then(serde_json::Value::as_f64)
        .is_some_and(|duration| duration.is_finite() && (0.0..=60_000.0).contains(&duration))
}

fn valid_prototype_transition(value: &serde_json::Value) -> bool {
    let Some(value) = value.as_object() else {
        return false;
    };
    match value.get("type").and_then(serde_json::Value::as_str) {
        Some("NONE") => true,
        Some("DISSOLVE") => prototype_duration(value.get("duration")),
        Some("DIRECTIONAL") => {
            prototype_duration(value.get("duration"))
                && matches!(
                    value.get("direction").and_then(serde_json::Value::as_str),
                    Some("LEFT") | Some("RIGHT") | Some("UP") | Some("DOWN")
                )
        }
        _ => false,
    }
}

fn valid_prototype_metadata_extension(value: Option<&Vec<u8>>) -> bool {
    let Some(bytes) = value else {
        return true;
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return false;
    };
    let Some(value) = value.as_object() else {
        return false;
    };
    if let Some(starting_point) = value.get("startingPoint") {
        if !starting_point.is_boolean() {
            return false;
        }
    }
    let Some(overlay) = value.get("overlay") else {
        return true;
    };
    let Some(overlay) = overlay.as_object() else {
        return false;
    };
    if !matches!(
        overlay
            .get("positionType")
            .and_then(serde_json::Value::as_str),
        Some("CENTER") | Some("MANUAL")
    ) || !matches!(
        overlay
            .get("backgroundInteraction")
            .and_then(serde_json::Value::as_str),
        Some("CLOSE_ON_CLICK_OUTSIDE") | Some("DO_NOTHING")
    ) {
        return false;
    }
    match overlay.get("relativePosition") {
        None => {
            overlay
                .get("positionType")
                .and_then(serde_json::Value::as_str)
                == Some("CENTER")
        }
        Some(position) => position.as_object().is_some_and(|position| {
            position
                .get("x")
                .and_then(serde_json::Value::as_f64)
                .is_some_and(f64::is_finite)
                && position
                    .get("y")
                    .and_then(serde_json::Value::as_f64)
                    .is_some_and(f64::is_finite)
        }),
    }
}

fn prototype_node_id(value: &str) -> Option<NodeId> {
    let compact = value.replace('-', "");
    (compact.len() == 32)
        .then(|| u128::from_str_radix(&compact, 16).ok())
        .flatten()
        .map(NodeId)
}

fn clear_prototype_destination_value(value: &mut serde_json::Value, target: NodeId) -> bool {
    let Some(reactions) = value.as_array_mut() else {
        return false;
    };
    let mut changed = false;
    for reaction in reactions {
        let Some(actions) = reaction
            .get_mut("actions")
            .and_then(serde_json::Value::as_array_mut)
        else {
            continue;
        };
        for action in actions {
            let Some(action) = action.as_object_mut() else {
                continue;
            };
            if action.get("type").and_then(serde_json::Value::as_str) != Some("NODE") {
                continue;
            }
            let matches_target = action
                .get("destinationId")
                .and_then(serde_json::Value::as_str)
                .and_then(prototype_node_id)
                == Some(target);
            if matches_target {
                action.insert("destinationId".into(), serde_json::Value::Null);
                changed = true;
            }
        }
    }
    changed
}

fn valid_appearance(appearance: &Appearance) -> bool {
    appearance.fill.is_valid()
        && appearance.stroke.is_valid()
        && valid_paint_stack(&appearance.fills)
        && valid_paint_stack(&appearance.strokes)
        && appearance.stroke_width.is_finite()
        && appearance.stroke_width >= 0.0
        && appearance.stroke_miter_limit.is_finite()
        && appearance.stroke_miter_limit >= 1.0
        && valid_dash_pattern(&appearance.stroke_dash_pattern)
        && valid_stroke_weights(&appearance.stroke_weights)
        && appearance.arc_data.is_none_or(valid_arc_data)
        && appearance
            .parametric_shape
            .is_none_or(valid_parametric_shape_value)
        && valid_relative_transform(appearance.relative_transform)
        && appearance.drop_shadow.is_none_or(valid_drop_shadow)
        && valid_effect_stack(&appearance.effect_stack, appearance.drop_shadow)
        && appearance.opacity.is_finite()
        && (0.0..=1.0).contains(&appearance.opacity)
        && appearance.corner_radius.is_finite()
        && appearance.corner_radius >= 0.0
        && valid_corner_radii(&appearance.corner_radii)
        && appearance.corner_smoothing.is_finite()
        && (0.0..=1.0).contains(&appearance.corner_smoothing)
}

fn valid_drop_shadow(shadow: DropShadow) -> bool {
    shadow.offset_x.is_finite()
        && shadow.offset_y.is_finite()
        && (-10_000.0..=10_000.0).contains(&shadow.offset_x)
        && (-10_000.0..=10_000.0).contains(&shadow.offset_y)
        && shadow.blur_radius.is_finite()
        && (0.0..=1_024.0).contains(&shadow.blur_radius)
        && shadow.spread.is_finite()
        && (-10_000.0..=10_000.0).contains(&shadow.spread)
        && shadow.color.is_valid()
}

/// Bounded independently from derived rendering surfaces (ADR 0031).
const MAX_EFFECTS_PER_NODE: usize = 8;

fn effect_stack_bytes(effects: &[Effect]) -> usize {
    effects.len() * std::mem::size_of::<Effect>()
}

fn first_effect_drop_shadow(effects: &[Effect]) -> Option<DropShadow> {
    match effects.first() {
        Some(Effect::DropShadow(shadow)) => Some(*shadow),
        _ => None,
    }
}

fn valid_effect_stack(effects: &[Effect], legacy_shadow: Option<DropShadow>) -> bool {
    effects.len() <= MAX_EFFECTS_PER_NODE
        && effects.iter().all(|effect| match effect {
            Effect::DropShadow(shadow) => valid_drop_shadow(*shadow),
            Effect::LayerBlur(blur) => {
                blur.radius.is_finite() && (0.0..=256.0).contains(&blur.radius)
            }
            Effect::InnerShadow(shadow) => valid_drop_shadow(DropShadow {
                offset_x: shadow.offset_x,
                offset_y: shadow.offset_y,
                blur_radius: shadow.blur_radius,
                spread: shadow.spread,
                color: shadow.color,
                visible: shadow.visible,
            }),
            Effect::BackgroundBlur(blur) => {
                blur.radius.is_finite() && (0.0..=256.0).contains(&blur.radius)
            }
        })
        && (effects.is_empty() || first_effect_drop_shadow(effects) == legacy_shadow)
}

fn hash_constraints(hasher: &mut Sha256, constraints: Option<Constraints>) {
    let Some(constraints) = constraints else {
        return;
    };
    let encode = |value| match value {
        ConstraintType::Min => 0,
        ConstraintType::Center => 1,
        ConstraintType::Max => 2,
        ConstraintType::Stretch => 3,
        ConstraintType::Scale => 4,
    };
    // Legacy nodes do not write this marker and therefore retain their hashes.
    hasher.update([
        7,
        encode(constraints.horizontal),
        encode(constraints.vertical),
    ]);
}

const MAX_PAINT_LAYERS: usize = 16;

fn valid_paint_stack(paints: &[Paint]) -> bool {
    paints.len() <= MAX_PAINT_LAYERS && paints.iter().all(Paint::is_valid)
}

fn paint_stack_bytes(paints: &[Paint]) -> usize {
    paints.iter().map(Paint::estimated_bytes).sum()
}

fn valid_corner_radii(radii: &[f64]) -> bool {
    (radii.is_empty() || radii.len() == 4)
        && radii
            .iter()
            .all(|radius| radius.is_finite() && *radius >= 0.0)
}

const DEFAULT_STROKE_MITER_LIMIT: f64 = 10.0;
const MAX_STROKE_DASH_SEGMENTS: usize = 32;

fn valid_dash_pattern(pattern: &[f64]) -> bool {
    pattern.len() <= MAX_STROKE_DASH_SEGMENTS
        && pattern
            .iter()
            .all(|segment| segment.is_finite() && *segment >= 0.0)
        && (pattern.is_empty() || pattern.iter().any(|segment| *segment > 0.0))
}

/// Canvas and Figma repeat odd-length patterns to form a full on/off cycle.
/// Persisting the expanded result makes equivalent inputs hash identically.
fn canonical_dash_pattern(pattern: &[f64]) -> Vec<f64> {
    if pattern.len() % 2 == 0 {
        return pattern.to_vec();
    }
    pattern
        .iter()
        .copied()
        .chain(pattern.iter().copied())
        .collect()
}

fn valid_stroke_weights(weights: &[f64]) -> bool {
    (weights.is_empty() || weights.len() == 4)
        && weights
            .iter()
            .all(|weight| weight.is_finite() && *weight >= 0.0)
}

fn valid_arc_data(arc: ArcData) -> bool {
    arc.starting_angle.is_finite()
        && arc.ending_angle.is_finite()
        && arc.inner_radius.is_finite()
        && (0.0..=1.0).contains(&arc.inner_radius)
}

const MIN_PARAMETRIC_POINTS: u32 = 3;
const MAX_PARAMETRIC_POINTS: u32 = 100;

fn valid_parametric_shape_value(shape: ParametricShape) -> bool {
    match shape {
        ParametricShape::Polygon { point_count } => {
            (MIN_PARAMETRIC_POINTS..=MAX_PARAMETRIC_POINTS).contains(&point_count)
        }
        ParametricShape::Star {
            point_count,
            inner_ratio,
        } => {
            (MIN_PARAMETRIC_POINTS..=MAX_PARAMETRIC_POINTS).contains(&point_count)
                && inner_ratio.is_finite()
                && (0.05..=0.95).contains(&inner_ratio)
        }
    }
}

fn valid_parametric_shape(kind: &NodeKind, shape: Option<ParametricShape>) -> bool {
    match (kind, shape) {
        (NodeKind::Polygon, Some(ParametricShape::Polygon { .. }))
        | (NodeKind::Star, Some(ParametricShape::Star { .. })) => {
            shape.is_some_and(valid_parametric_shape_value)
        }
        (NodeKind::Polygon | NodeKind::Star, None) => false,
        (_, None) => true,
        _ => false,
    }
}

const MAX_VECTOR_SUBPATHS: usize = 64;
const MAX_VECTOR_POINTS: usize = 8_192;
const MAX_VECTOR_PATH_BYTES: usize = 1_024 * 1_024;

fn valid_vector_path(path: &VectorPath) -> bool {
    if path.subpaths.len() > MAX_VECTOR_SUBPATHS || path.estimated_bytes() > MAX_VECTOR_PATH_BYTES {
        return false;
    }
    let mut ids = BTreeSet::new();
    let mut total = 0usize;
    for subpath in &path.subpaths {
        if subpath.points.is_empty() || (subpath.closed && subpath.points.len() < 3) {
            return false;
        }
        if subpath
            .points
            .windows(2)
            .any(|pair| pair[0].position == pair[1].position)
            || (subpath.closed
                && subpath.points.len() > 1
                && subpath.points.first().is_some_and(|first| {
                    subpath
                        .points
                        .last()
                        .is_some_and(|last| first.position == last.position)
                }))
        {
            return false;
        }
        total = total.saturating_add(subpath.points.len());
        for point in &subpath.points {
            if !ids.insert(point.id)
                || ![point.position.x, point.position.y]
                    .into_iter()
                    .chain(
                        point
                            .handle_in
                            .into_iter()
                            .flat_map(|handle| [handle.x, handle.y]),
                    )
                    .chain(
                        point
                            .handle_out
                            .into_iter()
                            .flat_map(|handle| [handle.x, handle.y]),
                    )
                    .all(f64::is_finite)
            {
                return false;
            }
        }
    }
    total <= MAX_VECTOR_POINTS
}

fn valid_vector_path_for_kind(kind: &NodeKind, path: Option<&VectorPath>) -> bool {
    match (kind, path) {
        (NodeKind::Vector | NodeKind::Highlight | NodeKind::TextPath, Some(path)) => {
            valid_vector_path(path)
        }
        (NodeKind::Vector | NodeKind::Highlight | NodeKind::TextPath, None) => false,
        (_, None) => true,
        _ => false,
    }
}

fn valid_boolean_operation(kind: &NodeKind, operation: Option<BooleanOperation>) -> bool {
    match kind {
        NodeKind::BooleanOperation => operation.is_some(),
        _ => operation.is_none(),
    }
}

fn is_alpha_mask(node: &Node) -> bool {
    node.extensions
        .get(ALPHA_MASK_EXTENSION_KEY)
        .is_some_and(|value| value.as_slice() == [1])
}

fn hash_vector_path(hasher: &mut Sha256, path: &VectorPath) {
    hasher.update([match path.fill_rule {
        FillRule::NonZero => 0,
        FillRule::EvenOdd => 1,
    }]);
    hash_len(hasher, path.subpaths.len());
    for subpath in &path.subpaths {
        hasher.update([u8::from(subpath.closed)]);
        hash_len(hasher, subpath.points.len());
        for point in &subpath.points {
            hasher.update(point.id.0.to_be_bytes());
            hash_number(hasher, point.position.x);
            hash_number(hasher, point.position.y);
            for handle in [point.handle_in, point.handle_out] {
                match handle {
                    Some(handle) => {
                        hasher.update([1]);
                        hash_number(hasher, handle.x);
                        hash_number(hasher, handle.y);
                    }
                    None => hasher.update([0]),
                }
            }
            hasher.update([match point.point_type {
                VectorPointType::Corner => 0,
                VectorPointType::Mirrored => 1,
                VectorPointType::Asymmetric => 2,
            }]);
        }
    }
}

fn hash_parametric_shape(hasher: &mut Sha256, shape: ParametricShape) {
    match shape {
        ParametricShape::Polygon { point_count } => {
            hasher.update([0]);
            hasher.update(point_count.to_be_bytes());
        }
        ParametricShape::Star {
            point_count,
            inner_ratio,
        } => {
            hasher.update([1]);
            hasher.update(point_count.to_be_bytes());
            hash_number(hasher, inner_ratio);
        }
    }
}

fn valid_relative_transform(transform: Option<AffineTransform>) -> bool {
    transform.is_none_or(|matrix| {
        [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f]
            .iter()
            .all(|value| value.is_finite())
            && matrix.inverse().is_ok()
    })
}

fn hash_stroke_style(
    hasher: &mut Sha256,
    join: StrokeJoin,
    miter_limit: f64,
    dash_pattern: &[f64],
    stroke_weights: &[f64],
    stroke_align: StrokeAlign,
    arc_data: Option<ArcData>,
    relative_transform: Option<AffineTransform>,
) {
    // Preserve every historical hash while making non-default stroke metadata
    // part of the durable semantic state.
    if join != StrokeJoin::Miter
        || miter_limit != DEFAULT_STROKE_MITER_LIMIT
        || !dash_pattern.is_empty()
        || !stroke_weights.is_empty()
        || stroke_align != StrokeAlign::Inside
        || arc_data.is_some()
        || relative_transform.is_some()
    {
        hasher.update([match join {
            StrokeJoin::Miter => 0,
            StrokeJoin::Bevel => 1,
            StrokeJoin::Round => 2,
        }]);
        hash_number(hasher, miter_limit);
        hash_len(hasher, dash_pattern.len());
        for segment in dash_pattern {
            hash_number(hasher, *segment);
        }
        hash_len(hasher, stroke_weights.len());
        for weight in stroke_weights {
            hash_number(hasher, *weight);
        }
        hasher.update([match stroke_align {
            StrokeAlign::Center => 0,
            StrokeAlign::Inside => 1,
            StrokeAlign::Outside => 2,
        }]);
        if let Some(arc) = arc_data {
            hash_number(hasher, arc.starting_angle);
            hash_number(hasher, arc.ending_angle);
            hash_number(hasher, arc.inner_radius);
        }
        if let Some(transform) = relative_transform {
            for value in [
                transform.a,
                transform.b,
                transform.c,
                transform.d,
                transform.e,
                transform.f,
            ] {
                hash_number(hasher, value);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: u128) -> Node {
        Node {
            id: NodeId(id),
            parent_id: None,
            position: PositionId::for_node(NodeId(id)),
            name: "Card".into(),
            kind: NodeKind::Frame,
            x: 0.0,
            y: 0.0,
            width: 240.0,
            height: 160.0,
            rotation: 0.0,
            fill: "#fff".into(),
            stroke: "#00000000".into(),
            fills: Vec::new(),
            strokes: Vec::new(),
            stroke_width: 0.0,
            stroke_cap_start: Default::default(),
            stroke_cap_end: Default::default(),
            stroke_join: Default::default(),
            stroke_miter_limit: DEFAULT_STROKE_MITER_LIMIT,
            stroke_dash_pattern: Vec::new(),
            stroke_weights: Vec::new(),
            stroke_align: Default::default(),
            arc_data: None,
            parametric_shape: None,
            vector_path: None,
            boolean_operation: None,
            relative_transform: None,
            opacity: 1.0,
            blend_mode: BlendMode::Normal,
            drop_shadow: None,
            effect_stack: Vec::new(),
            corner_radius: 0.0,
            corner_radii: Vec::new(),
            corner_smoothing: 0.0,
            constraints: None,
            text: String::new(),
            visible: true,
            locked: false,
            contents_hidden: false,
            clips_content: false,
            extensions: BTreeMap::new(),
        }
    }

    fn transaction(base_revision: u64, commands: Vec<Command>) -> Transaction {
        Transaction {
            id: TransactionId(base_revision as u128 + 7),
            base_revision,
            commands,
        }
    }

    fn text_style_resource(id: &str) -> TextStyleResource {
        TextStyleResource {
            id: id.into(),
            key: String::new(),
            name: "Body".into(),
            description: "Body text".into(),
            description_markdown: String::new(),
            documentation_links: Vec::new(),
            remote: false,
            style: TextStyleRun {
                start: 0,
                end: 0,
                font: None,
                font_size: 16.0,
                font_weight: 400,
                italic: false,
                letter_spacing: 0.0,
                color: None,
                fill_stack: None,
                text_case: None,
                hyperlink: None,
                text_decoration: None,
                text_decoration_style: None,
                text_decoration_offset: None,
                text_decoration_thickness: None,
                text_decoration_color: None,
                text_decoration_skip_ink: None,
                leading_trim: None,
                open_type_features: Vec::new(),
                text_style_id: None,
                paint_style_id: None,
                variable_bindings: Default::default(),
            },
            letter_spacing_unit: None,
            variable_bindings: BTreeMap::new(),
            paragraph: TextProperties::default().paragraph,
        }
    }

    fn paint_style_resource(id: &str) -> PaintStyleResource {
        PaintStyleResource {
            id: id.into(),
            key: String::new(),
            name: "Brand fill".into(),
            description: "Primary surface".into(),
            description_markdown: String::new(),
            documentation_links: Vec::new(),
            remote: false,
            paints: PaintStack::default(),
            variable_bindings: Vec::new(),
        }
    }

    fn assert_children_index_matches_nodes(document: &Document) {
        let mut expected =
            BTreeMap::<(PageId, Option<NodeId>), BTreeSet<(PositionId, NodeId)>>::new();
        for node in document.nodes.values() {
            let page_id = document
                .node_pages
                .get(&node.id)
                .copied()
                .unwrap_or(DEFAULT_PAGE_ID);
            expected
                .entry((page_id, node.parent_id))
                .or_default()
                .insert((node.position, node.id));
        }
        let actual = document
            .children_by_parent
            .iter()
            .map(|(key, bucket)| (*key, bucket.iter().copied().collect::<BTreeSet<_>>()))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(actual, expected);
    }

    #[test]
    fn document_identity_can_only_be_seeded_before_hydration() {
        let mut document = Document::empty();
        assert!(document.seed_document_id(DocumentId(41)));
        assert_eq!(document.id(), DocumentId(41));

        document.seed_node(node(1)).unwrap();
        assert!(!document.seed_document_id(DocumentId(42)));
        assert_eq!(document.id(), DocumentId(41));
    }

    #[test]
    fn child_bucket_promotes_and_demotes_without_changing_order() {
        let mut bucket = ChildBucket::default();
        for id in (1..=9u128).rev() {
            assert!(bucket.insert((PositionId::for_node(NodeId(id)), NodeId(id))));
        }
        assert!(matches!(bucket, ChildBucket::Tree(_)));
        assert_eq!(
            bucket.iter().map(|(_, id)| id.0).collect::<Vec<_>>(),
            (1..=9).collect::<Vec<_>>()
        );
        assert!(bucket.remove(&(PositionId::for_node(NodeId(5)), NodeId(5))));
        assert!(matches!(bucket, ChildBucket::Small(_)));
        assert_eq!(
            bucket.iter().map(|(_, id)| id.0).collect::<Vec<_>>(),
            vec![1, 2, 3, 4, 6, 7, 8, 9]
        );
        assert!(!bucket.insert((PositionId::for_node(NodeId(4)), NodeId(4))));
    }

    #[test]
    fn transaction_is_atomic() {
        let mut document = Document::empty();
        let result = document.submit(
            transaction(
                0,
                vec![Command::Create(node(1)), Command::Delete { id: NodeId(2) }],
            ),
            Origin::LocalUser,
        );
        assert_eq!(result, Err(CommandError::MissingNode { id: NodeId(2) }));
        assert_eq!(document.nodes().count(), 0);
        assert_eq!(document.revision, 0);
    }

    #[test]
    fn persistent_candidate_copies_only_the_touched_node_payload() {
        let mut document = Document::empty();
        document.seed_node(node(1)).unwrap();
        document.seed_node(node(2)).unwrap();
        let confirmed = document.clone();

        assert!(Arc::ptr_eq(
            &confirmed.nodes.get(&NodeId(1)).unwrap().0,
            &document.nodes.get(&NodeId(1)).unwrap().0,
        ));
        assert!(Arc::ptr_eq(
            &confirmed.nodes.get(&NodeId(2)).unwrap().0,
            &document.nodes.get(&NodeId(2)).unwrap().0,
        ));

        document
            .submit(
                transaction(
                    0,
                    vec![Command::Rename {
                        id: NodeId(1),
                        name: "renamed".into(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();

        assert_eq!(confirmed.node(NodeId(1)).unwrap().name, "Card");
        assert_eq!(document.node(NodeId(1)).unwrap().name, "renamed");
        assert!(!Arc::ptr_eq(
            &confirmed.nodes.get(&NodeId(1)).unwrap().0,
            &document.nodes.get(&NodeId(1)).unwrap().0,
        ));
        assert!(Arc::ptr_eq(
            &confirmed.nodes.get(&NodeId(2)).unwrap().0,
            &document.nodes.get(&NodeId(2)).unwrap().0,
        ));

        let accepted = document.clone();
        let failed = document.submit(
            transaction(
                1,
                vec![
                    Command::Rename {
                        id: NodeId(1),
                        name: "must roll back".into(),
                    },
                    Command::Rename {
                        id: NodeId(99),
                        name: "missing".into(),
                    },
                ],
            ),
            Origin::LocalUser,
        );
        assert_eq!(failed, Err(CommandError::MissingNode { id: NodeId(99) }));
        assert_eq!(document, accepted);
    }

    #[test]
    fn prototype_extensions_are_hashed_and_undoable_without_losing_unknown_fields() {
        let mut document = Document::empty();
        document
            .submit(
                transaction(0, vec![Command::Create(node(1))]),
                Origin::LocalUser,
            )
            .unwrap();
        let before_hash = document.canonical_hash_hex();
        let extensions = BTreeMap::from([
            (
                "makefigma.prototype.reactions.v1".into(),
                br#"[{"trigger":{"type":"ON_CLICK"},"actions":[{"type":"BACK"}]}]"#.to_vec(),
            ),
            ("future.imported.value".into(), vec![0, 255, 1]),
        ]);
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetNodeExtensions {
                        id: NodeId(1),
                        extensions: extensions.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(document.node(NodeId(1)).unwrap().extensions, extensions);
        assert_ne!(document.canonical_hash_hex(), before_hash);
        document.undo().unwrap();
        assert!(document.node(NodeId(1)).unwrap().extensions.is_empty());
        document.redo().unwrap();
        assert_eq!(document.node(NodeId(1)).unwrap().extensions, extensions);
    }

    #[test]
    fn deleting_a_prototype_destination_nulls_the_reference_and_undo_restores_it() {
        let mut document = Document::empty();
        document
            .submit(
                transaction(0, vec![Command::Create(node(1)), Command::Create(node(2))]),
                Origin::LocalUser,
            )
            .unwrap();
        let target = "00000000-0000-0000-0000-000000000002";
        let extensions = BTreeMap::from([(
            PROTOTYPE_REACTIONS_EXTENSION_KEY.into(),
            format!(r#"[{{"trigger":{{"type":"ON_CLICK"}},"actions":[{{"type":"NODE","navigation":"NAVIGATE","destinationId":"{target}"}}]}}]"#).into_bytes(),
        )]);
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetNodeExtensions {
                        id: NodeId(1),
                        extensions,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        document
            .submit(
                transaction(2, vec![Command::Delete { id: NodeId(2) }]),
                Origin::LocalUser,
            )
            .unwrap();
        let cleared: serde_json::Value = serde_json::from_slice(
            &document.node(NodeId(1)).unwrap().extensions[PROTOTYPE_REACTIONS_EXTENSION_KEY],
        )
        .unwrap();
        assert!(cleared[0]["actions"][0]["destinationId"].is_null());
        document.undo().unwrap();
        let restored: serde_json::Value = serde_json::from_slice(
            &document.node(NodeId(1)).unwrap().extensions[PROTOTYPE_REACTIONS_EXTENSION_KEY],
        )
        .unwrap();
        assert_eq!(restored[0]["actions"][0]["destinationId"], target);
        assert!(document.node(NodeId(2)).is_some());
    }

    #[test]
    fn auto_layout_fixed_horizontal_positions_children_and_undoes_exactly() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.x = 10.0;
        frame.y = 20.0;
        frame.width = 200.0;
        frame.height = 100.0;
        let mut first = node(2);
        first.kind = NodeKind::Rectangle;
        first.parent_id = Some(frame.id);
        first.width = 30.0;
        first.height = 20.0;
        let mut second = node(3);
        second.kind = NodeKind::Rectangle;
        second.parent_id = Some(frame.id);
        second.width = 40.0;
        second.height = 20.0;
        let layout = AutoLayout {
            mode: LayoutMode::Horizontal,
            padding: [10.0, 20.0, 30.0, 40.0],
            item_spacing: 8.0,
            counter_alignment: LayoutAlignment::Center,
            ..AutoLayout::default()
        };
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame.clone()),
                        Command::Create(first.clone()),
                        Command::Create(second.clone()),
                        Command::SetAutoLayout {
                            id: frame.id,
                            layout,
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document.node(first.id).map(|node| (node.x, node.y)),
            Some((50.0, 50.0))
        );
        assert_eq!(
            document.node(second.id).map(|node| (node.x, node.y)),
            Some((88.0, 50.0))
        );
        let hash = document.canonical_hash();
        document.undo().unwrap();
        assert!(document.node(first.id).is_none());
        document.redo().unwrap();
        assert_eq!(document.canonical_hash(), hash);
        assert_eq!(
            document.node(second.id).map(|node| (node.x, node.y)),
            Some((88.0, 50.0))
        );
    }

    #[test]
    fn grid_auto_layout_resolves_fixed_and_flex_tracks_in_row_major_order() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.x = 10.0;
        frame.y = 20.0;
        frame.width = 300.0;
        frame.height = 200.0;
        let mut first = node(2);
        first.parent_id = Some(frame.id);
        first.width = 40.0;
        first.height = 20.0;
        let mut second = node(3);
        second.parent_id = Some(frame.id);
        second.width = 1.0;
        second.height = 1.0;
        let mut third = node(4);
        third.parent_id = Some(frame.id);
        third.width = 30.0;
        third.height = 30.0;
        let grid = AutoLayout {
            mode: LayoutMode::Grid,
            padding: [10.0, 10.0, 10.0, 10.0],
            grid_rows: vec![GridTrack::Fixed(50.0), GridTrack::Flex(1.0)],
            grid_columns: vec![GridTrack::Fixed(80.0), GridTrack::Flex(1.0)],
            grid_row_gap: Some(10.0),
            grid_column_gap: Some(20.0),
            ..AutoLayout::default()
        };
        let fill_cell = AutoLayout {
            primary_sizing: LayoutSizing::Fill,
            counter_sizing: LayoutSizing::Fill,
            ..AutoLayout::default()
        };
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame.clone()),
                        Command::Create(first.clone()),
                        Command::Create(second.clone()),
                        Command::Create(third.clone()),
                        Command::SetAutoLayout {
                            id: second.id,
                            layout: fill_cell,
                        },
                        Command::SetAutoLayout {
                            id: frame.id,
                            layout: grid.clone(),
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document
                .node(first.id)
                .map(|node| (node.x, node.y, node.width, node.height)),
            Some((20.0, 30.0, 40.0, 20.0))
        );
        assert_eq!(
            document
                .node(second.id)
                .map(|node| (node.x, node.y, node.width, node.height)),
            Some((120.0, 30.0, 180.0, 50.0))
        );
        assert_eq!(
            document
                .node(third.id)
                .map(|node| (node.x, node.y, node.width, node.height)),
            Some((20.0, 90.0, 30.0, 30.0))
        );
        assert_eq!(document.auto_layout_for_node(frame.id), grid);
        let hash = document.canonical_hash();
        document.undo().unwrap();
        document.redo().unwrap();
        assert_eq!(document.canonical_hash(), hash);
        assert_eq!(document.node(second.id).map(|node| node.width), Some(180.0));
    }

    #[test]
    fn grid_hug_tracks_measure_fixed_children_and_reject_fill_cycles() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.x = 10.0;
        frame.y = 20.0;
        frame.width = 300.0;
        frame.height = 200.0;
        let mut first = node(2);
        first.parent_id = Some(frame.id);
        first.width = 40.0;
        first.height = 20.0;
        let mut second = node(3);
        second.parent_id = Some(frame.id);
        second.width = 60.0;
        second.height = 30.0;
        let mut third = node(4);
        third.parent_id = Some(frame.id);
        third.width = 50.0;
        third.height = 70.0;
        let grid = AutoLayout {
            mode: LayoutMode::Grid,
            padding: [10.0, 10.0, 10.0, 10.0],
            grid_rows: vec![GridTrack::Hug, GridTrack::Flex(1.0)],
            grid_columns: vec![GridTrack::Hug, GridTrack::Flex(1.0)],
            grid_row_gap: Some(10.0),
            grid_column_gap: Some(10.0),
            ..AutoLayout::default()
        };
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame.clone()),
                        Command::Create(first.clone()),
                        Command::Create(second.clone()),
                        Command::Create(third.clone()),
                        Command::SetAutoLayout {
                            id: frame.id,
                            layout: grid,
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document
                .node(second.id)
                .map(|node| (node.x, node.y, node.width, node.height)),
            Some((80.0, 30.0, 60.0, 30.0))
        );
        assert_eq!(
            document
                .node(third.id)
                .map(|node| (node.x, node.y, node.width, node.height)),
            Some((20.0, 70.0, 50.0, 70.0))
        );

        let hash = document.canonical_hash();
        let fill_hug_track = AutoLayout {
            primary_sizing: LayoutSizing::Fill,
            ..AutoLayout::default()
        };
        assert_eq!(
            document.submit(
                transaction(
                    document.revision,
                    vec![Command::SetAutoLayout {
                        id: first.id,
                        layout: fill_hug_track,
                    }],
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::AutoLayoutUnsupported)
        );
        assert_eq!(document.canonical_hash(), hash);
    }

    #[test]
    fn grid_container_hug_derives_physical_size_and_rejects_flex_cycles() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 500.0;
        frame.height = 500.0;
        let mut first = node(2);
        first.parent_id = Some(frame.id);
        first.width = 40.0;
        first.height = 20.0;
        let mut second = node(3);
        second.parent_id = Some(frame.id);
        second.width = 60.0;
        second.height = 30.0;
        let grid = AutoLayout {
            mode: LayoutMode::Grid,
            padding: [10.0, 20.0, 30.0, 40.0],
            primary_sizing: LayoutSizing::Hug,
            counter_sizing: LayoutSizing::Hug,
            grid_rows: vec![GridTrack::Hug],
            grid_columns: vec![GridTrack::Fixed(80.0), GridTrack::Hug],
            grid_column_gap: Some(10.0),
            ..AutoLayout::default()
        };
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame.clone()),
                        Command::Create(first.clone()),
                        Command::Create(second.clone()),
                        Command::SetAutoLayout {
                            id: frame.id,
                            layout: grid,
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();

        assert_eq!(
            document
                .node(frame.id)
                .map(|node| (node.width, node.height)),
            Some((210.0, 70.0))
        );
        assert_eq!(
            document.node(second.id).map(|node| (node.x, node.y)),
            Some((130.0, 10.0))
        );

        let hash = document.canonical_hash();
        let flex_cycle = AutoLayout {
            mode: LayoutMode::Grid,
            primary_sizing: LayoutSizing::Hug,
            grid_rows: vec![GridTrack::Fixed(40.0)],
            grid_columns: vec![GridTrack::Flex(1.0)],
            ..AutoLayout::default()
        };
        assert_eq!(
            document.submit(
                transaction(
                    document.revision,
                    vec![Command::SetAutoLayout {
                        id: frame.id,
                        layout: flex_cycle,
                    }],
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidAutoLayout)
        );
        assert_eq!(document.canonical_hash(), hash);
    }

    #[test]
    fn grid_row_auto_flow_places_spanning_children_and_rejects_overspan_atomically() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 260.0;
        frame.height = 170.0;
        let mut first = node(2);
        first.parent_id = Some(frame.id);
        let mut second = node(3);
        second.parent_id = Some(frame.id);
        second.width = 20.0;
        second.height = 20.0;
        let mut third = node(4);
        third.parent_id = Some(frame.id);
        let grid = AutoLayout {
            mode: LayoutMode::Grid,
            grid_rows: vec![
                GridTrack::Fixed(50.0),
                GridTrack::Fixed(50.0),
                GridTrack::Fixed(50.0),
            ],
            grid_columns: vec![
                GridTrack::Fixed(80.0),
                GridTrack::Fixed(80.0),
                GridTrack::Fixed(80.0),
            ],
            grid_row_gap: Some(10.0),
            grid_column_gap: Some(10.0),
            ..AutoLayout::default()
        };
        let fill_two_by_two = AutoLayout {
            primary_sizing: LayoutSizing::Fill,
            counter_sizing: LayoutSizing::Fill,
            grid_row_span: Some(2),
            grid_column_span: Some(2),
            ..AutoLayout::default()
        };
        let fill_two_columns = AutoLayout {
            primary_sizing: LayoutSizing::Fill,
            counter_sizing: LayoutSizing::Fill,
            grid_column_span: Some(2),
            ..AutoLayout::default()
        };
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame.clone()),
                        Command::Create(first.clone()),
                        Command::Create(second.clone()),
                        Command::Create(third.clone()),
                        Command::SetAutoLayout {
                            id: first.id,
                            layout: fill_two_by_two,
                        },
                        Command::SetAutoLayout {
                            id: third.id,
                            layout: fill_two_columns,
                        },
                        Command::SetAutoLayout {
                            id: frame.id,
                            layout: grid,
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document
                .node(first.id)
                .map(|node| (node.x, node.y, node.width, node.height)),
            Some((0.0, 0.0, 170.0, 110.0))
        );
        assert_eq!(
            document.node(second.id).map(|node| (node.x, node.y)),
            Some((180.0, 0.0))
        );
        assert_eq!(
            document
                .node(third.id)
                .map(|node| (node.x, node.y, node.width, node.height)),
            Some((0.0, 120.0, 170.0, 50.0))
        );

        let hash = document.canonical_hash();
        let overspan = AutoLayout {
            grid_row_span: Some(4),
            ..document.auto_layout_for_node(second.id)
        };
        assert_eq!(
            document.submit(
                transaction(
                    document.revision,
                    vec![Command::SetAutoLayout {
                        id: second.id,
                        layout: overspan,
                    }],
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::AutoLayoutUnsupported)
        );
        assert_eq!(document.canonical_hash(), hash);
    }

    #[test]
    fn grid_auto_rows_derives_effective_tracks_without_mutating_canonical_layout() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 200.0;
        frame.height = 300.0;
        let mut commands = vec![Command::Create(frame.clone())];
        for id in 2..=6 {
            let mut child = node(id);
            child.parent_id = Some(frame.id);
            child.width = 20.0;
            child.height = 20.0;
            commands.push(Command::Create(child));
        }
        let grid = AutoLayout {
            mode: LayoutMode::Grid,
            grid_rows: vec![GridTrack::Flex(1.0)],
            grid_columns: vec![GridTrack::Flex(1.0), GridTrack::Flex(1.0)],
            grid_auto_tracks: GridAutoTracks::Rows,
            ..AutoLayout::default()
        };
        commands.push(Command::SetAutoLayout {
            id: frame.id,
            layout: grid.clone(),
        });
        document
            .submit(transaction(0, commands), Origin::LocalUser)
            .unwrap();

        assert_eq!(
            document.node(NodeId(2)).map(|node| (node.x, node.y)),
            Some((0.0, 0.0))
        );
        assert_eq!(
            document.node(NodeId(4)).map(|node| (node.x, node.y)),
            Some((0.0, 100.0))
        );
        assert_eq!(
            document.node(NodeId(6)).map(|node| (node.x, node.y)),
            Some((0.0, 200.0))
        );
        assert_eq!(document.auto_layout_for_node(frame.id), grid);
        let hash = document.canonical_hash();
        document
            .submit(
                transaction(document.revision, vec![Command::Delete { id: NodeId(6) }]),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(document.node(NodeId(4)).map(|node| node.y), Some(150.0));
        document.undo().unwrap();
        assert_eq!(document.canonical_hash(), hash);
        assert_eq!(document.node(NodeId(4)).map(|node| node.y), Some(100.0));
        assert_eq!(document.auto_layout_for_node(frame.id).grid_rows.len(), 1);
    }

    #[test]
    fn grid_child_alignment_offsets_fixed_children_within_spanning_cells() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 210.0;
        frame.height = 210.0;
        let mut child = node(2);
        child.parent_id = Some(frame.id);
        child.width = 20.0;
        child.height = 40.0;
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame.clone()),
                        Command::Create(child.clone()),
                        Command::SetAutoLayout {
                            id: child.id,
                            layout: AutoLayout {
                                grid_column_span: Some(2),
                                grid_child_horizontal_align: GridChildAlignment::Center,
                                grid_child_vertical_align: GridChildAlignment::Max,
                                ..AutoLayout::default()
                            },
                        },
                        Command::SetAutoLayout {
                            id: frame.id,
                            layout: AutoLayout {
                                mode: LayoutMode::Grid,
                                grid_rows: vec![GridTrack::Fixed(100.0), GridTrack::Fixed(100.0)],
                                grid_columns: vec![
                                    GridTrack::Fixed(100.0),
                                    GridTrack::Fixed(100.0),
                                ],
                                grid_row_gap: Some(10.0),
                                grid_column_gap: Some(10.0),
                                ..AutoLayout::default()
                            },
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document.node(child.id).map(|node| (node.x, node.y)),
            Some((95.0, 60.0))
        );
        let hash = document.canonical_hash();
        document.undo().unwrap();
        document.redo().unwrap();
        assert_eq!(document.canonical_hash(), hash);
    }

    #[test]
    fn grid_manual_placement_uses_persisted_anchors_and_rejects_collisions_atomically() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 260.0;
        frame.height = 170.0;
        let mut first = node(2);
        first.parent_id = Some(frame.id);
        let mut second = node(3);
        second.parent_id = Some(frame.id);
        let tracks = AutoLayout {
            mode: LayoutMode::Grid,
            grid_rows: vec![GridTrack::Fixed(50.0); 3],
            grid_columns: vec![GridTrack::Fixed(80.0); 3],
            grid_row_gap: Some(10.0),
            grid_column_gap: Some(10.0),
            grid_items_positioning: GridItemsPositioning::Manual,
            ..AutoLayout::default()
        };
        let first_layout = AutoLayout {
            primary_sizing: LayoutSizing::Fill,
            counter_sizing: LayoutSizing::Fill,
            grid_row_span: Some(2),
            grid_column_span: Some(2),
            grid_row_anchor: Some(1),
            grid_column_anchor: Some(1),
            ..AutoLayout::default()
        };
        let second_layout = AutoLayout {
            grid_row_anchor: Some(0),
            grid_column_anchor: Some(0),
            ..AutoLayout::default()
        };
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame.clone()),
                        Command::Create(first.clone()),
                        Command::Create(second.clone()),
                        Command::SetAutoLayout {
                            id: first.id,
                            layout: first_layout,
                        },
                        Command::SetAutoLayout {
                            id: second.id,
                            layout: second_layout,
                        },
                        Command::SetAutoLayout {
                            id: frame.id,
                            layout: tracks,
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document.node(second.id).map(|node| (node.x, node.y)),
            Some((0.0, 0.0))
        );
        assert_eq!(
            document
                .node(first.id)
                .map(|node| (node.x, node.y, node.width, node.height)),
            Some((90.0, 60.0, 170.0, 110.0))
        );
        document
            .submit(
                transaction(
                    document.revision,
                    vec![Command::SetNodePosition {
                        id: first.id,
                        position: PositionId {
                            key: 4,
                            actor: ActorId(0),
                        },
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document.node(second.id).map(|node| (node.x, node.y)),
            Some((0.0, 0.0))
        );
        assert_eq!(
            document.node(first.id).map(|node| (node.x, node.y)),
            Some((90.0, 60.0))
        );

        let hash = document.canonical_hash();
        let collision = AutoLayout {
            grid_row_anchor: Some(1),
            grid_column_anchor: Some(1),
            ..document.auto_layout_for_node(second.id)
        };
        assert_eq!(
            document.submit(
                transaction(
                    document.revision,
                    vec![Command::SetAutoLayout {
                        id: second.id,
                        layout: collision
                    }],
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::AutoLayoutUnsupported)
        );
        assert_eq!(document.canonical_hash(), hash);
    }

    #[test]
    fn grid_spanning_child_contributes_to_hug_tracks_without_flex() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 110.0;
        frame.height = 50.0;
        let mut spanning = node(2);
        spanning.parent_id = Some(frame.id);
        spanning.width = 110.0;
        spanning.height = 20.0;
        let mut left = node(3);
        left.parent_id = Some(frame.id);
        left.width = 10.0;
        left.height = 10.0;
        let mut right = node(4);
        right.parent_id = Some(frame.id);
        right.width = 10.0;
        right.height = 10.0;
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame.clone()),
                        Command::Create(spanning.clone()),
                        Command::Create(left.clone()),
                        Command::Create(right.clone()),
                        Command::SetAutoLayout {
                            id: spanning.id,
                            layout: AutoLayout {
                                grid_column_span: Some(2),
                                ..AutoLayout::default()
                            },
                        },
                        Command::SetAutoLayout {
                            id: frame.id,
                            layout: AutoLayout {
                                mode: LayoutMode::Grid,
                                grid_rows: vec![GridTrack::Fixed(20.0), GridTrack::Fixed(20.0)],
                                grid_columns: vec![GridTrack::Hug, GridTrack::Hug],
                                grid_row_gap: Some(10.0),
                                grid_column_gap: Some(10.0),
                                ..AutoLayout::default()
                            },
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();

        assert_eq!(
            document.node(left.id).map(|node| (node.x, node.y)),
            Some((0.0, 30.0))
        );
        assert_eq!(
            document.node(right.id).map(|node| (node.x, node.y)),
            Some((60.0, 30.0))
        );
    }

    #[test]
    fn auto_layout_node_budget_counts_unique_nodes_across_convergence_iterations() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.kind = NodeKind::Frame;
        frame.width = 70_000.0;
        frame.height = 100.0;
        document.seed_node(frame.clone()).unwrap();
        for id in 2..=6_001u128 {
            let mut child = node(id);
            child.parent_id = Some(frame.id);
            child.width = 10.0;
            child.height = 10.0;
            document.seed_node(child).unwrap();
        }
        document
            .seed_auto_layout(
                frame.id,
                AutoLayout {
                    mode: LayoutMode::Horizontal,
                    ..AutoLayout::default()
                },
            )
            .unwrap();

        let applied = document
            .submit(
                transaction(
                    0,
                    vec![Command::UpdateGeometry {
                        id: frame.id,
                        x: frame.x,
                        y: frame.y,
                        width: 70_001.0,
                        height: frame.height,
                        rotation: frame.rotation,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();

        assert_eq!(applied.history_item.changes.len(), 6_000);
        assert_eq!(document.node(NodeId(6_001)).unwrap().x, 59_990.0);
    }

    #[test]
    fn auto_layout_child_align_self_overrides_the_frame_counter_axis() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 200.0;
        frame.height = 100.0;
        let mut child = node(2);
        child.kind = NodeKind::Rectangle;
        child.parent_id = Some(frame.id);
        child.width = 30.0;
        child.height = 20.0;
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame.clone()),
                        Command::Create(child.clone()),
                        Command::SetAutoLayout {
                            id: frame.id,
                            layout: AutoLayout {
                                mode: LayoutMode::Horizontal,
                                counter_alignment: LayoutAlignment::Center,
                                ..AutoLayout::default()
                            },
                        },
                        Command::SetAutoLayout {
                            id: child.id,
                            layout: AutoLayout {
                                align_self: Some(LayoutAlignment::End),
                                ..AutoLayout::default()
                            },
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document.node(child.id).map(|node| (node.x, node.y)),
            Some((0.0, 80.0))
        );
        let hash = document.canonical_hash();
        document.undo().unwrap();
        document.redo().unwrap();
        assert_eq!(document.canonical_hash(), hash);
    }

    #[test]
    fn auto_layout_horizontal_baseline_aligns_text_and_non_text_flow_children() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 200.0;
        frame.height = 60.0;
        let mut text = node(2);
        text.kind = NodeKind::Text;
        text.parent_id = Some(frame.id);
        text.text = "Text".into();
        text.width = 50.0;
        text.height = 20.0;
        let mut rectangle = node(3);
        rectangle.kind = NodeKind::Rectangle;
        rectangle.parent_id = Some(frame.id);
        rectangle.width = 30.0;
        rectangle.height = 30.0;
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame.clone()),
                        Command::Create(text.clone()),
                        Command::Create(rectangle.clone()),
                        Command::SetAutoLayout {
                            id: frame.id,
                            layout: AutoLayout {
                                mode: LayoutMode::Horizontal,
                                counter_alignment: LayoutAlignment::Baseline,
                                ..AutoLayout::default()
                            },
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();

        // The default 31px nominal font is centered in the 20px Core line
        // box, yielding a 19.3px alphabetic baseline. The Rectangle's lower
        // edge is at 30px, so the Text shifts by 10.7px.
        assert_eq!(
            document.node(text.id).map(|node| (node.x, node.y)),
            Some((0.0, 10.7))
        );
        assert_eq!(
            document.node(rectangle.id).map(|node| (node.x, node.y)),
            Some((50.0, 0.0))
        );
    }

    #[test]
    fn auto_layout_baseline_is_rejected_outside_horizontal_frame_counter_axis() {
        let mut document = Document::empty();
        let frame = node(1);
        let result = document.submit(
            transaction(
                0,
                vec![
                    Command::Create(frame.clone()),
                    Command::SetAutoLayout {
                        id: frame.id,
                        layout: AutoLayout {
                            mode: LayoutMode::Vertical,
                            counter_alignment: LayoutAlignment::Baseline,
                            ..AutoLayout::default()
                        },
                    },
                ],
            ),
            Origin::LocalUser,
        );
        assert_eq!(result, Err(CommandError::InvalidAutoLayout));
    }

    #[test]
    fn auto_layout_rejects_space_between_on_the_counter_axis() {
        let mut document = Document::empty();
        let frame = node(1);
        let result = document.submit(
            transaction(
                0,
                vec![
                    Command::Create(frame.clone()),
                    Command::SetAutoLayout {
                        id: frame.id,
                        layout: AutoLayout {
                            mode: LayoutMode::Horizontal,
                            counter_alignment: LayoutAlignment::SpaceBetween,
                            ..AutoLayout::default()
                        },
                    },
                ],
            ),
            Origin::LocalUser,
        );
        assert_eq!(result, Err(CommandError::InvalidAutoLayout));
    }

    #[test]
    fn auto_layout_wrap_aligns_baselines_per_horizontal_track() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 80.0;
        frame.height = 100.0;
        let mut text = node(2);
        text.kind = NodeKind::Text;
        text.parent_id = Some(frame.id);
        text.text = "Text".into();
        text.width = 40.0;
        text.height = 20.0;
        let mut first_rectangle = node(3);
        first_rectangle.kind = NodeKind::Rectangle;
        first_rectangle.parent_id = Some(frame.id);
        first_rectangle.width = 30.0;
        first_rectangle.height = 30.0;
        let mut second_rectangle = node(4);
        second_rectangle.kind = NodeKind::Rectangle;
        second_rectangle.parent_id = Some(frame.id);
        second_rectangle.width = 50.0;
        second_rectangle.height = 20.0;
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame.clone()),
                        Command::Create(text.clone()),
                        Command::Create(first_rectangle.clone()),
                        Command::Create(second_rectangle.clone()),
                        Command::SetAutoLayout {
                            id: frame.id,
                            layout: AutoLayout {
                                mode: LayoutMode::Horizontal,
                                wrap: true,
                                item_spacing: 5.0,
                                track_spacing: Some(7.0),
                                counter_alignment: LayoutAlignment::Baseline,
                                ..AutoLayout::default()
                            },
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();

        // The first track aligns Text's 19.3px CSS fallback baseline with the
        // first Rectangle's 30px lower edge. The wrapped track starts only
        // after that 30px track with its explicit 7px track gap, rather than
        // inheriting the main-axis 5px gap or the first baseline offset.
        assert_eq!(
            document.node(text.id).map(|node| (node.x, node.y)),
            Some((0.0, 10.7))
        );
        assert_eq!(
            document
                .node(first_rectangle.id)
                .map(|node| (node.x, node.y)),
            Some((45.0, 0.0))
        );
        assert_eq!(
            document
                .node(second_rectangle.id)
                .map(|node| (node.x, node.y)),
            Some((0.0, 37.0))
        );
    }

    #[test]
    fn auto_layout_wrap_space_between_distributes_remaining_counter_axis_space() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 80.0;
        frame.height = 100.0;
        let mut first = node(2);
        first.kind = NodeKind::Rectangle;
        first.parent_id = Some(frame.id);
        first.width = 30.0;
        first.height = 30.0;
        let mut second = node(3);
        second.kind = NodeKind::Rectangle;
        second.parent_id = Some(frame.id);
        second.width = 30.0;
        second.height = 20.0;
        let mut third = node(4);
        third.kind = NodeKind::Rectangle;
        third.parent_id = Some(frame.id);
        third.width = 50.0;
        third.height = 20.0;
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame.clone()),
                        Command::Create(first.clone()),
                        Command::Create(second.clone()),
                        Command::Create(third.clone()),
                        Command::SetAutoLayout {
                            id: frame.id,
                            layout: AutoLayout {
                                mode: LayoutMode::Horizontal,
                                wrap: true,
                                track_alignment: WrapTrackAlignment::SpaceBetween,
                                ..AutoLayout::default()
                            },
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();

        // Tracks are 30px and 20px high. The remaining 50px is placed between
        // the two tracks, so the second row starts at y=80 rather than y=30.
        assert_eq!(
            document.node(first.id).map(|node| (node.x, node.y)),
            Some((0.0, 0.0))
        );
        assert_eq!(
            document.node(second.id).map(|node| (node.x, node.y)),
            Some((30.0, 0.0))
        );
        assert_eq!(
            document.node(third.id).map(|node| (node.x, node.y)),
            Some((0.0, 80.0))
        );
    }

    #[test]
    fn auto_layout_rejects_wrap_track_space_between_without_wrap() {
        let mut document = Document::empty();
        let frame = node(1);
        let result = document.submit(
            transaction(
                0,
                vec![
                    Command::Create(frame.clone()),
                    Command::SetAutoLayout {
                        id: frame.id,
                        layout: AutoLayout {
                            mode: LayoutMode::Horizontal,
                            track_alignment: WrapTrackAlignment::SpaceBetween,
                            ..AutoLayout::default()
                        },
                    },
                ],
            ),
            Origin::LocalUser,
        );
        assert_eq!(result, Err(CommandError::InvalidAutoLayout));
    }

    #[test]
    fn auto_layout_fill_distributes_remaining_primary_space_and_stretches_counter_axis() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 200.0;
        frame.height = 100.0;
        let mut fixed = node(2);
        fixed.kind = NodeKind::Rectangle;
        fixed.parent_id = Some(frame.id);
        fixed.width = 30.0;
        fixed.height = 20.0;
        let mut fill = node(3);
        fill.kind = NodeKind::Rectangle;
        fill.parent_id = Some(frame.id);
        fill.width = 1.0;
        fill.height = 1.0;
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame.clone()),
                        Command::Create(fixed.clone()),
                        Command::Create(fill.clone()),
                        Command::SetAutoLayout {
                            id: frame.id,
                            layout: AutoLayout {
                                mode: LayoutMode::Horizontal,
                                item_spacing: 10.0,
                                ..AutoLayout::default()
                            },
                        },
                        Command::SetAutoLayout {
                            id: fill.id,
                            layout: AutoLayout {
                                primary_sizing: LayoutSizing::Fill,
                                counter_sizing: LayoutSizing::Fill,
                                ..AutoLayout::default()
                            },
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document
                .node(fixed.id)
                .map(|node| (node.x, node.y, node.width, node.height)),
            Some((0.0, 0.0, 30.0, 20.0))
        );
        assert_eq!(
            document
                .node(fill.id)
                .map(|node| (node.x, node.y, node.width, node.height)),
            Some((40.0, 0.0, 160.0, 100.0))
        );
    }

    #[test]
    fn auto_layout_allows_fixed_children_to_overflow_without_a_fill_constraint() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 100.0;
        frame.height = 40.0;
        let mut first = node(2);
        first.kind = NodeKind::Rectangle;
        first.parent_id = Some(frame.id);
        first.height = 30.0;
        let mut second = node(3);
        second.kind = NodeKind::Rectangle;
        second.parent_id = Some(frame.id);
        second.height = 30.0;
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame.clone()),
                        Command::Create(first.clone()),
                        Command::Create(second.clone()),
                        Command::SetAutoLayout {
                            id: frame.id,
                            layout: AutoLayout {
                                mode: LayoutMode::Vertical,
                                padding: [8.0, 0.0, 8.0, 0.0],
                                item_spacing: 6.0,
                                ..AutoLayout::default()
                            },
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(document.node(second.id).map(|node| node.y), Some(44.0));
    }

    #[test]
    fn auto_layout_hug_measures_direct_children_and_applies_frame_min_max() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 200.0;
        frame.height = 100.0;
        let mut first = node(2);
        first.kind = NodeKind::Rectangle;
        first.parent_id = Some(frame.id);
        first.width = 30.0;
        first.height = 20.0;
        let mut second = node(3);
        second.kind = NodeKind::Rectangle;
        second.parent_id = Some(frame.id);
        second.width = 40.0;
        second.height = 50.0;
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame.clone()),
                        Command::Create(first.clone()),
                        Command::Create(second.clone()),
                        Command::SetAutoLayout {
                            id: frame.id,
                            layout: AutoLayout {
                                mode: LayoutMode::Horizontal,
                                padding: [2.0, 3.0, 4.0, 5.0],
                                item_spacing: 6.0,
                                primary_sizing: LayoutSizing::Hug,
                                counter_sizing: LayoutSizing::Hug,
                                min_width: Some(90.0),
                                max_height: Some(52.0),
                                ..AutoLayout::default()
                            },
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document
                .node(frame.id)
                .map(|node| (node.width, node.height)),
            Some((90.0, 52.0))
        );
        assert_eq!(
            document.node(first.id).map(|node| (node.x, node.y)),
            Some((5.0, 2.0))
        );
        assert_eq!(
            document.node(second.id).map(|node| (node.x, node.y)),
            Some((41.0, 2.0))
        );
    }

    #[test]
    fn nested_auto_layout_hug_converges_from_inner_frame_to_outer_frame() {
        let mut document = Document::empty();
        let outer = node(1);
        let mut inner = node(2);
        inner.parent_id = Some(outer.id);
        inner.width = 1.0;
        inner.height = 1.0;
        let mut leaf = node(3);
        leaf.kind = NodeKind::Rectangle;
        leaf.parent_id = Some(inner.id);
        leaf.width = 20.0;
        leaf.height = 10.0;
        let hug = AutoLayout {
            mode: LayoutMode::Horizontal,
            primary_sizing: LayoutSizing::Hug,
            counter_sizing: LayoutSizing::Hug,
            ..AutoLayout::default()
        };
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(outer.clone()),
                        Command::Create(inner.clone()),
                        Command::Create(leaf.clone()),
                        Command::SetAutoLayout {
                            id: outer.id,
                            layout: hug.clone(),
                        },
                        Command::SetAutoLayout {
                            id: inner.id,
                            layout: hug,
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document
                .node(inner.id)
                .map(|node| (node.width, node.height, node.x, node.y)),
            Some((20.0, 10.0, 0.0, 0.0))
        );
        assert_eq!(
            document
                .node(outer.id)
                .map(|node| (node.width, node.height)),
            Some((20.0, 10.0))
        );
    }

    #[test]
    fn nested_auto_layout_frame_maps_its_width_and_height_to_the_parent_axes() {
        let mut document = Document::empty();
        let mut outer = node(1);
        outer.width = 200.0;
        outer.height = 100.0;
        let mut inner = node(2);
        inner.parent_id = Some(outer.id);
        inner.width = 1.0;
        inner.height = 1.0;
        let mut leaf = node(3);
        leaf.kind = NodeKind::Rectangle;
        leaf.parent_id = Some(inner.id);
        leaf.width = 20.0;
        leaf.height = 10.0;
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(outer.clone()),
                        Command::Create(inner.clone()),
                        Command::Create(leaf.clone()),
                        Command::SetAutoLayout {
                            id: outer.id,
                            layout: AutoLayout {
                                mode: LayoutMode::Horizontal,
                                ..AutoLayout::default()
                            },
                        },
                        Command::SetAutoLayout {
                            id: inner.id,
                            layout: AutoLayout {
                                mode: LayoutMode::Vertical,
                                // Vertical primary is the inner Frame's height; its
                                // counter axis is width and should Fill the outer row.
                                primary_sizing: LayoutSizing::Hug,
                                counter_sizing: LayoutSizing::Fill,
                                ..AutoLayout::default()
                            },
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document
                .node(inner.id)
                .map(|node| (node.width, node.height)),
            Some((200.0, 10.0))
        );
    }

    #[test]
    fn auto_layout_fill_respects_child_minimum_and_maximum_sizes() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 200.0;
        let mut fixed = node(2);
        fixed.kind = NodeKind::Rectangle;
        fixed.parent_id = Some(frame.id);
        fixed.width = 20.0;
        let mut capped_fill = node(3);
        capped_fill.kind = NodeKind::Rectangle;
        capped_fill.parent_id = Some(frame.id);
        let mut free_fill = node(4);
        free_fill.kind = NodeKind::Rectangle;
        free_fill.parent_id = Some(frame.id);
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame.clone()),
                        Command::Create(fixed.clone()),
                        Command::Create(capped_fill.clone()),
                        Command::Create(free_fill.clone()),
                        Command::SetAutoLayout {
                            id: frame.id,
                            layout: AutoLayout {
                                mode: LayoutMode::Horizontal,
                                ..AutoLayout::default()
                            },
                        },
                        Command::SetAutoLayout {
                            id: capped_fill.id,
                            layout: AutoLayout {
                                primary_sizing: LayoutSizing::Fill,
                                min_width: Some(50.0),
                                max_width: Some(80.0),
                                ..AutoLayout::default()
                            },
                        },
                        Command::SetAutoLayout {
                            id: free_fill.id,
                            layout: AutoLayout {
                                primary_sizing: LayoutSizing::Fill,
                                ..AutoLayout::default()
                            },
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document
                .node(capped_fill.id)
                .map(|node| (node.x, node.width)),
            Some((20.0, 80.0))
        );
        assert_eq!(
            document.node(free_fill.id).map(|node| (node.x, node.width)),
            Some((100.0, 100.0))
        );
    }

    #[test]
    fn auto_layout_rejects_unsatisfiable_fill_minimums_atomically() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 100.0;
        let mut first = node(2);
        first.kind = NodeKind::Rectangle;
        first.parent_id = Some(frame.id);
        let mut second = node(3);
        second.kind = NodeKind::Rectangle;
        second.parent_id = Some(frame.id);
        let result = document.submit(
            transaction(
                0,
                vec![
                    Command::Create(frame.clone()),
                    Command::Create(first.clone()),
                    Command::Create(second.clone()),
                    Command::SetAutoLayout {
                        id: frame.id,
                        layout: AutoLayout {
                            mode: LayoutMode::Horizontal,
                            ..AutoLayout::default()
                        },
                    },
                    Command::SetAutoLayout {
                        id: first.id,
                        layout: AutoLayout {
                            primary_sizing: LayoutSizing::Fill,
                            min_width: Some(60.0),
                            ..AutoLayout::default()
                        },
                    },
                    Command::SetAutoLayout {
                        id: second.id,
                        layout: AutoLayout {
                            primary_sizing: LayoutSizing::Fill,
                            min_width: Some(60.0),
                            ..AutoLayout::default()
                        },
                    },
                ],
            ),
            Origin::LocalUser,
        );
        assert_eq!(result, Err(CommandError::InvalidAutoLayout));
        assert_eq!(document.revision, 0);
        assert_eq!(document.nodes().count(), 0);
    }

    #[test]
    fn auto_layout_wrap_places_fixed_children_on_new_lines() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 100.0;
        frame.height = 100.0;
        let mut first = node(2);
        first.kind = NodeKind::Rectangle;
        first.parent_id = Some(frame.id);
        first.width = 40.0;
        first.height = 20.0;
        let mut second = node(3);
        second.kind = NodeKind::Rectangle;
        second.parent_id = Some(frame.id);
        second.width = 40.0;
        second.height = 20.0;
        let mut third = node(4);
        third.kind = NodeKind::Rectangle;
        third.parent_id = Some(frame.id);
        third.width = 40.0;
        third.height = 20.0;
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame.clone()),
                        Command::Create(first.clone()),
                        Command::Create(second.clone()),
                        Command::Create(third.clone()),
                        Command::SetAutoLayout {
                            id: frame.id,
                            layout: AutoLayout {
                                mode: LayoutMode::Horizontal,
                                wrap: true,
                                item_spacing: 10.0,
                                ..AutoLayout::default()
                            },
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document.node(first.id).map(|node| (node.x, node.y)),
            Some((0.0, 0.0))
        );
        assert_eq!(
            document.node(second.id).map(|node| (node.x, node.y)),
            Some((50.0, 0.0))
        );
        assert_eq!(
            document.node(third.id).map(|node| (node.x, node.y)),
            Some((0.0, 30.0))
        );
    }

    #[test]
    fn auto_layout_wrap_distributes_fill_per_track_and_stretches_counter_axis() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 120.0;
        frame.height = 100.0;
        let mut first = node(2);
        first.kind = NodeKind::Rectangle;
        first.parent_id = Some(frame.id);
        first.width = 50.0;
        first.height = 20.0;
        let mut flexible = node(3);
        flexible.kind = NodeKind::Rectangle;
        flexible.parent_id = Some(frame.id);
        flexible.width = 240.0;
        flexible.height = 160.0;
        let flexible_layout = AutoLayout {
            primary_sizing: LayoutSizing::Fill,
            counter_sizing: LayoutSizing::Fill,
            min_width: Some(20.0),
            max_width: Some(40.0),
            min_height: Some(10.0),
            ..AutoLayout::default()
        };
        let mut third = node(4);
        third.kind = NodeKind::Rectangle;
        third.parent_id = Some(frame.id);
        third.width = 80.0;
        third.height = 10.0;
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame.clone()),
                        Command::Create(first.clone()),
                        Command::Create(flexible.clone()),
                        Command::Create(third.clone()),
                        Command::SetAutoLayout {
                            id: flexible.id,
                            layout: flexible_layout.clone(),
                        },
                        Command::SetAutoLayout {
                            id: frame.id,
                            layout: AutoLayout {
                                mode: LayoutMode::Horizontal,
                                wrap: true,
                                item_spacing: 10.0,
                                ..AutoLayout::default()
                            },
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();

        assert_eq!(
            document
                .node(flexible.id)
                .map(|node| (node.x, node.y, node.width, node.height)),
            Some((60.0, 0.0, 40.0, 20.0))
        );
        assert_eq!(
            document
                .node(third.id)
                .map(|node| (node.x, node.y, node.width, node.height)),
            Some((0.0, 30.0, 80.0, 10.0))
        );

        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetAutoLayout {
                        id: flexible.id,
                        layout: AutoLayout {
                            max_width: Some(30.0),
                            ..flexible_layout
                        },
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document.node(flexible.id).map(|node| node.width),
            Some(30.0)
        );
        document.undo().unwrap();
        assert_eq!(
            document.node(flexible.id).map(|node| node.width),
            Some(40.0)
        );
    }

    #[test]
    fn auto_layout_wrap_stretches_tracks_when_every_child_stretches() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 100.0;
        frame.height = 100.0;
        let mut children = [node(2), node(3), node(4)];
        for child in &mut children {
            child.kind = NodeKind::Rectangle;
            child.parent_id = Some(frame.id);
            child.width = 45.0;
            child.height = 10.0;
        }
        let stretch = AutoLayout {
            counter_sizing: LayoutSizing::Fill,
            min_height: Some(10.0),
            ..AutoLayout::default()
        };
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame.clone()),
                        Command::Create(children[0].clone()),
                        Command::Create(children[1].clone()),
                        Command::Create(children[2].clone()),
                        Command::SetAutoLayout {
                            id: children[0].id,
                            layout: stretch.clone(),
                        },
                        Command::SetAutoLayout {
                            id: children[1].id,
                            layout: stretch.clone(),
                        },
                        Command::SetAutoLayout {
                            id: children[2].id,
                            layout: stretch,
                        },
                        Command::SetAutoLayout {
                            id: frame.id,
                            layout: AutoLayout {
                                mode: LayoutMode::Horizontal,
                                wrap: true,
                                item_spacing: 10.0,
                                track_spacing: Some(10.0),
                                ..AutoLayout::default()
                            },
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();

        assert_eq!(
            children
                .iter()
                .map(|child| {
                    document
                        .node(child.id)
                        .map(|node| (node.x, node.y, node.width, node.height))
                        .unwrap()
                })
                .collect::<Vec<_>>(),
            vec![
                (0.0, 0.0, 45.0, 45.0),
                (55.0, 0.0, 45.0, 45.0),
                (0.0, 55.0, 45.0, 45.0),
            ]
        );
    }

    #[test]
    fn auto_layout_wrap_hugs_the_complete_counter_axis_track_stack() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 100.0;
        frame.height = 1.0;
        let mut children = [node(2), node(3), node(4)];
        for (child, height) in children.iter_mut().zip([20.0, 30.0, 10.0]) {
            child.kind = NodeKind::Rectangle;
            child.parent_id = Some(frame.id);
            child.width = 40.0;
            child.height = height;
        }
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame.clone()),
                        Command::Create(children[0].clone()),
                        Command::Create(children[1].clone()),
                        Command::Create(children[2].clone()),
                        Command::SetAutoLayout {
                            id: frame.id,
                            layout: AutoLayout {
                                mode: LayoutMode::Horizontal,
                                padding: [5.0; 4],
                                item_spacing: 10.0,
                                track_spacing: Some(7.0),
                                wrap: true,
                                counter_sizing: LayoutSizing::Hug,
                                ..AutoLayout::default()
                            },
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();

        assert_eq!(document.node(frame.id).map(|node| node.height), Some(57.0));
        assert_eq!(
            document.node(children[2].id).map(|node| (node.x, node.y)),
            Some((5.0, 42.0))
        );
    }

    #[test]
    fn auto_layout_wrap_rejects_counter_hug_with_stretch_children_atomically() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 100.0;
        let mut child = node(2);
        child.kind = NodeKind::Rectangle;
        child.parent_id = Some(frame.id);
        let result = document.submit(
            transaction(
                0,
                vec![
                    Command::Create(frame.clone()),
                    Command::Create(child.clone()),
                    Command::SetAutoLayout {
                        id: child.id,
                        layout: AutoLayout {
                            counter_sizing: LayoutSizing::Fill,
                            ..AutoLayout::default()
                        },
                    },
                    Command::SetAutoLayout {
                        id: frame.id,
                        layout: AutoLayout {
                            mode: LayoutMode::Horizontal,
                            wrap: true,
                            counter_sizing: LayoutSizing::Hug,
                            ..AutoLayout::default()
                        },
                    },
                ],
            ),
            Origin::LocalUser,
        );
        assert_eq!(result, Err(CommandError::AutoLayoutUnsupported));
        assert_eq!(document.revision, 0);
        assert_eq!(document.nodes().count(), 0);
    }

    #[test]
    fn auto_layout_reflows_the_old_parent_after_a_child_is_reparented() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 100.0;
        let mut first = node(2);
        first.kind = NodeKind::Rectangle;
        first.parent_id = Some(frame.id);
        first.width = 20.0;
        let mut second = node(3);
        second.kind = NodeKind::Rectangle;
        second.parent_id = Some(frame.id);
        second.width = 20.0;
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame.clone()),
                        Command::Create(first.clone()),
                        Command::Create(second.clone()),
                        Command::SetAutoLayout {
                            id: frame.id,
                            layout: AutoLayout {
                                mode: LayoutMode::Horizontal,
                                item_spacing: 10.0,
                                ..AutoLayout::default()
                            },
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(document.node(second.id).map(|node| node.x), Some(30.0));
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetNodeParent {
                        id: first.id,
                        parent_id: None,
                        position: PositionId {
                            key: 10,
                            actor: ActorId(1),
                        },
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(document.node(second.id).map(|node| node.x), Some(0.0));
    }

    #[test]
    fn reparent_into_wrapped_auto_layout_preserves_fixed_child_extent() {
        let mut document = Document::empty();
        let mut target = node(1);
        target.kind = NodeKind::Frame;
        target.width = 240.0;
        target.height = 180.0;
        let mut source = node(2);
        source.kind = NodeKind::Frame;
        source.x = 340.0;
        source.width = 400.0;
        source.height = 200.0;
        let mut children = [node(3), node(4), node(5)];
        for (child, height) in children.iter_mut().zip([30.0, 50.0, 40.0]) {
            child.kind = NodeKind::Rectangle;
            child.parent_id = Some(target.id);
            child.width = 100.0;
            child.height = height;
        }
        let mut moved = node(6);
        moved.kind = NodeKind::Rectangle;
        moved.parent_id = Some(source.id);
        moved.width = 180.0;
        moved.height = 40.0;
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(target.clone()),
                        Command::Create(source.clone()),
                        Command::Create(children[0].clone()),
                        Command::Create(children[1].clone()),
                        Command::Create(children[2].clone()),
                        Command::Create(moved.clone()),
                        Command::SetAutoLayout {
                            id: moved.id,
                            layout: AutoLayout {
                                primary_sizing: LayoutSizing::Fill,
                                min_width: Some(120.0),
                                max_width: Some(180.0),
                                ..AutoLayout::default()
                            },
                        },
                        Command::SetAutoLayout {
                            id: target.id,
                            layout: AutoLayout {
                                mode: LayoutMode::Horizontal,
                                padding: [10.0; 4],
                                item_spacing: 10.0,
                                wrap: true,
                                track_alignment: WrapTrackAlignment::SpaceBetween,
                                ..AutoLayout::default()
                            },
                        },
                        Command::SetAutoLayout {
                            id: source.id,
                            layout: AutoLayout {
                                mode: LayoutMode::Horizontal,
                                padding: [20.0; 4],
                                item_spacing: 12.0,
                                ..AutoLayout::default()
                            },
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        document
            .submit(
                transaction(
                    1,
                    vec![
                        Command::SetAutoLayout {
                            id: moved.id,
                            layout: AutoLayout {
                                min_width: Some(120.0),
                                max_width: Some(180.0),
                                ..AutoLayout::default()
                            },
                        },
                        Command::SetNodeParent {
                            id: moved.id,
                            parent_id: Some(target.id),
                            position: PositionId {
                                key: 10,
                                actor: ActorId(1),
                            },
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let moved = document.node(moved.id).unwrap();
        assert_eq!((moved.width, moved.height), (180.0, 40.0));
        assert_eq!((moved.x, moved.y), (10.0, 130.0));
    }

    #[test]
    fn auto_layout_hug_measures_auto_sized_text_in_core() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 1.0;
        frame.height = 1.0;
        let mut text = node(2);
        text.kind = NodeKind::Text;
        text.parent_id = Some(frame.id);
        text.width = 1.0;
        text.height = 1.0;
        text.text = "hello".into();
        let properties = TextProperties {
            runs: vec![TextStyleRun {
                start: 0,
                end: 5,
                font: None,
                font_size: 10.0,
                font_weight: 400,
                italic: false,
                letter_spacing: 0.0,
                color: None,
                fill_stack: None,
                text_case: None,
                hyperlink: None,
                text_decoration: None,
                text_decoration_style: None,
                text_decoration_offset: None,
                text_decoration_thickness: None,
                text_decoration_skip_ink: None,
                leading_trim: None,
                open_type_features: Vec::new(),
                text_style_id: None,
                paint_style_id: None,
                variable_bindings: Default::default(),
                text_decoration_color: None,
            }],
            paragraph: ParagraphStyle {
                alignment: TextAlign::Left,
                line_height: Some(12.0),
                line_height_unit: None,
                paragraph_spacing: 0.0,
                paragraph_indent: None,
                text_wrap_style: None,
                list_type: None,
                list_spacing: None,
                hanging_list: false,
                hanging_punctuation: false,
            },
            paragraph_style_runs: Vec::new(),
            auto_size: TextAutoSize::WidthAndHeight,
            fallback_fonts: Vec::new(),
            text_truncation: TextTruncation::Disabled,
            max_lines: None,
            base_style: None,
        };
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame.clone()),
                        Command::Create(text.clone()),
                        Command::SetTextProperties {
                            id: text.id,
                            properties,
                        },
                        Command::SetAutoLayout {
                            id: frame.id,
                            layout: AutoLayout {
                                mode: LayoutMode::Horizontal,
                                primary_sizing: LayoutSizing::Hug,
                                counter_sizing: LayoutSizing::Hug,
                                ..AutoLayout::default()
                            },
                        },
                        Command::SetAutoLayout {
                            id: text.id,
                            layout: AutoLayout {
                                primary_sizing: LayoutSizing::Hug,
                                counter_sizing: LayoutSizing::Hug,
                                ..AutoLayout::default()
                            },
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document.node(text.id).map(|node| (node.width, node.height)),
            Some((30.0, 12.0))
        );
        assert_eq!(
            document
                .node(frame.id)
                .map(|node| (node.width, node.height)),
            Some((30.0, 12.0))
        );
    }

    #[test]
    fn auto_layout_hug_counts_crlf_as_one_paragraph_boundary() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 1.0;
        frame.height = 1.0;
        let mut text = node(2);
        text.kind = NodeKind::Text;
        text.parent_id = Some(frame.id);
        text.text = "ab\r\n中".into();
        let properties = TextProperties {
            runs: vec![TextStyleRun {
                start: 0,
                end: text.text.len() as u32,
                font: None,
                font_size: 10.0,
                font_weight: 400,
                italic: false,
                letter_spacing: 0.0,
                color: None,
                fill_stack: None,
                text_case: None,
                hyperlink: None,
                text_decoration: None,
                text_decoration_style: None,
                text_decoration_offset: None,
                text_decoration_thickness: None,
                text_decoration_skip_ink: None,
                leading_trim: None,
                open_type_features: Vec::new(),
                text_style_id: None,
                paint_style_id: None,
                variable_bindings: Default::default(),
                text_decoration_color: None,
            }],
            paragraph: ParagraphStyle {
                alignment: TextAlign::Left,
                line_height: Some(12.0),
                line_height_unit: None,
                paragraph_spacing: 3.0,
                paragraph_indent: None,
                text_wrap_style: None,
                list_type: None,
                list_spacing: None,
                hanging_list: false,
                hanging_punctuation: false,
            },
            paragraph_style_runs: Vec::new(),
            auto_size: TextAutoSize::WidthAndHeight,
            fallback_fonts: Vec::new(),
            text_truncation: TextTruncation::Disabled,
            max_lines: None,
            base_style: None,
        };
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame.clone()),
                        Command::Create(text.clone()),
                        Command::SetTextProperties {
                            id: text.id,
                            properties,
                        },
                        Command::SetAutoLayout {
                            id: frame.id,
                            layout: AutoLayout {
                                mode: LayoutMode::Horizontal,
                                primary_sizing: LayoutSizing::Hug,
                                counter_sizing: LayoutSizing::Hug,
                                ..AutoLayout::default()
                            },
                        },
                        Command::SetAutoLayout {
                            id: text.id,
                            layout: AutoLayout {
                                primary_sizing: LayoutSizing::Hug,
                                counter_sizing: LayoutSizing::Hug,
                                ..AutoLayout::default()
                            },
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document.node(text.id).map(|node| (node.width, node.height)),
            Some((12.0, 27.0))
        );
        assert_eq!(
            document
                .node(frame.id)
                .map(|node| (node.width, node.height)),
            Some((12.0, 27.0))
        );
    }

    #[test]
    fn auto_layout_height_auto_text_wraps_at_its_authored_width() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 100.0;
        frame.height = 1.0;
        let mut text = node(2);
        text.kind = NodeKind::Text;
        text.parent_id = Some(frame.id);
        text.width = 12.0;
        text.text = "ab中d".into();
        let properties = TextProperties {
            runs: vec![TextStyleRun {
                start: 0,
                end: text.text.len() as u32,
                font: None,
                font_size: 10.0,
                font_weight: 400,
                italic: false,
                letter_spacing: 0.0,
                color: None,
                fill_stack: None,
                text_case: None,
                hyperlink: None,
                text_decoration: None,
                text_decoration_style: None,
                text_decoration_offset: None,
                text_decoration_thickness: None,
                text_decoration_skip_ink: None,
                leading_trim: None,
                open_type_features: Vec::new(),
                text_style_id: None,
                paint_style_id: None,
                variable_bindings: Default::default(),
                text_decoration_color: None,
            }],
            paragraph: ParagraphStyle {
                alignment: TextAlign::Left,
                line_height: Some(12.0),
                line_height_unit: None,
                paragraph_spacing: 0.0,
                paragraph_indent: None,
                text_wrap_style: None,
                list_type: None,
                list_spacing: None,
                hanging_list: false,
                hanging_punctuation: false,
            },
            paragraph_style_runs: Vec::new(),
            auto_size: TextAutoSize::Height,
            fallback_fonts: Vec::new(),
            text_truncation: TextTruncation::Disabled,
            max_lines: None,
            base_style: None,
        };
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame.clone()),
                        Command::Create(text.clone()),
                        Command::SetTextProperties {
                            id: text.id,
                            properties,
                        },
                        Command::SetAutoLayout {
                            id: frame.id,
                            layout: AutoLayout {
                                mode: LayoutMode::Horizontal,
                                ..AutoLayout::default()
                            },
                        },
                        Command::SetAutoLayout {
                            id: text.id,
                            layout: AutoLayout {
                                primary_sizing: LayoutSizing::Fixed,
                                counter_sizing: LayoutSizing::Hug,
                                ..AutoLayout::default()
                            },
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document.node(text.id).map(|node| (node.width, node.height)),
            Some((12.0, 24.0))
        );
    }

    #[test]
    fn auto_layout_height_auto_wrap_keeps_emoji_and_combining_graphemes_intact() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 100.0;
        let mut text = node(2);
        text.kind = NodeKind::Text;
        text.parent_id = Some(frame.id);
        text.width = 12.0;
        text.text = "👩‍💻e\u{301}x".into();
        let properties = TextProperties {
            runs: vec![TextStyleRun {
                start: 0,
                end: text.text.len() as u32,
                font: None,
                font_size: 10.0,
                font_weight: 400,
                italic: false,
                letter_spacing: 0.0,
                color: None,
                fill_stack: None,
                text_case: None,
                hyperlink: None,
                text_decoration: None,
                text_decoration_style: None,
                text_decoration_offset: None,
                text_decoration_thickness: None,
                text_decoration_skip_ink: None,
                leading_trim: None,
                open_type_features: Vec::new(),
                text_style_id: None,
                paint_style_id: None,
                variable_bindings: Default::default(),
                text_decoration_color: None,
            }],
            paragraph: ParagraphStyle {
                alignment: TextAlign::Left,
                line_height: Some(12.0),
                line_height_unit: None,
                paragraph_spacing: 0.0,
                paragraph_indent: None,
                text_wrap_style: None,
                list_type: None,
                list_spacing: None,
                hanging_list: false,
                hanging_punctuation: false,
            },
            paragraph_style_runs: Vec::new(),
            auto_size: TextAutoSize::Height,
            fallback_fonts: Vec::new(),
            text_truncation: TextTruncation::Disabled,
            max_lines: None,
            base_style: None,
        };
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame.clone()),
                        Command::Create(text.clone()),
                        Command::SetTextProperties {
                            id: text.id,
                            properties,
                        },
                        Command::SetAutoLayout {
                            id: frame.id,
                            layout: AutoLayout {
                                mode: LayoutMode::Horizontal,
                                ..AutoLayout::default()
                            },
                        },
                        Command::SetAutoLayout {
                            id: text.id,
                            layout: AutoLayout {
                                primary_sizing: LayoutSizing::Fixed,
                                counter_sizing: LayoutSizing::Hug,
                                ..AutoLayout::default()
                            },
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        // Three graphemes at 6px each form two 12px lines, rather than the
        // eight Unicode scalars creating four unstable lines.
        assert_eq!(
            document.node(text.id).map(|node| (node.width, node.height)),
            Some((12.0, 24.0))
        );
    }

    #[test]
    fn auto_layout_preserves_absolute_children_outside_the_flow() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 100.0;
        frame.height = 100.0;
        let mut flow = node(2);
        flow.kind = NodeKind::Rectangle;
        flow.parent_id = Some(frame.id);
        flow.width = 20.0;
        flow.height = 20.0;
        let mut absolute = node(3);
        absolute.kind = NodeKind::Rectangle;
        absolute.parent_id = Some(frame.id);
        absolute.x = 70.0;
        absolute.y = 60.0;
        absolute.width = 10.0;
        absolute.height = 10.0;
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame.clone()),
                        Command::Create(flow.clone()),
                        Command::Create(absolute.clone()),
                        Command::SetAutoLayout {
                            id: frame.id,
                            layout: AutoLayout {
                                mode: LayoutMode::Horizontal,
                                padding: [5.0, 5.0, 5.0, 5.0],
                                ..AutoLayout::default()
                            },
                        },
                        Command::SetAutoLayout {
                            id: absolute.id,
                            layout: AutoLayout {
                                absolute: true,
                                ..AutoLayout::default()
                            },
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document.node(flow.id).map(|node| (node.x, node.y)),
            Some((5.0, 5.0))
        );
        assert_eq!(
            document
                .node(absolute.id)
                .map(|node| (node.x, node.y, node.width, node.height)),
            Some((70.0, 60.0, 10.0, 10.0))
        );
    }

    #[test]
    fn three_layer_auto_layout_hug_converges_from_leaf_to_root() {
        let mut document = Document::empty();
        let outer = node(1);
        let mut middle = node(2);
        middle.parent_id = Some(outer.id);
        let mut inner = node(3);
        inner.parent_id = Some(middle.id);
        let mut leaf = node(4);
        leaf.kind = NodeKind::Rectangle;
        leaf.parent_id = Some(inner.id);
        leaf.width = 24.0;
        leaf.height = 16.0;
        let hug = AutoLayout {
            mode: LayoutMode::Horizontal,
            primary_sizing: LayoutSizing::Hug,
            counter_sizing: LayoutSizing::Hug,
            ..AutoLayout::default()
        };
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(outer.clone()),
                        Command::Create(middle.clone()),
                        Command::Create(inner.clone()),
                        Command::Create(leaf.clone()),
                        Command::SetAutoLayout {
                            id: outer.id,
                            layout: hug.clone(),
                        },
                        Command::SetAutoLayout {
                            id: middle.id,
                            layout: hug.clone(),
                        },
                        Command::SetAutoLayout {
                            id: inner.id,
                            layout: hug,
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        for id in [outer.id, middle.id, inner.id] {
            assert_eq!(
                document.node(id).map(|node| (node.width, node.height)),
                Some((24.0, 16.0))
            );
        }
    }

    #[test]
    fn resizing_an_outer_auto_layout_frame_reflows_nested_frame_descendants() {
        let mut document = Document::empty();
        let mut outer = node(1);
        outer.width = 100.0;
        outer.height = 100.0;
        let mut inner = node(2);
        inner.parent_id = Some(outer.id);
        inner.width = 100.0;
        inner.height = 40.0;
        let mut leaf = node(3);
        leaf.kind = NodeKind::Rectangle;
        leaf.parent_id = Some(inner.id);
        leaf.width = 20.0;
        leaf.height = 20.0;
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(outer.clone()),
                        Command::Create(inner.clone()),
                        Command::Create(leaf.clone()),
                        Command::SetAutoLayout {
                            id: outer.id,
                            layout: AutoLayout {
                                mode: LayoutMode::Vertical,
                                ..AutoLayout::default()
                            },
                        },
                        // As a vertical parent's counter-axis child, this horizontal Frame
                        // fills the parent's width. Its own end alignment must be rerun
                        // whenever the parent changes that width.
                        Command::SetAutoLayout {
                            id: inner.id,
                            layout: AutoLayout {
                                mode: LayoutMode::Horizontal,
                                primary_sizing: LayoutSizing::Fill,
                                primary_alignment: LayoutAlignment::End,
                                ..AutoLayout::default()
                            },
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(document.node(leaf.id).map(|node| node.x), Some(80.0));

        document
            .submit(
                transaction(
                    1,
                    vec![Command::UpdateGeometry {
                        id: outer.id,
                        x: 0.0,
                        y: 0.0,
                        width: 200.0,
                        height: 100.0,
                        rotation: 0.0,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();

        assert_eq!(document.node(inner.id).map(|node| node.width), Some(200.0));
        assert_eq!(document.node(leaf.id).map(|node| node.x), Some(180.0));
    }

    #[test]
    fn auto_layout_reflows_children_after_a_sibling_reorder() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 100.0;
        let mut first = node(2);
        first.kind = NodeKind::Rectangle;
        first.parent_id = Some(frame.id);
        first.width = 20.0;
        let mut second = node(3);
        second.kind = NodeKind::Rectangle;
        second.parent_id = Some(frame.id);
        second.width = 20.0;
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame.clone()),
                        Command::Create(first.clone()),
                        Command::Create(second.clone()),
                        Command::SetAutoLayout {
                            id: frame.id,
                            layout: AutoLayout {
                                mode: LayoutMode::Horizontal,
                                item_spacing: 10.0,
                                ..AutoLayout::default()
                            },
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetNodePosition {
                        id: first.id,
                        position: PositionId {
                            key: 4,
                            actor: ActorId(0),
                        },
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(document.node(second.id).map(|node| node.x), Some(0.0));
        assert_eq!(document.node(first.id).map(|node| node.x), Some(30.0));
    }

    #[test]
    fn auto_layout_owns_child_geometry_over_preserved_constraints() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 100.0;
        frame.height = 100.0;
        let mut child = node(2);
        child.kind = NodeKind::Rectangle;
        child.parent_id = Some(frame.id);
        child.width = 20.0;
        child.height = 20.0;
        child.constraints = Some(Constraints {
            horizontal: ConstraintType::Stretch,
            vertical: ConstraintType::Stretch,
        });
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame.clone()),
                        Command::Create(child.clone()),
                        Command::SetAutoLayout {
                            id: frame.id,
                            layout: AutoLayout {
                                mode: LayoutMode::Horizontal,
                                ..AutoLayout::default()
                            },
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        document
            .submit(
                transaction(
                    1,
                    vec![Command::UpdateGeometry {
                        id: frame.id,
                        x: 0.0,
                        y: 0.0,
                        width: 200.0,
                        height: 200.0,
                        rotation: 0.0,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document
                .node(child.id)
                .map(|node| (node.x, node.y, node.width, node.height)),
            Some((0.0, 0.0, 20.0, 20.0))
        );
        assert_eq!(
            document.node(child.id).and_then(|node| node.constraints),
            child.constraints
        );
    }

    #[test]
    fn auto_layout_mode_is_rejected_on_non_frame_nodes() {
        let mut document = Document::empty();
        let mut rectangle = node(1);
        rectangle.kind = NodeKind::Rectangle;
        document
            .submit(
                transaction(0, vec![Command::Create(rectangle.clone())]),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document.submit(
                transaction(
                    1,
                    vec![Command::SetAutoLayout {
                        id: rectangle.id,
                        layout: AutoLayout {
                            mode: LayoutMode::Vertical,
                            ..AutoLayout::default()
                        },
                    }]
                ),
                Origin::LocalUser
            ),
            Err(CommandError::InvalidAutoLayout),
        );
    }

    #[test]
    fn component_inherits_frame_children_clip_and_auto_layout_contract() {
        let mut document = Document::empty();
        let mut component = node(1);
        component.kind = NodeKind::Component;
        component.name = "Card component".into();
        component.width = 200.0;
        component.height = 100.0;
        component.clips_content = true;
        let mut child = node(2);
        child.kind = NodeKind::Rectangle;
        child.parent_id = Some(component.id);
        child.width = 30.0;
        child.height = 20.0;
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(component.clone()),
                        Command::Create(child.clone()),
                        Command::SetAutoLayout {
                            id: component.id,
                            layout: AutoLayout {
                                mode: LayoutMode::Horizontal,
                                padding: [8.0, 0.0, 0.0, 12.0],
                                ..AutoLayout::default()
                            },
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();

        assert!(document.node(component.id).unwrap().clips_content);
        assert_eq!(
            document.node(child.id).map(|node| (node.x, node.y)),
            Some((12.0, 8.0))
        );
    }

    #[test]
    fn moving_the_last_component_out_of_a_component_set_dissolves_it_with_history() {
        let mut document = Document::empty();
        let mut component_set = node(1);
        component_set.kind = NodeKind::ComponentSet;
        component_set.name = "Button variants".into();
        let mut component = node(2);
        component.kind = NodeKind::Component;
        component.name = "State=Default".into();
        component.parent_id = Some(component_set.id);
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(component_set.clone()),
                        Command::Create(component.clone()),
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let grouped_hash = document.canonical_hash();

        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetNodeParent {
                        id: component.id,
                        parent_id: None,
                        position: PositionId {
                            key: 20,
                            actor: ActorId(7),
                        },
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert!(document.node(component_set.id).is_none());
        assert_eq!(document.node(component.id).unwrap().parent_id, None);
        let dissolved_hash = document.canonical_hash();

        document.undo().unwrap();
        assert_eq!(document.canonical_hash(), grouped_hash);
        assert_eq!(
            document.node(component.id).unwrap().parent_id,
            Some(component_set.id)
        );
        assert_eq!(
            document.node(component_set.id).unwrap().kind,
            NodeKind::ComponentSet
        );

        document.redo().unwrap();
        assert_eq!(document.canonical_hash(), dissolved_hash);
        assert!(document.node(component_set.id).is_none());
        assert_eq!(document.node(component.id).unwrap().parent_id, None);
    }

    #[test]
    fn deleting_the_last_component_dissolves_its_component_set_atomically() {
        let mut document = Document::empty();
        let mut component_set = node(1);
        component_set.kind = NodeKind::ComponentSet;
        let mut component = node(2);
        component.kind = NodeKind::Component;
        component.parent_id = Some(component_set.id);
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(component_set.clone()),
                        Command::Create(component.clone()),
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let before = document.canonical_hash();

        document
            .submit(
                transaction(1, vec![Command::Delete { id: component.id }]),
                Origin::LocalUser,
            )
            .unwrap();
        assert!(document.node(component.id).is_none());
        assert!(document.node(component_set.id).is_none());

        document.undo().unwrap();
        assert_eq!(document.canonical_hash(), before);
        assert_eq!(
            document.node(component.id).unwrap().parent_id,
            Some(component_set.id)
        );
    }

    #[test]
    fn line_and_connector_accept_zero_height_but_closed_nodes_do_not() {
        let mut document = Document::empty();
        let mut line = node(1);
        line.kind = NodeKind::Line;
        line.name = "Line".into();
        line.width = 120.0;
        line.height = 0.0;
        line.fill = "#00000000".into();
        line.stroke = "#000".into();
        line.stroke_width = 1.0;

        document
            .submit(
                transaction(0, vec![Command::Create(line)]),
                Origin::LocalUser,
            )
            .unwrap();

        let mut connector = node(3);
        connector.kind = NodeKind::Connector;
        connector.name = "Connector".into();
        connector.width = 120.0;
        connector.height = 0.0;
        connector.fill = "#00000000".into();
        connector.stroke = "#000".into();
        connector.stroke_width = 1.0;
        document
            .submit(
                transaction(1, vec![Command::Create(connector)]),
                Origin::LocalUser,
            )
            .unwrap();

        let mut rectangle = node(2);
        rectangle.height = 0.0;
        assert_eq!(
            document.submit(
                transaction(2, vec![Command::Create(rectangle)]),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidGeometry)
        );
    }

    #[test]
    fn transaction_emits_history_with_before_and_after_values() {
        let mut document = Document::empty();
        document
            .submit(
                transaction(0, vec![Command::Create(node(1))]),
                Origin::LocalUser,
            )
            .unwrap();
        let applied = document
            .submit(
                transaction(
                    1,
                    vec![Command::UpdateGeometry {
                        id: NodeId(1),
                        x: 10.0,
                        y: 20.0,
                        width: 300.0,
                        height: 160.0,
                        rotation: 30.0,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(applied.accepted_revision, 2);
        assert_eq!(
            applied.history_item.changes,
            vec![AppliedChange::GeometryChanged {
                id: NodeId(1),
                before: Geometry {
                    x: 0.0,
                    y: 0.0,
                    width: 240.0,
                    height: 160.0,
                    rotation: 0.0,
                },
                after: Geometry {
                    x: 10.0,
                    y: 20.0,
                    width: 300.0,
                    height: 160.0,
                    rotation: 30.0,
                },
            }]
        );
    }

    #[test]
    fn stale_revision_does_not_modify_document() {
        let mut document = Document::empty();
        document
            .submit(
                transaction(0, vec![Command::Create(node(1))]),
                Origin::LocalUser,
            )
            .unwrap();
        let result = document.submit(
            Transaction {
                id: TransactionId(8),
                base_revision: 0,
                commands: vec![Command::Rename {
                    id: NodeId(1),
                    name: "Stale".into(),
                }],
            },
            Origin::LocalUser,
        );
        assert_eq!(
            result,
            Err(CommandError::RevisionConflict {
                expected: 1,
                actual: 0
            })
        );
        assert_eq!(document.node(NodeId(1)).unwrap().name, "Card");
    }

    #[test]
    fn deleted_id_cannot_be_reused() {
        let mut document = Document::empty();
        document
            .submit(
                transaction(0, vec![Command::Create(node(1))]),
                Origin::LocalUser,
            )
            .unwrap();
        document
            .submit(
                transaction(1, vec![Command::Delete { id: NodeId(1) }]),
                Origin::LocalUser,
            )
            .unwrap();
        let result = document.submit(
            transaction(2, vec![Command::Create(node(1))]),
            Origin::LocalUser,
        );
        assert_eq!(result, Err(CommandError::RetiredNodeId { id: NodeId(1) }));
    }

    #[test]
    fn default_text_properties_use_a_twenty_pixel_line_height() {
        assert_eq!(TextProperties::default().paragraph.line_height, Some(20.0));
    }

    #[test]
    fn explicit_restore_replays_a_tombstone_without_reusing_the_id() {
        let mut document = Document::empty();
        let restored = node(1);
        document
            .submit(
                transaction(0, vec![Command::Create(restored.clone())]),
                Origin::RemoteOperation,
            )
            .unwrap();
        document
            .submit(
                transaction(1, vec![Command::Delete { id: NodeId(1) }]),
                Origin::RemoteOperation,
            )
            .unwrap();
        document
            .submit(
                transaction(
                    2,
                    vec![Command::RestoreNode {
                        page_id: DEFAULT_PAGE_ID,
                        node: restored,
                        asset_id: None,
                        text_properties: None,
                    }],
                ),
                Origin::RemoteOperation,
            )
            .unwrap();
        assert!(document.node(NodeId(1)).is_some());
        assert!(!document.retired_ids().any(|id| *id == NodeId(1)));
    }

    #[test]
    fn invalid_appearance_rolls_back_the_whole_transaction() {
        let mut document = Document::empty();
        document
            .submit(
                transaction(0, vec![Command::Create(node(1))]),
                Origin::LocalUser,
            )
            .unwrap();
        let result = document.submit(
            transaction(
                1,
                vec![
                    Command::Rename {
                        id: NodeId(1),
                        name: "Changed".into(),
                    },
                    Command::SetAppearance {
                        id: NodeId(1),
                        appearance: Appearance {
                            fill: "".into(),
                            stroke: "#00000000".into(),
                            fills: Vec::new(),
                            strokes: Vec::new(),
                            stroke_width: 0.0,
                            stroke_cap_start: StrokeCap::None,
                            stroke_cap_end: StrokeCap::ArrowLines,
                            stroke_join: Default::default(),
                            stroke_miter_limit: DEFAULT_STROKE_MITER_LIMIT,
                            stroke_dash_pattern: Vec::new(),
                            stroke_weights: Vec::new(),
                            stroke_align: Default::default(),
                            arc_data: None,
                            parametric_shape: None,
                            relative_transform: None,
                            opacity: 1.0,
                            blend_mode: BlendMode::Normal,
                            drop_shadow: None,
                            effect_stack: Vec::new(),
                            corner_radius: 0.0,
                            corner_radii: Vec::new(),
                            corner_smoothing: 0.0,
                            constraints: None,
                            visible: true,
                            locked: false,
                            contents_hidden: false,
                            clips_content: Some(false),
                        },
                    },
                ],
            ),
            Origin::LocalUser,
        );
        assert_eq!(result, Err(CommandError::InvalidAppearance));
        assert_eq!(document.node(NodeId(1)).unwrap().name, "Card");
    }

    #[test]
    fn canonical_color_space_is_hashed_and_invalid_color_rolls_back() {
        let mut srgb = Document::empty();
        let mut p3 = Document::empty();
        let srgb_node = node(1);
        let mut p3_node = node(1);
        p3_node.fill =
            Paint::Solid(Color::new(ColorSpace::DisplayP3, [0.2, 0.8, 0.4], 1.0).unwrap());
        srgb.submit(
            transaction(0, vec![Command::Create(srgb_node)]),
            Origin::LocalUser,
        )
        .unwrap();
        p3.submit(
            transaction(0, vec![Command::Create(p3_node)]),
            Origin::LocalUser,
        )
        .unwrap();
        assert_ne!(srgb.canonical_hash_hex(), p3.canonical_hash_hex());

        let mut invalid = node(2);
        invalid.fill = Paint::Solid(Color {
            space: ColorSpace::Srgb,
            components: [f32::NAN, 0.0, 0.0],
            alpha: 1.0,
        });
        assert_eq!(
            p3.submit(
                transaction(1, vec![Command::Create(invalid)]),
                Origin::LocalUser
            ),
            Err(CommandError::InvalidAppearance)
        );
        assert_eq!(p3.nodes().count(), 1);
    }

    #[test]
    fn resource_index_is_canonical_and_rejects_invalid_asset_records() {
        let mut document = Document::empty();
        let baseline = document.canonical_hash();
        let asset = AssetReference {
            asset_id: AssetId(7),
            content_hash: [9; 32],
            media_type: "image/png".into(),
            byte_length: 128,
            dimensions: Some([16, 8]),
            font_faces: Vec::new(),
        };
        document.seed_asset(asset.clone()).unwrap();
        assert_eq!(document.asset(AssetId(7)), Some(&asset));
        assert_ne!(document.canonical_hash(), baseline);
        assert_eq!(
            document.seed_asset(asset),
            Err(CommandError::DuplicateAsset { id: AssetId(7) })
        );
        assert_eq!(
            document.seed_asset(AssetReference {
                asset_id: AssetId(8),
                content_hash: [0; 32],
                media_type: "image/png".into(),
                byte_length: 1,
                dimensions: None,
                font_faces: Vec::new(),
            }),
            Err(CommandError::InvalidAsset)
        );

        let named_font = AssetReference {
            asset_id: AssetId(9),
            content_hash: [3; 32],
            media_type: "font/ttf".into(),
            byte_length: 512,
            dimensions: None,
            font_faces: vec![FontFaceMetadata {
                face_index: 0,
                family: "Acme Sans".into(),
                style: "Regular".into(),
                aliases: vec![FontNameAlias {
                    family: "思源黑体".into(),
                    style: "常规".into(),
                }],
            }],
        };
        let before_font = document.canonical_hash();
        document.seed_asset(named_font.clone()).unwrap();
        assert_ne!(document.canonical_hash(), before_font);
        let mut invalid_faces = named_font.clone();
        invalid_faces.asset_id = AssetId(10);
        invalid_faces.font_faces[0].face_index = 1;
        assert_eq!(
            document.seed_asset(invalid_faces),
            Err(CommandError::InvalidAsset)
        );
        let mut unsorted_aliases = named_font;
        unsorted_aliases.asset_id = AssetId(11);
        unsorted_aliases.font_faces[0].aliases = vec![
            FontNameAlias {
                family: "Zulu".into(),
                style: "Regular".into(),
            },
            FontNameAlias {
                family: "Alpha".into(),
                style: "Regular".into(),
            },
        ];
        assert_eq!(
            document.seed_asset(unsorted_aliases),
            Err(CommandError::InvalidAsset)
        );
    }

    #[test]
    fn text_style_catalog_is_hashed_bounded_and_undoable() {
        let mut document = Document::empty();
        let baseline = document.canonical_hash_hex();
        let style = text_style_resource("S:body");
        document
            .submit(
                transaction(
                    0,
                    vec![Command::RegisterTextStyle {
                        style: style.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(document.text_style("S:body"), Some(&style));
        assert_ne!(document.canonical_hash_hex(), baseline);
        document.undo().unwrap();
        assert!(document.text_style("S:body").is_none());
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(document.text_style("S:body"), Some(&style));

        assert!(matches!(
            document.submit(
                transaction(
                    document.revision,
                    vec![Command::RegisterTextStyle {
                        style: style.clone()
                    }],
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::DuplicateTextStyle { .. })
        ));
        let mut invalid = text_style_resource("S:invalid");
        invalid.style.text_style_id = Some("S:self".into());
        assert_eq!(
            document.seed_text_style(invalid),
            Err(CommandError::InvalidTextStyle)
        );
    }

    #[test]
    fn paint_style_catalog_is_hashed_bounded_and_undoable() {
        let mut document = Document::empty();
        let baseline = document.canonical_hash_hex();
        let style = paint_style_resource("S:brand-fill");
        document
            .submit(
                transaction(
                    0,
                    vec![Command::RegisterPaintStyle {
                        style: style.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(document.paint_style("S:brand-fill"), Some(&style));
        assert_ne!(document.canonical_hash_hex(), baseline);
        document.undo().unwrap();
        assert!(document.paint_style("S:brand-fill").is_none());
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(document.paint_style("S:brand-fill"), Some(&style));
        assert!(matches!(
            document.submit(
                transaction(
                    document.revision,
                    vec![Command::RegisterPaintStyle { style }]
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::DuplicatePaintStyle { .. })
        ));
        assert_eq!(
            document.seed_text_style(text_style_resource("S:brand-fill")),
            Err(CommandError::InvalidTextStyle)
        );
        let mut invalid = paint_style_resource("S:invalid");
        invalid.remote = true;
        assert_eq!(
            document.seed_paint_style(invalid),
            Err(CommandError::InvalidPaintStyle)
        );
    }

    #[test]
    fn local_style_updates_and_deletes_are_hashed_and_undoable() {
        let mut text_document = Document::empty();
        let text = text_style_resource("S:body");
        text_document
            .submit(
                transaction(
                    0,
                    vec![Command::RegisterTextStyle {
                        style: text.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let mut changed_text = text.clone();
        changed_text.name = "Typography/Body".into();
        changed_text.description_markdown = "**Body** copy".into();
        changed_text.documentation_links = vec!["https://example.com/styles/body".into()];
        changed_text.style.letter_spacing = 10.0;
        changed_text.letter_spacing_unit = Some(TextStyleLetterSpacingUnit::Percent);
        let text_hash_before_update = text_document.canonical_hash();
        text_document
            .submit(
                transaction(
                    1,
                    vec![Command::SetTextStyle {
                        style: changed_text.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(text_document.text_style(&text.id), Some(&changed_text));
        assert_ne!(text_document.canonical_hash(), text_hash_before_update);
        text_document.undo().unwrap();
        assert_eq!(text_document.text_style(&text.id), Some(&text));
        text_document.redo().unwrap();
        assert_eq!(text_document.text_style(&text.id), Some(&changed_text));
        text_document
            .submit(
                transaction(
                    text_document.revision,
                    vec![Command::DeleteTextStyle {
                        id: text.id.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert!(text_document.text_style(&text.id).is_none());
        text_document.undo().unwrap();
        assert_eq!(text_document.text_style(&text.id), Some(&changed_text));
        text_document.redo().unwrap();
        assert!(text_document.text_style(&text.id).is_none());

        let mut paint_document = Document::empty();
        let paint = paint_style_resource("S:brand");
        paint_document
            .submit(
                transaction(
                    0,
                    vec![Command::RegisterPaintStyle {
                        style: paint.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let mut changed_paint = paint.clone();
        changed_paint.name = "Color/Brand".into();
        changed_paint.description_markdown = "**Brand** color".into();
        changed_paint.documentation_links = vec!["https://example.com/styles/brand".into()];
        let paint_hash_before_update = paint_document.canonical_hash();
        paint_document
            .submit(
                transaction(
                    1,
                    vec![Command::SetPaintStyle {
                        style: changed_paint.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(paint_document.paint_style(&paint.id), Some(&changed_paint));
        assert_ne!(paint_document.canonical_hash(), paint_hash_before_update);
        paint_document.undo().unwrap();
        assert_eq!(paint_document.paint_style(&paint.id), Some(&paint));
        paint_document.redo().unwrap();
        assert_eq!(paint_document.paint_style(&paint.id), Some(&changed_paint));
        paint_document
            .submit(
                transaction(
                    paint_document.revision,
                    vec![Command::DeletePaintStyle {
                        id: paint.id.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert!(paint_document.paint_style(&paint.id).is_none());
        paint_document.undo().unwrap();
        assert_eq!(paint_document.paint_style(&paint.id), Some(&changed_paint));
        paint_document.redo().unwrap();
        assert!(paint_document.paint_style(&paint.id).is_none());

        let mut invalid_scheme = text_style_resource("S:invalid-scheme");
        invalid_scheme.documentation_links = vec!["javascript:alert(1)".into()];
        assert_eq!(
            Document::empty().seed_text_style(invalid_scheme),
            Err(CommandError::InvalidTextStyle)
        );
        let mut too_many_links = paint_style_resource("S:too-many-links");
        too_many_links.documentation_links = vec![
            "https://example.com/one".into(),
            "https://example.com/two".into(),
        ];
        assert_eq!(
            Document::empty().seed_paint_style(too_many_links),
            Err(CommandError::InvalidPaintStyle)
        );
        let mut invalid_percent = text_style_resource("S:invalid-percent");
        invalid_percent.style.letter_spacing = -101.0;
        invalid_percent.letter_spacing_unit = Some(TextStyleLetterSpacingUnit::Percent);
        assert_eq!(
            Document::empty().seed_text_style(invalid_percent),
            Err(CommandError::InvalidTextStyle)
        );
    }

    #[test]
    fn local_styles_must_be_unlinked_before_deletion() {
        let mut text = node(191);
        text.kind = NodeKind::Text;
        text.text = "A".into();
        let text_style = text_style_resource("S:body");
        let paint_style = paint_style_resource("S:brand");
        let mut run = text_style.style.clone();
        run.end = 1;
        run.text_style_id = Some(text_style.id.clone());
        run.paint_style_id = Some(paint_style.id.clone());
        let linked_properties = TextProperties {
            runs: vec![run],
            ..TextProperties::default()
        };
        let linked_paints = PaintStyleLinks {
            fill: Some(paint_style.id.clone()),
            stroke: None,
            background: None,
        };
        let mut document = Document::empty();
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(text),
                        Command::RegisterTextStyle {
                            style: text_style.clone(),
                        },
                        Command::RegisterPaintStyle {
                            style: paint_style.clone(),
                        },
                        Command::SetTextProperties {
                            id: NodeId(191),
                            properties: linked_properties.clone(),
                        },
                        Command::SetPaintStyleLinks {
                            id: NodeId(191),
                            links: linked_paints,
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let linked_hash = document.canonical_hash_hex();

        assert_eq!(
            document.submit(
                transaction(
                    document.revision,
                    vec![Command::DeleteTextStyle {
                        id: text_style.id.clone(),
                    }],
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidTextStyle)
        );
        assert_eq!(
            document.submit(
                transaction(
                    document.revision,
                    vec![Command::DeletePaintStyle {
                        id: paint_style.id.clone(),
                    }],
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidPaintStyle)
        );
        assert_eq!(document.canonical_hash_hex(), linked_hash);

        let mut unlinked_properties = linked_properties;
        unlinked_properties.runs[0].text_style_id = None;
        unlinked_properties.runs[0].paint_style_id = None;
        document
            .submit(
                transaction(
                    document.revision,
                    vec![
                        Command::SetTextProperties {
                            id: NodeId(191),
                            properties: unlinked_properties,
                        },
                        Command::SetPaintStyleLinks {
                            id: NodeId(191),
                            links: PaintStyleLinks::default(),
                        },
                        Command::DeleteTextStyle {
                            id: text_style.id.clone(),
                        },
                        Command::DeletePaintStyle {
                            id: paint_style.id.clone(),
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert!(document.text_style(&text_style.id).is_none());
        assert!(document.paint_style(&paint_style.id).is_none());
    }

    #[test]
    fn paint_style_links_are_hashed_undoable_and_follow_tombstones() {
        let mut document = Document::empty();
        document
            .submit(
                transaction(0, vec![Command::Create(node(1))]),
                Origin::LocalUser,
            )
            .unwrap();
        let baseline = document.canonical_hash_hex();
        let links = PaintStyleLinks {
            fill: Some("S:surface".into()),
            stroke: Some("S:border".into()),
            background: Some("S:surface".into()),
        };
        document
            .submit(
                transaction(
                    document.revision,
                    vec![Command::SetPaintStyleLinks {
                        id: NodeId(1),
                        links: links.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(document.paint_style_links_for_node(NodeId(1)), Some(&links));
        assert_ne!(document.canonical_hash_hex(), baseline);
        document.undo().unwrap();
        assert!(document.paint_style_links_for_node(NodeId(1)).is_none());
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(document.paint_style_links_for_node(NodeId(1)), Some(&links));

        document
            .submit(
                transaction(document.revision, vec![Command::Delete { id: NodeId(1) }]),
                Origin::LocalUser,
            )
            .unwrap();
        assert!(document.paint_style_links_for_node(NodeId(1)).is_none());
        document.undo().unwrap();
        assert_eq!(document.paint_style_links_for_node(NodeId(1)), Some(&links));
    }

    #[test]
    fn background_style_link_is_limited_to_frame_like_nodes() {
        let mut rectangle = node(2);
        rectangle.kind = NodeKind::Rectangle;
        let mut document = Document::empty();
        document
            .submit(
                transaction(0, vec![Command::Create(rectangle)]),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document.submit(
                transaction(
                    document.revision,
                    vec![Command::SetPaintStyleLinks {
                        id: NodeId(2),
                        links: PaintStyleLinks {
                            fill: Some("S:surface".into()),
                            stroke: None,
                            background: Some("S:surface".into()),
                        },
                    }],
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidPaintStyleLinks)
        );
    }

    #[test]
    fn localized_font_aliases_are_canonical_bounded_and_version_visible() {
        let base = AssetReference {
            asset_id: AssetId(12),
            content_hash: [4; 32],
            media_type: "font/ttf".into(),
            byte_length: 512,
            dimensions: None,
            font_faces: vec![FontFaceMetadata {
                face_index: 0,
                family: "Acme Sans".into(),
                style: "Regular".into(),
                aliases: Vec::new(),
            }],
        };
        let mut legacy = Document::empty();
        legacy.seed_asset(base.clone()).unwrap();

        let mut localized_asset = base.clone();
        localized_asset.font_faces[0].aliases = vec![FontNameAlias {
            family: "艾克米黑体".into(),
            style: "常规".into(),
        }];
        let mut localized = Document::empty();
        localized.seed_asset(localized_asset.clone()).unwrap();
        assert_ne!(legacy.canonical_hash(), localized.canonical_hash());

        for aliases in [
            vec![FontNameAlias {
                family: "Acme Sans".into(),
                style: "Regular".into(),
            }],
            vec![
                FontNameAlias {
                    family: "Alias".into(),
                    style: "Regular".into(),
                },
                FontNameAlias {
                    family: "Alias".into(),
                    style: "Regular".into(),
                },
            ],
            (0..65)
                .map(|index| FontNameAlias {
                    family: format!("Alias {index:02}"),
                    style: "Regular".into(),
                })
                .collect(),
        ] {
            let mut invalid = localized_asset.clone();
            invalid.asset_id = AssetId(13);
            invalid.font_faces[0].aliases = aliases;
            assert_eq!(
                Document::empty().seed_asset(invalid),
                Err(CommandError::InvalidAsset)
            );
        }
    }

    #[test]
    fn versioned_paint_stacks_preserve_presence_hash_and_history() {
        use crate::color::{ImagePaint, PaintLayer, PaintLayerKind};

        let asset = AssetReference {
            asset_id: AssetId(77),
            content_hash: [7; 32],
            media_type: "image/png".into(),
            byte_length: 64,
            dimensions: Some([4, 4]),
            font_faces: Vec::new(),
        };
        let mut document = Document::empty();
        document.seed_asset(asset.clone()).unwrap();
        document.seed_node(node(78)).unwrap();
        let legacy_hash = document.canonical_hash_hex();

        document
            .submit(
                Transaction {
                    id: TransactionId(780),
                    base_revision: 0,
                    commands: vec![Command::SetPaintStacks {
                        id: NodeId(78),
                        fill_stack: Some(PaintStack::default()),
                        stroke_stack: Some(PaintStack {
                            layers: vec![PaintLayer {
                                paint: PaintLayerKind::Image(ImagePaint {
                                    asset_id: asset.asset_id,
                                    scale_mode: ImageScaleMode::Fit,
                                    transform: AffineTransform::IDENTITY,
                                    rotation_degrees: 90,
                                    filters: None,
                                }),
                                visible: false,
                                opacity: 0.5,
                                blend_mode: BlendMode::Multiply,
                            }],
                        }),
                    }],
                },
                Origin::LocalUser,
            )
            .unwrap();

        assert_eq!(
            document.fill_stack_for_node(NodeId(78)),
            Some(&PaintStack::default())
        );
        assert_eq!(
            document
                .stroke_stack_for_node(NodeId(78))
                .unwrap()
                .layers
                .len(),
            1
        );
        let stacked_hash = document.canonical_hash_hex();
        assert_ne!(stacked_hash, legacy_hash);

        document.undo().unwrap();
        assert_eq!(document.fill_stack_for_node(NodeId(78)), None);
        assert_eq!(document.stroke_stack_for_node(NodeId(78)), None);
        assert_eq!(document.canonical_hash_hex(), legacy_hash);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), stacked_hash);
        assert!(matches!(
            &document.stroke_stack_for_node(NodeId(78)).unwrap().layers[0].paint,
            PaintLayerKind::Image(ImagePaint {
                rotation_degrees: 90,
                ..
            })
        ));

        document
            .submit(
                Transaction {
                    id: TransactionId(781),
                    base_revision: document.revision,
                    commands: vec![Command::Delete { id: NodeId(78) }],
                },
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(document.fill_stack_for_node(NodeId(78)), None);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), stacked_hash);
    }

    #[test]
    fn registered_asset_is_hashed_undoable_and_never_accepts_partial_dimensions() {
        let asset = AssetReference {
            asset_id: AssetId(9),
            content_hash: [4; 32],
            media_type: "image/png".into(),
            byte_length: 128,
            dimensions: Some([16, 8]),
            font_faces: Vec::new(),
        };
        let mut document = Document::empty();
        let baseline = document.canonical_hash_hex();
        document
            .submit(
                transaction(
                    0,
                    vec![Command::RegisterAsset {
                        asset: asset.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(document.asset(asset.asset_id), Some(&asset));
        assert_ne!(document.canonical_hash_hex(), baseline);
        document.undo().unwrap();
        assert_eq!(document.asset(asset.asset_id), None);
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(document.asset(asset.asset_id), Some(&asset));
    }

    #[test]
    fn image_nodes_reference_registered_image_assets_and_restore_through_history() {
        let asset = AssetReference {
            asset_id: AssetId(10),
            content_hash: [5; 32],
            media_type: "image/png".into(),
            byte_length: 256,
            dimensions: Some([64, 32]),
            font_faces: Vec::new(),
        };
        let mut document = Document::empty();
        document
            .submit(
                transaction(
                    0,
                    vec![Command::RegisterAsset {
                        asset: asset.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let resource_hash = document.canonical_hash_hex();
        let mut image = node(11);
        image.kind = NodeKind::Image;
        document
            .submit(
                transaction(
                    1,
                    vec![Command::CreateImageInPage {
                        page_id: DEFAULT_PAGE_ID,
                        node: image,
                        asset_id: asset.asset_id,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(document.asset_for_node(NodeId(11)), Some(asset.asset_id));
        assert_ne!(document.canonical_hash_hex(), resource_hash);

        document.undo().unwrap();
        assert_eq!(document.node(NodeId(11)), None);
        assert_eq!(document.asset_for_node(NodeId(11)), None);
        assert_ne!(document.canonical_hash_hex(), resource_hash);

        document.redo().unwrap();
        assert_eq!(document.asset_for_node(NodeId(11)), Some(asset.asset_id));
    }

    #[test]
    fn shape_image_fills_are_canonical_and_undoable() {
        let asset = AssetReference {
            asset_id: AssetId(11),
            content_hash: [8; 32],
            media_type: "image/png".into(),
            byte_length: 128,
            dimensions: Some([16, 8]),
            font_faces: Vec::new(),
        };
        let mut document = Document::empty();
        document.seed_asset(asset.clone()).unwrap();
        document
            .submit(
                transaction(0, vec![Command::Create(node(1))]),
                Origin::LocalUser,
            )
            .unwrap();
        let baseline = document.canonical_hash_hex();
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetNodeAsset {
                        id: NodeId(1),
                        asset_id: Some(asset.asset_id),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(document.asset_for_node(NodeId(1)), Some(asset.asset_id));
        assert_ne!(document.canonical_hash_hex(), baseline);
        document.undo();
        assert_eq!(document.asset_for_node(NodeId(1)), None);
        document.redo();
        assert_eq!(document.asset_for_node(NodeId(1)), Some(asset.asset_id));
    }

    #[test]
    fn stroke_and_width_are_canonical_hashed_and_undoable() {
        let mut document = Document::empty();
        document
            .submit(
                transaction(0, vec![Command::Create(node(1))]),
                Origin::LocalUser,
            )
            .unwrap();
        let baseline_hash = document.canonical_hash_hex();

        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetAppearance {
                        id: NodeId(1),
                        appearance: Appearance {
                            fill: "#fff".into(),
                            stroke: "#2563eb".into(),
                            fills: Vec::new(),
                            strokes: Vec::new(),
                            stroke_width: 3.0,
                            stroke_cap_start: Default::default(),
                            stroke_cap_end: StrokeCap::ArrowLines,
                            stroke_join: Default::default(),
                            stroke_miter_limit: DEFAULT_STROKE_MITER_LIMIT,
                            stroke_dash_pattern: Vec::new(),
                            stroke_weights: Vec::new(),
                            stroke_align: Default::default(),
                            arc_data: None,
                            parametric_shape: None,
                            relative_transform: None,
                            opacity: 1.0,
                            blend_mode: BlendMode::Normal,
                            drop_shadow: None,
                            effect_stack: Vec::new(),
                            corner_radius: 0.0,
                            corner_radii: Vec::new(),
                            corner_smoothing: 0.0,
                            constraints: None,
                            visible: true,
                            locked: false,
                            contents_hidden: false,
                            clips_content: Some(false),
                        },
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document.node(NodeId(1)).unwrap().stroke,
            Paint::Solid(Color::from_srgb_u8([37, 99, 235], 255))
        );
        assert_eq!(document.node(NodeId(1)).unwrap().stroke_width, 3.0);
        assert_eq!(
            document.node(NodeId(1)).unwrap().stroke_cap_end,
            StrokeCap::ArrowLines
        );
        assert_ne!(document.canonical_hash_hex(), baseline_hash);

        document.undo().unwrap();
        assert_eq!(document.node(NodeId(1)).unwrap().stroke_width, 0.0);
        assert_eq!(
            document.node(NodeId(1)).unwrap().stroke_cap_end,
            StrokeCap::None
        );
        assert_eq!(document.canonical_hash_hex(), baseline_hash);
        document.redo().unwrap();
        assert_eq!(document.node(NodeId(1)).unwrap().stroke_width, 3.0);
        assert_eq!(
            document.node(NodeId(1)).unwrap().stroke_cap_end,
            StrokeCap::ArrowLines
        );
    }

    #[test]
    fn document_color_profile_is_hashed_undoable_and_operation_hashed() {
        let mut document = Document::empty();
        let srgb_hash = document.canonical_hash_hex();
        let transaction = Transaction {
            id: TransactionId(77),
            base_revision: 0,
            commands: vec![Command::SetDocumentColorProfile {
                profile: DocumentColorProfile::DisplayP3,
            }],
        };
        let payload_hash = OperationEnvelope::payload_hash_for(&transaction);
        document.submit(transaction, Origin::LocalUser).unwrap();
        assert_eq!(document.color_profile(), DocumentColorProfile::DisplayP3);
        assert_ne!(document.canonical_hash_hex(), srgb_hash);

        let different_payload = OperationEnvelope::payload_hash_for(&Transaction {
            id: TransactionId(78),
            base_revision: 0,
            commands: vec![Command::SetDocumentColorProfile {
                profile: DocumentColorProfile::Srgb,
            }],
        });
        assert_ne!(payload_hash, different_payload);
        document.undo().unwrap();
        assert_eq!(document.color_profile(), DocumentColorProfile::Srgb);
        assert_eq!(document.canonical_hash_hex(), srgb_hash);
        document.redo().unwrap();
        assert_eq!(document.color_profile(), DocumentColorProfile::DisplayP3);
    }

    #[test]
    fn linear_gradient_is_canonical_hashed_and_undoable() {
        let gradient = crate::color::LinearGradient::new(
            [0.0, 0.0],
            [1.0, 1.0],
            vec![
                crate::color::GradientStop {
                    position: 0.0,
                    color: Color::from_srgb_u8([16, 24, 48], 255),
                },
                crate::color::GradientStop {
                    position: 1.0,
                    color: Color::from_srgb_u8([112, 224, 192], 204),
                },
            ],
        )
        .unwrap();
        let mut gradient_node = node(1);
        gradient_node.fill = Paint::LinearGradient(gradient.clone());
        let mut document = Document::empty();
        document
            .submit(
                transaction(0, vec![Command::Create(gradient_node)]),
                Origin::LocalUser,
            )
            .unwrap();
        let gradient_hash = document.canonical_hash_hex();
        let gradient_bytes = document.memory_stats().node_bytes;
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetAppearance {
                        id: NodeId(1),
                        appearance: Appearance {
                            fill: "#ffffff".into(),
                            stroke: "#00000000".into(),
                            fills: Vec::new(),
                            strokes: Vec::new(),
                            stroke_width: 0.0,
                            stroke_cap_start: Default::default(),
                            stroke_cap_end: Default::default(),
                            stroke_join: Default::default(),
                            stroke_miter_limit: DEFAULT_STROKE_MITER_LIMIT,
                            stroke_dash_pattern: Vec::new(),
                            stroke_weights: Vec::new(),
                            stroke_align: Default::default(),
                            arc_data: None,
                            parametric_shape: None,
                            relative_transform: None,
                            opacity: 1.0,
                            blend_mode: BlendMode::Normal,
                            drop_shadow: None,
                            effect_stack: Vec::new(),
                            corner_radius: 0.0,
                            corner_radii: Vec::new(),
                            corner_smoothing: 0.0,
                            constraints: None,
                            visible: true,
                            locked: false,
                            contents_hidden: false,
                            clips_content: Some(false),
                        },
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_ne!(document.canonical_hash_hex(), gradient_hash);
        assert!(document.memory_stats().node_bytes < gradient_bytes);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), gradient_hash);
        assert_eq!(document.memory_stats().node_bytes, gradient_bytes);
        assert_eq!(
            document.node(NodeId(1)).unwrap().fill,
            Paint::LinearGradient(gradient)
        );
    }

    #[test]
    fn position_ids_define_deterministic_sibling_order_and_gap_allocation() {
        let left = PositionId {
            key: 10,
            actor: ActorId(1),
        };
        let right = PositionId {
            key: 20,
            actor: ActorId(2),
        };
        assert_eq!(
            PositionId::between(Some(left), Some(right), ActorId(9)).unwrap(),
            PositionId {
                key: 15,
                actor: ActorId(9)
            }
        );
        assert_eq!(
            PositionId::between(
                Some(left),
                Some(PositionId {
                    key: 11,
                    actor: ActorId(2)
                }),
                ActorId(9)
            ),
            Err(PositionError::NoSpaceBetween)
        );

        let mut document = Document::empty();
        let mut parent = node(1);
        parent.position = PositionId {
            key: 50,
            actor: ActorId(0),
        };
        let mut later = node(2);
        later.parent_id = Some(NodeId(1));
        later.position = PositionId {
            key: 20,
            actor: ActorId(1),
        };
        let mut earlier = node(3);
        earlier.parent_id = Some(NodeId(1));
        earlier.position = PositionId {
            key: 10,
            actor: ActorId(2),
        };
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(parent),
                        Command::Create(later),
                        Command::Create(earlier),
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document
                .ordered_nodes()
                .iter()
                .map(|node| node.id)
                .collect::<Vec<_>>(),
            vec![NodeId(1), NodeId(3), NodeId(2)]
        );
        assert_eq!(
            document
                .position_between(
                    Some(NodeId(1)),
                    Some(NodeId(3)),
                    Some(NodeId(2)),
                    ActorId(4)
                )
                .unwrap(),
            PositionId {
                key: 15,
                actor: ActorId(4)
            }
        );
        let hash_before_rejected_reorder = document.canonical_hash();
        assert_eq!(
            document.submit(
                transaction(
                    1,
                    vec![Command::SetNodePosition {
                        id: NodeId(2),
                        position: PositionId {
                            key: 10,
                            actor: ActorId(2),
                        },
                    }],
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::DuplicatePosition {
                parent_id: Some(NodeId(1)),
                position: PositionId {
                    key: 10,
                    actor: ActorId(2),
                },
            })
        );
        assert_eq!(document.canonical_hash(), hash_before_rejected_reorder);
    }

    #[test]
    fn reparent_is_atomic_hashable_and_undoable_without_moving_world_geometry() {
        let mut document = Document::empty();
        let parent = node(1);
        let mut child = node(2);
        child.x = 48.0;
        child.y = 72.0;
        document
            .submit(
                transaction(0, vec![Command::Create(parent), Command::Create(child)]),
                Origin::LocalUser,
            )
            .unwrap();
        let baseline = document.canonical_hash_hex();
        let position = PositionId {
            key: 7,
            actor: ActorId(9),
        };
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetNodeParent {
                        id: NodeId(2),
                        parent_id: Some(NodeId(1)),
                        position,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let child = document.node(NodeId(2)).unwrap();
        assert_eq!(child.parent_id, Some(NodeId(1)));
        assert_eq!(child.position, position);
        assert_eq!((child.x, child.y), (48.0, 72.0));
        assert_ne!(document.canonical_hash_hex(), baseline);
        document.undo().unwrap();
        assert_eq!(document.node(NodeId(2)).unwrap().parent_id, None);
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(document.node(NodeId(2)).unwrap().parent_id, Some(NodeId(1)));
    }

    #[test]
    fn group_bounds_follow_child_geometry_and_undo_redo_exactly() {
        let mut document = Document::empty();
        let mut group = node(1);
        group.kind = NodeKind::Group;
        let mut child = node(2);
        child.parent_id = Some(NodeId(1));
        document
            .submit(
                transaction(0, vec![Command::Create(group), Command::Create(child)]),
                Origin::LocalUser,
            )
            .unwrap();
        let grouped_hash = document.canonical_hash_hex();
        document
            .submit(
                transaction(
                    1,
                    vec![Command::UpdateGeometry {
                        id: NodeId(2),
                        x: 10.0,
                        y: 20.0,
                        width: 30.0,
                        height: 40.0,
                        rotation: 0.0,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let group = document.node(NodeId(1)).unwrap();
        assert_eq!(
            (group.x, group.y, group.width, group.height, group.rotation),
            (10.0, 20.0, 30.0, 40.0, 0.0)
        );
        let updated_hash = document.canonical_hash_hex();
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), grouped_hash);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), updated_hash);
    }

    #[test]
    fn moving_a_grouped_child_via_relative_transform_moves_cleanly_and_undo_redo_exactly() {
        // A grouped child is Relative-v1, so a move arrives as SetAppearance with
        // a new relative_transform (never UpdateGeometry). Storing that transform
        // is the whole fix for "grouped child cannot move": the child must land
        // exactly where dropped with no compounding jump, and undo/redo must be
        // canonical-hash exact. The Group is created at the origin so its legacy
        // frame transform is the identity — exactly the anchor the client
        // preserves via translateNodeWorldPatch against the Group's pre-move world.
        let mut document = Document::empty();
        let mut group = node(1);
        group.kind = NodeKind::Group;
        group.name = "Group".into();
        group.x = 0.0;
        group.y = 0.0;
        let mut child = node(2);
        child.parent_id = Some(NodeId(1));
        child.width = 30.0;
        child.height = 40.0;
        child.relative_transform = Some(AffineTransform {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            e: 100.0,
            f: 50.0,
        });
        document
            .submit(
                transaction(0, vec![Command::Create(group), Command::Create(child)]),
                Origin::LocalUser,
            )
            .unwrap();
        // Before the move the child's world origin is its local origin.
        assert_eq!(
            (
                document.node_world_transform(NodeId(2)).unwrap().e,
                document.node_world_transform(NodeId(2)).unwrap().f
            ),
            (100.0, 50.0)
        );
        let grouped_hash = document.canonical_hash_hex();

        // Move the child by (+40, +40): against the identity frame the new local
        // origin is simply the new world origin.
        let mut appearance = appearance_for_node(document.node(NodeId(2)).unwrap());
        appearance.relative_transform = Some(AffineTransform {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            e: 140.0,
            f: 90.0,
        });
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetAppearance {
                        id: NodeId(2),
                        appearance,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();

        // The child lands exactly where dropped — no compounding jump from a
        // spurious Group-box refresh dragging the anchor.
        assert_eq!(
            (
                document.node_world_transform(NodeId(2)).unwrap().e,
                document.node_world_transform(NodeId(2)).unwrap().f
            ),
            (140.0, 90.0)
        );
        let moved_hash = document.canonical_hash_hex();
        assert_ne!(moved_hash, grouped_hash);

        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), grouped_hash);
        assert_eq!(
            (
                document.node_world_transform(NodeId(2)).unwrap().e,
                document.node_world_transform(NodeId(2)).unwrap().f
            ),
            (100.0, 50.0)
        );
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), moved_hash);
        assert_eq!(
            (
                document.node_world_transform(NodeId(2)).unwrap().e,
                document.node_world_transform(NodeId(2)).unwrap().f
            ),
            (140.0, 90.0)
        );
    }

    #[test]
    fn moving_one_relative_group_keeps_other_groups_independent() {
        let mut document = Document::empty();
        let mut first_group = node(1);
        first_group.kind = NodeKind::Group;
        first_group.name = "First group".into();
        first_group.x = 10.0;
        first_group.y = 20.0;
        first_group.width = 30.0;
        first_group.height = 20.0;
        let mut first_child = node(2);
        first_child.parent_id = Some(NodeId(1));
        first_child.width = 30.0;
        first_child.height = 20.0;
        first_child.relative_transform = Some(AffineTransform::IDENTITY);

        let mut second_group = node(3);
        second_group.kind = NodeKind::Group;
        second_group.name = "Second group".into();
        second_group.x = 200.0;
        second_group.y = 220.0;
        second_group.width = 40.0;
        second_group.height = 20.0;
        let mut second_child = node(4);
        second_child.parent_id = Some(NodeId(3));
        second_child.width = 40.0;
        second_child.height = 20.0;
        second_child.relative_transform = Some(AffineTransform::IDENTITY);

        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(first_group),
                        Command::Create(first_child),
                        Command::Create(second_group),
                        Command::Create(second_child),
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        document
            .submit(
                transaction(
                    1,
                    vec![Command::UpdateGeometry {
                        id: NodeId(1),
                        x: 50.0,
                        y: 60.0,
                        width: 30.0,
                        height: 20.0,
                        rotation: 0.0,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();

        assert_eq!(
            (
                document.node(NodeId(1)).unwrap().x,
                document.node(NodeId(1)).unwrap().y
            ),
            (50.0, 60.0)
        );
        assert_eq!(
            (
                document.node(NodeId(3)).unwrap().x,
                document.node(NodeId(3)).unwrap().y
            ),
            (200.0, 220.0)
        );
        assert_eq!(document.node_world_transform(NodeId(2)).unwrap().e, 50.0);
        assert_eq!(document.node_world_transform(NodeId(2)).unwrap().f, 60.0);
        assert_eq!(document.node_world_transform(NodeId(4)).unwrap().e, 200.0);
        assert_eq!(document.node_world_transform(NodeId(4)).unwrap().f, 220.0);
    }

    #[test]
    fn group_bounds_use_a_child_relative_transform_during_dual_read() {
        let mut document = Document::empty();
        let mut group = node(1);
        group.kind = NodeKind::Group;
        group.name = "Group".into();
        let mut child = node(2);
        child.parent_id = Some(NodeId(1));
        child.x = 0.0;
        child.y = 0.0;
        child.width = 30.0;
        child.height = 40.0;
        child.relative_transform = Some(AffineTransform {
            a: 0.0,
            b: 1.0,
            c: -1.0,
            d: 0.0,
            e: 100.0,
            f: 50.0,
        });
        document
            .submit(
                transaction(0, vec![Command::Create(group), Command::Create(child)]),
                Origin::LocalUser,
            )
            .unwrap();

        document
            .submit(
                transaction(
                    1,
                    vec![Command::UpdateGeometry {
                        id: NodeId(2),
                        x: 0.0,
                        y: 0.0,
                        width: 30.0,
                        height: 40.0,
                        rotation: 0.0,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let group = document.node(NodeId(1)).unwrap();
        assert_eq!(
            (group.x, group.y, group.width, group.height),
            (60.0, 50.0, 40.0, 30.0)
        );
    }

    #[test]
    fn moving_the_last_child_out_dissolves_its_group_and_is_undoable() {
        let mut document = Document::empty();
        let mut group = node(1);
        group.kind = NodeKind::Group;
        let mut child = node(2);
        child.parent_id = Some(NodeId(1));
        document
            .submit(
                transaction(0, vec![Command::Create(group), Command::Create(child)]),
                Origin::LocalUser,
            )
            .unwrap();
        let grouped_hash = document.canonical_hash_hex();
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetNodeParent {
                        id: NodeId(2),
                        parent_id: None,
                        position: PositionId {
                            key: 3,
                            actor: ActorId(1),
                        },
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert!(document.node(NodeId(1)).is_none());
        assert_eq!(document.node(NodeId(2)).unwrap().parent_id, None);
        let dissolved_hash = document.canonical_hash_hex();
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), grouped_hash);
        assert_eq!(document.node(NodeId(2)).unwrap().parent_id, Some(NodeId(1)));
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), dissolved_hash);
    }

    #[test]
    fn children_index_tracks_hydration_reorder_reparent_delete_and_history() {
        let mut document = Document::empty();
        let page_two = Page {
            id: PageId(2),
            name: "Page 2".into(),
            position: PositionId::for_node(NodeId(2)),
        };
        document.seed_page(page_two).unwrap();

        let mut page_two_parent = node(100);
        page_two_parent.kind = NodeKind::Group;
        page_two_parent.name = "Page two parent".into();
        document
            .seed_node_on_page(PageId(2), page_two_parent)
            .unwrap();
        let mut later_child = node(102);
        later_child.parent_id = Some(NodeId(100));
        later_child.position = PositionId {
            key: 20,
            actor: ActorId(1),
        };
        document.seed_node_on_page(PageId(2), later_child).unwrap();
        let mut earlier_child = node(101);
        earlier_child.parent_id = Some(NodeId(100));
        earlier_child.position = PositionId {
            key: 10,
            actor: ActorId(1),
        };
        document
            .seed_node_on_page(PageId(2), earlier_child)
            .unwrap();

        assert_eq!(
            document
                .ordered_children(PageId(2), Some(NodeId(100)))
                .unwrap()
                .into_iter()
                .map(|node| node.id)
                .collect::<Vec<_>>(),
            vec![NodeId(101), NodeId(102)]
        );
        let hash_before_validation = document.canonical_hash();
        document.validate_seeded_structure().unwrap();
        assert_eq!(document.canonical_hash(), hash_before_validation);
        assert_children_index_matches_nodes(&document);

        let parent = node(1);
        let mut child_two = node(2);
        child_two.parent_id = Some(NodeId(1));
        let mut child_three = node(3);
        child_three.parent_id = Some(NodeId(1));
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(parent),
                        Command::Create(child_two),
                        Command::Create(child_three),
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_children_index_matches_nodes(&document);

        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetNodePosition {
                        id: NodeId(3),
                        position: PositionId {
                            key: 1,
                            actor: ActorId(9),
                        },
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document
                .ordered_children(DEFAULT_PAGE_ID, Some(NodeId(1)))
                .unwrap()
                .into_iter()
                .map(|node| node.id)
                .collect::<Vec<_>>(),
            vec![NodeId(3), NodeId(2)]
        );
        assert_children_index_matches_nodes(&document);

        document
            .submit(
                transaction(
                    2,
                    vec![Command::SetNodeParent {
                        id: NodeId(3),
                        parent_id: None,
                        position: PositionId {
                            key: 30,
                            actor: ActorId(9),
                        },
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_children_index_matches_nodes(&document);

        document
            .submit(
                transaction(3, vec![Command::Delete { id: NodeId(2) }]),
                Origin::LocalUser,
            )
            .unwrap();
        assert_children_index_matches_nodes(&document);
        document.undo().unwrap();
        assert_children_index_matches_nodes(&document);
        document.redo().unwrap();
        assert_children_index_matches_nodes(&document);

        let before = document.clone();
        assert!(
            document
                .submit(
                    transaction(
                        document.revision,
                        vec![Command::SetNodePosition {
                            id: NodeId(3),
                            position: PositionId::for_node(NodeId(1)),
                        }],
                    ),
                    Origin::LocalUser,
                )
                .is_err()
        );
        assert_eq!(document, before);
        assert_children_index_matches_nodes(&document);
    }

    #[test]
    fn children_index_matches_full_scan_after_randomized_structural_history() {
        let mut document = Document::empty();
        let mut commands = Vec::new();
        for id in 1..=20 {
            commands.push(Command::Create(node(id)));
        }
        for id in 21..=100 {
            let mut child = node(id);
            child.kind = NodeKind::Rectangle;
            child.parent_id = Some(NodeId(1 + (id % 20)));
            commands.push(Command::Create(child));
        }
        document
            .submit(transaction(0, commands), Origin::LocalUser)
            .unwrap();

        let mut random = 0x4d59_5df4_d0f3_3173u64;
        for step in 0..300u128 {
            random = random
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            let child_id = NodeId(21 + u128::from(random % 80));
            random = random
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            let parent_id = match random % 21 {
                0 => None,
                value => Some(NodeId(u128::from(value))),
            };
            let revision = document.revision;
            document
                .submit(
                    transaction(
                        revision,
                        vec![Command::SetNodeParent {
                            id: child_id,
                            parent_id,
                            position: PositionId {
                                key: 10_000 + step,
                                actor: ActorId(77),
                            },
                        }],
                    ),
                    Origin::LocalUser,
                )
                .unwrap();
            assert_children_index_matches_nodes(&document);

            if step % 25 == 0 {
                let revision = document.revision;
                document
                    .submit(
                        transaction(revision, vec![Command::Delete { id: child_id }]),
                        Origin::LocalUser,
                    )
                    .unwrap();
                assert_children_index_matches_nodes(&document);
                document.undo().unwrap();
                assert_children_index_matches_nodes(&document);
                document.redo().unwrap();
                assert_children_index_matches_nodes(&document);
                document.undo().unwrap();
                assert_children_index_matches_nodes(&document);
            }
        }
    }

    #[test]
    fn children_index_scales_to_the_document_node_limit() {
        let mut document = Document::empty();
        let mut next_id = 1u128;
        for _ in 0..20_000 {
            let group_id = NodeId(next_id);
            let mut group = node(next_id);
            group.kind = NodeKind::Group;
            document.seed_node(group).unwrap();
            next_id += 1;
            let mut child = node(next_id);
            child.kind = NodeKind::Rectangle;
            child.parent_id = Some(group_id);
            document.seed_node(child).unwrap();
            next_id += 1;
        }
        for _ in 0..20_000 {
            let boolean_id = NodeId(next_id);
            let mut boolean = node(next_id);
            boolean.kind = NodeKind::BooleanOperation;
            boolean.boolean_operation = Some(BooleanOperation::Union);
            document.seed_node(boolean).unwrap();
            next_id += 1;
            for _ in 0..2 {
                let mut operand = node(next_id);
                operand.kind = NodeKind::Rectangle;
                operand.parent_id = Some(boolean_id);
                document.seed_node(operand).unwrap();
                next_id += 1;
            }
        }

        assert_eq!(next_id - 1, MAX_DOCUMENT_NODES as u128);
        document.validate_seeded_structure().unwrap();
        assert!(document.structural_validation_pending.is_empty());
        let roots = document.ordered_children(DEFAULT_PAGE_ID, None).unwrap();
        assert_eq!(roots.len(), 40_000);
        assert_eq!(roots.first().map(|node| node.id), Some(NodeId(1)));
        assert_eq!(
            document
                .ordered_nodes_on_page(DEFAULT_PAGE_ID)
                .unwrap()
                .len(),
            MAX_DOCUMENT_NODES
        );
        assert_children_index_matches_nodes(&document);

        document
            .submit(
                transaction(
                    0,
                    vec![Command::Rename {
                        id: NodeId(1),
                        name: "Renamed group".into(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert!(document.structural_validation_pending.is_empty());
    }

    #[test]
    fn transaction_rejects_an_empty_group_without_mutating_document_state() {
        let mut document = Document::empty();
        let mut group = node(1);
        group.kind = NodeKind::Group;
        group.name = "Empty group".into();
        let before_hash = document.canonical_hash_hex();

        assert_eq!(
            document.submit(
                transaction(0, vec![Command::Create(group)]),
                Origin::LocalUser
            ),
            Err(CommandError::EmptyGroup { id: NodeId(1) }),
        );
        assert_eq!(document.revision, 0);
        assert_eq!(document.canonical_hash_hex(), before_hash);
        assert!(document.node(NodeId(1)).is_none());
    }

    #[test]
    fn deleting_a_multi_level_frame_subtree_is_atomic_and_fully_restored_by_undo() {
        // Plan 12.2 scenario 5: a Frame with multiple levels of children is deleted
        // child-first in one transaction; Undo must restore IDs, sibling order, the
        // parent hierarchy, and every property exactly.
        let mut document = Document::empty();
        let mut outer = node(1);
        outer.name = "Outer".into();
        let mut inner = node(2);
        inner.name = "Inner".into();
        inner.parent_id = Some(NodeId(1));
        inner.x = 10.0;
        inner.y = 10.0;
        let mut rect = node(3);
        rect.kind = NodeKind::Rectangle;
        rect.name = "Rect".into();
        rect.parent_id = Some(NodeId(2));
        rect.corner_radii = vec![4.0, 8.0, 12.0, 16.0];
        let mut ellipse = node(4);
        ellipse.kind = NodeKind::Ellipse;
        ellipse.name = "Ellipse".into();
        ellipse.parent_id = Some(NodeId(2));
        ellipse.x = 40.0;
        let mut text = node(5);
        text.kind = NodeKind::Text;
        text.name = "Text".into();
        text.parent_id = Some(NodeId(1));
        text.text = "Hi".into();
        text.y = 80.0;
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(outer),
                        Command::Create(inner),
                        Command::Create(rect),
                        Command::Create(ellipse),
                        Command::Create(text),
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();

        let ordered_before: Vec<(NodeId, Option<NodeId>)> = document
            .ordered_nodes_on_page(DEFAULT_PAGE_ID)
            .unwrap()
            .iter()
            .map(|n| (n.id, n.parent_id))
            .collect();
        let rect_radii_before = document.node(NodeId(3)).unwrap().corner_radii.clone();
        let built_hash = document.canonical_hash_hex();

        // Child-first single-transaction subtree delete: deepest leaves, then Inner, then Outer.
        document
            .submit(
                transaction(
                    1,
                    vec![
                        Command::Delete { id: NodeId(3) },
                        Command::Delete { id: NodeId(4) },
                        Command::Delete { id: NodeId(2) },
                        Command::Delete { id: NodeId(5) },
                        Command::Delete { id: NodeId(1) },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(document.node_count(), 0);

        document.undo().unwrap();
        // Hash equality proves total restoration; the structural asserts pin the
        // specific ID / order / parent / property expectations the plan names.
        assert_eq!(document.canonical_hash_hex(), built_hash);
        let ordered_after: Vec<(NodeId, Option<NodeId>)> = document
            .ordered_nodes_on_page(DEFAULT_PAGE_ID)
            .unwrap()
            .iter()
            .map(|n| (n.id, n.parent_id))
            .collect();
        assert_eq!(ordered_after, ordered_before);
        assert_eq!(
            document.node(NodeId(3)).unwrap().corner_radii,
            rect_radii_before
        );
        assert_eq!(document.node(NodeId(5)).unwrap().text, "Hi");
        assert_eq!(document.node(NodeId(2)).unwrap().parent_id, Some(NodeId(1)));

        document.redo().unwrap();
        assert_eq!(document.node_count(), 0);
    }

    #[test]
    fn section_contents_hidden_is_hashed_and_undoable() {
        let mut document = Document::empty();
        let mut section = node(1);
        section.kind = NodeKind::Section;
        section.name = "Section".into();
        document
            .submit(
                transaction(0, vec![Command::Create(section)]),
                Origin::LocalUser,
            )
            .unwrap();
        let baseline = document.canonical_hash_hex();
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetAppearance {
                        id: NodeId(1),
                        appearance: Appearance {
                            fill: "#fff".into(),
                            stroke: "#000".into(),
                            fills: Vec::new(),
                            strokes: Vec::new(),
                            stroke_width: 1.0,
                            stroke_cap_start: StrokeCap::None,
                            stroke_cap_end: StrokeCap::None,
                            stroke_join: Default::default(),
                            stroke_miter_limit: DEFAULT_STROKE_MITER_LIMIT,
                            stroke_dash_pattern: Vec::new(),
                            stroke_weights: Vec::new(),
                            stroke_align: Default::default(),
                            arc_data: None,
                            parametric_shape: None,
                            relative_transform: None,
                            opacity: 1.0,
                            blend_mode: BlendMode::Normal,
                            drop_shadow: None,
                            effect_stack: Vec::new(),
                            corner_radius: 0.0,
                            corner_radii: Vec::new(),
                            corner_smoothing: 0.0,
                            constraints: None,
                            visible: true,
                            locked: false,
                            contents_hidden: true,
                            clips_content: None,
                        },
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert!(document.node(NodeId(1)).unwrap().contents_hidden);
        let hidden_hash = document.canonical_hash_hex();
        assert_ne!(hidden_hash, baseline);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), hidden_hash);
    }

    #[test]
    fn frame_clip_content_is_hashed_undoable_and_frame_only() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.kind = NodeKind::Frame;
        frame.name = "Frame".into();
        frame.clips_content = true;
        document
            .submit(
                transaction(0, vec![Command::Create(frame)]),
                Origin::LocalUser,
            )
            .unwrap();
        let baseline = document.canonical_hash_hex();
        let appearance = Appearance {
            fill: "#fff".into(),
            stroke: "#000".into(),
            fills: vec!["#e6edff".into(), "#0048ff".into()],
            strokes: vec!["#000".into(), "#2563eb".into()],
            stroke_width: 1.0,
            stroke_cap_start: StrokeCap::None,
            stroke_cap_end: StrokeCap::None,
            stroke_join: StrokeJoin::Miter,
            stroke_miter_limit: DEFAULT_STROKE_MITER_LIMIT,
            stroke_dash_pattern: Vec::new(),
            stroke_weights: Vec::new(),
            stroke_align: StrokeAlign::Inside,
            arc_data: None,
            parametric_shape: None,
            relative_transform: None,
            opacity: 1.0,
            blend_mode: BlendMode::Normal,
            drop_shadow: None,
            effect_stack: Vec::new(),
            corner_radius: 0.0,
            corner_radii: Vec::new(),
            corner_smoothing: 0.0,
            constraints: None,
            visible: true,
            locked: false,
            contents_hidden: false,
            clips_content: Some(false),
        };
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetAppearance {
                        id: NodeId(1),
                        appearance: appearance.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert!(!document.node(NodeId(1)).unwrap().clips_content);
        assert_eq!(document.node(NodeId(1)).unwrap().fills, appearance.fills);
        assert_eq!(
            document.node(NodeId(1)).unwrap().strokes,
            appearance.strokes
        );
        let unclipped = document.canonical_hash_hex();
        assert_ne!(unclipped, baseline);
        document.undo().unwrap();
        assert!(document.node(NodeId(1)).unwrap().clips_content);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), unclipped);

        let mut rectangle = node(2);
        rectangle.kind = NodeKind::Rectangle;
        rectangle.name = "Rectangle".into();
        document
            .submit(
                transaction(4, vec![Command::Create(rectangle)]),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document.submit(
                transaction(
                    5,
                    vec![Command::SetAppearance {
                        id: NodeId(2),
                        appearance: Appearance {
                            clips_content: Some(true),
                            ..appearance
                        }
                    }]
                ),
                Origin::LocalUser
            ),
            Err(CommandError::InvalidAppearance)
        );
    }

    #[test]
    fn alpha_mask_flag_is_hashed_undoable_and_requires_a_following_sibling() {
        let mut document = Document::empty();
        let mut mask = node(1);
        mask.kind = NodeKind::Rectangle;
        let mut target = node(2);
        target.kind = NodeKind::Rectangle;
        document
            .submit(
                transaction(0, vec![Command::Create(mask), Command::Create(target)]),
                Origin::LocalUser,
            )
            .unwrap();
        let baseline = document.canonical_hash_hex();

        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetMask {
                        id: NodeId(1),
                        enabled: true,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert!(is_alpha_mask(document.node(NodeId(1)).unwrap()));
        let masked = document.canonical_hash_hex();
        assert_ne!(masked, baseline);
        document.undo().unwrap();
        assert!(!is_alpha_mask(document.node(NodeId(1)).unwrap()));
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), masked);

        assert_eq!(
            document.submit(
                transaction(
                    4,
                    vec![Command::SetMask {
                        id: NodeId(2),
                        enabled: true
                    }]
                ),
                Origin::LocalUser
            ),
            Err(CommandError::InvalidGeometry)
        );
    }

    #[test]
    fn group_mask_requires_descendant_alpha_structure_and_is_undoable() {
        let mut document = Document::empty();
        let mut group = node(1);
        group.kind = NodeKind::Group;
        let mut child = node(2);
        child.kind = NodeKind::Ellipse;
        child.parent_id = Some(NodeId(1));
        let mut target = node(3);
        target.kind = NodeKind::Rectangle;
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(group),
                        Command::Create(child),
                        Command::Create(target),
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let baseline = document.canonical_hash_hex();

        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetMask {
                        id: NodeId(1),
                        enabled: true,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert!(is_alpha_mask(document.node(NodeId(1)).unwrap()));
        let masked = document.canonical_hash_hex();
        assert_ne!(masked, baseline);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), masked);

        let mut invalid = Document::empty();
        let mut empty_group = node(4);
        empty_group.kind = NodeKind::Group;
        let mut following = node(5);
        following.kind = NodeKind::Rectangle;
        assert_eq!(
            invalid.submit(
                transaction(
                    0,
                    vec![
                        Command::Create(empty_group),
                        Command::Create(following),
                        Command::SetMask {
                            id: NodeId(4),
                            enabled: true
                        },
                    ],
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidGeometry)
        );
    }

    #[test]
    fn transform_group_mask_requires_descendant_alpha_structure_and_is_undoable() {
        let mut document = Document::empty();
        let mut group = node(1);
        group.kind = NodeKind::TransformGroup;
        let mut child = node(2);
        child.kind = NodeKind::Ellipse;
        child.parent_id = Some(NodeId(1));
        let mut target = node(3);
        target.kind = NodeKind::Rectangle;
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(group),
                        Command::Create(child),
                        Command::Create(target),
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let baseline = document.canonical_hash_hex();

        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetMask {
                        id: NodeId(1),
                        enabled: true,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert!(is_alpha_mask(document.node(NodeId(1)).unwrap()));
        let masked = document.canonical_hash_hex();
        assert_ne!(masked, baseline);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), masked);

        let mut invalid = Document::empty();
        let mut empty_group = node(4);
        empty_group.kind = NodeKind::TransformGroup;
        let mut following = node(5);
        following.kind = NodeKind::Rectangle;
        assert_eq!(
            invalid.submit(
                transaction(
                    0,
                    vec![
                        Command::Create(empty_group),
                        Command::Create(following),
                        Command::SetMask {
                            id: NodeId(4),
                            enabled: true,
                        },
                    ],
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidGeometry)
        );
    }

    #[test]
    fn vector_boolean_mask_is_hashed_and_undoable() {
        let path = VectorPath {
            fill_rule: FillRule::NonZero,
            subpaths: vec![VectorSubpath {
                closed: true,
                points: vec![
                    VectorPoint {
                        id: PointId(1),
                        position: Point { x: 0.0, y: 0.0 },
                        handle_in: None,
                        handle_out: None,
                        point_type: VectorPointType::Corner,
                    },
                    VectorPoint {
                        id: PointId(2),
                        position: Point { x: 80.0, y: 0.0 },
                        handle_in: None,
                        handle_out: None,
                        point_type: VectorPointType::Corner,
                    },
                    VectorPoint {
                        id: PointId(3),
                        position: Point { x: 0.0, y: 60.0 },
                        handle_in: None,
                        handle_out: None,
                        point_type: VectorPointType::Corner,
                    },
                ],
            }],
        };
        let mut boolean = node(1);
        boolean.kind = NodeKind::BooleanOperation;
        boolean.boolean_operation = Some(BooleanOperation::Subtract);
        let mut first = node(2);
        first.kind = NodeKind::Vector;
        first.parent_id = Some(NodeId(1));
        first.vector_path = Some(path.clone());
        let mut second = node(3);
        second.kind = NodeKind::Vector;
        second.parent_id = Some(NodeId(1));
        second.vector_path = Some(path);
        let mut target = node(4);
        target.kind = NodeKind::Rectangle;
        let mut document = Document::empty();
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(boolean),
                        Command::Create(first),
                        Command::Create(second),
                        Command::Create(target),
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let baseline = document.canonical_hash_hex();

        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetMask {
                        id: NodeId(1),
                        enabled: true,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert!(is_alpha_mask(document.node(NodeId(1)).unwrap()));
        let masked = document.canonical_hash_hex();
        assert_ne!(masked, baseline);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), masked);

        let mut unsupported = Document::empty();
        let mut boolean = node(10);
        boolean.kind = NodeKind::BooleanOperation;
        boolean.boolean_operation = Some(BooleanOperation::Union);
        let mut first = node(11);
        first.kind = NodeKind::Rectangle;
        first.parent_id = Some(NodeId(10));
        let mut second = node(12);
        second.kind = NodeKind::Ellipse;
        second.parent_id = Some(NodeId(10));
        let mut target = node(13);
        target.kind = NodeKind::Rectangle;
        assert_eq!(
            unsupported.submit(
                transaction(
                    0,
                    vec![
                        Command::Create(boolean),
                        Command::Create(first),
                        Command::Create(second),
                        Command::Create(target),
                        Command::SetMask {
                            id: NodeId(10),
                            enabled: true,
                        },
                    ],
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidGeometry)
        );
    }

    #[test]
    fn slice_is_non_painting_non_masking_and_cannot_parent_children() {
        let mut document = Document::empty();
        let mut slice = node(1);
        slice.kind = NodeKind::Slice;
        slice.name = "Export area".into();
        slice.fill = "#00000000".into();
        slice.stroke = "#00000000".into();
        slice.stroke_width = 0.0;
        slice.stroke_align = StrokeAlign::Inside;
        let mut target = node(2);
        target.kind = NodeKind::Rectangle;
        document
            .submit(
                transaction(0, vec![Command::Create(slice), Command::Create(target)]),
                Origin::LocalUser,
            )
            .unwrap();

        let baseline = document.canonical_hash_hex();
        let mut painted = appearance_for_node(document.node(NodeId(1)).unwrap());
        painted.fill = "#ffffff".into();
        assert_eq!(
            document.submit(
                transaction(
                    1,
                    vec![Command::SetAppearance {
                        id: NodeId(1),
                        appearance: painted
                    }]
                ),
                Origin::LocalUser
            ),
            Err(CommandError::InvalidAppearance)
        );
        assert_eq!(
            document.submit(
                transaction(
                    1,
                    vec![Command::SetMask {
                        id: NodeId(1),
                        enabled: true
                    }]
                ),
                Origin::LocalUser
            ),
            Err(CommandError::InvalidGeometry)
        );

        document
            .submit(
                transaction(
                    1,
                    vec![Command::UpdateGeometry {
                        id: NodeId(1),
                        x: 24.0,
                        y: 12.0,
                        width: 240.0,
                        height: 160.0,
                        rotation: 15.0,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_ne!(document.canonical_hash_hex(), baseline);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();

        let mut child = node(3);
        child.parent_id = Some(NodeId(1));
        child.kind = NodeKind::Rectangle;
        assert_eq!(
            document.submit(
                transaction(4, vec![Command::Create(child)]),
                Origin::LocalUser
            ),
            Err(CommandError::InvalidParent { id: NodeId(1) })
        );
    }

    #[test]
    fn corner_geometry_is_hashed_undoable_and_limited_to_closed_nodes() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.name = "Frame".into();
        frame.clips_content = true;
        document
            .submit(
                transaction(0, vec![Command::Create(frame)]),
                Origin::LocalUser,
            )
            .unwrap();
        let baseline = document.canonical_hash_hex();
        let appearance = Appearance {
            fill: "#fff".into(),
            stroke: "#000".into(),
            fills: Vec::new(),
            strokes: Vec::new(),
            stroke_width: 1.0,
            stroke_cap_start: StrokeCap::None,
            stroke_cap_end: StrokeCap::None,
            stroke_join: StrokeJoin::Miter,
            stroke_miter_limit: DEFAULT_STROKE_MITER_LIMIT,
            stroke_dash_pattern: Vec::new(),
            stroke_weights: Vec::new(),
            stroke_align: StrokeAlign::Inside,
            arc_data: None,
            parametric_shape: None,
            relative_transform: None,
            opacity: 1.0,
            blend_mode: BlendMode::Normal,
            drop_shadow: None,
            effect_stack: Vec::new(),
            corner_radius: 0.0,
            corner_radii: vec![4.0, 8.0, 12.0, 16.0],
            corner_smoothing: 0.65,
            constraints: None,
            visible: true,
            locked: false,
            contents_hidden: false,
            clips_content: Some(true),
        };
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetAppearance {
                        id: NodeId(1),
                        appearance: appearance.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document.node(NodeId(1)).unwrap().corner_radii,
            appearance.corner_radii
        );
        assert_eq!(document.node(NodeId(1)).unwrap().corner_smoothing, 0.65);
        assert_eq!(document.node(NodeId(1)).unwrap().fills, appearance.fills);
        assert_eq!(
            document.node(NodeId(1)).unwrap().strokes,
            appearance.strokes
        );
        let rounded_hash = document.canonical_hash_hex();
        assert_ne!(rounded_hash, baseline);
        document.undo().unwrap();
        assert!(document.node(NodeId(1)).unwrap().corner_radii.is_empty());
        assert_eq!(document.node(NodeId(1)).unwrap().corner_smoothing, 0.0);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), rounded_hash);

        let mut line = node(2);
        line.kind = NodeKind::Line;
        line.name = "Line".into();
        line.height = 0.0;
        document
            .submit(
                transaction(4, vec![Command::Create(line)]),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document.submit(
                transaction(
                    5,
                    vec![Command::SetAppearance {
                        id: NodeId(2),
                        appearance: appearance.clone()
                    }]
                ),
                Origin::LocalUser
            ),
            Err(CommandError::InvalidAppearance)
        );
        assert_eq!(
            document.submit(
                transaction(
                    5,
                    vec![Command::SetAppearance {
                        id: NodeId(1),
                        appearance: Appearance {
                            corner_radii: vec![1.0, 2.0],
                            ..appearance.clone()
                        }
                    }]
                ),
                Origin::LocalUser
            ),
            Err(CommandError::InvalidAppearance)
        );
        assert_eq!(
            document.submit(
                transaction(
                    5,
                    vec![Command::SetAppearance {
                        id: NodeId(1),
                        appearance: Appearance {
                            corner_smoothing: 1.1,
                            ..appearance
                        }
                    }]
                ),
                Origin::LocalUser
            ),
            Err(CommandError::InvalidAppearance)
        );
    }

    #[test]
    fn constraints_are_hashed_undoable_and_reject_structural_nodes() {
        let mut document = Document::empty();
        document
            .submit(
                transaction(0, vec![Command::Create(node(1))]),
                Origin::LocalUser,
            )
            .unwrap();
        let baseline = document.canonical_hash_hex();
        let appearance = Appearance {
            fill: "#fff".into(),
            stroke: "#00000000".into(),
            fills: Vec::new(),
            strokes: Vec::new(),
            stroke_width: 0.0,
            stroke_cap_start: StrokeCap::None,
            stroke_cap_end: StrokeCap::None,
            stroke_join: StrokeJoin::Miter,
            stroke_miter_limit: DEFAULT_STROKE_MITER_LIMIT,
            stroke_dash_pattern: Vec::new(),
            stroke_weights: Vec::new(),
            stroke_align: StrokeAlign::Inside,
            arc_data: None,
            parametric_shape: None,
            relative_transform: None,
            opacity: 1.0,
            blend_mode: BlendMode::Normal,
            drop_shadow: None,
            effect_stack: Vec::new(),
            corner_radius: 0.0,
            corner_radii: Vec::new(),
            corner_smoothing: 0.0,
            constraints: Some(Constraints {
                horizontal: ConstraintType::Stretch,
                vertical: ConstraintType::Center,
            }),
            visible: true,
            locked: false,
            contents_hidden: false,
            clips_content: Some(true),
        };
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetAppearance {
                        id: NodeId(1),
                        appearance: appearance.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document.node(NodeId(1)).unwrap().constraints,
            appearance.constraints
        );
        let constrained = document.canonical_hash_hex();
        assert_ne!(constrained, baseline);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), constrained);

        let mut group = node(2);
        group.kind = NodeKind::Group;
        group.name = "Group".into();
        let mut child = node(3);
        child.parent_id = Some(NodeId(2));
        document
            .submit(
                transaction(4, vec![Command::Create(group), Command::Create(child)]),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document.submit(
                transaction(
                    5,
                    vec![Command::SetAppearance {
                        id: NodeId(2),
                        appearance
                    }]
                ),
                Origin::LocalUser
            ),
            Err(CommandError::InvalidAppearance)
        );
    }

    #[test]
    fn frame_resize_applies_direct_child_constraints_atomically() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 200.0;
        frame.height = 100.0;
        let mut child = node(2);
        child.kind = NodeKind::Rectangle;
        child.name = "Child".into();
        child.parent_id = Some(NodeId(1));
        child.x = 20.0;
        child.y = 20.0;
        child.width = 100.0;
        child.height = 30.0;
        child.constraints = Some(Constraints {
            horizontal: ConstraintType::Stretch,
            vertical: ConstraintType::Center,
        });
        document
            .submit(
                transaction(0, vec![Command::Create(frame), Command::Create(child)]),
                Origin::LocalUser,
            )
            .unwrap();
        document
            .submit(
                transaction(
                    1,
                    vec![Command::UpdateGeometry {
                        id: NodeId(1),
                        x: 0.0,
                        y: 0.0,
                        width: 300.0,
                        height: 200.0,
                        rotation: 0.0,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let child = document.node(NodeId(2)).unwrap();
        assert_eq!(
            (child.x, child.y, child.width, child.height),
            (20.0, 70.0, 200.0, 30.0)
        );
        document.undo().unwrap();
        let child = document.node(NodeId(2)).unwrap();
        assert_eq!(
            (child.x, child.y, child.width, child.height),
            (20.0, 20.0, 100.0, 30.0)
        );
        document.redo().unwrap();
        assert_eq!(document.node(NodeId(2)).unwrap().width, 200.0);
    }

    #[test]
    fn frame_resize_without_constraints_leaves_child_geometry_unchanged() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 200.0;
        frame.height = 100.0;
        let mut child = node(2);
        child.kind = NodeKind::Rectangle;
        child.parent_id = Some(frame.id);
        child.x = 20.0;
        child.y = 20.0;
        child.width = 100.0;
        child.height = 30.0;
        child.constraints = Some(Constraints {
            horizontal: ConstraintType::Stretch,
            vertical: ConstraintType::Center,
        });
        document
            .submit(
                transaction(0, vec![Command::Create(frame), Command::Create(child)]),
                Origin::LocalUser,
            )
            .unwrap();

        document
            .submit(
                transaction(
                    1,
                    vec![Command::UpdateGeometryWithoutConstraints {
                        id: NodeId(1),
                        x: 0.0,
                        y: 0.0,
                        width: 300.0,
                        height: 200.0,
                        rotation: 0.0,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();

        let child = document.node(NodeId(2)).unwrap();
        assert_eq!(
            (child.x, child.y, child.width, child.height),
            (20.0, 20.0, 100.0, 30.0)
        );
    }

    #[test]
    fn omitted_legacy_constraints_execute_as_figma_min_min_default() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.x = 100.0;
        frame.y = 50.0;
        frame.width = 200.0;
        frame.height = 100.0;
        let mut child = node(2);
        child.kind = NodeKind::Rectangle;
        child.parent_id = Some(NodeId(1));
        child.x = 120.0;
        child.y = 60.0;
        child.width = 40.0;
        child.height = 20.0;
        assert_eq!(child.constraints, None);
        document
            .submit(
                transaction(0, vec![Command::Create(frame), Command::Create(child)]),
                Origin::LocalUser,
            )
            .unwrap();

        document
            .submit(
                transaction(
                    1,
                    vec![Command::UpdateGeometry {
                        id: NodeId(1),
                        x: 180.0,
                        y: 90.0,
                        width: 260.0,
                        height: 140.0,
                        rotation: 0.0,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();

        let child = document.node(NodeId(2)).unwrap();
        assert_eq!(
            (child.x, child.y, child.width, child.height),
            (200.0, 100.0, 40.0, 20.0)
        );
        // The old absence encoding stays byte-compatible until a user edits
        // constraints, while its execution is no longer a hidden sixth mode.
        assert_eq!(child.constraints, None);
    }

    #[test]
    fn active_auto_layout_applies_constraints_only_to_absolute_children() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 100.0;
        frame.height = 100.0;
        let mut flow = node(2);
        flow.kind = NodeKind::Rectangle;
        flow.parent_id = Some(frame.id);
        flow.width = 10.0;
        flow.height = 10.0;
        flow.constraints = Some(Constraints {
            horizontal: ConstraintType::Max,
            vertical: ConstraintType::Max,
        });
        let mut absolute = node(3);
        absolute.kind = NodeKind::Rectangle;
        absolute.parent_id = Some(frame.id);
        absolute.x = 70.0;
        absolute.y = 60.0;
        absolute.width = 10.0;
        absolute.height = 10.0;
        absolute.constraints = flow.constraints;
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame),
                        Command::Create(flow),
                        Command::Create(absolute),
                        Command::SetAutoLayout {
                            id: NodeId(1),
                            layout: AutoLayout {
                                mode: LayoutMode::Horizontal,
                                padding: [5.0, 5.0, 5.0, 5.0],
                                ..AutoLayout::default()
                            },
                        },
                        Command::SetAutoLayout {
                            id: NodeId(3),
                            layout: AutoLayout {
                                absolute: true,
                                ..AutoLayout::default()
                            },
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();

        document
            .submit(
                transaction(
                    1,
                    vec![Command::UpdateGeometry {
                        id: NodeId(1),
                        x: 0.0,
                        y: 0.0,
                        width: 200.0,
                        height: 200.0,
                        rotation: 0.0,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();

        assert_eq!(
            document.node(NodeId(2)).map(|node| (node.x, node.y)),
            Some((5.0, 5.0))
        );
        assert_eq!(
            document.node(NodeId(3)).map(|node| (node.x, node.y)),
            Some((170.0, 160.0))
        );
    }

    #[test]
    fn frame_resize_resolves_min_max_and_scale_axes() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 200.0;
        frame.height = 100.0;
        let child = |id, constraints| {
            let mut value = node(id);
            value.kind = NodeKind::Rectangle;
            value.name = format!("Child {id}");
            value.parent_id = Some(NodeId(1));
            value.x = 20.0;
            value.y = 10.0;
            value.width = 40.0;
            value.height = 20.0;
            value.constraints = Some(constraints);
            value
        };
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame),
                        Command::Create(child(
                            2,
                            Constraints {
                                horizontal: ConstraintType::Min,
                                vertical: ConstraintType::Min,
                            },
                        )),
                        Command::Create(child(
                            3,
                            Constraints {
                                horizontal: ConstraintType::Max,
                                vertical: ConstraintType::Max,
                            },
                        )),
                        Command::Create(child(
                            4,
                            Constraints {
                                horizontal: ConstraintType::Scale,
                                vertical: ConstraintType::Scale,
                            },
                        )),
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        document
            .submit(
                transaction(
                    1,
                    vec![Command::UpdateGeometry {
                        id: NodeId(1),
                        x: 0.0,
                        y: 0.0,
                        width: 400.0,
                        height: 200.0,
                        rotation: 0.0,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            (
                document.node(NodeId(2)).unwrap().x,
                document.node(NodeId(2)).unwrap().y
            ),
            (20.0, 10.0)
        );
        assert_eq!(
            (
                document.node(NodeId(3)).unwrap().x,
                document.node(NodeId(3)).unwrap().y
            ),
            (220.0, 110.0)
        );
        assert_eq!(
            (
                document.node(NodeId(4)).unwrap().x,
                document.node(NodeId(4)).unwrap().y,
                document.node(NodeId(4)).unwrap().width,
                document.node(NodeId(4)).unwrap().height
            ),
            (40.0, 20.0, 80.0, 40.0)
        );
    }

    #[test]
    fn rotated_frame_resize_migrates_legacy_direct_constraints_to_local_matrix_space() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 200.0;
        frame.height = 100.0;
        let mut child = node(2);
        child.kind = NodeKind::Rectangle;
        child.name = "Child".into();
        child.parent_id = Some(NodeId(1));
        child.x = 20.0;
        child.y = 20.0;
        child.constraints = Some(Constraints {
            horizontal: ConstraintType::Max,
            vertical: ConstraintType::Max,
        });
        document
            .submit(
                transaction(0, vec![Command::Create(frame), Command::Create(child)]),
                Origin::LocalUser,
            )
            .unwrap();
        document
            .submit(
                transaction(
                    1,
                    vec![Command::UpdateGeometry {
                        id: NodeId(1),
                        x: 0.0,
                        y: 0.0,
                        width: 300.0,
                        height: 200.0,
                        rotation: 30.0,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let child = document.node(NodeId(2)).unwrap();
        assert_eq!(child.relative_transform.unwrap().e, 120.0);
        assert_eq!(child.relative_transform.unwrap().f, 120.0);
        assert_eq!((child.x, child.y), (120.0, 120.0));
        let constrained_hash = document.canonical_hash_hex();
        document.undo().unwrap();
        let child = document.node(NodeId(2)).unwrap();
        assert!(child.relative_transform.is_none());
        assert_eq!((child.x, child.y), (20.0, 20.0));
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), constrained_hash);
    }

    #[test]
    fn rotated_frame_resize_migrates_an_entire_legacy_group_constraint_subtree() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 200.0;
        frame.height = 100.0;
        let mut group = node(2);
        group.kind = NodeKind::Group;
        group.name = "Legacy group".into();
        group.parent_id = Some(NodeId(1));
        group.x = 20.0;
        group.y = 10.0;
        group.width = 40.0;
        group.height = 20.0;
        let mut child = node(3);
        child.kind = NodeKind::Rectangle;
        child.name = "Constrained legacy child".into();
        child.parent_id = Some(NodeId(2));
        child.x = 20.0;
        child.y = 10.0;
        child.width = 40.0;
        child.height = 20.0;
        child.constraints = Some(Constraints {
            horizontal: ConstraintType::Max,
            vertical: ConstraintType::Max,
        });

        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame),
                        Command::Create(group),
                        Command::Create(child),
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        document
            .submit(
                transaction(
                    1,
                    vec![Command::UpdateGeometry {
                        id: NodeId(1),
                        x: 0.0,
                        y: 0.0,
                        width: 300.0,
                        height: 200.0,
                        rotation: 30.0,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();

        let group = document.node(NodeId(2)).unwrap();
        let child = document.node(NodeId(3)).unwrap();
        assert_eq!(
            (
                group.relative_transform.unwrap().e,
                group.relative_transform.unwrap().f
            ),
            (20.0, 10.0)
        );
        // The constrained child is (120, 110) in Frame-local space. Its
        // immediate parent is the migrated Group at (20, 10), so the durable
        // matrix stores the local delta rather than a stale world coordinate.
        assert_eq!(
            (
                child.relative_transform.unwrap().e,
                child.relative_transform.unwrap().f
            ),
            (100.0, 100.0)
        );
        let constrained_hash = document.canonical_hash_hex();

        document.undo().unwrap();
        assert!(
            document
                .node(NodeId(2))
                .unwrap()
                .relative_transform
                .is_none()
        );
        assert!(
            document
                .node(NodeId(3))
                .unwrap()
                .relative_transform
                .is_none()
        );
        assert_eq!(
            (
                document.node(NodeId(3)).unwrap().x,
                document.node(NodeId(3)).unwrap().y
            ),
            (20.0, 10.0)
        );
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), constrained_hash);
    }

    #[test]
    fn rotated_frame_resize_migrates_nested_legacy_groups_before_their_constrained_leaf() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 200.0;
        frame.height = 100.0;
        let mut outer = node(2);
        outer.kind = NodeKind::Group;
        outer.name = "Outer legacy group".into();
        outer.parent_id = Some(NodeId(1));
        outer.x = 40.0;
        outer.y = 30.0;
        outer.width = 40.0;
        outer.height = 20.0;
        let mut inner = node(3);
        inner.kind = NodeKind::Group;
        inner.name = "Inner legacy group".into();
        inner.parent_id = Some(NodeId(2));
        inner.x = 40.0;
        inner.y = 30.0;
        inner.width = 40.0;
        inner.height = 20.0;
        let mut child = node(4);
        child.kind = NodeKind::Rectangle;
        child.name = "Nested constrained legacy child".into();
        child.parent_id = Some(NodeId(3));
        child.x = 40.0;
        child.y = 30.0;
        child.width = 40.0;
        child.height = 20.0;
        child.constraints = Some(Constraints {
            horizontal: ConstraintType::Max,
            vertical: ConstraintType::Max,
        });

        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame),
                        Command::Create(outer),
                        Command::Create(inner),
                        Command::Create(child),
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        document
            .submit(
                transaction(
                    1,
                    vec![Command::UpdateGeometry {
                        id: NodeId(1),
                        x: 0.0,
                        y: 0.0,
                        width: 300.0,
                        height: 200.0,
                        rotation: 30.0,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();

        let outer = document.node(NodeId(2)).unwrap();
        let inner = document.node(NodeId(3)).unwrap();
        let child = document.node(NodeId(4)).unwrap();
        assert_eq!(
            (
                outer.relative_transform.unwrap().e,
                outer.relative_transform.unwrap().f
            ),
            (40.0, 30.0)
        );
        assert_eq!(
            (
                inner.relative_transform.unwrap().e,
                inner.relative_transform.unwrap().f
            ),
            (0.0, 0.0)
        );
        assert_eq!(
            (
                child.relative_transform.unwrap().e,
                child.relative_transform.unwrap().f
            ),
            (100.0, 100.0)
        );
    }

    #[test]
    fn migrated_group_constraints_do_not_drift_across_reentrant_frame_resizes() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 200.0;
        frame.height = 100.0;
        let mut group = node(2);
        group.kind = NodeKind::Group;
        group.name = "Legacy group".into();
        group.parent_id = Some(NodeId(1));
        group.x = 20.0;
        group.y = 10.0;
        group.width = 40.0;
        group.height = 20.0;
        let mut child = node(3);
        child.kind = NodeKind::Rectangle;
        child.name = "Max constrained child".into();
        child.parent_id = Some(NodeId(2));
        child.x = 20.0;
        child.y = 10.0;
        child.width = 40.0;
        child.height = 20.0;
        child.constraints = Some(Constraints {
            horizontal: ConstraintType::Max,
            vertical: ConstraintType::Max,
        });
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame),
                        Command::Create(group),
                        Command::Create(child),
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();

        document
            .submit(
                transaction(
                    1,
                    vec![Command::UpdateGeometry {
                        id: NodeId(1),
                        x: 0.0,
                        y: 0.0,
                        width: 300.0,
                        height: 200.0,
                        rotation: 30.0,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            (
                document
                    .node(NodeId(3))
                    .unwrap()
                    .relative_transform
                    .unwrap()
                    .e,
                document
                    .node(NodeId(3))
                    .unwrap()
                    .relative_transform
                    .unwrap()
                    .f
            ),
            (100.0, 100.0)
        );

        document
            .submit(
                transaction(
                    2,
                    vec![Command::UpdateGeometry {
                        id: NodeId(1),
                        x: 0.0,
                        y: 0.0,
                        width: 200.0,
                        height: 100.0,
                        rotation: 30.0,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            (
                document
                    .node(NodeId(3))
                    .unwrap()
                    .relative_transform
                    .unwrap()
                    .e,
                document
                    .node(NodeId(3))
                    .unwrap()
                    .relative_transform
                    .unwrap()
                    .f
            ),
            (0.0, 0.0)
        );

        document
            .submit(
                transaction(
                    3,
                    vec![Command::UpdateGeometry {
                        id: NodeId(1),
                        x: 0.0,
                        y: 0.0,
                        width: 300.0,
                        height: 200.0,
                        rotation: 30.0,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            (
                document
                    .node(NodeId(3))
                    .unwrap()
                    .relative_transform
                    .unwrap()
                    .e,
                document
                    .node(NodeId(3))
                    .unwrap()
                    .relative_transform
                    .unwrap()
                    .f
            ),
            (100.0, 100.0)
        );
    }

    #[test]
    fn group_subtree_migration_stops_at_a_nested_frame_layout_boundary() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 200.0;
        frame.height = 100.0;
        let mut group = node(2);
        group.kind = NodeKind::Group;
        group.name = "Legacy group".into();
        group.parent_id = Some(NodeId(1));
        group.x = 40.0;
        group.y = 30.0;
        group.width = 80.0;
        group.height = 60.0;
        let mut nested_frame = node(3);
        nested_frame.kind = NodeKind::Frame;
        nested_frame.name = "Nested frame".into();
        nested_frame.parent_id = Some(NodeId(2));
        nested_frame.x = 40.0;
        nested_frame.y = 30.0;
        nested_frame.width = 80.0;
        nested_frame.height = 60.0;
        let mut nested_child = node(4);
        nested_child.kind = NodeKind::Rectangle;
        nested_child.name = "Nested-frame child".into();
        nested_child.parent_id = Some(NodeId(3));
        nested_child.x = 50.0;
        nested_child.y = 40.0;
        nested_child.width = 20.0;
        nested_child.height = 10.0;
        nested_child.constraints = Some(Constraints {
            horizontal: ConstraintType::Max,
            vertical: ConstraintType::Max,
        });
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame),
                        Command::Create(group),
                        Command::Create(nested_frame),
                        Command::Create(nested_child),
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();

        document
            .submit(
                transaction(
                    1,
                    vec![Command::UpdateGeometry {
                        id: NodeId(1),
                        x: 0.0,
                        y: 0.0,
                        width: 300.0,
                        height: 200.0,
                        rotation: 30.0,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();

        // The outer Group becomes Relative-v1, but the nested Frame keeps its
        // own legacy layout boundary. Its child must not receive the outer
        // Frame's +100/+100 Max movement.
        assert!(
            document
                .node(NodeId(2))
                .unwrap()
                .relative_transform
                .is_some()
        );
        assert!(
            document
                .node(NodeId(3))
                .unwrap()
                .relative_transform
                .is_none()
        );
        assert!(
            document
                .node(NodeId(4))
                .unwrap()
                .relative_transform
                .is_none()
        );
        assert_eq!(
            (
                document.node(NodeId(4)).unwrap().x,
                document.node(NodeId(4)).unwrap().y
            ),
            (50.0, 40.0)
        );
    }

    #[test]
    fn mirrored_relative_frame_resizes_constraints_in_its_local_axes() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 200.0;
        frame.height = 100.0;
        // Horizontal reflection is intentionally on the containing Frame. The
        // child's constraints must continue to use its unmirrored local axes.
        frame.relative_transform = Some(AffineTransform {
            a: -1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            e: 200.0,
            f: 0.0,
        });
        let mut child = node(2);
        child.kind = NodeKind::Rectangle;
        child.name = "Mirrored frame child".into();
        child.parent_id = Some(NodeId(1));
        child.width = 40.0;
        child.height = 20.0;
        child.relative_transform = Some(AffineTransform {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            e: 20.0,
            f: 10.0,
        });
        child.constraints = Some(Constraints {
            horizontal: ConstraintType::Max,
            vertical: ConstraintType::Max,
        });
        document
            .submit(
                transaction(0, vec![Command::Create(frame), Command::Create(child)]),
                Origin::LocalUser,
            )
            .unwrap();

        document
            .submit(
                transaction(
                    1,
                    vec![Command::UpdateGeometry {
                        id: NodeId(1),
                        x: 0.0,
                        y: 0.0,
                        width: 300.0,
                        height: 200.0,
                        rotation: 0.0,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();

        let child = document.node(NodeId(2)).unwrap();
        assert_eq!(
            (
                child.relative_transform.unwrap().e,
                child.relative_transform.unwrap().f
            ),
            (120.0, 110.0)
        );
        assert_eq!((child.width, child.height), (40.0, 20.0));
    }

    #[test]
    fn frame_resize_applies_constraints_to_relative_matrix_subtrees_in_local_space() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 200.0;
        frame.height = 100.0;
        // A rotated Frame proves that the constraint calculation is independent
        // of the canvas/world axes.
        frame.relative_transform = Some(AffineTransform {
            a: 0.0,
            b: 1.0,
            c: -1.0,
            d: 0.0,
            e: 300.0,
            f: 200.0,
        });

        let mut direct = node(2);
        direct.kind = NodeKind::Rectangle;
        direct.name = "Direct matrix child".into();
        direct.parent_id = Some(NodeId(1));
        direct.width = 40.0;
        direct.height = 20.0;
        direct.relative_transform = Some(AffineTransform {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            e: 20.0,
            f: 10.0,
        });
        direct.constraints = Some(Constraints {
            horizontal: ConstraintType::Max,
            vertical: ConstraintType::Center,
        });

        let mut group = node(3);
        group.kind = NodeKind::Group;
        group.name = "Rotated group".into();
        group.parent_id = Some(NodeId(1));
        group.relative_transform = Some(AffineTransform {
            a: 0.0,
            b: 1.0,
            c: -1.0,
            d: 0.0,
            e: 50.0,
            f: 20.0,
        });
        let mut nested = node(4);
        nested.kind = NodeKind::Rectangle;
        nested.name = "Nested matrix child".into();
        nested.parent_id = Some(NodeId(3));
        nested.width = 40.0;
        nested.height = 20.0;
        nested.relative_transform = Some(AffineTransform {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            e: 10.0,
            f: 5.0,
        });
        nested.constraints = Some(Constraints {
            horizontal: ConstraintType::Stretch,
            vertical: ConstraintType::Max,
        });

        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame),
                        Command::Create(direct),
                        Command::Create(group),
                        Command::Create(nested),
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        document
            .submit(
                transaction(
                    1,
                    vec![Command::UpdateGeometry {
                        id: NodeId(1),
                        x: 0.0,
                        y: 0.0,
                        width: 300.0,
                        height: 200.0,
                        rotation: 0.0,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();

        let direct = document.node(NodeId(2)).unwrap();
        assert_eq!(direct.relative_transform.unwrap().e, 120.0);
        assert_eq!(direct.relative_transform.unwrap().f, 60.0);
        assert_eq!((direct.width, direct.height), (40.0, 20.0));
        let nested = document.node(NodeId(4)).unwrap();
        // Frame-local (45, 30) becomes (45, 130). The inverse rotated Group
        // converts that back to the child's immediate local translation.
        assert_eq!(nested.relative_transform.unwrap().e, 110.0);
        assert_eq!(nested.relative_transform.unwrap().f, 5.0);
        assert_eq!((nested.width, nested.height), (140.0, 20.0));

        document.undo().unwrap();
        let direct = document.node(NodeId(2)).unwrap();
        assert_eq!(
            (
                direct.relative_transform.unwrap().e,
                direct.relative_transform.unwrap().f
            ),
            (20.0, 10.0)
        );
        let nested = document.node(NodeId(4)).unwrap();
        assert_eq!(
            (
                nested.relative_transform.unwrap().e,
                nested.relative_transform.unwrap().f,
                nested.width
            ),
            (10.0, 5.0, 40.0)
        );
        document.redo().unwrap();
        assert_eq!(
            document
                .node(NodeId(4))
                .unwrap()
                .relative_transform
                .unwrap()
                .e,
            110.0
        );
    }

    #[test]
    fn frame_resize_propagates_through_groups_and_refreshes_group_bounds() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 200.0;
        frame.height = 100.0;
        let mut group = node(2);
        group.kind = NodeKind::Group;
        group.name = "Group".into();
        group.parent_id = Some(NodeId(1));
        group.x = 20.0;
        group.y = 10.0;
        group.width = 40.0;
        group.height = 20.0;
        let mut child = node(3);
        child.kind = NodeKind::Rectangle;
        child.name = "Child".into();
        child.parent_id = Some(NodeId(2));
        child.x = 20.0;
        child.y = 10.0;
        child.width = 40.0;
        child.height = 20.0;
        child.constraints = Some(Constraints {
            horizontal: ConstraintType::Max,
            vertical: ConstraintType::Min,
        });
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(frame),
                        Command::Create(group),
                        Command::Create(child),
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        document
            .submit(
                transaction(
                    1,
                    vec![Command::UpdateGeometry {
                        id: NodeId(1),
                        x: 0.0,
                        y: 0.0,
                        width: 300.0,
                        height: 100.0,
                        rotation: 0.0,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(document.node(NodeId(3)).unwrap().x, 120.0);
        assert_eq!(document.node(NodeId(2)).unwrap().x, 120.0);
        document.undo().unwrap();
        assert_eq!(document.node(NodeId(3)).unwrap().x, 20.0);
        assert_eq!(document.node(NodeId(2)).unwrap().x, 20.0);
    }

    #[test]
    fn frame_resize_rejects_scale_from_a_zero_sized_axis() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 1.0;
        frame.height = 100.0;
        let constraints = Constraints {
            horizontal: ConstraintType::Scale,
            vertical: ConstraintType::Min,
        };
        let mut child = node(2);
        child.kind = NodeKind::Rectangle;
        child.name = "Child".into();
        child.parent_id = Some(NodeId(1));
        child.constraints = Some(constraints);
        document
            .submit(
                transaction(0, vec![Command::Create(frame), Command::Create(child)]),
                Origin::LocalUser,
            )
            .unwrap();
        // Canonical geometry disallows a zero Frame, so the scale guard is exercised
        // directly through the shared pure geometry rule.
        assert_eq!(
            geometry_for_constraints(
                Geometry {
                    x: 0.0,
                    y: 0.0,
                    width: 0.0,
                    height: 100.0,
                    rotation: 0.0
                },
                Geometry {
                    x: 0.0,
                    y: 0.0,
                    width: 10.0,
                    height: 100.0,
                    rotation: 0.0
                },
                Geometry {
                    x: 1.0,
                    y: 1.0,
                    width: 10.0,
                    height: 10.0,
                    rotation: 0.0
                },
                constraints,
                &NodeKind::Rectangle
            ),
            Err(CommandError::InvalidGeometry)
        );
    }

    // --- P1-5: named unit fixtures directly over `geometry_for_constraints` ---
    // The five axis rules are asserted as pure geometry so their contract is
    // pinned independently of the transaction plumbing that consumes them.

    // A 100x40 parent doubling to 200x80, child at local (20,10) sized 40x20.
    const PARENT_BEFORE: Geometry = Geometry {
        x: 10.0,
        y: 20.0,
        width: 100.0,
        height: 40.0,
        rotation: 0.0,
    };
    const PARENT_AFTER: Geometry = Geometry {
        x: 10.0,
        y: 20.0,
        width: 200.0,
        height: 80.0,
        rotation: 0.0,
    };
    // World-space child: parent origin (10,20) + local (20,10).
    const CHILD: Geometry = Geometry {
        x: 30.0,
        y: 30.0,
        width: 40.0,
        height: 20.0,
        rotation: 0.0,
    };

    fn constrained(
        horizontal: ConstraintType,
        vertical: ConstraintType,
        kind: &NodeKind,
    ) -> Geometry {
        geometry_for_constraints(
            PARENT_BEFORE,
            PARENT_AFTER,
            CHILD,
            Constraints {
                horizontal,
                vertical,
            },
            kind,
        )
        .unwrap()
    }

    #[test]
    fn constraint_axis_min_pins_leading_edge_and_keeps_size() {
        let after = constrained(
            ConstraintType::Min,
            ConstraintType::Min,
            &NodeKind::Rectangle,
        );
        // Local offset preserved from the new parent origin; size unchanged.
        assert_eq!(
            (after.x, after.y, after.width, after.height),
            (30.0, 30.0, 40.0, 20.0)
        );
    }

    #[test]
    fn constraint_axis_max_tracks_trailing_edge() {
        let after = constrained(
            ConstraintType::Max,
            ConstraintType::Max,
            &NodeKind::Rectangle,
        );
        // Width delta +100, height delta +40 shift the local position by the full delta.
        assert_eq!(
            (after.x, after.y, after.width, after.height),
            (130.0, 70.0, 40.0, 20.0)
        );
    }

    #[test]
    fn constraint_axis_center_tracks_half_delta() {
        let after = constrained(
            ConstraintType::Center,
            ConstraintType::Center,
            &NodeKind::Rectangle,
        );
        assert_eq!(
            (after.x, after.y, after.width, after.height),
            (80.0, 50.0, 40.0, 20.0)
        );
    }

    #[test]
    fn constraint_axis_stretch_grows_size_by_delta() {
        let after = constrained(
            ConstraintType::Stretch,
            ConstraintType::Stretch,
            &NodeKind::Rectangle,
        );
        // Leading edge fixed; size absorbs the parent delta on each axis.
        assert_eq!(
            (after.x, after.y, after.width, after.height),
            (30.0, 30.0, 140.0, 60.0)
        );
    }

    #[test]
    fn constraint_axis_scale_multiplies_position_and_size_by_ratio() {
        let after = constrained(
            ConstraintType::Scale,
            ConstraintType::Scale,
            &NodeKind::Rectangle,
        );
        // Ratio 2x horizontal, 2x vertical over local (20,10) sized 40x20.
        assert_eq!(
            (after.x, after.y, after.width, after.height),
            (50.0, 40.0, 80.0, 40.0)
        );
    }

    #[test]
    fn constraint_mixed_axes_resolve_independently() {
        // Horizontal Max + vertical Scale prove the two axes never share state.
        let after = constrained(
            ConstraintType::Max,
            ConstraintType::Scale,
            &NodeKind::Rectangle,
        );
        assert_eq!((after.x, after.width), (130.0, 40.0));
        assert_eq!((after.y, after.height), (40.0, 40.0));
    }

    #[test]
    fn constraint_line_stretch_preserves_zero_height() {
        // A Line's height must stay exactly zero even under a Stretch vertical
        // rule, matching `valid_geometry`'s Line invariant.
        let line = Geometry {
            x: 30.0,
            y: 30.0,
            width: 40.0,
            height: 0.0,
            rotation: 0.0,
        };
        let after = geometry_for_constraints(
            PARENT_BEFORE,
            PARENT_AFTER,
            line,
            Constraints {
                horizontal: ConstraintType::Stretch,
                vertical: ConstraintType::Stretch,
            },
            &NodeKind::Line,
        )
        .unwrap();
        assert_eq!((after.width, after.height), (140.0, 0.0));
    }

    #[test]
    fn constraint_scale_rejects_zero_sized_source_axis_per_axis() {
        // Guard fires the moment either source extent is zero, independent of which axis scales.
        let zero_width = Geometry {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 40.0,
            rotation: 0.0,
        };
        assert_eq!(
            geometry_for_constraints(
                zero_width,
                PARENT_AFTER,
                CHILD,
                Constraints {
                    horizontal: ConstraintType::Scale,
                    vertical: ConstraintType::Min
                },
                &NodeKind::Rectangle
            ),
            Err(CommandError::InvalidGeometry)
        );
        let zero_height = Geometry {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 0.0,
            rotation: 0.0,
        };
        assert_eq!(
            geometry_for_constraints(
                zero_height,
                PARENT_AFTER,
                CHILD,
                Constraints {
                    horizontal: ConstraintType::Min,
                    vertical: ConstraintType::Scale
                },
                &NodeKind::Rectangle
            ),
            Err(CommandError::InvalidGeometry)
        );
    }

    #[test]
    fn constrained_child_under_a_clipping_frame_still_resolves_and_reparent_preserves_the_constraint()
     {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 200.0;
        frame.height = 100.0;
        frame.clips_content = true;
        let mut child = node(2);
        child.kind = NodeKind::Rectangle;
        child.name = "Child".into();
        child.parent_id = Some(NodeId(1));
        child.x = 20.0;
        child.y = 20.0;
        child.width = 40.0;
        child.height = 20.0;
        child.constraints = Some(Constraints {
            horizontal: ConstraintType::Max,
            vertical: ConstraintType::Center,
        });
        document
            .submit(
                transaction(0, vec![Command::Create(frame), Command::Create(child)]),
                Origin::LocalUser,
            )
            .unwrap();
        document
            .submit(
                transaction(
                    1,
                    vec![Command::UpdateGeometry {
                        id: NodeId(1),
                        x: 0.0,
                        y: 0.0,
                        width: 300.0,
                        height: 200.0,
                        rotation: 0.0,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        // Clip state does not alter constraint math: Max x shifts by +100.
        assert_eq!(document.node(NodeId(2)).unwrap().x, 120.0);
        assert!(document.node(NodeId(1)).unwrap().clips_content);

        // Reparenting the constrained child into a Group keeps its constraint record verbatim.
        let mut group = node(3);
        group.kind = NodeKind::Group;
        group.name = "Group".into();
        document
            .submit(
                transaction(
                    2,
                    vec![
                        Command::Create(group),
                        Command::SetNodeParent {
                            id: NodeId(2),
                            parent_id: Some(NodeId(3)),
                            position: PositionId {
                                key: 5,
                                actor: ActorId(1),
                            },
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document.node(NodeId(2)).unwrap().constraints,
            Some(Constraints {
                horizontal: ConstraintType::Max,
                vertical: ConstraintType::Center
            })
        );
    }

    #[test]
    fn constrained_resize_is_hash_stable_across_replay_and_undo_redo() {
        let build = || {
            let mut document = Document::empty();
            let mut frame = node(1);
            frame.width = 200.0;
            frame.height = 100.0;
            let mut child = node(2);
            child.kind = NodeKind::Rectangle;
            child.name = "Child".into();
            child.parent_id = Some(NodeId(1));
            child.x = 20.0;
            child.y = 10.0;
            child.width = 40.0;
            child.height = 20.0;
            child.constraints = Some(Constraints {
                horizontal: ConstraintType::Scale,
                vertical: ConstraintType::Max,
            });
            document
                .submit(
                    transaction(0, vec![Command::Create(frame), Command::Create(child)]),
                    Origin::LocalUser,
                )
                .unwrap();
            document
                .submit(
                    transaction(
                        1,
                        vec![Command::UpdateGeometry {
                            id: NodeId(1),
                            x: 0.0,
                            y: 0.0,
                            width: 400.0,
                            height: 260.0,
                            rotation: 0.0,
                        }],
                    ),
                    Origin::LocalUser,
                )
                .unwrap();
            document
        };
        let first = build();
        let resized_hash = first.canonical_hash_hex();
        // Independent replay of the same command stream lands on the same hash.
        assert_eq!(build().canonical_hash_hex(), resized_hash);

        let mut document = build();
        document.undo().unwrap();
        let before_hash = document.canonical_hash_hex();
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), resized_hash);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), before_hash);
    }

    #[test]
    fn stroke_style_is_canonicalized_hashed_and_undoable() {
        let mut document = Document::empty();
        let mut line = node(1);
        line.kind = NodeKind::Line;
        line.name = "Divider".into();
        line.width = 120.0;
        line.height = 0.0;
        document
            .submit(
                transaction(0, vec![Command::Create(line)]),
                Origin::LocalUser,
            )
            .unwrap();
        let baseline = document.canonical_hash_hex();
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetAppearance {
                        id: NodeId(1),
                        appearance: Appearance {
                            fill: "#fff".into(),
                            stroke: "#2563eb".into(),
                            fills: Vec::new(),
                            strokes: Vec::new(),
                            stroke_width: 2.0,
                            stroke_cap_start: StrokeCap::None,
                            stroke_cap_end: StrokeCap::None,
                            stroke_join: StrokeJoin::Round,
                            stroke_miter_limit: 6.0,
                            stroke_dash_pattern: vec![8.0, 4.0, 2.0],
                            stroke_weights: Vec::new(),
                            stroke_align: Default::default(),
                            arc_data: None,
                            parametric_shape: None,
                            relative_transform: None,
                            opacity: 1.0,
                            blend_mode: BlendMode::Normal,
                            drop_shadow: None,
                            effect_stack: Vec::new(),
                            corner_radius: 0.0,
                            corner_radii: Vec::new(),
                            corner_smoothing: 0.0,
                            constraints: None,
                            visible: true,
                            locked: false,
                            contents_hidden: false,
                            clips_content: Some(false),
                        },
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let styled = document.node(NodeId(1)).unwrap();
        assert_eq!(styled.stroke_join, StrokeJoin::Round);
        assert_eq!(
            styled.stroke_dash_pattern,
            vec![8.0, 4.0, 2.0, 8.0, 4.0, 2.0]
        );
        let styled_hash = document.canonical_hash_hex();
        assert_ne!(styled_hash, baseline);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), styled_hash);
    }

    #[test]
    fn rectangle_per_side_stroke_weights_and_ellipse_stroke_align_are_hashed_and_reject_unsupported_nodes()
     {
        let mut document = Document::empty();
        document
            .submit(
                transaction(0, vec![Command::Create(node(1))]),
                Origin::LocalUser,
            )
            .unwrap();
        let baseline = document.canonical_hash_hex();
        let appearance = Appearance {
            fill: "#fff".into(),
            stroke: "#2563eb".into(),
            fills: Vec::new(),
            strokes: Vec::new(),
            stroke_width: 1.0,
            stroke_cap_start: StrokeCap::None,
            stroke_cap_end: StrokeCap::None,
            stroke_join: StrokeJoin::Miter,
            stroke_miter_limit: DEFAULT_STROKE_MITER_LIMIT,
            stroke_dash_pattern: Vec::new(),
            stroke_weights: vec![1.0, 2.0, 3.0, 4.0],
            stroke_align: StrokeAlign::Outside,
            arc_data: None,
            parametric_shape: None,
            relative_transform: None,
            opacity: 1.0,
            blend_mode: BlendMode::Normal,
            drop_shadow: None,
            effect_stack: Vec::new(),
            corner_radius: 0.0,
            corner_radii: Vec::new(),
            corner_smoothing: 0.0,
            constraints: None,
            visible: true,
            locked: false,
            contents_hidden: false,
            clips_content: Some(false),
        };
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetAppearance {
                        id: NodeId(1),
                        appearance: appearance.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document.node(NodeId(1)).unwrap().stroke_weights,
            vec![1.0, 2.0, 3.0, 4.0]
        );
        assert_eq!(
            document.node(NodeId(1)).unwrap().stroke_align,
            StrokeAlign::Outside
        );
        let weighted = document.canonical_hash_hex();
        assert_ne!(weighted, baseline);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), weighted);

        let mut line = node(2);
        line.kind = NodeKind::Line;
        line.name = "Line".into();
        line.width = 20.0;
        line.height = 0.0;
        document
            .submit(
                transaction(4, vec![Command::Create(line)]),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document.submit(
                transaction(
                    5,
                    vec![Command::SetAppearance {
                        id: NodeId(2),
                        appearance: appearance.clone()
                    }]
                ),
                Origin::LocalUser
            ),
            Err(CommandError::InvalidAppearance),
        );

        let mut ellipse = node(3);
        ellipse.kind = NodeKind::Ellipse;
        ellipse.name = "Ellipse".into();
        document
            .submit(
                transaction(5, vec![Command::Create(ellipse)]),
                Origin::LocalUser,
            )
            .unwrap();
        let ellipse_appearance = Appearance {
            stroke_weights: Vec::new(),
            stroke_align: StrokeAlign::Outside,
            ..appearance.clone()
        };
        document
            .submit(
                transaction(
                    6,
                    vec![Command::SetAppearance {
                        id: NodeId(3),
                        appearance: ellipse_appearance.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document.node(NodeId(3)).unwrap().stroke_align,
            StrokeAlign::Outside
        );
        let arc_appearance = Appearance {
            arc_data: Some(ArcData {
                starting_angle: 0.0,
                ending_angle: 90.0,
                inner_radius: 0.0,
            }),
            ..ellipse_appearance
        };
        assert_eq!(
            document.submit(
                transaction(
                    7,
                    vec![Command::SetAppearance {
                        id: NodeId(3),
                        appearance: arc_appearance
                    }]
                ),
                Origin::LocalUser
            ),
            Err(CommandError::InvalidAppearance),
        );
    }

    #[test]
    fn ellipse_arc_is_hashed_undoable_and_rejected_for_non_ellipse() {
        let mut document = Document::empty();
        let mut ellipse = node(1);
        ellipse.kind = NodeKind::Ellipse;
        ellipse.name = "Arc".into();
        document
            .submit(
                transaction(0, vec![Command::Create(ellipse)]),
                Origin::LocalUser,
            )
            .unwrap();
        let baseline = document.canonical_hash_hex();
        let appearance = Appearance {
            fill: "#fff".into(),
            stroke: "#000".into(),
            fills: Vec::new(),
            strokes: Vec::new(),
            stroke_width: 1.0,
            stroke_cap_start: StrokeCap::None,
            stroke_cap_end: StrokeCap::None,
            stroke_join: StrokeJoin::Miter,
            stroke_miter_limit: DEFAULT_STROKE_MITER_LIMIT,
            stroke_dash_pattern: Vec::new(),
            stroke_weights: Vec::new(),
            stroke_align: StrokeAlign::Inside,
            arc_data: Some(ArcData {
                starting_angle: 0.0,
                ending_angle: 180.0,
                inner_radius: 0.4,
            }),
            parametric_shape: None,
            relative_transform: None,
            opacity: 1.0,
            blend_mode: BlendMode::Normal,
            drop_shadow: None,
            effect_stack: Vec::new(),
            corner_radius: 0.0,
            corner_radii: Vec::new(),
            corner_smoothing: 0.0,
            constraints: None,
            visible: true,
            locked: false,
            contents_hidden: false,
            clips_content: Some(false),
        };
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetAppearance {
                        id: NodeId(1),
                        appearance: appearance.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document.node(NodeId(1)).unwrap().arc_data,
            appearance.arc_data
        );
        let arc_hash = document.canonical_hash_hex();
        assert_ne!(arc_hash, baseline);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), arc_hash);
        assert_eq!(
            document
                .submit(
                    transaction(
                        4,
                        vec![Command::SetAppearance {
                            id: NodeId(1),
                            appearance: Appearance {
                                arc_data: None,
                                ..appearance
                            }
                        }]
                    ),
                    Origin::LocalUser
                )
                .unwrap()
                .accepted_revision,
            5
        );
    }

    #[test]
    fn relative_transform_is_hashed_undoable_and_rejects_singular_matrices() {
        let mut document = Document::empty();
        document
            .submit(
                transaction(0, vec![Command::Create(node(1))]),
                Origin::LocalUser,
            )
            .unwrap();
        let baseline = document.canonical_hash_hex();
        let appearance = Appearance {
            fill: "#fff".into(),
            stroke: "#00000000".into(),
            fills: Vec::new(),
            strokes: Vec::new(),
            stroke_width: 0.0,
            stroke_cap_start: StrokeCap::None,
            stroke_cap_end: StrokeCap::None,
            stroke_join: StrokeJoin::Miter,
            stroke_miter_limit: DEFAULT_STROKE_MITER_LIMIT,
            stroke_dash_pattern: Vec::new(),
            stroke_weights: Vec::new(),
            stroke_align: StrokeAlign::Inside,
            arc_data: None,
            parametric_shape: None,
            relative_transform: Some(AffineTransform {
                a: 0.0,
                b: 1.0,
                c: -1.0,
                d: 0.0,
                e: 40.0,
                f: 20.0,
            }),
            opacity: 1.0,
            blend_mode: BlendMode::Normal,
            drop_shadow: None,
            effect_stack: Vec::new(),
            corner_radius: 0.0,
            corner_radii: Vec::new(),
            corner_smoothing: 0.0,
            constraints: None,
            visible: true,
            locked: false,
            contents_hidden: false,
            clips_content: Some(false),
        };
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetAppearance {
                        id: NodeId(1),
                        appearance: appearance.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document.node(NodeId(1)).unwrap().relative_transform,
            appearance.relative_transform
        );
        let transformed = document.canonical_hash_hex();
        assert_ne!(transformed, baseline);
        document.undo().unwrap();
        assert_eq!(document.node(NodeId(1)).unwrap().relative_transform, None);
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), transformed);

        let singular = Appearance {
            relative_transform: Some(AffineTransform {
                a: 0.0,
                b: 0.0,
                c: 0.0,
                d: 0.0,
                e: 0.0,
                f: 0.0,
            }),
            ..appearance
        };
        assert_eq!(
            document.submit(
                transaction(
                    4,
                    vec![Command::SetAppearance {
                        id: NodeId(1),
                        appearance: singular
                    }]
                ),
                Origin::LocalUser
            ),
            Err(CommandError::InvalidAppearance),
        );
    }

    #[test]
    fn pages_are_canonical_and_reject_cross_page_parent_references() {
        let mut document = Document::empty();
        let design_page = Page {
            id: PageId(2),
            name: "Design".into(),
            position: PositionId {
                key: 2,
                actor: ActorId(0),
            },
        };
        document.seed_page(design_page).unwrap();

        let parent = node(1);
        document.seed_node_on_page(PageId(2), parent).unwrap();
        let mut child = node(2);
        child.parent_id = Some(NodeId(1));
        document.seed_node_on_page(PageId(2), child).unwrap();
        assert_eq!(document.page_for_node(NodeId(2)), Some(PageId(2)));
        assert_eq!(document.ordered_nodes_on_page(PageId(2)).unwrap().len(), 2);

        let mut invalid = node(3);
        invalid.parent_id = Some(NodeId(1));
        assert_eq!(
            document.seed_node(invalid),
            Err(CommandError::MissingParent { id: NodeId(1) })
        );
        assert_eq!(
            document
                .ordered_nodes_on_page(DEFAULT_PAGE_ID)
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn node_creation_rejects_non_container_parent() {
        let mut document = Document::empty();
        let mut rectangle = node(1);
        rectangle.kind = NodeKind::Rectangle;
        document.seed_node(rectangle).unwrap();

        let mut child = node(2);
        child.parent_id = Some(NodeId(1));
        assert_eq!(
            document.seed_node(child),
            Err(CommandError::InvalidParent { id: NodeId(1) })
        );
        assert_eq!(document.node_count(), 1);
    }

    #[test]
    fn slides_hierarchy_requires_one_grid_then_rows_then_fixed_size_slides() {
        let mut document = Document::empty();
        let mut grid = node(1);
        grid.kind = NodeKind::SlideGrid;
        document.seed_node(grid).unwrap();

        let mut row = node(2);
        row.kind = NodeKind::SlideRow;
        row.parent_id = Some(NodeId(1));
        document.seed_node(row).unwrap();

        let mut slide = node(3);
        slide.kind = NodeKind::Slide;
        slide.parent_id = Some(NodeId(2));
        slide.width = 1920.0;
        slide.height = 1080.0;
        document.seed_node(slide).unwrap();

        let mut second_grid = node(4);
        second_grid.kind = NodeKind::SlideGrid;
        assert_eq!(
            document.seed_node(second_grid),
            Err(CommandError::InvalidParent { id: NodeId(4) })
        );
        let mut top_level_row = node(5);
        top_level_row.kind = NodeKind::SlideRow;
        assert_eq!(
            document.seed_node(top_level_row),
            Err(CommandError::InvalidParent { id: NodeId(5) })
        );
        let mut malformed_slide = node(6);
        malformed_slide.kind = NodeKind::Slide;
        malformed_slide.parent_id = Some(NodeId(2));
        malformed_slide.width = 1919.0;
        malformed_slide.height = 1080.0;
        assert_eq!(
            document.seed_node(malformed_slide),
            Err(CommandError::InvalidGeometry)
        );
    }

    #[test]
    fn locked_group_blocks_descendant_mutations_but_can_be_explicitly_unlocked() {
        let mut document = Document::empty();
        let mut group = node(1);
        group.kind = NodeKind::Group;
        group.name = "Locked group".into();
        document.seed_node(group).unwrap();
        let mut child = node(2);
        child.parent_id = Some(NodeId(1));
        document.seed_node(child).unwrap();

        let mut lock_group = appearance_for_node(document.node(NodeId(1)).unwrap());
        lock_group.locked = true;
        document
            .submit(
                transaction(
                    0,
                    vec![Command::SetAppearance {
                        id: NodeId(1),
                        appearance: lock_group,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert!(document.is_effectively_locked(NodeId(2)));

        assert_eq!(
            document.submit(
                transaction(
                    1,
                    vec![Command::UpdateGeometry {
                        id: NodeId(2),
                        x: 10.0,
                        y: 20.0,
                        width: 240.0,
                        height: 160.0,
                        rotation: 0.0,
                    }],
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::EffectivelyLocked { id: NodeId(2) })
        );

        let mut unlock_group = appearance_for_node(document.node(NodeId(1)).unwrap());
        unlock_group.locked = false;
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetAppearance {
                        id: NodeId(1),
                        appearance: unlock_group,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert!(!document.is_effectively_locked(NodeId(2)));
    }

    #[test]
    fn page_creation_and_page_scoped_node_creation_are_atomic_and_undoable() {
        let mut document = Document::empty();
        let page = Page {
            id: PageId(2),
            name: "Design".into(),
            position: PositionId::for_node(NodeId(2)),
        };
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::CreatePage(page.clone()),
                        Command::CreateInPage {
                            page_id: page.id,
                            node: node(7),
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(document.page_for_node(NodeId(7)), Some(PageId(2)));
        assert_eq!(document.ordered_nodes_on_page(PageId(2)).unwrap().len(), 1);
        document.undo().unwrap();
        assert!(document.page(PageId(2)).is_none());
        assert!(document.node(NodeId(7)).is_none());
        document.redo().unwrap();
        assert_eq!(document.page_for_node(NodeId(7)), Some(PageId(2)));
    }

    #[test]
    fn text_content_is_canonical_undoable_and_operation_hashed() {
        let mut document = Document::empty();
        let mut text_node = node(1);
        text_node.kind = NodeKind::Text;
        text_node.text = "Before".into();
        document
            .submit(
                transaction(0, vec![Command::Create(text_node)]),
                Origin::LocalUser,
            )
            .unwrap();
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetText {
                        id: NodeId(1),
                        text: "After".into(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(document.node(NodeId(1)).unwrap().text, "After");
        assert_eq!(document.undo(), Some(3));
        assert_eq!(document.node(NodeId(1)).unwrap().text, "Before");
        assert_eq!(document.redo(), Some(4));
        assert_eq!(document.node(NodeId(1)).unwrap().text, "After");

        let before = Transaction {
            id: TransactionId(90),
            base_revision: 4,
            commands: vec![Command::SetText {
                id: NodeId(1),
                text: "Before".into(),
            }],
        };
        let after = Transaction {
            id: TransactionId(91),
            base_revision: 4,
            commands: vec![Command::SetText {
                id: NodeId(1),
                text: "After".into(),
            }],
        };
        assert_ne!(
            OperationEnvelope::payload_hash_for(&before),
            OperationEnvelope::payload_hash_for(&after)
        );
        assert_eq!(
            document.submit(
                transaction(
                    4,
                    vec![Command::SetText {
                        id: NodeId(1),
                        text: "x".repeat(MAX_TEXT_BYTES + 1),
                    }],
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidText)
        );
        assert_eq!(document.node(NodeId(1)).unwrap().text, "After");
    }

    #[test]
    fn shape_with_text_text_sublayer_properties_are_canonical_and_undoable() {
        let mut document = Document::empty();
        let mut shape = node(41);
        shape.kind = NodeKind::ShapeWithText;
        shape.text = "Approve".into();
        document
            .submit(
                transaction(0, vec![Command::Create(shape)]),
                Origin::LocalUser,
            )
            .unwrap();
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetText {
                        id: NodeId(41),
                        text: "Review".into(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(document.node(NodeId(41)).unwrap().text, "Review");
        let properties = TextProperties {
            runs: vec![TextStyleRun {
                start: 0,
                end: 6,
                font: None,
                font_size: 18.0,
                font_weight: 650,
                italic: false,
                letter_spacing: 1.5,
                color: None,
                fill_stack: None,
                text_case: None,
                hyperlink: None,
                text_decoration: None,
                text_decoration_style: None,
                text_decoration_offset: None,
                text_decoration_thickness: None,
                text_decoration_skip_ink: None,
                leading_trim: None,
                open_type_features: Vec::new(),
                text_style_id: None,
                paint_style_id: None,
                variable_bindings: Default::default(),
                text_decoration_color: None,
            }],
            paragraph: ParagraphStyle {
                alignment: TextAlign::Center,
                line_height: Some(24.0),
                line_height_unit: None,
                paragraph_spacing: 4.0,
                paragraph_indent: None,
                text_wrap_style: None,
                list_type: None,
                list_spacing: None,
                hanging_list: false,
                hanging_punctuation: false,
            },
            ..TextProperties::default()
        };
        document
            .submit(
                transaction(
                    2,
                    vec![Command::SetTextProperties {
                        id: NodeId(41),
                        properties: properties.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document.text_properties_for_node(NodeId(41)),
            Some(&properties)
        );
        assert_eq!(document.undo(), Some(4));
        assert_eq!(document.text_properties_for_node(NodeId(41)), None);
        assert_eq!(document.redo(), Some(5));
        assert_eq!(
            document.text_properties_for_node(NodeId(41)),
            Some(&properties)
        );
    }

    #[test]
    fn line_height_units_are_validated_hashed_and_resolved() {
        let pixels = ParagraphStyle {
            alignment: TextAlign::Left,
            line_height: Some(24.0),
            line_height_unit: None,
            paragraph_spacing: 0.0,
            paragraph_indent: None,
            text_wrap_style: None,
            list_type: None,
            list_spacing: None,
            hanging_list: false,
            hanging_punctuation: false,
        };
        let percent = ParagraphStyle {
            line_height: Some(150.0),
            line_height_unit: Some(LineHeightUnit::Percent),
            ..pixels.clone()
        };
        let auto = ParagraphStyle {
            line_height: None,
            line_height_unit: Some(LineHeightUnit::Auto),
            ..pixels.clone()
        };
        assert_eq!(pixels.effective_line_height(20.0), 24.0);
        assert_eq!(percent.effective_line_height(20.0), 30.0);
        assert_eq!(auto.effective_line_height(20.0), 24.0);

        let mut document = Document::empty();
        let mut shape = node(42);
        shape.kind = NodeKind::ShapeWithText;
        shape.text = "A".into();
        document
            .submit(
                transaction(0, vec![Command::Create(shape)]),
                Origin::LocalUser,
            )
            .unwrap();
        let base = TextProperties {
            runs: vec![TextStyleRun {
                start: 0,
                end: 1,
                font: None,
                font_size: 20.0,
                font_weight: 400,
                italic: false,
                letter_spacing: 0.0,
                color: None,
                fill_stack: None,
                text_case: None,
                hyperlink: None,
                text_decoration: None,
                text_decoration_style: None,
                text_decoration_offset: None,
                text_decoration_thickness: None,
                text_decoration_skip_ink: None,
                leading_trim: None,
                open_type_features: Vec::new(),
                text_style_id: None,
                paint_style_id: None,
                variable_bindings: Default::default(),
                text_decoration_color: None,
            }],
            paragraph: pixels,
            ..TextProperties::default()
        };
        let percent_properties = TextProperties {
            paragraph: percent,
            ..base.clone()
        };
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetTextProperties {
                        id: NodeId(42),
                        properties: percent_properties,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let percent_hash = document.canonical_hash_hex();
        document
            .submit(
                transaction(
                    2,
                    vec![Command::SetTextProperties {
                        id: NodeId(42),
                        properties: TextProperties {
                            paragraph: auto,
                            ..base.clone()
                        },
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_ne!(document.canonical_hash_hex(), percent_hash);
        let invalid_auto = TextProperties {
            paragraph: ParagraphStyle {
                line_height: Some(20.0),
                line_height_unit: Some(LineHeightUnit::Auto),
                ..base.paragraph.clone()
            },
            ..base
        };
        assert_eq!(
            document.submit(
                transaction(
                    3,
                    vec![Command::SetTextProperties {
                        id: NodeId(42),
                        properties: invalid_auto
                    }]
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidTextProperties)
        );
    }

    #[test]
    fn paragraph_indent_is_validated_hashed_and_included_in_auto_size() {
        let mut document = Document::empty();
        let mut text = node(43);
        text.kind = NodeKind::Text;
        text.text = "abcd".into();
        document
            .submit(
                transaction(0, vec![Command::Create(text.clone())]),
                Origin::LocalUser,
            )
            .unwrap();
        let properties = TextProperties {
            runs: vec![TextStyleRun {
                start: 0,
                end: 4,
                font: None,
                font_size: 10.0,
                font_weight: 400,
                italic: false,
                letter_spacing: 0.0,
                color: None,
                fill_stack: None,
                text_case: None,
                hyperlink: None,
                text_decoration: None,
                text_decoration_style: None,
                text_decoration_offset: None,
                text_decoration_thickness: None,
                text_decoration_skip_ink: None,
                leading_trim: None,
                open_type_features: Vec::new(),
                text_style_id: None,
                paint_style_id: None,
                variable_bindings: Default::default(),
                text_decoration_color: None,
            }],
            paragraph: ParagraphStyle {
                paragraph_indent: Some(12.0),
                text_wrap_style: None,
                list_type: None,
                list_spacing: None,
                hanging_list: false,
                ..ParagraphStyle {
                    alignment: TextAlign::Left,
                    line_height: Some(20.0),
                    line_height_unit: None,
                    paragraph_spacing: 0.0,
                    paragraph_indent: None,
                    text_wrap_style: None,
                    list_type: None,
                    list_spacing: None,
                    hanging_list: false,
                    hanging_punctuation: false,
                }
            },
            auto_size: TextAutoSize::WidthAndHeight,
            ..TextProperties::default()
        };
        let legacy_hash = document.canonical_hash();
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetTextProperties {
                        id: NodeId(43),
                        properties: properties.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_ne!(document.canonical_hash(), legacy_hash);
        assert_eq!(
            document.auto_layout_text_size(document.node(NodeId(43)).unwrap()),
            (36.0, 20.0)
        );

        let mut cap_height = properties.clone();
        cap_height.runs[0].leading_trim = Some(LeadingTrim::CapHeight);
        document
            .submit(
                transaction(
                    document.revision,
                    vec![Command::SetTextProperties {
                        id: NodeId(43),
                        properties: cap_height,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document.auto_layout_text_size(document.node(NodeId(43)).unwrap()),
            (36.0, 7.0)
        );

        let invalid = TextProperties {
            paragraph: ParagraphStyle {
                paragraph_indent: Some(-1.0),
                text_wrap_style: None,
                list_type: None,
                list_spacing: None,
                hanging_list: false,
                ..properties.paragraph.clone()
            },
            ..properties
        };
        assert!(!document.valid_text_properties("abcd", &invalid));
    }

    #[test]
    fn text_wrap_style_is_presence_hashed_and_undoable() {
        let mut document = Document::empty();
        let mut text = node(44);
        text.kind = NodeKind::ShapeWithText;
        text.text = "aa bb cc dd".into();
        document
            .submit(
                transaction(0, vec![Command::Create(text)]),
                Origin::LocalUser,
            )
            .unwrap();
        let legacy_hash = document.canonical_hash();
        let mut properties = TextProperties::default();
        properties.paragraph.text_wrap_style = Some(TextWrapStyle::Balance);
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetTextProperties {
                        id: NodeId(44),
                        properties: properties.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let balance_hash = document.canonical_hash();
        assert_ne!(balance_hash, legacy_hash);

        properties.paragraph.text_wrap_style = Some(TextWrapStyle::Pretty);
        document
            .submit(
                transaction(
                    2,
                    vec![Command::SetTextProperties {
                        id: NodeId(44),
                        properties: properties.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_ne!(document.canonical_hash(), balance_hash);
        assert_eq!(document.undo(), Some(4));
        assert_eq!(
            document
                .text_properties_for_node(NodeId(44))
                .unwrap()
                .paragraph
                .text_wrap_style,
            Some(TextWrapStyle::Balance)
        );
    }

    #[test]
    fn paragraph_text_wrap_style_overrides_are_canonical_hashed_and_undoable() {
        let mut document = Document::empty();
        let mut text = node(152);
        text.kind = NodeKind::Text;
        text.text = "One\nTwo".into();
        document
            .submit(
                transaction(0, vec![Command::Create(text)]),
                Origin::LocalUser,
            )
            .unwrap();

        let mut properties = TextProperties::default();
        properties.paragraph.text_wrap_style = Some(TextWrapStyle::Balance);
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetTextProperties {
                        id: NodeId(152),
                        properties: properties.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let inherited_hash = document.canonical_hash();

        properties.paragraph_style_runs = vec![ParagraphStyleRun {
            start: 4,
            indentation: None,
            list_type: None,
            list_spacing: None,
            paragraph_spacing: None,
            paragraph_indent: None,
            line_height: None,
            line_height_unit: None,
            text_wrap_style: Some(TextWrapStyle::Auto),
        }];
        document
            .submit(
                transaction(
                    2,
                    vec![Command::SetTextProperties {
                        id: NodeId(152),
                        properties: properties.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_ne!(document.canonical_hash(), inherited_hash);

        let mut redundant = properties.clone();
        redundant.paragraph_style_runs[0].text_wrap_style = Some(TextWrapStyle::Balance);
        assert_eq!(
            document.submit(
                transaction(
                    document.revision,
                    vec![Command::SetTextProperties {
                        id: NodeId(152),
                        properties: redundant,
                    }],
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidTextProperties)
        );

        assert_eq!(document.undo(), Some(4));
        assert!(
            document
                .text_properties_for_node(NodeId(152))
                .unwrap()
                .paragraph_style_runs
                .is_empty()
        );
    }

    #[test]
    fn text_list_type_is_presence_hashed_undoable_and_included_in_auto_size() {
        let mut document = Document::empty();
        let mut text = node(45);
        text.kind = NodeKind::Text;
        text.text = (1..=10)
            .map(|index| index.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        document
            .submit(
                transaction(0, vec![Command::Create(text)]),
                Origin::LocalUser,
            )
            .unwrap();
        let legacy_hash = document.canonical_hash();
        let mut properties = TextProperties::default();
        properties.auto_size = TextAutoSize::WidthAndHeight;
        properties.paragraph.list_type = Some(TextListType::Ordered);
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetTextProperties {
                        id: NodeId(45),
                        properties: properties.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let ordered_hash = document.canonical_hash();
        assert_ne!(ordered_hash, legacy_hash);
        // Default 31px text: the widest content is two glyphs (37.2px) and a
        // four-column `10. ` gutter is 74.4px.
        assert_eq!(
            document.auto_layout_text_size(document.node(NodeId(45)).unwrap()),
            (111.6, 200.0)
        );

        properties.paragraph.list_type = Some(TextListType::Unordered);
        document
            .submit(
                transaction(
                    2,
                    vec![Command::SetTextProperties {
                        id: NodeId(45),
                        properties,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_ne!(document.canonical_hash(), ordered_hash);
        assert_eq!(document.undo(), Some(4));
        assert_eq!(
            document
                .text_properties_for_node(NodeId(45))
                .unwrap()
                .paragraph
                .list_type,
            Some(TextListType::Ordered)
        );
    }

    #[test]
    fn text_list_spacing_is_presence_hashed_validated_undoable_and_included_in_auto_size() {
        let mut document = Document::empty();
        let mut text = node(46);
        text.kind = NodeKind::Text;
        text.text = "One\nTwo".into();
        document
            .submit(
                transaction(0, vec![Command::Create(text)]),
                Origin::LocalUser,
            )
            .unwrap();

        let mut properties = TextProperties::default();
        properties.auto_size = TextAutoSize::Height;
        properties.paragraph.list_type = Some(TextListType::Ordered);
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetTextProperties {
                        id: NodeId(46),
                        properties: properties.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let zero_spacing_hash = document.canonical_hash();
        assert_eq!(
            document.auto_layout_text_size(document.node(NodeId(46)).unwrap()),
            (111.6, 40.0)
        );

        let mut invalid = properties.clone();
        invalid.paragraph.list_spacing = Some(-1.0);
        assert!(
            document
                .submit(
                    transaction(
                        2,
                        vec![Command::SetTextProperties {
                            id: NodeId(46),
                            properties: invalid,
                        }],
                    ),
                    Origin::LocalUser,
                )
                .is_err()
        );
        assert_eq!(document.canonical_hash(), zero_spacing_hash);

        properties.paragraph.list_spacing = Some(8.0);
        document
            .submit(
                transaction(
                    2,
                    vec![Command::SetTextProperties {
                        id: NodeId(46),
                        properties,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_ne!(document.canonical_hash(), zero_spacing_hash);
        assert_eq!(
            document.auto_layout_text_size(document.node(NodeId(46)).unwrap()),
            (111.6, 48.0)
        );

        assert!(document.undo().is_some());
        assert_eq!(document.canonical_hash(), zero_spacing_hash);
        assert_eq!(
            document
                .text_properties_for_node(NodeId(46))
                .unwrap()
                .paragraph
                .list_spacing,
            None
        );
    }

    #[test]
    fn paragraph_list_spacing_overrides_are_canonical_hashed_and_measured_per_boundary() {
        let mut document = Document::empty();
        let mut text = node(47);
        text.kind = NodeKind::Text;
        text.text = "One\nTwo".into();
        document
            .submit(
                transaction(0, vec![Command::Create(text)]),
                Origin::LocalUser,
            )
            .unwrap();

        let mut properties = TextProperties::default();
        properties.auto_size = TextAutoSize::Height;
        properties.paragraph.list_type = Some(TextListType::Ordered);
        properties.paragraph.list_spacing = Some(8.0);
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetTextProperties {
                        id: NodeId(47),
                        properties: properties.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let global_hash = document.canonical_hash();
        assert_eq!(
            document.auto_layout_text_size(document.node(NodeId(47)).unwrap()),
            (111.6, 48.0)
        );

        properties.paragraph_style_runs = vec![ParagraphStyleRun {
            start: 0,
            indentation: None,
            list_type: None,
            list_spacing: Some(0.0),
            paragraph_spacing: None,
            paragraph_indent: None,
            line_height: None,
            line_height_unit: None,
            text_wrap_style: None,
        }];
        document
            .submit(
                transaction(
                    2,
                    vec![Command::SetTextProperties {
                        id: NodeId(47),
                        properties: properties.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let disabled_hash = document.canonical_hash();
        assert_ne!(disabled_hash, global_hash);
        assert_eq!(
            document.auto_layout_text_size(document.node(NodeId(47)).unwrap()),
            (111.6, 40.0)
        );

        properties.paragraph_style_runs[0].list_spacing = Some(12.0);
        document
            .submit(
                transaction(
                    3,
                    vec![Command::SetTextProperties {
                        id: NodeId(47),
                        properties: properties.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_ne!(document.canonical_hash(), disabled_hash);
        assert_eq!(
            document.auto_layout_text_size(document.node(NodeId(47)).unwrap()),
            (111.6, 52.0)
        );

        for invalid_spacing in [8.0, -1.0, f64::NAN] {
            let mut invalid = properties.clone();
            invalid.paragraph_style_runs[0].list_spacing = Some(invalid_spacing);
            assert!(
                document
                    .submit(
                        transaction(
                            document.revision,
                            vec![Command::SetTextProperties {
                                id: NodeId(47),
                                properties: invalid,
                            }],
                        ),
                        Origin::LocalUser,
                    )
                    .is_err()
            );
        }
    }

    #[test]
    fn paragraph_spacing_overrides_are_canonical_hashed_and_measured_per_boundary() {
        let mut document = Document::empty();
        let mut text = node(147);
        text.kind = NodeKind::Text;
        text.text = "One\nTwo\nThree".into();
        document
            .submit(
                transaction(0, vec![Command::Create(text)]),
                Origin::LocalUser,
            )
            .unwrap();

        let mut properties = TextProperties::default();
        properties.auto_size = TextAutoSize::Height;
        properties.paragraph.paragraph_spacing = 8.0;
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetTextProperties {
                        id: NodeId(147),
                        properties: properties.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let global_hash = document.canonical_hash();
        assert_eq!(
            document.auto_layout_text_size(document.node(NodeId(147)).unwrap()),
            (93.0, 76.0)
        );

        properties.paragraph_style_runs = vec![
            ParagraphStyleRun {
                start: 0,
                indentation: None,
                list_type: None,
                list_spacing: None,
                paragraph_spacing: Some(0.0),
                paragraph_indent: None,
                line_height: None,
                line_height_unit: None,
                text_wrap_style: None,
            },
            ParagraphStyleRun {
                start: 4,
                indentation: None,
                list_type: None,
                list_spacing: None,
                paragraph_spacing: Some(12.0),
                paragraph_indent: None,
                line_height: None,
                line_height_unit: None,
                text_wrap_style: None,
            },
        ];
        document
            .submit(
                transaction(
                    2,
                    vec![Command::SetTextProperties {
                        id: NodeId(147),
                        properties: properties.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_ne!(document.canonical_hash(), global_hash);
        assert_eq!(
            document.auto_layout_text_size(document.node(NodeId(147)).unwrap()),
            (93.0, 72.0)
        );

        for invalid_spacing in [8.0, -1.0, f64::NAN] {
            let mut invalid = properties.clone();
            invalid.paragraph_style_runs[0].paragraph_spacing = Some(invalid_spacing);
            assert_eq!(
                document.submit(
                    transaction(
                        document.revision,
                        vec![Command::SetTextProperties {
                            id: NodeId(147),
                            properties: invalid,
                        }],
                    ),
                    Origin::LocalUser,
                ),
                Err(CommandError::InvalidTextProperties)
            );
        }
    }

    #[test]
    fn paragraph_indent_overrides_are_canonical_hashed_and_measured_per_paragraph() {
        let mut document = Document::empty();
        let mut text = node(149);
        text.kind = NodeKind::Text;
        text.text = "A\nA".into();
        document
            .submit(
                transaction(0, vec![Command::Create(text)]),
                Origin::LocalUser,
            )
            .unwrap();
        let mut properties = TextProperties::default();
        properties.auto_size = TextAutoSize::WidthAndHeight;
        properties.paragraph.paragraph_indent = Some(8.0);
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetTextProperties {
                        id: NodeId(149),
                        properties: properties.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document.auto_layout_text_size(document.node(NodeId(149)).unwrap()),
            (26.6, 40.0)
        );
        let inherited_hash = document.canonical_hash();
        properties.paragraph_style_runs = vec![
            ParagraphStyleRun {
                start: 0,
                indentation: None,
                list_type: None,
                list_spacing: None,
                paragraph_spacing: None,
                paragraph_indent: Some(0.0),
                line_height: None,
                line_height_unit: None,
                text_wrap_style: None,
            },
            ParagraphStyleRun {
                start: 2,
                indentation: None,
                list_type: None,
                list_spacing: None,
                paragraph_spacing: None,
                paragraph_indent: Some(12.0),
                line_height: None,
                line_height_unit: None,
                text_wrap_style: None,
            },
        ];
        document
            .submit(
                transaction(
                    document.revision,
                    vec![Command::SetTextProperties {
                        id: NodeId(149),
                        properties: properties.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_ne!(document.canonical_hash(), inherited_hash);
        assert_eq!(
            document.auto_layout_text_size(document.node(NodeId(149)).unwrap()),
            (30.6, 40.0)
        );

        for invalid_indent in [8.0, -1.0, f64::NAN] {
            let mut invalid = properties.clone();
            invalid.paragraph_style_runs[0].paragraph_indent = Some(invalid_indent);
            assert_eq!(
                document.submit(
                    transaction(
                        document.revision,
                        vec![Command::SetTextProperties {
                            id: NodeId(149),
                            properties: invalid,
                        }],
                    ),
                    Origin::LocalUser,
                ),
                Err(CommandError::InvalidTextProperties)
            );
        }
    }

    #[test]
    fn paragraph_line_height_overrides_are_atomic_hashed_and_measured_per_visual_line() {
        let mut document = Document::empty();
        let mut text = node(150);
        text.kind = NodeKind::Text;
        text.text = "A\nA".into();
        document
            .submit(
                transaction(0, vec![Command::Create(text)]),
                Origin::LocalUser,
            )
            .unwrap();
        let mut properties = TextProperties::default();
        properties.auto_size = TextAutoSize::WidthAndHeight;
        let inherited_hash = document.canonical_hash();
        properties.paragraph_style_runs = vec![
            ParagraphStyleRun {
                start: 0,
                indentation: None,
                list_type: None,
                list_spacing: None,
                paragraph_spacing: None,
                paragraph_indent: None,
                line_height: Some(30.0),
                line_height_unit: None,
                text_wrap_style: None,
            },
            ParagraphStyleRun {
                start: 2,
                indentation: None,
                list_type: None,
                list_spacing: None,
                paragraph_spacing: None,
                paragraph_indent: None,
                line_height: None,
                line_height_unit: Some(LineHeightUnit::Auto),
                text_wrap_style: None,
            },
        ];
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetTextProperties {
                        id: NodeId(150),
                        properties: properties.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_ne!(document.canonical_hash(), inherited_hash);
        assert_eq!(
            document.auto_layout_text_size(document.node(NodeId(150)).unwrap()),
            (18.6, 67.2)
        );

        for (line_height, unit) in [
            (None, Some(LineHeightUnit::Percent)),
            (Some(20.0), Some(LineHeightUnit::Auto)),
            (Some(0.0), None),
        ] {
            let mut invalid = properties.clone();
            invalid.paragraph_style_runs[0].line_height = line_height;
            invalid.paragraph_style_runs[0].line_height_unit = unit;
            assert_eq!(
                document.submit(
                    transaction(
                        document.revision,
                        vec![Command::SetTextProperties {
                            id: NodeId(150),
                            properties: invalid
                        }],
                    ),
                    Origin::LocalUser,
                ),
                Err(CommandError::InvalidTextProperties)
            );
        }
    }

    #[test]
    fn hanging_punctuation_changes_hash_and_core_auto_size_width() {
        let mut document = Document::empty();
        let mut text = node(151);
        text.kind = NodeKind::Text;
        text.text = "“AB。”".into();
        document
            .submit(
                transaction(0, vec![Command::Create(text)]),
                Origin::LocalUser,
            )
            .unwrap();
        let mut properties = TextProperties::default();
        properties.auto_size = TextAutoSize::WidthAndHeight;
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetTextProperties {
                        id: NodeId(151),
                        properties: properties.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let legacy_hash = document.canonical_hash();
        assert_eq!(
            document.auto_layout_text_size(document.node(NodeId(151)).unwrap()),
            (93.0, 20.0)
        );

        properties.paragraph.hanging_punctuation = true;
        document
            .submit(
                transaction(
                    2,
                    vec![Command::SetTextProperties {
                        id: NodeId(151),
                        properties,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_ne!(document.canonical_hash(), legacy_hash);
        assert_eq!(
            document.auto_layout_text_size(document.node(NodeId(151)).unwrap()),
            (55.8, 20.0)
        );
    }

    #[test]
    fn paragraph_style_runs_validate_hash_and_measure_nested_list_indentation() {
        let mut document = Document::empty();
        let mut text = node(48);
        text.kind = NodeKind::Text;
        text.text = "One\nTwo".into();
        document
            .submit(
                transaction(0, vec![Command::Create(text)]),
                Origin::LocalUser,
            )
            .unwrap();
        let mut properties = TextProperties::default();
        properties.auto_size = TextAutoSize::WidthAndHeight;
        properties.paragraph.list_type = Some(TextListType::Ordered);
        let base_hash = document.canonical_hash();
        properties.paragraph_style_runs = vec![ParagraphStyleRun {
            start: 4,
            indentation: Some(2),
            list_type: None,
            list_spacing: None,
            paragraph_spacing: None,
            paragraph_indent: None,
            line_height: None,
            line_height_unit: None,
            text_wrap_style: None,
        }];
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetTextProperties {
                        id: NodeId(48),
                        properties: properties.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_ne!(document.canonical_hash(), base_hash);
        assert_eq!(
            document.auto_layout_text_size(document.node(NodeId(48)).unwrap()),
            (167.4, 40.0)
        );

        let inside_marker_hash = document.canonical_hash();
        properties.paragraph.hanging_list = true;
        document
            .submit(
                transaction(
                    document.revision,
                    vec![Command::SetTextProperties {
                        id: NodeId(48),
                        properties: properties.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_ne!(document.canonical_hash(), inside_marker_hash);
        assert_eq!(
            document.auto_layout_text_size(document.node(NodeId(48)).unwrap()),
            (111.6, 40.0)
        );

        let hanging_hash = document.canonical_hash();
        properties.paragraph.hanging_list = false;
        properties.paragraph_style_runs = vec![ParagraphStyleRun {
            start: 4,
            indentation: None,
            list_type: Some(ParagraphListType::None),
            list_spacing: None,
            paragraph_spacing: None,
            paragraph_indent: None,
            line_height: None,
            line_height_unit: None,
            text_wrap_style: None,
        }];
        document
            .submit(
                transaction(
                    document.revision,
                    vec![Command::SetTextProperties {
                        id: NodeId(48),
                        properties: properties.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_ne!(document.canonical_hash(), hanging_hash);
        assert_eq!(
            document.auto_layout_text_size(document.node(NodeId(48)).unwrap()),
            (111.6, 40.0)
        );

        for invalid_run in [
            ParagraphStyleRun {
                start: 2,
                indentation: Some(2),
                list_type: None,
                list_spacing: None,
                paragraph_spacing: None,
                paragraph_indent: None,
                line_height: None,
                line_height_unit: None,
                text_wrap_style: None,
            },
            ParagraphStyleRun {
                start: 4,
                indentation: Some(101),
                list_type: None,
                list_spacing: None,
                paragraph_spacing: None,
                paragraph_indent: None,
                line_height: None,
                line_height_unit: None,
                text_wrap_style: None,
            },
            ParagraphStyleRun {
                start: 4,
                indentation: None,
                list_type: None,
                list_spacing: None,
                paragraph_spacing: None,
                paragraph_indent: None,
                line_height: None,
                line_height_unit: None,
                text_wrap_style: None,
            },
            ParagraphStyleRun {
                start: 4,
                indentation: None,
                list_type: Some(ParagraphListType::Ordered),
                list_spacing: None,
                paragraph_spacing: None,
                paragraph_indent: None,
                line_height: None,
                line_height_unit: None,
                text_wrap_style: None,
            },
        ] {
            let mut invalid = properties.clone();
            invalid.paragraph_style_runs = vec![invalid_run];
            assert_eq!(
                document.submit(
                    transaction(
                        document.revision,
                        vec![Command::SetTextProperties {
                            id: NodeId(48),
                            properties: invalid,
                        }],
                    ),
                    Origin::LocalUser,
                ),
                Err(CommandError::InvalidTextProperties)
            );
        }
        assert!(document.undo().is_some());
        assert!(
            document
                .text_properties_for_node(NodeId(48))
                .unwrap()
                .paragraph
                .hanging_list
        );
        assert!(document.undo().is_some());
        assert!(
            !document
                .text_properties_for_node(NodeId(48))
                .unwrap()
                .paragraph
                .hanging_list
        );
        assert!(document.undo().is_some());
        assert!(document.text_properties_for_node(NodeId(48)).is_none());
    }

    #[test]
    fn empty_text_base_style_is_canonical_validated_and_undoable() {
        let mut document = Document::empty();
        let mut shape = node(42);
        shape.kind = NodeKind::ShapeWithText;
        shape.text.clear();
        document
            .submit(
                transaction(0, vec![Command::Create(shape)]),
                Origin::LocalUser,
            )
            .unwrap();
        let style = TextStyleRun {
            start: 0,
            end: 0,
            font: None,
            font_size: 22.0,
            font_weight: 600,
            italic: true,
            letter_spacing: 1.25,
            color: None,
            fill_stack: Some(PaintStack { layers: vec![] }),
            text_case: None,
            hyperlink: None,
            text_decoration: None,
            text_decoration_style: None,
            text_decoration_offset: None,
            text_decoration_thickness: None,
            text_decoration_skip_ink: None,
            leading_trim: None,
            open_type_features: Vec::new(),
            text_style_id: None,
            paint_style_id: None,
            variable_bindings: Default::default(),
            text_decoration_color: None,
        };
        let properties = TextProperties {
            base_style: Some(style.clone()),
            ..TextProperties::default()
        };
        let baseline = document.canonical_hash_hex();
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetTextProperties {
                        id: NodeId(42),
                        properties: properties.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document.text_properties_for_node(NodeId(42)),
            Some(&properties)
        );
        assert_ne!(document.canonical_hash_hex(), baseline);
        assert_eq!(document.undo(), Some(3));
        assert_eq!(document.text_properties_for_node(NodeId(42)), None);
        assert_eq!(document.redo(), Some(4));
        assert_eq!(
            document.text_properties_for_node(NodeId(42)),
            Some(&properties)
        );

        let mut invalid = properties;
        invalid.base_style.as_mut().unwrap().end = 1;
        assert_eq!(
            document.submit(
                transaction(
                    4,
                    vec![Command::SetTextProperties {
                        id: NodeId(42),
                        properties: invalid,
                    }],
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidTextProperties)
        );
    }

    #[test]
    fn rich_text_properties_are_canonical_validated_and_undoable() {
        let font = AssetReference {
            asset_id: AssetId(12),
            content_hash: [12; 32],
            media_type: "font/woff2".into(),
            byte_length: 256,
            dimensions: None,
            font_faces: Vec::new(),
        };
        let mut text_node = node(13);
        text_node.kind = NodeKind::Text;
        text_node.text = "A😀B".into();
        let mut document = Document::empty();
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::RegisterAsset {
                            asset: font.clone(),
                        },
                        Command::Create(text_node),
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let font_reference = FontReference {
            asset_id: font.asset_id,
            face_index: 0,
            variation_axes: BTreeMap::from([("wght".into(), 650.0)]),
        };
        let properties = TextProperties {
            runs: vec![
                TextStyleRun {
                    start: 0,
                    end: 1,
                    font: Some(font_reference.clone()),
                    font_size: 18.0,
                    font_weight: 650,
                    italic: false,
                    letter_spacing: 0.0,
                    color: None,
                    fill_stack: None,
                    text_case: None,
                    hyperlink: None,
                    text_decoration: None,
                    text_decoration_style: None,
                    text_decoration_offset: None,
                    text_decoration_thickness: None,
                    text_decoration_skip_ink: None,
                    leading_trim: None,
                    open_type_features: Vec::new(),
                    text_style_id: None,
                    paint_style_id: None,
                    variable_bindings: Default::default(),
                    text_decoration_color: None,
                },
                TextStyleRun {
                    start: 1,
                    end: 5,
                    font: Some(font_reference.clone()),
                    font_size: 18.0,
                    font_weight: 650,
                    italic: false,
                    letter_spacing: 0.0,
                    color: None,
                    fill_stack: None,
                    text_case: None,
                    hyperlink: None,
                    text_decoration: None,
                    text_decoration_style: None,
                    text_decoration_offset: None,
                    text_decoration_thickness: None,
                    text_decoration_skip_ink: None,
                    leading_trim: None,
                    open_type_features: Vec::new(),
                    text_style_id: None,
                    paint_style_id: None,
                    variable_bindings: Default::default(),
                    text_decoration_color: None,
                },
                TextStyleRun {
                    start: 5,
                    end: 6,
                    font: Some(font_reference.clone()),
                    font_size: 18.0,
                    font_weight: 650,
                    italic: false,
                    letter_spacing: 0.0,
                    color: None,
                    fill_stack: None,
                    text_case: None,
                    hyperlink: None,
                    text_decoration: None,
                    text_decoration_style: None,
                    text_decoration_offset: None,
                    text_decoration_thickness: None,
                    text_decoration_skip_ink: None,
                    leading_trim: None,
                    open_type_features: Vec::new(),
                    text_style_id: None,
                    paint_style_id: None,
                    variable_bindings: Default::default(),
                    text_decoration_color: None,
                },
            ],
            paragraph: ParagraphStyle {
                alignment: TextAlign::Center,
                line_height: Some(24.0),
                line_height_unit: None,
                paragraph_spacing: 8.0,
                paragraph_indent: None,
                text_wrap_style: None,
                list_type: None,
                list_spacing: None,
                hanging_list: false,
                hanging_punctuation: false,
            },
            paragraph_style_runs: Vec::new(),
            auto_size: TextAutoSize::Height,
            fallback_fonts: vec![font_reference.clone()],
            text_truncation: TextTruncation::Disabled,
            max_lines: None,
            base_style: None,
        };
        let baseline = document.canonical_hash_hex();
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetTextProperties {
                        id: NodeId(13),
                        properties: properties.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document.text_properties_for_node(NodeId(13)),
            Some(&properties)
        );
        assert_ne!(document.canonical_hash_hex(), baseline);
        document.undo().unwrap();
        assert_eq!(document.text_properties_for_node(NodeId(13)), None);
        document.redo().unwrap();
        assert_eq!(
            document.text_properties_for_node(NodeId(13)),
            Some(&properties)
        );

        let mut invalid = properties.clone();
        invalid.runs[1].start = 2;
        assert_eq!(
            document.submit(
                transaction(
                    4,
                    vec![Command::SetTextProperties {
                        id: NodeId(13),
                        properties: invalid,
                    }],
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidTextProperties)
        );
        assert_eq!(
            document.text_properties_for_node(NodeId(13)),
            Some(&properties)
        );

        document
            .submit(
                transaction(
                    4,
                    vec![Command::SetText {
                        id: NodeId(13),
                        text: "changed".into(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert!(
            document
                .text_properties_for_node(NodeId(13))
                .unwrap()
                .runs
                .is_empty()
        );
        document.undo().unwrap();
        assert_eq!(
            document.text_properties_for_node(NodeId(13)),
            Some(&properties)
        );
    }

    #[test]
    fn rich_text_run_color_is_hashed_undoable_and_validated() {
        let mut text = node(1);
        text.kind = NodeKind::Text;
        text.text = "AB".into();
        let mut document = Document::empty();
        document
            .submit(
                transaction(0, vec![Command::Create(text)]),
                Origin::LocalUser,
            )
            .unwrap();
        let baseline = document.canonical_hash_hex();
        let properties = TextProperties {
            runs: vec![TextStyleRun {
                start: 0,
                end: 2,
                font: None,
                font_size: 16.0,
                font_weight: 500,
                italic: false,
                letter_spacing: 0.0,
                color: Some(Color::from_srgb_u8([220, 38, 38], 255)),
                fill_stack: None,
                text_case: None,
                hyperlink: None,
                text_decoration: None,
                text_decoration_style: None,
                text_decoration_offset: None,
                text_decoration_thickness: None,
                text_decoration_skip_ink: None,
                leading_trim: None,
                open_type_features: Vec::new(),
                text_style_id: None,
                paint_style_id: None,
                variable_bindings: Default::default(),
                text_decoration_color: None,
            }],
            ..TextProperties::default()
        };
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetTextProperties {
                        id: NodeId(1),
                        properties: properties.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let colored_hash = document.canonical_hash_hex();
        assert_ne!(colored_hash, baseline);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), colored_hash);
        let mut invalid = properties;
        invalid.runs[0].color = Some(Color {
            space: ColorSpace::Srgb,
            components: [f32::NAN, 0.0, 0.0],
            alpha: 1.0,
        });
        assert_eq!(
            document.submit(
                transaction(
                    document.revision,
                    vec![Command::SetTextProperties {
                        id: NodeId(1),
                        properties: invalid
                    }]
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidTextProperties),
        );
    }

    #[test]
    fn text_case_is_canonical_hashed_undoable_and_normalizes_original_by_rejection() {
        let mut text = node(90);
        text.kind = NodeKind::Text;
        text.text = "straße".into();
        let mut document = Document::empty();
        document
            .submit(
                transaction(0, vec![Command::Create(text)]),
                Origin::LocalUser,
            )
            .unwrap();
        let baseline = document.canonical_hash_hex();
        let properties = TextProperties {
            runs: vec![TextStyleRun {
                start: 0,
                end: 7,
                font: None,
                font_size: 16.0,
                font_weight: 400,
                italic: false,
                letter_spacing: 0.0,
                color: None,
                fill_stack: None,
                text_case: Some(TextCase::Upper),
                hyperlink: None,
                text_decoration: None,
                text_decoration_style: None,
                text_decoration_offset: None,
                text_decoration_thickness: None,
                text_decoration_skip_ink: None,
                leading_trim: None,
                open_type_features: Vec::new(),
                text_style_id: None,
                paint_style_id: None,
                variable_bindings: Default::default(),
                text_decoration_color: None,
            }],
            ..TextProperties::default()
        };
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetTextProperties {
                        id: NodeId(90),
                        properties: properties.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let case_hash = document.canonical_hash_hex();
        assert_ne!(case_hash, baseline);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), case_hash);

        let mut duplicate_original = properties;
        duplicate_original.runs[0].text_case = Some(TextCase::Original);
        assert_eq!(
            document.submit(
                transaction(
                    document.revision,
                    vec![Command::SetTextProperties {
                        id: NodeId(90),
                        properties: duplicate_original,
                    }],
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidTextProperties)
        );
    }

    #[test]
    fn open_type_features_are_bounded_sorted_hashed_and_undoable() {
        let mut text = node(190);
        text.kind = NodeKind::Text;
        text.text = "office".into();
        let mut document = Document::empty();
        document
            .submit(
                transaction(0, vec![Command::Create(text)]),
                Origin::LocalUser,
            )
            .unwrap();
        let baseline = document.canonical_hash_hex();
        let style = TextStyleRun {
            start: 0,
            end: 6,
            font: None,
            font_size: 16.0,
            font_weight: 400,
            italic: false,
            letter_spacing: 0.0,
            color: None,
            fill_stack: None,
            text_case: None,
            hyperlink: None,
            text_decoration: None,
            text_decoration_style: None,
            text_decoration_offset: None,
            text_decoration_thickness: None,
            text_decoration_color: None,
            text_decoration_skip_ink: None,
            leading_trim: None,
            open_type_features: vec![
                OpenTypeFeature {
                    tag: "KERN".into(),
                    enabled: false,
                },
                OpenTypeFeature {
                    tag: "LIGA".into(),
                    enabled: true,
                },
            ],
            text_style_id: None,
            paint_style_id: None,
            variable_bindings: Default::default(),
        };
        let properties = TextProperties {
            runs: vec![style],
            ..TextProperties::default()
        };
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetTextProperties {
                        id: NodeId(190),
                        properties: properties.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let feature_hash = document.canonical_hash_hex();
        assert_ne!(feature_hash, baseline);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), feature_hash);

        for features in [
            vec![OpenTypeFeature {
                tag: "liga".into(),
                enabled: true,
            }],
            vec![
                OpenTypeFeature {
                    tag: "LIGA".into(),
                    enabled: true,
                },
                OpenTypeFeature {
                    tag: "KERN".into(),
                    enabled: false,
                },
            ],
            (0..129)
                .map(|index| OpenTypeFeature {
                    tag: format!("A{index:03}"),
                    enabled: true,
                })
                .collect(),
        ] {
            let mut invalid = properties.clone();
            invalid.runs[0].open_type_features = features;
            assert_eq!(
                document.submit(
                    transaction(
                        document.revision,
                        vec![Command::SetTextProperties {
                            id: NodeId(190),
                            properties: invalid
                        }]
                    ),
                    Origin::LocalUser
                ),
                Err(CommandError::InvalidTextProperties)
            );
            assert_eq!(document.canonical_hash_hex(), feature_hash);
        }

        let mut linked = properties.clone();
        linked.runs[0].open_type_features.clear();
        linked.runs[0].text_style_id = Some("S:heading".into());
        document
            .submit(
                transaction(
                    document.revision,
                    vec![Command::SetTextProperties {
                        id: NodeId(190),
                        properties: linked.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let linked_hash = document.canonical_hash_hex();
        assert_ne!(linked_hash, feature_hash);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), feature_hash);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), linked_hash);
        for id in [
            String::new(),
            "x".repeat(MAX_STYLE_ID_BYTES + 1),
            "bad\0id".into(),
        ] {
            let mut invalid = linked.clone();
            invalid.runs[0].text_style_id = Some(id);
            assert_eq!(
                document.submit(
                    transaction(
                        document.revision,
                        vec![Command::SetTextProperties {
                            id: NodeId(190),
                            properties: invalid
                        }]
                    ),
                    Origin::LocalUser
                ),
                Err(CommandError::InvalidTextProperties)
            );
            assert_eq!(document.canonical_hash_hex(), linked_hash);
        }

        let mut paint_linked = linked.clone();
        paint_linked.runs[0].text_style_id = None;
        paint_linked.runs[0].paint_style_id = Some("S:accent".into());
        document
            .submit(
                transaction(
                    document.revision,
                    vec![Command::SetTextProperties {
                        id: NodeId(190),
                        properties: paint_linked.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let paint_linked_hash = document.canonical_hash_hex();
        assert_ne!(paint_linked_hash, linked_hash);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), linked_hash);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), paint_linked_hash);
        let mut invalid = paint_linked;
        invalid.runs[0].paint_style_id = Some("bad\0id".into());
        assert_eq!(
            document.submit(
                transaction(
                    document.revision,
                    vec![Command::SetTextProperties {
                        id: NodeId(190),
                        properties: invalid,
                    }],
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidTextProperties)
        );
        assert_eq!(document.canonical_hash_hex(), paint_linked_hash);
    }

    #[test]
    fn text_hyperlink_is_canonical_hashed_undoable_and_validated_atomically() {
        let mut text = node(92);
        text.kind = NodeKind::Text;
        text.text = "AB".into();
        let mut document = Document::empty();
        document
            .submit(
                transaction(0, vec![Command::Create(text)]),
                Origin::LocalUser,
            )
            .unwrap();
        let baseline = document.canonical_hash_hex();
        let properties = TextProperties {
            runs: vec![TextStyleRun {
                start: 0,
                end: 2,
                font: None,
                font_size: 16.0,
                font_weight: 400,
                italic: false,
                letter_spacing: 0.0,
                color: None,
                fill_stack: None,
                text_case: None,
                hyperlink: Some(HyperlinkTarget {
                    kind: HyperlinkType::Url,
                    value: "https://example.com".into(),
                }),
                text_decoration: None,
                text_decoration_style: None,
                text_decoration_offset: None,
                text_decoration_thickness: None,
                text_decoration_skip_ink: None,
                leading_trim: None,
                open_type_features: Vec::new(),
                text_style_id: None,
                paint_style_id: None,
                variable_bindings: Default::default(),
                text_decoration_color: None,
            }],
            ..TextProperties::default()
        };
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetTextProperties {
                        id: NodeId(92),
                        properties: properties.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let url_hash = document.canonical_hash_hex();
        assert_ne!(url_hash, baseline);
        assert_eq!(document.undo(), Some(3));
        assert_eq!(document.canonical_hash_hex(), baseline);
        assert_eq!(document.redo(), Some(4));
        assert_eq!(document.canonical_hash_hex(), url_hash);

        let mut node_target = properties.clone();
        node_target.runs[0].hyperlink = Some(HyperlinkTarget {
            kind: HyperlinkType::Node,
            value: "123:456".into(),
        });
        document
            .submit(
                transaction(
                    document.revision,
                    vec![Command::SetTextProperties {
                        id: NodeId(92),
                        properties: node_target,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_ne!(document.canonical_hash_hex(), url_hash);

        for invalid_value in [
            String::new(),
            "contains\0nul".into(),
            "x".repeat(MAX_TEXT_HYPERLINK_BYTES + 1),
        ] {
            let before_revision = document.revision;
            let before_hash = document.canonical_hash_hex();
            let mut invalid = properties.clone();
            invalid.runs[0].hyperlink.as_mut().unwrap().value = invalid_value;
            assert_eq!(
                document.submit(
                    transaction(
                        document.revision,
                        vec![Command::SetTextProperties {
                            id: NodeId(92),
                            properties: invalid,
                        }],
                    ),
                    Origin::LocalUser,
                ),
                Err(CommandError::InvalidTextProperties)
            );
            assert_eq!(document.revision, before_revision);
            assert_eq!(document.canonical_hash_hex(), before_hash);
        }
    }

    #[test]
    fn text_decoration_is_canonical_hashed_and_undoable() {
        let mut text = node(93);
        text.kind = NodeKind::Text;
        text.text = "AB".into();
        let mut document = Document::empty();
        document
            .submit(
                transaction(0, vec![Command::Create(text)]),
                Origin::LocalUser,
            )
            .unwrap();
        let baseline = document.canonical_hash_hex();
        let properties = TextProperties {
            runs: vec![TextStyleRun {
                start: 0,
                end: 2,
                font: None,
                font_size: 16.0,
                font_weight: 400,
                italic: false,
                letter_spacing: 0.0,
                color: None,
                fill_stack: None,
                text_case: None,
                hyperlink: None,
                text_decoration: Some(TextDecoration::Underline),
                text_decoration_style: None,
                text_decoration_offset: None,
                text_decoration_thickness: None,
                text_decoration_skip_ink: None,
                leading_trim: None,
                open_type_features: Vec::new(),
                text_style_id: None,
                paint_style_id: None,
                variable_bindings: Default::default(),
                text_decoration_color: None,
            }],
            ..TextProperties::default()
        };
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetTextProperties {
                        id: NodeId(93),
                        properties: properties.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let underline_hash = document.canonical_hash_hex();
        assert_ne!(underline_hash, baseline);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), underline_hash);

        let mut strikethrough = properties;
        strikethrough.runs[0].text_decoration = Some(TextDecoration::Strikethrough);
        document
            .submit(
                transaction(
                    document.revision,
                    vec![Command::SetTextProperties {
                        id: NodeId(93),
                        properties: strikethrough,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_ne!(document.canonical_hash_hex(), underline_hash);

        let solid_hash = document.canonical_hash_hex();
        let mut wavy = document
            .text_properties_for_node(NodeId(93))
            .cloned()
            .unwrap();
        wavy.runs[0].text_decoration_style = Some(TextDecorationStyle::Wavy);
        document
            .submit(
                transaction(
                    document.revision,
                    vec![Command::SetTextProperties {
                        id: NodeId(93),
                        properties: wavy,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_ne!(document.canonical_hash_hex(), solid_hash);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), solid_hash);

        let mut offset = document
            .text_properties_for_node(NodeId(93))
            .cloned()
            .unwrap();
        offset.runs[0].text_decoration = Some(TextDecoration::Underline);
        offset.runs[0].text_decoration_offset = Some(TextDecorationOffset::Pixels(3.5));
        document
            .submit(
                transaction(
                    document.revision,
                    vec![Command::SetTextProperties {
                        id: NodeId(93),
                        properties: offset.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let pixel_offset_hash = document.canonical_hash_hex();
        assert_ne!(pixel_offset_hash, solid_hash);

        offset.runs[0].text_decoration_offset = Some(TextDecorationOffset::Percent(20.0));
        document
            .submit(
                transaction(
                    document.revision,
                    vec![Command::SetTextProperties {
                        id: NodeId(93),
                        properties: offset.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_ne!(document.canonical_hash_hex(), pixel_offset_hash);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), pixel_offset_hash);

        let mut thickness = document
            .text_properties_for_node(NodeId(93))
            .cloned()
            .unwrap();
        thickness.runs[0].text_decoration_thickness = Some(TextDecorationThickness::Pixels(2.5));
        document
            .submit(
                transaction(
                    document.revision,
                    vec![Command::SetTextProperties {
                        id: NodeId(93),
                        properties: thickness.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let pixel_thickness_hash = document.canonical_hash_hex();
        assert_ne!(pixel_thickness_hash, pixel_offset_hash);

        thickness.runs[0].text_decoration_thickness = Some(TextDecorationThickness::Percent(12.5));
        document
            .submit(
                transaction(
                    document.revision,
                    vec![Command::SetTextProperties {
                        id: NodeId(93),
                        properties: thickness.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_ne!(document.canonical_hash_hex(), pixel_thickness_hash);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), pixel_thickness_hash);

        thickness.runs[0].text_decoration_thickness = Some(TextDecorationThickness::Pixels(-1.0));
        let before_revision = document.revision;
        let before_hash = document.canonical_hash_hex();
        assert_eq!(
            document.submit(
                transaction(
                    document.revision,
                    vec![Command::SetTextProperties {
                        id: NodeId(93),
                        properties: thickness,
                    }],
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidTextProperties)
        );
        assert_eq!(document.revision, before_revision);
        assert_eq!(document.canonical_hash_hex(), before_hash);

        let mut decoration_color = document
            .text_properties_for_node(NodeId(93))
            .cloned()
            .unwrap();
        decoration_color.runs[0].text_decoration = Some(TextDecoration::Underline);
        decoration_color.runs[0].text_decoration_color = Some(TextDecorationColor {
            color: Color {
                space: ColorSpace::Srgb,
                components: [1.0, 0.25, 0.5],
                alpha: 1.0,
            },
            visible: true,
            opacity: 0.75,
            blend_mode: BlendMode::Multiply,
        });
        document
            .submit(
                transaction(
                    document.revision,
                    vec![Command::SetTextProperties {
                        id: NodeId(93),
                        properties: decoration_color.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let decoration_color_hash = document.canonical_hash_hex();
        assert_ne!(decoration_color_hash, before_hash);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), before_hash);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), decoration_color_hash);

        for invalid in [
            TextDecorationColor {
                opacity: f32::NAN,
                ..decoration_color.runs[0].text_decoration_color.unwrap()
            },
            TextDecorationColor {
                color: Color {
                    alpha: 0.5,
                    ..decoration_color.runs[0]
                        .text_decoration_color
                        .unwrap()
                        .color
                },
                ..decoration_color.runs[0].text_decoration_color.unwrap()
            },
            TextDecorationColor {
                blend_mode: BlendMode::PassThrough,
                ..decoration_color.runs[0].text_decoration_color.unwrap()
            },
        ] {
            let mut properties = decoration_color.clone();
            properties.runs[0].text_decoration_color = Some(invalid);
            let before_revision = document.revision;
            let before_hash = document.canonical_hash_hex();
            assert_eq!(
                document.submit(
                    transaction(
                        document.revision,
                        vec![Command::SetTextProperties {
                            id: NodeId(93),
                            properties,
                        }],
                    ),
                    Origin::LocalUser,
                ),
                Err(CommandError::InvalidTextProperties)
            );
            assert_eq!(document.revision, before_revision);
            assert_eq!(document.canonical_hash_hex(), before_hash);
        }

        let mut skip_ink = document
            .text_properties_for_node(NodeId(93))
            .cloned()
            .unwrap();
        skip_ink.runs[0].text_decoration_skip_ink = Some(true);
        let continuous_hash = document.canonical_hash_hex();
        document
            .submit(
                transaction(
                    document.revision,
                    vec![Command::SetTextProperties {
                        id: NodeId(93),
                        properties: skip_ink.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let skip_ink_hash = document.canonical_hash_hex();
        assert_ne!(skip_ink_hash, continuous_hash);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), continuous_hash);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), skip_ink_hash);

        let mut cap_height = document
            .text_properties_for_node(NodeId(93))
            .cloned()
            .unwrap();
        cap_height.runs[0].leading_trim = Some(LeadingTrim::CapHeight);
        document
            .submit(
                transaction(
                    document.revision,
                    vec![Command::SetTextProperties {
                        id: NodeId(93),
                        properties: cap_height,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let cap_height_hash = document.canonical_hash_hex();
        assert_ne!(cap_height_hash, skip_ink_hash);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), skip_ink_hash);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), cap_height_hash);

        skip_ink.runs[0].text_decoration_skip_ink = Some(false);
        let before_revision = document.revision;
        assert_eq!(
            document.submit(
                transaction(
                    document.revision,
                    vec![Command::SetTextProperties {
                        id: NodeId(93),
                        properties: skip_ink,
                    }],
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidTextProperties)
        );
        assert_eq!(document.revision, before_revision);

        let mut invalid_offset = document
            .text_properties_for_node(NodeId(93))
            .cloned()
            .unwrap();
        invalid_offset.runs[0].text_decoration_offset =
            Some(TextDecorationOffset::Pixels(f64::NAN));
        let before_revision = document.revision;
        let before_hash = document.canonical_hash_hex();
        assert_eq!(
            document.submit(
                transaction(
                    document.revision,
                    vec![Command::SetTextProperties {
                        id: NodeId(93),
                        properties: invalid_offset,
                    }],
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidTextProperties)
        );
        assert_eq!(document.revision, before_revision);
        assert_eq!(document.canonical_hash_hex(), before_hash);
    }

    #[test]
    fn rich_text_run_paint_stack_is_hashed_undoable_and_exclusive_with_legacy_color() {
        let mut text = node(2);
        text.kind = NodeKind::Text;
        text.text = "AB".into();
        let mut document = Document::empty();
        document
            .submit(
                transaction(0, vec![Command::Create(text)]),
                Origin::LocalUser,
            )
            .unwrap();
        let baseline = document.canonical_hash_hex();
        let stack = PaintStack {
            layers: vec![crate::color::PaintLayer {
                paint: PaintLayerKind::Solid(Color::from_srgb_u8([59, 130, 246], 255)),
                visible: true,
                opacity: 0.75,
                blend_mode: BlendMode::Multiply,
            }],
        };
        let properties = TextProperties {
            runs: vec![TextStyleRun {
                start: 0,
                end: 2,
                font: None,
                font_size: 16.0,
                font_weight: 500,
                italic: false,
                letter_spacing: 0.0,
                color: None,
                fill_stack: Some(stack.clone()),
                text_case: None,
                hyperlink: None,
                text_decoration: None,
                text_decoration_style: None,
                text_decoration_offset: None,
                text_decoration_thickness: None,
                text_decoration_skip_ink: None,
                leading_trim: None,
                open_type_features: Vec::new(),
                text_style_id: None,
                paint_style_id: None,
                variable_bindings: Default::default(),
                text_decoration_color: None,
            }],
            ..TextProperties::default()
        };
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetTextProperties {
                        id: NodeId(2),
                        properties: properties.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let stacked_hash = document.canonical_hash_hex();
        assert_ne!(stacked_hash, baseline);
        assert_eq!(
            document.text_properties_for_node(NodeId(2)).unwrap().runs[0].fill_stack,
            Some(stack)
        );
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), stacked_hash);

        let mut invalid = properties;
        invalid.runs[0].color = Some(Color::from_srgb_u8([255, 0, 0], 255));
        assert_eq!(
            document.submit(
                transaction(
                    document.revision,
                    vec![Command::SetTextProperties {
                        id: NodeId(2),
                        properties: invalid,
                    }],
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidTextProperties),
        );
    }

    #[test]
    fn effects_are_hashed_undoable_allow_groups_and_reject_boolean_operations() {
        let mut document = Document::empty();
        document
            .submit(
                transaction(0, vec![Command::Create(node(1))]),
                Origin::LocalUser,
            )
            .unwrap();
        let baseline = document.canonical_hash_hex();
        let mut appearance = appearance_for_node(document.node(NodeId(1)).unwrap());
        appearance.drop_shadow = Some(DropShadow {
            offset_x: 6.0,
            offset_y: 8.0,
            blur_radius: 12.0,
            spread: 2.0,
            color: Color::from_srgb_u8([15, 23, 42], 96),
            visible: true,
        });
        // New clients persist the ordered stack and retain the first entry in
        // the legacy field so R3 readers continue to render the same shadow.
        appearance.effect_stack = vec![Effect::DropShadow(appearance.drop_shadow.unwrap())];
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetAppearance {
                        id: NodeId(1),
                        appearance: appearance.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let shadowed = document.canonical_hash_hex();
        assert_ne!(shadowed, baseline);
        assert_eq!(
            document.node(NodeId(1)).unwrap().drop_shadow,
            appearance.drop_shadow
        );
        assert_eq!(
            document.node(NodeId(1)).unwrap().effect_stack,
            appearance.effect_stack
        );
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), shadowed);

        let mut invalid = appearance.clone();
        invalid.drop_shadow.as_mut().unwrap().blur_radius = f64::NAN;
        assert_eq!(
            document.submit(
                transaction(
                    document.revision,
                    vec![Command::SetAppearance {
                        id: NodeId(1),
                        appearance: invalid
                    }]
                ),
                Origin::LocalUser
            ),
            Err(CommandError::InvalidAppearance)
        );

        let mut conflicting_legacy = appearance.clone();
        conflicting_legacy.drop_shadow = None;
        assert_eq!(
            document.submit(
                transaction(
                    document.revision,
                    vec![Command::SetAppearance {
                        id: NodeId(1),
                        appearance: conflicting_legacy
                    }]
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidAppearance),
        );

        let mut multiple_effects = appearance.clone();
        multiple_effects
            .effect_stack
            .push(Effect::DropShadow(DropShadow {
                offset_x: -2.0,
                offset_y: 3.0,
                blur_radius: 4.0,
                spread: 0.0,
                color: Color::from_srgb_u8([255, 255, 255], 64),
                visible: true,
            }));
        document
            .submit(
                transaction(
                    document.revision,
                    vec![Command::SetAppearance {
                        id: NodeId(1),
                        appearance: multiple_effects.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document.node(NodeId(1)).unwrap().effect_stack,
            multiple_effects.effect_stack
        );

        let mut layer_blurred = multiple_effects.clone();
        layer_blurred
            .effect_stack
            .push(Effect::LayerBlur(LayerBlur {
                radius: 24.0,
                visible: true,
            }));
        document
            .submit(
                transaction(
                    document.revision,
                    vec![Command::SetAppearance {
                        id: NodeId(1),
                        appearance: layer_blurred.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let blurred_hash = document.canonical_hash_hex();
        assert_ne!(blurred_hash, shadowed);
        document.undo().unwrap();
        assert_eq!(
            document.node(NodeId(1)).unwrap().effect_stack,
            multiple_effects.effect_stack
        );
        document.redo().unwrap();
        assert_eq!(
            document.node(NodeId(1)).unwrap().effect_stack,
            layer_blurred.effect_stack
        );

        let mut inner_shadowed = layer_blurred.clone();
        inner_shadowed
            .effect_stack
            .push(Effect::InnerShadow(InnerShadow {
                offset_x: -3.0,
                offset_y: 5.0,
                blur_radius: 10.0,
                spread: 1.0,
                color: Color::from_srgb_u8([2, 6, 23], 80),
                visible: true,
            }));
        document
            .submit(
                transaction(
                    document.revision,
                    vec![Command::SetAppearance {
                        id: NodeId(1),
                        appearance: inner_shadowed.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document.node(NodeId(1)).unwrap().effect_stack,
            inner_shadowed.effect_stack
        );
        document.undo().unwrap();
        assert_eq!(
            document.node(NodeId(1)).unwrap().effect_stack,
            layer_blurred.effect_stack
        );
        document.redo().unwrap();
        assert_eq!(
            document.node(NodeId(1)).unwrap().effect_stack,
            inner_shadowed.effect_stack
        );

        let mut invalid_layer_blur = layer_blurred.clone();
        invalid_layer_blur
            .effect_stack
            .push(Effect::LayerBlur(LayerBlur {
                radius: 257.0,
                visible: true,
            }));
        assert_eq!(
            document.submit(
                transaction(
                    document.revision,
                    vec![Command::SetAppearance {
                        id: NodeId(1),
                        appearance: invalid_layer_blur
                    }]
                ),
                Origin::LocalUser
            ),
            Err(CommandError::InvalidAppearance),
        );

        let mut too_many_effects = multiple_effects;
        while too_many_effects.effect_stack.len() <= MAX_EFFECTS_PER_NODE {
            too_many_effects
                .effect_stack
                .push(Effect::DropShadow(appearance.drop_shadow.unwrap()));
        }
        assert_eq!(
            document.submit(
                transaction(
                    document.revision,
                    vec![Command::SetAppearance {
                        id: NodeId(1),
                        appearance: too_many_effects
                    }]
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidAppearance),
        );

        let mut group = node(2);
        group.kind = NodeKind::Group;
        group.name = "Group".into();
        let mut child = node(3);
        child.kind = NodeKind::Rectangle;
        child.parent_id = Some(NodeId(2));
        document
            .submit(
                transaction(
                    document.revision,
                    vec![Command::Create(group), Command::Create(child)],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let mut group_appearance = appearance_for_node(document.node(NodeId(2)).unwrap());
        group_appearance.effect_stack = vec![Effect::LayerBlur(LayerBlur {
            radius: 4.0,
            visible: true,
        })];
        let group_baseline = document.canonical_hash_hex();
        document
            .submit(
                transaction(
                    document.revision,
                    vec![Command::SetAppearance {
                        id: NodeId(2),
                        appearance: group_appearance.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let group_effect_hash = document.canonical_hash_hex();
        assert_ne!(group_effect_hash, group_baseline);
        assert_eq!(
            document.node(NodeId(2)).unwrap().effect_stack,
            group_appearance.effect_stack
        );
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), group_baseline);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), group_effect_hash);

        let mut boolean = node(4);
        boolean.kind = NodeKind::BooleanOperation;
        boolean.boolean_operation = Some(BooleanOperation::Union);
        let mut first_operand = node(5);
        first_operand.parent_id = Some(NodeId(4));
        let mut second_operand = node(6);
        second_operand.parent_id = Some(NodeId(4));
        document
            .submit(
                transaction(
                    document.revision,
                    vec![
                        Command::Create(boolean),
                        Command::Create(first_operand),
                        Command::Create(second_operand),
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let mut boolean_appearance = appearance_for_node(document.node(NodeId(4)).unwrap());
        boolean_appearance.effect_stack = vec![Effect::LayerBlur(LayerBlur {
            radius: 4.0,
            visible: true,
        })];
        assert_eq!(
            document.submit(
                transaction(
                    document.revision,
                    vec![Command::SetAppearance {
                        id: NodeId(4),
                        appearance: boolean_appearance
                    }]
                ),
                Origin::LocalUser
            ),
            Err(CommandError::InvalidAppearance)
        );

        let mut created_with_effect = node(7);
        created_with_effect.kind = NodeKind::BooleanOperation;
        created_with_effect.boolean_operation = Some(BooleanOperation::Union);
        created_with_effect.effect_stack = vec![Effect::LayerBlur(LayerBlur {
            radius: 4.0,
            visible: true,
        })];
        let mut created_operand_a = node(8);
        created_operand_a.parent_id = Some(NodeId(7));
        let mut created_operand_b = node(9);
        created_operand_b.parent_id = Some(NodeId(7));
        assert_eq!(
            document.submit(
                transaction(
                    document.revision,
                    vec![
                        Command::Create(created_with_effect),
                        Command::Create(created_operand_a),
                        Command::Create(created_operand_b),
                    ],
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidAppearance),
        );
    }

    #[test]
    fn undo_and_redo_replay_semantic_changes_without_reusing_ids() {
        let mut document = Document::empty();
        document
            .submit(
                transaction(0, vec![Command::Create(node(1))]),
                Origin::SystemRepair,
            )
            .unwrap();
        document
            .submit(
                transaction(
                    1,
                    vec![
                        Command::UpdateGeometry {
                            id: NodeId(1),
                            x: 48.0,
                            y: 16.0,
                            width: 300.0,
                            height: 160.0,
                            rotation: 15.0,
                        },
                        Command::Rename {
                            id: NodeId(1),
                            name: "Moved card".into(),
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(document.undo(), Some(3));
        assert_eq!(document.node(NodeId(1)).unwrap().name, "Card");
        assert_eq!(document.node(NodeId(1)).unwrap().x, 0.0);
        assert_eq!(document.node(NodeId(1)).unwrap().rotation, 0.0);
        assert_eq!(document.redo(), Some(4));
        assert_eq!(document.node(NodeId(1)).unwrap().name, "Moved card");
        assert_eq!(document.node(NodeId(1)).unwrap().x, 48.0);
        assert_eq!(document.node(NodeId(1)).unwrap().rotation, 15.0);

        document
            .submit(
                transaction(4, vec![Command::Delete { id: NodeId(1) }]),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(document.undo(), Some(6));
        assert!(document.node(NodeId(1)).is_some());
        assert_eq!(document.redo(), Some(7));
        assert!(document.node(NodeId(1)).is_none());
        assert_eq!(
            document.submit(
                transaction(7, vec![Command::Create(node(1))]),
                Origin::LocalUser
            ),
            Err(CommandError::RetiredNodeId { id: NodeId(1) })
        );
    }

    #[test]
    fn retrying_an_accepted_transaction_is_idempotent() {
        let mut document = Document::empty();
        let transaction = Transaction {
            id: TransactionId(99),
            base_revision: 0,
            commands: vec![Command::Create(node(1))],
        };

        let first = document
            .submit(transaction.clone(), Origin::LocalUser)
            .unwrap();
        let retried = document.submit(transaction, Origin::LocalUser).unwrap();

        assert_eq!(retried, first);
        assert_eq!(document.revision, 1);
        assert_eq!(document.nodes().count(), 1);
        assert_eq!(document.undo(), Some(2));
        assert!(document.undo().is_none());
        assert_eq!(
            document.submit(
                Transaction {
                    id: TransactionId(99),
                    base_revision: 2,
                    commands: vec![Command::Create(node(2))],
                },
                Origin::LocalUser,
            ),
            Err(CommandError::TransactionIdConflict {
                id: TransactionId(99)
            })
        );
    }

    #[test]
    fn operation_envelope_is_idempotent_and_canonicalizes_causal_parent_order() {
        let document_id = DocumentId(41);
        let transaction = Transaction {
            id: TransactionId(81),
            base_revision: 0,
            commands: vec![Command::Create(node(1))],
        };
        let first_envelope = OperationEnvelope::new(
            document_id,
            OperationId(91),
            ActorId(7),
            vec![OperationId(3), OperationId(2), OperationId(3)],
            transaction.clone(),
        );
        let retry_envelope = OperationEnvelope::new(
            document_id,
            OperationId(91),
            ActorId(7),
            vec![OperationId(2), OperationId(3)],
            transaction,
        );
        assert_eq!(first_envelope.fingerprint(), retry_envelope.fingerprint());

        let mut document = Document::with_id(document_id);
        let first = document
            .submit_operation(first_envelope, Origin::RemoteOperation)
            .unwrap();
        let retried = document
            .submit_operation(retry_envelope, Origin::RemoteOperation)
            .unwrap();
        assert_eq!(first, retried);
        assert_eq!(document.revision, 1);
        assert_eq!(document.memory_stats().operation_dedupe_items, 1);

        let conflict = OperationEnvelope::new(
            document_id,
            OperationId(91),
            ActorId(7),
            vec![],
            Transaction {
                id: TransactionId(82),
                base_revision: 1,
                commands: vec![Command::Create(node(2))],
            },
        );
        assert_eq!(
            document.submit_operation(conflict, Origin::RemoteOperation),
            Err(CommandError::OperationIdConflict {
                id: OperationId(91)
            })
        );
        assert_eq!(document.revision, 1);
    }

    #[test]
    fn operation_envelope_rejects_tampering_before_document_mutation() {
        let document_id = DocumentId(42);
        let base = OperationEnvelope::new(
            document_id,
            OperationId(92),
            ActorId(7),
            vec![],
            Transaction {
                id: TransactionId(83),
                base_revision: 0,
                commands: vec![Command::Create(node(1))],
            },
        );
        let mut document = Document::with_id(document_id);

        let mut tampered = base.clone();
        tampered.payload_hash = [0; 32];
        assert_eq!(
            document.submit_operation(tampered, Origin::RemoteOperation),
            Err(CommandError::OperationPayloadHashMismatch)
        );
        let mut wrong_schema = base.clone();
        wrong_schema.schema_version = 99;
        assert_eq!(
            document.submit_operation(wrong_schema, Origin::RemoteOperation),
            Err(CommandError::UnsupportedOperationSchema { found: 99 })
        );
        let mut wrong_document = base;
        wrong_document.document_id = DocumentId(99);
        assert_eq!(
            document.submit_operation(wrong_document, Origin::RemoteOperation),
            Err(CommandError::OperationDocumentMismatch {
                expected: document_id,
                actual: DocumentId(99),
            })
        );
        assert_eq!(document.revision, 0);
        assert_eq!(document.nodes().count(), 0);
    }

    #[test]
    fn operation_candidate_is_atomic_when_a_later_command_fails() {
        let document_id = DocumentId(44);
        let operation = OperationEnvelope::new(
            document_id,
            OperationId(93),
            ActorId(7),
            vec![],
            Transaction {
                id: TransactionId(84),
                base_revision: 0,
                commands: vec![Command::Create(node(1)), Command::Delete { id: NodeId(99) }],
            },
        );
        let mut document = Document::with_id(document_id);
        let before = document.clone();

        assert_eq!(
            document.submit_operation(operation, Origin::RemoteOperation),
            Err(CommandError::MissingNode { id: NodeId(99) })
        );
        assert_eq!(document, before);
    }

    #[test]
    fn operation_can_reference_an_already_accepted_identical_transaction() {
        let document_id = DocumentId(45);
        let transaction = Transaction {
            id: TransactionId(85),
            base_revision: 0,
            commands: vec![Command::Create(node(1))],
        };
        let mut document = Document::with_id(document_id);
        let accepted = document
            .submit(transaction.clone(), Origin::LocalUser)
            .unwrap();
        let operation = OperationEnvelope::new(
            document_id,
            OperationId(94),
            ActorId(7),
            vec![],
            transaction,
        );

        let applied = document
            .submit_operation(operation, Origin::RemoteOperation)
            .unwrap();
        assert_eq!(applied.accepted_revision, accepted.accepted_revision);
        assert_eq!(document.revision, 1);
        assert_eq!(document.memory_stats().operation_dedupe_items, 1);
        assert_eq!(document.undo(), Some(2));
        assert!(document.undo().is_none());
    }

    #[test]
    fn legal_operation_replay_converges_to_the_same_document_hash() {
        let document_id = DocumentId(43);
        let create = OperationEnvelope::new(
            document_id,
            OperationId(100),
            ActorId(8),
            vec![],
            Transaction {
                id: TransactionId(1000),
                base_revision: 0,
                commands: vec![Command::Create(node(1))],
            },
        );
        let rename = OperationEnvelope::new(
            document_id,
            OperationId(101),
            ActorId(8),
            vec![OperationId(100)],
            Transaction {
                id: TransactionId(1001),
                base_revision: 1,
                commands: vec![Command::Rename {
                    id: NodeId(1),
                    name: "Shared card".into(),
                }],
            },
        );
        let mut first = Document::with_id(document_id);
        let mut second = Document::with_id(document_id);
        for document in [&mut first, &mut second] {
            document
                .submit_operation(create.clone(), Origin::RemoteOperation)
                .unwrap();
            document
                .submit_operation(rename.clone(), Origin::RemoteOperation)
                .unwrap();
        }
        assert_eq!(first.revision, 2);
        assert_eq!(first.canonical_hash(), second.canonical_hash());
        assert!(
            !first.can_undo(),
            "remote operations do not enter local undo"
        );
    }

    #[test]
    fn canonical_hash_is_independent_of_legal_command_order() {
        let mut first = Document::empty();
        let mut second = Document::empty();
        first
            .submit(
                Transaction {
                    id: TransactionId(1),
                    base_revision: 0,
                    commands: vec![Command::Create(node(1)), Command::Create(node(2))],
                },
                Origin::Import,
            )
            .unwrap();
        second
            .submit(
                Transaction {
                    id: TransactionId(2),
                    base_revision: 0,
                    commands: vec![Command::Create(node(2)), Command::Create(node(1))],
                },
                Origin::Import,
            )
            .unwrap();

        assert_eq!(first.canonical_hash(), second.canonical_hash());
        second
            .submit(
                Transaction {
                    id: TransactionId(3),
                    base_revision: 1,
                    commands: vec![Command::Delete { id: NodeId(2) }],
                },
                Origin::Import,
            )
            .unwrap();
        assert_ne!(first.canonical_hash(), second.canonical_hash());
    }

    #[test]
    fn resource_limits_reject_an_oversized_transaction_before_mutation() {
        let mut document = Document::empty();
        let commands = vec![Command::Delete { id: NodeId(1) }; MAX_TRANSACTION_COMMANDS + 1];
        assert_eq!(
            document.submit(
                Transaction {
                    id: TransactionId(1),
                    base_revision: 0,
                    commands
                },
                Origin::LocalUser,
            ),
            Err(CommandError::ResourceLimit)
        );
        assert_eq!(document.revision, 0);
        assert_eq!(document.nodes().count(), 0);

        let mut huge = node(2);
        huge.name = "x".repeat(MAX_TRANSACTION_BYTES);
        assert_eq!(
            document.submit(
                Transaction {
                    id: TransactionId(2),
                    base_revision: 0,
                    commands: vec![Command::Create(huge)]
                },
                Origin::LocalUser,
            ),
            Err(CommandError::ResourceLimit)
        );
        assert_eq!(document.revision, 0);
    }

    #[test]
    fn one_hundred_thousand_node_fixture_is_admitted_and_next_node_is_rejected() {
        let mut document = Document::empty();
        for id in 1..=MAX_DOCUMENT_NODES as u128 {
            document.seed_node(node(id)).unwrap();
        }
        let before = document.memory_stats();
        assert_eq!(before.node_count, MAX_DOCUMENT_NODES);
        assert!(before.node_bytes <= MAX_DOCUMENT_BYTES);

        let result = document.submit(
            Transaction {
                id: TransactionId(50_000),
                base_revision: 0,
                commands: vec![Command::Create(node(MAX_DOCUMENT_NODES as u128 + 1))],
            },
            Origin::LocalUser,
        );
        assert_eq!(result, Err(CommandError::ResourceLimit));
        assert_eq!(document.node_count(), MAX_DOCUMENT_NODES);
        assert_eq!(document.memory_stats().node_bytes, before.node_bytes);
        assert_eq!(document.revision, 0);
    }

    #[test]
    fn document_byte_budget_rejects_text_growth_without_mutation() {
        let mut document = Document::empty();
        let mut text = node(1);
        text.kind = NodeKind::Text;
        text.text = "small".into();
        document.seed_node(text).unwrap();

        // Exercise the admission boundary without allocating a 256 MiB test fixture.
        document.node_bytes = MAX_DOCUMENT_BYTES;
        let result = document.submit(
            Transaction {
                id: TransactionId(50_001),
                base_revision: 0,
                commands: vec![Command::SetText {
                    id: NodeId(1),
                    text: "this growth must be rejected before mutation".into(),
                }],
            },
            Origin::LocalUser,
        );

        assert_eq!(result, Err(CommandError::ResourceLimit));
        assert_eq!(document.node(NodeId(1)).unwrap().text, "small");
        assert_eq!(document.revision, 0);
        assert_eq!(document.memory_stats().node_bytes, MAX_DOCUMENT_BYTES);
    }

    #[test]
    fn undo_and_redo_keep_node_byte_accounting_in_sync() {
        let mut document = Document::empty();
        let mut text = node(1);
        text.kind = NodeKind::Text;
        text.text = "before".into();
        document.seed_node(text).unwrap();
        let initial_bytes = document.memory_stats().node_bytes;

        document
            .submit(
                Transaction {
                    id: TransactionId(50_002),
                    base_revision: 0,
                    commands: vec![
                        Command::Rename {
                            id: NodeId(1),
                            name: "A longer name".into(),
                        },
                        Command::SetText {
                            id: NodeId(1),
                            text: "A longer canonical text value".into(),
                        },
                    ],
                },
                Origin::LocalUser,
            )
            .unwrap();
        let changed_bytes = document.memory_stats().node_bytes;
        assert!(changed_bytes > initial_bytes);

        document.undo().unwrap();
        assert_eq!(document.memory_stats().node_bytes, initial_bytes);
        document.redo().unwrap();
        assert_eq!(document.memory_stats().node_bytes, changed_bytes);
    }

    #[test]
    fn undo_history_has_a_bounded_count_and_byte_budget() {
        let mut document = Document::empty();
        for id in 1..=(MAX_HISTORY_ITEMS as u128 + 1) {
            document
                .submit(
                    Transaction {
                        id: TransactionId(10_000 + id),
                        base_revision: document.revision,
                        commands: vec![Command::Create(node(id))],
                    },
                    Origin::LocalUser,
                )
                .unwrap();
        }

        let stats = document.memory_stats();
        assert_eq!(stats.undo_items, MAX_HISTORY_ITEMS);
        assert!(stats.undo_bytes <= MAX_HISTORY_BYTES);
        assert!(stats.dedupe_bytes <= MAX_DEDUPE_BYTES);
        for _ in 0..MAX_HISTORY_ITEMS {
            assert!(document.undo().is_some());
        }
        assert!(document.undo().is_none());
    }

    #[test]
    fn parametric_shapes_are_validated_hashed_and_undoable() {
        let mut document = Document::empty();
        let mut polygon = node(1);
        polygon.kind = NodeKind::Polygon;
        polygon.name = "Polygon".into();
        polygon.parametric_shape = Some(ParametricShape::Polygon { point_count: 5 });
        document
            .submit(
                transaction(0, vec![Command::Create(polygon)]),
                Origin::LocalUser,
            )
            .unwrap();
        let five_points = document.canonical_hash_hex();

        let mut appearance = appearance_for_node(document.node(NodeId(1)).unwrap());
        appearance.parametric_shape = Some(ParametricShape::Polygon { point_count: 6 });
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetAppearance {
                        id: NodeId(1),
                        appearance,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let six_points = document.canonical_hash_hex();
        assert_ne!(five_points, six_points);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), five_points);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), six_points);

        let mut invalid = appearance_for_node(document.node(NodeId(1)).unwrap());
        invalid.parametric_shape = Some(ParametricShape::Star {
            point_count: 5,
            inner_ratio: 0.5,
        });
        assert_eq!(
            document.submit(
                transaction(
                    4,
                    vec![Command::SetAppearance {
                        id: NodeId(1),
                        appearance: invalid
                    }]
                ),
                Origin::LocalUser
            ),
            Err(CommandError::InvalidAppearance),
        );
    }

    #[test]
    fn boolean_operation_kind_requires_a_canonical_operation_and_hashes_it() {
        let mut union = node(1);
        union.kind = NodeKind::BooleanOperation;
        union.boolean_operation = Some(BooleanOperation::Union);
        let mut subtract = union.clone();
        subtract.boolean_operation = Some(BooleanOperation::Subtract);

        let operands = || {
            let mut first = node(4);
            first.kind = NodeKind::Rectangle;
            first.parent_id = Some(NodeId(1));
            first.x = 10.0;
            first.y = 20.0;
            let mut second = node(5);
            second.kind = NodeKind::Ellipse;
            second.parent_id = Some(NodeId(1));
            second.x = 80.0;
            second.y = 50.0;
            vec![Command::Create(first), Command::Create(second)]
        };

        let mut union_document = Document::empty();
        let mut union_commands = vec![Command::Create(union)];
        union_commands.extend(operands());
        union_document
            .submit(transaction(0, union_commands), Origin::LocalUser)
            .unwrap();
        let mut subtract_document = Document::empty();
        let mut subtract_commands = vec![Command::Create(subtract)];
        subtract_commands.extend(operands());
        subtract_document
            .submit(transaction(0, subtract_commands), Origin::LocalUser)
            .unwrap();
        assert_ne!(
            union_document.canonical_hash_hex(),
            subtract_document.canonical_hash_hex()
        );

        let mut incomplete = node(6);
        incomplete.kind = NodeKind::BooleanOperation;
        incomplete.boolean_operation = Some(BooleanOperation::Union);
        assert_eq!(
            Document::empty().submit(
                transaction(0, vec![Command::Create(incomplete)]),
                Origin::LocalUser
            ),
            Err(CommandError::InsufficientBooleanOperands { id: NodeId(6) }),
        );

        let mut missing_operation = node(2);
        missing_operation.kind = NodeKind::BooleanOperation;
        assert_eq!(
            Document::empty().submit(
                transaction(0, vec![Command::Create(missing_operation)]),
                Origin::LocalUser
            ),
            Err(CommandError::InvalidGeometry),
        );

        let mut misplaced_operation = node(3);
        misplaced_operation.boolean_operation = Some(BooleanOperation::Union);
        assert_eq!(
            Document::empty().submit(
                transaction(0, vec![Command::Create(misplaced_operation)]),
                Origin::LocalUser
            ),
            Err(CommandError::InvalidGeometry),
        );
    }

    #[test]
    fn live_boolean_operands_are_atomic_and_undoable() {
        let mut document = Document::empty();
        let mut first = node(1);
        first.kind = NodeKind::Rectangle;
        first.x = 10.0;
        first.y = 20.0;
        first.width = 60.0;
        first.height = 40.0;
        let mut second = node(2);
        second.kind = NodeKind::Ellipse;
        second.x = 80.0;
        second.y = 50.0;
        second.width = 30.0;
        second.height = 70.0;
        document
            .submit(
                transaction(0, vec![Command::Create(first), Command::Create(second)]),
                Origin::LocalUser,
            )
            .unwrap();

        let mut boolean = node(3);
        boolean.kind = NodeKind::BooleanOperation;
        boolean.name = "Union".into();
        boolean.boolean_operation = Some(BooleanOperation::Union);
        document
            .submit(
                transaction(
                    1,
                    vec![
                        Command::Create(boolean),
                        Command::SetNodeParent {
                            id: NodeId(1),
                            parent_id: Some(NodeId(3)),
                            position: PositionId::for_node(NodeId(1)),
                        },
                        Command::SetNodeParent {
                            id: NodeId(2),
                            parent_id: Some(NodeId(3)),
                            position: PositionId::for_node(NodeId(2)),
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let live_hash = document.canonical_hash_hex();
        let boolean = document.node(NodeId(3)).unwrap();
        assert_eq!(
            (boolean.x, boolean.y, boolean.width, boolean.height),
            (10.0, 20.0, 100.0, 100.0)
        );

        assert_eq!(
            document.submit(
                transaction(
                    2,
                    vec![Command::SetNodeParent {
                        id: NodeId(1),
                        parent_id: None,
                        position: PositionId::for_node(NodeId(1)),
                    }],
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::InsufficientBooleanOperands { id: NodeId(3) }),
        );
        assert_eq!(document.canonical_hash_hex(), live_hash);

        document.undo().unwrap();
        // Undo retires the newly allocated Boolean id, so its Canonical hash is
        // intentionally distinct from the pre-create state even though the two
        // original operands are restored exactly.
        assert!(document.node(NodeId(3)).is_none());
        assert_eq!(document.node(NodeId(1)).unwrap().parent_id, None);
        assert_eq!(document.node(NodeId(2)).unwrap().parent_id, None);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), live_hash);
    }

    #[test]
    fn boolean_operation_selector_is_undoable_without_rewriting_operands() {
        let mut boolean = node(1);
        boolean.kind = NodeKind::BooleanOperation;
        boolean.boolean_operation = Some(BooleanOperation::Union);
        let mut first = node(2);
        first.kind = NodeKind::Rectangle;
        first.parent_id = Some(NodeId(1));
        let mut second = node(3);
        second.kind = NodeKind::Ellipse;
        second.parent_id = Some(NodeId(1));
        let mut document = Document::empty();
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::Create(boolean),
                        Command::Create(first),
                        Command::Create(second),
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let union = document.canonical_hash_hex();

        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetBooleanOperation {
                        id: NodeId(1),
                        operation: BooleanOperation::Subtract,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let subtract = document.canonical_hash_hex();
        assert_ne!(union, subtract);
        assert_eq!(
            document.node(NodeId(1)).unwrap().boolean_operation,
            Some(BooleanOperation::Subtract)
        );
        assert_eq!(document.node(NodeId(2)).unwrap().parent_id, Some(NodeId(1)));
        assert_eq!(document.node(NodeId(3)).unwrap().parent_id, Some(NodeId(1)));
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), union);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), subtract);
    }

    #[test]
    fn vector_path_is_validated_hashed_and_undoable() {
        let path = VectorPath {
            fill_rule: FillRule::NonZero,
            subpaths: vec![VectorSubpath {
                closed: true,
                points: vec![
                    VectorPoint {
                        id: PointId(1),
                        position: Point { x: 0.0, y: 0.0 },
                        handle_in: None,
                        handle_out: None,
                        point_type: VectorPointType::Corner,
                    },
                    VectorPoint {
                        id: PointId(2),
                        position: Point { x: 100.0, y: 0.0 },
                        handle_in: None,
                        handle_out: Some(Point { x: 8.0, y: 0.0 }),
                        point_type: VectorPointType::Asymmetric,
                    },
                    VectorPoint {
                        id: PointId(3),
                        position: Point { x: 50.0, y: 100.0 },
                        handle_in: None,
                        handle_out: None,
                        point_type: VectorPointType::Corner,
                    },
                ],
            }],
        };
        let mut vector = node(1);
        vector.kind = NodeKind::Vector;
        vector.name = "Triangle".into();
        vector.vector_path = Some(path.clone());
        let mut document = Document::empty();
        document
            .submit(
                transaction(0, vec![Command::Create(vector)]),
                Origin::LocalUser,
            )
            .unwrap();
        let baseline = document.canonical_hash_hex();

        let mut updated = path.clone();
        updated.fill_rule = FillRule::EvenOdd;
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetVectorPath {
                        id: NodeId(1),
                        path: updated,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let changed = document.canonical_hash_hex();
        assert_ne!(changed, baseline);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), changed);

        let duplicate = VectorPath {
            fill_rule: FillRule::NonZero,
            subpaths: vec![VectorSubpath {
                closed: false,
                points: vec![
                    VectorPoint {
                        id: PointId(9),
                        position: Point { x: 0.0, y: 0.0 },
                        handle_in: None,
                        handle_out: None,
                        point_type: VectorPointType::Corner,
                    },
                    VectorPoint {
                        id: PointId(9),
                        position: Point { x: 20.0, y: 20.0 },
                        handle_in: None,
                        handle_out: None,
                        point_type: VectorPointType::Corner,
                    },
                ],
            }],
        };
        assert_eq!(
            document.submit(
                transaction(
                    4,
                    vec![Command::SetVectorPath {
                        id: NodeId(1),
                        path: duplicate
                    }]
                ),
                Origin::LocalUser
            ),
            Err(CommandError::InvalidGeometry)
        );

        let mut degenerate = path;
        degenerate.subpaths[0].points[1].position = degenerate.subpaths[0].points[0].position;
        assert_eq!(
            document.submit(
                transaction(
                    4,
                    vec![Command::SetVectorPath {
                        id: NodeId(1),
                        path: degenerate
                    }]
                ),
                Origin::LocalUser
            ),
            Err(CommandError::InvalidGeometry)
        );
    }

    #[test]
    fn named_vector_point_commands_are_validated_hashed_and_undoable() {
        let path = VectorPath {
            fill_rule: FillRule::NonZero,
            subpaths: vec![VectorSubpath {
                closed: true,
                points: vec![
                    VectorPoint {
                        id: PointId(1),
                        position: Point { x: 0.0, y: 0.0 },
                        handle_in: None,
                        handle_out: None,
                        point_type: VectorPointType::Corner,
                    },
                    VectorPoint {
                        id: PointId(2),
                        position: Point { x: 100.0, y: 0.0 },
                        handle_in: None,
                        handle_out: None,
                        point_type: VectorPointType::Corner,
                    },
                    VectorPoint {
                        id: PointId(3),
                        position: Point { x: 50.0, y: 100.0 },
                        handle_in: None,
                        handle_out: None,
                        point_type: VectorPointType::Corner,
                    },
                ],
            }],
        };
        let mut vector = node(1);
        vector.kind = NodeKind::Vector;
        vector.vector_path = Some(path);
        let mut document = Document::empty();
        document
            .submit(
                transaction(0, vec![Command::Create(vector)]),
                Origin::LocalUser,
            )
            .unwrap();
        let baseline = document.canonical_hash_hex();

        document
            .submit(
                transaction(
                    1,
                    vec![Command::MoveVectorPoint {
                        id: NodeId(1),
                        point_id: PointId(2),
                        position: Point { x: 120.0, y: 10.0 },
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let moved = document.canonical_hash_hex();
        assert_ne!(moved, baseline);
        assert_eq!(
            document
                .node(NodeId(1))
                .unwrap()
                .vector_path
                .as_ref()
                .unwrap()
                .subpaths[0]
                .points[1]
                .position,
            Point { x: 120.0, y: 10.0 },
        );
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), moved);

        document
            .submit(
                transaction(
                    document.revision,
                    vec![Command::SetVectorSubpathClosed {
                        id: NodeId(1),
                        subpath_index: 0,
                        closed: false,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let open = document.canonical_hash_hex();
        assert_ne!(open, moved);
        assert!(
            !document
                .node(NodeId(1))
                .unwrap()
                .vector_path
                .as_ref()
                .unwrap()
                .subpaths[0]
                .closed
        );
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), moved);

        document
            .submit(
                transaction(
                    document.revision,
                    vec![Command::SetVectorPointHandles {
                        id: NodeId(1),
                        point_id: PointId(2),
                        handle_in: Some(Point { x: -12.0, y: 4.0 }),
                        handle_out: Some(Point { x: 18.0, y: -6.0 }),
                        point_type: VectorPointType::Asymmetric,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let point = &document
            .node(NodeId(1))
            .unwrap()
            .vector_path
            .as_ref()
            .unwrap()
            .subpaths[0]
            .points[1];
        assert_eq!(point.handle_in, Some(Point { x: -12.0, y: 4.0 }));
        assert_eq!(point.point_type, VectorPointType::Asymmetric);

        assert_eq!(
            document.submit(
                transaction(
                    document.revision,
                    vec![Command::MoveVectorPoint {
                        id: NodeId(1),
                        point_id: PointId(99),
                        position: Point { x: 10.0, y: 10.0 },
                    }]
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidGeometry),
        );
        assert_eq!(
            document.submit(
                transaction(
                    document.revision,
                    vec![Command::SetVectorSubpathClosed {
                        id: NodeId(1),
                        subpath_index: 99,
                        closed: false,
                    }]
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidGeometry),
        );

        document
            .submit(
                transaction(
                    document.revision,
                    vec![Command::InsertVectorPoint {
                        id: NodeId(1),
                        subpath_index: 0,
                        after_point_id: Some(PointId(2)),
                        point: VectorPoint {
                            id: PointId(4),
                            position: Point { x: 80.0, y: 40.0 },
                            handle_in: None,
                            handle_out: None,
                            point_type: VectorPointType::Corner,
                        },
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document
                .node(NodeId(1))
                .unwrap()
                .vector_path
                .as_ref()
                .unwrap()
                .subpaths[0]
                .points[2]
                .id,
            PointId(4)
        );
        document.undo().unwrap();
        assert_eq!(
            document
                .node(NodeId(1))
                .unwrap()
                .vector_path
                .as_ref()
                .unwrap()
                .subpaths[0]
                .points
                .len(),
            3
        );

        document
            .submit(
                transaction(
                    document.revision,
                    vec![Command::SetVectorSubpathClosed {
                        id: NodeId(1),
                        subpath_index: 0,
                        closed: false,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        document
            .submit(
                transaction(
                    document.revision,
                    vec![Command::DeleteVectorPoint {
                        id: NodeId(1),
                        point_id: PointId(2),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(
            document
                .node(NodeId(1))
                .unwrap()
                .vector_path
                .as_ref()
                .unwrap()
                .subpaths[0]
                .points
                .len(),
            2
        );
    }

    #[test]
    fn pass_through_blend_mode_is_hashed_and_undoable() {
        let mut document = Document::empty();
        document
            .submit(
                transaction(0, vec![Command::Create(node(1))]),
                Origin::LocalUser,
            )
            .unwrap();
        let baseline = document.canonical_hash_hex();
        let mut appearance = appearance_for_node(document.node(NodeId(1)).unwrap());
        appearance.blend_mode = BlendMode::PassThrough;

        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetAppearance {
                        id: NodeId(1),
                        appearance,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let blended = document.canonical_hash_hex();
        assert_eq!(
            document.node(NodeId(1)).unwrap().blend_mode,
            BlendMode::PassThrough
        );
        assert_ne!(blended, baseline);
        document.undo().unwrap();
        assert_eq!(
            document.node(NodeId(1)).unwrap().blend_mode,
            BlendMode::Normal
        );
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), blended);
    }

    #[test]
    fn linear_blend_modes_are_distinct_in_hash_and_history() {
        let mut document = Document::empty();
        document
            .submit(
                transaction(0, vec![Command::Create(node(1))]),
                Origin::LocalUser,
            )
            .unwrap();
        let baseline = document.canonical_hash_hex();
        let mut appearance = appearance_for_node(document.node(NodeId(1)).unwrap());
        appearance.blend_mode = BlendMode::LinearBurn;
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetAppearance {
                        id: NodeId(1),
                        appearance: appearance.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let burn = document.canonical_hash_hex();
        appearance.blend_mode = BlendMode::LinearDodge;
        document
            .submit(
                transaction(
                    2,
                    vec![Command::SetAppearance {
                        id: NodeId(1),
                        appearance,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let dodge = document.canonical_hash_hex();
        assert_ne!(baseline, burn);
        assert_ne!(burn, dodge);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), burn);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), dodge);
    }

    #[test]
    fn split_vector_segment_preserves_cubic_curve_and_undo_redo_hash() {
        let path = VectorPath {
            fill_rule: FillRule::NonZero,
            subpaths: vec![VectorSubpath {
                closed: false,
                points: vec![
                    VectorPoint {
                        id: PointId(1),
                        position: Point { x: 0.0, y: 0.0 },
                        handle_in: None,
                        handle_out: Some(Point { x: 0.0, y: 10.0 }),
                        point_type: VectorPointType::Asymmetric,
                    },
                    VectorPoint {
                        id: PointId(2),
                        position: Point { x: 10.0, y: 0.0 },
                        handle_in: Some(Point { x: 0.0, y: 10.0 }),
                        handle_out: None,
                        point_type: VectorPointType::Asymmetric,
                    },
                ],
            }],
        };
        let mut vector = node(1);
        vector.kind = NodeKind::Vector;
        vector.vector_path = Some(path);
        let mut document = Document::empty();
        document
            .submit(
                transaction(0, vec![Command::Create(vector)]),
                Origin::LocalUser,
            )
            .unwrap();
        let baseline = document.canonical_hash_hex();

        document
            .submit(
                transaction(
                    1,
                    vec![Command::SplitVectorSegment {
                        id: NodeId(1),
                        subpath_index: 0,
                        after_point_id: PointId(1),
                        t: 0.5,
                        point_id: PointId(3),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let split = document.canonical_hash_hex();
        let points = &document
            .node(NodeId(1))
            .unwrap()
            .vector_path
            .as_ref()
            .unwrap()
            .subpaths[0]
            .points;
        assert_eq!(points.len(), 3);
        assert_eq!(points[0].handle_out, Some(Point { x: 0.0, y: 5.0 }));
        assert_eq!(
            points[1],
            VectorPoint {
                id: PointId(3),
                position: Point { x: 5.0, y: 7.5 },
                handle_in: Some(Point { x: -2.5, y: 0.0 }),
                handle_out: Some(Point { x: 2.5, y: 0.0 }),
                point_type: VectorPointType::Asymmetric
            }
        );
        assert_eq!(points[2].handle_in, Some(Point { x: 0.0, y: 5.0 }));
        assert_ne!(split, baseline);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), split);
        assert_eq!(
            document.submit(
                transaction(
                    document.revision,
                    vec![Command::SplitVectorSegment {
                        id: NodeId(1),
                        subpath_index: 0,
                        after_point_id: PointId(3),
                        t: 1.0,
                        point_id: PointId(4),
                    }]
                ),
                Origin::LocalUser
            ),
            Err(CommandError::InvalidGeometry)
        );
    }

    #[test]
    fn connect_vector_endpoints_merges_open_subpaths_and_preserves_undo() {
        let path = VectorPath {
            fill_rule: FillRule::NonZero,
            subpaths: vec![
                VectorSubpath {
                    closed: false,
                    points: vec![
                        VectorPoint {
                            id: PointId(1),
                            position: Point { x: 0.0, y: 0.0 },
                            handle_in: None,
                            handle_out: None,
                            point_type: VectorPointType::Corner,
                        },
                        VectorPoint {
                            id: PointId(2),
                            position: Point { x: 10.0, y: 0.0 },
                            handle_in: None,
                            handle_out: None,
                            point_type: VectorPointType::Corner,
                        },
                    ],
                },
                VectorSubpath {
                    closed: false,
                    points: vec![
                        VectorPoint {
                            id: PointId(3),
                            position: Point { x: 20.0, y: 0.0 },
                            handle_in: None,
                            handle_out: None,
                            point_type: VectorPointType::Corner,
                        },
                        VectorPoint {
                            id: PointId(4),
                            position: Point { x: 30.0, y: 0.0 },
                            handle_in: None,
                            handle_out: None,
                            point_type: VectorPointType::Corner,
                        },
                    ],
                },
            ],
        };
        let mut vector = node(1);
        vector.kind = NodeKind::Vector;
        vector.vector_path = Some(path);
        let mut document = Document::empty();
        document
            .submit(
                transaction(0, vec![Command::Create(vector)]),
                Origin::LocalUser,
            )
            .unwrap();
        let baseline = document.canonical_hash_hex();

        document
            .submit(
                transaction(
                    1,
                    vec![Command::ConnectVectorEndpoints {
                        id: NodeId(1),
                        first_subpath_index: 0,
                        first_point_id: PointId(2),
                        second_subpath_index: 1,
                        second_point_id: PointId(3),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let subpaths = &document
            .node(NodeId(1))
            .unwrap()
            .vector_path
            .as_ref()
            .unwrap()
            .subpaths;
        assert_eq!(subpaths.len(), 1);
        assert_eq!(
            subpaths[0]
                .points
                .iter()
                .map(|point| point.id)
                .collect::<Vec<_>>(),
            vec![PointId(1), PointId(2), PointId(3), PointId(4)]
        );
        assert!(!subpaths[0].closed);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(
            document
                .node(NodeId(1))
                .unwrap()
                .vector_path
                .as_ref()
                .unwrap()
                .subpaths
                .len(),
            1
        );
    }

    #[test]
    fn connect_vector_endpoints_closes_opposite_ends_of_one_subpath() {
        let path = VectorPath {
            fill_rule: FillRule::NonZero,
            subpaths: vec![VectorSubpath {
                closed: false,
                points: vec![
                    VectorPoint {
                        id: PointId(1),
                        position: Point { x: 0.0, y: 0.0 },
                        handle_in: None,
                        handle_out: None,
                        point_type: VectorPointType::Corner,
                    },
                    VectorPoint {
                        id: PointId(2),
                        position: Point { x: 20.0, y: 0.0 },
                        handle_in: None,
                        handle_out: None,
                        point_type: VectorPointType::Corner,
                    },
                    VectorPoint {
                        id: PointId(3),
                        position: Point { x: 10.0, y: 20.0 },
                        handle_in: None,
                        handle_out: None,
                        point_type: VectorPointType::Corner,
                    },
                ],
            }],
        };
        let mut vector = node(1);
        vector.kind = NodeKind::Vector;
        vector.vector_path = Some(path);
        let mut document = Document::empty();
        document
            .submit(
                transaction(0, vec![Command::Create(vector)]),
                Origin::LocalUser,
            )
            .unwrap();

        document
            .submit(
                transaction(
                    1,
                    vec![Command::ConnectVectorEndpoints {
                        id: NodeId(1),
                        first_subpath_index: 0,
                        first_point_id: PointId(1),
                        second_subpath_index: 0,
                        second_point_id: PointId(3),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert!(
            document
                .node(NodeId(1))
                .unwrap()
                .vector_path
                .as_ref()
                .unwrap()
                .subpaths[0]
                .closed
        );
    }

    #[test]
    fn text_ending_truncation_is_validated_hashed_and_undoable() {
        let mut text = node(1);
        text.kind = NodeKind::Text;
        text.text = "one two three".into();
        let mut document = Document::empty();
        document
            .submit(
                transaction(0, vec![Command::Create(text)]),
                Origin::LocalUser,
            )
            .unwrap();
        let baseline = document.canonical_hash_hex();
        let properties = TextProperties {
            text_truncation: TextTruncation::Ending,
            max_lines: Some(2),
            ..TextProperties::default()
        };
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetTextProperties {
                        id: NodeId(1),
                        properties: properties.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let truncated = document.canonical_hash_hex();
        assert_ne!(truncated, baseline);
        assert_eq!(
            document.text_properties_for_node(NodeId(1)),
            Some(&properties)
        );
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), truncated);

        let revision = document.revision;
        let hash = document.canonical_hash();
        for invalid in [
            TextProperties {
                text_truncation: TextTruncation::Ending,
                max_lines: Some(0),
                ..TextProperties::default()
            },
            TextProperties {
                text_truncation: TextTruncation::Disabled,
                max_lines: Some(1),
                ..TextProperties::default()
            },
        ] {
            assert!(
                document
                    .submit(
                        transaction(
                            revision,
                            vec![Command::SetTextProperties {
                                id: NodeId(1),
                                properties: invalid
                            }]
                        ),
                        Origin::LocalUser,
                    )
                    .is_err()
            );
            assert_eq!(document.revision, revision);
            assert_eq!(document.canonical_hash(), hash);
        }
    }

    #[test]
    fn text_path_conversion_retains_identity_and_restores_the_source_on_undo() {
        let mut rectangle = node(91);
        rectangle.kind = NodeKind::Rectangle;
        rectangle.name = "Source rectangle".into();
        rectangle.corner_radius = 12.0;
        let position = rectangle.position;
        let path = VectorPath {
            fill_rule: FillRule::NonZero,
            subpaths: vec![VectorSubpath {
                closed: true,
                points: vec![
                    VectorPoint {
                        id: PointId(911),
                        position: Point::new(0.0, 0.0).unwrap(),
                        handle_in: None,
                        handle_out: None,
                        point_type: VectorPointType::Corner,
                    },
                    VectorPoint {
                        id: PointId(912),
                        position: Point::new(240.0, 0.0).unwrap(),
                        handle_in: None,
                        handle_out: None,
                        point_type: VectorPointType::Corner,
                    },
                    VectorPoint {
                        id: PointId(913),
                        position: Point::new(240.0, 160.0).unwrap(),
                        handle_in: None,
                        handle_out: None,
                        point_type: VectorPointType::Corner,
                    },
                    VectorPoint {
                        id: PointId(914),
                        position: Point::new(0.0, 160.0).unwrap(),
                        handle_in: None,
                        handle_out: None,
                        point_type: VectorPointType::Corner,
                    },
                ],
            }],
        };
        let mut document = Document::empty();
        document
            .submit(
                transaction(0, vec![Command::Create(rectangle)]),
                Origin::LocalUser,
            )
            .unwrap();
        let source_hash = document.canonical_hash_hex();
        document
            .submit(
                transaction(
                    1,
                    vec![
                        Command::ConvertToTextPath {
                            id: NodeId(91),
                            path: path.clone(),
                        },
                        Command::Rename {
                            id: NodeId(91),
                            name: "Text path".into(),
                        },
                        Command::SetText {
                            id: NodeId(91),
                            text: "hello".into(),
                        },
                        Command::SetTextProperties {
                            id: NodeId(91),
                            properties: TextProperties {
                                runs: vec![TextStyleRun {
                                    start: 0,
                                    end: 5,
                                    font: None,
                                    font_size: 18.0,
                                    font_weight: 400,
                                    italic: false,
                                    letter_spacing: 0.0,
                                    color: None,
                                    fill_stack: None,
                                    text_case: None,
                                    hyperlink: None,
                                    text_decoration: None,
                                    text_decoration_style: None,
                                    text_decoration_offset: None,
                                    text_decoration_thickness: None,
                                    text_decoration_skip_ink: None,
                                    leading_trim: None,
                                    open_type_features: Vec::new(),
                                    text_style_id: None,
                                    paint_style_id: None,
                                    variable_bindings: Default::default(),
                                    text_decoration_color: None,
                                }],
                                ..TextProperties::default()
                            },
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let converted_hash = document.canonical_hash_hex();
        let converted = document.node(NodeId(91)).unwrap();
        assert_eq!(converted.id, NodeId(91));
        assert_eq!(converted.position, position);
        assert_eq!(converted.kind, NodeKind::TextPath);
        assert_eq!(converted.vector_path.as_ref(), Some(&path));
        assert_eq!(converted.corner_radius, 0.0);
        assert!(document.text_properties_for_node(NodeId(91)).is_some());

        document.undo().unwrap();
        let restored = document.node(NodeId(91)).unwrap();
        assert_eq!(restored.kind, NodeKind::Rectangle);
        assert_eq!(restored.name, "Source rectangle");
        assert_eq!(restored.corner_radius, 12.0);
        assert!(restored.vector_path.is_none());
        assert!(document.text_properties_for_node(NodeId(91)).is_none());
        assert_eq!(document.canonical_hash_hex(), source_hash);

        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), converted_hash);
        assert_eq!(document.node(NodeId(91)).unwrap().kind, NodeKind::TextPath);
    }

    #[test]
    fn variable_registration_is_atomic_undoable_and_replayable() {
        let mut document = Document::with_id(DocumentId(919));
        let collection = VariableCollectionResource {
            id: "VC:tokens".into(),
            key: String::new(),
            name: "Tokens".into(),
            remote: false,
            hidden_from_publishing: false,
            modes: vec![VariableMode {
                id: "default".into(),
                name: "Mode 1".into(),
            }],
            default_mode_id: "default".into(),
        };
        let variable = VariableResource {
            id: "V:spacing".into(),
            key: String::new(),
            name: "Spacing".into(),
            description: String::new(),
            remote: false,
            hidden_from_publishing: false,
            collection_id: collection.id.clone(),
            resolved_type: VariableResolvedType::Float,
            values_by_mode: [("default".into(), VariableValue::Float(0.0))].into(),
            scopes: vec!["ALL_SCOPES".into()],
            code_syntax: BTreeMap::new(),
        };
        let before = document.canonical_hash();
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::RegisterVariableCollection {
                            collection: collection.clone(),
                        },
                        Command::RegisterVariable {
                            variable: variable.clone(),
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let after = document.canonical_hash();
        assert_ne!(before, after);
        assert_eq!(
            document.variable_collection(&collection.id),
            Some(&collection)
        );
        assert_eq!(document.variable(&variable.id), Some(&variable));

        document.undo().unwrap();
        assert_eq!(document.canonical_hash(), before);
        assert!(document.variable_collection(&collection.id).is_none());
        assert!(document.variable(&variable.id).is_none());

        document.redo().unwrap();
        assert_eq!(document.canonical_hash(), after);
        assert_eq!(document.variable(&variable.id), Some(&variable));
    }

    #[test]
    fn text_style_variable_bindings_are_typed_hashed_and_protect_variables() {
        let mut document = Document::with_id(DocumentId(921));
        let collection = VariableCollectionResource {
            id: "VC:typography".into(),
            key: String::new(),
            name: "Typography".into(),
            remote: false,
            hidden_from_publishing: false,
            modes: vec![VariableMode {
                id: "default".into(),
                name: "Default".into(),
            }],
            default_mode_id: "default".into(),
        };
        let font_size = VariableResource {
            id: "V:font-size".into(),
            key: String::new(),
            name: "Font size".into(),
            description: String::new(),
            remote: false,
            hidden_from_publishing: false,
            collection_id: collection.id.clone(),
            resolved_type: VariableResolvedType::Float,
            values_by_mode: [("default".into(), VariableValue::Float(16.0))].into(),
            scopes: vec!["FONT_SIZE".into()],
            code_syntax: BTreeMap::new(),
        };
        let font_family = VariableResource {
            id: "V:font-family".into(),
            key: String::new(),
            name: "Font family".into(),
            description: String::new(),
            remote: false,
            hidden_from_publishing: false,
            collection_id: collection.id.clone(),
            resolved_type: VariableResolvedType::String,
            values_by_mode: [("default".into(), VariableValue::String("Inter".into()))].into(),
            scopes: vec!["FONT_FAMILY".into()],
            code_syntax: BTreeMap::new(),
        };
        document
            .seed_variable_collection(collection.clone())
            .unwrap();
        document.seed_variable(font_size.clone()).unwrap();
        document.seed_variable(font_family.clone()).unwrap();

        let baseline = document.canonical_hash();
        let mut style = text_style_resource("S:body");
        style.variable_bindings = [
            ("fontFamily".into(), font_family.id.clone()),
            ("fontSize".into(), font_size.id.clone()),
        ]
        .into();
        document
            .submit(
                transaction(
                    document.revision,
                    vec![Command::RegisterTextStyle {
                        style: style.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let bound_hash = document.canonical_hash();
        assert_ne!(bound_hash, baseline);
        assert_eq!(document.text_style(&style.id), Some(&style));
        document.undo().unwrap();
        assert_eq!(document.canonical_hash(), baseline);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash(), bound_hash);

        assert_eq!(
            document.submit(
                transaction(
                    document.revision,
                    vec![Command::DeleteVariable {
                        id: font_size.id.clone(),
                    }],
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidVariable)
        );
        assert_eq!(
            document.submit(
                transaction(
                    document.revision,
                    vec![Command::DeleteVariableCollection {
                        id: collection.id.clone(),
                    }],
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidVariableCollection)
        );

        let mut wrong_type = text_style_resource("S:wrong-type");
        wrong_type
            .variable_bindings
            .insert("fontFamily".into(), font_size.id.clone());
        assert_eq!(
            document.seed_text_style(wrong_type),
            Err(CommandError::InvalidTextStyle)
        );
        let mut missing = text_style_resource("S:missing-variable");
        missing
            .variable_bindings
            .insert("fontSize".into(), "V:missing".into());
        assert_eq!(
            document.seed_text_style(missing),
            Err(CommandError::InvalidTextStyle)
        );
    }

    #[test]
    fn text_range_variable_bindings_are_typed_hashed_and_protect_variables() {
        let mut document = Document::with_id(DocumentId(923));
        let collection = VariableCollectionResource {
            id: "VC:text-range".into(),
            key: String::new(),
            name: "Text range".into(),
            remote: false,
            hidden_from_publishing: false,
            modes: vec![VariableMode {
                id: "default".into(),
                name: "Default".into(),
            }],
            default_mode_id: "default".into(),
        };
        let variable = VariableResource {
            id: "V:text-size".into(),
            key: String::new(),
            name: "Text size".into(),
            description: String::new(),
            remote: false,
            hidden_from_publishing: false,
            collection_id: collection.id.clone(),
            resolved_type: VariableResolvedType::Float,
            values_by_mode: [("default".into(), VariableValue::Float(24.0))].into(),
            scopes: vec!["FONT_SIZE".into()],
            code_syntax: BTreeMap::new(),
        };
        document
            .seed_variable_collection(collection.clone())
            .unwrap();
        document.seed_variable(variable.clone()).unwrap();
        let mut text = node(923);
        text.kind = NodeKind::Text;
        text.text = "A".into();
        document.seed_node(text).unwrap();
        let baseline = document.canonical_hash();
        let mut run = text_style_resource("S:template").style;
        run.start = 0;
        run.end = 1;
        run.variable_bindings
            .insert("fontSize".into(), variable.id.clone());
        document
            .seed_text_properties(
                NodeId(923),
                TextProperties {
                    runs: vec![run.clone()],
                    ..TextProperties::default()
                },
            )
            .unwrap();
        assert_ne!(document.canonical_hash(), baseline);
        assert_eq!(
            document.submit(
                transaction(
                    document.revision,
                    vec![Command::DeleteVariable {
                        id: variable.id.clone(),
                    }],
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidVariable)
        );
        assert_eq!(
            document.submit(
                transaction(
                    document.revision,
                    vec![Command::DeleteVariableCollection {
                        id: collection.id.clone(),
                    }],
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidVariableCollection)
        );

        run.variable_bindings = [("fontFamily".into(), variable.id.clone())].into();
        assert_eq!(
            document.seed_text_properties(
                NodeId(923),
                TextProperties {
                    runs: vec![run],
                    ..TextProperties::default()
                },
            ),
            Err(CommandError::InvalidTextProperties)
        );
    }

    #[test]
    fn paint_style_variable_bindings_are_typed_ordered_and_protect_variables() {
        let mut document = Document::with_id(DocumentId(922));
        let collection = VariableCollectionResource {
            id: "VC:colors".into(),
            key: String::new(),
            name: "Colors".into(),
            remote: false,
            hidden_from_publishing: false,
            modes: vec![VariableMode {
                id: "default".into(),
                name: "Default".into(),
            }],
            default_mode_id: "default".into(),
        };
        let color = VariableResource {
            id: "V:brand".into(),
            key: String::new(),
            name: "Brand".into(),
            description: String::new(),
            remote: false,
            hidden_from_publishing: false,
            collection_id: collection.id.clone(),
            resolved_type: VariableResolvedType::Color,
            values_by_mode: [(
                "default".into(),
                VariableValue::Color(Color::from_srgb_u8([255, 0, 0], 255)),
            )]
            .into(),
            scopes: vec!["ALL_FILLS".into()],
            code_syntax: BTreeMap::new(),
        };
        document
            .seed_variable_collection(collection.clone())
            .unwrap();
        document.seed_variable(color.clone()).unwrap();

        let baseline = document.canonical_hash();
        let mut style = paint_style_resource("S:brand");
        style.paints.layers.push(color::PaintLayer {
            paint: PaintLayerKind::Solid(Color::from_srgb_u8([255, 0, 0], 255)),
            visible: true,
            opacity: 1.0,
            blend_mode: BlendMode::Normal,
        });
        style.variable_bindings.push(PaintStyleVariableBinding {
            paint_index: 0,
            stop_index: None,
            variable_id: color.id.clone(),
        });
        document
            .submit(
                transaction(
                    document.revision,
                    vec![Command::RegisterPaintStyle {
                        style: style.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let bound_hash = document.canonical_hash();
        assert_ne!(bound_hash, baseline);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash(), baseline);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash(), bound_hash);
        assert_eq!(
            document.submit(
                transaction(
                    document.revision,
                    vec![Command::DeleteVariable {
                        id: color.id.clone(),
                    }],
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidVariable)
        );
        assert_eq!(
            document.submit(
                transaction(
                    document.revision,
                    vec![Command::DeleteVariableCollection {
                        id: collection.id.clone(),
                    }],
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidVariableCollection)
        );

        let mut invalid_target = paint_style_resource("S:invalid-target");
        invalid_target
            .variable_bindings
            .push(PaintStyleVariableBinding {
                paint_index: 0,
                stop_index: None,
                variable_id: color.id,
            });
        assert_eq!(
            document.seed_paint_style(invalid_target),
            Err(CommandError::InvalidPaintStyle)
        );
    }

    #[test]
    fn variable_changes_and_deletion_preserve_history_and_alias_integrity() {
        let mut document = Document::with_id(DocumentId(918));
        let collection = VariableCollectionResource {
            id: "VC:tokens".into(),
            key: String::new(),
            name: "Tokens".into(),
            remote: false,
            hidden_from_publishing: false,
            modes: vec![VariableMode {
                id: "default".into(),
                name: "Mode 1".into(),
            }],
            default_mode_id: "default".into(),
        };
        let variable = VariableResource {
            id: "V:spacing".into(),
            key: String::new(),
            name: "Spacing".into(),
            description: String::new(),
            remote: false,
            hidden_from_publishing: false,
            collection_id: collection.id.clone(),
            resolved_type: VariableResolvedType::Float,
            values_by_mode: [("default".into(), VariableValue::Float(0.0))].into(),
            scopes: vec!["ALL_SCOPES".into()],
            code_syntax: BTreeMap::new(),
        };
        document
            .submit(
                transaction(
                    0,
                    vec![
                        Command::RegisterVariableCollection { collection },
                        Command::RegisterVariable {
                            variable: variable.clone(),
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        let mut changed = variable.clone();
        changed.name = "Space".into();
        changed.code_syntax.insert("WEB".into(), "--space".into());
        changed
            .values_by_mode
            .insert("default".into(), VariableValue::Float(8.0));
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetVariable {
                        variable: changed.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(document.variable(&changed.id), Some(&changed));
        document.undo().unwrap();
        assert_eq!(document.variable(&variable.id), Some(&variable));
        document.redo().unwrap();
        assert_eq!(document.variable(&changed.id), Some(&changed));

        document
            .submit(
                transaction(
                    document.revision,
                    vec![Command::DeleteVariable {
                        id: changed.id.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert!(document.variable(&changed.id).is_none());
        document.undo().unwrap();
        assert_eq!(document.variable(&changed.id), Some(&changed));

        let mut updated_collection = document.variable_collection("VC:tokens").unwrap().clone();
        updated_collection.modes.push(VariableMode {
            id: "dark".into(),
            name: "Dark".into(),
        });
        let mut mode_variable = changed.clone();
        mode_variable
            .values_by_mode
            .insert("dark".into(), VariableValue::Float(12.0));
        document
            .submit(
                transaction(
                    document.revision,
                    vec![Command::SetVariableCollection {
                        collection: updated_collection.clone(),
                        variables: vec![mode_variable.clone()],
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(document.variable(&mode_variable.id), Some(&mode_variable));
        document
            .submit(
                transaction(
                    document.revision,
                    vec![Command::DeleteVariableCollection {
                        id: updated_collection.id.clone(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert!(
            document
                .variable_collection(&updated_collection.id)
                .is_none()
        );
        assert!(document.variable(&mode_variable.id).is_none());
        document.undo().unwrap();
        assert_eq!(
            document.variable_collection(&updated_collection.id),
            Some(&updated_collection)
        );
        assert_eq!(document.variable(&mode_variable.id), Some(&mode_variable));
    }

    #[test]
    fn variable_catalog_is_bounded_hashed_and_alias_safe() {
        let mut document = Document::with_id(DocumentId(920));
        let collection = VariableCollectionResource {
            id: "VC:theme".into(),
            key: String::new(),
            name: "Theme".into(),
            remote: false,
            hidden_from_publishing: false,
            modes: vec![
                VariableMode {
                    id: "light".into(),
                    name: "Light".into(),
                },
                VariableMode {
                    id: "dark".into(),
                    name: "Dark".into(),
                },
            ],
            default_mode_id: "light".into(),
        };
        document
            .seed_variable_collection(collection.clone())
            .unwrap();
        let before = document.canonical_hash();
        let spacing = VariableResource {
            id: "V:spacing".into(),
            key: String::new(),
            name: "Spacing".into(),
            description: String::new(),
            remote: false,
            hidden_from_publishing: false,
            collection_id: collection.id.clone(),
            resolved_type: VariableResolvedType::Float,
            values_by_mode: [
                ("light".into(), VariableValue::Float(8.0)),
                ("dark".into(), VariableValue::Float(12.0)),
            ]
            .into(),
            scopes: vec!["GAP".into()],
            code_syntax: BTreeMap::new(),
        };
        document.seed_variable(spacing.clone()).unwrap();
        document
            .seed_variable(VariableResource {
                id: "V:alias".into(),
                key: String::new(),
                name: "Alias".into(),
                description: String::new(),
                remote: false,
                hidden_from_publishing: false,
                collection_id: collection.id.clone(),
                resolved_type: VariableResolvedType::Float,
                values_by_mode: [
                    ("light".into(), VariableValue::Alias(spacing.id.clone())),
                    ("dark".into(), VariableValue::Float(16.0)),
                ]
                .into(),
                scopes: Vec::new(),
                code_syntax: BTreeMap::new(),
            })
            .unwrap();
        document.validate_variable_catalog().unwrap();
        assert_ne!(document.canonical_hash(), before);
        assert_eq!(document.variable("V:spacing"), Some(&spacing));
        let mut invalid_syntax = spacing.clone();
        invalid_syntax.id = "V:invalid-syntax".into();
        invalid_syntax
            .code_syntax
            .insert("DESKTOP".into(), "space".into());
        assert!(matches!(
            document.seed_variable(invalid_syntax),
            Err(CommandError::InvalidVariable)
        ));
        assert!(matches!(
            document.seed_variable(VariableResource {
                id: "V:bad".into(),
                key: String::new(),
                name: "Bad".into(),
                description: String::new(),
                remote: false,
                hidden_from_publishing: false,
                collection_id: collection.id,
                resolved_type: VariableResolvedType::Boolean,
                values_by_mode: [
                    ("light".into(), VariableValue::Float(1.0)),
                    ("dark".into(), VariableValue::Boolean(true))
                ]
                .into(),
                scopes: Vec::new(),
                code_syntax: BTreeMap::new(),
            }),
            Err(CommandError::InvalidVariable)
        ));
    }
}
