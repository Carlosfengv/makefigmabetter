//! Browser bridge for the canonical Rust document core.
//!
//! Rendering deliberately stays outside this crate. The Engine Worker owns the
//! canvas/GPU resources while this adapter owns only durable document semantics.

use editor_core::{
    ActorId, Appearance, ArcData, AssetId, AssetReference, Command, ConstraintType, Constraints, DEFAULT_PAGE_ID, Document, DocumentId,
    FontReference, Node, NodeId, NodeKind, OperationEnvelope, OperationId, Origin, Page, PageId,
    ParagraphStyle, PositionId, StrokeAlign, StrokeCap, StrokeJoin, TextAlign, TextAutoSize, TextProperties, TextStyleRun,
    Transaction, TransactionId,
    color::{Color, ColorSpace, DocumentColorProfile, GradientStop, LinearGradient, Paint},
    geometry::{DecorativeCapStyle, PerSideStrokeAlign, Point, StrokeCapStyle, StrokeJoinStyle, StrokeStyle, decorative_cap_mesh, stroke_mesh_for_continuous_rounded_rectangle_with_radii, stroke_mesh_for_dashed_line, stroke_mesh_for_dashed_polyline, stroke_mesh_for_dashed_rounded_rectangle_with_radii, stroke_mesh_for_polyline, stroke_mesh_for_rounded_rectangle, stroke_mesh_for_rounded_rectangle_with_radii, stroke_meshes_for_per_side_rectangle, stroke_meshes_for_per_side_rectangle_with_dash},
};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct DocumentEngine {
    document: Document,
}

impl DocumentEngine {
    fn submit_resolved_operation(
        &mut self,
        transaction: Transaction,
        origin: Origin,
    ) -> Result<u64, editor_core::CommandError> {
        let operation_id = OperationId(transaction.id.0);
        self.document
            .submit_operation(
                OperationEnvelope::new(
                    self.document.id(),
                    operation_id,
                    ActorId(0),
                    vec![],
                    transaction,
                ),
                origin,
            )
            .map(|applied| applied.accepted_revision)
    }

    fn submit_create(
        &mut self,
        transaction_id: NodeId,
        base_revision: u64,
        node: Node,
        origin: Origin,
    ) -> Result<u64, editor_core::CommandError> {
        let transaction = Transaction {
            id: TransactionId(transaction_id.0),
            base_revision,
            commands: vec![Command::Create(node)],
        };
        self.submit_resolved_operation(transaction, origin)
    }

    fn submit_create_on_page(
        &mut self,
        transaction_id: NodeId,
        base_revision: u64,
        page_id: PageId,
        node: Node,
        origin: Origin,
    ) -> Result<u64, editor_core::CommandError> {
        self.submit_resolved_operation(
            Transaction {
                id: TransactionId(transaction_id.0),
                base_revision,
                commands: vec![Command::CreateInPage { page_id, node }],
            },
            origin,
        )
    }

    fn submit_create_page(
        &mut self,
        transaction_id: NodeId,
        base_revision: u64,
        page: Page,
    ) -> Result<u64, editor_core::CommandError> {
        self.submit_resolved_operation(
            Transaction {
                id: TransactionId(transaction_id.0),
                base_revision,
                commands: vec![Command::CreatePage(page)],
            },
            Origin::LocalUser,
        )
    }

    fn submit_rename(
        &mut self,
        transaction_id: NodeId,
        base_revision: u64,
        node_id: NodeId,
        name: String,
    ) -> Result<u64, editor_core::CommandError> {
        let transaction = Transaction {
            id: TransactionId(transaction_id.0),
            base_revision,
            commands: vec![Command::Rename { id: node_id, name }],
        };
        self.submit_resolved_operation(transaction, Origin::LocalUser)
    }

    fn submit_document_color_profile(
        &mut self,
        transaction_id: NodeId,
        base_revision: u64,
        profile: DocumentColorProfile,
    ) -> Result<u64, editor_core::CommandError> {
        let transaction = Transaction {
            id: TransactionId(transaction_id.0),
            base_revision,
            commands: vec![Command::SetDocumentColorProfile { profile }],
        };
        self.submit_resolved_operation(transaction, Origin::LocalUser)
    }

    fn submit_register_asset(
        &mut self,
        transaction_id: NodeId,
        base_revision: u64,
        asset: AssetReference,
    ) -> Result<u64, editor_core::CommandError> {
        self.submit_resolved_operation(
            Transaction {
                id: TransactionId(transaction_id.0),
                base_revision,
                commands: vec![Command::RegisterAsset { asset }],
            },
            Origin::LocalUser,
        )
    }

    fn submit_update(
        &mut self,
        transaction_id: NodeId,
        base_revision: u64,
        node_id: NodeId,
        name: String,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        rotation: f64,
        appearance: Appearance,
        text: String,
    ) -> Result<u64, editor_core::CommandError> {
        let transaction = Transaction {
            id: TransactionId(transaction_id.0),
            base_revision,
            commands: {
                let mut commands = vec![
                    Command::UpdateGeometry {
                        id: node_id,
                        x,
                        y,
                        width,
                        height,
                        rotation,
                    },
                    Command::Rename { id: node_id, name },
                    Command::SetAppearance {
                        id: node_id,
                        appearance,
                    },
                ];
                if self
                    .document
                    .node(node_id)
                    .is_some_and(|node| node.kind == NodeKind::Text)
                {
                    commands.push(Command::SetText { id: node_id, text });
                }
                commands
            },
        };
        self.submit_resolved_operation(transaction, Origin::LocalUser)
    }

    fn submit_delete(
        &mut self,
        transaction_id: NodeId,
        base_revision: u64,
        node_ids: Vec<NodeId>,
    ) -> Result<u64, editor_core::CommandError> {
        let transaction = Transaction {
            id: TransactionId(transaction_id.0),
            base_revision,
            commands: node_ids
                .into_iter()
                .map(|id| Command::Delete { id })
                .collect(),
        };
        self.submit_resolved_operation(transaction, Origin::LocalUser)
    }

    fn submit_move(
        &mut self,
        transaction_id: NodeId,
        base_revision: u64,
        updates: Vec<GeometryCommand>,
    ) -> Result<u64, editor_core::CommandError> {
        let mut commands = Vec::with_capacity(updates.len());
        for update in updates {
            let rotation = update.rotation.unwrap_or_else(|| {
                self.document
                    .node(update.id)
                    .map(|node| node.rotation)
                    .unwrap_or(f64::NAN)
            });
            commands.push(Command::UpdateGeometry {
                id: update.id,
                x: update.x,
                y: update.y,
                width: update.width,
                height: update.height,
                rotation,
            });
        }
        let transaction = Transaction {
            id: TransactionId(transaction_id.0),
            base_revision,
            commands,
        };
        self.submit_resolved_operation(transaction, Origin::LocalUser)
    }

