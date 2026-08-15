//! Canonical document and transaction primitives shared by browser and server runtimes.
//!
//! The crate deliberately contains no rendering cache, UI state, or transport types.
//! A document is the only source of truth; consumers derive scene and GPU state after a
//! transaction has been accepted.

pub mod authz;
pub mod color;
pub mod geometry;

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use crate::color::{Color, ColorSpace, DocumentColorProfile, Paint};
use crate::geometry::{AffineTransform, Point};
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
pub const MAX_FONT_VARIATION_AXES: usize = 16;

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
}

/// Figma-compatible per-axis response to a containing Frame resize. `None` on
/// a node remains a deliberate legacy/no-constraint state.
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LayoutAlignment {
    #[default]
    Start,
    Center,
    End,
    SpaceBetween,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LayoutSizing {
    #[default]
    Fixed,
    Hug,
    Fill,
}

/// Container and child inputs live in a separate canonical table, which keeps
/// legacy Node snapshots byte-compatible while still making layout semantic.
#[derive(Debug, Clone, PartialEq)]
pub struct AutoLayout {
    pub mode: LayoutMode,
    pub padding: [f64; 4],
    pub item_spacing: f64,
    pub wrap: bool,
    pub primary_alignment: LayoutAlignment,
    pub counter_alignment: LayoutAlignment,
    pub primary_sizing: LayoutSizing,
    pub counter_sizing: LayoutSizing,
    pub min_width: Option<f64>,
    pub max_width: Option<f64>,
    pub min_height: Option<f64>,
    pub max_height: Option<f64>,
    pub absolute: bool,
}

impl Default for AutoLayout {
    fn default() -> Self {
        Self {
            mode: LayoutMode::None,
            padding: [0.0; 4],
            item_spacing: 0.0,
            wrap: false,
            primary_alignment: LayoutAlignment::Start,
            counter_alignment: LayoutAlignment::Start,
            primary_sizing: LayoutSizing::Fixed,
            counter_sizing: LayoutSizing::Fixed,
            min_width: None,
            max_width: None,
            min_height: None,
            max_height: None,
            absolute: false,
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
pub struct BackgroundBlur { pub radius: f64, pub visible: bool }

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
pub struct AssetReference {
    pub asset_id: AssetId,
    pub content_hash: [u8; 32],
    pub media_type: String,
    pub byte_length: u64,
    /// Raster dimensions are present only for image resources; fonts retain
    /// `None` for both dimensions.
    pub dimensions: Option<[u32; 2]>,
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
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParagraphStyle {
    pub alignment: TextAlign,
    pub line_height: Option<f64>,
    pub paragraph_spacing: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TextProperties {
    pub runs: Vec<TextStyleRun>,
    pub paragraph: ParagraphStyle,
    pub auto_size: TextAutoSize,
    pub fallback_fonts: Vec<FontReference>,
}

impl Default for TextProperties {
    fn default() -> Self {
        Self {
            runs: Vec::new(),
            paragraph: ParagraphStyle {
                alignment: TextAlign::Left,
                line_height: Some(20.0),
                paragraph_spacing: 0.0,
            },
            auto_size: TextAutoSize::Fixed,
            fallback_fonts: Vec::new(),
        }
    }
}

pub const DEFAULT_PAGE_ID: PageId = PageId(1);

#[derive(Debug, Clone, PartialEq)]
pub struct Document {
    id: DocumentId,
    pub revision: u64,
    color_profile: DocumentColorProfile,
    pages: BTreeMap<PageId, Page>,
    /// Kept separately from `Node` during the Phase 0 → Phase 1 migration so the
    /// public node construction contract remains source-compatible. The mapping is
    /// nevertheless canonical state and participates in hashing and snapshots.
    node_pages: BTreeMap<NodeId, PageId>,
    /// Tracks the unique ordering key for each sibling set, so malformed
    /// snapshots cannot leave rendering order dependent on a node-ID tiebreaker.
    sibling_positions: BTreeSet<(PageId, Option<NodeId>, PositionId)>,
    node_assets: BTreeMap<NodeId, AssetId>,
    node_text_properties: BTreeMap<NodeId, TextProperties>,
    /// Explicit entries only; omitted records are exactly `AutoLayout::default`.
    node_auto_layout: BTreeMap<NodeId, AutoLayout>,
    /// Retained page membership for node tombstones; undo/redo therefore restores
    /// a node to the page it came from.
    retired_node_pages: BTreeMap<NodeId, PageId>,
    retired_node_assets: BTreeMap<NodeId, AssetId>,
    retired_node_text_properties: BTreeMap<NodeId, TextProperties>,
    retired_node_auto_layout: BTreeMap<NodeId, AutoLayout>,
    nodes: BTreeMap<NodeId, Node>,
    /// Versioned Resource Index. Asset references are canonical state even before
    /// an Image/Text node consumes them, so cache eviction cannot alter a document.
    assets: BTreeMap<AssetId, AssetReference>,
    node_bytes: usize,
    /// IDs are never allocated to an unrelated new node after deletion.
    retired_ids: BTreeSet<NodeId>,
    undo_stack: Vec<HistoryItem>,
    redo_stack: Vec<HistoryItem>,
    undo_bytes: usize,
    redo_bytes: usize,
    /// Dedupe state belongs to the canonical document: retrying an already accepted
    /// transaction must not create a second revision or history item.
    accepted_transactions: BTreeMap<TransactionId, AcceptedTransactionRecord>,
    accepted_transaction_order: VecDeque<TransactionId>,
    accepted_transaction_bytes: usize,
    /// Operation delivery is at-least-once. This independent cache ensures a reused
    /// operation ID cannot either mutate twice or silently carry a different payload.
    accepted_operations: BTreeMap<OperationId, AcceptedOperationRecord>,
    accepted_operation_order: VecDeque<OperationId>,
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
    Rename {
        id: NodeId,
        name: String,
    },
    SetAppearance {
        id: NodeId,
        appearance: Appearance,
    },
    /// Replaces a complete validated VectorPath in one history/replication
    /// unit. This remains the import/snapshot escape hatch for vector edits.
    SetVectorPath {
        id: NodeId,
        path: VectorPath,
    },
    /// Changes the durable reducer selector of a live BooleanOperation without
    /// flattening or rewriting its ordered operand children.
    SetBooleanOperation {
        id: NodeId,
        operation: BooleanOperation,
    },
    /// Marks a paintable layer as an alpha mask for its following siblings.
    /// The relationship is intentionally expressed by durable sibling order;
    /// the mask flag itself is stored in the reserved Phase 2 extension key so
    /// snapshots predating G4 remain byte-for-byte compatible.
    SetMask {
        id: NodeId,
        enabled: bool,
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
            pages: BTreeMap::from([(
                DEFAULT_PAGE_ID,
                Page {
                    id: DEFAULT_PAGE_ID,
                    name: "Page 1".into(),
                    position: PositionId::for_node(NodeId(DEFAULT_PAGE_ID.0)),
                },
            )]),
            node_pages: BTreeMap::new(),
            sibling_positions: BTreeSet::new(),
            node_assets: BTreeMap::new(),
            node_text_properties: BTreeMap::new(),
            node_auto_layout: BTreeMap::new(),
            retired_node_pages: BTreeMap::new(),
            retired_node_assets: BTreeMap::new(),
            retired_node_text_properties: BTreeMap::new(),
            retired_node_auto_layout: BTreeMap::new(),
            nodes: BTreeMap::new(),
            assets: BTreeMap::new(),
            node_bytes: 0,
            retired_ids: BTreeSet::new(),
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            undo_bytes: 0,
            redo_bytes: 0,
            accepted_transactions: BTreeMap::new(),
            accepted_transaction_order: VecDeque::new(),
            accepted_transaction_bytes: 0,
            accepted_operations: BTreeMap::new(),
            accepted_operation_order: VecDeque::new(),
            accepted_operation_bytes: 0,
        }
    }

    pub fn id(&self) -> DocumentId {
        self.id
    }

    pub fn nodes(&self) -> impl Iterator<Item = &Node> {
        self.nodes.values()
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

    /// An absent record is exactly the stable Auto Layout default.
    pub fn auto_layout_for_node(&self, id: NodeId) -> AutoLayout {
        self.node_auto_layout.get(&id).cloned().unwrap_or_default()
    }

    /// A Frame that owns Auto Layout describes its own width and height using
    /// its primary/counter axes. Map those physical axes to the parent's axes
    /// before the parent lays it out; this keeps nested Frame sizing stable
    /// when the two containers use different directions.
    fn auto_layout_child_sizing(&self, node: &Node, parent_horizontal: bool) -> (LayoutSizing, LayoutSizing) {
        let layout = self.auto_layout_for_node(node.id);
        if node.kind == NodeKind::Frame && layout.mode != LayoutMode::None {
            let (width, height) = match layout.mode {
                LayoutMode::Horizontal => (layout.primary_sizing, layout.counter_sizing),
                LayoutMode::Vertical => (layout.counter_sizing, layout.primary_sizing),
                LayoutMode::None => unreachable!("active layout has a direction"),
            };
            return if parent_horizontal { (width, height) } else { (height, width) };
        }
        (layout.primary_sizing, layout.counter_sizing)
    }

    pub fn ordered_nodes_on_page(&self, page_id: PageId) -> Result<Vec<&Node>, CommandError> {
        if !self.pages.contains_key(&page_id) {
            return Err(CommandError::MissingPage { id: page_id });
        }
        let mut nodes = self
            .nodes
            .values()
            .filter(|node| self.node_pages.get(&node.id) == Some(&page_id))
            .collect::<Vec<_>>();
        nodes.sort_unstable_by_key(|node| (node.parent_id, node.position, node.id));
        Ok(nodes)
    }

    pub fn ordered_nodes(&self) -> Vec<&Node> {
        let mut nodes = self.nodes.values().collect::<Vec<_>>();
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
        self.nodes.get(&id)
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
        if node.kind != NodeKind::Text || !self.valid_text_properties(&node.text, &properties) {
            return Err(CommandError::InvalidTextProperties);
        }
        self.replace_text_properties(id, properties);
        Ok(())
    }

    /// Trusted snapshot hydration for explicit Auto Layout input. Omitted
    /// records remain the stable default and are not materialized in the map.
    pub fn seed_auto_layout(&mut self, id: NodeId, layout: AutoLayout) -> Result<(), CommandError> {
        let node = self.nodes.get(&id).ok_or(CommandError::MissingNode { id })?;
        if !valid_auto_layout(&layout) || (layout.mode != LayoutMode::None && node.kind != NodeKind::Frame) {
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

    /// Inserts a resource record while hydrating a verified snapshot. Attachment
    /// operations will be added with Image/Text node semantics; this registry is
    /// deliberately separate from raw bytes and cache lifetime.
    pub fn seed_asset(&mut self, asset: AssetReference) -> Result<(), CommandError> {
        self.insert_asset(asset)
    }

    fn insert_asset(&mut self, asset: AssetReference) -> Result<(), CommandError> {
        if asset.media_type.trim().is_empty()
            || asset.byte_length == 0
            || asset.content_hash == [0; 32]
            || matches!(asset.dimensions, Some([0, _] | [_, 0]))
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
        if let Some(previous) = self.accepted_transactions.get(&transaction.id) {
            return if previous.transaction == transaction {
                Ok(previous.applied.clone())
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

        let mut next = self.clone();
        let mut changes = Vec::with_capacity(transaction.commands.len());
        for command in &transaction.commands {
            changes.push(next.apply(command)?);
        }
        changes.extend(next.reflow_auto_layout(next.auto_layout_dirty_frames(&transaction.commands, self))?);
        next.ensure_non_empty_groups()?;
        next.revision += 1;
        let accepted_revision = next.revision;
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
            next.push_undo(history_item.clone());
            next.clear_redo();
        }
        let applied = AppliedTransaction {
            transaction_id: transaction.id,
            accepted_revision,
            history_item,
        };
        next.insert_accepted_transaction(
            transaction.id,
            AcceptedTransactionRecord {
                transaction,
                applied: applied.clone(),
            },
        );
        *self = next;
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

        let mut next = self.clone();
        let accepted_transaction = next.submit(operation.transaction.clone(), origin)?;
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
        let item = self.undo_stack.pop()?;
        self.undo_bytes = self.undo_bytes.saturating_sub(item.estimated_bytes());
        for change in item.changes.iter().rev() {
            self.apply_inverse(change);
        }
        self.revision += 1;
        self.push_redo(item);
        Some(self.revision)
    }

    pub fn redo(&mut self) -> Option<u64> {
        let item = self.redo_stack.pop()?;
        self.redo_bytes = self.redo_bytes.saturating_sub(item.estimated_bytes());
        for change in &item.changes {
            self.apply_forward(change);
        }
        self.revision += 1;
        self.push_undo(item);
        Some(self.revision)
    }

    fn clear_redo(&mut self) {
        self.redo_stack.clear();
        self.redo_bytes = 0;
    }

    fn push_undo(&mut self, item: HistoryItem) {
        self.undo_bytes += item.estimated_bytes();
        self.undo_stack.push(item);
        while self.undo_stack.len() > MAX_HISTORY_ITEMS || self.undo_bytes > MAX_HISTORY_BYTES {
            if let Some(discarded) = self.undo_stack.first() {
                self.undo_bytes = self.undo_bytes.saturating_sub(discarded.estimated_bytes());
            }
            self.undo_stack.remove(0);
        }
    }

    fn push_redo(&mut self, item: HistoryItem) {
        self.redo_bytes += item.estimated_bytes();
        self.redo_stack.push(item);
        while self.redo_stack.len() > MAX_HISTORY_ITEMS || self.redo_bytes > MAX_HISTORY_BYTES {
            if let Some(discarded) = self.redo_stack.first() {
                self.redo_bytes = self.redo_bytes.saturating_sub(discarded.estimated_bytes());
            }
            self.redo_stack.remove(0);
        }
    }

    fn insert_accepted_transaction(
        &mut self,
        id: TransactionId,
        record: AcceptedTransactionRecord,
    ) {
        self.accepted_transaction_bytes += record.estimated_bytes();
        self.accepted_transactions.insert(id, record);
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
        self.accepted_operations.insert(id, record);
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
                self.restore_tombstoned_node(*page_id, node.clone(), *asset_id, text_properties.clone())
            }
            Command::Create(node) => {
                self.assert_parent_mutable(node.parent_id)?;
                self.create_node_in_page(DEFAULT_PAGE_ID, node.clone())
            }
            Command::UpdateGeometry {
                id,
                x,
                y,
                width,
                height,
                rotation,
            } => {
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
                    let relative_group_bounds = self.nodes.get(id).is_some_and(|node| node.relative_transform.is_some())
                        && after.x.is_finite()
                        && after.y.is_finite()
                        && after.width.is_finite()
                        && after.height.is_finite()
                        && after.width > 0.0
                        && after.height > 0.0
                        && after.rotation.is_finite();
                    relative_group_bounds || self.geometry_for(*id).is_some_and(|before| {
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
                // Constraints are preserved for round-trip compatibility, but
                // an active Auto Layout Frame is the sole owner of descendant
                // placement and sizing. Applying both systems during a resize
                // would transiently rewrite the child before layout reflows.
                let frame_has_active_auto_layout = kind == NodeKind::Frame
                    && self.auto_layout_for_node(*id).mode != LayoutMode::None;
                let constrained_children = if kind == NodeKind::Frame
                    && !frame_has_active_auto_layout
                    && after.rotation == 0.0
                    && self.nodes.get(id).is_some_and(|node| node.relative_transform.is_none() && node.rotation == 0.0)
                {
                    let before = frame_before.expect("existing node has geometry");
                    self.nodes.values().filter(|child| {
                        if child.relative_transform.is_some() { return false; }
                        let mut parent_id = child.parent_id;
                        while let Some(ancestor_id) = parent_id {
                            if ancestor_id == *id { return true; }
                            let Some(ancestor) = self.nodes.get(&ancestor_id) else { return false; };
                            if !is_structural_container(&ancestor.kind) { return false; }
                            parent_id = ancestor.parent_id;
                        }
                        false
                    }).filter_map(|child| {
                        child.constraints.map(|constraints| geometry_for_constraints(before, after, Geometry { x: child.x, y: child.y, width: child.width, height: child.height, rotation: child.rotation }, constraints, &child.kind).map(|geometry| (child.id, geometry)))
                    }).collect::<Result<Vec<_>, _>>()?
                } else { Vec::new() };
                // Relative-v1 nodes already live in their Frame's local space,
                // including below one or more transformed Groups. Unlike legacy
                // world-space coordinates, their constraints remain correct when
                // the Frame itself is rotated or has an arbitrary affine matrix.
                let mut matrix_constrained_children = if kind == NodeKind::Frame && !frame_has_active_auto_layout {
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
                    self.nodes.values().filter_map(|child| {
                        let constraints = child.constraints?;
                        let (child_to_frame, parent_to_frame) = self.relative_transform_to_frame(child.id, *id)?;
                        let child_before = Geometry {
                            x: child_to_frame.e,
                            y: child_to_frame.f,
                            width: child.width,
                            height: child.height,
                            rotation: child.rotation,
                        };
                        Some(geometry_for_constraints(
                            frame_before_local,
                            frame_after_local,
                            child_before,
                            constraints,
                            &child.kind,
                        ).and_then(|child_after_local| {
                            let child_to_frame_after = AffineTransform {
                                e: child_after_local.x,
                                f: child_after_local.y,
                                ..child_to_frame
                            };
                            let child_after_transform = child_to_frame_after
                                .then(parent_to_frame.inverse().map_err(|_| CommandError::InvalidGeometry)?);
                            let child_after_geometry = geometry_for_relative_transform(
                                child_after_transform,
                                child_after_local.width,
                                child_after_local.height,
                                &child.kind,
                            )?;
                            Ok((child.id, child_after_geometry, child_after_transform))
                        }))
                    }).collect::<Result<Vec<_>, _>>()?
                } else { Vec::new() };
                // Legacy direct Frame children historically store world-space
                // geometry.  Leaving them on that projection when a Frame is
                // rotated or matrix-backed silently made an Inspector-visible
                // constraint a no-op.  At this transaction boundary their
                // current world transform is unambiguous, so migrate it once
                // into the Frame's local Relative-v1 space and apply exactly
                // the same per-axis rule as modern children.  Group paths are
                // intentionally not guessed here: a legacy Group has derived
                // world bounds and must be migrated as a complete subtree.
                if kind == NodeKind::Frame && !frame_has_active_auto_layout && constrained_children.is_empty() {
                    let frame_before_transform = self.node_world_transform(*id)
                        .ok_or(CommandError::InvalidGeometry)?;
                    let frame_inverse = frame_before_transform.inverse()
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
                    let legacy_direct = self.nodes.values().filter_map(|child| {
                        let constraints = child.constraints?;
                        (child.parent_id == Some(*id) && child.relative_transform.is_none())
                            .then_some((child, constraints))
                    }).map(|(child, constraints)| {
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
                    }).collect::<Result<Vec<_>, CommandError>>()?;
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
                    let mut pending = self.nodes.values()
                        .filter(|node| node.parent_id == Some(*id) && node.kind == NodeKind::Group && node.relative_transform.is_none())
                        .map(|node| node.id)
                        .collect::<Vec<_>>();
                    let mut legacy_group_subtree = Vec::new();
                    while let Some(child_id) = pending.pop() {
                        let child = self.nodes.get(&child_id).ok_or(CommandError::MissingNode { id: child_id })?;
                        // A nested Frame/Section/Boolean owns a fresh layout or
                        // structural context. Its legacy descendants are not a
                        // transparent Group chain, so an outer Frame resize must
                        // leave that boundary untouched until its own migration
                        // transaction has an unambiguous local coordinate space.
                        if matches!(child.kind, NodeKind::Frame | NodeKind::Section | NodeKind::BooleanOperation)
                            && self.nodes.values().any(|descendant| descendant.parent_id == Some(child_id))
                        {
                            continue;
                        }
                        let parent_id = child.parent_id.ok_or(CommandError::InvalidGeometry)?;
                        let parent_to_frame = *local_to_frame.get(&parent_id).ok_or(CommandError::InvalidGeometry)?;
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
                        let child_after_local = child.constraints.map(|constraints| {
                            geometry_for_constraints(
                                frame_before_local,
                                frame_after_local,
                                child_before,
                                constraints,
                                &child.kind,
                            )
                        }).transpose()?.unwrap_or(child_before);
                        let child_to_frame_after = AffineTransform {
                            e: child_after_local.x,
                            f: child_after_local.y,
                            ..child_to_frame
                        };
                        let child_after_transform = child_to_frame_after
                            .then(parent_to_frame.inverse().map_err(|_| CommandError::InvalidGeometry)?);
                        local_to_frame.insert(child_id, child_to_frame_after);
                        // A modern leaf below a legacy Group retains its local
                        // matrix unless the Frame resize changed its constrained
                        // Frame-local placement. Legacy links always need their
                        // one-time Relative-v1 conversion.
                        if child.relative_transform.is_none() || child.constraints.is_some() {
                            let child_after_geometry = geometry_for_relative_transform(
                                child_after_transform,
                                child_after_local.width,
                                child_after_local.height,
                                &child.kind,
                            )?;
                            legacy_group_subtree.push((child_id, child_after_geometry, child_after_transform));
                        }
                        if child.kind == NodeKind::Group {
                            pending.extend(self.nodes.values()
                                .filter(|descendant| descendant.parent_id == Some(child_id))
                                .map(|descendant| descendant.id));
                        }
                    }
                    matrix_constrained_children.extend(legacy_group_subtree);
                }
                let parent_id = self.nodes.get(id).and_then(|node| node.parent_id);
                let mut affected_groups = self.group_ancestor_ids([parent_id]);
                if is_structural_container(&kind) {
                    affected_groups.insert(0, *id);
                }
                for group_id in self.group_ancestor_ids(constrained_children.iter().map(|(child_id, _)| self.nodes.get(child_id).and_then(|child| child.parent_id))) {
                    if !affected_groups.contains(&group_id) { affected_groups.push(group_id); }
                }
                for group_id in self.group_ancestor_ids(matrix_constrained_children.iter().map(|(child_id, _, _)| self.nodes.get(child_id).and_then(|child| child.parent_id))) {
                    if !affected_groups.contains(&group_id) { affected_groups.push(group_id); }
                }
                let before_bounds = affected_groups
                    .iter()
                    .filter_map(|group_id| self.geometry_for(*group_id).map(|geometry| (*group_id, geometry)))
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
                    let child = self.nodes.get_mut(&child_id).ok_or(CommandError::MissingNode { id: child_id })?;
                    let child_before = Geometry { x: child.x, y: child.y, width: child.width, height: child.height, rotation: child.rotation };
                    if child_before != child_after {
                        (child.x, child.y, child.width, child.height, child.rotation) = (child_after.x, child_after.y, child_after.width, child_after.height, child_after.rotation);
                        changes.push(AppliedChange::GeometryChanged { id: child_id, before: child_before, after: child_after });
                    }
                }
                for (child_id, child_after_geometry, child_after_transform) in matrix_constrained_children {
                    let child = self.nodes.get_mut(&child_id).ok_or(CommandError::MissingNode { id: child_id })?;
                    let child_before_geometry = Geometry { x: child.x, y: child.y, width: child.width, height: child.height, rotation: child.rotation };
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
                if after.clips_content == Some(true) && node.kind != NodeKind::Frame {
                    return Err(CommandError::InvalidAppearance);
                }
                if !after.corner_radii.is_empty() && !matches!(node.kind, NodeKind::Frame | NodeKind::Rectangle | NodeKind::Section) {
                    return Err(CommandError::InvalidAppearance);
                }
                if after.corner_smoothing != 0.0 && !matches!(node.kind, NodeKind::Frame | NodeKind::Rectangle | NodeKind::Section) {
                    return Err(CommandError::InvalidAppearance);
                }
                if after.constraints.is_some() && matches!(node.kind, NodeKind::Group | NodeKind::BooleanOperation | NodeKind::Section) {
                    return Err(CommandError::InvalidAppearance);
                }
                if !after.stroke_weights.is_empty()
                    && !matches!(node.kind, NodeKind::Frame | NodeKind::Rectangle)
                {
                    return Err(CommandError::InvalidAppearance);
                }
                if after.stroke_align != StrokeAlign::Inside
                    && (!matches!(node.kind, NodeKind::Frame | NodeKind::Rectangle | NodeKind::Ellipse | NodeKind::Polygon | NodeKind::Star)
                        || after.arc_data.is_some())
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
                    && is_structural_container(&node.kind)
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
                node.clips_content = after.clips_content.unwrap_or(node.kind == NodeKind::Frame);
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
            Command::SetVectorPath { id, path } => {
                self.assert_mutable(*id)?;
                self.replace_vector_path(*id, path.clone())
            }
            Command::SetBooleanOperation { id, operation } => {
                self.assert_mutable(*id)?;
                let node = self.nodes.get_mut(id).ok_or(CommandError::MissingNode { id: *id })?;
                if node.kind != NodeKind::BooleanOperation {
                    return Err(CommandError::InvalidGeometry);
                }
                let before = node.boolean_operation.ok_or(CommandError::InvalidGeometry)?;
                node.boolean_operation = Some(*operation);
                Ok(AppliedChange::BooleanOperationChanged { id: *id, before, after: *operation })
            }
            Command::SetMask { id, enabled } => {
                self.assert_mutable(*id)?;
                let (before, before_bytes, after_bytes) = {
                    let node = self.nodes.get(id).ok_or(CommandError::MissingNode { id: *id })?;
                    if is_structural_container(&node.kind)
                        || matches!(node.kind, NodeKind::Section | NodeKind::Slice)
                    {
                        return Err(CommandError::InvalidGeometry);
                    }
                    let before = is_alpha_mask(node);
                    let before_bytes = node.estimated_bytes();
                    let mut after = node.clone();
                    if *enabled {
                        after.extensions.insert(ALPHA_MASK_EXTENSION_KEY.into(), vec![1]);
                    } else {
                        after.extensions.remove(ALPHA_MASK_EXTENSION_KEY);
                    }
                    (before, before_bytes, after.estimated_bytes())
                };
                if *enabled && !self.has_following_sibling(*id) {
                    return Err(CommandError::InvalidGeometry);
                }
                if self.node_bytes.saturating_sub(before_bytes).saturating_add(after_bytes) > MAX_DOCUMENT_BYTES {
                    return Err(CommandError::ResourceLimit);
                }
                self.set_mask(*id, *enabled);
                Ok(AppliedChange::MaskChanged { id: *id, before, after: *enabled })
            }
            Command::MoveVectorPoint { id, point_id, position } => {
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
            Command::SetVectorSubpathClosed { id, subpath_index, closed } => {
                self.assert_mutable(*id)?;
                let mut path = self.vector_path_for_node(*id)?;
                let subpath = path
                    .subpaths
                    .get_mut(*subpath_index as usize)
                    .ok_or(CommandError::InvalidGeometry)?;
                subpath.closed = *closed;
                self.replace_vector_path(*id, path)
            }
            Command::InsertVectorPoint { id, subpath_index, after_point_id, point } => {
                self.assert_mutable(*id)?;
                let mut path = self.vector_path_for_node(*id)?;
                if path.subpaths.iter().flat_map(|subpath| &subpath.points).any(|candidate| candidate.id == point.id) {
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
            Command::SplitVectorSegment { id, subpath_index, after_point_id, t, point_id } => {
                self.assert_mutable(*id)?;
                if !t.is_finite() || *t <= 0.0 || *t >= 1.0 { return Err(CommandError::InvalidGeometry); }
                let mut path = self.vector_path_for_node(*id)?;
                if path.subpaths.iter().flat_map(|subpath| &subpath.points).any(|candidate| candidate.id == *point_id) {
                    return Err(CommandError::InvalidGeometry);
                }
                let subpath = path.subpaths.get_mut(*subpath_index as usize).ok_or(CommandError::InvalidGeometry)?;
                let after_index = subpath.points.iter().position(|candidate| candidate.id == *after_point_id).ok_or(CommandError::InvalidGeometry)?;
                let next_index = if after_index + 1 < subpath.points.len() { after_index + 1 } else if subpath.closed { 0 } else { return Err(CommandError::InvalidGeometry); };
                let from = subpath.points[after_index].clone();
                let to = subpath.points[next_index].clone();
                let control_from = from.handle_out.map(|handle| Point { x: from.position.x + handle.x, y: from.position.y + handle.y }).unwrap_or(from.position);
                let control_to = to.handle_in.map(|handle| Point { x: to.position.x + handle.x, y: to.position.y + handle.y }).unwrap_or(to.position);
                let interpolate = |left: Point, right: Point| Point { x: left.x + (right.x - left.x) * *t, y: left.y + (right.y - left.y) * *t };
                let first = interpolate(from.position, control_from);
                let second = interpolate(control_from, control_to);
                let third = interpolate(control_to, to.position);
                let fourth = interpolate(first, second);
                let fifth = interpolate(second, third);
                let position = interpolate(fourth, fifth);
                let curved = from.handle_out.is_some() || to.handle_in.is_some();
                subpath.points[after_index].handle_out = curved.then_some(Point { x: first.x - from.position.x, y: first.y - from.position.y });
                subpath.points[next_index].handle_in = curved.then_some(Point { x: third.x - to.position.x, y: third.y - to.position.y });
                subpath.points.insert(after_index + 1, VectorPoint {
                    id: *point_id,
                    position,
                    handle_in: curved.then_some(Point { x: fourth.x - position.x, y: fourth.y - position.y }),
                    handle_out: curved.then_some(Point { x: fifth.x - position.x, y: fifth.y - position.y }),
                    point_type: if curved { VectorPointType::Asymmetric } else { VectorPointType::Corner },
                });
                self.replace_vector_path(*id, path)
            }
            Command::ConnectVectorEndpoints { id, first_subpath_index, first_point_id, second_subpath_index, second_point_id } => {
                self.assert_mutable(*id)?;
                let mut path = self.vector_path_for_node(*id)?;
                let first_index = *first_subpath_index as usize;
                let second_index = *second_subpath_index as usize;
                let first = path.subpaths.get(first_index).ok_or(CommandError::InvalidGeometry)?;
                let second = path.subpaths.get(second_index).ok_or(CommandError::InvalidGeometry)?;
                let endpoint = |subpath: &VectorSubpath, point_id: PointId| {
                    if subpath.closed || subpath.points.is_empty() { return None; }
                    if subpath.points.first().is_some_and(|point| point.id == point_id) { Some(true) }
                    else if subpath.points.last().is_some_and(|point| point.id == point_id) { Some(false) }
                    else { None }
                };
                let first_at_start = endpoint(first, *first_point_id).ok_or(CommandError::InvalidGeometry)?;
                let second_at_start = endpoint(second, *second_point_id).ok_or(CommandError::InvalidGeometry)?;
                if first_index == second_index {
                    if first_point_id == second_point_id || first_at_start == second_at_start || first.points.len() < 3 {
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
                if first_at_start { reverse(&mut first); }
                if !second_at_start { reverse(&mut second); }
                if first.points.last().is_some_and(|left| second.points.first().is_some_and(|right| left.position == right.position)) {
                    let joined = second.points.remove(0);
                    let last = first.points.last_mut().ok_or(CommandError::InvalidGeometry)?;
                    last.handle_out = joined.handle_out;
                    last.point_type = if last.handle_in.is_some() || last.handle_out.is_some() { VectorPointType::Asymmetric } else { VectorPointType::Corner };
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
                    .find(|subpath| subpath.points.iter().any(|candidate| candidate.id == *point_id))
                    .ok_or(CommandError::InvalidGeometry)?;
                if subpath.points.len() <= if subpath.closed { 3 } else { 1 } {
                    return Err(CommandError::InvalidGeometry);
                }
                let point_index = subpath.points.iter().position(|candidate| candidate.id == *point_id)
                    .ok_or(CommandError::InvalidGeometry)?;
                subpath.points.remove(point_index);
                self.replace_vector_path(*id, path)
            }
            Command::SetVectorPointHandles { id, point_id, handle_in, handle_out, point_type } => {
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
                    (next != TextProperties::default()).then_some(next)
                });
                let node = self
                    .nodes
                    .get_mut(id)
                    .ok_or(CommandError::MissingNode { id: *id })?;
                if node.kind != NodeKind::Text {
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
                if node.kind != NodeKind::Text
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
                let node = self.nodes.get(id).ok_or(CommandError::MissingNode { id: *id })?;
                if !valid_auto_layout(layout) || (layout.mode != LayoutMode::None && node.kind != NodeKind::Frame) {
                    return Err(CommandError::InvalidAutoLayout);
                }
                let before = self.node_auto_layout.get(id).cloned();
                let after = (layout != &AutoLayout::default()).then_some(layout.clone());
                match &after {
                    Some(layout) => { self.node_auto_layout.insert(*id, layout.clone()); }
                    None => { self.node_auto_layout.remove(id); }
                }
                Ok(AppliedChange::AutoLayoutChanged { id: *id, before, after })
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
                if *position != before
                    && self
                        .sibling_positions
                        .contains(&(page_id, parent_id, *position))
                {
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
                self.sibling_positions.remove(&(page_id, parent_id, before));
                self.sibling_positions
                    .insert((page_id, parent_id, *position));
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
                let node = self.nodes.get(id).ok_or(CommandError::MissingNode { id: *id })?;
                let page_id = self.node_pages.get(id).copied().unwrap_or(DEFAULT_PAGE_ID);
                let before_parent_id = node.parent_id;
                let before_position = node.position;
                if *parent_id == Some(*id) {
                    return Err(CommandError::InvalidParent { id: *id });
                }
                if let Some(next_parent_id) = parent_id {
                    let parent = self
                        .nodes
                        .get(next_parent_id)
                        .ok_or(CommandError::MissingParent { id: *next_parent_id })?;
                    if self.is_effectively_locked(*next_parent_id) {
                        return Err(CommandError::EffectivelyLocked {
                            id: *next_parent_id,
                        });
                    }
                    if self.node_pages.get(next_parent_id).copied().unwrap_or(DEFAULT_PAGE_ID) != page_id
                        || !can_contain_children(&parent.kind)
                    {
                        return Err(CommandError::InvalidParent { id: *next_parent_id });
                    }
                    let mut ancestor = parent.parent_id;
                    while let Some(ancestor_id) = ancestor {
                        if ancestor_id == *id {
                            return Err(CommandError::InvalidParent { id: *next_parent_id });
                        }
                        ancestor = self.nodes.get(&ancestor_id).and_then(|candidate| candidate.parent_id);
                    }
                }
                if (*parent_id != before_parent_id || *position != before_position)
                    && self.sibling_positions.contains(&(page_id, *parent_id, *position))
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
                self.sibling_positions
                    .remove(&(page_id, before_parent_id, before_position));
                self.sibling_positions.insert((page_id, *parent_id, *position));
                let node = self.nodes.get_mut(id).ok_or(CommandError::MissingNode { id: *id })?;
                node.parent_id = *parent_id;
                node.position = *position;
                self.refresh_group_bounds(before_parent_id);
                self.refresh_group_bounds(*parent_id);
                let dissolved_groups = self.dissolve_empty_groups_from(before_parent_id);
                let mut changes = vec![AppliedChange::NodeParentChanged {
                    id: *id,
                    before_parent_id,
                    before_position,
                    after_parent_id: *parent_id,
                    after_position: *position,
                }];
                changes.extend(before_bounds.into_iter().filter_map(|(id, before)| {
                    let after = self.geometry_for(id)?;
                    (before != after).then_some(AppliedChange::GeometryChanged { id, before, after })
                }));
                changes.extend(
                    dissolved_groups
                        .into_iter()
                        .map(|node| AppliedChange::NodeDeleted { node }),
                );
                Ok(if changes.len() == 1 { changes.remove(0) } else { AppliedChange::Composite { changes } })
            }
            Command::Delete { id } => {
                self.assert_mutable(*id)?;
                if self.nodes.values().any(|node| node.parent_id == Some(*id)) {
                    return Err(CommandError::NodeHasChildren { id: *id });
                }
                let node = self.nodes.get(id).cloned().ok_or(CommandError::MissingNode { id: *id })?;
                let affected_groups = self.group_ancestor_ids([node.parent_id]);
                let before_bounds = affected_groups
                    .iter()
                    .filter_map(|group_id| self.geometry_for(*group_id).map(|geometry| (*group_id, geometry)))
                    .collect::<Vec<_>>();
                self.nodes.remove(id);
                self.node_bytes = self.node_bytes.saturating_sub(node.estimated_bytes());
                if let Some(properties) = self.node_text_properties.remove(id) {
                    self.node_bytes = self.node_bytes.saturating_sub(properties.estimated_bytes());
                    self.retired_node_text_properties.insert(*id, properties);
                }
                let page_id = self.node_pages.remove(id).unwrap_or(DEFAULT_PAGE_ID);
                self.sibling_positions
                    .remove(&(page_id, node.parent_id, node.position));
                self.retired_node_pages.insert(*id, page_id);
                if let Some(asset_id) = self.node_assets.remove(id) {
                    self.retired_node_assets.insert(*id, asset_id);
                }
                self.retired_ids.insert(*id);
                self.refresh_group_bounds(node.parent_id);
                let dissolved_groups = self.dissolve_empty_groups_from(node.parent_id);
                let mut changes = vec![AppliedChange::NodeDeleted { node }];
                changes.extend(before_bounds.into_iter().filter_map(|(group_id, before)| {
                    let after = self.geometry_for(group_id)?;
                    (before != after).then_some(AppliedChange::GeometryChanged {
                        id: group_id,
                        before,
                        after,
                    })
                }));
                changes.extend(
                    dissolved_groups
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
            AppliedChange::AutoLayoutChanged { id, before, .. } => {
                self.replace_auto_layout_option(*id, before.clone());
            }
            AppliedChange::VectorPathChanged { id, before, .. } => self.set_vector_path(*id, before),
            AppliedChange::BooleanOperationChanged { id, before, .. } => {
                if let Some(node) = self.nodes.get_mut(id) { node.boolean_operation = Some(*before); }
            }
            AppliedChange::MaskChanged { id, before, .. } => self.set_mask(*id, *before),
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
            AppliedChange::AutoLayoutChanged { id, after, .. } => {
                self.replace_auto_layout_option(*id, after.clone());
            }
            AppliedChange::VectorPathChanged { id, after, .. } => self.set_vector_path(*id, after),
            AppliedChange::BooleanOperationChanged { id, after, .. } => {
                if let Some(node) = self.nodes.get_mut(id) { node.boolean_operation = Some(*after); }
            }
            AppliedChange::MaskChanged { id, after, .. } => self.set_mask(*id, *after),
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
            node.clips_content = appearance.clips_content.unwrap_or(node.kind == NodeKind::Frame);
            self.node_bytes = self
                .node_bytes
                .saturating_sub(before_bytes)
                .saturating_add(after_bytes);
        }
    }

    fn replace_auto_layout_option(&mut self, id: NodeId, layout: Option<AutoLayout>) {
        match layout {
            Some(layout) => { self.node_auto_layout.insert(id, layout); }
            None => { self.node_auto_layout.remove(&id); }
        }
    }

    /// The dirty set follows touched nodes only through their ancestor chain;
    /// it never defaults to an all-page layout scan.
    fn auto_layout_dirty_frames(&self, commands: &[Command], before_transaction: &Document) -> Vec<NodeId> {
        let mut touched = BTreeSet::new();
        for command in commands {
            match command {
                Command::Create(node) => { touched.insert(node.id); }
                Command::CreateInPage { node, .. } | Command::CreateImageInPage { node, .. } | Command::RestoreNode { node, .. } => { touched.insert(node.id); }
                Command::UpdateGeometry { id, .. } | Command::Rename { id, .. } | Command::SetAppearance { id, .. }
                | Command::SetVectorPath { id, .. } | Command::SetBooleanOperation { id, .. } | Command::SetMask { id, .. }
                | Command::MoveVectorPoint { id, .. } | Command::SetVectorSubpathClosed { id, .. }
                | Command::InsertVectorPoint { id, .. } | Command::SplitVectorSegment { id, .. } | Command::ConnectVectorEndpoints { id, .. }
                | Command::DeleteVectorPoint { id, .. } | Command::SetVectorPointHandles { id, .. }
                | Command::SetNodeAsset { id, .. } | Command::SetText { id, .. } | Command::SetTextProperties { id, .. }
                | Command::SetAutoLayout { id, .. } | Command::SetNodePosition { id, .. } | Command::SetNodeParent { id, .. }
                | Command::Delete { id } => { touched.insert(*id); }
                Command::CreatePage(_) | Command::SetDocumentColorProfile { .. } | Command::RegisterAsset { .. } => {}
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
                    if !visited.insert(id) { break; }
                    let Some(node) = document.nodes.get(&id) else { break; };
                    if self.nodes.get(&id).is_some_and(|current_node| current_node.kind == NodeKind::Frame)
                        && self.auto_layout_for_node(id).mode != LayoutMode::None {
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
                    || candidate.kind != NodeKind::Frame
                    || self.auto_layout_for_node(candidate.id).mode == LayoutMode::None
                {
                    continue;
                }
                let mut current = candidate.parent_id;
                let mut visited = BTreeSet::new();
                while let Some(parent_id) = current {
                    if !visited.insert(parent_id) { break; }
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
            if !visited.insert(id) { return usize::MAX; }
            current = self.nodes.get(&id).and_then(|node| node.parent_id);
            if current.is_some() { depth += 1; }
        }
        depth
    }

    /// The layout engine cannot rely on a browser FontFace being present during
    /// snapshot replay. This deliberately small metric model keeps Auto Layout
    /// deterministic across Core, service and WASM while the canvas may refine
    /// glyph painting with an available font.
    fn auto_layout_text_size(&self, node: &Node) -> (f64, f64) {
        let properties = self.node_text_properties.get(&node.id);
        let line_height = properties
            .and_then(|value| value.paragraph.line_height)
            .unwrap_or(20.0);
        let paragraph_spacing = properties.map(|value| value.paragraph.paragraph_spacing).unwrap_or(0.0);
        let runs = properties.map(|value| value.runs.as_slice()).unwrap_or(&[]);
        // Height-auto text keeps its authored width. Measure its soft wraps in
        // Core as well, so snapshot replay does not depend on a browser font
        // layout pass to decide an Auto Layout row's height.
        let wrap_width = properties
            .filter(|value| value.auto_size == TextAutoSize::Height)
            .map(|_| node.width)
            .filter(|width| width.is_finite() && *width > 0.0);
        let mut line_width = 0.0_f64;
        let mut widest = 0.0_f64;
        let mut lines = 1usize;
        let mut paragraph_breaks = 0usize;
        let mut glyphs_on_line = 0usize;
        for (offset, grapheme) in node.text.grapheme_indices(true) {
            if matches!(grapheme, "\n" | "\r" | "\r\n" | "\u{2028}" | "\u{2029}") {
                // CRLF is one grapheme and one paragraph boundary, matching
                // DOM editing/export semantics without splitting source bytes.
                widest = widest.max(line_width);
                line_width = 0.0;
                glyphs_on_line = 0;
                lines += 1;
                paragraph_breaks += 1;
                continue;
            }
            let run = runs.iter().find(|run| (run.start as usize) <= offset && offset < run.end as usize);
            let font_size = run.map(|run| run.font_size).unwrap_or(31.0);
            let letter_spacing = run.map(|run| run.letter_spacing).unwrap_or(0.0);
            // A fallback advance is attributed to one legal editing grapheme,
            // so combining marks and Emoji ZWJ sequences cannot manufacture
            // soft-wrap lines that the text editor cannot address.
            let advance = font_size * 0.6;
            let spacing = (glyphs_on_line > 0).then_some(letter_spacing).unwrap_or(0.0);
            if glyphs_on_line > 0 && wrap_width.is_some_and(|width| line_width + spacing + advance > width) {
                widest = widest.max(line_width);
                line_width = 0.0;
                glyphs_on_line = 0;
                lines += 1;
            }
            if glyphs_on_line > 0 { line_width += letter_spacing; }
            line_width += advance;
            glyphs_on_line += 1;
        }
        widest = widest.max(line_width);
        (
            normalize_layout_number(widest.max(1.0)),
            normalize_layout_number((lines as f64 * line_height + paragraph_breaks as f64 * paragraph_spacing).max(1.0)),
        )
    }

    fn reflow_auto_layout(&mut self, dirty_frames: Vec<NodeId>) -> Result<Vec<AppliedChange>, CommandError> {
        const MAX_LAYOUT_NODES: usize = 10_000;
        const MAX_LAYOUT_ITERATIONS: usize = 32;
        let mut changes = Vec::new();
        let mut visited_nodes = 0usize;
        for _iteration in 0..MAX_LAYOUT_ITERATIONS {
            let changes_before_iteration = changes.len();
            for frame_id in dirty_frames.iter().copied() {
            let layout = self.auto_layout_for_node(frame_id);
            if layout.mode == LayoutMode::None { continue; }
            let frame = self.nodes.get(&frame_id).cloned().ok_or(CommandError::MissingNode { id: frame_id })?;
            if frame.kind != NodeKind::Frame || frame.relative_transform.is_some() { return Err(CommandError::AutoLayoutUnsupported); }
            let mut children = self.nodes.values()
                .filter(|node| node.parent_id == Some(frame_id))
                .cloned().collect::<Vec<_>>();
            children.sort_unstable_by_key(|node| (node.position, node.id));
            visited_nodes = visited_nodes.saturating_add(children.len());
            if visited_nodes > MAX_LAYOUT_NODES { return Err(CommandError::AutoLayoutLimit); }
            let flow = children.into_iter().filter(|node| !self.auto_layout_for_node(node.id).absolute).collect::<Vec<_>>();
            if flow.iter().any(|node| node.relative_transform.is_some()) { return Err(CommandError::AutoLayoutUnsupported); }
            let horizontal = layout.mode == LayoutMode::Horizontal;
            if flow.iter().any(|node| {
                let child = self.auto_layout_for_node(node.id);
                let (primary_sizing, counter_sizing) = self.auto_layout_child_sizing(node, horizontal);
                let text_auto_size = self.node_text_properties.get(&node.id).map(|properties| properties.auto_size);
                let text_supports_primary_hug = node.kind == NodeKind::Text
                    && (matches!(text_auto_size, Some(TextAutoSize::WidthAndHeight))
                        || (!horizontal && matches!(text_auto_size, Some(TextAutoSize::Height))));
                let text_supports_counter_hug = node.kind == NodeKind::Text
                    && (matches!(text_auto_size, Some(TextAutoSize::WidthAndHeight))
                        || (horizontal && matches!(text_auto_size, Some(TextAutoSize::Height))));
                (primary_sizing == LayoutSizing::Hug
                    && node.kind != NodeKind::Frame
                    && !text_supports_primary_hug)
                    || (counter_sizing == LayoutSizing::Hug
                        && node.kind != NodeKind::Frame
                        && !text_supports_counter_hug)
                    || child.wrap
            }) { return Err(CommandError::AutoLayoutUnsupported); }
            let [top, right, bottom, left] = layout.padding;
            let intrinsic_primary = flow.iter().map(|node| {
                let (primary_sizing, _) = self.auto_layout_child_sizing(node, horizontal);
                let (text_width, text_height) = (node.kind == NodeKind::Text).then(|| self.auto_layout_text_size(node)).unwrap_or((node.width, node.height));
                if primary_sizing == LayoutSizing::Hug {
                    if horizontal { text_width } else { text_height }
                } else if horizontal { node.width } else { node.height }
            }).sum::<f64>()
                + layout.item_spacing * flow.len().saturating_sub(1) as f64;
            let intrinsic_counter = flow.iter().map(|node| {
                let (_, counter_sizing) = self.auto_layout_child_sizing(node, horizontal);
                let (text_width, text_height) = (node.kind == NodeKind::Text).then(|| self.auto_layout_text_size(node)).unwrap_or((node.width, node.height));
                if counter_sizing == LayoutSizing::Hug {
                    if horizontal { text_height } else { text_width }
                } else if horizontal { node.height } else { node.width }
            }).fold(0.0, f64::max);
            let clamp_size = |value: f64, min: Option<f64>, max: Option<f64>| {
                max.map(|limit| value.min(limit)).unwrap_or(value).max(min.unwrap_or(0.0))
            };
            let (candidate_width, candidate_height) = if horizontal {
                (
                    clamp_size(if layout.primary_sizing == LayoutSizing::Hug { left + intrinsic_primary + right } else { frame.width }, layout.min_width, layout.max_width),
                    clamp_size(if layout.counter_sizing == LayoutSizing::Hug { top + intrinsic_counter + bottom } else { frame.height }, layout.min_height, layout.max_height),
                )
            } else {
                (
                    clamp_size(if layout.counter_sizing == LayoutSizing::Hug { left + intrinsic_counter + right } else { frame.width }, layout.min_width, layout.max_width),
                    clamp_size(if layout.primary_sizing == LayoutSizing::Hug { top + intrinsic_primary + bottom } else { frame.height }, layout.min_height, layout.max_height),
                )
            };
            if frame.width != candidate_width || frame.height != candidate_height {
                let before = Geometry { x: frame.x, y: frame.y, width: frame.width, height: frame.height, rotation: frame.rotation };
                let after = Geometry { x: frame.x, y: frame.y, width: normalize_layout_number(candidate_width), height: normalize_layout_number(candidate_height), rotation: frame.rotation };
                let node = self.nodes.get_mut(&frame_id).expect("layout frame exists");
                (node.width, node.height) = (after.width, after.height);
                changes.push(AppliedChange::GeometryChanged { id: frame_id, before, after });
            }
            let frame = self.nodes.get(&frame_id).cloned().expect("layout frame exists");
            let primary_extent = if horizontal { frame.width - left - right } else { frame.height - top - bottom };
            let counter_extent = if horizontal { frame.height - top - bottom } else { frame.width - left - right };
            if primary_extent < 0.0 || counter_extent < 0.0 { return Err(CommandError::InvalidAutoLayout); }
            if layout.wrap {
                if layout.primary_sizing != LayoutSizing::Fixed || layout.counter_sizing != LayoutSizing::Fixed
                    || flow.iter().any(|child| {
                        let (primary_sizing, counter_sizing) = self.auto_layout_child_sizing(child, horizontal);
                        primary_sizing != LayoutSizing::Fixed || counter_sizing != LayoutSizing::Fixed
                    }) {
                    return Err(CommandError::AutoLayoutUnsupported);
                }
                let mut lines = Vec::<Vec<(Node, f64, f64)>>::new();
                let mut line_primary = 0.0;
                for child in flow {
                    let child_layout = self.auto_layout_for_node(child.id);
                    let (primary_min, primary_max, counter_min, counter_max) = if horizontal {
                        (child_layout.min_width, child_layout.max_width, child_layout.min_height, child_layout.max_height)
                    } else {
                        (child_layout.min_height, child_layout.max_height, child_layout.min_width, child_layout.max_width)
                    };
                    let primary = clamp_size(if horizontal { child.width } else { child.height }, primary_min, primary_max);
                    let counter = clamp_size(if horizontal { child.height } else { child.width }, counter_min, counter_max);
                    let next_primary = if lines.last().is_some_and(|line| !line.is_empty()) {
                        line_primary + layout.item_spacing + primary
                    } else { primary };
                    if next_primary > primary_extent && lines.last().is_some_and(|line| !line.is_empty()) {
                        lines.push(Vec::new());
                        line_primary = 0.0;
                    }
                    if lines.is_empty() { lines.push(Vec::new()); }
                    let line = lines.last_mut().expect("wrap line exists");
                    line_primary = if line.is_empty() { primary } else { line_primary + layout.item_spacing + primary };
                    line.push((child, primary, counter));
                }
                let mut counter_cursor = 0.0;
                for (line_index, line) in lines.iter().enumerate() {
                    let content_primary = line.iter().map(|(_, primary, _)| *primary).sum::<f64>();
                    let regular_spacing = layout.item_spacing * line.len().saturating_sub(1) as f64;
                    let (mut primary_cursor, spacing) = match layout.primary_alignment {
                        LayoutAlignment::Start => (0.0, layout.item_spacing),
                        LayoutAlignment::Center => (((primary_extent - content_primary - regular_spacing).max(0.0)) / 2.0, layout.item_spacing),
                        LayoutAlignment::End => ((primary_extent - content_primary - regular_spacing).max(0.0), layout.item_spacing),
                        LayoutAlignment::SpaceBetween if line.len() > 1 => (0.0, ((primary_extent - content_primary).max(0.0)) / (line.len() - 1) as f64),
                        LayoutAlignment::SpaceBetween => (0.0, 0.0),
                    };
                    let line_counter = line.iter().map(|(_, _, counter)| *counter).fold(0.0, f64::max);
                    for (child, primary, counter) in line {
                        let counter_offset = match layout.counter_alignment {
                            LayoutAlignment::Start | LayoutAlignment::SpaceBetween => 0.0,
                            LayoutAlignment::Center => ((line_counter - *counter).max(0.0)) / 2.0,
                            LayoutAlignment::End => (line_counter - *counter).max(0.0),
                        };
                        let (x, y) = if horizontal {
                            (frame.x + left + primary_cursor, frame.y + top + counter_cursor + counter_offset)
                        } else {
                            (frame.x + left + counter_cursor + counter_offset, frame.y + top + primary_cursor)
                        };
                        primary_cursor += *primary + spacing;
                        let after = Geometry {
                            x: normalize_layout_number(x), y: normalize_layout_number(y),
                            width: normalize_layout_number(if horizontal { *primary } else { *counter }),
                            height: normalize_layout_number(if horizontal { *counter } else { *primary }),
                            rotation: child.rotation,
                        };
                        let before = Geometry { x: child.x, y: child.y, width: child.width, height: child.height, rotation: child.rotation };
                        if before != after {
                            let node = self.nodes.get_mut(&child.id).expect("layout child exists");
                            (node.x, node.y, node.width, node.height) = (after.x, after.y, after.width, after.height);
                            changes.push(AppliedChange::GeometryChanged { id: child.id, before, after });
                        }
                    }
                    counter_cursor += line_counter;
                    if line_index + 1 < lines.len() { counter_cursor += layout.item_spacing; }
                }
                continue;
            }
            let regular_spacing = layout.item_spacing * flow.len().saturating_sub(1) as f64;
            let mut sized = flow.into_iter().map(|child| {
                let child_layout = self.auto_layout_for_node(child.id);
                let (primary_sizing, counter_sizing) = self.auto_layout_child_sizing(&child, horizontal);
                let (text_width, text_height) = (child.kind == NodeKind::Text).then(|| self.auto_layout_text_size(&child)).unwrap_or((child.width, child.height));
                let (primary_min, primary_max, counter_min, counter_max) = if horizontal {
                    (child_layout.min_width, child_layout.max_width, child_layout.min_height, child_layout.max_height)
                } else {
                    (child_layout.min_height, child_layout.max_height, child_layout.min_width, child_layout.max_width)
                };
                let primary = if primary_sizing == LayoutSizing::Fill {
                    primary_min.unwrap_or(0.0)
                } else if primary_sizing == LayoutSizing::Hug {
                    clamp_size(if horizontal { text_width } else { text_height }, primary_min, primary_max)
                } else {
                    clamp_size(if horizontal { child.width } else { child.height }, primary_min, primary_max)
                };
                let counter = if counter_sizing == LayoutSizing::Fill {
                    if counter_min.is_some_and(|minimum| minimum > counter_extent) {
                        return Err(CommandError::InvalidAutoLayout);
                    }
                    clamp_size(counter_extent, counter_min, counter_max)
                } else if counter_sizing == LayoutSizing::Hug {
                    clamp_size(if horizontal { text_height } else { text_width }, counter_min, counter_max)
                } else {
                    clamp_size(if horizontal { child.height } else { child.width }, counter_min, counter_max)
                };
                Ok((child, primary_sizing, primary, counter, primary_max))
            }).collect::<Result<Vec<_>, CommandError>>()?;
            let fixed_content_extent = sized.iter()
                .filter(|(_, primary_sizing, _, _, _)| *primary_sizing != LayoutSizing::Fill)
                .map(|(_, _, primary, _, _)| *primary)
                .sum::<f64>();
            let fill_indices = sized.iter().enumerate()
                .filter_map(|(index, (_, primary_sizing, _, _, _))| (*primary_sizing == LayoutSizing::Fill).then_some(index))
                .collect::<Vec<_>>();
            let available_fill_extent = primary_extent - fixed_content_extent - regular_spacing;
            let minimum_fill_extent = fill_indices.iter().map(|index| sized[*index].2).sum::<f64>();
            if !fill_indices.is_empty() && minimum_fill_extent > available_fill_extent + 1e-6 {
                return Err(CommandError::InvalidAutoLayout);
            }
            let mut remaining_fill_extent = (available_fill_extent - minimum_fill_extent).max(0.0);
            let mut active_fill_indices = fill_indices;
            while remaining_fill_extent > 1e-6 && !active_fill_indices.is_empty() {
                let share = remaining_fill_extent / active_fill_indices.len() as f64;
                let constrained = active_fill_indices.iter().copied()
                    .filter(|index| sized[*index].4.is_some_and(|maximum| maximum - sized[*index].2 < share))
                    .collect::<Vec<_>>();
                if constrained.is_empty() {
                    for index in active_fill_indices { sized[index].2 += share; }
                    break;
                }
                for index in constrained {
                    let maximum = sized[index].4.expect("constrained fill has a maximum");
                    remaining_fill_extent -= maximum - sized[index].2;
                    sized[index].2 = maximum;
                }
                active_fill_indices.retain(|index| !sized[*index].4.is_some_and(|maximum| (maximum - sized[*index].2).abs() <= 1e-6));
            }
            let content_extent = sized.iter().map(|(_, _, primary, _, _)| *primary).sum::<f64>();
            let (start_offset, spacing) = match layout.primary_alignment {
                LayoutAlignment::Start => (0.0, layout.item_spacing),
                LayoutAlignment::Center => (((primary_extent - content_extent - regular_spacing).max(0.0)) / 2.0, layout.item_spacing),
                LayoutAlignment::End => ((primary_extent - content_extent - regular_spacing).max(0.0), layout.item_spacing),
                LayoutAlignment::SpaceBetween if sized.len() > 1 => (0.0, ((primary_extent - content_extent).max(0.0)) / (sized.len() - 1) as f64),
                LayoutAlignment::SpaceBetween => (0.0, 0.0),
            };
            let mut cursor = start_offset;
            for (child, _primary_sizing, primary, counter, _) in sized {
                let counter_offset = match layout.counter_alignment {
                    LayoutAlignment::Start | LayoutAlignment::SpaceBetween => 0.0,
                    LayoutAlignment::Center => ((counter_extent - counter).max(0.0)) / 2.0,
                    LayoutAlignment::End => (counter_extent - counter).max(0.0),
                };
                let (x, y) = if horizontal { (frame.x + left + cursor, frame.y + top + counter_offset) } else { (frame.x + left + counter_offset, frame.y + top + cursor) };
                cursor += primary + spacing;
                let after = Geometry {
                    x: normalize_layout_number(x),
                    y: normalize_layout_number(y),
                    width: normalize_layout_number(if horizontal { primary } else { counter }),
                    height: normalize_layout_number(if horizontal { counter } else { primary }),
                    rotation: child.rotation,
                };
                let before = Geometry { x: child.x, y: child.y, width: child.width, height: child.height, rotation: child.rotation };
                if before != after {
                    let node = self.nodes.get_mut(&child.id).expect("layout child exists");
                    (node.x, node.y, node.width, node.height) = (after.x, after.y, after.width, after.height);
                    changes.push(AppliedChange::GeometryChanged { id: child.id, before, after });
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
        let Some(node) = self.nodes.get(&id) else { return false; };
        let page_id = self.node_pages.get(&id).copied().unwrap_or(DEFAULT_PAGE_ID);
        self.nodes.values().any(|candidate| {
            candidate.id != id
                && self.node_pages.get(&candidate.id).copied().unwrap_or(DEFAULT_PAGE_ID) == page_id
                && candidate.parent_id == node.parent_id
                && candidate.position > node.position
        })
    }

    fn set_mask(&mut self, id: NodeId, enabled: bool) {
        let Some((before_bytes, after_bytes)) = self.nodes.get_mut(&id).map(|node| {
            let before_bytes = node.estimated_bytes();
            if enabled {
                node.extensions.insert(ALPHA_MASK_EXTENSION_KEY.into(), vec![1]);
            } else {
                node.extensions.remove(ALPHA_MASK_EXTENSION_KEY);
            }
            (before_bytes, node.estimated_bytes())
        }) else { return; };
        self.node_bytes = self.node_bytes.saturating_sub(before_bytes).saturating_add(after_bytes);
    }

    fn set_vector_path(&mut self, id: NodeId, path: &VectorPath) {
        if let Some(node) = self.nodes.get_mut(&id) {
            let before_bytes = node.estimated_bytes();
            let after_bytes = before_bytes
                .saturating_sub(node.vector_path.as_ref().map(VectorPath::estimated_bytes).unwrap_or(0))
                .saturating_add(path.estimated_bytes());
            node.vector_path = Some(path.clone());
            self.node_bytes = self.node_bytes.saturating_sub(before_bytes).saturating_add(after_bytes);
        }
    }

    fn vector_path_for_node(&self, id: NodeId) -> Result<VectorPath, CommandError> {
        let node = self.nodes.get(&id).ok_or(CommandError::MissingNode { id })?;
        if node.kind != NodeKind::Vector {
            return Err(CommandError::InvalidGeometry);
        }
        node.vector_path.clone().ok_or(CommandError::InvalidGeometry)
    }

    fn replace_vector_path(&mut self, id: NodeId, path: VectorPath) -> Result<AppliedChange, CommandError> {
        if !valid_vector_path(&path) {
            return Err(CommandError::InvalidGeometry);
        }
        let node = self.nodes.get_mut(&id).ok_or(CommandError::MissingNode { id })?;
        if node.kind != NodeKind::Vector {
            return Err(CommandError::InvalidGeometry);
        }
        let before_bytes = node.estimated_bytes();
        let after_bytes = before_bytes
            .saturating_sub(node.vector_path.as_ref().map(VectorPath::estimated_bytes).unwrap_or(0))
            .saturating_add(path.estimated_bytes());
        if self.node_bytes.saturating_sub(before_bytes).saturating_add(after_bytes) > MAX_DOCUMENT_BYTES {
            return Err(CommandError::ResourceLimit);
        }
        let before = std::mem::replace(&mut node.vector_path, Some(path.clone()))
            .ok_or(CommandError::InvalidGeometry)?;
        self.node_bytes = self.node_bytes.saturating_sub(before_bytes).saturating_add(after_bytes);
        Ok(AppliedChange::VectorPathChanged { id, before, after: path })
    }

    fn set_node_position(&mut self, id: NodeId, position: PositionId) {
        if let Some(node) = self.nodes.get(&id) {
            let page_id = self.node_pages.get(&id).copied().unwrap_or(DEFAULT_PAGE_ID);
            self.sibling_positions
                .remove(&(page_id, node.parent_id, node.position));
            self.sibling_positions
                .insert((page_id, node.parent_id, position));
        }
        if let Some(node) = self.nodes.get_mut(&id) {
            node.position = position;
        }
    }

    fn set_node_parent(&mut self, id: NodeId, parent_id: Option<NodeId>, position: PositionId) {
        if let Some(node) = self.nodes.get(&id) {
            let page_id = self.node_pages.get(&id).copied().unwrap_or(DEFAULT_PAGE_ID);
            self.sibling_positions
                .remove(&(page_id, node.parent_id, node.position));
            self.sibling_positions.insert((page_id, parent_id, position));
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
                let Some(node) = self.nodes.get(&current) else { break };
                if is_structural_container(&node.kind) && !ids.contains(&current) {
                    ids.push(current);
                }
                let Some(parent_id) = node.parent_id else { break };
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
            let Some(group) = self.nodes.get(&id).cloned() else { break };
            if !is_structural_container(&group.kind) { break; }
            // A Relative-v1 Group has already been normalized by the shared
            // matrix resolver before its complete batch crosses into Core.
            // Recomputing it from world AABBs here would overwrite its local
            // transform and move every relative child a second time. Legacy
            // Groups continue through the historical path during migration.
            if group.relative_transform.is_some() {
                group_id = group.parent_id;
                continue;
            }
            let children = self
                .nodes
                .values()
                .filter(|node| node.parent_id == Some(id))
                .map(|node| node.id)
                .collect::<Vec<_>>();
            if children.is_empty() { break; }
            let bounds = children.into_iter().filter_map(|child_id| self.node_world_visual_bounds(child_id)).reduce(|left, right| Bounds {
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
        if !visiting.insert(id) { return None; }
        let node = self.nodes.get(&id)?;
        let local = node.relative_transform.unwrap_or(node_legacy_transform(node)?);
        let world = if node.relative_transform.is_some() {
            match node.parent_id {
                Some(parent_id) => local.then(self.node_world_transform_inner(parent_id, visiting)?),
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
            Point { x: node.width, y: 0.0 },
            Point { x: node.width, y: node.height },
            Point { x: 0.0, y: node.height },
        ].map(|point| transform.transform_point(point));
        Some(Bounds {
            left: corners.iter().map(|point| point.x).fold(f64::INFINITY, f64::min),
            top: corners.iter().map(|point| point.y).fold(f64::INFINITY, f64::min),
            right: corners.iter().map(|point| point.x).fold(f64::NEG_INFINITY, f64::max),
            bottom: corners.iter().map(|point| point.y).fold(f64::NEG_INFINITY, f64::max),
        })
    }

    fn dissolve_empty_groups_from(&mut self, mut group_id: Option<NodeId>) -> Vec<Node> {
        let mut dissolved = Vec::new();
        while let Some(id) = group_id {
            let Some(group) = self.nodes.get(&id).cloned() else { break };
            if group.kind != NodeKind::Group
                || self.nodes.values().any(|node| node.parent_id == Some(id))
            {
                break;
            }
            group_id = group.parent_id;
            self.retire_node(id);
            self.refresh_group_bounds(group_id);
            dissolved.push(group);
        }
        dissolved
    }

    /// A Group or BooleanOperation may be temporarily incomplete while commands
    /// in one transaction are being applied (Create followed by Reparent is
    /// the normal construction path). The atomic boundary, not an individual
    /// command, owns the invariant so alternate clients and operation replay
    /// cannot persist an invalid structural shell.
    fn ensure_non_empty_groups(&self) -> Result<(), CommandError> {
        if let Some(group) = self.nodes
            .values()
            .filter(|node| node.kind == NodeKind::Group)
            .find(|group| !self.nodes.values().any(|node| node.parent_id == Some(group.id)))
        {
            return Err(CommandError::EmptyGroup { id: group.id });
        }
        if let Some(boolean) = self
            .nodes
            .values()
            .filter(|node| node.kind == NodeKind::BooleanOperation)
            .find(|boolean| {
                self.nodes
                    .values()
                    .filter(|node| node.parent_id == Some(boolean.id))
                    .take(2)
                    .count()
                    < 2
            })
        {
            return Err(CommandError::InsufficientBooleanOperands { id: boolean.id });
        }
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
            || properties.fallback_fonts.len() > MAX_TEXT_FALLBACK_FONTS
            || !properties.paragraph.paragraph_spacing.is_finite()
            || properties.paragraph.paragraph_spacing < 0.0
            || properties
                .paragraph
                .line_height
                .is_some_and(|value| !value.is_finite() || value <= 0.0)
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
                || !run.font_size.is_finite()
                || !(0.1..=10_000.0).contains(&run.font_size)
                || run.font_weight == 0
                || run.font_weight > 1_000
                || !run.letter_spacing.is_finite()
                || !(-10_000.0..=10_000.0).contains(&run.letter_spacing)
                || !run.color.is_none_or(Color::is_valid)
                || !run
                    .font
                    .as_ref()
                    .is_none_or(|font| self.valid_font_reference(font))
            {
                return false;
            }
            expected_start = end;
        }
        if !properties.runs.is_empty() && expected_start != text.len() {
            return false;
        }
        let mut seen_fonts = BTreeSet::new();
        properties
            .fallback_fonts
            .iter()
            .all(|font| seen_fonts.insert(font.asset_id) && self.valid_font_reference(font))
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

    fn retire_node(&mut self, id: NodeId) {
        let page_id = self.node_pages.remove(&id).unwrap_or(DEFAULT_PAGE_ID);
        if let Some(node) = self.nodes.remove(&id) {
            self.sibling_positions
                .remove(&(page_id, node.parent_id, node.position));
            self.node_bytes = self.node_bytes.saturating_sub(node.estimated_bytes());
        }
        if let Some(properties) = self.node_text_properties.remove(&id) {
            self.node_bytes = self.node_bytes.saturating_sub(properties.estimated_bytes());
            self.retired_node_text_properties.insert(id, properties);
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
        if !valid_dash_pattern(&node.stroke_dash_pattern) || !valid_stroke_weights(&node.stroke_weights) {
            return Err(CommandError::InvalidAppearance);
        }
        if !node.stroke_weights.is_empty() && !matches!(node.kind, NodeKind::Frame | NodeKind::Rectangle) {
            return Err(CommandError::InvalidAppearance);
        }
        if node.stroke_align != StrokeAlign::Inside
            && (!matches!(node.kind, NodeKind::Frame | NodeKind::Rectangle | NodeKind::Ellipse | NodeKind::Polygon | NodeKind::Star)
                || node.arc_data.is_some())
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
        self.nodes.insert(node.id, node.clone());
        self.node_pages.insert(node.id, page_id);
        self.sibling_positions
            .insert((page_id, node.parent_id, node.position));
        if let Some(asset_id) = asset_id {
            self.node_assets.insert(node.id, asset_id);
        }
        self.retired_node_pages.remove(&node.id);
        self.retired_node_assets.remove(&node.id);
        self.retired_node_text_properties.remove(&node.id);
        self.node_bytes += node.estimated_bytes();
        Ok(AppliedChange::NodeCreated { node })
    }

    fn restore_node(&mut self, node: &Node) {
        self.nodes.insert(node.id, node.clone());
        let page_id = self
            .retired_node_pages
            .remove(&node.id)
            .unwrap_or(DEFAULT_PAGE_ID);
        self.node_pages.insert(node.id, page_id);
        self.sibling_positions
            .insert((page_id, node.parent_id, node.position));
        if let Some(asset_id) = self.retired_node_assets.remove(&node.id) {
            self.node_assets.insert(node.id, asset_id);
        }
        if let Some(properties) = self.retired_node_text_properties.remove(&node.id) {
            self.node_bytes = self.node_bytes.saturating_add(properties.estimated_bytes());
            self.node_text_properties.insert(node.id, properties);
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
        if self
            .sibling_positions
            .contains(&(page_id, node.parent_id, node.position))
        {
            return Err(CommandError::DuplicatePosition {
                parent_id: node.parent_id,
                position: node.position,
            });
        }
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
        if text_properties
            .as_ref()
            .is_some_and(|properties| node.kind != NodeKind::Text || !self.valid_text_properties(&node.text, properties))
        {
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
        self.nodes.insert(node.id, node.clone());
        self.node_pages.insert(node.id, page_id);
        self.sibling_positions
            .insert((page_id, node.parent_id, node.position));
        if let Some(asset_id) = asset_id {
            self.node_assets.insert(node.id, asset_id);
        }
        if let Some(properties) = text_properties {
            self.node_text_properties.insert(node.id, properties);
        }
        self.retired_node_pages.remove(&node.id);
        self.retired_node_assets.remove(&node.id);
        self.retired_node_text_properties.remove(&node.id);
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
        if !valid_geometry(&node.kind, Geometry {
            x: node.x,
            y: node.y,
            width: node.width,
            height: node.height,
            rotation: node.rotation,
        }) {
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
        if node.clips_content && node.kind != NodeKind::Frame {
            return Err(CommandError::InvalidAppearance);
        }
        if node.kind == NodeKind::Slice
            && !valid_slice_node(node)
        {
            return Err(CommandError::InvalidAppearance);
        }
        if !valid_vector_path_for_kind(&node.kind, node.vector_path.as_ref()) {
            return Err(CommandError::InvalidGeometry);
        }
        if node.text.len() > MAX_TEXT_BYTES
            || (node.kind != NodeKind::Text && !node.text.is_empty())
        {
            return Err(CommandError::InvalidText);
        }
        if let Some(parent_id) = node.parent_id {
            let parent = self
                .nodes
                .get(&parent_id)
                .ok_or(CommandError::MissingParent { id: parent_id })?;
            if !can_contain_children(&parent.kind) {
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
        if self
            .sibling_positions
            .contains(&(page_id, node.parent_id, node.position))
        {
            return Err(CommandError::DuplicatePosition {
                parent_id: node.parent_id,
                position: node.position,
            });
        }
        Ok(())
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
            Command::Create(node) => node.estimated_bytes(),
            Command::UpdateGeometry { .. } => {
                std::mem::size_of::<Geometry>() + std::mem::size_of::<NodeId>()
            }
            Command::Rename { name, .. } => std::mem::size_of::<NodeId>() + name.len(),
            Command::SetAppearance { appearance, .. } => {
                std::mem::size_of::<NodeId>() + appearance.estimated_bytes()
            }
            Command::SetVectorPath { path, .. } => std::mem::size_of::<NodeId>() + path.estimated_bytes(),
            Command::SetBooleanOperation { .. } => std::mem::size_of::<NodeId>() + std::mem::size_of::<BooleanOperation>(),
            Command::SetMask { .. } => std::mem::size_of::<NodeId>() + std::mem::size_of::<bool>(),
            Command::MoveVectorPoint { .. } => {
                std::mem::size_of::<NodeId>() + std::mem::size_of::<PointId>() + std::mem::size_of::<Point>()
            }
            Command::SetVectorSubpathClosed { .. } => {
                std::mem::size_of::<NodeId>() + std::mem::size_of::<u32>() + std::mem::size_of::<bool>()
            }
            Command::InsertVectorPoint { point, .. } => {
                std::mem::size_of::<NodeId>() + std::mem::size_of::<u32>()
                    + std::mem::size_of::<Option<PointId>>() + std::mem::size_of_val(point)
            }
            Command::SplitVectorSegment { .. } => {
                std::mem::size_of::<NodeId>() + std::mem::size_of::<u32>()
                    + std::mem::size_of::<PointId>() * 2 + std::mem::size_of::<f64>()
            }
            Command::ConnectVectorEndpoints { .. } => {
                std::mem::size_of::<NodeId>() + std::mem::size_of::<u32>() * 2
                    + std::mem::size_of::<PointId>() * 2
            }
            Command::DeleteVectorPoint { .. } => {
                std::mem::size_of::<NodeId>() + std::mem::size_of::<PointId>()
            }
            Command::SetVectorPointHandles { .. } => {
                std::mem::size_of::<NodeId>() + std::mem::size_of::<PointId>()
                    + std::mem::size_of::<Option<Point>>() * 2 + std::mem::size_of::<VectorPointType>()
            }
            Command::SetNodeAsset { .. } => {
                std::mem::size_of::<NodeId>() + std::mem::size_of::<Option<AssetId>>()
            }
            Command::SetText { text, .. } => std::mem::size_of::<NodeId>() + text.len(),
            Command::SetTextProperties { properties, .. } => {
                std::mem::size_of::<NodeId>() + properties.estimated_bytes()
            }
            Command::SetAutoLayout { .. } => std::mem::size_of::<NodeId>() + std::mem::size_of::<AutoLayout>(),
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
                std::mem::size_of::<AssetReference>() + asset.media_type.len()
            }
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
            + self.extensions.iter().map(|(key, value)| key.len() + value.len()).sum::<usize>()
            + self.vector_path.as_ref().map(VectorPath::estimated_bytes).unwrap_or(0)
    }
}

impl VectorPath {
    fn estimated_bytes(&self) -> usize {
        std::mem::size_of::<Self>() + self.subpaths.iter().map(|subpath| {
            std::mem::size_of::<VectorSubpath>() + subpath.points.len() * std::mem::size_of::<VectorPoint>()
        }).sum::<usize>()
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
                })
                .sum::<usize>()
            + self
                .fallback_fonts
                .iter()
                .map(FontReference::estimated_bytes)
                .sum::<usize>()
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
            AppliedChange::Composite { changes } => changes.iter().map(AppliedChange::estimated_bytes).sum(),
            AppliedChange::PageCreated { page } => std::mem::size_of::<Page>() + page.name.len(),
            AppliedChange::NodeCreated { node }
            | AppliedChange::NodeDeleted { node }
            | AppliedChange::NodeRestored { node } => {
                node.estimated_bytes()
            }
            AppliedChange::GeometryChanged { .. } => {
                std::mem::size_of::<Geometry>() * 2 + std::mem::size_of::<NodeId>()
            }
            AppliedChange::NameChanged { before, after, .. } => {
                std::mem::size_of::<NodeId>() + before.len() + after.len()
            }
            AppliedChange::AppearanceChanged { before, after, .. } => {
                std::mem::size_of::<NodeId>() + before.estimated_bytes() + after.estimated_bytes()
            }
            AppliedChange::AutoLayoutChanged { .. } => {
                std::mem::size_of::<NodeId>() + std::mem::size_of::<Option<AutoLayout>>() * 2
            }
            AppliedChange::VectorPathChanged { before, after, .. } => {
                std::mem::size_of::<NodeId>() + before.estimated_bytes() + after.estimated_bytes()
            }
            AppliedChange::BooleanOperationChanged { .. } => {
                std::mem::size_of::<NodeId>() + std::mem::size_of::<BooleanOperation>() * 2
            }
            AppliedChange::MaskChanged { .. } => {
                std::mem::size_of::<NodeId>() + std::mem::size_of::<bool>() * 2
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
                std::mem::size_of::<AssetReference>() + asset.media_type.len()
            }
        }
    }
}

impl HistoryItem {
    fn estimated_bytes(&self) -> usize {
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
    hasher.update([match layout.mode { LayoutMode::None => 0, LayoutMode::Horizontal => 1, LayoutMode::Vertical => 2 }]);
    for value in layout.padding { hash_number(hasher, value); }
    hash_number(hasher, layout.item_spacing);
    hasher.update([u8::from(layout.wrap)]);
    hasher.update([match layout.primary_alignment { LayoutAlignment::Start => 0, LayoutAlignment::Center => 1, LayoutAlignment::End => 2, LayoutAlignment::SpaceBetween => 3 }]);
    hasher.update([match layout.counter_alignment { LayoutAlignment::Start => 0, LayoutAlignment::Center => 1, LayoutAlignment::End => 2, LayoutAlignment::SpaceBetween => 3 }]);
    hasher.update([match layout.primary_sizing { LayoutSizing::Fixed => 0, LayoutSizing::Hug => 1, LayoutSizing::Fill => 2 }]);
    hasher.update([match layout.counter_sizing { LayoutSizing::Fixed => 0, LayoutSizing::Hug => 1, LayoutSizing::Fill => 2 }]);
    for value in [layout.min_width, layout.max_width, layout.min_height, layout.max_height] {
        match value { Some(value) => { hasher.update([1]); hash_number(hasher, value); }, None => hasher.update([0]) }
    }
    hasher.update([u8::from(layout.absolute)]);
}

fn valid_auto_layout(layout: &AutoLayout) -> bool {
    layout.padding.into_iter().all(|value| value.is_finite() && value >= 0.0)
        && layout.item_spacing.is_finite()
        && [layout.min_width, layout.max_width, layout.min_height, layout.max_height]
            .into_iter().flatten().all(|value| value.is_finite() && value >= 0.0)
        && layout.min_width.zip(layout.max_width).is_none_or(|(min, max)| min <= max)
        && layout.min_height.zip(layout.max_height).is_none_or(|(min, max)| min <= max)
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
    for value in [shadow.offset_x, shadow.offset_y, shadow.blur_radius, shadow.spread] {
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
                hash_drop_shadow(hasher, DropShadow { offset_x: shadow.offset_x, offset_y: shadow.offset_y, blur_radius: shadow.blur_radius, spread: shadow.spread, color: shadow.color, visible: shadow.visible });
            }
            Effect::BackgroundBlur(blur) => { hasher.update([3]); hash_number(hasher, blur.radius); hasher.update([u8::from(blur.visible)]); }
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
    hasher.update([match properties.auto_size {
        TextAutoSize::Fixed => 0,
        TextAutoSize::Height => 1,
        TextAutoSize::WidthAndHeight => 2,
    }]);
    hash_len(hasher, properties.fallback_fonts.len());
    for font in &properties.fallback_fonts {
        hash_font_reference(hasher, font);
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
    if node.kind == NodeKind::Frame && !node.clips_content {
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
        Command::SetVectorPath { id, path } => {
            hasher.update([16]);
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
        Command::MoveVectorPoint { id, point_id, position } => {
            hasher.update([17]);
            hasher.update(id.0.to_be_bytes());
            hasher.update(point_id.0.to_be_bytes());
            hash_number(hasher, position.x);
            hash_number(hasher, position.y);
        }
        Command::SetVectorSubpathClosed { id, subpath_index, closed } => {
            hasher.update([18]);
            hasher.update(id.0.to_be_bytes());
            hasher.update(subpath_index.to_be_bytes());
            hasher.update([u8::from(*closed)]);
        }
        Command::InsertVectorPoint { id, subpath_index, after_point_id, point } => {
            hasher.update([19]);
            hasher.update(id.0.to_be_bytes());
            hasher.update(subpath_index.to_be_bytes());
            match after_point_id {
                Some(point_id) => { hasher.update([1]); hasher.update(point_id.0.to_be_bytes()); }
                None => hasher.update([0]),
            }
            hasher.update(point.id.0.to_be_bytes());
            hash_number(hasher, point.position.x);
            hash_number(hasher, point.position.y);
            for handle in [point.handle_in, point.handle_out] {
                match handle {
                    Some(handle) => { hasher.update([1]); hash_number(hasher, handle.x); hash_number(hasher, handle.y); }
                    None => hasher.update([0]),
                }
            }
            hasher.update([match point.point_type { VectorPointType::Corner => 0, VectorPointType::Mirrored => 1, VectorPointType::Asymmetric => 2 }]);
        }
        Command::DeleteVectorPoint { id, point_id } => {
            hasher.update([20]);
            hasher.update(id.0.to_be_bytes());
            hasher.update(point_id.0.to_be_bytes());
        }
        Command::SplitVectorSegment { id, subpath_index, after_point_id, t, point_id } => {
            hasher.update([23]);
            hasher.update(id.0.to_be_bytes());
            hasher.update(subpath_index.to_be_bytes());
            hasher.update(after_point_id.0.to_be_bytes());
            hash_number(hasher, *t);
            hasher.update(point_id.0.to_be_bytes());
        }
        Command::ConnectVectorEndpoints { id, first_subpath_index, first_point_id, second_subpath_index, second_point_id } => {
            hasher.update([25]);
            hasher.update(id.0.to_be_bytes());
            hasher.update(first_subpath_index.to_be_bytes());
            hasher.update(first_point_id.0.to_be_bytes());
            hasher.update(second_subpath_index.to_be_bytes());
            hasher.update(second_point_id.0.to_be_bytes());
        }
        Command::SetVectorPointHandles { id, point_id, handle_in, handle_out, point_type } => {
            hasher.update([21]);
            hasher.update(id.0.to_be_bytes());
            hasher.update(point_id.0.to_be_bytes());
            for handle in [handle_in, handle_out] {
                match handle {
                    Some(handle) => { hasher.update([1]); hash_number(hasher, handle.x); hash_number(hasher, handle.y); }
                    None => hasher.update([0]),
                }
            }
            hasher.update([match point_type { VectorPointType::Corner => 0, VectorPointType::Mirrored => 1, VectorPointType::Asymmetric => 2 }]);
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
        NodeKind::Frame | NodeKind::Section | NodeKind::Rectangle | NodeKind::Ellipse | NodeKind::Image
    )
}

fn node_legacy_transform(node: &Node) -> Option<AffineTransform> {
    if !valid_geometry(&node.kind, Geometry {
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        rotation: node.rotation,
    }) {
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
            NodeKind::Line => geometry.height == 0.0,
            _ => geometry.height > 0.0,
        }
}

fn can_contain_children(kind: &NodeKind) -> bool {
    matches!(kind, NodeKind::Frame | NodeKind::Group | NodeKind::BooleanOperation | NodeKind::Section)
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

fn geometry_for_constraints(parent_before: Geometry, parent_after: Geometry, child: Geometry, constraints: Constraints, kind: &NodeKind) -> Result<Geometry, CommandError> {
    fn axis(position: f64, size: f64, old_parent: f64, new_parent: f64, constraint: ConstraintType, preserve_zero: bool) -> Result<(f64, f64), CommandError> {
        let delta = new_parent - old_parent;
        Ok(match constraint {
            ConstraintType::Min => (position, size),
            ConstraintType::Center => (position + delta / 2.0, size),
            ConstraintType::Max => (position + delta, size),
            ConstraintType::Stretch => (position, if preserve_zero { 0.0 } else { size + delta }),
            ConstraintType::Scale => {
                if old_parent == 0.0 { return Err(CommandError::InvalidGeometry); }
                let ratio = new_parent / old_parent;
                (position * ratio, if preserve_zero { 0.0 } else { size * ratio })
            }
        })
    }
    let (x, width) = axis(child.x - parent_before.x, child.width, parent_before.width, parent_after.width, constraints.horizontal, false)?;
    let (y, height) = axis(child.y - parent_before.y, child.height, parent_before.height, parent_after.height, constraints.vertical, *kind == NodeKind::Line)?;
    let after = Geometry { x: parent_after.x + x, y: parent_after.y + y, width, height, rotation: child.rotation };
    if valid_geometry(kind, after) { Ok(after) } else { Err(CommandError::InvalidGeometry) }
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
        && appearance.parametric_shape.is_none_or(valid_parametric_shape_value)
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
            Effect::LayerBlur(blur) => blur.radius.is_finite() && (0.0..=256.0).contains(&blur.radius),
            Effect::InnerShadow(shadow) => valid_drop_shadow(DropShadow { offset_x: shadow.offset_x, offset_y: shadow.offset_y, blur_radius: shadow.blur_radius, spread: shadow.spread, color: shadow.color, visible: shadow.visible }),
            Effect::BackgroundBlur(blur) => blur.radius.is_finite() && (0.0..=256.0).contains(&blur.radius),
        })
        && (effects.is_empty() || first_effect_drop_shadow(effects) == legacy_shadow)
}

fn hash_constraints(hasher: &mut Sha256, constraints: Option<Constraints>) {
    let Some(constraints) = constraints else { return; };
    let encode = |value| match value {
        ConstraintType::Min => 0,
        ConstraintType::Center => 1,
        ConstraintType::Max => 2,
        ConstraintType::Stretch => 3,
        ConstraintType::Scale => 4,
    };
    // Legacy nodes do not write this marker and therefore retain their hashes.
    hasher.update([7, encode(constraints.horizontal), encode(constraints.vertical)]);
}

const MAX_PAINT_LAYERS: usize = 16;

fn valid_paint_stack(paints: &[Paint]) -> bool {
    paints.len() <= MAX_PAINT_LAYERS && paints.iter().all(Paint::is_valid)
}

fn paint_stack_bytes(paints: &[Paint]) -> usize {
    paints.iter().map(Paint::estimated_bytes).sum()
}

fn valid_corner_radii(radii: &[f64]) -> bool {
    (radii.is_empty() || radii.len() == 4) && radii.iter().all(|radius| radius.is_finite() && *radius >= 0.0)
}

const DEFAULT_STROKE_MITER_LIMIT: f64 = 10.0;
const MAX_STROKE_DASH_SEGMENTS: usize = 32;

fn valid_dash_pattern(pattern: &[f64]) -> bool {
    pattern.len() <= MAX_STROKE_DASH_SEGMENTS
        && pattern.iter().all(|segment| segment.is_finite() && *segment >= 0.0)
        && (pattern.is_empty() || pattern.iter().any(|segment| *segment > 0.0))
}

/// Canvas and Figma repeat odd-length patterns to form a full on/off cycle.
/// Persisting the expanded result makes equivalent inputs hash identically.
fn canonical_dash_pattern(pattern: &[f64]) -> Vec<f64> {
    if pattern.len() % 2 == 0 {
        return pattern.to_vec();
    }
    pattern.iter().copied().chain(pattern.iter().copied()).collect()
}

fn valid_stroke_weights(weights: &[f64]) -> bool {
    (weights.is_empty() || weights.len() == 4)
        && weights.iter().all(|weight| weight.is_finite() && *weight >= 0.0)
}

fn valid_arc_data(arc: ArcData) -> bool {
    arc.starting_angle.is_finite()
        && arc.ending_angle.is_finite()
        && arc.inner_radius.is_finite()
        && (0.0..1.0).contains(&arc.inner_radius)
}

const MIN_PARAMETRIC_POINTS: u32 = 3;
const MAX_PARAMETRIC_POINTS: u32 = 100;

fn valid_parametric_shape_value(shape: ParametricShape) -> bool {
    match shape {
        ParametricShape::Polygon { point_count } => {
            (MIN_PARAMETRIC_POINTS..=MAX_PARAMETRIC_POINTS).contains(&point_count)
        }
        ParametricShape::Star { point_count, inner_ratio } => {
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
        if subpath.points.windows(2).any(|pair| pair[0].position == pair[1].position)
            || (subpath.closed
                && subpath.points.len() > 1
                && subpath.points.first().is_some_and(|first| {
                    subpath.points.last().is_some_and(|last| first.position == last.position)
                }))
        {
            return false;
        }
        total = total.saturating_add(subpath.points.len());
        for point in &subpath.points {
            if !ids.insert(point.id)
                || ![point.position.x, point.position.y]
                    .into_iter()
                    .chain(point.handle_in.into_iter().flat_map(|handle| [handle.x, handle.y]))
                    .chain(point.handle_out.into_iter().flat_map(|handle| [handle.x, handle.y]))
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
        (NodeKind::Vector, Some(path)) => valid_vector_path(path),
        (NodeKind::Vector, None) => false,
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
    hasher.update([match path.fill_rule { FillRule::NonZero => 0, FillRule::EvenOdd => 1 }]);
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
                    Some(handle) => { hasher.update([1]); hash_number(hasher, handle.x); hash_number(hasher, handle.y); }
                    None => hasher.update([0]),
                }
            }
            hasher.update([match point.point_type { VectorPointType::Corner => 0, VectorPointType::Mirrored => 1, VectorPointType::Asymmetric => 2 }]);
        }
    }
}

fn hash_parametric_shape(hasher: &mut Sha256, shape: ParametricShape) {
    match shape {
        ParametricShape::Polygon { point_count } => {
            hasher.update([0]);
            hasher.update(point_count.to_be_bytes());
        }
        ParametricShape::Star { point_count, inner_ratio } => {
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
            for value in [transform.a, transform.b, transform.c, transform.d, transform.e, transform.f] {
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
        document.submit(transaction(0, vec![
            Command::Create(frame.clone()),
            Command::Create(first.clone()),
            Command::Create(second.clone()),
            Command::SetAutoLayout { id: frame.id, layout },
        ]), Origin::LocalUser).unwrap();
        assert_eq!(document.node(first.id).map(|node| (node.x, node.y)), Some((50.0, 50.0)));
        assert_eq!(document.node(second.id).map(|node| (node.x, node.y)), Some((88.0, 50.0)));
        let hash = document.canonical_hash();
        document.undo().unwrap();
        assert!(document.node(first.id).is_none());
        document.redo().unwrap();
        assert_eq!(document.canonical_hash(), hash);
        assert_eq!(document.node(second.id).map(|node| (node.x, node.y)), Some((88.0, 50.0)));
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
        document.submit(transaction(0, vec![
            Command::Create(frame.clone()),
            Command::Create(fixed.clone()),
            Command::Create(fill.clone()),
            Command::SetAutoLayout {
                id: frame.id,
                layout: AutoLayout { mode: LayoutMode::Horizontal, item_spacing: 10.0, ..AutoLayout::default() },
            },
            Command::SetAutoLayout {
                id: fill.id,
                layout: AutoLayout { primary_sizing: LayoutSizing::Fill, counter_sizing: LayoutSizing::Fill, ..AutoLayout::default() },
            },
        ]), Origin::LocalUser).unwrap();
        assert_eq!(document.node(fixed.id).map(|node| (node.x, node.y, node.width, node.height)), Some((0.0, 0.0, 30.0, 20.0)));
        assert_eq!(document.node(fill.id).map(|node| (node.x, node.y, node.width, node.height)), Some((40.0, 0.0, 160.0, 100.0)));
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
        document.submit(transaction(0, vec![
            Command::Create(frame.clone()),
            Command::Create(first.clone()),
            Command::Create(second.clone()),
            Command::SetAutoLayout { id: frame.id, layout: AutoLayout { mode: LayoutMode::Vertical, padding: [8.0, 0.0, 8.0, 0.0], item_spacing: 6.0, ..AutoLayout::default() } },
        ]), Origin::LocalUser).unwrap();
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
        document.submit(transaction(0, vec![
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
        ]), Origin::LocalUser).unwrap();
        assert_eq!(document.node(frame.id).map(|node| (node.width, node.height)), Some((90.0, 52.0)));
        assert_eq!(document.node(first.id).map(|node| (node.x, node.y)), Some((5.0, 2.0)));
        assert_eq!(document.node(second.id).map(|node| (node.x, node.y)), Some((41.0, 2.0)));
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
        let hug = AutoLayout { mode: LayoutMode::Horizontal, primary_sizing: LayoutSizing::Hug, counter_sizing: LayoutSizing::Hug, ..AutoLayout::default() };
        document.submit(transaction(0, vec![
            Command::Create(outer.clone()),
            Command::Create(inner.clone()),
            Command::Create(leaf.clone()),
            Command::SetAutoLayout { id: outer.id, layout: hug.clone() },
            Command::SetAutoLayout { id: inner.id, layout: hug },
        ]), Origin::LocalUser).unwrap();
        assert_eq!(document.node(inner.id).map(|node| (node.width, node.height, node.x, node.y)), Some((20.0, 10.0, 0.0, 0.0)));
        assert_eq!(document.node(outer.id).map(|node| (node.width, node.height)), Some((20.0, 10.0)));
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
        document.submit(transaction(0, vec![
            Command::Create(outer.clone()),
            Command::Create(inner.clone()),
            Command::Create(leaf.clone()),
            Command::SetAutoLayout { id: outer.id, layout: AutoLayout { mode: LayoutMode::Horizontal, ..AutoLayout::default() } },
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
        ]), Origin::LocalUser).unwrap();
        assert_eq!(document.node(inner.id).map(|node| (node.width, node.height)), Some((200.0, 10.0)));
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
        document.submit(transaction(0, vec![
            Command::Create(frame.clone()), Command::Create(fixed.clone()), Command::Create(capped_fill.clone()), Command::Create(free_fill.clone()),
            Command::SetAutoLayout { id: frame.id, layout: AutoLayout { mode: LayoutMode::Horizontal, ..AutoLayout::default() } },
            Command::SetAutoLayout { id: capped_fill.id, layout: AutoLayout { primary_sizing: LayoutSizing::Fill, min_width: Some(50.0), max_width: Some(80.0), ..AutoLayout::default() } },
            Command::SetAutoLayout { id: free_fill.id, layout: AutoLayout { primary_sizing: LayoutSizing::Fill, ..AutoLayout::default() } },
        ]), Origin::LocalUser).unwrap();
        assert_eq!(document.node(capped_fill.id).map(|node| (node.x, node.width)), Some((20.0, 80.0)));
        assert_eq!(document.node(free_fill.id).map(|node| (node.x, node.width)), Some((100.0, 100.0)));
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
        let result = document.submit(transaction(0, vec![
            Command::Create(frame.clone()), Command::Create(first.clone()), Command::Create(second.clone()),
            Command::SetAutoLayout { id: frame.id, layout: AutoLayout { mode: LayoutMode::Horizontal, ..AutoLayout::default() } },
            Command::SetAutoLayout { id: first.id, layout: AutoLayout { primary_sizing: LayoutSizing::Fill, min_width: Some(60.0), ..AutoLayout::default() } },
            Command::SetAutoLayout { id: second.id, layout: AutoLayout { primary_sizing: LayoutSizing::Fill, min_width: Some(60.0), ..AutoLayout::default() } },
        ]), Origin::LocalUser);
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
        document.submit(transaction(0, vec![
            Command::Create(frame.clone()), Command::Create(first.clone()), Command::Create(second.clone()), Command::Create(third.clone()),
            Command::SetAutoLayout {
                id: frame.id,
                layout: AutoLayout { mode: LayoutMode::Horizontal, wrap: true, item_spacing: 10.0, ..AutoLayout::default() },
            },
        ]), Origin::LocalUser).unwrap();
        assert_eq!(document.node(first.id).map(|node| (node.x, node.y)), Some((0.0, 0.0)));
        assert_eq!(document.node(second.id).map(|node| (node.x, node.y)), Some((50.0, 0.0)));
        assert_eq!(document.node(third.id).map(|node| (node.x, node.y)), Some((0.0, 30.0)));
    }

    #[test]
    fn auto_layout_rejects_wrap_with_fill_children_atomically() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 100.0;
        let mut child = node(2);
        child.kind = NodeKind::Rectangle;
        child.parent_id = Some(frame.id);
        let result = document.submit(transaction(0, vec![
            Command::Create(frame.clone()), Command::Create(child.clone()),
            Command::SetAutoLayout { id: child.id, layout: AutoLayout { primary_sizing: LayoutSizing::Fill, ..AutoLayout::default() } },
            Command::SetAutoLayout { id: frame.id, layout: AutoLayout { mode: LayoutMode::Horizontal, wrap: true, ..AutoLayout::default() } },
        ]), Origin::LocalUser);
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
        document.submit(transaction(0, vec![
            Command::Create(frame.clone()), Command::Create(first.clone()), Command::Create(second.clone()),
            Command::SetAutoLayout { id: frame.id, layout: AutoLayout { mode: LayoutMode::Horizontal, item_spacing: 10.0, ..AutoLayout::default() } },
        ]), Origin::LocalUser).unwrap();
        assert_eq!(document.node(second.id).map(|node| node.x), Some(30.0));
        document.submit(transaction(1, vec![Command::SetNodeParent {
            id: first.id, parent_id: None, position: PositionId { key: 10, actor: ActorId(1) },
        }]), Origin::LocalUser).unwrap();
        assert_eq!(document.node(second.id).map(|node| node.x), Some(0.0));
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
            runs: vec![TextStyleRun { start: 0, end: 5, font: None, font_size: 10.0, font_weight: 400, italic: false, letter_spacing: 0.0, color: None }],
            paragraph: ParagraphStyle { alignment: TextAlign::Left, line_height: Some(12.0), paragraph_spacing: 0.0 },
            auto_size: TextAutoSize::WidthAndHeight,
            fallback_fonts: Vec::new(),
        };
        document.submit(transaction(0, vec![
            Command::Create(frame.clone()), Command::Create(text.clone()),
            Command::SetTextProperties { id: text.id, properties },
            Command::SetAutoLayout { id: frame.id, layout: AutoLayout { mode: LayoutMode::Horizontal, primary_sizing: LayoutSizing::Hug, counter_sizing: LayoutSizing::Hug, ..AutoLayout::default() } },
            Command::SetAutoLayout { id: text.id, layout: AutoLayout { primary_sizing: LayoutSizing::Hug, counter_sizing: LayoutSizing::Hug, ..AutoLayout::default() } },
        ]), Origin::LocalUser).unwrap();
        assert_eq!(document.node(text.id).map(|node| (node.width, node.height)), Some((30.0, 12.0)));
        assert_eq!(document.node(frame.id).map(|node| (node.width, node.height)), Some((30.0, 12.0)));
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
            runs: vec![TextStyleRun { start: 0, end: text.text.len() as u32, font: None, font_size: 10.0, font_weight: 400, italic: false, letter_spacing: 0.0, color: None }],
            paragraph: ParagraphStyle { alignment: TextAlign::Left, line_height: Some(12.0), paragraph_spacing: 3.0 },
            auto_size: TextAutoSize::WidthAndHeight,
            fallback_fonts: Vec::new(),
        };
        document.submit(transaction(0, vec![
            Command::Create(frame.clone()), Command::Create(text.clone()),
            Command::SetTextProperties { id: text.id, properties },
            Command::SetAutoLayout { id: frame.id, layout: AutoLayout { mode: LayoutMode::Horizontal, primary_sizing: LayoutSizing::Hug, counter_sizing: LayoutSizing::Hug, ..AutoLayout::default() } },
            Command::SetAutoLayout { id: text.id, layout: AutoLayout { primary_sizing: LayoutSizing::Hug, counter_sizing: LayoutSizing::Hug, ..AutoLayout::default() } },
        ]), Origin::LocalUser).unwrap();
        assert_eq!(document.node(text.id).map(|node| (node.width, node.height)), Some((12.0, 27.0)));
        assert_eq!(document.node(frame.id).map(|node| (node.width, node.height)), Some((12.0, 27.0)));
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
            runs: vec![TextStyleRun { start: 0, end: text.text.len() as u32, font: None, font_size: 10.0, font_weight: 400, italic: false, letter_spacing: 0.0, color: None }],
            paragraph: ParagraphStyle { alignment: TextAlign::Left, line_height: Some(12.0), paragraph_spacing: 0.0 },
            auto_size: TextAutoSize::Height,
            fallback_fonts: Vec::new(),
        };
        document.submit(transaction(0, vec![
            Command::Create(frame.clone()), Command::Create(text.clone()),
            Command::SetTextProperties { id: text.id, properties },
            Command::SetAutoLayout { id: frame.id, layout: AutoLayout { mode: LayoutMode::Horizontal, ..AutoLayout::default() } },
            Command::SetAutoLayout { id: text.id, layout: AutoLayout { primary_sizing: LayoutSizing::Fixed, counter_sizing: LayoutSizing::Hug, ..AutoLayout::default() } },
        ]), Origin::LocalUser).unwrap();
        assert_eq!(document.node(text.id).map(|node| (node.width, node.height)), Some((12.0, 24.0)));
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
            runs: vec![TextStyleRun { start: 0, end: text.text.len() as u32, font: None, font_size: 10.0, font_weight: 400, italic: false, letter_spacing: 0.0, color: None }],
            paragraph: ParagraphStyle { alignment: TextAlign::Left, line_height: Some(12.0), paragraph_spacing: 0.0 },
            auto_size: TextAutoSize::Height,
            fallback_fonts: Vec::new(),
        };
        document.submit(transaction(0, vec![
            Command::Create(frame.clone()), Command::Create(text.clone()),
            Command::SetTextProperties { id: text.id, properties },
            Command::SetAutoLayout { id: frame.id, layout: AutoLayout { mode: LayoutMode::Horizontal, ..AutoLayout::default() } },
            Command::SetAutoLayout { id: text.id, layout: AutoLayout { primary_sizing: LayoutSizing::Fixed, counter_sizing: LayoutSizing::Hug, ..AutoLayout::default() } },
        ]), Origin::LocalUser).unwrap();
        // Three graphemes at 6px each form two 12px lines, rather than the
        // eight Unicode scalars creating four unstable lines.
        assert_eq!(document.node(text.id).map(|node| (node.width, node.height)), Some((12.0, 24.0)));
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
        document.submit(transaction(0, vec![
            Command::Create(frame.clone()), Command::Create(flow.clone()), Command::Create(absolute.clone()),
            Command::SetAutoLayout { id: frame.id, layout: AutoLayout { mode: LayoutMode::Horizontal, padding: [5.0, 5.0, 5.0, 5.0], ..AutoLayout::default() } },
            Command::SetAutoLayout { id: absolute.id, layout: AutoLayout { absolute: true, ..AutoLayout::default() } },
        ]), Origin::LocalUser).unwrap();
        assert_eq!(document.node(flow.id).map(|node| (node.x, node.y)), Some((5.0, 5.0)));
        assert_eq!(document.node(absolute.id).map(|node| (node.x, node.y, node.width, node.height)), Some((70.0, 60.0, 10.0, 10.0)));
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
        let hug = AutoLayout { mode: LayoutMode::Horizontal, primary_sizing: LayoutSizing::Hug, counter_sizing: LayoutSizing::Hug, ..AutoLayout::default() };
        document.submit(transaction(0, vec![
            Command::Create(outer.clone()), Command::Create(middle.clone()), Command::Create(inner.clone()), Command::Create(leaf.clone()),
            Command::SetAutoLayout { id: outer.id, layout: hug.clone() },
            Command::SetAutoLayout { id: middle.id, layout: hug.clone() },
            Command::SetAutoLayout { id: inner.id, layout: hug },
        ]), Origin::LocalUser).unwrap();
        for id in [outer.id, middle.id, inner.id] {
            assert_eq!(document.node(id).map(|node| (node.width, node.height)), Some((24.0, 16.0)));
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
        document.submit(transaction(0, vec![
            Command::Create(outer.clone()), Command::Create(inner.clone()), Command::Create(leaf.clone()),
            Command::SetAutoLayout { id: outer.id, layout: AutoLayout { mode: LayoutMode::Vertical, ..AutoLayout::default() } },
            // As a vertical parent's counter-axis child, this horizontal Frame
            // fills the parent's width. Its own end alignment must be rerun
            // whenever the parent changes that width.
            Command::SetAutoLayout { id: inner.id, layout: AutoLayout { mode: LayoutMode::Horizontal, primary_sizing: LayoutSizing::Fill, primary_alignment: LayoutAlignment::End, ..AutoLayout::default() } },
        ]), Origin::LocalUser).unwrap();
        assert_eq!(document.node(leaf.id).map(|node| node.x), Some(80.0));

        document.submit(transaction(1, vec![Command::UpdateGeometry {
            id: outer.id, x: 0.0, y: 0.0, width: 200.0, height: 100.0, rotation: 0.0,
        }]), Origin::LocalUser).unwrap();

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
        document.submit(transaction(0, vec![
            Command::Create(frame.clone()), Command::Create(first.clone()), Command::Create(second.clone()),
            Command::SetAutoLayout { id: frame.id, layout: AutoLayout { mode: LayoutMode::Horizontal, item_spacing: 10.0, ..AutoLayout::default() } },
        ]), Origin::LocalUser).unwrap();
        document.submit(transaction(1, vec![Command::SetNodePosition {
            id: first.id, position: PositionId { key: 4, actor: ActorId(0) },
        }]), Origin::LocalUser).unwrap();
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
        child.constraints = Some(Constraints { horizontal: ConstraintType::Stretch, vertical: ConstraintType::Stretch });
        document.submit(transaction(0, vec![
            Command::Create(frame.clone()), Command::Create(child.clone()),
            Command::SetAutoLayout { id: frame.id, layout: AutoLayout { mode: LayoutMode::Horizontal, ..AutoLayout::default() } },
        ]), Origin::LocalUser).unwrap();
        document.submit(transaction(1, vec![Command::UpdateGeometry {
            id: frame.id, x: 0.0, y: 0.0, width: 200.0, height: 200.0, rotation: 0.0,
        }]), Origin::LocalUser).unwrap();
        assert_eq!(document.node(child.id).map(|node| (node.x, node.y, node.width, node.height)), Some((0.0, 0.0, 20.0, 20.0)));
        assert_eq!(document.node(child.id).and_then(|node| node.constraints), child.constraints);
    }

    #[test]
    fn auto_layout_mode_is_rejected_on_non_frame_nodes() {
        let mut document = Document::empty();
        let mut rectangle = node(1);
        rectangle.kind = NodeKind::Rectangle;
        document.submit(transaction(0, vec![Command::Create(rectangle.clone())]), Origin::LocalUser).unwrap();
        assert_eq!(
            document.submit(transaction(1, vec![Command::SetAutoLayout {
                id: rectangle.id,
                layout: AutoLayout { mode: LayoutMode::Vertical, ..AutoLayout::default() },
            }]), Origin::LocalUser),
            Err(CommandError::InvalidAutoLayout),
        );
    }

    #[test]
    fn line_accepts_zero_height_but_other_nodes_do_not() {
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
            .submit(transaction(0, vec![Command::Create(line)]), Origin::LocalUser)
            .unwrap();

        let mut rectangle = node(2);
        rectangle.height = 0.0;
        assert_eq!(
            document.submit(
                transaction(1, vec![Command::Create(rectangle)]),
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
                dimensions: None
            }),
            Err(CommandError::InvalidAsset)
        );
    }

    #[test]
    fn registered_asset_is_hashed_undoable_and_never_accepts_partial_dimensions() {
        let asset = AssetReference {
            asset_id: AssetId(9),
            content_hash: [4; 32],
            media_type: "image/png".into(),
            byte_length: 128,
            dimensions: Some([16, 8]),
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
        assert_eq!(document.node(NodeId(1)).unwrap().stroke_cap_end, StrokeCap::ArrowLines);
        assert_ne!(document.canonical_hash_hex(), baseline_hash);

        document.undo().unwrap();
        assert_eq!(document.node(NodeId(1)).unwrap().stroke_width, 0.0);
        assert_eq!(document.node(NodeId(1)).unwrap().stroke_cap_end, StrokeCap::None);
        assert_eq!(document.canonical_hash_hex(), baseline_hash);
        document.redo().unwrap();
        assert_eq!(document.node(NodeId(1)).unwrap().stroke_width, 3.0);
        assert_eq!(document.node(NodeId(1)).unwrap().stroke_cap_end, StrokeCap::ArrowLines);
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
        let position = PositionId { key: 7, actor: ActorId(9) };
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
        assert_eq!((group.x, group.y, group.width, group.height, group.rotation), (10.0, 20.0, 30.0, 40.0, 0.0));
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
        child.relative_transform = Some(AffineTransform { a: 1.0, b: 0.0, c: 0.0, d: 1.0, e: 100.0, f: 50.0 });
        document
            .submit(transaction(0, vec![Command::Create(group), Command::Create(child)]), Origin::LocalUser)
            .unwrap();
        // Before the move the child's world origin is its local origin.
        assert_eq!((document.node_world_transform(NodeId(2)).unwrap().e, document.node_world_transform(NodeId(2)).unwrap().f), (100.0, 50.0));
        let grouped_hash = document.canonical_hash_hex();

        // Move the child by (+40, +40): against the identity frame the new local
        // origin is simply the new world origin.
        let mut appearance = appearance_for_node(document.node(NodeId(2)).unwrap());
        appearance.relative_transform = Some(AffineTransform { a: 1.0, b: 0.0, c: 0.0, d: 1.0, e: 140.0, f: 90.0 });
        document
            .submit(transaction(1, vec![Command::SetAppearance { id: NodeId(2), appearance }]), Origin::LocalUser)
            .unwrap();

        // The child lands exactly where dropped — no compounding jump from a
        // spurious Group-box refresh dragging the anchor.
        assert_eq!((document.node_world_transform(NodeId(2)).unwrap().e, document.node_world_transform(NodeId(2)).unwrap().f), (140.0, 90.0));
        let moved_hash = document.canonical_hash_hex();
        assert_ne!(moved_hash, grouped_hash);

        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), grouped_hash);
        assert_eq!((document.node_world_transform(NodeId(2)).unwrap().e, document.node_world_transform(NodeId(2)).unwrap().f), (100.0, 50.0));
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), moved_hash);
        assert_eq!((document.node_world_transform(NodeId(2)).unwrap().e, document.node_world_transform(NodeId(2)).unwrap().f), (140.0, 90.0));
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

        document.submit(transaction(0, vec![Command::Create(first_group), Command::Create(first_child), Command::Create(second_group), Command::Create(second_child)]), Origin::LocalUser).unwrap();
        document.submit(transaction(1, vec![Command::UpdateGeometry {
            id: NodeId(1), x: 50.0, y: 60.0, width: 30.0, height: 20.0, rotation: 0.0,
        }]), Origin::LocalUser).unwrap();

        assert_eq!((document.node(NodeId(1)).unwrap().x, document.node(NodeId(1)).unwrap().y), (50.0, 60.0));
        assert_eq!((document.node(NodeId(3)).unwrap().x, document.node(NodeId(3)).unwrap().y), (200.0, 220.0));
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
        child.relative_transform = Some(AffineTransform { a: 0.0, b: 1.0, c: -1.0, d: 0.0, e: 100.0, f: 50.0 });
        document.submit(transaction(0, vec![Command::Create(group), Command::Create(child)]), Origin::LocalUser).unwrap();

        document.submit(transaction(1, vec![Command::UpdateGeometry {
            id: NodeId(2), x: 0.0, y: 0.0, width: 30.0, height: 40.0, rotation: 0.0,
        }]), Origin::LocalUser).unwrap();
        let group = document.node(NodeId(1)).unwrap();
        assert_eq!((group.x, group.y, group.width, group.height), (60.0, 50.0, 40.0, 30.0));
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
                        position: PositionId { key: 3, actor: ActorId(1) },
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
    fn transaction_rejects_an_empty_group_without_mutating_document_state() {
        let mut document = Document::empty();
        let mut group = node(1);
        group.kind = NodeKind::Group;
        group.name = "Empty group".into();
        let before_hash = document.canonical_hash_hex();

        assert_eq!(
            document.submit(transaction(0, vec![Command::Create(group)]), Origin::LocalUser),
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
        let mut outer = node(1); outer.name = "Outer".into();
        let mut inner = node(2); inner.name = "Inner".into(); inner.parent_id = Some(NodeId(1)); inner.x = 10.0; inner.y = 10.0;
        let mut rect = node(3); rect.kind = NodeKind::Rectangle; rect.name = "Rect".into(); rect.parent_id = Some(NodeId(2)); rect.corner_radii = vec![4.0, 8.0, 12.0, 16.0];
        let mut ellipse = node(4); ellipse.kind = NodeKind::Ellipse; ellipse.name = "Ellipse".into(); ellipse.parent_id = Some(NodeId(2)); ellipse.x = 40.0;
        let mut text = node(5); text.kind = NodeKind::Text; text.name = "Text".into(); text.parent_id = Some(NodeId(1)); text.text = "Hi".into(); text.y = 80.0;
        document.submit(transaction(0, vec![
            Command::Create(outer), Command::Create(inner),
            Command::Create(rect), Command::Create(ellipse), Command::Create(text),
        ]), Origin::LocalUser).unwrap();

        let ordered_before: Vec<(NodeId, Option<NodeId>)> = document
            .ordered_nodes_on_page(DEFAULT_PAGE_ID).unwrap()
            .iter().map(|n| (n.id, n.parent_id)).collect();
        let rect_radii_before = document.node(NodeId(3)).unwrap().corner_radii.clone();
        let built_hash = document.canonical_hash_hex();

        // Child-first single-transaction subtree delete: deepest leaves, then Inner, then Outer.
        document.submit(transaction(1, vec![
            Command::Delete { id: NodeId(3) },
            Command::Delete { id: NodeId(4) },
            Command::Delete { id: NodeId(2) },
            Command::Delete { id: NodeId(5) },
            Command::Delete { id: NodeId(1) },
        ]), Origin::LocalUser).unwrap();
        assert_eq!(document.node_count(), 0);

        document.undo().unwrap();
        // Hash equality proves total restoration; the structural asserts pin the
        // specific ID / order / parent / property expectations the plan names.
        assert_eq!(document.canonical_hash_hex(), built_hash);
        let ordered_after: Vec<(NodeId, Option<NodeId>)> = document
            .ordered_nodes_on_page(DEFAULT_PAGE_ID).unwrap()
            .iter().map(|n| (n.id, n.parent_id)).collect();
        assert_eq!(ordered_after, ordered_before);
        assert_eq!(document.node(NodeId(3)).unwrap().corner_radii, rect_radii_before);
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
            .submit(transaction(0, vec![Command::Create(section)]), Origin::LocalUser)
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
        document.submit(transaction(0, vec![Command::Create(frame)]), Origin::LocalUser).unwrap();
        let baseline = document.canonical_hash_hex();
        let appearance = Appearance {
            fill: "#fff".into(), stroke: "#000".into(), fills: vec!["#e6edff".into(), "#0048ff".into()], strokes: vec!["#000".into(), "#2563eb".into()], stroke_width: 1.0,
            stroke_cap_start: StrokeCap::None, stroke_cap_end: StrokeCap::None,
            stroke_join: StrokeJoin::Miter, stroke_miter_limit: DEFAULT_STROKE_MITER_LIMIT,
            stroke_dash_pattern: Vec::new(), stroke_weights: Vec::new(), stroke_align: StrokeAlign::Inside,
            arc_data: None, parametric_shape: None, relative_transform: None, opacity: 1.0, blend_mode: BlendMode::Normal, drop_shadow: None,
            effect_stack: Vec::new(), corner_radius: 0.0,
            corner_radii: Vec::new(),
            corner_smoothing: 0.0,
            constraints: None,
            visible: true, locked: false, contents_hidden: false, clips_content: Some(false),
        };
        document.submit(transaction(1, vec![Command::SetAppearance { id: NodeId(1), appearance: appearance.clone() }]), Origin::LocalUser).unwrap();
        assert!(!document.node(NodeId(1)).unwrap().clips_content);
        assert_eq!(document.node(NodeId(1)).unwrap().fills, appearance.fills);
        assert_eq!(document.node(NodeId(1)).unwrap().strokes, appearance.strokes);
        let unclipped = document.canonical_hash_hex();
        assert_ne!(unclipped, baseline);
        document.undo().unwrap();
        assert!(document.node(NodeId(1)).unwrap().clips_content);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), unclipped);

        let mut rectangle = node(2);
        rectangle.kind = NodeKind::Rectangle;
        rectangle.name = "Rectangle".into();
        document.submit(transaction(4, vec![Command::Create(rectangle)]), Origin::LocalUser).unwrap();
        assert_eq!(document.submit(transaction(5, vec![Command::SetAppearance { id: NodeId(2), appearance: Appearance { clips_content: Some(true), ..appearance } }]), Origin::LocalUser), Err(CommandError::InvalidAppearance));
    }

    #[test]
    fn alpha_mask_flag_is_hashed_undoable_and_requires_a_following_sibling() {
        let mut document = Document::empty();
        let mut mask = node(1);
        mask.kind = NodeKind::Rectangle;
        let mut target = node(2);
        target.kind = NodeKind::Rectangle;
        document.submit(transaction(0, vec![Command::Create(mask), Command::Create(target)]), Origin::LocalUser).unwrap();
        let baseline = document.canonical_hash_hex();

        document.submit(transaction(1, vec![Command::SetMask { id: NodeId(1), enabled: true }]), Origin::LocalUser).unwrap();
        assert!(is_alpha_mask(document.node(NodeId(1)).unwrap()));
        let masked = document.canonical_hash_hex();
        assert_ne!(masked, baseline);
        document.undo().unwrap();
        assert!(!is_alpha_mask(document.node(NodeId(1)).unwrap()));
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), masked);

        assert_eq!(document.submit(transaction(4, vec![Command::SetMask { id: NodeId(2), enabled: true }]), Origin::LocalUser), Err(CommandError::InvalidGeometry));
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
        document.submit(transaction(0, vec![Command::Create(slice), Command::Create(target)]), Origin::LocalUser).unwrap();

        let baseline = document.canonical_hash_hex();
        let mut painted = appearance_for_node(document.node(NodeId(1)).unwrap());
        painted.fill = "#ffffff".into();
        assert_eq!(document.submit(transaction(1, vec![Command::SetAppearance { id: NodeId(1), appearance: painted }]), Origin::LocalUser), Err(CommandError::InvalidAppearance));
        assert_eq!(document.submit(transaction(1, vec![Command::SetMask { id: NodeId(1), enabled: true }]), Origin::LocalUser), Err(CommandError::InvalidGeometry));

        document.submit(transaction(1, vec![Command::UpdateGeometry { id: NodeId(1), x: 24.0, y: 12.0, width: 240.0, height: 160.0, rotation: 15.0 }]), Origin::LocalUser).unwrap();
        assert_ne!(document.canonical_hash_hex(), baseline);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();

        let mut child = node(3);
        child.parent_id = Some(NodeId(1));
        child.kind = NodeKind::Rectangle;
        assert_eq!(document.submit(transaction(4, vec![Command::Create(child)]), Origin::LocalUser), Err(CommandError::InvalidParent { id: NodeId(1) }));
    }

    #[test]
    fn corner_geometry_is_hashed_undoable_and_limited_to_closed_nodes() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.name = "Frame".into();
        frame.clips_content = true;
        document.submit(transaction(0, vec![Command::Create(frame)]), Origin::LocalUser).unwrap();
        let baseline = document.canonical_hash_hex();
        let appearance = Appearance {
            fill: "#fff".into(), stroke: "#000".into(), fills: Vec::new(), strokes: Vec::new(), stroke_width: 1.0,
            stroke_cap_start: StrokeCap::None, stroke_cap_end: StrokeCap::None,
            stroke_join: StrokeJoin::Miter, stroke_miter_limit: DEFAULT_STROKE_MITER_LIMIT,
            stroke_dash_pattern: Vec::new(), stroke_weights: Vec::new(), stroke_align: StrokeAlign::Inside,
            arc_data: None, parametric_shape: None, relative_transform: None, opacity: 1.0, blend_mode: BlendMode::Normal, drop_shadow: None,
            effect_stack: Vec::new(), corner_radius: 0.0,
            corner_radii: vec![4.0, 8.0, 12.0, 16.0],
            corner_smoothing: 0.65,
            constraints: None,
            visible: true, locked: false, contents_hidden: false, clips_content: Some(true),
        };
        document.submit(transaction(1, vec![Command::SetAppearance { id: NodeId(1), appearance: appearance.clone() }]), Origin::LocalUser).unwrap();
        assert_eq!(document.node(NodeId(1)).unwrap().corner_radii, appearance.corner_radii);
        assert_eq!(document.node(NodeId(1)).unwrap().corner_smoothing, 0.65);
        assert_eq!(document.node(NodeId(1)).unwrap().fills, appearance.fills);
        assert_eq!(document.node(NodeId(1)).unwrap().strokes, appearance.strokes);
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
        document.submit(transaction(4, vec![Command::Create(line)]), Origin::LocalUser).unwrap();
        assert_eq!(document.submit(transaction(5, vec![Command::SetAppearance { id: NodeId(2), appearance: appearance.clone() }]), Origin::LocalUser), Err(CommandError::InvalidAppearance));
        assert_eq!(document.submit(transaction(5, vec![Command::SetAppearance { id: NodeId(1), appearance: Appearance { corner_radii: vec![1.0, 2.0], ..appearance.clone() } }]), Origin::LocalUser), Err(CommandError::InvalidAppearance));
        assert_eq!(document.submit(transaction(5, vec![Command::SetAppearance { id: NodeId(1), appearance: Appearance { corner_smoothing: 1.1, ..appearance } }]), Origin::LocalUser), Err(CommandError::InvalidAppearance));
    }

    #[test]
    fn constraints_are_hashed_undoable_and_reject_structural_nodes() {
        let mut document = Document::empty();
        document.submit(transaction(0, vec![Command::Create(node(1))]), Origin::LocalUser).unwrap();
        let baseline = document.canonical_hash_hex();
        let appearance = Appearance {
            fill: "#fff".into(), stroke: "#00000000".into(), fills: Vec::new(), strokes: Vec::new(), stroke_width: 0.0,
            stroke_cap_start: StrokeCap::None, stroke_cap_end: StrokeCap::None, stroke_join: StrokeJoin::Miter,
            stroke_miter_limit: DEFAULT_STROKE_MITER_LIMIT, stroke_dash_pattern: Vec::new(), stroke_weights: Vec::new(), stroke_align: StrokeAlign::Inside,
            arc_data: None, parametric_shape: None, relative_transform: None, opacity: 1.0, blend_mode: BlendMode::Normal, drop_shadow: None,
            effect_stack: Vec::new(), corner_radius: 0.0, corner_radii: Vec::new(), corner_smoothing: 0.0,
            constraints: Some(Constraints { horizontal: ConstraintType::Stretch, vertical: ConstraintType::Center }), visible: true, locked: false, contents_hidden: false, clips_content: Some(true),
        };
        document.submit(transaction(1, vec![Command::SetAppearance { id: NodeId(1), appearance: appearance.clone() }]), Origin::LocalUser).unwrap();
        assert_eq!(document.node(NodeId(1)).unwrap().constraints, appearance.constraints);
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
        document.submit(transaction(4, vec![Command::Create(group), Command::Create(child)]), Origin::LocalUser).unwrap();
        assert_eq!(document.submit(transaction(5, vec![Command::SetAppearance { id: NodeId(2), appearance }]), Origin::LocalUser), Err(CommandError::InvalidAppearance));
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
        child.constraints = Some(Constraints { horizontal: ConstraintType::Stretch, vertical: ConstraintType::Center });
        document.submit(transaction(0, vec![Command::Create(frame), Command::Create(child)]), Origin::LocalUser).unwrap();
        document.submit(transaction(1, vec![Command::UpdateGeometry { id: NodeId(1), x: 0.0, y: 0.0, width: 300.0, height: 200.0, rotation: 0.0 }]), Origin::LocalUser).unwrap();
        let child = document.node(NodeId(2)).unwrap();
        assert_eq!((child.x, child.y, child.width, child.height), (20.0, 70.0, 200.0, 30.0));
        document.undo().unwrap();
        let child = document.node(NodeId(2)).unwrap();
        assert_eq!((child.x, child.y, child.width, child.height), (20.0, 20.0, 100.0, 30.0));
        document.redo().unwrap();
        assert_eq!(document.node(NodeId(2)).unwrap().width, 200.0);
    }

    #[test]
    fn frame_resize_resolves_min_max_and_scale_axes() {
        let mut document = Document::empty();
        let mut frame = node(1); frame.width = 200.0; frame.height = 100.0;
        let child = |id, constraints| { let mut value = node(id); value.kind = NodeKind::Rectangle; value.name = format!("Child {id}"); value.parent_id = Some(NodeId(1)); value.x = 20.0; value.y = 10.0; value.width = 40.0; value.height = 20.0; value.constraints = Some(constraints); value };
        document.submit(transaction(0, vec![Command::Create(frame), Command::Create(child(2, Constraints { horizontal: ConstraintType::Min, vertical: ConstraintType::Min })), Command::Create(child(3, Constraints { horizontal: ConstraintType::Max, vertical: ConstraintType::Max })), Command::Create(child(4, Constraints { horizontal: ConstraintType::Scale, vertical: ConstraintType::Scale }))]), Origin::LocalUser).unwrap();
        document.submit(transaction(1, vec![Command::UpdateGeometry { id: NodeId(1), x: 0.0, y: 0.0, width: 400.0, height: 200.0, rotation: 0.0 }]), Origin::LocalUser).unwrap();
        assert_eq!((document.node(NodeId(2)).unwrap().x, document.node(NodeId(2)).unwrap().y), (20.0, 10.0));
        assert_eq!((document.node(NodeId(3)).unwrap().x, document.node(NodeId(3)).unwrap().y), (220.0, 110.0));
        assert_eq!((document.node(NodeId(4)).unwrap().x, document.node(NodeId(4)).unwrap().y, document.node(NodeId(4)).unwrap().width, document.node(NodeId(4)).unwrap().height), (40.0, 20.0, 80.0, 40.0));
    }

    #[test]
    fn rotated_frame_resize_migrates_legacy_direct_constraints_to_local_matrix_space() {
        let mut document = Document::empty();
        let mut frame = node(1); frame.width = 200.0; frame.height = 100.0;
        let mut child = node(2); child.kind = NodeKind::Rectangle; child.name = "Child".into(); child.parent_id = Some(NodeId(1)); child.x = 20.0; child.y = 20.0; child.constraints = Some(Constraints { horizontal: ConstraintType::Max, vertical: ConstraintType::Max });
        document.submit(transaction(0, vec![Command::Create(frame), Command::Create(child)]), Origin::LocalUser).unwrap();
        document.submit(transaction(1, vec![Command::UpdateGeometry { id: NodeId(1), x: 0.0, y: 0.0, width: 300.0, height: 200.0, rotation: 30.0 }]), Origin::LocalUser).unwrap();
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
        child.constraints = Some(Constraints { horizontal: ConstraintType::Max, vertical: ConstraintType::Max });

        document.submit(transaction(0, vec![Command::Create(frame), Command::Create(group), Command::Create(child)]), Origin::LocalUser).unwrap();
        document.submit(transaction(1, vec![Command::UpdateGeometry {
            id: NodeId(1), x: 0.0, y: 0.0, width: 300.0, height: 200.0, rotation: 30.0,
        }]), Origin::LocalUser).unwrap();

        let group = document.node(NodeId(2)).unwrap();
        let child = document.node(NodeId(3)).unwrap();
        assert_eq!((group.relative_transform.unwrap().e, group.relative_transform.unwrap().f), (20.0, 10.0));
        // The constrained child is (120, 110) in Frame-local space. Its
        // immediate parent is the migrated Group at (20, 10), so the durable
        // matrix stores the local delta rather than a stale world coordinate.
        assert_eq!((child.relative_transform.unwrap().e, child.relative_transform.unwrap().f), (100.0, 100.0));
        let constrained_hash = document.canonical_hash_hex();

        document.undo().unwrap();
        assert!(document.node(NodeId(2)).unwrap().relative_transform.is_none());
        assert!(document.node(NodeId(3)).unwrap().relative_transform.is_none());
        assert_eq!((document.node(NodeId(3)).unwrap().x, document.node(NodeId(3)).unwrap().y), (20.0, 10.0));
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
        child.constraints = Some(Constraints { horizontal: ConstraintType::Max, vertical: ConstraintType::Max });

        document.submit(transaction(0, vec![Command::Create(frame), Command::Create(outer), Command::Create(inner), Command::Create(child)]), Origin::LocalUser).unwrap();
        document.submit(transaction(1, vec![Command::UpdateGeometry {
            id: NodeId(1), x: 0.0, y: 0.0, width: 300.0, height: 200.0, rotation: 30.0,
        }]), Origin::LocalUser).unwrap();

        let outer = document.node(NodeId(2)).unwrap();
        let inner = document.node(NodeId(3)).unwrap();
        let child = document.node(NodeId(4)).unwrap();
        assert_eq!((outer.relative_transform.unwrap().e, outer.relative_transform.unwrap().f), (40.0, 30.0));
        assert_eq!((inner.relative_transform.unwrap().e, inner.relative_transform.unwrap().f), (0.0, 0.0));
        assert_eq!((child.relative_transform.unwrap().e, child.relative_transform.unwrap().f), (100.0, 100.0));
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
        child.constraints = Some(Constraints { horizontal: ConstraintType::Max, vertical: ConstraintType::Max });
        document.submit(transaction(0, vec![Command::Create(frame), Command::Create(group), Command::Create(child)]), Origin::LocalUser).unwrap();

        document.submit(transaction(1, vec![Command::UpdateGeometry {
            id: NodeId(1), x: 0.0, y: 0.0, width: 300.0, height: 200.0, rotation: 30.0,
        }]), Origin::LocalUser).unwrap();
        assert_eq!((document.node(NodeId(3)).unwrap().relative_transform.unwrap().e, document.node(NodeId(3)).unwrap().relative_transform.unwrap().f), (100.0, 100.0));

        document.submit(transaction(2, vec![Command::UpdateGeometry {
            id: NodeId(1), x: 0.0, y: 0.0, width: 200.0, height: 100.0, rotation: 30.0,
        }]), Origin::LocalUser).unwrap();
        assert_eq!((document.node(NodeId(3)).unwrap().relative_transform.unwrap().e, document.node(NodeId(3)).unwrap().relative_transform.unwrap().f), (0.0, 0.0));

        document.submit(transaction(3, vec![Command::UpdateGeometry {
            id: NodeId(1), x: 0.0, y: 0.0, width: 300.0, height: 200.0, rotation: 30.0,
        }]), Origin::LocalUser).unwrap();
        assert_eq!((document.node(NodeId(3)).unwrap().relative_transform.unwrap().e, document.node(NodeId(3)).unwrap().relative_transform.unwrap().f), (100.0, 100.0));
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
        nested_child.constraints = Some(Constraints { horizontal: ConstraintType::Max, vertical: ConstraintType::Max });
        document.submit(transaction(0, vec![Command::Create(frame), Command::Create(group), Command::Create(nested_frame), Command::Create(nested_child)]), Origin::LocalUser).unwrap();

        document.submit(transaction(1, vec![Command::UpdateGeometry {
            id: NodeId(1), x: 0.0, y: 0.0, width: 300.0, height: 200.0, rotation: 30.0,
        }]), Origin::LocalUser).unwrap();

        // The outer Group becomes Relative-v1, but the nested Frame keeps its
        // own legacy layout boundary. Its child must not receive the outer
        // Frame's +100/+100 Max movement.
        assert!(document.node(NodeId(2)).unwrap().relative_transform.is_some());
        assert!(document.node(NodeId(3)).unwrap().relative_transform.is_none());
        assert!(document.node(NodeId(4)).unwrap().relative_transform.is_none());
        assert_eq!((document.node(NodeId(4)).unwrap().x, document.node(NodeId(4)).unwrap().y), (50.0, 40.0));
    }

    #[test]
    fn mirrored_relative_frame_resizes_constraints_in_its_local_axes() {
        let mut document = Document::empty();
        let mut frame = node(1);
        frame.width = 200.0;
        frame.height = 100.0;
        // Horizontal reflection is intentionally on the containing Frame. The
        // child's constraints must continue to use its unmirrored local axes.
        frame.relative_transform = Some(AffineTransform { a: -1.0, b: 0.0, c: 0.0, d: 1.0, e: 200.0, f: 0.0 });
        let mut child = node(2);
        child.kind = NodeKind::Rectangle;
        child.name = "Mirrored frame child".into();
        child.parent_id = Some(NodeId(1));
        child.width = 40.0;
        child.height = 20.0;
        child.relative_transform = Some(AffineTransform { a: 1.0, b: 0.0, c: 0.0, d: 1.0, e: 20.0, f: 10.0 });
        child.constraints = Some(Constraints { horizontal: ConstraintType::Max, vertical: ConstraintType::Max });
        document.submit(transaction(0, vec![Command::Create(frame), Command::Create(child)]), Origin::LocalUser).unwrap();

        document.submit(transaction(1, vec![Command::UpdateGeometry {
            id: NodeId(1), x: 0.0, y: 0.0, width: 300.0, height: 200.0, rotation: 0.0,
        }]), Origin::LocalUser).unwrap();

        let child = document.node(NodeId(2)).unwrap();
        assert_eq!((child.relative_transform.unwrap().e, child.relative_transform.unwrap().f), (120.0, 110.0));
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
        frame.relative_transform = Some(AffineTransform { a: 0.0, b: 1.0, c: -1.0, d: 0.0, e: 300.0, f: 200.0 });

        let mut direct = node(2);
        direct.kind = NodeKind::Rectangle;
        direct.name = "Direct matrix child".into();
        direct.parent_id = Some(NodeId(1));
        direct.width = 40.0;
        direct.height = 20.0;
        direct.relative_transform = Some(AffineTransform { a: 1.0, b: 0.0, c: 0.0, d: 1.0, e: 20.0, f: 10.0 });
        direct.constraints = Some(Constraints { horizontal: ConstraintType::Max, vertical: ConstraintType::Center });

        let mut group = node(3);
        group.kind = NodeKind::Group;
        group.name = "Rotated group".into();
        group.parent_id = Some(NodeId(1));
        group.relative_transform = Some(AffineTransform { a: 0.0, b: 1.0, c: -1.0, d: 0.0, e: 50.0, f: 20.0 });
        let mut nested = node(4);
        nested.kind = NodeKind::Rectangle;
        nested.name = "Nested matrix child".into();
        nested.parent_id = Some(NodeId(3));
        nested.width = 40.0;
        nested.height = 20.0;
        nested.relative_transform = Some(AffineTransform { a: 1.0, b: 0.0, c: 0.0, d: 1.0, e: 10.0, f: 5.0 });
        nested.constraints = Some(Constraints { horizontal: ConstraintType::Stretch, vertical: ConstraintType::Max });

        document.submit(transaction(0, vec![Command::Create(frame), Command::Create(direct), Command::Create(group), Command::Create(nested)]), Origin::LocalUser).unwrap();
        document.submit(transaction(1, vec![Command::UpdateGeometry { id: NodeId(1), x: 0.0, y: 0.0, width: 300.0, height: 200.0, rotation: 0.0 }]), Origin::LocalUser).unwrap();

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
        assert_eq!((direct.relative_transform.unwrap().e, direct.relative_transform.unwrap().f), (20.0, 10.0));
        let nested = document.node(NodeId(4)).unwrap();
        assert_eq!((nested.relative_transform.unwrap().e, nested.relative_transform.unwrap().f, nested.width), (10.0, 5.0, 40.0));
        document.redo().unwrap();
        assert_eq!(document.node(NodeId(4)).unwrap().relative_transform.unwrap().e, 110.0);
    }

    #[test]
    fn frame_resize_propagates_through_groups_and_refreshes_group_bounds() {
        let mut document = Document::empty();
        let mut frame = node(1); frame.width = 200.0; frame.height = 100.0;
        let mut group = node(2); group.kind = NodeKind::Group; group.name = "Group".into(); group.parent_id = Some(NodeId(1)); group.x = 20.0; group.y = 10.0; group.width = 40.0; group.height = 20.0;
        let mut child = node(3); child.kind = NodeKind::Rectangle; child.name = "Child".into(); child.parent_id = Some(NodeId(2)); child.x = 20.0; child.y = 10.0; child.width = 40.0; child.height = 20.0; child.constraints = Some(Constraints { horizontal: ConstraintType::Max, vertical: ConstraintType::Min });
        document.submit(transaction(0, vec![Command::Create(frame), Command::Create(group), Command::Create(child)]), Origin::LocalUser).unwrap();
        document.submit(transaction(1, vec![Command::UpdateGeometry { id: NodeId(1), x: 0.0, y: 0.0, width: 300.0, height: 100.0, rotation: 0.0 }]), Origin::LocalUser).unwrap();
        assert_eq!(document.node(NodeId(3)).unwrap().x, 120.0);
        assert_eq!(document.node(NodeId(2)).unwrap().x, 120.0);
        document.undo().unwrap();
        assert_eq!(document.node(NodeId(3)).unwrap().x, 20.0);
        assert_eq!(document.node(NodeId(2)).unwrap().x, 20.0);
    }

    #[test]
    fn frame_resize_rejects_scale_from_a_zero_sized_axis() {
        let mut document = Document::empty();
        let mut frame = node(1); frame.width = 1.0; frame.height = 100.0;
        let constraints = Constraints { horizontal: ConstraintType::Scale, vertical: ConstraintType::Min };
        let mut child = node(2); child.kind = NodeKind::Rectangle; child.name = "Child".into(); child.parent_id = Some(NodeId(1)); child.constraints = Some(constraints);
        document.submit(transaction(0, vec![Command::Create(frame), Command::Create(child)]), Origin::LocalUser).unwrap();
        // Canonical geometry disallows a zero Frame, so the scale guard is exercised
        // directly through the shared pure geometry rule.
        assert_eq!(geometry_for_constraints(Geometry { x: 0.0, y: 0.0, width: 0.0, height: 100.0, rotation: 0.0 }, Geometry { x: 0.0, y: 0.0, width: 10.0, height: 100.0, rotation: 0.0 }, Geometry { x: 1.0, y: 1.0, width: 10.0, height: 10.0, rotation: 0.0 }, constraints, &NodeKind::Rectangle), Err(CommandError::InvalidGeometry));
    }

    // --- P1-5: named unit fixtures directly over `geometry_for_constraints` ---
    // The five axis rules are asserted as pure geometry so their contract is
    // pinned independently of the transaction plumbing that consumes them.

    // A 100x40 parent doubling to 200x80, child at local (20,10) sized 40x20.
    const PARENT_BEFORE: Geometry = Geometry { x: 10.0, y: 20.0, width: 100.0, height: 40.0, rotation: 0.0 };
    const PARENT_AFTER: Geometry = Geometry { x: 10.0, y: 20.0, width: 200.0, height: 80.0, rotation: 0.0 };
    // World-space child: parent origin (10,20) + local (20,10).
    const CHILD: Geometry = Geometry { x: 30.0, y: 30.0, width: 40.0, height: 20.0, rotation: 0.0 };

    fn constrained(horizontal: ConstraintType, vertical: ConstraintType, kind: &NodeKind) -> Geometry {
        geometry_for_constraints(PARENT_BEFORE, PARENT_AFTER, CHILD, Constraints { horizontal, vertical }, kind).unwrap()
    }

    #[test]
    fn constraint_axis_min_pins_leading_edge_and_keeps_size() {
        let after = constrained(ConstraintType::Min, ConstraintType::Min, &NodeKind::Rectangle);
        // Local offset preserved from the new parent origin; size unchanged.
        assert_eq!((after.x, after.y, after.width, after.height), (30.0, 30.0, 40.0, 20.0));
    }

    #[test]
    fn constraint_axis_max_tracks_trailing_edge() {
        let after = constrained(ConstraintType::Max, ConstraintType::Max, &NodeKind::Rectangle);
        // Width delta +100, height delta +40 shift the local position by the full delta.
        assert_eq!((after.x, after.y, after.width, after.height), (130.0, 70.0, 40.0, 20.0));
    }

    #[test]
    fn constraint_axis_center_tracks_half_delta() {
        let after = constrained(ConstraintType::Center, ConstraintType::Center, &NodeKind::Rectangle);
        assert_eq!((after.x, after.y, after.width, after.height), (80.0, 50.0, 40.0, 20.0));
    }

    #[test]
    fn constraint_axis_stretch_grows_size_by_delta() {
        let after = constrained(ConstraintType::Stretch, ConstraintType::Stretch, &NodeKind::Rectangle);
        // Leading edge fixed; size absorbs the parent delta on each axis.
        assert_eq!((after.x, after.y, after.width, after.height), (30.0, 30.0, 140.0, 60.0));
    }

    #[test]
    fn constraint_axis_scale_multiplies_position_and_size_by_ratio() {
        let after = constrained(ConstraintType::Scale, ConstraintType::Scale, &NodeKind::Rectangle);
        // Ratio 2x horizontal, 2x vertical over local (20,10) sized 40x20.
        assert_eq!((after.x, after.y, after.width, after.height), (50.0, 40.0, 80.0, 40.0));
    }

    #[test]
    fn constraint_mixed_axes_resolve_independently() {
        // Horizontal Max + vertical Scale prove the two axes never share state.
        let after = constrained(ConstraintType::Max, ConstraintType::Scale, &NodeKind::Rectangle);
        assert_eq!((after.x, after.width), (130.0, 40.0));
        assert_eq!((after.y, after.height), (40.0, 40.0));
    }

    #[test]
    fn constraint_line_stretch_preserves_zero_height() {
        // A Line's height must stay exactly zero even under a Stretch vertical
        // rule, matching `valid_geometry`'s Line invariant.
        let line = Geometry { x: 30.0, y: 30.0, width: 40.0, height: 0.0, rotation: 0.0 };
        let after = geometry_for_constraints(PARENT_BEFORE, PARENT_AFTER, line, Constraints { horizontal: ConstraintType::Stretch, vertical: ConstraintType::Stretch }, &NodeKind::Line).unwrap();
        assert_eq!((after.width, after.height), (140.0, 0.0));
    }

    #[test]
    fn constraint_scale_rejects_zero_sized_source_axis_per_axis() {
        // Guard fires the moment either source extent is zero, independent of which axis scales.
        let zero_width = Geometry { x: 0.0, y: 0.0, width: 0.0, height: 40.0, rotation: 0.0 };
        assert_eq!(geometry_for_constraints(zero_width, PARENT_AFTER, CHILD, Constraints { horizontal: ConstraintType::Scale, vertical: ConstraintType::Min }, &NodeKind::Rectangle), Err(CommandError::InvalidGeometry));
        let zero_height = Geometry { x: 0.0, y: 0.0, width: 100.0, height: 0.0, rotation: 0.0 };
        assert_eq!(geometry_for_constraints(zero_height, PARENT_AFTER, CHILD, Constraints { horizontal: ConstraintType::Min, vertical: ConstraintType::Scale }, &NodeKind::Rectangle), Err(CommandError::InvalidGeometry));
    }

    #[test]
    fn constrained_child_under_a_clipping_frame_still_resolves_and_reparent_preserves_the_constraint() {
        let mut document = Document::empty();
        let mut frame = node(1); frame.width = 200.0; frame.height = 100.0; frame.clips_content = true;
        let mut child = node(2); child.kind = NodeKind::Rectangle; child.name = "Child".into(); child.parent_id = Some(NodeId(1)); child.x = 20.0; child.y = 20.0; child.width = 40.0; child.height = 20.0;
        child.constraints = Some(Constraints { horizontal: ConstraintType::Max, vertical: ConstraintType::Center });
        document.submit(transaction(0, vec![Command::Create(frame), Command::Create(child)]), Origin::LocalUser).unwrap();
        document.submit(transaction(1, vec![Command::UpdateGeometry { id: NodeId(1), x: 0.0, y: 0.0, width: 300.0, height: 200.0, rotation: 0.0 }]), Origin::LocalUser).unwrap();
        // Clip state does not alter constraint math: Max x shifts by +100.
        assert_eq!(document.node(NodeId(2)).unwrap().x, 120.0);
        assert!(document.node(NodeId(1)).unwrap().clips_content);

        // Reparenting the constrained child into a Group keeps its constraint record verbatim.
        let mut group = node(3); group.kind = NodeKind::Group; group.name = "Group".into();
        document.submit(transaction(2, vec![Command::Create(group), Command::SetNodeParent { id: NodeId(2), parent_id: Some(NodeId(3)), position: PositionId { key: 5, actor: ActorId(1) } }]), Origin::LocalUser).unwrap();
        assert_eq!(document.node(NodeId(2)).unwrap().constraints, Some(Constraints { horizontal: ConstraintType::Max, vertical: ConstraintType::Center }));
    }

    #[test]
    fn constrained_resize_is_hash_stable_across_replay_and_undo_redo() {
        let build = || {
            let mut document = Document::empty();
            let mut frame = node(1); frame.width = 200.0; frame.height = 100.0;
            let mut child = node(2); child.kind = NodeKind::Rectangle; child.name = "Child".into(); child.parent_id = Some(NodeId(1)); child.x = 20.0; child.y = 10.0; child.width = 40.0; child.height = 20.0;
            child.constraints = Some(Constraints { horizontal: ConstraintType::Scale, vertical: ConstraintType::Max });
            document.submit(transaction(0, vec![Command::Create(frame), Command::Create(child)]), Origin::LocalUser).unwrap();
            document.submit(transaction(1, vec![Command::UpdateGeometry { id: NodeId(1), x: 0.0, y: 0.0, width: 400.0, height: 260.0, rotation: 0.0 }]), Origin::LocalUser).unwrap();
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
            .submit(transaction(0, vec![Command::Create(line)]), Origin::LocalUser)
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
        assert_eq!(styled.stroke_dash_pattern, vec![8.0, 4.0, 2.0, 8.0, 4.0, 2.0]);
        let styled_hash = document.canonical_hash_hex();
        assert_ne!(styled_hash, baseline);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), styled_hash);
    }

    #[test]
    fn rectangle_per_side_stroke_weights_and_ellipse_stroke_align_are_hashed_and_reject_unsupported_nodes() {
        let mut document = Document::empty();
        document
            .submit(transaction(0, vec![Command::Create(node(1))]), Origin::LocalUser)
            .unwrap();
        let baseline = document.canonical_hash_hex();
        let appearance = Appearance {
            fill: "#fff".into(), stroke: "#2563eb".into(), fills: Vec::new(), strokes: Vec::new(), stroke_width: 1.0,
            stroke_cap_start: StrokeCap::None, stroke_cap_end: StrokeCap::None,
            stroke_join: StrokeJoin::Miter, stroke_miter_limit: DEFAULT_STROKE_MITER_LIMIT,
            stroke_dash_pattern: Vec::new(), stroke_weights: vec![1.0, 2.0, 3.0, 4.0], stroke_align: StrokeAlign::Outside, arc_data: None, parametric_shape: None, relative_transform: None,
            opacity: 1.0, blend_mode: BlendMode::Normal, drop_shadow: None,
            effect_stack: Vec::new(), corner_radius: 0.0,
            corner_radii: Vec::new(), corner_smoothing: 0.0, constraints: None, visible: true, locked: false, contents_hidden: false,
            clips_content: Some(false),
        };
        document
            .submit(transaction(1, vec![Command::SetAppearance { id: NodeId(1), appearance: appearance.clone() }]), Origin::LocalUser)
            .unwrap();
        assert_eq!(document.node(NodeId(1)).unwrap().stroke_weights, vec![1.0, 2.0, 3.0, 4.0]);
        assert_eq!(document.node(NodeId(1)).unwrap().stroke_align, StrokeAlign::Outside);
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
            .submit(transaction(4, vec![Command::Create(line)]), Origin::LocalUser)
            .unwrap();
        assert_eq!(
            document.submit(transaction(5, vec![Command::SetAppearance { id: NodeId(2), appearance: appearance.clone() }]), Origin::LocalUser),
            Err(CommandError::InvalidAppearance),
        );

        let mut ellipse = node(3);
        ellipse.kind = NodeKind::Ellipse;
        ellipse.name = "Ellipse".into();
        document
            .submit(transaction(5, vec![Command::Create(ellipse)]), Origin::LocalUser)
            .unwrap();
        let ellipse_appearance = Appearance {
            stroke_weights: Vec::new(),
            stroke_align: StrokeAlign::Outside,
            ..appearance.clone()
        };
        document
            .submit(transaction(6, vec![Command::SetAppearance { id: NodeId(3), appearance: ellipse_appearance.clone() }]), Origin::LocalUser)
            .unwrap();
        assert_eq!(document.node(NodeId(3)).unwrap().stroke_align, StrokeAlign::Outside);
        let arc_appearance = Appearance {
            arc_data: Some(ArcData { starting_angle: 0.0, ending_angle: 90.0, inner_radius: 0.0 }),
            ..ellipse_appearance
        };
        assert_eq!(
            document.submit(transaction(7, vec![Command::SetAppearance { id: NodeId(3), appearance: arc_appearance }]), Origin::LocalUser),
            Err(CommandError::InvalidAppearance),
        );
    }

    #[test]
    fn ellipse_arc_is_hashed_undoable_and_rejected_for_non_ellipse() {
        let mut document = Document::empty();
        let mut ellipse = node(1);
        ellipse.kind = NodeKind::Ellipse;
        ellipse.name = "Arc".into();
        document.submit(transaction(0, vec![Command::Create(ellipse)]), Origin::LocalUser).unwrap();
        let baseline = document.canonical_hash_hex();
        let appearance = Appearance {
            fill: "#fff".into(), stroke: "#000".into(), fills: Vec::new(), strokes: Vec::new(), stroke_width: 1.0,
            stroke_cap_start: StrokeCap::None, stroke_cap_end: StrokeCap::None,
            stroke_join: StrokeJoin::Miter, stroke_miter_limit: DEFAULT_STROKE_MITER_LIMIT,
            stroke_dash_pattern: Vec::new(), stroke_weights: Vec::new(), stroke_align: StrokeAlign::Inside,
            arc_data: Some(ArcData { starting_angle: 0.0, ending_angle: 180.0, inner_radius: 0.4 }), parametric_shape: None, relative_transform: None,
            opacity: 1.0, blend_mode: BlendMode::Normal, drop_shadow: None,
            effect_stack: Vec::new(), corner_radius: 0.0,
            corner_radii: Vec::new(), corner_smoothing: 0.0, constraints: None, visible: true, locked: false, contents_hidden: false,
            clips_content: Some(false),
        };
        document.submit(transaction(1, vec![Command::SetAppearance { id: NodeId(1), appearance: appearance.clone() }]), Origin::LocalUser).unwrap();
        assert_eq!(document.node(NodeId(1)).unwrap().arc_data, appearance.arc_data);
        let arc_hash = document.canonical_hash_hex();
        assert_ne!(arc_hash, baseline);
        document.undo().unwrap(); assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap(); assert_eq!(document.canonical_hash_hex(), arc_hash);
        assert_eq!(document.submit(transaction(4, vec![Command::SetAppearance { id: NodeId(1), appearance: Appearance { arc_data: None, ..appearance } }]), Origin::LocalUser).unwrap().accepted_revision, 5);
    }

    #[test]
    fn relative_transform_is_hashed_undoable_and_rejects_singular_matrices() {
        let mut document = Document::empty();
        document.submit(transaction(0, vec![Command::Create(node(1))]), Origin::LocalUser).unwrap();
        let baseline = document.canonical_hash_hex();
        let appearance = Appearance {
            fill: "#fff".into(), stroke: "#00000000".into(), fills: Vec::new(), strokes: Vec::new(), stroke_width: 0.0,
            stroke_cap_start: StrokeCap::None, stroke_cap_end: StrokeCap::None,
            stroke_join: StrokeJoin::Miter, stroke_miter_limit: DEFAULT_STROKE_MITER_LIMIT,
            stroke_dash_pattern: Vec::new(), stroke_weights: Vec::new(), stroke_align: StrokeAlign::Inside,
            arc_data: None,
            parametric_shape: None,
            relative_transform: Some(AffineTransform { a: 0.0, b: 1.0, c: -1.0, d: 0.0, e: 40.0, f: 20.0 }),
            opacity: 1.0, blend_mode: BlendMode::Normal, drop_shadow: None,
            effect_stack: Vec::new(), corner_radius: 0.0,
            corner_radii: Vec::new(), corner_smoothing: 0.0, constraints: None, visible: true, locked: false, contents_hidden: false,
            clips_content: Some(false),
        };
        document.submit(transaction(1, vec![Command::SetAppearance { id: NodeId(1), appearance: appearance.clone() }]), Origin::LocalUser).unwrap();
        assert_eq!(document.node(NodeId(1)).unwrap().relative_transform, appearance.relative_transform);
        let transformed = document.canonical_hash_hex();
        assert_ne!(transformed, baseline);
        document.undo().unwrap();
        assert_eq!(document.node(NodeId(1)).unwrap().relative_transform, None);
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), transformed);

        let singular = Appearance { relative_transform: Some(AffineTransform { a: 0.0, b: 0.0, c: 0.0, d: 0.0, e: 0.0, f: 0.0 }), ..appearance };
        assert_eq!(
            document.submit(transaction(4, vec![Command::SetAppearance { id: NodeId(1), appearance: singular }]), Origin::LocalUser),
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
    fn rich_text_properties_are_canonical_validated_and_undoable() {
        let font = AssetReference {
            asset_id: AssetId(12),
            content_hash: [12; 32],
            media_type: "font/woff2".into(),
            byte_length: 256,
            dimensions: None,
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
                },
            ],
            paragraph: ParagraphStyle {
                alignment: TextAlign::Center,
                line_height: Some(24.0),
                paragraph_spacing: 8.0,
            },
            auto_size: TextAutoSize::Height,
            fallback_fonts: vec![font_reference.clone()],
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
            .submit(transaction(0, vec![Command::Create(text)]), Origin::LocalUser)
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
            }],
            ..TextProperties::default()
        };
        document
            .submit(
                transaction(1, vec![Command::SetTextProperties { id: NodeId(1), properties: properties.clone() }]),
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
        invalid.runs[0].color = Some(Color { space: ColorSpace::Srgb, components: [f32::NAN, 0.0, 0.0], alpha: 1.0 });
        assert_eq!(
            document.submit(
                transaction(document.revision, vec![Command::SetTextProperties { id: NodeId(1), properties: invalid }]),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidTextProperties),
        );
    }

    #[test]
    fn drop_shadow_is_hashed_undoable_and_rejects_invalid_or_structural_usage() {
        let mut document = Document::empty();
        document.submit(transaction(0, vec![Command::Create(node(1))]), Origin::LocalUser).unwrap();
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
        document.submit(transaction(1, vec![Command::SetAppearance { id: NodeId(1), appearance: appearance.clone() }]), Origin::LocalUser).unwrap();
        let shadowed = document.canonical_hash_hex();
        assert_ne!(shadowed, baseline);
        assert_eq!(document.node(NodeId(1)).unwrap().drop_shadow, appearance.drop_shadow);
        assert_eq!(document.node(NodeId(1)).unwrap().effect_stack, appearance.effect_stack);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), shadowed);

        let mut invalid = appearance.clone();
        invalid.drop_shadow.as_mut().unwrap().blur_radius = f64::NAN;
        assert_eq!(document.submit(transaction(document.revision, vec![Command::SetAppearance { id: NodeId(1), appearance: invalid }]), Origin::LocalUser), Err(CommandError::InvalidAppearance));

        let mut conflicting_legacy = appearance.clone();
        conflicting_legacy.drop_shadow = None;
        assert_eq!(
            document.submit(
                transaction(document.revision, vec![Command::SetAppearance { id: NodeId(1), appearance: conflicting_legacy }]),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidAppearance),
        );

        let mut multiple_effects = appearance.clone();
        multiple_effects.effect_stack.push(Effect::DropShadow(DropShadow {
            offset_x: -2.0,
            offset_y: 3.0,
            blur_radius: 4.0,
            spread: 0.0,
            color: Color::from_srgb_u8([255, 255, 255], 64),
            visible: true,
        }));
        document.submit(
            transaction(document.revision, vec![Command::SetAppearance { id: NodeId(1), appearance: multiple_effects.clone() }]),
            Origin::LocalUser,
        ).unwrap();
        assert_eq!(document.node(NodeId(1)).unwrap().effect_stack, multiple_effects.effect_stack);

        let mut layer_blurred = multiple_effects.clone();
        layer_blurred.effect_stack.push(Effect::LayerBlur(LayerBlur { radius: 24.0, visible: true }));
        document.submit(
            transaction(document.revision, vec![Command::SetAppearance { id: NodeId(1), appearance: layer_blurred.clone() }]),
            Origin::LocalUser,
        ).unwrap();
        let blurred_hash = document.canonical_hash_hex();
        assert_ne!(blurred_hash, shadowed);
        document.undo().unwrap();
        assert_eq!(document.node(NodeId(1)).unwrap().effect_stack, multiple_effects.effect_stack);
        document.redo().unwrap();
        assert_eq!(document.node(NodeId(1)).unwrap().effect_stack, layer_blurred.effect_stack);

        let mut inner_shadowed = layer_blurred.clone();
        inner_shadowed.effect_stack.push(Effect::InnerShadow(InnerShadow {
            offset_x: -3.0, offset_y: 5.0, blur_radius: 10.0, spread: 1.0,
            color: Color::from_srgb_u8([2, 6, 23], 80), visible: true,
        }));
        document.submit(
            transaction(document.revision, vec![Command::SetAppearance { id: NodeId(1), appearance: inner_shadowed.clone() }]),
            Origin::LocalUser,
        ).unwrap();
        assert_eq!(document.node(NodeId(1)).unwrap().effect_stack, inner_shadowed.effect_stack);
        document.undo().unwrap();
        assert_eq!(document.node(NodeId(1)).unwrap().effect_stack, layer_blurred.effect_stack);
        document.redo().unwrap();
        assert_eq!(document.node(NodeId(1)).unwrap().effect_stack, inner_shadowed.effect_stack);

        let mut invalid_layer_blur = layer_blurred.clone();
        invalid_layer_blur.effect_stack.push(Effect::LayerBlur(LayerBlur { radius: 257.0, visible: true }));
        assert_eq!(
            document.submit(transaction(document.revision, vec![Command::SetAppearance { id: NodeId(1), appearance: invalid_layer_blur }]), Origin::LocalUser),
            Err(CommandError::InvalidAppearance),
        );

        let mut too_many_effects = multiple_effects;
        while too_many_effects.effect_stack.len() <= MAX_EFFECTS_PER_NODE {
            too_many_effects.effect_stack.push(Effect::DropShadow(appearance.drop_shadow.unwrap()));
        }
        assert_eq!(
            document.submit(
                transaction(document.revision, vec![Command::SetAppearance { id: NodeId(1), appearance: too_many_effects }]),
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
        document.submit(transaction(document.revision, vec![Command::Create(group), Command::Create(child)]), Origin::LocalUser).unwrap();
        let mut group_appearance = appearance_for_node(document.node(NodeId(2)).unwrap());
        group_appearance.drop_shadow = appearance.drop_shadow;
        assert_eq!(document.submit(transaction(document.revision, vec![Command::SetAppearance { id: NodeId(2), appearance: group_appearance }]), Origin::LocalUser), Err(CommandError::InvalidAppearance));
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
        document.submit(transaction(0, vec![Command::Create(polygon)]), Origin::LocalUser).unwrap();
        let five_points = document.canonical_hash_hex();

        let mut appearance = appearance_for_node(document.node(NodeId(1)).unwrap());
        appearance.parametric_shape = Some(ParametricShape::Polygon { point_count: 6 });
        document.submit(transaction(1, vec![Command::SetAppearance { id: NodeId(1), appearance }]), Origin::LocalUser).unwrap();
        let six_points = document.canonical_hash_hex();
        assert_ne!(five_points, six_points);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), five_points);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), six_points);

        let mut invalid = appearance_for_node(document.node(NodeId(1)).unwrap());
        invalid.parametric_shape = Some(ParametricShape::Star { point_count: 5, inner_ratio: 0.5 });
        assert_eq!(
            document.submit(transaction(4, vec![Command::SetAppearance { id: NodeId(1), appearance: invalid }]), Origin::LocalUser),
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
        union_document.submit(transaction(0, union_commands), Origin::LocalUser).unwrap();
        let mut subtract_document = Document::empty();
        let mut subtract_commands = vec![Command::Create(subtract)];
        subtract_commands.extend(operands());
        subtract_document.submit(transaction(0, subtract_commands), Origin::LocalUser).unwrap();
        assert_ne!(union_document.canonical_hash_hex(), subtract_document.canonical_hash_hex());

        let mut incomplete = node(6);
        incomplete.kind = NodeKind::BooleanOperation;
        incomplete.boolean_operation = Some(BooleanOperation::Union);
        assert_eq!(
            Document::empty().submit(transaction(0, vec![Command::Create(incomplete)]), Origin::LocalUser),
            Err(CommandError::InsufficientBooleanOperands { id: NodeId(6) }),
        );

        let mut missing_operation = node(2);
        missing_operation.kind = NodeKind::BooleanOperation;
        assert_eq!(
            Document::empty().submit(transaction(0, vec![Command::Create(missing_operation)]), Origin::LocalUser),
            Err(CommandError::InvalidGeometry),
        );

        let mut misplaced_operation = node(3);
        misplaced_operation.boolean_operation = Some(BooleanOperation::Union);
        assert_eq!(
            Document::empty().submit(transaction(0, vec![Command::Create(misplaced_operation)]), Origin::LocalUser),
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
        assert_eq!((boolean.x, boolean.y, boolean.width, boolean.height), (10.0, 20.0, 100.0, 100.0));

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
        document.submit(
            transaction(0, vec![Command::Create(boolean), Command::Create(first), Command::Create(second)]),
            Origin::LocalUser,
        ).unwrap();
        let union = document.canonical_hash_hex();

        document.submit(
            transaction(1, vec![Command::SetBooleanOperation { id: NodeId(1), operation: BooleanOperation::Subtract }]),
            Origin::LocalUser,
        ).unwrap();
        let subtract = document.canonical_hash_hex();
        assert_ne!(union, subtract);
        assert_eq!(document.node(NodeId(1)).unwrap().boolean_operation, Some(BooleanOperation::Subtract));
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
                    VectorPoint { id: PointId(1), position: Point { x: 0.0, y: 0.0 }, handle_in: None, handle_out: None, point_type: VectorPointType::Corner },
                    VectorPoint { id: PointId(2), position: Point { x: 100.0, y: 0.0 }, handle_in: None, handle_out: Some(Point { x: 8.0, y: 0.0 }), point_type: VectorPointType::Asymmetric },
                    VectorPoint { id: PointId(3), position: Point { x: 50.0, y: 100.0 }, handle_in: None, handle_out: None, point_type: VectorPointType::Corner },
                ],
            }],
        };
        let mut vector = node(1);
        vector.kind = NodeKind::Vector;
        vector.name = "Triangle".into();
        vector.vector_path = Some(path.clone());
        let mut document = Document::empty();
        document.submit(transaction(0, vec![Command::Create(vector)]), Origin::LocalUser).unwrap();
        let baseline = document.canonical_hash_hex();

        let mut updated = path.clone();
        updated.fill_rule = FillRule::EvenOdd;
        document.submit(transaction(1, vec![Command::SetVectorPath { id: NodeId(1), path: updated }]), Origin::LocalUser).unwrap();
        let changed = document.canonical_hash_hex();
        assert_ne!(changed, baseline);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), changed);

        let duplicate = VectorPath { fill_rule: FillRule::NonZero, subpaths: vec![VectorSubpath { closed: false, points: vec![
            VectorPoint { id: PointId(9), position: Point { x: 0.0, y: 0.0 }, handle_in: None, handle_out: None, point_type: VectorPointType::Corner },
            VectorPoint { id: PointId(9), position: Point { x: 20.0, y: 20.0 }, handle_in: None, handle_out: None, point_type: VectorPointType::Corner },
        ] }] };
        assert_eq!(document.submit(transaction(4, vec![Command::SetVectorPath { id: NodeId(1), path: duplicate }]), Origin::LocalUser), Err(CommandError::InvalidGeometry));

        let mut degenerate = path;
        degenerate.subpaths[0].points[1].position = degenerate.subpaths[0].points[0].position;
        assert_eq!(document.submit(transaction(4, vec![Command::SetVectorPath { id: NodeId(1), path: degenerate }]), Origin::LocalUser), Err(CommandError::InvalidGeometry));
    }

    #[test]
    fn named_vector_point_commands_are_validated_hashed_and_undoable() {
        let path = VectorPath {
            fill_rule: FillRule::NonZero,
            subpaths: vec![VectorSubpath {
                closed: true,
                points: vec![
                    VectorPoint { id: PointId(1), position: Point { x: 0.0, y: 0.0 }, handle_in: None, handle_out: None, point_type: VectorPointType::Corner },
                    VectorPoint { id: PointId(2), position: Point { x: 100.0, y: 0.0 }, handle_in: None, handle_out: None, point_type: VectorPointType::Corner },
                    VectorPoint { id: PointId(3), position: Point { x: 50.0, y: 100.0 }, handle_in: None, handle_out: None, point_type: VectorPointType::Corner },
                ],
            }],
        };
        let mut vector = node(1);
        vector.kind = NodeKind::Vector;
        vector.vector_path = Some(path);
        let mut document = Document::empty();
        document.submit(transaction(0, vec![Command::Create(vector)]), Origin::LocalUser).unwrap();
        let baseline = document.canonical_hash_hex();

        document.submit(
            transaction(1, vec![Command::MoveVectorPoint {
                id: NodeId(1),
                point_id: PointId(2),
                position: Point { x: 120.0, y: 10.0 },
            }]),
            Origin::LocalUser,
        ).unwrap();
        let moved = document.canonical_hash_hex();
        assert_ne!(moved, baseline);
        assert_eq!(
            document.node(NodeId(1)).unwrap().vector_path.as_ref().unwrap().subpaths[0].points[1].position,
            Point { x: 120.0, y: 10.0 },
        );
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), moved);

        document.submit(
            transaction(document.revision, vec![Command::SetVectorSubpathClosed {
                id: NodeId(1),
                subpath_index: 0,
                closed: false,
            }]),
            Origin::LocalUser,
        ).unwrap();
        let open = document.canonical_hash_hex();
        assert_ne!(open, moved);
        assert!(!document.node(NodeId(1)).unwrap().vector_path.as_ref().unwrap().subpaths[0].closed);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), moved);

        document.submit(
            transaction(document.revision, vec![Command::SetVectorPointHandles {
                id: NodeId(1),
                point_id: PointId(2),
                handle_in: Some(Point { x: -12.0, y: 4.0 }),
                handle_out: Some(Point { x: 18.0, y: -6.0 }),
                point_type: VectorPointType::Asymmetric,
            }]),
            Origin::LocalUser,
        ).unwrap();
        let point = &document.node(NodeId(1)).unwrap().vector_path.as_ref().unwrap().subpaths[0].points[1];
        assert_eq!(point.handle_in, Some(Point { x: -12.0, y: 4.0 }));
        assert_eq!(point.point_type, VectorPointType::Asymmetric);

        assert_eq!(
            document.submit(
                transaction(document.revision, vec![Command::MoveVectorPoint {
                    id: NodeId(1),
                    point_id: PointId(99),
                    position: Point { x: 10.0, y: 10.0 },
                }]),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidGeometry),
        );
        assert_eq!(
            document.submit(
                transaction(document.revision, vec![Command::SetVectorSubpathClosed {
                    id: NodeId(1),
                    subpath_index: 99,
                    closed: false,
                }]),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidGeometry),
        );

        document.submit(
            transaction(document.revision, vec![Command::InsertVectorPoint {
                id: NodeId(1),
                subpath_index: 0,
                after_point_id: Some(PointId(2)),
                point: VectorPoint { id: PointId(4), position: Point { x: 80.0, y: 40.0 }, handle_in: None, handle_out: None, point_type: VectorPointType::Corner },
            }]),
            Origin::LocalUser,
        ).unwrap();
        assert_eq!(document.node(NodeId(1)).unwrap().vector_path.as_ref().unwrap().subpaths[0].points[2].id, PointId(4));
        document.undo().unwrap();
        assert_eq!(document.node(NodeId(1)).unwrap().vector_path.as_ref().unwrap().subpaths[0].points.len(), 3);

        document.submit(
            transaction(document.revision, vec![Command::SetVectorSubpathClosed { id: NodeId(1), subpath_index: 0, closed: false }]),
            Origin::LocalUser,
        ).unwrap();
        document.submit(
            transaction(document.revision, vec![Command::DeleteVectorPoint { id: NodeId(1), point_id: PointId(2) }]),
            Origin::LocalUser,
        ).unwrap();
        assert_eq!(document.node(NodeId(1)).unwrap().vector_path.as_ref().unwrap().subpaths[0].points.len(), 2);
    }

    #[test]
    fn blend_mode_is_hashed_and_undoable() {
        let mut document = Document::empty();
        document.submit(transaction(0, vec![Command::Create(node(1))]), Origin::LocalUser).unwrap();
        let baseline = document.canonical_hash_hex();
        let mut appearance = appearance_for_node(document.node(NodeId(1)).unwrap());
        appearance.blend_mode = BlendMode::Multiply;

        document.submit(transaction(1, vec![Command::SetAppearance { id: NodeId(1), appearance }]), Origin::LocalUser).unwrap();
        let blended = document.canonical_hash_hex();
        assert_eq!(document.node(NodeId(1)).unwrap().blend_mode, BlendMode::Multiply);
        assert_ne!(blended, baseline);
        document.undo().unwrap();
        assert_eq!(document.node(NodeId(1)).unwrap().blend_mode, BlendMode::Normal);
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), blended);
    }

    #[test]
    fn split_vector_segment_preserves_cubic_curve_and_undo_redo_hash() {
        let path = VectorPath {
            fill_rule: FillRule::NonZero,
            subpaths: vec![VectorSubpath {
                closed: false,
                points: vec![
                    VectorPoint { id: PointId(1), position: Point { x: 0.0, y: 0.0 }, handle_in: None, handle_out: Some(Point { x: 0.0, y: 10.0 }), point_type: VectorPointType::Asymmetric },
                    VectorPoint { id: PointId(2), position: Point { x: 10.0, y: 0.0 }, handle_in: Some(Point { x: 0.0, y: 10.0 }), handle_out: None, point_type: VectorPointType::Asymmetric },
                ],
            }],
        };
        let mut vector = node(1);
        vector.kind = NodeKind::Vector;
        vector.vector_path = Some(path);
        let mut document = Document::empty();
        document.submit(transaction(0, vec![Command::Create(vector)]), Origin::LocalUser).unwrap();
        let baseline = document.canonical_hash_hex();

        document.submit(transaction(1, vec![Command::SplitVectorSegment {
            id: NodeId(1), subpath_index: 0, after_point_id: PointId(1), t: 0.5, point_id: PointId(3),
        }]), Origin::LocalUser).unwrap();
        let split = document.canonical_hash_hex();
        let points = &document.node(NodeId(1)).unwrap().vector_path.as_ref().unwrap().subpaths[0].points;
        assert_eq!(points.len(), 3);
        assert_eq!(points[0].handle_out, Some(Point { x: 0.0, y: 5.0 }));
        assert_eq!(points[1], VectorPoint { id: PointId(3), position: Point { x: 5.0, y: 7.5 }, handle_in: Some(Point { x: -2.5, y: 0.0 }), handle_out: Some(Point { x: 2.5, y: 0.0 }), point_type: VectorPointType::Asymmetric });
        assert_eq!(points[2].handle_in, Some(Point { x: 0.0, y: 5.0 }));
        assert_ne!(split, baseline);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(document.canonical_hash_hex(), split);
        assert_eq!(document.submit(transaction(document.revision, vec![Command::SplitVectorSegment {
            id: NodeId(1), subpath_index: 0, after_point_id: PointId(3), t: 1.0, point_id: PointId(4),
        }]), Origin::LocalUser), Err(CommandError::InvalidGeometry));
    }

    #[test]
    fn connect_vector_endpoints_merges_open_subpaths_and_preserves_undo() {
        let path = VectorPath {
            fill_rule: FillRule::NonZero,
            subpaths: vec![
                VectorSubpath { closed: false, points: vec![
                    VectorPoint { id: PointId(1), position: Point { x: 0.0, y: 0.0 }, handle_in: None, handle_out: None, point_type: VectorPointType::Corner },
                    VectorPoint { id: PointId(2), position: Point { x: 10.0, y: 0.0 }, handle_in: None, handle_out: None, point_type: VectorPointType::Corner },
                ] },
                VectorSubpath { closed: false, points: vec![
                    VectorPoint { id: PointId(3), position: Point { x: 20.0, y: 0.0 }, handle_in: None, handle_out: None, point_type: VectorPointType::Corner },
                    VectorPoint { id: PointId(4), position: Point { x: 30.0, y: 0.0 }, handle_in: None, handle_out: None, point_type: VectorPointType::Corner },
                ] },
            ],
        };
        let mut vector = node(1);
        vector.kind = NodeKind::Vector;
        vector.vector_path = Some(path);
        let mut document = Document::empty();
        document.submit(transaction(0, vec![Command::Create(vector)]), Origin::LocalUser).unwrap();
        let baseline = document.canonical_hash_hex();

        document.submit(transaction(1, vec![Command::ConnectVectorEndpoints {
            id: NodeId(1), first_subpath_index: 0, first_point_id: PointId(2), second_subpath_index: 1, second_point_id: PointId(3),
        }]), Origin::LocalUser).unwrap();
        let subpaths = &document.node(NodeId(1)).unwrap().vector_path.as_ref().unwrap().subpaths;
        assert_eq!(subpaths.len(), 1);
        assert_eq!(subpaths[0].points.iter().map(|point| point.id).collect::<Vec<_>>(), vec![PointId(1), PointId(2), PointId(3), PointId(4)]);
        assert!(!subpaths[0].closed);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), baseline);
        document.redo().unwrap();
        assert_eq!(document.node(NodeId(1)).unwrap().vector_path.as_ref().unwrap().subpaths.len(), 1);
    }

    #[test]
    fn connect_vector_endpoints_closes_opposite_ends_of_one_subpath() {
        let path = VectorPath {
            fill_rule: FillRule::NonZero,
            subpaths: vec![VectorSubpath { closed: false, points: vec![
                VectorPoint { id: PointId(1), position: Point { x: 0.0, y: 0.0 }, handle_in: None, handle_out: None, point_type: VectorPointType::Corner },
                VectorPoint { id: PointId(2), position: Point { x: 20.0, y: 0.0 }, handle_in: None, handle_out: None, point_type: VectorPointType::Corner },
                VectorPoint { id: PointId(3), position: Point { x: 10.0, y: 20.0 }, handle_in: None, handle_out: None, point_type: VectorPointType::Corner },
            ] }],
        };
        let mut vector = node(1);
        vector.kind = NodeKind::Vector;
        vector.vector_path = Some(path);
        let mut document = Document::empty();
        document.submit(transaction(0, vec![Command::Create(vector)]), Origin::LocalUser).unwrap();

        document.submit(transaction(1, vec![Command::ConnectVectorEndpoints {
            id: NodeId(1), first_subpath_index: 0, first_point_id: PointId(1), second_subpath_index: 0, second_point_id: PointId(3),
        }]), Origin::LocalUser).unwrap();
        assert!(document.node(NodeId(1)).unwrap().vector_path.as_ref().unwrap().subpaths[0].closed);
    }
}
