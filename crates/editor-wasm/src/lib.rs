//! Browser bridge for the canonical Rust document core.
//!
//! Rendering deliberately stays outside this crate. The Engine Worker owns the
//! canvas/GPU resources while this adapter owns only durable document semantics.

use editor_core::{
    color::{Color, ColorSpace, DocumentColorProfile, GradientStop, LinearGradient, Paint}, ActorId, Appearance, Command, Document, Node, NodeId, NodeKind, OperationEnvelope, PositionId,
    OperationId, Origin, Transaction, TransactionId,
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
            let rotation = update.rotation.unwrap_or_else(|| self.document.node(update.id).map(|node| node.rotation).unwrap_or(f64::NAN));
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
                BatchCommand::Create { node } => commands.push(Command::Create(node_from_projection(node)?)),
                // The Worker resolves a partial Inspector patch to this complete node
                // payload before crossing the bridge. Keeping the bridge input fully
                // concrete makes replay deterministic and lets the Rust reducer own
                // the all-or-nothing validation of every derived core field.
                BatchCommand::Update { node } => {
                    let node = node_from_projection(node)?;
                    let appearance = Appearance {
                        fill: node.fill,
                        stroke: node.stroke,
                        stroke_width: node.stroke_width,
                        opacity: node.opacity,
                        corner_radius: node.corner_radius,
                        visible: node.visible,
                        locked: node.locked,
                    };
                    commands.extend([
                        Command::UpdateGeometry {
                            id: node.id,
                            x: node.x,
                            y: node.y,
                            width: node.width,
                            height: node.height,
                            rotation: node.rotation,
                        },
                        Command::Rename { id: node.id, name: node.name },
                        Command::SetAppearance { id: node.id, appearance },
                    ]);
                    if node.kind == NodeKind::Text {
                        commands.push(Command::SetText {
                            id: node.id,
                            text: node.text,
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
    revision: u64,
    can_undo: bool,
    can_redo: bool,
    #[serde(default)]
    canonical_hash: String,
    #[serde(default = "default_document_color_profile")]
    color_profile: String,
    nodes: Vec<ProjectionNode>,
    #[serde(default)]
    retired_ids: Option<Vec<String>>,
}

fn default_document_color_profile() -> String {
    "srgb".into()
}

fn default_transparent_css() -> String {
    "#00000000".into()
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionNode {
    id: String,
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
    /// v9 persists Canonical stroke paint and width. The CSS value is only the
    /// deterministic Canvas/Inspector projection fallback.
    #[serde(default = "default_transparent_css")]
    stroke: String,
    #[serde(default)]
    stroke_color: Option<ProjectionColor>,
    #[serde(default)]
    stroke_gradient: Option<ProjectionLinearGradient>,
    #[serde(default)]
    stroke_width: f64,
    #[serde(default)]
    position_id: Option<String>,
    opacity: f64,
    corner_radius: f64,
    #[serde(default)]
    text: String,
    visible: bool,
    locked: bool,
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
struct ProjectionGradientStop {
    position: f32,
    color: ProjectionColor,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum BatchCommand {
    Create { node: ProjectionNode },
    Update { node: ProjectionNode },
    Delete { ids: Vec<String> },
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
            schema_version: 9,
            revision: self.document.revision,
            can_undo: self.document.can_undo(),
            can_redo: self.document.can_redo(),
            canonical_hash: self.document.canonical_hash_hex(),
            color_profile: format_document_color_profile(self.document.color_profile()),
            nodes: self.document.ordered_nodes().into_iter().map(projection_node).collect(),
            retired_ids: Some(self.document.retired_ids().map(|id| format_uuid(*id)).collect()),
        };
        serde_json::to_string(&snapshot).expect("projection snapshot is serializable")
    }

    /// Restores a versioned Core snapshot. This deliberately restores no undo history:
    /// snapshots represent a confirmed durable state, while a future journal will carry
    /// operations that happened after it.
    #[wasm_bindgen]
    pub fn load_snapshot_json(&mut self, value: &str) -> Result<u64, JsValue> {
        let snapshot = serde_json::from_str::<CoreSnapshot>(value)
            .map_err(|_| JsValue::from_str("INVALID_CORE_SNAPSHOT"))?;
        if !(1..=9).contains(&snapshot.schema_version) {
            return Err(JsValue::from_str("UNSUPPORTED_CORE_SNAPSHOT"));
        }
        let mut document = Document::empty();
        document.seed_color_profile(parse_document_color_profile(&snapshot.color_profile)?);
        for node in snapshot.nodes {
            document
                .seed_node(node_from_projection(node)?)
                .map_err(core_error)?;
        }
        for id in snapshot.retired_ids.clone().unwrap_or_default() {
            document.seed_retired_id(parse_id(&id)?).map_err(core_error)?;
        }
        document.revision = snapshot.revision;
        // Schema v1 predates tombstones, v2 canonical text, v3 canonical color, v4
        // Canonical sibling positions, v6 DocumentColorProfile, v7 Paint, v8
        // rotation and v9 stroke. Only v9 hashes encode every current field.
        if snapshot.schema_version >= 9 && !snapshot.canonical_hash.is_empty() && snapshot.canonical_hash != document.canonical_hash_hex() {
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
                BatchCommand::Create { node } => self.document.seed_node(node_from_projection(node)?).map_err(core_error)?,
                BatchCommand::Update { .. } | BatchCommand::Delete { .. } => return Err(JsValue::from_str("INVALID_SEED_BATCH")),
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
            stroke_width,
            opacity,
            corner_radius,
            text: text.into(),
            visible,
            locked,
        };
        self.submit_create(
            parse_id(transaction_id)?,
            base_revision,
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
            stroke_width,
            opacity,
            corner_radius,
            text: text.into(),
            visible,
            locked,
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
                stroke_width,
                opacity,
                corner_radius,
                visible,
                locked,
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

#[wasm_bindgen]
pub fn engine_semantics_version() -> u32 {
    3
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

fn parse_kind(value: &str) -> Result<NodeKind, JsValue> {
    match value {
        "frame" => Ok(NodeKind::Frame),
        "rectangle" => Ok(NodeKind::Rectangle),
        "ellipse" => Ok(NodeKind::Ellipse),
        "text" => Ok(NodeKind::Text),
        _ => Err(JsValue::from_str("UNSUPPORTED_NODE_KIND")),
    }
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
            .map(|stop| Ok(GradientStop { position: stop.position, color: color_from_projection(&stop.color)? }))
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

fn projection_node(node: &Node) -> ProjectionNode {
    let project_paint = |paint: &Paint| match paint {
        Paint::Solid(color) => (color.to_css_srgb_hex(), Some(projection_color(*color)), None),
        Paint::LinearGradient(gradient) => (
            gradient.stops[0].color.to_css_srgb_hex(),
            None,
            Some(ProjectionLinearGradient {
                start: gradient.start,
                end: gradient.end,
                stops: gradient
                    .stops
                    .iter()
                    .map(|stop| ProjectionGradientStop { position: stop.position, color: projection_color(stop.color) })
                    .collect(),
            }),
        ),
    };
    let (fill, fill_color, fill_gradient) = project_paint(&node.fill);
    let (stroke, stroke_color, stroke_gradient) = project_paint(&node.stroke);
    ProjectionNode {
        id: format_uuid(node.id),
        name: node.name.clone(),
        kind: match node.kind {
            NodeKind::Frame => "frame",
            NodeKind::Rectangle => "rectangle",
            NodeKind::Ellipse => "ellipse",
            NodeKind::Text => "text",
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
        stroke,
        stroke_color,
        stroke_gradient,
        stroke_width: node.stroke_width,
        position_id: Some(format_position_id(node.position)),
        opacity: node.opacity,
        corner_radius: node.corner_radius,
        text: node.text.clone(),
        visible: node.visible,
        locked: node.locked,
    }
}

fn node_from_projection(node: ProjectionNode) -> Result<Node, JsValue> {
    let fill = paint_from_projection(&node.fill, node.fill_color.as_ref(), node.fill_gradient.as_ref())?;
    let stroke = paint_from_projection(&node.stroke, node.stroke_color.as_ref(), node.stroke_gradient.as_ref())?;
    let id = parse_id(&node.id)?;
    let position = node.position_id.as_deref().map(parse_position_id).transpose()?.unwrap_or_else(|| PositionId::for_node(id));
    Ok(Node {
        id,
        parent_id: None,
        position,
        name: node.name,
        kind: parse_kind(&node.kind)?,
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        rotation: node.rotation,
        fill,
        stroke,
        stroke_width: node.stroke_width,
        opacity: node.opacity,
        corner_radius: node.corner_radius,
        text: node.text,
        visible: node.visible,
        locked: node.locked,
    })
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
    if key.len() != 32 || actor.len() != 32 || !key.bytes().all(|byte| byte.is_ascii_hexdigit()) || !actor.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(JsValue::from_str("INVALID_POSITION_ID"));
    }
    let key = u128::from_str_radix(key, 16).map_err(|_| JsValue::from_str("INVALID_POSITION_ID"))?;
    let actor = u128::from_str_radix(actor, 16).map_err(|_| JsValue::from_str("INVALID_POSITION_ID"))?;
    Ok(PositionId { key, actor: ActorId(actor) })
}

fn core_error(error: editor_core::CommandError) -> JsValue {
    JsValue::from_str(&format!("{error:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;

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
            fill: "#e3dcff".into(),
            stroke: "#00000000".into(),
            stroke_width: 0.0,
            opacity: 1.0,
            corner_radius: 12.0,
            text: String::new(),
            visible: true,
            locked: false,
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
            fill: "#e3dcff".into(),
            stroke: "#00000000".into(),
            stroke_width: 0.0,
            opacity: 1.0,
            corner_radius: 12.0,
            text: String::new(),
            visible: true,
            locked: false,
        };
        let second = Node {
            id: NodeId(2),
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
                        fill: "#e3dcff".into(),
                        stroke: "#00000000".into(),
                        stroke_width: 0.0,
                        opacity: 1.0,
                        corner_radius: 12.0,
                        visible: true,
                        locked: false
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
            fill: "#e3dcff".into(),
            stroke: "#00000000".into(),
            stroke_width: 0.0,
            opacity: 1.0,
            corner_radius: 12.0,
            text: String::new(),
            visible: true,
            locked: false,
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
            fill: "#e3dcff".into(),
            stroke: "#00000000".into(),
            stroke_width: 0.0,
            opacity: 0.75,
            corner_radius: 12.0,
            text: String::new(),
            visible: true,
            locked: false,
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
            fill: "#e3dcff".into(),
            stroke: "#00000000".into(),
            stroke_width: 0.0,
            opacity: 1.0,
            corner_radius: 12.0,
            text: String::new(),
            visible: true,
            locked: false,
        };
        source.submit_create(NodeId(16), 0, node, Origin::LocalUser).unwrap();
        source.submit_delete(NodeId(17), 1, vec![NodeId(1)]).unwrap();

        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&source.snapshot_json()).unwrap();
        assert!(restored.document.retired_ids().any(|id| *id == NodeId(1)));
        assert!(restored
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
                    fill: "#e3dcff".into(),
                    stroke: "#00000000".into(),
                    stroke_width: 0.0,
                    opacity: 1.0,
                    corner_radius: 12.0,
                    text: String::new(),
                    visible: true,
                    locked: false,
                },
                Origin::LocalUser,
            )
            .is_err());
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
                    fill: "#e3dcff".into(),
                    stroke: "#00000000".into(),
                    stroke_width: 0.0,
                    opacity: 1.0,
                    corner_radius: 12.0,
                    text: String::new(),
                    visible: true,
                    locked: false,
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
        assert_eq!(restored.document.node(NodeId(1)).unwrap().name, "Legacy card");
    }

    #[test]
    fn concrete_batch_crosses_the_bridge_as_one_history_revision() {
        let mut engine = DocumentEngine::new();
        let node = |id: &str, name: &str| ProjectionNode {
            id: id.into(),
            name: name.into(),
            kind: "rectangle".into(),
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 80.0,
            rotation: 0.0,
            fill: "#e3dcff".into(),
            fill_color: None,
            fill_gradient: None,
            stroke: "transparent".into(),
            stroke_color: None,
            stroke_gradient: None,
            stroke_width: 0.0,
            position_id: None,
            opacity: 1.0,
            corner_radius: 12.0,
            text: String::new(),
            visible: true,
            locked: false,
        };

        let revision = engine
            .submit_batch(
                NodeId(16),
                0,
                vec![
                    BatchCommand::Create { node: node("00000000-0000-4000-8000-000000000001", "First") },
                    BatchCommand::Create { node: node("00000000-0000-4000-8000-000000000002", "Second") },
                ],
            )
            .unwrap();

        assert_eq!(revision, 1);
        assert_eq!(engine.document.revision, 1);
        assert_eq!(engine.document.nodes().count(), 2);
        assert!(engine.document.can_undo());
    }

    #[test]
    fn text_batch_round_trips_canonically_and_v2_snapshots_remain_readable() {
        let mut engine = DocumentEngine::new();
        let id = parse_id("00000000-0000-4000-8000-000000000001").unwrap();
        let text = |value: &str| ProjectionNode {
            id: "00000000-0000-4000-8000-000000000001".into(),
            name: "Heading".into(),
            kind: "text".into(),
            x: 0.0,
            y: 0.0,
            width: 240.0,
            height: 48.0,
            rotation: 0.0,
            fill: "#111111".into(),
            fill_color: None,
            fill_gradient: None,
            stroke: "#00000000".into(),
            stroke_color: None,
            stroke_gradient: None,
            stroke_width: 0.0,
            position_id: None,
            opacity: 1.0,
            corner_radius: 0.0,
            text: value.into(),
            visible: true,
            locked: false,
        };
        engine
            .submit_batch(NodeId(16), 0, vec![BatchCommand::Create { node: text("Before") }])
            .unwrap();
        engine
            .submit_batch(NodeId(17), 1, vec![BatchCommand::Update { node: text("After") }])
            .unwrap();
        assert_eq!(engine.document.node(id).unwrap().text, "After");
        assert_eq!(engine.undo().unwrap(), 3);
        assert_eq!(engine.document.node(id).unwrap().text, "Before");
        assert_eq!(engine.redo().unwrap(), 4);

        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":9"));
        assert!(snapshot.contains("\"stroke\":\"#00000000\""));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.document.node(id).unwrap().text, "After");

        let mut v2: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        v2.as_object_mut().unwrap().insert("schemaVersion".into(), serde_json::json!(2));
        v2["nodes"][0].as_object_mut().unwrap().remove("text");
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
            name: "P3 card".into(),
            kind: "rectangle".into(),
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 80.0,
            rotation: 0.0,
            fill: "#43d477".into(),
            fill_color: Some(ProjectionColor { space: "display-p3".into(), components: [0.2, 0.8, 0.4], alpha: 1.0 }),
            fill_gradient: None,
            stroke: "#00000000".into(),
            stroke_color: None,
            stroke_gradient: None,
            stroke_width: 0.0,
            position_id: Some("00000000000000000000000000000010:00000000000000000000000000000007".into()),
            opacity: 1.0,
            corner_radius: 8.0,
            text: String::new(),
            visible: true,
            locked: false,
        };
        engine.submit_batch(NodeId(16), 0, vec![BatchCommand::Create { node }]).unwrap();
        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"fillColor\":{\"space\":\"display-p3\""));
        assert!(snapshot.contains("\"positionId\":\"00000000000000000000000000000010:00000000000000000000000000000007\""));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.document.node(parse_id(id).unwrap()).unwrap().fill, Paint::Solid(Color::new(ColorSpace::DisplayP3, [0.2, 0.8, 0.4], 1.0).unwrap()));
        assert_eq!(restored.document.node(parse_id(id).unwrap()).unwrap().position, PositionId { key: 16, actor: ActorId(7) });

        let mut v4: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        v4.as_object_mut().unwrap().insert("schemaVersion".into(), serde_json::json!(4));
        v4["nodes"][0].as_object_mut().unwrap().remove("positionId");
        let mut position_migrated = DocumentEngine::new();
        position_migrated.load_snapshot_json(&v4.to_string()).unwrap();
        assert_eq!(position_migrated.document.node(parse_id(id).unwrap()).unwrap().position, PositionId::for_node(parse_id(id).unwrap()));

        let mut v3: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        v3.as_object_mut().unwrap().insert("schemaVersion".into(), serde_json::json!(3));
        v3["nodes"][0].as_object_mut().unwrap().remove("fillColor");
        v3["nodes"][0].as_object_mut().unwrap().remove("positionId");
        let mut migrated = DocumentEngine::new();
        migrated.load_snapshot_json(&v3.to_string()).unwrap();
        assert!(matches!(migrated.document.node(parse_id(id).unwrap()).unwrap().fill, Paint::Solid(Color { space: ColorSpace::Srgb, .. })));
    }

    #[test]
    fn snapshot_v6_round_trips_document_color_profile_and_v5_defaults_to_srgb() {
        let mut engine = DocumentEngine::new();
        engine
            .set_document_color_profile(
                "00000000-0000-4000-8000-000000000099",
                0,
                "display-p3",
            )
            .unwrap();
        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":9"));
        assert!(snapshot.contains("\"colorProfile\":\"display-p3\""));

        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.document.color_profile(), DocumentColorProfile::DisplayP3);

        let mut v5: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        v5.as_object_mut().unwrap().insert("schemaVersion".into(), serde_json::json!(5));
        v5.as_object_mut().unwrap().remove("colorProfile");
        let mut migrated = DocumentEngine::new();
        migrated.load_snapshot_json(&v5.to_string()).unwrap();
        assert_eq!(migrated.document.color_profile(), DocumentColorProfile::Srgb);
    }

    #[test]
    fn snapshot_v9_round_trips_gradient_stroke_and_v7_uses_legacy_rotation_fallback() {
        let mut engine = DocumentEngine::new();
        let id = "00000000-0000-4000-8000-000000000001";
        let gradient = ProjectionLinearGradient {
            start: [0.0, 0.0],
            end: [1.0, 1.0],
            stops: vec![
                ProjectionGradientStop { position: 0.0, color: ProjectionColor { space: "srgb".into(), components: [0.1, 0.2, 0.3], alpha: 1.0 } },
                ProjectionGradientStop { position: 1.0, color: ProjectionColor { space: "display-p3".into(), components: [0.4, 0.8, 0.6], alpha: 0.8 } },
            ],
        };
        engine
            .submit_batch(
                NodeId(44),
                0,
                vec![BatchCommand::Create {
                    node: ProjectionNode {
                        id: id.into(), name: "Gradient card".into(), kind: "rectangle".into(),
                        x: 0.0, y: 0.0, width: 100.0, height: 80.0, rotation: 30.0,
                        fill: "#1a334d".into(), fill_color: None, fill_gradient: Some(gradient.clone()), stroke: "#1a334d".into(), stroke_color: None, stroke_gradient: Some(gradient.clone()), stroke_width: 3.0, position_id: None,
                        opacity: 1.0, corner_radius: 8.0, text: String::new(), visible: true, locked: false,
                    },
                }],
            )
            .unwrap();
        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":9"));
        assert!(snapshot.contains("\"fillGradient\""));
        assert!(snapshot.contains("\"strokeGradient\""));
        assert!(snapshot.contains("\"strokeWidth\":3.0"));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert!(matches!(restored.document.node(parse_id(id).unwrap()).unwrap().fill, Paint::LinearGradient(ref value) if value.start == gradient.start && value.end == gradient.end && value.stops.len() == 2));
        assert_eq!(restored.document.node(parse_id(id).unwrap()).unwrap().rotation, 30.0);
        assert!(matches!(restored.document.node(parse_id(id).unwrap()).unwrap().stroke, Paint::LinearGradient(ref value) if value.start == gradient.start && value.end == gradient.end && value.stops.len() == 2));
        assert_eq!(restored.document.node(parse_id(id).unwrap()).unwrap().stroke_width, 3.0);

        let mut v6: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        v6.as_object_mut().unwrap().insert("schemaVersion".into(), serde_json::json!(7));
        v6.as_object_mut().unwrap().remove("canonicalHash");
        v6["nodes"][0].as_object_mut().unwrap().remove("fillGradient");
        v6["nodes"][0].as_object_mut().unwrap().remove("rotation");
        let mut legacy = DocumentEngine::new();
        legacy.load_snapshot_json(&v6.to_string()).unwrap();
        assert!(matches!(legacy.document.node(parse_id(id).unwrap()).unwrap().fill, Paint::Solid(_)));
        assert_eq!(legacy.document.node(parse_id(id).unwrap()).unwrap().rotation, 0.0);
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
                    fill: "#e3dcff".into(),
                    stroke: "#00000000".into(),
                    stroke_width: 0.0,
                    opacity: 1.0,
                    corner_radius: 12.0,
                    text: String::new(),
                    visible: true,
                    locked: false,
                })
                .unwrap();
            updates.push(BatchCommand::Update {
                node: ProjectionNode {
                    id: format_uuid(id),
                    name: format!("Layer {index}"),
                    kind: "rectangle".into(),
                    x: index as f64,
                    y: -(index as f64),
                    width: 100.0,
                    height: 80.0,
                    rotation: 0.0,
                    fill: "#e3dcff".into(),
                    fill_color: None,
                    fill_gradient: None,
                    stroke: "#00000000".into(),
                    stroke_color: None,
                    stroke_gradient: None,
                    stroke_width: 0.0,
                    position_id: None,
                    opacity: 1.0,
                    corner_radius: 12.0,
                    text: String::new(),
                    visible: true,
                    locked: false,
                },
            });
        }

        assert_eq!(engine.submit_batch(NodeId(1_001), 0, updates).unwrap(), 1);
        assert_eq!(engine.document.revision, 1);
        assert_eq!(engine.document.node(NodeId(1_000)).unwrap().x, 1_000.0);
        assert_eq!(engine.document.node(NodeId(1_000)).unwrap().y, -1_000.0);
    }
}