    fn submit_batch(
        &mut self,
        transaction_id: NodeId,
        base_revision: u64,
        batch: Vec<BatchCommand>,
    ) -> Result<u64, JsValue> {
        let mut commands = Vec::new();
        for command in batch {
            match command {
                BatchCommand::Create { node } => {
                    let text_properties =
                        text_properties_from_projection(node.text_properties.as_ref())?;
                    let page_id = node
                        .page_id
                        .as_deref()
                        .map(parse_page_id)
                        .transpose()?
                        .unwrap_or(DEFAULT_PAGE_ID);
                    let asset_id = node
                        .asset_id
                        .as_deref()
                        .map(parse_id)
                        .transpose()?
                        .map(|id| AssetId(id.0));
                    let node = node_from_projection(node)?;
                    if node.kind == NodeKind::Image {
                        commands.push(Command::CreateImageInPage {
                            page_id,
                            node,
                            asset_id: asset_id
                                .ok_or_else(|| JsValue::from_str("INVALID_ASSET_REFERENCE"))?,
                        });
                    } else if asset_id.is_some() {
                        return Err(JsValue::from_str("INVALID_ASSET_REFERENCE"));
                    } else {
                        commands.push(Command::CreateInPage { page_id, node });
                    }
                    if let Some(properties) = text_properties {
                        let id = match commands.last() {
                            Some(Command::CreateInPage { node, .. })
                            | Some(Command::CreateImageInPage { node, .. }) => node.id,
                            _ => return Err(JsValue::from_str("INVALID_TRANSACTION")),
                        };
                        commands.push(Command::SetTextProperties { id, properties });
                    }
                }
                BatchCommand::Restore { node } => {
                    let text_properties = text_properties_from_projection(node.text_properties.as_ref())?;
                    let page_id = node
                        .page_id
                        .as_deref()
                        .map(parse_page_id)
                        .transpose()?
                        .unwrap_or(DEFAULT_PAGE_ID);
                    let asset_id = node
                        .asset_id
                        .as_deref()
                        .map(parse_id)
                        .transpose()?
                        .map(|id| AssetId(id.0));
                    let node = node_from_projection(node)?;
                    commands.push(Command::RestoreNode {
                        page_id,
                        node,
                        asset_id,
                        text_properties,
                    });
                }
                // The Worker resolves a partial Inspector patch to this complete node
                // payload before crossing the bridge. Keeping the bridge input fully
                // concrete makes replay deterministic and lets the Rust reducer own
                // the all-or-nothing validation of every derived core field.
                BatchCommand::Update { node } => {
                    let text_properties =
                        text_properties_from_projection(node.text_properties.as_ref())?;
                    let asset_id = node
                        .asset_id
                        .as_deref()
                        .map(parse_id)
                        .transpose()?
                        .map(|id| AssetId(id.0));
                    let node = node_from_projection(node)?;
                    let appearance = Appearance {
                        fill: node.fill,
                        stroke: node.stroke,
                        fills: node.fills,
                        strokes: node.strokes,
                        stroke_width: node.stroke_width,
                        stroke_cap_start: node.stroke_cap_start,
                        stroke_cap_end: node.stroke_cap_end,
                        stroke_join: node.stroke_join,
                        stroke_miter_limit: node.stroke_miter_limit,
                        stroke_dash_pattern: node.stroke_dash_pattern,
                        stroke_weights: node.stroke_weights,
                        stroke_align: node.stroke_align,
                        arc_data: node.arc_data,
                        relative_transform: node.relative_transform,
                        opacity: node.opacity,
                        corner_radius: node.corner_radius,
                        corner_radii: node.corner_radii,
                        corner_smoothing: node.corner_smoothing,
                        constraints: node.constraints,
                        visible: node.visible,
                        locked: node.locked,
                        contents_hidden: node.contents_hidden,
                        clips_content: Some(node.clips_content),
                    };
                    let geometry = Command::UpdateGeometry {
                        id: node.id,
                        x: node.x,
                        y: node.y,
                        width: node.width,
                        height: node.height,
                        rotation: node.rotation,
                    };
                    let rename = Command::Rename {
                        id: node.id,
                        name: node.name,
                    };
                    let appearance = Command::SetAppearance {
                        id: node.id,
                        appearance,
                    };
                    // A Group promoted into another Group acquires a
                    // parent-relative matrix in this same batch. Core must see
                    // that matrix before validating its derived geometry;
                    // otherwise the legacy Group gate rejects a valid nested
                    // Group as an invalid edit.
                    if node.kind == NodeKind::Group && node.relative_transform.is_some() {
                        commands.extend([appearance, geometry, rename]);
                    } else {
                        commands.extend([geometry, rename, appearance]);
                    }
                    if node.kind != NodeKind::Text {
                        if self.document.asset_for_node(node.id) != asset_id {
                            commands.push(Command::SetNodeAsset {
                                id: node.id,
                                asset_id,
                            });
                        }
                    } else if asset_id.is_some() {
                        return Err(JsValue::from_str("INVALID_ASSET_REFERENCE"));
                    }
                    if node.kind == NodeKind::Text {
                        commands.push(Command::SetText {
                            id: node.id,
                            text: node.text,
                        });
                        commands.push(Command::SetTextProperties {
                            id: node.id,
                            properties: text_properties.unwrap_or_default(),
                        });
                    } else if text_properties.is_some() {
                        return Err(JsValue::from_str("INVALID_TEXT_PROPERTIES"));
                    }
                }
                BatchCommand::Reposition { position_ids } => {
                    if position_ids.is_empty() {
                        return Err(JsValue::from_str("INVALID_TRANSACTION"));
                    }
                    for update in position_ids {
                        commands.push(Command::SetNodePosition {
                            id: parse_id(&update.id)?,
                            position: parse_position_id(&update.position_id)?,
                        });
                    }
                }
                BatchCommand::Reparent { parent_ids } => {
                    if parent_ids.is_empty() {
                        return Err(JsValue::from_str("INVALID_TRANSACTION"));
                    }
                    for update in parent_ids {
                        commands.push(Command::SetNodeParent {
                            id: parse_id(&update.id)?,
                            parent_id: update.parent_id.as_deref().map(parse_id).transpose()?,
                            position: parse_position_id(&update.position_id)?,
                        });
                    }
                }
                BatchCommand::Delete { ids } => {
                    if ids.is_empty() {
                        return Err(JsValue::from_str("INVALID_TRANSACTION"));
                    }
                    for id in ids {
                        commands.push(Command::Delete { id: parse_id(&id)? });
                    }
                }
            }
        }
        if commands.is_empty() {
            return Err(JsValue::from_str("INVALID_TRANSACTION"));
        }
        self.submit_resolved_operation(
            Transaction {
                id: TransactionId(transaction_id.0),
                base_revision,
                commands,
            },
            Origin::LocalUser,
        )
        .map_err(core_error)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeometryUpdate {
    id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    #[serde(default)]
    rotation: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PositionUpdate {
    id: String,
    position_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParentUpdate {
    id: String,
    parent_id: Option<String>,
    position_id: String,
}

struct GeometryCommand {
    id: NodeId,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    rotation: Option<f64>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CoreSnapshot {
    schema_version: u32,
    /// Stable document identity is part of the Core snapshot rather than UI
    /// persistence. v1–v10 records deterministically migrate to DocumentId(0).
    #[serde(default = "default_document_id")]
    document_id: String,
    revision: u64,
    can_undo: bool,
    can_redo: bool,
    #[serde(default)]
    canonical_hash: String,
    #[serde(default = "default_document_color_profile")]
    color_profile: String,
    #[serde(default)]
    pages: Option<Vec<ProjectionPage>>,
    #[serde(default)]
    resource_index: Option<Vec<ProjectionAsset>>,
    nodes: Vec<ProjectionNode>,
    #[serde(default)]
    retired_ids: Option<Vec<String>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionPage {
    id: String,
    name: String,
    position_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionAsset {
    asset_id: String,
    content_hash: String,
    media_type: String,
    byte_length: u64,
    #[serde(default)]
    pixel_width: Option<u32>,
    #[serde(default)]
    pixel_height: Option<u32>,
}

fn default_document_color_profile() -> String {
    "srgb".into()
}

fn default_document_id() -> String {
    "00000000-0000-0000-0000-000000000000".into()
}

fn default_transparent_css() -> String {
    "#00000000".into()
}

fn default_stroke_cap() -> String {
    "none".into()
}

fn default_stroke_join() -> String {
    "miter".into()
}

fn default_stroke_miter_limit() -> f64 {
    10.0
}

fn default_stroke_align() -> String {
    "inside".into()
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionNode {
    id: String,
    /// v15 carries parent ownership in the durable JSON projection. Its absence
    /// remains a valid root node in earlier local snapshots.
    #[serde(default)]
    parent_id: Option<String>,
    name: String,
    kind: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    #[serde(default)]
    rotation: f64,
    fill: String,
    /// v4 persists the explicit Canonical color alongside a CSS sRGB display fallback.
    #[serde(default)]
    fill_color: Option<ProjectionColor>,
    /// v7 persists the complete Canonical gradient; `fill` remains a deterministic
    /// legacy CSS fallback for consumers that cannot render gradients.
    #[serde(default)]
    fill_gradient: Option<ProjectionLinearGradient>,
    #[serde(default)]
    fills: Vec<ProjectionPaint>,
    /// v9 persists Canonical stroke paint and width. The CSS value is only the
    /// deterministic Canvas/Inspector projection fallback.
    #[serde(default = "default_transparent_css")]
    stroke: String,
    #[serde(default)]
    stroke_color: Option<ProjectionColor>,
    #[serde(default)]
    stroke_gradient: Option<ProjectionLinearGradient>,
    #[serde(default)]
    strokes: Vec<ProjectionPaint>,
    #[serde(default)]
    stroke_width: f64,
    /// v16 persists Figma-compatible open-path endpoint styles, v17 adds
    /// independent closed-shape corner radii, v18 adds continuous corner
    /// smoothing, and v19 adds ordered fill/stroke stacks. Earlier snapshots
    /// migrate to their singular-paint defaults.
    #[serde(default = "default_stroke_cap")]
    stroke_cap_start: String,
    #[serde(default = "default_stroke_cap")]
    stroke_cap_end: String,
    #[serde(default = "default_stroke_join")]
    stroke_join: String,
    #[serde(default = "default_stroke_miter_limit")]
    stroke_miter_limit: f64,
    #[serde(default)]
    stroke_dash_pattern: Vec<f64>,
    #[serde(default)]
    stroke_weights: Vec<f64>,
    #[serde(default = "default_stroke_align")]
    stroke_align: String,
    #[serde(default)]
    arc_data: Option<ProjectionArcData>,
    #[serde(default)]
    relative_transform: Option<ProjectionTransform>,
    #[serde(default)]
    position_id: Option<String>,
    /// Absent in v1–v9 records; those nodes migrate deterministically to Page 1.
    #[serde(default)]
    page_id: Option<String>,
    /// Present only for image nodes; raw bytes remain outside the document.
    #[serde(default)]
    asset_id: Option<String>,
    /// Optional canonical rich-text record. Its absence means stable default
    /// text semantics, retaining compatibility with snapshots written before v14.
    #[serde(default)]
    text_properties: Option<ProjectionTextProperties>,
    opacity: f64,
    corner_radius: f64,
    #[serde(default)]
    corner_radii: Vec<f64>,
    #[serde(default)]
    corner_smoothing: f64,
    #[serde(default)]
    constraints: Option<ProjectionConstraints>,
    #[serde(default)]
    text: String,
    visible: bool,
    locked: bool,
    #[serde(default)]
    contents_hidden: bool,
    #[serde(default)]
    clips_content: Option<bool>,
    /// Forward-compatibility payloads owned by newer engine versions. Absent in
    /// snapshots written before extensions existed. The browser treats this as
    /// an opaque read-only pass-through: bytes are preserved verbatim across the
    /// JSON round-trip and never surfaced in the Inspector. serde_json encodes
    /// each `Vec<u8>` as a number array, so the round-trip is byte-exact.
    #[serde(default)]
    extensions: std::collections::BTreeMap<String, Vec<u8>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionFontReference {
    asset_id: String,
    #[serde(default)]
    face_index: u32,
    #[serde(default)]
    variation_axes: Vec<ProjectionFontVariation>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionArcData {
    starting_angle: f64,
    ending_angle: f64,
    inner_radius: f64,
}

#[derive(Clone, Serialize, Deserialize)]
struct ProjectionTransform { a: f64, b: f64, c: f64, d: f64, e: f64, f: f64 }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionConstraints { horizontal: String, vertical: String }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionFontVariation {
    tag: String,
    value: f32,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionTextStyleRun {
    start: u32,
    end: u32,
    #[serde(default)]
    font: Option<ProjectionFontReference>,
    font_size: f64,
    font_weight: u16,
    italic: bool,
    letter_spacing: f64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionParagraphStyle {
    alignment: String,
    #[serde(default)]
    line_height: Option<f64>,
    paragraph_spacing: f64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionTextProperties {
    #[serde(default)]
    runs: Vec<ProjectionTextStyleRun>,
    paragraph: ProjectionParagraphStyle,
    auto_size: String,
    #[serde(default)]
    fallback_fonts: Vec<ProjectionFontReference>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionColor {
    space: String,
    components: [f32; 3],
    alpha: f32,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionLinearGradient {
    start: [f32; 2],
    end: [f32; 2],
    stops: Vec<ProjectionGradientStop>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionPaint {
    css: String,
    #[serde(default)]
    color: Option<ProjectionColor>,
    #[serde(default)]
    gradient: Option<ProjectionLinearGradient>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionGradientStop {
    position: f32,
    color: ProjectionColor,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum BatchCommand {
    Create {
        node: ProjectionNode,
    },
    Restore {
        node: ProjectionNode,
    },
    Update {
        node: ProjectionNode,
    },
    Reposition {
        #[serde(rename = "positionIds")]
        position_ids: Vec<PositionUpdate>,
    },
    Reparent {
        #[serde(rename = "parentIds")]
        parent_ids: Vec<ParentUpdate>,
    },
    Delete {
        ids: Vec<String>,
    },
}

#[wasm_bindgen]
impl DocumentEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            document: Document::empty(),
        }
    }

    #[wasm_bindgen(getter)]
    pub fn revision(&self) -> u64 {
        self.document.revision
    }

    #[wasm_bindgen(getter)]
    pub fn can_undo(&self) -> bool {
        self.document.can_undo()
    }

    #[wasm_bindgen(getter)]
    pub fn can_redo(&self) -> bool {
        self.document.can_redo()
    }

    #[wasm_bindgen]
    pub fn canonical_hash(&self) -> String {
        self.document.canonical_hash_hex()
    }

    /// Durable wire snapshot shared with the server-side Document Service. The
    /// JSON projection remains local-storage-only; this payload is the boundary
    /// used to safely bootstrap and recover a remote document.
    #[wasm_bindgen]
    pub fn snapshot_protobuf(&self) -> Result<Vec<u8>, JsValue> {
        makefigma_document_codec::snapshot_from_document(&self.document, 3)
            .map_err(|_| JsValue::from_str("INVALID_CORE_SNAPSHOT"))
    }

    #[wasm_bindgen]
    pub fn load_snapshot_protobuf(&mut self, bytes: &[u8]) -> Result<u64, JsValue> {
        self.document = makefigma_document_codec::document_from_wire_snapshot(bytes)
            // The prior `self.document` is untouched because `?` short-circuits
            // before the assignment: a rejected load never mutates the open doc.
            .map_err(|error| JsValue::from_str(snapshot_error_code(error)))?;
        Ok(self.document.revision)
    }

    #[wasm_bindgen]
    pub fn memory_stats_json(&self) -> String {
        let stats = self.document.memory_stats();
        serde_json::json!({
            "nodeCount": stats.node_count,
            "nodeBytes": stats.node_bytes,
            "maxDocumentBytes": editor_core::MAX_DOCUMENT_BYTES,
            "undoItems": stats.undo_items,
            "undoBytes": stats.undo_bytes,
            "redoItems": stats.redo_items,
            "redoBytes": stats.redo_bytes,
            "dedupeItems": stats.dedupe_items,
            "dedupeBytes": stats.dedupe_bytes,
            "operationDedupeItems": stats.operation_dedupe_items,
            "operationDedupeBytes": stats.operation_dedupe_bytes,
        })
        .to_string()
    }

    #[wasm_bindgen]
    pub fn snapshot_json(&self) -> String {
        let snapshot = CoreSnapshot {
            schema_version: 19,
            document_id: format_document_id(self.document.id()),
            revision: self.document.revision,
            can_undo: self.document.can_undo(),
            can_redo: self.document.can_redo(),
            canonical_hash: self.document.canonical_hash_hex(),
            color_profile: format_document_color_profile(self.document.color_profile()),
            pages: Some(self.document.pages().map(projection_page).collect()),
            resource_index: Some(self.document.assets().map(projection_asset).collect()),
            nodes: self
                .document
                .ordered_nodes()
                .into_iter()
                .map(|node| {
                    projection_node(
                        node,
                        self.document
                            .page_for_node(node.id)
                            .unwrap_or(DEFAULT_PAGE_ID),
                        self.document.asset_for_node(node.id),
                        self.document.text_properties_for_node(node.id),
                    )
                })
                .collect(),
            retired_ids: Some(
                self.document
                    .retired_ids()
                    .map(|id| format_uuid(*id))
                    .collect(),
            ),
        };
        serde_json::to_string(&snapshot).expect("projection snapshot is serializable")
    }

    /// Projects the current Canonical Document into the GPU-handle-free Rust
    /// Render Graph plan. The Worker can execute this plan with WebGPU or use
    /// its explicit Canvas fallback; neither path gets ownership of Document.
    #[wasm_bindgen]
    pub fn render_graph_plan_json(
        &self,
        viewport_x: f32,
        viewport_y: f32,
        viewport_width: f32,
        viewport_height: f32,
    ) -> String {
        self.render_graph_plan_json_for_nodes(
            self.document.ordered_nodes(),
            viewport_x,
            viewport_y,
            viewport_width,
            viewport_height,
        )
    }

    /// Equivalent to [`Self::render_graph_plan_json`], scoped to the active
    /// Canonical Page. A renderer must not accidentally schedule hidden pages
    /// merely because their coordinates intersect the current viewport.
    #[wasm_bindgen]
    pub fn render_graph_plan_for_page_json(
        &self,
        page_id: &str,
        viewport_x: f32,
        viewport_y: f32,
        viewport_width: f32,
        viewport_height: f32,
    ) -> Result<String, JsValue> {
        let page_id = parse_page_id(page_id)?;
        Ok(self.render_graph_plan_json_for_nodes(
            self.document
                .ordered_nodes_on_page(page_id)
                .map_err(core_error)?,
            viewport_x,
            viewport_y,
            viewport_width,
            viewport_height,
        ))
    }

    fn render_graph_plan_json_for_nodes(
        &self,
        nodes: Vec<&Node>,
        viewport_x: f32,
        viewport_y: f32,
        viewport_width: f32,
        viewport_height: f32,
    ) -> String {
        let scene = makefigma_renderer_wgpu::Scene {
            document_revision: self.document.revision,
            nodes: nodes
                .into_iter()
                .enumerate()
                .map(|(z_index, node)| makefigma_renderer_wgpu::SceneNode {
                    id: node.id.0,
                    kind: match node.kind {
                        NodeKind::Frame => makefigma_renderer_wgpu::SceneNodeKind::Frame,
                        NodeKind::Rectangle => makefigma_renderer_wgpu::SceneNodeKind::Rectangle,
                        NodeKind::Ellipse => makefigma_renderer_wgpu::SceneNodeKind::Ellipse,
                        NodeKind::Image => makefigma_renderer_wgpu::SceneNodeKind::Image,
                        NodeKind::Text => makefigma_renderer_wgpu::SceneNodeKind::Text,
                        NodeKind::Line => makefigma_renderer_wgpu::SceneNodeKind::Line,
                        NodeKind::Group => makefigma_renderer_wgpu::SceneNodeKind::Group,
                        NodeKind::Section => makefigma_renderer_wgpu::SceneNodeKind::Section,
                    },
                    bounds: makefigma_renderer_wgpu::Rect {
                        x: node.x as f32,
                        y: node.y as f32,
                        width: node.width as f32,
                        height: node.height as f32,
                    },
                    z_index: z_index as u32,
                })
                .collect(),
        };
        let graph = makefigma_renderer_wgpu::compile_render_graph(
            &scene,
            makefigma_renderer_wgpu::DirtySet::full_scene(self.document.revision),
            makefigma_renderer_wgpu::Rect {
                x: viewport_x,
                y: viewport_y,
                width: viewport_width.max(0.0),
                height: viewport_height.max(0.0),
            },
        );
        serde_json::json!({
            "documentRevision": graph.document_revision,
            "fullScene": graph.dirty.full_scene,
            "passes": graph.passes.into_iter().map(render_pass_name).collect::<Vec<_>>(),
            "commands": graph.commands.into_iter().map(|command| serde_json::json!({
                "nodeId": format_uuid(NodeId(command.node_id)),
                "pass": render_pass_name(command.pass),
            })).collect::<Vec<_>>(),
        })
        .to_string()
    }

    /// Produces the 16-float solid-shape instance layout consumed by the
    /// WebGPU/WGSL executor. It filters to one active Page and intentionally
    /// leaves Image/Text to their own Render Graph passes.
    #[wasm_bindgen]
    pub fn gpu_scene_instances_json(&self, page_id: &str) -> Result<String, JsValue> {
        let page_id = parse_page_id(page_id)?;
        let primitives = self
            .document
            .ordered_nodes_on_page(page_id)
            .map_err(core_error)?
            .into_iter()
            .filter_map(|node| {
                if !node.visible {
                    return None;
                }
                let (Paint::Solid(fill), Paint::Solid(stroke)) = (&node.fill, &node.stroke) else {
                    return None;
                };
                let stroke_rgba = css_executor_rgba(*stroke, node.opacity);
                if matches!(node.kind, NodeKind::Frame | NodeKind::Rectangle)
                    && (!node.stroke_weights.is_empty() || !node.corner_radii.is_empty() || node.corner_smoothing != 0.0)
                {
                    return None;
                }
                let shape_stroke_outset = shape_gpu_stroke_outset(
                    node.kind.clone(),
                    node.arc_data.is_some(),
                    node.stroke_align,
                    node.stroke_width,
                    stroke_rgba[3],
                );
                Some(makefigma_renderer_wgpu::GpuPrimitive {
                    node_id: node.id.0,
                    kind: match node.kind {
                        NodeKind::Frame => makefigma_renderer_wgpu::SceneNodeKind::Frame,
                        NodeKind::Rectangle => makefigma_renderer_wgpu::SceneNodeKind::Rectangle,
                        NodeKind::Ellipse => makefigma_renderer_wgpu::SceneNodeKind::Ellipse,
                        NodeKind::Image => makefigma_renderer_wgpu::SceneNodeKind::Image,
                        NodeKind::Text => makefigma_renderer_wgpu::SceneNodeKind::Text,
                        NodeKind::Line => makefigma_renderer_wgpu::SceneNodeKind::Line,
                        NodeKind::Group => makefigma_renderer_wgpu::SceneNodeKind::Group,
                        NodeKind::Section => makefigma_renderer_wgpu::SceneNodeKind::Section,
                    },
                    bounds: makefigma_renderer_wgpu::Rect {
                        x: node.x as f32,
                        y: node.y as f32,
                        width: node.width as f32,
                        height: node.height as f32,
                    },
                    rotation_degrees: node.rotation as f32,
                    corner_radius: node.corner_radius as f32,
                    stroke_width: node.stroke_width as f32,
                    shape_stroke_outset,
                    // The current WGSL executor uses conventional
                    // non-premultiplied source-alpha blending. Keep this
                    // Canonical-derived batch byte-for-byte compatible with
                    // its TypeScript fallback while the executor itself is
                    // migrated to a linear-premultiplied pipeline.
                    fill_rgba: css_executor_rgba(*fill, node.opacity),
                    stroke_rgba,
                })
            });
        let batch = makefigma_renderer_wgpu::build_gpu_instance_batch(primitives);
        Ok(serde_json::json!({
            "instanceFloats": batch.instance_floats,
            "renderedNodeIds": batch.rendered_node_ids.into_iter().map(|id| format_uuid(NodeId(id))).collect::<Vec<_>>(),
        })
        .to_string())
    }

    /// Adds only an already-admitted Asset Service record to the Canonical
    /// Resource Index. Bytes remain owned by the resource service.
    #[wasm_bindgen]
    pub fn register_asset(
        &mut self,
        transaction_id: &str,
        base_revision: u64,
        asset_id: &str,
        content_hash: &str,
        media_type: &str,
        byte_length: u64,
        pixel_width: u32,
        pixel_height: u32,
    ) -> Result<u64, JsValue> {
        let dimensions = match (pixel_width, pixel_height) {
            (0, 0) => (None, None),
            (0, _) | (_, 0) => return Err(JsValue::from_str("INVALID_ASSET_REFERENCE")),
            (width, height) => (Some(width), Some(height)),
        };
        let asset = asset_from_projection(ProjectionAsset {
            asset_id: asset_id.into(),
            content_hash: content_hash.into(),
            media_type: media_type.into(),
            byte_length,
            pixel_width: dimensions.0,
            pixel_height: dimensions.1,
        })?;
        self.submit_register_asset(parse_id(transaction_id)?, base_revision, asset)
            .map_err(core_error)
    }

    /// Restores a versioned Core snapshot. This deliberately restores no undo history:
    /// snapshots represent a confirmed durable state, while a future journal will carry
    /// operations that happened after it.
    #[wasm_bindgen]
    pub fn load_snapshot_json(&mut self, value: &str) -> Result<u64, JsValue> {
        let snapshot = serde_json::from_str::<CoreSnapshot>(value)
            .map_err(|_| JsValue::from_str("INVALID_CORE_SNAPSHOT"))?;
        if !(1..=19).contains(&snapshot.schema_version) {
            return Err(JsValue::from_str("UNSUPPORTED_CORE_SNAPSHOT"));
        }
        let mut document = Document::with_id(parse_document_id(&snapshot.document_id)?);
        document.seed_color_profile(parse_document_color_profile(&snapshot.color_profile)?);
        for page in snapshot.pages.clone().unwrap_or_default() {
            let page = page_from_projection(page)?;
            if page.id != DEFAULT_PAGE_ID {
                document.seed_page(page).map_err(core_error)?;
            }
        }
        for asset in snapshot.resource_index.clone().unwrap_or_default() {
            document
                .seed_asset(asset_from_projection(asset)?)
                .map_err(core_error)?;
        }
        for node in snapshot.nodes {
            let page_id = node
                .page_id
                .as_deref()
                .map(parse_page_id)
                .transpose()?
                .unwrap_or(DEFAULT_PAGE_ID);
            let asset_id = node
                .asset_id
                .as_deref()
                .map(parse_id)
                .transpose()?
                .map(|id| AssetId(id.0));
            let text_properties = text_properties_from_projection(node.text_properties.as_ref())?;
            let node = node_from_projection(node)?;
            let node_id = node.id;
            if let Some(asset_id) = asset_id {
                document.seed_image_node_on_page(page_id, node, asset_id)
            } else {
                document.seed_node_on_page(page_id, node)
            }
            .map_err(core_error)?;
            if let Some(properties) = text_properties {
                document
                    .seed_text_properties(node_id, properties)
                    .map_err(core_error)?;
            }
        }
        for id in snapshot.retired_ids.clone().unwrap_or_default() {
            document
                .seed_retired_id(parse_id(&id)?)
                .map_err(core_error)?;
        }
        document.revision = snapshot.revision;
        // Schema v1 predates tombstones, v2 canonical text, v3 canonical color, v4
        // Canonical sibling positions, v6 DocumentColorProfile, v7 Paint, v8
        // rotation, v9 stroke, v10 Document/Page ownership, v11 stable
        // DocumentId, v12 Resource Index, v13 node-level AssetId references, and
        // v14 canonical rich text properties, v15 image fills on regular
        // shape nodes (both use the existing node-level AssetId field).
        // v16 adds StrokeCap endpoint semantics to open paths, v17 adds
        // independent TL/TR/BR/BL corner radii, v18 adds continuous corner
        // smoothing, and v19 adds ordered fill/stroke stacks.
        // v10 snapshots verify against the deterministic legacy DocumentId(0); v14
        // persists every current field.
        if snapshot.schema_version >= 16
            && !snapshot.canonical_hash.is_empty()
            && snapshot.canonical_hash != document.canonical_hash_hex()
        {
            return Err(JsValue::from_str("CORRUPT_CORE_SNAPSHOT"));
        }
        self.document = document;
        Ok(self.document.revision)
    }

    /// Installs a trusted legacy projection without adding history. Unlike the narrow
    /// v1 seed_node bridge, this carries the full v7 paint projection during one-time
    /// hydration of older local records and fixtures.
    #[wasm_bindgen]
    pub fn seed_batch_json(&mut self, value: &str) -> Result<u64, JsValue> {
        let batch = serde_json::from_str::<Vec<BatchCommand>>(value)
            .map_err(|_| JsValue::from_str("INVALID_SEED_BATCH"))?;
        for command in batch {
            match command {
                BatchCommand::Create { node } => {
                    let text_properties =
                        text_properties_from_projection(node.text_properties.as_ref())?;
                    let node = node_from_projection(node)?;
                    let node_id = node.id;
                    self.document.seed_node(node).map_err(core_error)?;
                    if let Some(properties) = text_properties {
                        self.document
                            .seed_text_properties(node_id, properties)
                            .map_err(core_error)?;
                    }
                }
                BatchCommand::Update { .. }
                | BatchCommand::Restore { .. }
                | BatchCommand::Reposition { .. }
                | BatchCommand::Reparent { .. }
                | BatchCommand::Delete { .. } => {
                    return Err(JsValue::from_str("INVALID_SEED_BATCH"));
                }
            }
        }
        Ok(self.document.revision)
    }

    #[wasm_bindgen]
    pub fn undo(&mut self) -> Result<u64, JsValue> {
        self.document
            .undo()
            .ok_or_else(|| JsValue::from_str("NO_UNDO"))
    }

    #[wasm_bindgen]
    pub fn redo(&mut self) -> Result<u64, JsValue> {
        self.document
            .redo()
            .ok_or_else(|| JsValue::from_str("NO_REDO"))
    }

    /// Sets the Canonical default profile for the document. The profile does not
    /// reinterpret existing explicit Colors; it governs future profile-aware assets.
    #[wasm_bindgen]
    pub fn set_document_color_profile(
        &mut self,
        transaction_id: &str,
        base_revision: u64,
        profile: &str,
    ) -> Result<u64, JsValue> {
        let transaction_id = parse_id(transaction_id)?;
        let profile = parse_document_color_profile(profile)?;
        self.submit_document_color_profile(transaction_id, base_revision, profile)
            .map_err(core_error)
    }

    /// Creates a durable top-level Figma-style Page. The worker decides which Page
    /// is active for the current view; Page order and identity remain canonical.
    #[wasm_bindgen]
    pub fn create_page(
        &mut self,
        transaction_id: &str,
        base_revision: u64,
        page_id: &str,
        name: &str,
    ) -> Result<u64, JsValue> {
        let page_id = parse_page_id(page_id)?;
        self.submit_create_page(
            parse_id(transaction_id)?,
            base_revision,
            Page {
                id: page_id,
                name: name.into(),
                position: PositionId::for_node(NodeId(page_id.0)),
            },
        )
        .map_err(core_error)
    }

    /// A deliberately narrow first bridge operation. It proves that JS can submit a
    /// versioned intent to the same Rust reducer used by the future backend service.
    #[wasm_bindgen]
    pub fn create_node(
        &mut self,
        transaction_id: &str,
        base_revision: u64,
        node_id: &str,
        kind: &str,
        name: &str,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        rotation: f64,
        fill: &str,
        stroke: &str,
        stroke_width: f64,
        opacity: f64,
        corner_radius: f64,
        visible: bool,
        locked: bool,
        text: &str,
    ) -> Result<u64, JsValue> {
        let node = Node {
            id: parse_id(node_id)?,
            parent_id: None,
            position: PositionId::for_node(parse_id(node_id)?),
            name: name.into(),
            kind: parse_kind(kind)?,
            x,
            y,
            width,
            height,
            rotation,
            fill: Paint::Solid(parse_css_color(fill)?),
            stroke: Paint::Solid(parse_css_color(stroke)?),
            fills: Vec::new(),
            strokes: Vec::new(),
            stroke_width,
            stroke_cap_start: StrokeCap::None,
            stroke_cap_end: StrokeCap::None,
            stroke_join: StrokeJoin::Miter,
            stroke_miter_limit: 10.0,
            stroke_dash_pattern: Vec::new(),
            stroke_weights: Vec::new(),
            stroke_align: StrokeAlign::Inside,
            arc_data: None,
            relative_transform: None,
            opacity,
            corner_radius,
            corner_radii: Vec::new(),
            corner_smoothing: 0.0,
            constraints: None,
            text: text.into(),
            visible,
            locked,
            contents_hidden: false,
            clips_content: false,
            extensions: Default::default(),
        };
        self.submit_create(
            parse_id(transaction_id)?,
            base_revision,
            node,
            Origin::LocalUser,
        )
        .map_err(core_error)
    }

    #[wasm_bindgen]
    pub fn create_node_on_page(
        &mut self,
        transaction_id: &str,
        base_revision: u64,
        page_id: &str,
        node_id: &str,
        kind: &str,
        name: &str,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        rotation: f64,
        fill: &str,
        stroke: &str,
        stroke_width: f64,
        opacity: f64,
        corner_radius: f64,
        visible: bool,
        locked: bool,
        text: &str,
    ) -> Result<u64, JsValue> {
        let node_id = parse_id(node_id)?;
        let node = Node {
            id: node_id,
            parent_id: None,
            position: PositionId::for_node(node_id),
            name: name.into(),
            kind: parse_kind(kind)?,
            x,
            y,
            width,
            height,
            rotation,
            fill: Paint::Solid(parse_css_color(fill)?),
            stroke: Paint::Solid(parse_css_color(stroke)?),
            fills: Vec::new(),
            strokes: Vec::new(),
            stroke_width,
            stroke_cap_start: StrokeCap::None,
            stroke_cap_end: StrokeCap::None,
            stroke_join: StrokeJoin::Miter,
            stroke_miter_limit: 10.0,
            stroke_dash_pattern: Vec::new(),
            stroke_weights: Vec::new(),
            stroke_align: StrokeAlign::Inside,
            arc_data: None,
            relative_transform: None,
            opacity,
            corner_radius,
            corner_radii: Vec::new(),
            corner_smoothing: 0.0,
            constraints: None,
            text: text.into(),
            visible,
            locked,
            contents_hidden: false,
            clips_content: false,
            extensions: Default::default(),
        };
        self.submit_create_on_page(
            parse_id(transaction_id)?,
            base_revision,
            parse_page_id(page_id)?,
            node,
            Origin::LocalUser,
        )
        .map_err(core_error)
    }

    /// Loads an existing local snapshot without turning document hydration into a user
    /// undo step. Only the Worker uses this while bootstrapping the projection.
    #[wasm_bindgen]
    pub fn seed_node(
        &mut self,
        transaction_id: &str,
        base_revision: u64,
        node_id: &str,
        kind: &str,
        name: &str,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        rotation: f64,
        fill: &str,
        stroke: &str,
        stroke_width: f64,
        opacity: f64,
        corner_radius: f64,
        visible: bool,
        locked: bool,
        text: &str,
    ) -> Result<u64, JsValue> {
        let node = Node {
            id: parse_id(node_id)?,
            parent_id: None,
            position: PositionId::for_node(parse_id(node_id)?),
            name: name.into(),
            kind: parse_kind(kind)?,
            x,
            y,
            width,
            height,
            rotation,
            fill: Paint::Solid(parse_css_color(fill)?),
            stroke: Paint::Solid(parse_css_color(stroke)?),
            fills: Vec::new(),
            strokes: Vec::new(),
            stroke_width,
            stroke_cap_start: StrokeCap::None,
            stroke_cap_end: StrokeCap::None,
            stroke_join: StrokeJoin::Miter,
            stroke_miter_limit: 10.0,
            stroke_dash_pattern: Vec::new(),
            stroke_weights: Vec::new(),
            stroke_align: StrokeAlign::Inside,
            arc_data: None,
            relative_transform: None,
            opacity,
            corner_radius,
            corner_radii: Vec::new(),
            corner_smoothing: 0.0,
            constraints: None,
            text: text.into(),
            visible,
            locked,
            contents_hidden: false,
            clips_content: false,
            extensions: Default::default(),
        };
        let _ = parse_id(transaction_id)?;
        if base_revision != self.document.revision {
            return Err(core_error(editor_core::CommandError::RevisionConflict {
                expected: self.document.revision,
                actual: base_revision,
            }));
        }
        self.document
            .seed_node(node)
            .map(|()| self.document.revision)
            .map_err(core_error)
    }

    #[wasm_bindgen]
    pub fn rename_node(
        &mut self,
        transaction_id: &str,
        base_revision: u64,
        node_id: &str,
        name: &str,
    ) -> Result<u64, JsValue> {
        self.submit_rename(
            parse_id(transaction_id)?,
            base_revision,
            parse_id(node_id)?,
            name.into(),
        )
        .map_err(core_error)
    }

    /// Applies geometry and name as one atomic Rust transaction, so a failed name
    /// validation cannot leave a partially applied resize in the browser document.
    #[wasm_bindgen]
    pub fn update_node(
        &mut self,
        transaction_id: &str,
        base_revision: u64,
        node_id: &str,
        name: &str,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        rotation: f64,
        fill: &str,
        stroke: &str,
        stroke_width: f64,
        opacity: f64,
        corner_radius: f64,
        visible: bool,
        locked: bool,
        text: &str,
    ) -> Result<u64, JsValue> {
        self.submit_update(
            parse_id(transaction_id)?,
            base_revision,
            parse_id(node_id)?,
            name.into(),
            x,
            y,
            width,
            height,
            rotation,
            Appearance {
                fill: Paint::Solid(parse_css_color(fill)?),
                stroke: Paint::Solid(parse_css_color(stroke)?),
                fills: Vec::new(),
                strokes: Vec::new(),
                stroke_width,
                stroke_cap_start: StrokeCap::None,
                stroke_cap_end: StrokeCap::None,
                stroke_join: StrokeJoin::Miter,
                stroke_miter_limit: 10.0,
                stroke_dash_pattern: Vec::new(),
                stroke_weights: Vec::new(),
                stroke_align: StrokeAlign::Inside,
                arc_data: None,
                relative_transform: None,
                opacity,
                corner_radius,
                corner_radii: Vec::new(),
                corner_smoothing: 0.0,
            constraints: None,
                visible,
                locked,
                contents_hidden: false,
            clips_content: Some(false),
            },
            text.into(),
        )
        .map_err(core_error)
    }

    /// `node_ids` is a comma-separated sequence of validated UUIDs. The format is
    /// intentionally narrow because this is an internal Worker-to-WASM boundary.
    #[wasm_bindgen]
    pub fn delete_nodes(
        &mut self,
        transaction_id: &str,
        base_revision: u64,
        node_ids: &str,
    ) -> Result<u64, JsValue> {
        let ids = node_ids
            .split(',')
            .filter(|id| !id.is_empty())
            .map(parse_id)
            .collect::<Result<Vec<_>, _>>()?;
        if ids.is_empty() {
            return Err(JsValue::from_str(
                "INVALID_DELETE: expected at least one node ID",
            ));
        }
        self.submit_delete(parse_id(transaction_id)?, base_revision, ids)
            .map_err(core_error)
    }

    /// Keeps a pointer drag as one semantic history item, even when several nodes move.
    #[wasm_bindgen]
    pub fn move_nodes(
        &mut self,
        transaction_id: &str,
        base_revision: u64,
        updates_json: &str,
    ) -> Result<u64, JsValue> {
        let updates = serde_json::from_str::<Vec<GeometryUpdate>>(updates_json)
            .map_err(|_| JsValue::from_str("INVALID_GEOMETRY_UPDATES"))?;
        if updates.is_empty() {
            return Err(JsValue::from_str("INVALID_GEOMETRY_UPDATES"));
        }
        let updates = updates
            .into_iter()
            .map(|update| {
                Ok(GeometryCommand {
                    id: parse_id(&update.id)?,
                    x: update.x,
                    y: update.y,
                    width: update.width,
                    height: update.height,
                    rotation: update.rotation,
                })
            })
            .collect::<Result<Vec<_>, JsValue>>()?;
        self.submit_move(parse_id(transaction_id)?, base_revision, updates)
            .map_err(core_error)
    }

    /// Accepts one concrete, all-or-nothing command batch from the Engine Worker.
    /// The payload has no UI selection or live pointer state and therefore can be
    /// replayed by the same reducer used by other runtimes.
    #[wasm_bindgen]
    pub fn apply_transaction_json(
        &mut self,
        transaction_id: &str,
        base_revision: u64,
        commands_json: &str,
    ) -> Result<u64, JsValue> {
        let commands = serde_json::from_str::<Vec<BatchCommand>>(commands_json)
            .map_err(|_| JsValue::from_str("INVALID_TRANSACTION"))?;
        self.submit_batch(parse_id(transaction_id)?, base_revision, commands)
    }
}

fn css_executor_rgba(color: Color, opacity: f64) -> [f32; 4] {
    let [red, green, blue, alpha] = color.to_srgb_u8();
    [
        red as f32 / 255.0,
        green as f32 / 255.0,
        blue as f32 / 255.0,
        alpha as f32 / 255.0 * opacity as f32,
    ]
}

#[wasm_bindgen]
pub fn engine_semantics_version() -> u32 {
    3
}

/// Projects the canonical Rust stroke tessellation through the WASM boundary.
/// The returned triangles are presentation data only: neither a mesh nor its
/// cache can become durable document state. Keeping this conversion here gives
/// Canvas, WebGPU and export callers one finite, validated geometry source.
#[wasm_bindgen]
pub fn stroke_mesh_for_polyline_json(
    points_json: &str,
    width: f64,
    cap: &str,
    join: &str,
    miter_limit: f64,
    closed: bool,
) -> Result<String, JsValue> {
    let raw_points = serde_json::from_str::<Vec<[f64; 2]>>(points_json)
        .map_err(|_| JsValue::from_str("INVALID_STROKE_MESH_POINTS"))?;
    let points = raw_points
        .into_iter()
        .map(|[x, y]| Point::new(x, y).map_err(|_| JsValue::from_str("INVALID_STROKE_MESH_POINTS")))
        .collect::<Result<Vec<_>, _>>()?;
    let cap = match cap {
        "butt" => StrokeCapStyle::Butt,
        "round" => StrokeCapStyle::Round,
        "square" => StrokeCapStyle::Square,
        _ => return Err(JsValue::from_str("INVALID_STROKE_CAP")),
    };
    let join = match join {
        "miter" => StrokeJoinStyle::Miter,
        "bevel" => StrokeJoinStyle::Bevel,
        "round" => StrokeJoinStyle::Round,
        _ => return Err(JsValue::from_str("INVALID_STROKE_JOIN")),
    };
    let mesh = stroke_mesh_for_polyline(
        &points,
        StrokeStyle {
            width,
            cap,
            join,
            miter_limit,
        },
        closed,
    )
    .map_err(|_| JsValue::from_str("INVALID_STROKE_MESH_STYLE"))?;
    Ok(serde_json::json!({
        "triangles": mesh.triangles.into_iter().map(|triangle| triangle.map(|point| [point.x, point.y])).collect::<Vec<_>>(),
        "bounds": mesh.bounds.map(|bounds| {
            serde_json::json!({
                "min": [bounds.min.x, bounds.min.y],
                "max": [bounds.max.x, bounds.max.y],
            })
        }),
    })
    .to_string())
}

/// Projects a decorative Line endpoint marker (arrowhead, diamond or dot) from
/// the same Core geometry the Canvas renderer, hit test and SVG export consume.
/// `endpoint`/`direction` place and orient the marker in the Line's local space
/// (`direction` is `-1` at the start, `1` at the end); `stroke_width` sizes it.
#[wasm_bindgen]
pub fn decorative_cap_mesh_json(
    cap: &str,
    endpoint: f64,
    direction: f64,
    stroke_width: f64,
) -> Result<String, JsValue> {
    let cap = match cap {
        "arrowLines" => DecorativeCapStyle::ArrowLines,
        "arrowEquilateral" => DecorativeCapStyle::ArrowEquilateral,
        "triangleFilled" => DecorativeCapStyle::TriangleFilled,
        "diamondFilled" => DecorativeCapStyle::DiamondFilled,
        "circleFilled" => DecorativeCapStyle::CircleFilled,
        _ => return Err(JsValue::from_str("INVALID_DECORATIVE_CAP")),
    };
    let mesh = decorative_cap_mesh(cap, endpoint, direction, stroke_width)
        .map_err(|_| JsValue::from_str("INVALID_DECORATIVE_CAP_STYLE"))?;
    Ok(serde_json::json!({
        "triangles": mesh.triangles.into_iter().map(|triangle| triangle.map(|point| [point.x, point.y])).collect::<Vec<_>>(),
        "bounds": mesh.bounds.map(|bounds| {
            serde_json::json!({
                "min": [bounds.min.x, bounds.min.y],
                "max": [bounds.max.x, bounds.max.y],
            })
        }),
    })
    .to_string())
}

/// Projects the visible dashes of a straight Line from the same Core mesh
/// source used by hit testing and selection bounds.
#[wasm_bindgen]
pub fn stroke_mesh_for_dashed_line_json(
    width: f64,
    stroke_width: f64,
    dash_json: &str,
    cap: &str,
    join: &str,
    miter_limit: f64,
) -> Result<String, JsValue> {
    let dash_pattern = serde_json::from_str::<Vec<f64>>(dash_json)
        .map_err(|_| JsValue::from_str("INVALID_STROKE_DASH"))?;
    let cap = match cap {
        "butt" => StrokeCapStyle::Butt,
        "round" => StrokeCapStyle::Round,
        "square" => StrokeCapStyle::Square,
        _ => return Err(JsValue::from_str("INVALID_STROKE_CAP")),
    };
    let join = match join {
        "miter" => StrokeJoinStyle::Miter,
        "bevel" => StrokeJoinStyle::Bevel,
        "round" => StrokeJoinStyle::Round,
        _ => return Err(JsValue::from_str("INVALID_STROKE_JOIN")),
    };
    let mesh = stroke_mesh_for_dashed_line(width, StrokeStyle { width: stroke_width, cap, join, miter_limit }, &dash_pattern)
        .map_err(|_| JsValue::from_str("INVALID_DASHED_LINE_STROKE_STYLE"))?;
    Ok(serde_json::json!({
        "triangles": mesh.triangles.into_iter().map(|triangle| triangle.map(|point| [point.x, point.y])).collect::<Vec<_>>(),
        "bounds": mesh.bounds.map(|bounds| serde_json::json!({
            "min": [bounds.min.x, bounds.min.y], "max": [bounds.max.x, bounds.max.y],
        })),
    }).to_string())
}

/// Projects visible dashes of an arbitrary open or closed polyline. A dashed
/// Frame/Rectangle uses this boundary so its corner joins are not re-derived
/// by Canvas.
#[wasm_bindgen]
pub fn stroke_mesh_for_dashed_polyline_json(
    points_json: &str,
    stroke_width: f64,
    dash_json: &str,
    cap: &str,
    join: &str,
    miter_limit: f64,
    closed: bool,
) -> Result<String, JsValue> {
    let raw_points = serde_json::from_str::<Vec<[f64; 2]>>(points_json)
        .map_err(|_| JsValue::from_str("INVALID_STROKE_MESH_POINTS"))?;
    let points = raw_points.into_iter()
        .map(|[x, y]| Point::new(x, y).map_err(|_| JsValue::from_str("INVALID_STROKE_MESH_POINTS")))
        .collect::<Result<Vec<_>, _>>()?;
    let dash_pattern = serde_json::from_str::<Vec<f64>>(dash_json)
        .map_err(|_| JsValue::from_str("INVALID_STROKE_DASH"))?;
    let cap = match cap {
        "butt" => StrokeCapStyle::Butt,
        "round" => StrokeCapStyle::Round,
        "square" => StrokeCapStyle::Square,
        _ => return Err(JsValue::from_str("INVALID_STROKE_CAP")),
    };
    let join = match join {
        "miter" => StrokeJoinStyle::Miter,
        "bevel" => StrokeJoinStyle::Bevel,
        "round" => StrokeJoinStyle::Round,
        _ => return Err(JsValue::from_str("INVALID_STROKE_JOIN")),
    };
    let mesh = stroke_mesh_for_dashed_polyline(&points, StrokeStyle { width: stroke_width, cap, join, miter_limit }, &dash_pattern, closed)
        .map_err(|_| JsValue::from_str("INVALID_DASHED_POLYLINE_STROKE_STYLE"))?;
    Ok(serde_json::json!({
        "triangles": mesh.triangles.into_iter().map(|triangle| triangle.map(|point| [point.x, point.y])).collect::<Vec<_>>(),
        "bounds": mesh.bounds.map(|bounds| serde_json::json!({
            "min": [bounds.min.x, bounds.min.y], "max": [bounds.max.x, bounds.max.y],
        })),
    }).to_string())
}

/// Projects the four independently weighted square-corner rectangle edges
/// from Core. The ordered meshes retain their separate paint-stack passes.
#[wasm_bindgen]
pub fn stroke_meshes_for_per_side_rectangle_json(
    width: f64,
    height: f64,
    weights_json: &str,
    align: &str,
) -> Result<String, JsValue> {
    let weights = serde_json::from_str::<[f64; 4]>(weights_json)
        .map_err(|_| JsValue::from_str("INVALID_PER_SIDE_STROKE_WEIGHTS"))?;
    let align = match align {
        "inside" => PerSideStrokeAlign::Inside,
        "center" => PerSideStrokeAlign::Center,
        "outside" => PerSideStrokeAlign::Outside,
        _ => return Err(JsValue::from_str("INVALID_STROKE_ALIGN")),
    };
    let meshes = stroke_meshes_for_per_side_rectangle(width, height, weights, align)
        .map_err(|_| JsValue::from_str("INVALID_PER_SIDE_RECTANGLE_STROKE_STYLE"))?;
    Ok(serde_json::json!({
        "meshes": meshes.into_iter().map(|mesh| serde_json::json!({
            "triangles": mesh.triangles.into_iter().map(|triangle| triangle.map(|point| [point.x, point.y])).collect::<Vec<_>>(),
            "bounds": mesh.bounds.map(|bounds| serde_json::json!({
                "min": [bounds.min.x, bounds.min.y],
                "max": [bounds.max.x, bounds.max.y],
            })),
        })).collect::<Vec<_>>(),
    }).to_string())
}

/// Projects independently weighted square-corner rectangle dashes from Core.
/// The dash phase intentionally restarts on each independent edge, matching
/// the existing per-side rendering contract.
#[wasm_bindgen]
pub fn stroke_meshes_for_per_side_rectangle_with_dash_json(
    width: f64,
    height: f64,
    weights_json: &str,
    align: &str,
    dash_json: &str,
) -> Result<String, JsValue> {
    let weights = serde_json::from_str::<[f64; 4]>(weights_json)
        .map_err(|_| JsValue::from_str("INVALID_PER_SIDE_STROKE_WEIGHTS"))?;
    let dash = serde_json::from_str::<Vec<f64>>(dash_json)
        .map_err(|_| JsValue::from_str("INVALID_STROKE_DASH"))?;
    let align = match align {
        "inside" => PerSideStrokeAlign::Inside,
        "center" => PerSideStrokeAlign::Center,
        "outside" => PerSideStrokeAlign::Outside,
        _ => return Err(JsValue::from_str("INVALID_STROKE_ALIGN")),
    };
    let meshes = stroke_meshes_for_per_side_rectangle_with_dash(width, height, weights, align, Some(&dash))
        .map_err(|_| JsValue::from_str("INVALID_DASHED_PER_SIDE_RECTANGLE_STROKE_STYLE"))?;
    Ok(serde_json::json!({
        "meshes": meshes.into_iter().map(|mesh| serde_json::json!({
            "triangles": mesh.triangles.into_iter().map(|triangle| triangle.map(|point| [point.x, point.y])).collect::<Vec<_>>(),
            "bounds": mesh.bounds.map(|bounds| serde_json::json!({
                "min": [bounds.min.x, bounds.min.y],
                "max": [bounds.max.x, bounds.max.y],
            })),
        })).collect::<Vec<_>>(),
    }).to_string())
}

/// Projects the canonical uniform rounded-rectangle stroke outline. This is a
/// presentation-only mesh; it cannot become document state and therefore
/// keeps the same finite validation boundary as polyline tessellation.
#[wasm_bindgen]
pub fn stroke_mesh_for_rounded_rectangle_json(
    width: f64,
    height: f64,
    radius: f64,
    stroke_width: f64,
    join: &str,
    miter_limit: f64,
) -> Result<String, JsValue> {
    let join = match join {
        "miter" => StrokeJoinStyle::Miter,
        "bevel" => StrokeJoinStyle::Bevel,
        "round" => StrokeJoinStyle::Round,
        _ => return Err(JsValue::from_str("INVALID_STROKE_JOIN")),
    };
    let mesh = stroke_mesh_for_rounded_rectangle(
        width,
        height,
        radius,
        StrokeStyle {
            width: stroke_width,
            cap: StrokeCapStyle::Butt,
            join,
            miter_limit,
        },
    )
    .map_err(|_| JsValue::from_str("INVALID_ROUNDED_RECTANGLE_STROKE_STYLE"))?;
    Ok(serde_json::json!({
        "triangles": mesh.triangles.into_iter().map(|triangle| triangle.map(|point| [point.x, point.y])).collect::<Vec<_>>(),
        "bounds": mesh.bounds.map(|bounds| {
            serde_json::json!({
                "min": [bounds.min.x, bounds.min.y],
                "max": [bounds.max.x, bounds.max.y],
            })
        }),
    })
    .to_string())
}

/// Projects a canonical four-corner rounded-rectangle stroke outline. Radii
/// are TL/TR/BR/BL and are normalized by Core before tessellation.
#[wasm_bindgen]
pub fn stroke_mesh_for_rounded_rectangle_with_radii_json(
    width: f64,
    height: f64,
    radii_json: &str,
    stroke_width: f64,
    join: &str,
    miter_limit: f64,
) -> Result<String, JsValue> {
    let radii = serde_json::from_str::<[f64; 4]>(radii_json)
        .map_err(|_| JsValue::from_str("INVALID_ROUNDED_RECTANGLE_RADII"))?;
    let join = match join {
        "miter" => StrokeJoinStyle::Miter,
        "bevel" => StrokeJoinStyle::Bevel,
        "round" => StrokeJoinStyle::Round,
        _ => return Err(JsValue::from_str("INVALID_STROKE_JOIN")),
    };
    let mesh = stroke_mesh_for_rounded_rectangle_with_radii(
        width,
        height,
        radii,
        StrokeStyle {
            width: stroke_width,
            cap: StrokeCapStyle::Butt,
            join,
            miter_limit,
        },
    )
    .map_err(|_| JsValue::from_str("INVALID_ROUNDED_RECTANGLE_STROKE_STYLE"))?;
    Ok(serde_json::json!({
        "triangles": mesh.triangles.into_iter().map(|triangle| triangle.map(|point| [point.x, point.y])).collect::<Vec<_>>(),
        "bounds": mesh.bounds.map(|bounds| {
            serde_json::json!({
                "min": [bounds.min.x, bounds.min.y],
                "max": [bounds.max.x, bounds.max.y],
            })
        }),
    })
    .to_string())
}

/// Projects the canonical dashed independent-radius rounded-rectangle outline.
#[wasm_bindgen]
pub fn stroke_mesh_for_dashed_rounded_rectangle_with_radii_json(
    width: f64,
    height: f64,
    radii_json: &str,
    stroke_width: f64,
    dash_json: &str,
    join: &str,
    miter_limit: f64,
) -> Result<String, JsValue> {
    let radii = serde_json::from_str::<[f64; 4]>(radii_json)
        .map_err(|_| JsValue::from_str("INVALID_ROUNDED_RECTANGLE_RADII"))?;
    let dash_pattern = serde_json::from_str::<Vec<f64>>(dash_json)
        .map_err(|_| JsValue::from_str("INVALID_STROKE_DASH"))?;
    let join = match join {
        "miter" => StrokeJoinStyle::Miter,
        "bevel" => StrokeJoinStyle::Bevel,
        "round" => StrokeJoinStyle::Round,
        _ => return Err(JsValue::from_str("INVALID_STROKE_JOIN")),
    };
    let mesh = stroke_mesh_for_dashed_rounded_rectangle_with_radii(
        width,
        height,
        radii,
        StrokeStyle { width: stroke_width, cap: StrokeCapStyle::Butt, join, miter_limit },
        &dash_pattern,
    ).map_err(|_| JsValue::from_str("INVALID_DASHED_ROUNDED_RECTANGLE_STROKE_STYLE"))?;
    Ok(serde_json::json!({
        "triangles": mesh.triangles.into_iter().map(|triangle| triangle.map(|point| [point.x, point.y])).collect::<Vec<_>>(),
        "bounds": mesh.bounds.map(|bounds| serde_json::json!({
            "min": [bounds.min.x, bounds.min.y], "max": [bounds.max.x, bounds.max.y],
        })),
    }).to_string())
}

/// Projects the shared Figma-style Corner Smoothing approximation. An empty
/// Dash array means solid; otherwise Core emits only the visible dash runs.
#[wasm_bindgen]
pub fn stroke_mesh_for_continuous_rounded_rectangle_with_radii_json(
    width: f64,
    height: f64,
    radii_json: &str,
    smoothing: f64,
    stroke_width: f64,
    dash_json: &str,
    join: &str,
    miter_limit: f64,
) -> Result<String, JsValue> {
    let radii = serde_json::from_str::<[f64; 4]>(radii_json)
        .map_err(|_| JsValue::from_str("INVALID_ROUNDED_RECTANGLE_RADII"))?;
    let dash_pattern = serde_json::from_str::<Vec<f64>>(dash_json)
        .map_err(|_| JsValue::from_str("INVALID_STROKE_DASH"))?;
    let join = match join {
        "miter" => StrokeJoinStyle::Miter,
        "bevel" => StrokeJoinStyle::Bevel,
        "round" => StrokeJoinStyle::Round,
        _ => return Err(JsValue::from_str("INVALID_STROKE_JOIN")),
    };
    let mesh = stroke_mesh_for_continuous_rounded_rectangle_with_radii(
        width,
        height,
        radii,
        smoothing,
        StrokeStyle { width: stroke_width, cap: StrokeCapStyle::Butt, join, miter_limit },
        (!dash_pattern.is_empty()).then_some(dash_pattern.as_slice()),
    ).map_err(|_| JsValue::from_str("INVALID_CONTINUOUS_ROUNDED_RECTANGLE_STROKE_STYLE"))?;
    Ok(serde_json::json!({
        "triangles": mesh.triangles.into_iter().map(|triangle| triangle.map(|point| [point.x, point.y])).collect::<Vec<_>>(),
        "bounds": mesh.bounds.map(|bounds| serde_json::json!({
            "min": [bounds.min.x, bounds.min.y], "max": [bounds.max.x, bounds.max.y],
        })),
    }).to_string())
}

/// Returns a deterministic, UTF-8 byte-addressed fallback layout for selection,
/// caret, and IME clients. This boundary owns neither a canvas nor a font: the
/// presentation renderer may refine glyph positions without changing the saved
/// document text or its canonical byte offsets.
#[wasm_bindgen]
pub fn fallback_text_layout_json(text: &str, max_graphemes_per_line: u32) -> String {
    let layout =
        makefigma_graphics_core::fallback_text_layout(text, max_graphemes_per_line as usize);
    serde_json::json!({
        "lines": layout.lines.into_iter().map(|line| serde_json::json!({
            "start": line.start,
            "end": line.end,
            "direction": match line.direction {
                makefigma_graphics_core::TextDirection::LeftToRight => "ltr",
                makefigma_graphics_core::TextDirection::RightToLeft => "rtl",
            },
        })).collect::<Vec<_>>(),
        "carets": layout.carets.into_iter().map(|caret| serde_json::json!({
            "byteOffset": caret.byte_offset,
            "lineIndex": caret.line_index,
        })).collect::<Vec<_>>(),
    })
    .to_string()
}

/// Produces a transient text-edit/IME preview. It has no DocumentEngine
/// receiver by design: only a composition commit crosses into Canonical
/// Document as an atomic text transaction.
#[wasm_bindgen]
pub fn preview_text_replacement_json(
    text: &str,
    anchor: u32,
    focus: u32,
    replacement: &str,
) -> Result<String, JsValue> {
    let layout = makefigma_graphics_core::fallback_text_layout(text, usize::MAX);
    let result = makefigma_graphics_core::replace_text_selection(
        text,
        &layout,
        makefigma_graphics_core::TextSelection { anchor, focus },
        replacement,
    )
    .map_err(|_| JsValue::from_str("INVALID_TEXT_SELECTION"))?;
    Ok(serde_json::json!({
        "text": result.text,
        "selection": {
            "anchor": result.selection.anchor,
            "focus": result.selection.focus,
        },
    })
    .to_string())
}

/// Shapes text from explicit font bytes without using browser font metrics.
/// This is presentation-only data; persisted text and font references remain
/// owned by Canonical Document and commit through the normal transaction path.
#[wasm_bindgen]
pub fn shape_text_json(
    font_bytes: &[u8],
    face_index: u32,
    text: &str,
    direction: &str,
) -> Result<String, JsValue> {
    let direction = match direction {
        "ltr" => makefigma_graphics_core::TextDirection::LeftToRight,
        "rtl" => makefigma_graphics_core::TextDirection::RightToLeft,
        _ => return Err(JsValue::from_str("INVALID_TEXT_DIRECTION")),
    };
    let shaped = makefigma_graphics_core::shape_text(font_bytes, face_index, text, direction)
        .map_err(|_| JsValue::from_str("INVALID_FONT_BYTES"))?;
    Ok(serde_json::json!({
        "direction": match shaped.direction {
            makefigma_graphics_core::TextDirection::LeftToRight => "ltr",
            makefigma_graphics_core::TextDirection::RightToLeft => "rtl",
        },
        "unitsPerEm": shaped.units_per_em,
        "glyphs": shaped.glyphs.into_iter().map(|glyph| serde_json::json!({
            "glyphId": glyph.glyph_id,
            "cluster": glyph.cluster,
            "xAdvance": glyph.x_advance,
            "yAdvance": glyph.y_advance,
            "xOffset": glyph.x_offset,
            "yOffset": glyph.y_offset,
        })).collect::<Vec<_>>(),
    })
    .to_string())
}

/// Produces a bounded, deterministic glyph alpha mask from explicit font
/// bytes. The result is presentation-only input for a renderer-owned atlas;
/// neither the pixels nor the placement can enter Canonical Document state.
#[wasm_bindgen]
pub fn rasterize_glyph_json(
    font_bytes: &[u8],
    face_index: u32,
    glyph_id: u32,
    pixel_size: u16,
) -> Result<String, JsValue> {
    let raster =
        makefigma_graphics_core::rasterize_glyph(font_bytes, face_index, glyph_id, pixel_size)
            .map_err(|_| JsValue::from_str("INVALID_GLYPH_RASTER_INPUT"))?;
    Ok(serde_json::json!({
        "width": raster.width,
        "height": raster.height,
        "bearingX": raster.bearing_x,
        "bearingY": raster.bearing_y,
        "ascent": raster.ascent,
        "advanceX": raster.advance_x,
        "pixels": raster.pixels,
    })
    .to_string())
}

/// Rasterizes at the same declared variation coordinates as shaping. Pixels
/// remain an ephemeral renderer resource and never enter Canonical Document.
#[wasm_bindgen]
pub fn rasterize_glyph_with_variations_json(
    font_bytes: &[u8],
    face_index: u32,
    variation_axes_json: &str,
    glyph_id: u32,
    pixel_size: u16,
) -> Result<String, JsValue> {
    let variations = parse_font_variations(variation_axes_json)?;
    let raster = makefigma_graphics_core::rasterize_glyph_with_variations(
        font_bytes,
        face_index,
        &variations,
        glyph_id,
        pixel_size,
    )
    .map_err(|_| JsValue::from_str("INVALID_GLYPH_RASTER_INPUT"))?;
    Ok(serde_json::json!({
        "width": raster.width,
        "height": raster.height,
        "bearingX": raster.bearing_x,
        "bearingY": raster.bearing_y,
        "ascent": raster.ascent,
        "advanceX": raster.advance_x,
        "pixels": raster.pixels,
    })
    .to_string())
}

/// Produces ICU4X line ranges and Rustybuzz advances from explicit font bytes.
/// The width is measured in em, so viewport zoom never changes the derived
/// source ranges. Glyph pixels remain a renderer-owned cache.
#[wasm_bindgen]
pub fn layout_shaped_text_json(
    font_bytes: &[u8],
    face_index: u32,
    text: &str,
    max_width_em: f32,
) -> Result<String, JsValue> {
    let layout =
        makefigma_graphics_core::layout_shaped_text(font_bytes, face_index, text, max_width_em)
            .map_err(|_| JsValue::from_str("INVALID_TEXT_LAYOUT_INPUT"))?;
    Ok(serde_json::json!({
        "unitsPerEm": layout.units_per_em,
        "lines": layout.lines.into_iter().map(|line| serde_json::json!({
            "start": line.start,
            "end": line.end,
            "direction": match line.direction {
                makefigma_graphics_core::TextDirection::LeftToRight => "ltr",
                makefigma_graphics_core::TextDirection::RightToLeft => "rtl",
            },
            "advance": line.advance,
            "visualRuns": line.visual_runs.into_iter().map(|run| serde_json::json!({
                "start": run.start,
                "end": run.end,
                "direction": match run.direction {
                    makefigma_graphics_core::TextDirection::LeftToRight => "ltr",
                    makefigma_graphics_core::TextDirection::RightToLeft => "rtl",
                },
            })).collect::<Vec<_>>(),
            "glyphs": line.glyphs.into_iter().map(|glyph| serde_json::json!({
                "glyphId": glyph.glyph_id,
                "cluster": glyph.cluster,
                "xAdvance": glyph.x_advance,
                "yAdvance": glyph.y_advance,
                "xOffset": glyph.x_offset,
                "yOffset": glyph.y_offset,
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "carets": layout.carets.into_iter().map(|caret| serde_json::json!({
            "byteOffset": caret.byte_offset,
            "lineIndex": caret.line_index,
        })).collect::<Vec<_>>(),
    })
    .to_string())
}

/// Produces ICU4X line ranges at the same Variable Font coordinates used by
/// the shaping and glyph-raster stages.
#[wasm_bindgen]
pub fn layout_shaped_text_with_variations_json(
    font_bytes: &[u8],
    face_index: u32,
    variation_axes_json: &str,
    text: &str,
    max_width_em: f32,
) -> Result<String, JsValue> {
    let variations = parse_font_variations(variation_axes_json)?;
    let layout = makefigma_graphics_core::layout_shaped_text_with_variations(
        font_bytes,
        face_index,
        &variations,
        text,
        max_width_em,
    )
    .map_err(|_| JsValue::from_str("INVALID_TEXT_LAYOUT_INPUT"))?;
    Ok(serde_json::json!({
        "unitsPerEm": layout.units_per_em,
        "lines": layout.lines.into_iter().map(|line| serde_json::json!({
            "start": line.start,
            "end": line.end,
            "direction": match line.direction {
                makefigma_graphics_core::TextDirection::LeftToRight => "ltr",
                makefigma_graphics_core::TextDirection::RightToLeft => "rtl",
            },
            "advance": line.advance,
            "visualRuns": line.visual_runs.into_iter().map(|run| serde_json::json!({
                "start": run.start,
                "end": run.end,
                "direction": match run.direction {
                    makefigma_graphics_core::TextDirection::LeftToRight => "ltr",
                    makefigma_graphics_core::TextDirection::RightToLeft => "rtl",
                },
            })).collect::<Vec<_>>(),
            "glyphs": line.glyphs.into_iter().map(|glyph| serde_json::json!({
                "glyphId": glyph.glyph_id,
                "cluster": glyph.cluster,
                "xAdvance": glyph.x_advance,
                "yAdvance": glyph.y_advance,
                "xOffset": glyph.x_offset,
                "yOffset": glyph.y_offset,
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "carets": layout.carets.into_iter().map(|caret| serde_json::json!({
            "byteOffset": caret.byte_offset,
            "lineIndex": caret.line_index,
        })).collect::<Vec<_>>(),
    })
    .to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FontVariationInput {
    tag: String,
    value: f32,
}

fn parse_font_variations(
    value: &str,
) -> Result<Vec<makefigma_graphics_core::FontVariation>, JsValue> {
    let values = serde_json::from_str::<Vec<FontVariationInput>>(value)
        .map_err(|_| JsValue::from_str("INVALID_FONT_VARIATIONS"))?;
    values
        .into_iter()
        .map(|axis| {
            let tag: [u8; 4] = axis
                .tag
                .as_bytes()
                .try_into()
                .map_err(|_| JsValue::from_str("INVALID_FONT_VARIATION_TAG"))?;
            Ok(makefigma_graphics_core::FontVariation {
                tag,
                value: axis.value,
            })
        })
        .collect()
}

fn render_pass_name(pass: makefigma_renderer_wgpu::RenderPass) -> &'static str {
    match pass {
        makefigma_renderer_wgpu::RenderPass::MainScene => "mainScene",
        makefigma_renderer_wgpu::RenderPass::Images => "images",
        makefigma_renderer_wgpu::RenderPass::Text => "text",
        makefigma_renderer_wgpu::RenderPass::Overlay => "overlay",
        makefigma_renderer_wgpu::RenderPass::Composite => "composite",
    }
}

fn parse_id(value: &str) -> Result<NodeId, JsValue> {
    let compact = value.replace('-', "");
    if compact.len() != 32 || !compact.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(JsValue::from_str(
            "INVALID_ID: expected a 128-bit hexadecimal UUID",
        ));
    }
    u128::from_str_radix(&compact, 16)
        .map(NodeId)
        .map_err(|_| JsValue::from_str("INVALID_ID"))
}

/// Maps a codec snapshot rejection to a stable string code for the Worker error
/// boundary. A node minted by a newer engine is not corruption: it gets a
/// distinguishable code so the shell degrades to read-only rather than reporting
/// generic data corruption (ADR 0023, P0-3).
fn snapshot_error_code(error: makefigma_document_codec::SnapshotError) -> &'static str {
    match error {
        makefigma_document_codec::SnapshotError::UnsupportedFutureNode => {
            "DOCUMENT_REQUIRES_NEWER_CLIENT"
        }
        makefigma_document_codec::SnapshotError::Invalid => "INVALID_CORE_SNAPSHOT",
    }
}

fn parse_kind(value: &str) -> Result<NodeKind, JsValue> {
    match value {
        "frame" => Ok(NodeKind::Frame),
        "rectangle" => Ok(NodeKind::Rectangle),
        "ellipse" => Ok(NodeKind::Ellipse),
        "text" => Ok(NodeKind::Text),
        "image" => Ok(NodeKind::Image),
        "line" => Ok(NodeKind::Line),
        "group" => Ok(NodeKind::Group),
        "section" => Ok(NodeKind::Section),
        _ => Err(JsValue::from_str("UNSUPPORTED_NODE_KIND")),
    }
}

fn parse_stroke_cap(value: &str) -> Result<StrokeCap, JsValue> {
    match value {
        "" | "none" => Ok(StrokeCap::None),
        "round" => Ok(StrokeCap::Round),
        "square" => Ok(StrokeCap::Square),
        "arrowLines" => Ok(StrokeCap::ArrowLines),
        "arrowEquilateral" => Ok(StrokeCap::ArrowEquilateral),
        "diamondFilled" => Ok(StrokeCap::DiamondFilled),
        "triangleFilled" => Ok(StrokeCap::TriangleFilled),
        "circleFilled" => Ok(StrokeCap::CircleFilled),
        _ => Err(JsValue::from_str("INVALID_STROKE_CAP")),
    }
}

fn format_stroke_cap(cap: StrokeCap) -> String {
    match cap {
        StrokeCap::None => "none",
        StrokeCap::Round => "round",
        StrokeCap::Square => "square",
        StrokeCap::ArrowLines => "arrowLines",
        StrokeCap::ArrowEquilateral => "arrowEquilateral",
        StrokeCap::DiamondFilled => "diamondFilled",
        StrokeCap::TriangleFilled => "triangleFilled",
        StrokeCap::CircleFilled => "circleFilled",
    }
    .into()
}

fn parse_stroke_join(value: &str) -> Result<StrokeJoin, JsValue> {
    match value {
        "" | "miter" => Ok(StrokeJoin::Miter),
        "bevel" => Ok(StrokeJoin::Bevel),
        "round" => Ok(StrokeJoin::Round),
        _ => Err(JsValue::from_str("INVALID_STROKE_JOIN")),
    }
}

fn format_stroke_join(join: StrokeJoin) -> String {
    match join {
        StrokeJoin::Miter => "miter",
        StrokeJoin::Bevel => "bevel",
        StrokeJoin::Round => "round",
    }
    .into()
}

fn parse_stroke_align(value: &str) -> Result<StrokeAlign, JsValue> {
    match value {
        "" | "inside" => Ok(StrokeAlign::Inside),
        "center" => Ok(StrokeAlign::Center),
        "outside" => Ok(StrokeAlign::Outside),
        _ => Err(JsValue::from_str("INVALID_STROKE_ALIGN")),
    }
}

fn shape_gpu_stroke_outset(
    kind: NodeKind,
    has_arc_data: bool,
    align: StrokeAlign,
    stroke_width: f64,
    stroke_alpha: f32,
) -> f32 {
    if !matches!(kind, NodeKind::Frame | NodeKind::Rectangle | NodeKind::Ellipse)
        || (kind == NodeKind::Ellipse && has_arc_data)
        || stroke_width <= 0.0
        || stroke_alpha <= 0.0
    {
        return 0.0;
    }
    match align {
        StrokeAlign::Center => stroke_width as f32 / 2.0,
        StrokeAlign::Outside => stroke_width as f32,
        StrokeAlign::Inside => 0.0,
    }
}

fn format_constraint_type(value: ConstraintType) -> &'static str {
    match value {
        ConstraintType::Min => "min",
        ConstraintType::Center => "center",
        ConstraintType::Max => "max",
        ConstraintType::Stretch => "stretch",
        ConstraintType::Scale => "scale",
    }
}

fn parse_constraint_type(value: &str) -> Result<ConstraintType, JsValue> {
    match value {
        "min" => Ok(ConstraintType::Min),
        "center" => Ok(ConstraintType::Center),
        "max" => Ok(ConstraintType::Max),
        "stretch" => Ok(ConstraintType::Stretch),
        "scale" => Ok(ConstraintType::Scale),
        _ => Err(JsValue::from_str("INVALID_CONSTRAINTS")),
    }
}

fn format_stroke_align(align: StrokeAlign) -> String {
    match align {
        StrokeAlign::Center => "center",
        StrokeAlign::Inside => "inside",
        StrokeAlign::Outside => "outside",
    }
    .into()
}

fn parse_css_color(value: &str) -> Result<Color, JsValue> {
    if value == "transparent" {
        return Ok(Color::from_srgb_u8([0, 0, 0], 0));
    }
    Color::parse_css_hex(value).map_err(|_| JsValue::from_str("INVALID_COLOR"))
}

fn format_document_color_profile(profile: DocumentColorProfile) -> String {
    match profile {
        DocumentColorProfile::Srgb => "srgb",
        DocumentColorProfile::DisplayP3 => "display-p3",
    }
    .into()
}

fn parse_document_color_profile(value: &str) -> Result<DocumentColorProfile, JsValue> {
    match value {
        "srgb" => Ok(DocumentColorProfile::Srgb),
        "display-p3" => Ok(DocumentColorProfile::DisplayP3),
        _ => Err(JsValue::from_str("INVALID_DOCUMENT_COLOR_PROFILE")),
    }
}

fn projection_color(color: Color) -> ProjectionColor {
    ProjectionColor {
        space: match color.space {
            ColorSpace::Srgb => "srgb",
            ColorSpace::DisplayP3 => "display-p3",
            ColorSpace::LinearSrgb => "linear-srgb",
        }
        .into(),
        components: color.components,
        alpha: color.alpha,
    }
}

fn color_from_projection(color: &ProjectionColor) -> Result<Color, JsValue> {
    let space = match color.space.as_str() {
        "srgb" => ColorSpace::Srgb,
        "display-p3" => ColorSpace::DisplayP3,
        "linear-srgb" => ColorSpace::LinearSrgb,
        _ => return Err(JsValue::from_str("INVALID_COLOR")),
    };
    Color::new(space, color.components, color.alpha).map_err(|_| JsValue::from_str("INVALID_COLOR"))
}

fn paint_from_projection(
    css: &str,
    color: Option<&ProjectionColor>,
    gradient: Option<&ProjectionLinearGradient>,
) -> Result<Paint, JsValue> {
    if let Some(gradient) = gradient {
        let stops = gradient
            .stops
            .iter()
            .map(|stop| {
                Ok(GradientStop {
                    position: stop.position,
                    color: color_from_projection(&stop.color)?,
                })
            })
            .collect::<Result<Vec<_>, JsValue>>()?;
        return LinearGradient::new(gradient.start, gradient.end, stops)
            .map(Paint::LinearGradient)
            .map_err(|_| JsValue::from_str("INVALID_GRADIENT"));
    }
    let Some(color) = color else {
        return parse_css_color(css).map(Paint::Solid);
    };
    color_from_projection(color).map(Paint::Solid)
}

fn projection_page(page: &Page) -> ProjectionPage {
    ProjectionPage {
        id: format_page_id(page.id),
        name: page.name.clone(),
        position_id: format_position_id(page.position),
    }
}

fn page_from_projection(page: ProjectionPage) -> Result<Page, JsValue> {
    if page.name.trim().is_empty() {
        return Err(JsValue::from_str("INVALID_PAGE_NAME"));
    }
    Ok(Page {
        id: parse_page_id(&page.id)?,
        name: page.name,
        position: parse_position_id(&page.position_id)?,
    })
}

fn projection_asset(asset: &AssetReference) -> ProjectionAsset {
    ProjectionAsset {
        asset_id: format_uuid(NodeId(asset.asset_id.0)),
        content_hash: asset
            .content_hash
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        media_type: asset.media_type.clone(),
        byte_length: asset.byte_length,
        pixel_width: asset.dimensions.map(|[width, _]| width),
        pixel_height: asset.dimensions.map(|[_, height]| height),
    }
}

fn asset_from_projection(asset: ProjectionAsset) -> Result<AssetReference, JsValue> {
    let hash = asset.content_hash;
    if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(JsValue::from_str("INVALID_ASSET_REFERENCE"));
    }
    let mut content_hash = [0; 32];
    for (index, pair) in hash.as_bytes().chunks_exact(2).enumerate() {
        content_hash[index] = u8::from_str_radix(
            std::str::from_utf8(pair).map_err(|_| JsValue::from_str("INVALID_ASSET_REFERENCE"))?,
            16,
        )
        .map_err(|_| JsValue::from_str("INVALID_ASSET_REFERENCE"))?;
    }
    let dimensions = match (asset.pixel_width, asset.pixel_height) {
        (None, None) => None,
        (Some(width), Some(height)) => Some([width, height]),
        _ => return Err(JsValue::from_str("INVALID_ASSET_REFERENCE")),
    };
    Ok(AssetReference {
        asset_id: AssetId(parse_id(&asset.asset_id)?.0),
        content_hash,
        media_type: asset.media_type,
        byte_length: asset.byte_length,
        dimensions,
    })
}

fn projection_node(
    node: &Node,
    page_id: PageId,
    asset_id: Option<AssetId>,
    text_properties: Option<&TextProperties>,
) -> ProjectionNode {
    let project_paint = |paint: &Paint| match paint {
        Paint::Solid(color) => (
            color.to_css_srgb_hex(),
            Some(projection_color(*color)),
            None,
        ),
        Paint::LinearGradient(gradient) => (
            gradient.stops[0].color.to_css_srgb_hex(),
            None,
            Some(ProjectionLinearGradient {
                start: gradient.start,
                end: gradient.end,
                stops: gradient
                    .stops
                    .iter()
                    .map(|stop| ProjectionGradientStop {
                        position: stop.position,
                        color: projection_color(stop.color),
                    })
                    .collect(),
            }),
        ),
    };
    let (fill, fill_color, fill_gradient) = project_paint(&node.fill);
    let (stroke, stroke_color, stroke_gradient) = project_paint(&node.stroke);
    ProjectionNode {
        id: format_uuid(node.id),
        parent_id: node.parent_id.map(format_uuid),
        name: node.name.clone(),
        kind: match node.kind {
            NodeKind::Frame => "frame",
            NodeKind::Rectangle => "rectangle",
            NodeKind::Ellipse => "ellipse",
            NodeKind::Text => "text",
            NodeKind::Image => "image",
            NodeKind::Line => "line",
            NodeKind::Group => "group",
            NodeKind::Section => "section",
        }
        .into(),
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        rotation: node.rotation,
        fill,
        fill_color,
        fill_gradient,
        fills: node.fills.iter().map(|paint| {
            let (css, color, gradient) = project_paint(paint);
            ProjectionPaint { css, color, gradient }
        }).collect(),
        stroke,
        stroke_color,
        stroke_gradient,
        strokes: node.strokes.iter().map(|paint| {
            let (css, color, gradient) = project_paint(paint);
            ProjectionPaint { css, color, gradient }
        }).collect(),
        stroke_width: node.stroke_width,
        stroke_cap_start: format_stroke_cap(node.stroke_cap_start),
        stroke_cap_end: format_stroke_cap(node.stroke_cap_end),
        stroke_join: format_stroke_join(node.stroke_join),
        stroke_miter_limit: node.stroke_miter_limit,
        stroke_dash_pattern: node.stroke_dash_pattern.clone(),
        stroke_weights: node.stroke_weights.clone(),
        stroke_align: format_stroke_align(node.stroke_align),
        arc_data: node.arc_data.map(|arc| ProjectionArcData { starting_angle: arc.starting_angle, ending_angle: arc.ending_angle, inner_radius: arc.inner_radius }),
        relative_transform: node.relative_transform.map(|matrix| ProjectionTransform { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, e: matrix.e, f: matrix.f }),
        position_id: Some(format_position_id(node.position)),
        page_id: Some(format_page_id(page_id)),
        asset_id: asset_id.map(|id| format_uuid(NodeId(id.0))),
        text_properties: text_properties.map(projection_text_properties),
        opacity: node.opacity,
        corner_radius: node.corner_radius,
        corner_radii: node.corner_radii.clone(),
        corner_smoothing: node.corner_smoothing,
        constraints: node.constraints.map(|value| ProjectionConstraints { horizontal: format_constraint_type(value.horizontal).into(), vertical: format_constraint_type(value.vertical).into() }),
        text: node.text.clone(),
        visible: node.visible,
        locked: node.locked,
        contents_hidden: node.contents_hidden,
        clips_content: Some(node.clips_content),
        extensions: node.extensions.clone().into_iter().collect(),
    }
}

fn projection_text_properties(properties: &TextProperties) -> ProjectionTextProperties {
    ProjectionTextProperties {
        runs: properties
            .runs
            .iter()
            .map(|run| ProjectionTextStyleRun {
                start: run.start,
                end: run.end,
                font: run.font.as_ref().map(projection_font_reference),
                font_size: run.font_size,
                font_weight: run.font_weight,
                italic: run.italic,
                letter_spacing: run.letter_spacing,
            })
            .collect(),
        paragraph: ProjectionParagraphStyle {
            alignment: match properties.paragraph.alignment {
                TextAlign::Left => "left",
                TextAlign::Center => "center",
                TextAlign::Right => "right",
                TextAlign::Justify => "justify",
            }
            .into(),
            line_height: properties.paragraph.line_height,
            paragraph_spacing: properties.paragraph.paragraph_spacing,
        },
        auto_size: match properties.auto_size {
            TextAutoSize::Fixed => "fixed",
            TextAutoSize::Height => "height",
            TextAutoSize::WidthAndHeight => "widthAndHeight",
        }
        .into(),
        fallback_fonts: properties
            .fallback_fonts
            .iter()
            .map(projection_font_reference)
            .collect(),
    }
}

fn projection_font_reference(font: &FontReference) -> ProjectionFontReference {
    ProjectionFontReference {
        asset_id: format_uuid(NodeId(font.asset_id.0)),
        face_index: font.face_index,
        variation_axes: font
            .variation_axes
            .iter()
            .map(|(tag, value)| ProjectionFontVariation {
                tag: tag.clone(),
                value: *value,
            })
            .collect(),
    }
}

fn text_properties_from_projection(
    properties: Option<&ProjectionTextProperties>,
) -> Result<Option<TextProperties>, JsValue> {
    properties
        .map(|properties| {
            Ok(TextProperties {
                runs: properties
                    .runs
                    .iter()
                    .map(|run| {
                        Ok(TextStyleRun {
                            start: run.start,
                            end: run.end,
                            font: run.font.as_ref().map(font_from_projection).transpose()?,
                            font_size: run.font_size,
                            font_weight: run.font_weight,
                            italic: run.italic,
                            letter_spacing: run.letter_spacing,
                        })
                    })
                    .collect::<Result<Vec<_>, JsValue>>()?,
                paragraph: ParagraphStyle {
                    alignment: match properties.paragraph.alignment.as_str() {
                        "left" => TextAlign::Left,
                        "center" => TextAlign::Center,
                        "right" => TextAlign::Right,
                        "justify" => TextAlign::Justify,
                        _ => return Err(JsValue::from_str("INVALID_TEXT_PROPERTIES")),
                    },
                    line_height: properties.paragraph.line_height,
                    paragraph_spacing: properties.paragraph.paragraph_spacing,
                },
                auto_size: match properties.auto_size.as_str() {
                    "fixed" => TextAutoSize::Fixed,
                    "height" => TextAutoSize::Height,
                    "widthAndHeight" => TextAutoSize::WidthAndHeight,
                    _ => return Err(JsValue::from_str("INVALID_TEXT_PROPERTIES")),
                },
                fallback_fonts: properties
                    .fallback_fonts
                    .iter()
                    .map(font_from_projection)
                    .collect::<Result<Vec<_>, JsValue>>()?,
            })
        })
        .transpose()
}

fn font_from_projection(font: &ProjectionFontReference) -> Result<FontReference, JsValue> {
    Ok(FontReference {
        asset_id: AssetId(parse_id(&font.asset_id)?.0),
        face_index: font.face_index,
        variation_axes: font
            .variation_axes
            .iter()
            .map(|axis| Ok((axis.tag.clone(), axis.value)))
            .collect::<Result<_, JsValue>>()?,
    })
}

fn node_from_projection(node: ProjectionNode) -> Result<Node, JsValue> {
    let fill = paint_from_projection(
        &node.fill,
        node.fill_color.as_ref(),
        node.fill_gradient.as_ref(),
    )?;
    let stroke = paint_from_projection(
        &node.stroke,
        node.stroke_color.as_ref(),
        node.stroke_gradient.as_ref(),
    )?;
    let fills = node.fills.iter().map(|paint| paint_from_projection(&paint.css, paint.color.as_ref(), paint.gradient.as_ref())).collect::<Result<Vec<_>, _>>()?;
    let strokes = node.strokes.iter().map(|paint| paint_from_projection(&paint.css, paint.color.as_ref(), paint.gradient.as_ref())).collect::<Result<Vec<_>, _>>()?;
    let id = parse_id(&node.id)?;
    let position = node
        .position_id
        .as_deref()
        .map(parse_position_id)
        .transpose()?
        .unwrap_or_else(|| PositionId::for_node(id));
    let kind = parse_kind(&node.kind)?;
    let clips_content = node.clips_content.unwrap_or(kind == NodeKind::Frame);
    Ok(Node {
        id,
        parent_id: node.parent_id.as_deref().map(parse_id).transpose()?,
        position,
        name: node.name,
        kind,
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        rotation: node.rotation,
        fill,
        stroke,
        fills,
        strokes,
        stroke_width: node.stroke_width,
        stroke_cap_start: parse_stroke_cap(&node.stroke_cap_start)?,
        stroke_cap_end: parse_stroke_cap(&node.stroke_cap_end)?,
        stroke_join: parse_stroke_join(&node.stroke_join)?,
        stroke_miter_limit: node.stroke_miter_limit,
        stroke_dash_pattern: node.stroke_dash_pattern,
        stroke_weights: node.stroke_weights,
        stroke_align: parse_stroke_align(&node.stroke_align)?,
        arc_data: node.arc_data.map(|arc| ArcData { starting_angle: arc.starting_angle, ending_angle: arc.ending_angle, inner_radius: arc.inner_radius }),
        relative_transform: node.relative_transform.map(|matrix| editor_core::geometry::AffineTransform { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, e: matrix.e, f: matrix.f }),
        opacity: node.opacity,
        corner_radius: node.corner_radius,
        corner_radii: node.corner_radii,
        corner_smoothing: node.corner_smoothing,
        constraints: node.constraints.map(|value| Ok::<Constraints, JsValue>(Constraints { horizontal: parse_constraint_type(&value.horizontal)?, vertical: parse_constraint_type(&value.vertical)? })).transpose()?,
        text: node.text,
        visible: node.visible,
        locked: node.locked,
        contents_hidden: node.contents_hidden,
        clips_content,
        extensions: node.extensions.into_iter().collect(),
    })
}

fn format_page_id(id: PageId) -> String {
    format_uuid(NodeId(id.0))
}

fn format_document_id(id: DocumentId) -> String {
    format_uuid(NodeId(id.0))
}

fn parse_document_id(value: &str) -> Result<DocumentId, JsValue> {
    parse_id(value).map(|id| DocumentId(id.0))
}

fn parse_page_id(value: &str) -> Result<PageId, JsValue> {
    parse_id(value).map(|id| PageId(id.0))
}

fn format_uuid(id: NodeId) -> String {
    let value = format!("{:032x}", id.0);
    format!(
        "{}-{}-{}-{}-{}",
        &value[0..8],
        &value[8..12],
        &value[12..16],
        &value[16..20],
        &value[20..32]
    )
}

fn format_position_id(position: PositionId) -> String {
    format!("{:032x}:{:032x}", position.key, position.actor.0)
}

fn parse_position_id(value: &str) -> Result<PositionId, JsValue> {
    let Some((key, actor)) = value.split_once(':') else {
        return Err(JsValue::from_str("INVALID_POSITION_ID"));
    };
    if key.len() != 32
        || actor.len() != 32
        || !key.bytes().all(|byte| byte.is_ascii_hexdigit())
        || !actor.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(JsValue::from_str("INVALID_POSITION_ID"));
    }
    let key =
        u128::from_str_radix(key, 16).map_err(|_| JsValue::from_str("INVALID_POSITION_ID"))?;
    let actor =
        u128::from_str_radix(actor, 16).map_err(|_| JsValue::from_str("INVALID_POSITION_ID"))?;
    Ok(PositionId {
        key,
        actor: ActorId(actor),
    })
}

fn core_error(error: editor_core::CommandError) -> JsValue {
    JsValue::from_str(&format!("{error:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn existing_rect(id: NodeId) -> Node {
        Node {
            id,
            parent_id: None,
            position: PositionId::for_node(id),
            name: "Existing".into(),
            kind: NodeKind::Rectangle,
            x: 0.0,
            y: 0.0,
            width: 20.0,
            height: 20.0,
            rotation: 0.0,
            fill: "#ffffff".into(),
            stroke: "#00000000".into(),
            fills: Vec::new(),
            strokes: Vec::new(),
            stroke_width: 0.0,
            stroke_cap_start: Default::default(),
            stroke_cap_end: Default::default(),
            stroke_join: Default::default(),
            stroke_miter_limit: 10.0,
            stroke_dash_pattern: Vec::new(),
            stroke_weights: Vec::new(),
            stroke_align: Default::default(),
            arc_data: None,
            relative_transform: None,
            opacity: 1.0,
            corner_radius: 0.0,
            corner_radii: Vec::new(),
            corner_smoothing: 0.0,
            constraints: None,
            text: String::new(),
            visible: true,
            locked: false,
            contents_hidden: false,
            clips_content: false,
            extensions: std::collections::BTreeMap::new(),
        }
    }

    #[test]
    fn exposes_canonical_stroke_mesh_at_the_wasm_boundary() {
        let mesh = serde_json::from_str::<serde_json::Value>(
            &stroke_mesh_for_polyline_json("[[0,0],[10,0]]", 4.0, "round", "round", 4.0, false)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(mesh["bounds"]["min"], serde_json::json!([-2.0, -2.0]));
        assert_eq!(mesh["bounds"]["max"], serde_json::json!([12.0, 2.0]));
        assert!(mesh["triangles"].as_array().is_some_and(|triangles| triangles.len() > 2));

        let closed = serde_json::from_str::<serde_json::Value>(
            &stroke_mesh_for_polyline_json(
                "[[0,0],[10,0],[10,6],[0,6]]",
                2.0,
                "butt",
                "miter",
                4.0,
                true,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(closed["bounds"]["min"], serde_json::json!([-1.0, -1.0]));
        assert_eq!(closed["bounds"]["max"], serde_json::json!([11.0, 7.0]));

        let rounded = serde_json::from_str::<serde_json::Value>(
            &stroke_mesh_for_rounded_rectangle_json(100.0, 60.0, 12.0, 8.0, "round", 4.0)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(rounded["bounds"]["min"], serde_json::json!([-4.0, -4.0]));
        assert_eq!(rounded["bounds"]["max"], serde_json::json!([104.0, 64.0]));

        let independent = serde_json::from_str::<serde_json::Value>(
            &stroke_mesh_for_rounded_rectangle_with_radii_json(100.0, 60.0, "[12,24,8,16]", 8.0, "round", 4.0)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(independent["bounds"]["min"], serde_json::json!([-4.0, -4.0]));
        assert_eq!(independent["bounds"]["max"], serde_json::json!([104.0, 64.0]));

        let dashed_independent = serde_json::from_str::<serde_json::Value>(
            &stroke_mesh_for_dashed_rounded_rectangle_with_radii_json(100.0, 60.0, "[12,24,8,16]", 8.0, "[18,8]", "round", 4.0)
                .unwrap(),
        ).unwrap();
        assert!(dashed_independent["triangles"].as_array().is_some_and(|triangles| !triangles.is_empty()));

        let continuous = serde_json::from_str::<serde_json::Value>(
            &stroke_mesh_for_continuous_rounded_rectangle_with_radii_json(100.0, 60.0, "[12,24,8,16]", 0.5, 8.0, "[18,8]", "round", 4.0)
                .unwrap(),
        ).unwrap();
        assert!(continuous["triangles"].as_array().is_some_and(|triangles| !triangles.is_empty()));

        let dashed = serde_json::from_str::<serde_json::Value>(
            &stroke_mesh_for_dashed_line_json(94.0, 10.0, "[8,4]", "square", "miter", 4.0)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(dashed["bounds"]["min"], serde_json::json!([-5.0, -5.0]));
        assert_eq!(dashed["bounds"]["max"], serde_json::json!([97.0, 5.0]));

        let per_side = serde_json::from_str::<serde_json::Value>(
            &stroke_meshes_for_per_side_rectangle_json(100.0, 80.0, "[6,2,4,8]", "outside")
                .unwrap(),
        )
        .unwrap();
        assert_eq!(per_side["meshes"].as_array().map(Vec::len), Some(4));
        assert_eq!(per_side["meshes"][0]["bounds"]["min"], serde_json::json!([0.0, -6.0]));

        let dashed_per_side = serde_json::from_str::<serde_json::Value>(
            &stroke_meshes_for_per_side_rectangle_with_dash_json(100.0, 80.0, "[6,2,4,8]", "outside", "[12,8]")
                .unwrap(),
        )
        .unwrap();
        assert_eq!(dashed_per_side["meshes"][0]["bounds"]["max"], serde_json::json!([92.0, 0.0]));

        let dashed_closed = serde_json::from_str::<serde_json::Value>(
            &stroke_mesh_for_dashed_polyline_json(
                "[[0,0],[100,0],[100,60],[0,60]]", 4.0, "[120,20]", "butt", "miter", 4.0, true,
            ).unwrap(),
        ).unwrap();
        assert!(dashed_closed["triangles"].as_array().is_some_and(|triangles| !triangles.is_empty()));
    }

    #[test]
    fn exposes_decorative_endpoint_cap_meshes_at_the_wasm_boundary() {
        // End arrowhead: tip at the endpoint, base `size` (= max(8, w·4)) beyond.
        let arrow = serde_json::from_str::<serde_json::Value>(
            &decorative_cap_mesh_json("arrowEquilateral", 100.0, 1.0, 3.0).unwrap(),
        )
        .unwrap();
        assert_eq!(arrow["bounds"]["min"][0], serde_json::json!(100.0));
        assert_eq!(arrow["bounds"]["max"][0], serde_json::json!(112.0));
        assert!(arrow["triangles"].as_array().is_some_and(|triangles| !triangles.is_empty()));

        // Start dot: centred on the endpoint, radius size/2 = 8.
        let dot = serde_json::from_str::<serde_json::Value>(
            &decorative_cap_mesh_json("circleFilled", 0.0, -1.0, 4.0).unwrap(),
        )
        .unwrap();
        assert_eq!(dot["bounds"]["min"], serde_json::json!([-8.0, -8.0]));
        assert_eq!(dot["bounds"]["max"], serde_json::json!([8.0, 8.0]));
    }

    #[test]
    fn exposes_graphics_core_caret_map_without_utf8_splitting() {
        let layout = fallback_text_layout_json("A😀中", 2);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&layout).unwrap(),
            serde_json::json!({
                "lines": [
                    { "start": 0, "end": 5, "direction": "ltr" },
                    { "start": 5, "end": 8, "direction": "ltr" },
                ],
                "carets": [
                    { "byteOffset": 0, "lineIndex": 0 },
                    { "byteOffset": 1, "lineIndex": 0 },
                    { "byteOffset": 5, "lineIndex": 0 },
                    { "byteOffset": 5, "lineIndex": 1 },
                    { "byteOffset": 8, "lineIndex": 1 },
                ],
            })
        );
    }

    #[test]
    fn exposes_ime_preview_without_mutating_the_document() {
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &preview_text_replacement_json("A😀B", 1, 5, "中").unwrap()
            )
            .unwrap(),
            serde_json::json!({
                "text": "A中B",
                "selection": { "anchor": 4, "focus": 4 },
            })
        );
    }

    #[test]
    fn exposes_font_byte_shaping_to_the_wasm_boundary() {
        let result = serde_json::from_str::<serde_json::Value>(
            &shape_text_json(
                font_test_data::NOTO_SERIF_DISPLAY_TRIMMED,
                0,
                "office",
                "ltr",
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(result["direction"], "ltr");
        assert!(result["unitsPerEm"].as_i64().is_some_and(|value| value > 0));
        assert!(
            result["glyphs"]
                .as_array()
                .is_some_and(|glyphs| !glyphs.is_empty())
        );
    }

    #[test]
    fn exposes_a_bounded_glyph_alpha_mask_to_the_wasm_boundary() {
        let result = serde_json::from_str::<serde_json::Value>(
            &rasterize_glyph_json(font_test_data::NOTO_SERIF_DISPLAY_TRIMMED, 0, 1, 32).unwrap(),
        )
        .unwrap();
        assert!(result["width"].as_u64().is_some_and(|value| value > 0));
        assert!(result["height"].as_u64().is_some_and(|value| value > 0));
        assert_eq!(
            result["pixels"].as_array().map(Vec::len),
            Some((result["width"].as_u64().unwrap() * result["height"].as_u64().unwrap()) as usize),
        );
    }

    #[test]
    fn parses_variable_font_axes_for_the_wasm_layout_and_raster_boundaries() {
        let axes = r#"[{"tag":"wght","value":800}]"#;
        let axes = parse_font_variations(axes).unwrap();
        assert_eq!(axes.len(), 1);
        assert_eq!(axes[0].tag, *b"wght");
        let layout = makefigma_graphics_core::layout_shaped_text_with_variations(
            font_test_data::VAZIRMATN_VAR,
            0,
            &axes,
            "ا ا",
            10.0,
        )
        .unwrap();
        assert!(!layout.lines.is_empty());
        let raster = makefigma_graphics_core::rasterize_glyph_with_variations(
            font_test_data::VAZIRMATN_VAR,
            0,
            &axes,
            1,
            32,
        )
        .unwrap();
        assert!(!raster.pixels.is_empty());
    }

    #[test]
    fn exposes_icu4x_shaped_line_ranges_to_the_wasm_boundary() {
        let result = serde_json::from_str::<serde_json::Value>(
            &layout_shaped_text_json(
                font_test_data::NOTO_SERIF_DISPLAY_TRIMMED,
                0,
                "office office",
                3.0,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(result["lines"].as_array().map(Vec::len), Some(2));
        assert_eq!(result["lines"][0]["start"], 0);
        assert_eq!(result["lines"][0]["end"], 7);
        assert!(
            result["lines"][0]["glyphs"]
                .as_array()
                .is_some_and(|glyphs| !glyphs.is_empty())
        );
        assert!(
            result["carets"]
                .as_array()
                .is_some_and(|carets| carets.len() > 2)
        );
    }

    #[test]
    fn exposes_uax9_visual_runs_without_rewriting_source_offsets() {
        let source = "office مرحبا office";
        let result = serde_json::from_str::<serde_json::Value>(
            &layout_shaped_text_json(font_test_data::NOTO_SERIF_DISPLAY_TRIMMED, 0, source, 100.0)
                .unwrap(),
        )
        .unwrap();
        let runs = result["lines"][0]["visualRuns"].as_array().unwrap();
        assert!(runs.len() >= 3);
        assert!(runs.iter().any(|run| run["direction"] == "rtl"));
        let covered = runs
            .iter()
            .map(|run| run["end"].as_u64().unwrap() - run["start"].as_u64().unwrap())
            .sum::<u64>();
        assert_eq!(covered, source.len() as u64);
    }

    #[test]
    fn projects_a_canonical_document_to_a_handle_free_render_graph() {
        let mut engine = DocumentEngine::new();
        engine
            .create_node(
                "00000000-0000-0000-0000-000000000111",
                0,
                "00000000-0000-0000-0000-000000000222",
                "rectangle",
                "Card",
                10.0,
                20.0,
                80.0,
                40.0,
                0.0,
                "#ffffff",
                "transparent",
                0.0,
                1.0,
                0.0,
                true,
                false,
                "",
            )
            .unwrap();
        let plan = serde_json::from_str::<serde_json::Value>(
            &engine.render_graph_plan_json(0.0, 0.0, 200.0, 100.0),
        )
        .unwrap();
        assert_eq!(plan["documentRevision"], 1);
        assert_eq!(
            plan["passes"],
            serde_json::json!(["mainScene", "images", "text", "overlay", "composite"])
        );
        assert_eq!(
            plan["commands"],
            serde_json::json!([{
                "nodeId": "00000000-0000-0000-0000-000000000222",
                "pass": "mainScene",
            }])
        );
    }

    #[test]
    fn render_graph_page_projection_never_schedules_another_page() {
        let mut engine = DocumentEngine::new();
        let second_page = "00000000-0000-0000-0000-000000000333";
        engine
            .create_page(
                "00000000-0000-0000-0000-000000000334",
                0,
                second_page,
                "Second page",
            )
            .unwrap();
        engine
            .create_node_on_page(
                "00000000-0000-0000-0000-000000000335",
                1,
                second_page,
                "00000000-0000-0000-0000-000000000336",
                "text",
                "Only second page",
                0.0,
                0.0,
                40.0,
                20.0,
                0.0,
                "#ffffff",
                "transparent",
                0.0,
                1.0,
                0.0,
                true,
                false,
                "Second",
            )
            .unwrap();
        let plan = serde_json::from_str::<serde_json::Value>(
            &engine
                .render_graph_plan_for_page_json(second_page, -100.0, -100.0, 200.0, 200.0)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(plan["documentRevision"], 2);
        assert_eq!(
            plan["commands"],
            serde_json::json!([{
                "nodeId": "00000000-0000-0000-0000-000000000336",
                "pass": "text",
            }])
        );
    }

    #[test]
    fn projects_solid_page_nodes_to_the_wgsl_instance_layout() {
        let mut engine = DocumentEngine::new();
        engine
            .create_node(
                "00000000-0000-0000-0000-000000000311",
                0,
                "00000000-0000-0000-0000-000000000322",
                "ellipse",
                "Orb",
                10.0,
                20.0,
                80.0,
                40.0,
                0.0,
                "#ff000080",
                "#11223380",
                0.0,
                0.5,
                8.0,
                true,
                false,
                "",
            )
            .unwrap();
        let instances = serde_json::from_str::<serde_json::Value>(
            &engine
                .gpu_scene_instances_json("00000000-0000-0000-0000-000000000001")
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            instances["renderedNodeIds"],
            serde_json::json!(["00000000-0000-0000-0000-000000000322"])
        );
        assert_eq!(
            instances["instanceFloats"].as_array().map(Vec::len),
            Some(16)
        );
        assert_eq!(instances["instanceFloats"][5], 1.0);
        let floats = instances["instanceFloats"].as_array().unwrap();
        assert_eq!(floats[8], 1.0);
        assert_eq!(floats[9], 0.0);
        assert_eq!(floats[10], 0.0);
        assert!((floats[11].as_f64().unwrap() - 128.0 / 255.0 * 0.5).abs() < 0.000_001);
        assert!((floats[12].as_f64().unwrap() - 17.0 / 255.0).abs() < 0.000_001);
        assert!((floats[13].as_f64().unwrap() - 34.0 / 255.0).abs() < 0.000_001);
        assert!((floats[14].as_f64().unwrap() - 51.0 / 255.0).abs() < 0.000_001);
        assert!((floats[15].as_f64().unwrap() - 128.0 / 255.0 * 0.5).abs() < 0.000_001);
    }

    #[test]
    fn maps_uniform_closed_shape_alignments_to_gpu_outsets() {
        assert_eq!(shape_gpu_stroke_outset(NodeKind::Ellipse, false, StrokeAlign::Outside, 8.0, 1.0), 8.0);
        assert_eq!(shape_gpu_stroke_outset(NodeKind::Ellipse, false, StrokeAlign::Center, 8.0, 1.0), 4.0);
        assert_eq!(shape_gpu_stroke_outset(NodeKind::Ellipse, false, StrokeAlign::Inside, 8.0, 1.0), 0.0);
        assert_eq!(shape_gpu_stroke_outset(NodeKind::Ellipse, true, StrokeAlign::Outside, 8.0, 1.0), 0.0);
        assert_eq!(shape_gpu_stroke_outset(NodeKind::Rectangle, false, StrokeAlign::Outside, 8.0, 1.0), 8.0);
    }

    #[test]
    fn snapshot_v14_preserves_document_identity_and_resource_index() {
        let mut source = DocumentEngine::new();
        source.document = Document::with_id(DocumentId(42));
        source
            .document
            .seed_asset(AssetReference {
                asset_id: AssetId(7),
                content_hash: [9; 32],
                media_type: "image/png".into(),
                byte_length: 128,
                dimensions: Some([16, 8]),
            })
            .unwrap();
        let snapshot = source.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":19"));
        assert!(snapshot.contains("\"documentId\":\"00000000-0000-0000-0000-00000000002a\""));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.document.id(), DocumentId(42));
        assert_eq!(
            restored.document.asset(AssetId(7)).unwrap().dimensions,
            Some([16, 8])
        );

        let mut legacy: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        legacy["schemaVersion"] = serde_json::json!(10);
        legacy.as_object_mut().unwrap().remove("documentId");
        legacy.as_object_mut().unwrap().remove("canonicalHash");
        let mut migrated = DocumentEngine::new();
        migrated.load_snapshot_json(&legacy.to_string()).unwrap();
        assert_eq!(migrated.document.id(), DocumentId(0));
    }

    #[test]
    fn registered_asset_crosses_the_wasm_bridge_and_survives_a_snapshot() {
        let mut engine = DocumentEngine::new();
        engine
            .register_asset(
                "00000000-0000-0000-0000-000000000001",
                0,
                "00000000-0000-0000-0000-000000000002",
                &"ab".repeat(32),
                "image/png",
                128,
                16,
                8,
            )
            .unwrap();
        assert_eq!(
            engine.document.asset(AssetId(2)).unwrap().dimensions,
            Some([16, 8])
        );
        let snapshot = engine.snapshot_protobuf().unwrap();
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_protobuf(&snapshot).unwrap();
        assert_eq!(
            restored.document.asset(AssetId(2)).unwrap().content_hash,
            [0xab; 32]
        );
    }

    #[test]
    fn protobuf_snapshot_uses_the_same_validating_codec_as_document_service() {
        let mut source = DocumentEngine::new();
        source
            .create_node(
                "00000000-0000-0000-0000-000000000001",
                0,
                "00000000-0000-0000-0000-000000000002",
                "rectangle",
                "Remote card",
                1.0,
                2.0,
                30.0,
                40.0,
                0.0,
                "#ffffff",
                "#00000000",
                0.0,
                1.0,
                0.0,
                true,
                false,
                "",
            )
            .unwrap();
        let wire = source.snapshot_protobuf().unwrap();
        let mut restored = DocumentEngine::new();
        assert_eq!(restored.load_snapshot_protobuf(&wire).unwrap(), 1);
        assert_eq!(restored.canonical_hash(), source.canonical_hash());
    }

    #[test]
    fn line_survives_service_wire_and_local_json_snapshot_round_trip() {
        let mut source = DocumentEngine::new();
        source
            .create_node(
                "00000000-0000-0000-0000-000000000001",
                0,
                "00000000-0000-0000-0000-000000000002",
                "line",
                "Line",
                84.0,
                201.0,
                130.0,
                0.0,
                22.619_865,
                "#000000",
                "#0048ff",
                1.0,
                1.0,
                0.0,
                true,
                false,
                "",
            )
            .unwrap();

        let wire = source.snapshot_protobuf().unwrap();
        let mut service_rehydrated = DocumentEngine::new();
        service_rehydrated.load_snapshot_protobuf(&wire).unwrap();
        let local_snapshot = service_rehydrated.snapshot_json();

        let mut browser_rehydrated = DocumentEngine::new();
        browser_rehydrated.load_snapshot_json(&local_snapshot).unwrap();
        assert_eq!(browser_rehydrated.canonical_hash(), source.canonical_hash());
    }

    #[test]
    fn phase2_common_nodes_fixture_survives_service_wire_and_local_snapshot_round_trip() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!("../../../fixtures/documents/phase2-common-nodes.fixture.json")).unwrap();
        let nodes = fixture["nodes"].as_array().unwrap();
        let batch = nodes
            .iter()
            .map(|source| {
                // The fixture is a browser presentation document. Match the
                // transaction adapter at the durable boundary: `radius` is
                // projected to the Canonical `cornerRadius`, and absent
                // editable flags receive their deterministic defaults.
                let mut node = source.clone();
                node["cornerRadius"] = node.get("radius").cloned().unwrap_or_else(|| serde_json::json!(0));
                node["locked"] = node.get("locked").cloned().unwrap_or_else(|| serde_json::json!(false));
                serde_json::json!({ "type": "create", "node": node })
            })
            .collect::<Vec<_>>();

        let mut source = DocumentEngine::new();
        source.seed_batch_json(&serde_json::to_string(&batch).unwrap()).unwrap();
        let source_hash = source.canonical_hash();
        assert_eq!(serde_json::from_str::<serde_json::Value>(&source.snapshot_json()).unwrap()["nodes"].as_array().map(Vec::len), Some(nodes.len()));

        // The Protobuf payload is the durable service boundary; the JSON
        // projection is the browser-local recovery boundary.
        let service_wire = source.snapshot_protobuf().unwrap();
        let mut service_rehydrated = DocumentEngine::new();
        service_rehydrated.load_snapshot_protobuf(&service_wire).unwrap();
        assert_eq!(service_rehydrated.canonical_hash(), source_hash);

        let mut browser_rehydrated = DocumentEngine::new();
        browser_rehydrated.load_snapshot_json(&service_rehydrated.snapshot_json()).unwrap();
        assert_eq!(browser_rehydrated.canonical_hash(), source_hash);
    }

    #[test]
    fn bridge_uses_core_revision_checks() {
        let mut engine = DocumentEngine::new();
        let id = NodeId(1);
        let node = Node {
            id,
            parent_id: None,
            position: PositionId::for_node(id),
            name: "Card".into(),
            kind: NodeKind::Rectangle,
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 80.0,
            rotation: 0.0,
            fill: "#e6edff".into(),
            stroke: "#00000000".into(),
            fills: Vec::new(),
            strokes: Vec::new(),
            stroke_width: 0.0,
            stroke_cap_start: Default::default(),
            stroke_cap_end: Default::default(),
            stroke_join: Default::default(),
            stroke_miter_limit: 10.0,
            stroke_dash_pattern: Vec::new(),
           stroke_weights: Vec::new(),
           stroke_align: Default::default(),
            arc_data: None,
            relative_transform: None,
            opacity: 1.0,
            corner_radius: 12.0,
            corner_radii: Vec::new(),
            corner_smoothing: 0.0,
            constraints: None,
            text: String::new(),
            visible: true,
            locked: false,
            contents_hidden: false,
            clips_content: false,
            extensions: Default::default(),
        };
        assert_eq!(
            engine
                .submit_create(NodeId(16), 0, node, Origin::LocalUser)
                .unwrap(),
            1
        );
        assert!(
            engine
                .submit_rename(NodeId(17), 0, id, "Stale".into())
                .is_err()
        );
    }

    #[test]
    fn unknown_node_extensions_survive_operation_replay_and_both_snapshot_boundaries() {
        // A node authored by a future engine carries opaque extension payloads.
        // They must ride through operation replay (submit_create) and both the
        // durable Protobuf service boundary and the browser-local JSON boundary
        // byte-for-byte, without ever surfacing as an editable field.
        let mut extensions = std::collections::BTreeMap::new();
        extensions.insert("phase3.autoLayout".to_string(), vec![0x00, 0xff, 0x7f, 0x80, 0x00]);
        extensions.insert("phase3.blend".to_string(), Vec::<u8>::new());

        let id = NodeId(1);
        let node = Node {
            id,
            parent_id: None,
            position: PositionId::for_node(id),
            name: "Future".into(),
            kind: NodeKind::Rectangle,
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 80.0,
            rotation: 0.0,
            fill: "#e6edff".into(),
            stroke: "#00000000".into(),
            fills: Vec::new(),
            strokes: Vec::new(),
            stroke_width: 0.0,
            stroke_cap_start: Default::default(),
            stroke_cap_end: Default::default(),
            stroke_join: Default::default(),
            stroke_miter_limit: 10.0,
            stroke_dash_pattern: Vec::new(),
            stroke_weights: Vec::new(),
            stroke_align: Default::default(),
            arc_data: None,
            relative_transform: None,
            opacity: 1.0,
            corner_radius: 0.0,
            corner_radii: Vec::new(),
            corner_smoothing: 0.0,
            constraints: None,
            text: String::new(),
            visible: true,
            locked: false,
            contents_hidden: false,
            clips_content: false,
            extensions: extensions.clone(),
        };

        let mut source = DocumentEngine::new();
        source.submit_create(NodeId(16), 0, node, Origin::LocalUser).unwrap();
        // Operation replay preserved the payloads verbatim.
        assert_eq!(source.document.node(id).unwrap().extensions, extensions);
        let source_hash = source.canonical_hash();

        // Durable Protobuf service boundary.
        let service_wire = source.snapshot_protobuf().unwrap();
        let mut service_rehydrated = DocumentEngine::new();
        service_rehydrated.load_snapshot_protobuf(&service_wire).unwrap();
        assert_eq!(service_rehydrated.document.node(id).unwrap().extensions, extensions);
        assert_eq!(service_rehydrated.canonical_hash(), source_hash);

        // Browser-local JSON recovery boundary.
        let mut browser_rehydrated = DocumentEngine::new();
        browser_rehydrated.load_snapshot_json(&service_rehydrated.snapshot_json()).unwrap();
        assert_eq!(browser_rehydrated.document.node(id).unwrap().extensions, extensions);
        assert_eq!(browser_rehydrated.canonical_hash(), source_hash);
    }

    #[test]
    fn future_node_kind_snapshot_is_rejected_read_only_without_mutating_the_open_document() {
        use prost::Message;
        // Build a valid one-node snapshot, then rewrite that node's kind to a tag
        // no current engine mints (a Phase 3 NodeKind reaching an old client).
        let id = NodeId(1);
        let node = Node {
            id,
            parent_id: None,
            position: PositionId::for_node(id),
            name: "Present".into(),
            kind: NodeKind::Rectangle,
            x: 0.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
            rotation: 0.0,
            fill: "#e6edff".into(),
            stroke: "#00000000".into(),
            fills: Vec::new(),
            strokes: Vec::new(),
            stroke_width: 0.0,
            stroke_cap_start: Default::default(),
            stroke_cap_end: Default::default(),
            stroke_join: Default::default(),
            stroke_miter_limit: 10.0,
            stroke_dash_pattern: Vec::new(),
            stroke_weights: Vec::new(),
            stroke_align: Default::default(),
            arc_data: None,
            relative_transform: None,
            opacity: 1.0,
            corner_radius: 0.0,
            corner_radii: Vec::new(),
            corner_smoothing: 0.0,
            constraints: None,
            text: String::new(),
            visible: true,
            locked: false,
            contents_hidden: false,
            clips_content: false,
            extensions: std::collections::BTreeMap::new(),
        };
        let mut source = DocumentEngine::new();
        source.submit_create(NodeId(16), 0, node, Origin::LocalUser).unwrap();
        let wire = source.snapshot_protobuf().unwrap();

        let mut decoded = makefigma_protocol::v1::DocumentSnapshot::decode(wire.as_slice()).unwrap();
        let reference = &mut decoded.page_chunks[0].nodes[0];
        let mut inner =
            makefigma_protocol::v1::SceneNode::decode(reference.canonical_node.as_slice()).unwrap();
        inner.kind = 9; // beyond NODE_KIND_SECTION = 8
        reference.canonical_node = inner.encode_to_vec();
        let future_wire = decoded.encode_to_vec();

        // A client with an already-open document. The codec rejects the future
        // snapshot before `load_snapshot_protobuf` ever reassigns `self.document`
        // (the `?` short-circuits), so the open document cannot be mutated. We
        // assert the rejection at the codec layer directly: constructing the
        // wasm-bindgen JsValue error is not possible in a native test.
        let mut engine = DocumentEngine::new();
        engine.submit_create(NodeId(17), 0, existing_rect(NodeId(2)), Origin::LocalUser).unwrap();
        let hash_before = engine.canonical_hash();

        assert_eq!(
            makefigma_document_codec::document_from_wire_snapshot(&future_wire).unwrap_err(),
            makefigma_document_codec::SnapshotError::UnsupportedFutureNode
        );
        // That rejection maps to the distinguishable read-only code, not the
        // generic corruption code (ADR 0023, P0-3).
        assert_eq!(
            snapshot_error_code(makefigma_document_codec::SnapshotError::UnsupportedFutureNode),
            "DOCUMENT_REQUIRES_NEWER_CLIENT"
        );
        assert_eq!(
            snapshot_error_code(makefigma_document_codec::SnapshotError::Invalid),
            "INVALID_CORE_SNAPSHOT"
        );
        // The open document is untouched and still loadable.
        assert_eq!(engine.canonical_hash(), hash_before);
        assert!(engine.document.node(NodeId(2)).is_some());
        // The same well-formed wire still loads once its kind is a known value.
        let mut ok_engine = DocumentEngine::new();
        assert!(ok_engine.load_snapshot_protobuf(&wire).is_ok());
    }

    #[test]
    fn update_and_multidelete_are_atomic() {
        let mut engine = DocumentEngine::new();
        let first = Node {
            id: NodeId(1),
            parent_id: None,
            position: PositionId::for_node(NodeId(1)),
            name: "First".into(),
            kind: NodeKind::Rectangle,
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 80.0,
            rotation: 0.0,
            fill: "#e6edff".into(),
            stroke: "#00000000".into(),
            fills: Vec::new(),
            strokes: Vec::new(),
            stroke_width: 0.0,
            stroke_cap_start: Default::default(),
            stroke_cap_end: Default::default(),
            stroke_join: Default::default(),
            stroke_miter_limit: 10.0,
            stroke_dash_pattern: Vec::new(),
           stroke_weights: Vec::new(),
           stroke_align: Default::default(),
            arc_data: None,
            relative_transform: None,
            opacity: 1.0,
            corner_radius: 12.0,
            corner_radii: Vec::new(),
            corner_smoothing: 0.0,
            constraints: None,
            text: String::new(),
            visible: true,
            locked: false,
            contents_hidden: false,
            clips_content: false,
            extensions: Default::default(),
        };
        let second = Node {
            id: NodeId(2),
            position: PositionId::for_node(NodeId(2)),
            ..first.clone()
        };
        engine
            .submit_create(NodeId(16), 0, first, Origin::LocalUser)
            .unwrap();
        engine
            .submit_create(NodeId(17), 1, second, Origin::LocalUser)
            .unwrap();
        assert_eq!(
            engine
                .submit_update(
                    NodeId(18),
                    2,
                    NodeId(1),
                    "Resized".into(),
                    10.0,
                    12.0,
                    140.0,
                    90.0,
                    0.0,
                    Appearance {
                        fill: "#e6edff".into(),
                        stroke: "#00000000".into(),
                        fills: Vec::new(),
                        strokes: Vec::new(),
                        stroke_width: 0.0,
            stroke_cap_start: Default::default(),
            stroke_cap_end: Default::default(),
            stroke_join: Default::default(),
            stroke_miter_limit: 10.0,
            stroke_dash_pattern: Vec::new(),
           stroke_weights: Vec::new(),
           stroke_align: Default::default(),
            arc_data: None,
            relative_transform: None,
            opacity: 1.0,
                        corner_radius: 12.0,
                        corner_radii: Vec::new(),
                        corner_smoothing: 0.0,
            constraints: None,
                        visible: true,
                        locked: false,
                        contents_hidden: false,
            clips_content: Some(false),
                    },
                    String::new(),
                )
                .unwrap(),
            3
        );
        assert_eq!(engine.document.node(NodeId(1)).unwrap().name, "Resized");
        assert!(
            engine
                .submit_delete(NodeId(19), 3, vec![NodeId(1), NodeId(99)])
                .is_err()
        );
        assert!(engine.document.node(NodeId(1)).is_some());
        assert!(engine.document.node(NodeId(2)).is_some());
    }

    #[test]
    fn bridge_undo_and_redo_publish_the_current_core_projection() {
        let mut engine = DocumentEngine::new();
        let node = Node {
            id: NodeId(1),
            parent_id: None,
            position: PositionId::for_node(NodeId(1)),
            name: "Card".into(),
            kind: NodeKind::Rectangle,
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 80.0,
            rotation: 0.0,
            fill: "#e6edff".into(),
            stroke: "#00000000".into(),
            fills: Vec::new(),
            strokes: Vec::new(),
            stroke_width: 0.0,
            stroke_cap_start: Default::default(),
            stroke_cap_end: Default::default(),
            stroke_join: Default::default(),
            stroke_miter_limit: 10.0,
            stroke_dash_pattern: Vec::new(),
           stroke_weights: Vec::new(),
           stroke_align: Default::default(),
            arc_data: None,
            relative_transform: None,
            opacity: 1.0,
            corner_radius: 12.0,
            corner_radii: Vec::new(),
            corner_smoothing: 0.0,
            constraints: None,
            text: String::new(),
            visible: true,
            locked: false,
            contents_hidden: false,
            clips_content: false,
            extensions: Default::default(),
        };
        engine
            .submit_create(NodeId(16), 0, node, Origin::LocalUser)
            .unwrap();
        assert!(engine.can_undo());
        assert_eq!(engine.undo().unwrap(), 2);
        assert!(!engine.snapshot_json().contains("Card"));
        assert!(engine.can_redo());
        assert_eq!(engine.redo().unwrap(), 3);
        assert!(engine.snapshot_json().contains("Card"));
    }

    #[test]
    fn core_snapshot_round_trips_without_restoring_undo_history() {
        let mut source = DocumentEngine::new();
        let node = Node {
            id: NodeId(1),
            parent_id: None,
            position: PositionId::for_node(NodeId(1)),
            name: "Saved card".into(),
            kind: NodeKind::Rectangle,
            x: 12.0,
            y: 24.0,
            width: 100.0,
            height: 80.0,
            rotation: 0.0,
            fill: "#e6edff".into(),
            stroke: "#00000000".into(),
            fills: Vec::new(),
            strokes: Vec::new(),
            stroke_width: 0.0,
            stroke_cap_start: Default::default(),
            stroke_cap_end: Default::default(),
            stroke_join: Default::default(),
            stroke_miter_limit: 10.0,
            stroke_dash_pattern: Vec::new(),
            stroke_weights: Vec::new(),
            stroke_align: Default::default(),
            arc_data: None,
            relative_transform: None,
            opacity: 0.75,
            corner_radius: 12.0,
            corner_radii: Vec::new(),
            corner_smoothing: 0.0,
            constraints: None,
            text: String::new(),
            visible: true,
            locked: false,
            contents_hidden: false,
            clips_content: false,
            extensions: Default::default(),
        };
        source
            .submit_create(NodeId(16), 0, node, Origin::LocalUser)
            .unwrap();
        let snapshot = source.snapshot_json();
        let mut restored = DocumentEngine::new();
        assert_eq!(restored.load_snapshot_json(&snapshot).unwrap(), 1);
        assert_eq!(
            restored.document.node(NodeId(1)).unwrap().name,
            "Saved card"
        );
        assert_eq!(restored.document.node(NodeId(1)).unwrap().opacity, 0.75);
        assert!(!restored.can_undo());
    }

    #[test]
    fn core_snapshot_preserves_parent_page_and_sibling_position_invariants() {
        let mut source = DocumentEngine::new();
        let node = |id, parent_id, name: &str, position| Node {
            id: NodeId(id),
            parent_id,
            position: PositionId::for_node(NodeId(position)),
            name: name.into(),
            kind: NodeKind::Frame,
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 80.0,
            rotation: 0.0,
            fill: "#e6edff".into(),
            stroke: "#00000000".into(),
            fills: Vec::new(),
            strokes: Vec::new(),
            stroke_width: 0.0,
            stroke_cap_start: Default::default(),
            stroke_cap_end: Default::default(),
            stroke_join: Default::default(),
            stroke_miter_limit: 10.0,
            stroke_dash_pattern: Vec::new(),
           stroke_weights: Vec::new(),
           stroke_align: Default::default(),
            arc_data: None,
            relative_transform: None,
            opacity: 1.0,
            corner_radius: 12.0,
            corner_radii: Vec::new(),
            corner_smoothing: 0.0,
            constraints: None,
            text: String::new(),
            visible: true,
            locked: false,
            contents_hidden: false,
            clips_content: false,
            extensions: Default::default(),
        };
        source
            .document
            .seed_node(node(1, None, "Root frame", 1))
            .unwrap();
        source
            .document
            .seed_node(node(2, None, "Root sibling", 2))
            .unwrap();
        source
            .document
            .seed_node(node(3, Some(NodeId(1)), "Nested frame", 3))
            .unwrap();
        let snapshot = source.snapshot_json();
        assert!(snapshot.contains(r#""parentId":"00000000-0000-0000-0000-000000000001""#));

        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(
            restored.document.node(NodeId(3)).unwrap().parent_id,
            Some(NodeId(1))
        );
        assert_eq!(restored.canonical_hash(), source.canonical_hash());

        let mut invalid_parent = node(4, Some(NodeId(255)), "Unknown parent", 4);
        assert!(Document::empty().seed_node(invalid_parent.clone()).is_err());

        invalid_parent.parent_id = None;
        invalid_parent.position = PositionId::for_node(NodeId(1));
        let mut duplicate_position = Document::empty();
        duplicate_position
            .seed_node(node(1, None, "First sibling", 1))
            .unwrap();
        assert!(duplicate_position.seed_node(invalid_parent).is_err());

        let second_page = Page {
            id: PageId(99),
            name: "Second page".into(),
            position: PositionId::for_node(NodeId(99)),
        };
        let mut cross_page_parent = Document::empty();
        cross_page_parent.seed_page(second_page).unwrap();
        cross_page_parent
            .seed_node(node(1, None, "Page one parent", 1))
            .unwrap();
        assert!(
            cross_page_parent
                .seed_node_on_page(PageId(99), node(5, Some(NodeId(1)), "Cross-page child", 5))
                .is_err()
        );
    }

    #[test]
    fn phase1_snapshot_fixtures_migrate_to_a_stable_current_projection() {
        let fixtures = [
            (
                "v13",
                include_str!("../../../fixtures/documents/phase1-snapshot-v13.fixture.json"),
                "f003936ef1fef23ac2722be779191c9f7f02fb1507eaf2b2bff1ed43195cf3b2",
            ),
            (
                "v14",
                include_str!("../../../fixtures/documents/phase1-snapshot-v14.fixture.json"),
                "0899e19b4cc9e839c298d40b9a1c5bc404f000d4a45daf060012bf8e9d6a3b9d",
            ),
            (
                "v15",
                include_str!("../../../fixtures/documents/phase1-snapshot-v15.fixture.json"),
                "68ceba49708c64f32db79c561f85e0b778709154ebe22cf8f02feda51ff3a013",
            ),
        ];
        for (version, fixture, expected_hash) in fixtures {
            let mut migrated = DocumentEngine::new();
            migrated.load_snapshot_json(fixture).unwrap();
            assert_eq!(migrated.document.pages().count(), 2, "{version}");
            assert_eq!(migrated.document.nodes().count(), 5, "{version}");
            assert_eq!(
                migrated
                    .document
                    .node(parse_id("00000000-0000-4000-8000-000000000103").unwrap())
                    .unwrap()
                    .parent_id,
                Some(parse_id("00000000-0000-4000-8000-000000000101").unwrap()),
                "{version}"
            );
            assert_eq!(
                migrated
                    .document
                    .asset(AssetId(
                        parse_id("00000000-0000-4000-8000-000000000201").unwrap().0,
                    ))
                    .unwrap()
                    .dimensions,
                Some([16, 16]),
                "{version}"
            );
            let projection = migrated.snapshot_json();
            assert!(projection.contains(r#""schemaVersion":19"#), "{version}");

            let mut round_trip = DocumentEngine::new();
            round_trip.load_snapshot_json(&projection).unwrap();
            assert_eq!(
                round_trip.canonical_hash(),
                migrated.canonical_hash(),
                "{version}"
            );
            assert_eq!(migrated.canonical_hash(), expected_hash, "{version}");
        }
    }

    #[test]
    fn phase2_snapshot_fixtures_migrate_and_preserve_new_version_fields() {
        // Phase 2 introduced v16 (StrokeCap), v17 (corner_radii), v18 (corner
        // smoothing) and v19 (paint stacks). Each fixture freezes the version that
        // first carried its new field; all migrate to the current projection, keep
        // that field, round-trip Hash-stable, and re-migrate idempotently (P0-4).
        let fixtures = [
            (
                "v16",
                include_str!("../../../fixtures/documents/phase2-snapshot-v16.fixture.json"),
                "4e87b90c55bb672013acd0e1a0baf62d4f35e80b6967ee75feee168fc1c81e05",
            ),
            (
                "v17",
                include_str!("../../../fixtures/documents/phase2-snapshot-v17.fixture.json"),
                "e4100f2040c3448b463f4a21f48fc0766046dafe929256dc9f9971ba3279a893",
            ),
            (
                "v18",
                include_str!("../../../fixtures/documents/phase2-snapshot-v18.fixture.json"),
                "634b5aafcefab752d41cca06a2464ba6624070346a012786e2e34f94868a93dc",
            ),
            (
                "v19",
                include_str!("../../../fixtures/documents/phase2-snapshot-v19.fixture.json"),
                "9f3f4e0e3eb78fdb388f9991d1eb84e2b8352f66eeb31a48f7a0b8eee5ab3da8",
            ),
        ];
        let line_id = parse_id("00000000-0000-4000-8000-000000000102").unwrap();
        let panel_id = parse_id("00000000-0000-4000-8000-000000000103").unwrap();
        for (version, fixture, expected_hash) in fixtures {
            let mut migrated = DocumentEngine::new();
            migrated.load_snapshot_json(fixture).unwrap();
            assert_eq!(migrated.document.pages().count(), 2, "{version}");
            assert_eq!(migrated.document.nodes().count(), 5, "{version}");

            // v16: the arrow cap survived migration to the current projection.
            let line = migrated.document.node(line_id).unwrap();
            assert_eq!(line.stroke_cap_end, StrokeCap::ArrowLines, "{version}");

            let panel = migrated.document.node(panel_id).unwrap();
            if version >= "v17" {
                // v17: independent per-corner radii are preserved.
                assert_eq!(panel.corner_radii, vec![4.0, 8.0, 16.0, 24.0], "{version}");
            }
            if version >= "v18" {
                // v18: continuous corner smoothing is preserved.
                assert_eq!(panel.corner_smoothing, 0.6, "{version}");
            }
            if version >= "v19" {
                // v19: the ordered fill/stroke stacks are preserved.
                assert_eq!(panel.fills.len(), 2, "{version}");
                assert_eq!(panel.strokes.len(), 2, "{version}");
            }

            let projection = migrated.snapshot_json();
            assert!(projection.contains(r#""schemaVersion":19"#), "{version}");

            // Re-migrating the current projection is idempotent and Hash-stable.
            let mut round_trip = DocumentEngine::new();
            round_trip.load_snapshot_json(&projection).unwrap();
            assert_eq!(round_trip.canonical_hash(), migrated.canonical_hash(), "{version}");
            assert_eq!(migrated.canonical_hash(), expected_hash, "{version}");
        }
    }

    #[test]
    fn transparent_legacy_paint_migrates_to_transparent_paint_not_empty() {
        // Phase 2 froze the rule that a transparent CSS paint ("#00000000" or
        // "transparent") migrates to a transparent Solid Paint, never to an empty
        // paint stack. parse_css_color implements it; this pins the behavior (P0-4).
        let transparent = parse_css_color("#00000000").unwrap();
        assert_eq!(transparent.alpha, 0.0);
        assert_eq!(parse_css_color("transparent").unwrap().alpha, 0.0);

        // A node whose stroke is transparent keeps a Solid transparent stroke.
        let mut engine = DocumentEngine::new();
        engine
            .load_snapshot_json(include_str!(
                "../../../fixtures/documents/phase2-snapshot-v16.fixture.json"
            ))
            .unwrap();
        let root = engine
            .document
            .node(parse_id("00000000-0000-4000-8000-000000000101").unwrap())
            .unwrap();
        match &root.stroke {
            Paint::Solid(color) => assert_eq!(color.alpha, 0.0),
            _ => panic!("transparent stroke must remain a Solid transparent paint, not a gradient/empty"),
        }
    }

    #[test]
    fn core_snapshot_retains_deleted_id_tombstones() {
        let mut source = DocumentEngine::new();
        let node = Node {
            id: NodeId(1),
            parent_id: None,
            position: PositionId::for_node(NodeId(1)),
            name: "Deleted card".into(),
            kind: NodeKind::Rectangle,
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 80.0,
            rotation: 0.0,
            fill: "#e6edff".into(),
            stroke: "#00000000".into(),
            fills: Vec::new(),
            strokes: Vec::new(),
            stroke_width: 0.0,
            stroke_cap_start: Default::default(),
            stroke_cap_end: Default::default(),
            stroke_join: Default::default(),
            stroke_miter_limit: 10.0,
            stroke_dash_pattern: Vec::new(),
           stroke_weights: Vec::new(),
           stroke_align: Default::default(),
            arc_data: None,
            relative_transform: None,
            opacity: 1.0,
            corner_radius: 12.0,
            corner_radii: Vec::new(),
            corner_smoothing: 0.0,
            constraints: None,
            text: String::new(),
            visible: true,
            locked: false,
            contents_hidden: false,
            clips_content: false,
            extensions: Default::default(),
        };
        source
            .submit_create(NodeId(16), 0, node, Origin::LocalUser)
            .unwrap();
        source
            .submit_delete(NodeId(17), 1, vec![NodeId(1)])
            .unwrap();

        let mut restored = DocumentEngine::new();
        restored
            .load_snapshot_json(&source.snapshot_json())
            .unwrap();
        assert!(restored.document.retired_ids().any(|id| *id == NodeId(1)));
        assert!(
            restored
                .submit_create(
                    NodeId(18),
                    2,
                    Node {
                        id: NodeId(1),
                        parent_id: None,
                        position: PositionId::for_node(NodeId(1)),
                        name: "Reused".into(),
                        kind: NodeKind::Rectangle,
                        x: 0.0,
                        y: 0.0,
                        width: 100.0,
                        height: 80.0,
                        rotation: 0.0,
                        fill: "#e6edff".into(),
                        stroke: "#00000000".into(),
                        fills: Vec::new(),
                        strokes: Vec::new(),
                        stroke_width: 0.0,
            stroke_cap_start: Default::default(),
            stroke_cap_end: Default::default(),
            stroke_join: Default::default(),
            stroke_miter_limit: 10.0,
            stroke_dash_pattern: Vec::new(),
           stroke_weights: Vec::new(),
           stroke_align: Default::default(),
            arc_data: None,
            relative_transform: None,
            opacity: 1.0,
                        corner_radius: 12.0,
                        corner_radii: Vec::new(),
                        corner_smoothing: 0.0,
            constraints: None,
                        text: String::new(),
                        visible: true,
                        locked: false,
            contents_hidden: false,
            clips_content: false,
            extensions: Default::default(),
                    },
                    Origin::LocalUser,
                )
                .is_err()
        );
    }

    #[test]
    fn schema_v1_snapshot_remains_readable_after_tombstone_migration() {
        let mut source = DocumentEngine::new();
        source
            .submit_create(
                NodeId(16),
                0,
                Node {
                    id: NodeId(1),
                    parent_id: None,
                    position: PositionId::for_node(NodeId(1)),
                    name: "Legacy card".into(),
                    kind: NodeKind::Rectangle,
                    x: 0.0,
                    y: 0.0,
                    width: 100.0,
                    height: 80.0,
                    rotation: 0.0,
                    fill: "#e6edff".into(),
                    stroke: "#00000000".into(),
                    fills: Vec::new(),
                    strokes: Vec::new(),
                    stroke_width: 0.0,
            stroke_cap_start: Default::default(),
            stroke_cap_end: Default::default(),
            stroke_join: Default::default(),
            stroke_miter_limit: 10.0,
            stroke_dash_pattern: Vec::new(),
           stroke_weights: Vec::new(),
           stroke_align: Default::default(),
            arc_data: None,
            relative_transform: None,
            opacity: 1.0,
                    corner_radius: 12.0,
                    corner_radii: Vec::new(),
                    corner_smoothing: 0.0,
            constraints: None,
                    text: String::new(),
                    visible: true,
                    locked: false,
            contents_hidden: false,
            clips_content: false,
            extensions: Default::default(),
                },
                Origin::LocalUser,
            )
            .unwrap();
        let mut legacy: serde_json::Value = serde_json::from_str(&source.snapshot_json()).unwrap();
        let object = legacy.as_object_mut().unwrap();
        object.insert("schemaVersion".into(), serde_json::json!(1));
        object.remove("canonicalHash");
        object.remove("retiredIds");

        let mut restored = DocumentEngine::new();
        assert_eq!(restored.load_snapshot_json(&legacy.to_string()).unwrap(), 1);
        assert_eq!(
            restored.document.node(NodeId(1)).unwrap().name,
            "Legacy card"
        );
    }

    #[test]
    fn concrete_batch_crosses_the_bridge_as_one_history_revision() {
        let mut engine = DocumentEngine::new();
        let node = |id: &str, name: &str| ProjectionNode {
            id: id.into(),
            parent_id: None,
            name: name.into(),
            kind: "rectangle".into(),
            asset_id: None,
            text_properties: None,
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 80.0,
            rotation: 0.0,
            fill: "#e6edff".into(),
            fill_color: None,
            fill_gradient: None,
            stroke: "transparent".into(),
            fills: Vec::new(),
            strokes: Vec::new(),
            stroke_color: None,
            stroke_gradient: None,
            stroke_width: 0.0,
            stroke_cap_start: Default::default(),
            stroke_cap_end: Default::default(),
            stroke_join: Default::default(),
            stroke_miter_limit: 10.0,
            stroke_dash_pattern: Vec::new(),
           stroke_weights: Vec::new(),
           stroke_align: "inside".into(),
            arc_data: None,
            relative_transform: None,
            position_id: None,
            page_id: None,
            opacity: 1.0,
            corner_radius: 12.0,
            corner_radii: Vec::new(),
            corner_smoothing: 0.0,
            constraints: None,
            text: String::new(),
            visible: true,
            locked: false,
            contents_hidden: false,
            clips_content: Some(false),
            extensions: Default::default(),
        };

        let revision = engine
            .submit_batch(
                NodeId(16),
                0,
                vec![
                    BatchCommand::Create {
                        node: node("00000000-0000-4000-8000-000000000001", "First"),
                    },
                    BatchCommand::Create {
                        node: node("00000000-0000-4000-8000-000000000002", "Second"),
                    },
                ],
            )
            .unwrap();

        assert_eq!(revision, 1);
        assert_eq!(engine.document.revision, 1);
        assert_eq!(engine.document.nodes().count(), 2);
        let first_id = parse_id("00000000-0000-4000-8000-000000000001").unwrap();
        assert!(engine.document.node(first_id).is_some());
        assert!(engine.document.can_undo());

        let group_id = "00000000-0000-0000-0000-000000000003";
        let group_core_id = parse_id(group_id).unwrap();
        let mut group = node(group_id, "Group");
        group.kind = "group".into();
        group.x = 10.0;
        group.y = 20.0;
        let mut first_as_group_child = node("00000000-0000-4000-8000-000000000001", "First");
        first_as_group_child.x = 0.0;
        first_as_group_child.y = 0.0;
        first_as_group_child.relative_transform = Some(ProjectionTransform {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            e: 0.0,
            f: 0.0,
        });
        engine
            .submit_batch(
                NodeId(17),
                1,
                vec![
                    BatchCommand::Create { node: group },
                    BatchCommand::Reparent {
                        parent_ids: vec![ParentUpdate {
                            id: "00000000-0000-4000-8000-000000000001".into(),
                            parent_id: Some(group_id.into()),
                            position_id: "00000000000000000000000000000001:00000000000000000000000000000000".into(),
                        }],
                    },
                    BatchCommand::Update { node: first_as_group_child },
                ],
            )
            .unwrap();
        assert_eq!(engine.document.node(first_id).unwrap().parent_id, Some(group_core_id));
        assert_eq!(engine.document.node(first_id).unwrap().relative_transform, Some(editor_core::geometry::AffineTransform { a: 1.0, b: 0.0, c: 0.0, d: 1.0, e: 0.0, f: 0.0 }));
        engine.document.undo().unwrap();
        assert_eq!(engine.document.node(first_id).unwrap().parent_id, None);
        assert_eq!(engine.document.node(first_id).unwrap().relative_transform, None);
        engine.document.redo().unwrap();
        assert_eq!(engine.document.node(first_id).unwrap().parent_id, Some(group_core_id));

        // A Group is itself a valid Group child. Re-wrapping it must carry the
        // same parent-relative transform protocol as a shape child.
        let outer_group_id = "00000000-0000-0000-0000-000000000004";
        let outer_group_core_id = parse_id(outer_group_id).unwrap();
        let mut outer_group = node(outer_group_id, "Outer Group");
        outer_group.kind = "group".into();
        outer_group.x = 10.0;
        outer_group.y = 20.0;
        let mut nested_group = node(group_id, "Group");
        nested_group.kind = "group".into();
        nested_group.x = 0.0;
        nested_group.y = 0.0;
        nested_group.relative_transform = Some(ProjectionTransform {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            e: 0.0,
            f: 0.0,
        });
        engine
            .submit_batch(
                NodeId(18),
                engine.document.revision,
                vec![
                    BatchCommand::Create { node: outer_group },
                    BatchCommand::Reparent {
                        parent_ids: vec![ParentUpdate {
                            id: group_id.into(),
                            parent_id: Some(outer_group_id.into()),
                            position_id: "00000000000000000000000000000003:00000000000000000000000000000000".into(),
                        }],
                    },
                    BatchCommand::Update { node: nested_group },
                ],
            )
            .unwrap();
        assert_eq!(engine.document.node(group_core_id).unwrap().parent_id, Some(outer_group_core_id));
    }

    #[test]
    fn image_filled_frame_can_update_stroke_alignment_after_asset_binding() {
        let mut engine = DocumentEngine::new();
        let frame_id = "00000000-0000-4000-8000-000000000011";
        let asset_id = "00000000-0000-4000-8000-000000000022";
        engine
            .document
            .seed_asset(AssetReference {
                asset_id: AssetId(parse_id(asset_id).unwrap().0),
                content_hash: [7; 32],
                media_type: "image/png".into(),
                byte_length: 128,
                dimensions: Some([16, 8]),
            })
            .unwrap();
        let frame = ProjectionNode {
            id: frame_id.into(),
            parent_id: None,
            name: "Image frame".into(),
            kind: "frame".into(),
            asset_id: None,
            text_properties: None,
            x: 0.0,
            y: 0.0,
            width: 320.0,
            height: 180.0,
            rotation: 0.0,
            fill: "#ffffff".into(),
            fill_color: None,
            fill_gradient: None,
            fills: Vec::new(),
            stroke: "#000000".into(),
            stroke_color: None,
            stroke_gradient: None,
            strokes: Vec::new(),
            stroke_width: 4.0,
            stroke_cap_start: Default::default(),
            stroke_cap_end: Default::default(),
            stroke_join: Default::default(),
            stroke_miter_limit: 10.0,
            stroke_dash_pattern: Vec::new(),
            stroke_weights: Vec::new(),
            stroke_align: "inside".into(),
            arc_data: None,
            relative_transform: None,
            position_id: None,
            page_id: None,
            opacity: 1.0,
            corner_radius: 24.0,
            corner_radii: vec![24.0, 32.0, 24.0, 18.0],
            corner_smoothing: 0.25,
            constraints: None,
            text: String::new(),
            visible: true,
            locked: false,
            contents_hidden: false,
            clips_content: Some(true),
            extensions: Default::default(),
        };
        engine
            .submit_batch(
                NodeId(101),
                0,
                vec![BatchCommand::Create { node: frame.clone() }],
            )
            .unwrap();
        let mut image_filled = frame.clone();
        image_filled.asset_id = Some(asset_id.into());
        engine
            .submit_batch(
                NodeId(102),
                1,
                vec![BatchCommand::Update { node: image_filled.clone() }],
            )
            .unwrap();
        let mut circular = image_filled;
        circular.corner_smoothing = 0.0;
        engine
            .submit_batch(
                NodeId(103),
                2,
                vec![BatchCommand::Update { node: circular.clone() }],
            )
            .unwrap();
        let mut outside = circular;
        outside.stroke_align = "outside".into();
        assert_eq!(
            engine
                .submit_batch(NodeId(104), 3, vec![BatchCommand::Update { node: outside }])
                .unwrap(),
            4
        );
        assert_eq!(
            engine.document.node(parse_id(frame_id).unwrap()).unwrap().stroke_align,
            StrokeAlign::Outside
        );
    }

    #[test]
    fn reposition_batch_changes_canonical_paint_order_and_is_undoable() {
        let mut engine = DocumentEngine::new();
        let node = |id: &str, name: &str| ProjectionNode {
            id: id.into(),
            parent_id: None,
            name: name.into(),
            kind: "rectangle".into(),
            asset_id: None,
            text_properties: None,
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 80.0,
            rotation: 0.0,
            fill: "#e6edff".into(),
            fill_color: None,
            fill_gradient: None,
            stroke: "transparent".into(),
            fills: Vec::new(),
            strokes: Vec::new(),
            stroke_color: None,
            stroke_gradient: None,
            stroke_width: 0.0,
            stroke_cap_start: Default::default(),
            stroke_cap_end: Default::default(),
            stroke_join: Default::default(),
            stroke_miter_limit: 10.0,
            stroke_dash_pattern: Vec::new(),
           stroke_weights: Vec::new(),
           stroke_align: "inside".into(),
            arc_data: None,
            relative_transform: None,
            position_id: None,
            page_id: None,
            opacity: 1.0,
            corner_radius: 12.0,
            corner_radii: Vec::new(),
            corner_smoothing: 0.0,
            constraints: None,
            text: String::new(),
            visible: true,
            locked: false,
            contents_hidden: false,
            clips_content: Some(false),
            extensions: Default::default(),
        };
        let first = "00000000-0000-4000-8000-000000000001";
        let second = "00000000-0000-4000-8000-000000000002";
        engine
            .submit_batch(
                NodeId(16),
                0,
                vec![
                    BatchCommand::Create {
                        node: node(first, "First"),
                    },
                    BatchCommand::Create {
                        node: node(second, "Second"),
                    },
                ],
            )
            .unwrap();

        engine
            .submit_batch(
                NodeId(17),
                1,
                vec![BatchCommand::Reposition {
                    position_ids: vec![PositionUpdate {
                        id: first.into(),
                        position_id:
                            "ffffffffffffffffffffffffffffffff:00000000000000000000000000000007"
                                .into(),
                    }],
                }],
            )
            .unwrap();
        assert_eq!(
            engine
                .document
                .ordered_nodes()
                .into_iter()
                .map(|node| node.name.as_str())
                .collect::<Vec<_>>(),
            ["Second", "First"]
        );
        engine.document.undo().unwrap();
        assert_eq!(
            engine
                .document
                .ordered_nodes()
                .into_iter()
                .map(|node| node.name.as_str())
                .collect::<Vec<_>>(),
            ["First", "Second"]
        );
    }

    #[test]
    fn text_batch_round_trips_canonically_and_v2_snapshots_remain_readable() {
        let mut engine = DocumentEngine::new();
        let id = parse_id("00000000-0000-4000-8000-000000000001").unwrap();
        let text = |value: &str| ProjectionNode {
            id: "00000000-0000-4000-8000-000000000001".into(),
            parent_id: None,
            name: "Heading".into(),
            kind: "text".into(),
            asset_id: None,
            text_properties: Some(ProjectionTextProperties {
                runs: vec![ProjectionTextStyleRun {
                    start: 0,
                    end: value.len() as u32,
                    font: None,
                    font_size: 24.0,
                    font_weight: 700,
                    italic: false,
                    letter_spacing: 0.5,
                }],
                paragraph: ProjectionParagraphStyle {
                    alignment: "center".into(),
                    line_height: Some(30.0),
                    paragraph_spacing: 4.0,
                },
                auto_size: "height".into(),
                fallback_fonts: vec![],
            }),
            x: 0.0,
            y: 0.0,
            width: 240.0,
            height: 48.0,
            rotation: 0.0,
            fill: "#111111".into(),
            fill_color: None,
            fill_gradient: None,
            stroke: "#00000000".into(),
            fills: Vec::new(),
            strokes: Vec::new(),
            stroke_color: None,
            stroke_gradient: None,
            stroke_width: 0.0,
            stroke_cap_start: Default::default(),
            stroke_cap_end: Default::default(),
            stroke_join: Default::default(),
            stroke_miter_limit: 10.0,
            stroke_dash_pattern: Vec::new(),
           stroke_weights: Vec::new(),
           stroke_align: "inside".into(),
            arc_data: None,
            relative_transform: None,
            position_id: None,
            page_id: None,
            opacity: 1.0,
            corner_radius: 0.0,
            corner_radii: Vec::new(),
            corner_smoothing: 0.0,
            constraints: None,
            text: value.into(),
            visible: true,
            locked: false,
            contents_hidden: false,
            clips_content: Some(false),
            extensions: Default::default(),
        };
        engine
            .submit_batch(
                NodeId(16),
                0,
                vec![BatchCommand::Create {
                    node: text("Before"),
                }],
            )
            .unwrap();
        engine
            .submit_batch(
                NodeId(17),
                1,
                vec![BatchCommand::Update {
                    node: text("After"),
                }],
            )
            .unwrap();
        assert_eq!(engine.document.node(id).unwrap().text, "After");
        assert_eq!(
            engine
                .document
                .text_properties_for_node(id)
                .unwrap()
                .paragraph
                .alignment,
            TextAlign::Center
        );
        assert_eq!(engine.undo().unwrap(), 3);
        assert_eq!(engine.document.node(id).unwrap().text, "Before");
        assert_eq!(engine.redo().unwrap(), 4);

        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":19"));
        assert!(snapshot.contains("\"textProperties\":{\"runs\":[{\"start\":0,\"end\":5"));
        assert!(snapshot.contains("\"stroke\":\"#00000000\""));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.document.node(id).unwrap().text, "After");
        assert_eq!(
            restored
                .document
                .text_properties_for_node(id)
                .unwrap()
                .auto_size,
            TextAutoSize::Height
        );

        let mut v2: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        v2.as_object_mut()
            .unwrap()
            .insert("schemaVersion".into(), serde_json::json!(2));
        v2["nodes"][0].as_object_mut().unwrap().remove("text");
        v2["nodes"][0]
            .as_object_mut()
            .unwrap()
            .remove("textProperties");
        let mut legacy = DocumentEngine::new();
        legacy.load_snapshot_json(&v2.to_string()).unwrap();
        assert_eq!(legacy.document.node(id).unwrap().text, "");
    }

    #[test]
    fn snapshot_v4_preserves_display_p3_and_v3_migrates_css_fill() {
        let mut engine = DocumentEngine::new();
        let id = "00000000-0000-4000-8000-000000000001";
        let node = ProjectionNode {
            id: id.into(),
            parent_id: None,
            name: "P3 card".into(),
            kind: "rectangle".into(),
            asset_id: None,
            text_properties: None,
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 80.0,
            rotation: 0.0,
            fill: "#43d477".into(),
            fill_color: Some(ProjectionColor {
                space: "display-p3".into(),
                components: [0.2, 0.8, 0.4],
                alpha: 1.0,
            }),
            fill_gradient: None,
            stroke: "#00000000".into(),
            fills: Vec::new(),
            strokes: Vec::new(),
            stroke_color: None,
            stroke_gradient: None,
            stroke_width: 0.0,
            stroke_cap_start: Default::default(),
            stroke_cap_end: Default::default(),
            stroke_join: Default::default(),
            stroke_miter_limit: 10.0,
            stroke_dash_pattern: Vec::new(),
            stroke_weights: Vec::new(),
            stroke_align: "inside".into(),
            arc_data: None,
            relative_transform: None,
            position_id: Some(
                "00000000000000000000000000000010:00000000000000000000000000000007".into(),
            ),
            page_id: None,
            opacity: 1.0,
            corner_radius: 8.0,
            corner_radii: Vec::new(),
            corner_smoothing: 0.0,
            constraints: None,
            text: String::new(),
            visible: true,
            locked: false,
            contents_hidden: false,
            clips_content: Some(false),
            extensions: Default::default(),
        };
        engine
            .submit_batch(NodeId(16), 0, vec![BatchCommand::Create { node }])
            .unwrap();
        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"fillColor\":{\"space\":\"display-p3\""));
        assert!(snapshot.contains(
            "\"positionId\":\"00000000000000000000000000000010:00000000000000000000000000000007\""
        ));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(
            restored.document.node(parse_id(id).unwrap()).unwrap().fill,
            Paint::Solid(Color::new(ColorSpace::DisplayP3, [0.2, 0.8, 0.4], 1.0).unwrap())
        );
        assert_eq!(
            restored
                .document
                .node(parse_id(id).unwrap())
                .unwrap()
                .position,
            PositionId {
                key: 16,
                actor: ActorId(7)
            }
        );

        let mut v4: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        v4.as_object_mut()
            .unwrap()
            .insert("schemaVersion".into(), serde_json::json!(4));
        v4["nodes"][0].as_object_mut().unwrap().remove("positionId");
        let mut position_migrated = DocumentEngine::new();
        position_migrated
            .load_snapshot_json(&v4.to_string())
            .unwrap();
        assert_eq!(
            position_migrated
                .document
                .node(parse_id(id).unwrap())
                .unwrap()
                .position,
            PositionId::for_node(parse_id(id).unwrap())
        );

        let mut v3: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        v3.as_object_mut()
            .unwrap()
            .insert("schemaVersion".into(), serde_json::json!(3));
        v3["nodes"][0].as_object_mut().unwrap().remove("fillColor");
        v3["nodes"][0].as_object_mut().unwrap().remove("positionId");
        let mut migrated = DocumentEngine::new();
        migrated.load_snapshot_json(&v3.to_string()).unwrap();
        assert!(matches!(
            migrated.document.node(parse_id(id).unwrap()).unwrap().fill,
            Paint::Solid(Color {
                space: ColorSpace::Srgb,
                ..
            })
        ));
    }

    #[test]
    fn snapshot_v6_round_trips_document_color_profile_and_v5_defaults_to_srgb() {
        let mut engine = DocumentEngine::new();
        engine
            .set_document_color_profile("00000000-0000-4000-8000-000000000099", 0, "display-p3")
            .unwrap();
        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":19"));
        assert!(snapshot.contains("\"colorProfile\":\"display-p3\""));

        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(
            restored.document.color_profile(),
            DocumentColorProfile::DisplayP3
        );

        let mut v5: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        v5.as_object_mut()
            .unwrap()
            .insert("schemaVersion".into(), serde_json::json!(5));
        v5.as_object_mut().unwrap().remove("colorProfile");
        let mut migrated = DocumentEngine::new();
        migrated.load_snapshot_json(&v5.to_string()).unwrap();
        assert_eq!(
            migrated.document.color_profile(),
            DocumentColorProfile::Srgb
        );
    }

    #[test]
    fn snapshot_v9_round_trips_gradient_stroke_and_v7_uses_legacy_rotation_fallback() {
        let mut engine = DocumentEngine::new();
        let id = "00000000-0000-4000-8000-000000000001";
        let gradient = ProjectionLinearGradient {
            start: [0.0, 0.0],
            end: [1.0, 1.0],
            stops: vec![
                ProjectionGradientStop {
                    position: 0.0,
                    color: ProjectionColor {
                        space: "srgb".into(),
                        components: [0.1, 0.2, 0.3],
                        alpha: 1.0,
                    },
                },
                ProjectionGradientStop {
                    position: 1.0,
                    color: ProjectionColor {
                        space: "display-p3".into(),
                        components: [0.4, 0.8, 0.6],
                        alpha: 0.8,
                    },
                },
            ],
        };
        engine
            .submit_batch(
                NodeId(44),
                0,
                vec![BatchCommand::Create {
                    node: ProjectionNode {
                        id: id.into(),
                        parent_id: None,
                        name: "Gradient card".into(),
                        kind: "rectangle".into(),
                        asset_id: None,
                        text_properties: None,
                        x: 0.0,
                        y: 0.0,
                        width: 100.0,
                        height: 80.0,
                        rotation: 30.0,
                        fill: "#1a334d".into(),
                        fill_color: None,
                        fill_gradient: Some(gradient.clone()),
                        stroke: "#1a334d".into(),
                        fills: Vec::new(),
                        strokes: Vec::new(),
                        stroke_color: None,
                        stroke_gradient: Some(gradient.clone()),
                        stroke_width: 3.0,
            stroke_cap_start: Default::default(),
            stroke_cap_end: Default::default(),
            stroke_join: Default::default(),
            stroke_miter_limit: 10.0,
            stroke_dash_pattern: Vec::new(),
           stroke_weights: Vec::new(),
           stroke_align: "inside".into(),
            arc_data: None,
            relative_transform: None,
            position_id: None,
                        page_id: None,
                        opacity: 1.0,
                        corner_radius: 8.0,
                        corner_radii: Vec::new(),
                        corner_smoothing: 0.0,
            constraints: None,
                        text: String::new(),
                        visible: true,
                        locked: false,
            contents_hidden: false,
            clips_content: Some(false),
            extensions: Default::default(),
                    },
                }],
            )
            .unwrap();
        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":19"));
        assert!(snapshot.contains("\"fillGradient\""));
        assert!(snapshot.contains("\"strokeGradient\""));
        assert!(snapshot.contains("\"strokeWidth\":3.0"));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert!(
            matches!(restored.document.node(parse_id(id).unwrap()).unwrap().fill, Paint::LinearGradient(ref value) if value.start == gradient.start && value.end == gradient.end && value.stops.len() == 2)
        );
        assert_eq!(
            restored
                .document
                .node(parse_id(id).unwrap())
                .unwrap()
                .rotation,
            30.0
        );
        assert!(
            matches!(restored.document.node(parse_id(id).unwrap()).unwrap().stroke, Paint::LinearGradient(ref value) if value.start == gradient.start && value.end == gradient.end && value.stops.len() == 2)
        );
        assert_eq!(
            restored
                .document
                .node(parse_id(id).unwrap())
                .unwrap()
                .stroke_width,
            3.0
        );

        let mut v6: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        v6.as_object_mut()
            .unwrap()
            .insert("schemaVersion".into(), serde_json::json!(7));
        v6.as_object_mut().unwrap().remove("canonicalHash");
        v6["nodes"][0]
            .as_object_mut()
            .unwrap()
            .remove("fillGradient");
        v6["nodes"][0].as_object_mut().unwrap().remove("rotation");
        let mut legacy = DocumentEngine::new();
        legacy.load_snapshot_json(&v6.to_string()).unwrap();
        assert!(matches!(
            legacy.document.node(parse_id(id).unwrap()).unwrap().fill,
            Paint::Solid(_)
        ));
        assert_eq!(
            legacy
                .document
                .node(parse_id(id).unwrap())
                .unwrap()
                .rotation,
            0.0
        );
    }

    #[test]
    fn schema_v10_persists_page_ownership_and_v9_migrates_to_page_one() {
        let mut source = DocumentEngine::new();
        source
            .create_node(
                "00000000-0000-4000-8000-0000000000aa",
                0,
                "00000000-0000-4000-8000-0000000000bb",
                "rectangle",
                "Card",
                0.0,
                0.0,
                100.0,
                80.0,
                0.0,
                "#ffffff",
                "#00000000",
                0.0,
                1.0,
                0.0,
                true,
                false,
                "",
            )
            .unwrap();
        let mut current: serde_json::Value = serde_json::from_str(&source.snapshot_json()).unwrap();
        let design_page = "00000000-0000-4000-8000-000000000002";
        current["pages"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "id": design_page,
                "name": "Design",
                "positionId": "00000000000000000000000000000002:00000000000000000000000000000000"
            }));
        current["nodes"][0]["pageId"] = serde_json::json!(design_page);
        current.as_object_mut().unwrap().remove("canonicalHash");

        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&current.to_string()).unwrap();
        let node_id = parse_id("00000000-0000-4000-8000-0000000000bb").unwrap();
        assert_eq!(
            restored.document.page_for_node(node_id),
            Some(parse_page_id(design_page).unwrap())
        );
        let round_trip = restored.snapshot_json();
        assert!(round_trip.contains("\"schemaVersion\":19"));
        assert!(round_trip.contains("\"pageId\":\"00000000-0000-4000-8000-000000000002\""));

        let mut v9 = current;
        v9["schemaVersion"] = serde_json::json!(9);
        v9["nodes"][0].as_object_mut().unwrap().remove("pageId");
        v9.as_object_mut().unwrap().remove("pages");
        let mut migrated = DocumentEngine::new();
        migrated.load_snapshot_json(&v9.to_string()).unwrap();
        assert_eq!(
            migrated.document.page_for_node(node_id),
            Some(DEFAULT_PAGE_ID)
        );
    }

    #[test]
    fn create_page_is_a_versioned_undoable_bridge_operation() {
        let mut engine = DocumentEngine::new();
        engine
            .create_page(
                "00000000-0000-4000-8000-0000000000aa",
                0,
                "00000000-0000-4000-8000-0000000000bb",
                "Exploration",
            )
            .unwrap();
        assert_eq!(engine.document.pages().count(), 2);
        assert!(engine.snapshot_json().contains("\"name\":\"Exploration\""));
        engine.undo().unwrap();
        assert_eq!(engine.document.pages().count(), 1);
        engine.redo().unwrap();
        assert_eq!(engine.document.pages().count(), 2);
    }

    #[test]
    fn one_thousand_property_updates_commit_as_one_batch() {
        let mut engine = DocumentEngine::new();
        let mut updates = Vec::with_capacity(1_000);
        for index in 1..=1_000_u128 {
            let id = NodeId(index);
            engine
                .document
                .seed_node(Node {
                    id,
                    parent_id: None,
                    position: PositionId::for_node(id),
                    name: format!("Layer {index}"),
                    kind: NodeKind::Rectangle,
                    x: 0.0,
                    y: 0.0,
                    width: 100.0,
                    height: 80.0,
                    rotation: 0.0,
                    fill: "#e6edff".into(),
                    stroke: "#00000000".into(),
                    fills: Vec::new(),
                    strokes: Vec::new(),
                    stroke_width: 0.0,
            stroke_cap_start: Default::default(),
            stroke_cap_end: Default::default(),
            stroke_join: Default::default(),
            stroke_miter_limit: 10.0,
            stroke_dash_pattern: Vec::new(),
           stroke_weights: Vec::new(),
           stroke_align: Default::default(),
            arc_data: None,
            relative_transform: None,
            opacity: 1.0,
                    corner_radius: 12.0,
                    corner_radii: Vec::new(),
                    corner_smoothing: 0.0,
            constraints: None,
                    text: String::new(),
                    visible: true,
                    locked: false,
            contents_hidden: false,
            clips_content: false,
            extensions: Default::default(),
                })
                .unwrap();
            updates.push(BatchCommand::Update {
                node: ProjectionNode {
                    id: format_uuid(id),
                    parent_id: None,
                    name: format!("Layer {index}"),
                    kind: "rectangle".into(),
                    asset_id: None,
                    text_properties: None,
                    x: index as f64,
                    y: -(index as f64),
                    width: 100.0,
                    height: 80.0,
                    rotation: 0.0,
                    fill: "#e6edff".into(),
                    fill_color: None,
                    fill_gradient: None,
                    stroke: "#00000000".into(),
                    fills: Vec::new(),
                    strokes: Vec::new(),
                    stroke_color: None,
                    stroke_gradient: None,
                    stroke_width: 0.0,
            stroke_cap_start: Default::default(),
            stroke_cap_end: Default::default(),
            stroke_join: Default::default(),
            stroke_miter_limit: 10.0,
            stroke_dash_pattern: Vec::new(),
           stroke_weights: Vec::new(),
           stroke_align: "inside".into(),
            arc_data: None,
            relative_transform: None,
            position_id: None,
                    page_id: None,
                    opacity: 1.0,
                    corner_radius: 12.0,
                    corner_radii: Vec::new(),
                    corner_smoothing: 0.0,
            constraints: None,
                    text: String::new(),
                    visible: true,
                    locked: false,
            contents_hidden: false,
            clips_content: Some(false),
            extensions: Default::default(),
                },
            });
        }

        assert_eq!(engine.submit_batch(NodeId(1_001), 0, updates).unwrap(), 1);
        assert_eq!(engine.document.revision, 1);
        assert_eq!(engine.document.node(NodeId(1_000)).unwrap().x, 1_000.0);
        assert_eq!(engine.document.node(NodeId(1_000)).unwrap().y, -1_000.0);
    }
}
