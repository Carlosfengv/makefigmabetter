//! Browser bridge for the canonical Rust document core.
//!
//! Rendering deliberately stays outside this crate. The Engine Worker owns the
//! canvas/GPU resources while this adapter owns only durable document semantics.

use editor_core::{
    ActorId, Appearance, AppliedChange, ArcData, AssetId, AssetReference, AutoLayout,
    BackgroundBlur, BlendMode, BooleanOperation, Command, ConstraintType, Constraints,
    DEFAULT_PAGE_ID, Document, DocumentId, DropShadow, Effect, FillRule, FontFaceMetadata,
    FontReference, GridItemsPositioning, GridTrack, HyperlinkTarget, HyperlinkType, InnerShadow,
    LayerBlur, LayoutAlignment, LayoutMode, LayoutSizing, LeadingTrim, LineHeightUnit, Node,
    NodeId, NodeKind, OpenTypeFeature, OperationEnvelope, OperationId, Origin, Page, PageId,
    PaintStyleLinks, PaintStyleResource, PaintStyleVariableBinding, ParagraphListType,
    ParagraphStyle, ParagraphStyleRun, ParametricShape, PointId, PositionId, StrokeAlign,
    StrokeCap, StrokeJoin, TextAlign, TextAutoSize, TextCase, TextDecoration, TextDecorationColor,
    TextDecorationOffset, TextDecorationStyle, TextDecorationThickness, TextListType,
    TextProperties, TextStyleLetterSpacingUnit, TextStyleResource, TextStyleRun, TextTruncation,
    TextWrapStyle, Transaction, TransactionId, VariableCollectionResource, VariableMode,
    VariableResolvedType, VariableResource, VariableValue, VectorPath, VectorPoint,
    VectorPointType, VectorSubpath, WrapTrackAlignment,
    color::{
        Color, ColorSpace, DocumentColorProfile, GradientPaint, GradientPaintKind, GradientStop,
        ImageFilters, ImagePaint, ImageScaleMode, LinearGradient, Paint, PaintLayer,
        PaintLayerKind, PaintStack,
    },
    geometry::{
        Bounds, DecorativeCapStyle, PerSideStrokeAlign, Point, StrokeCapStyle, StrokeJoinStyle,
        StrokeStyle, boolean_vector_paths, decorative_cap_mesh, flatten_vector_path,
        nearest_vector_path_segment, outline_stroke_mesh, outline_vector_path,
        outline_vector_path_with_caps, parametric_shape_outline, point_in_polygon,
        stroke_mesh_for_continuous_rounded_rectangle_with_radii, stroke_mesh_for_dashed_line,
        stroke_mesh_for_dashed_polyline, stroke_mesh_for_dashed_rounded_rectangle_with_radii,
        stroke_mesh_for_polyline, stroke_mesh_for_polyline_with_caps,
        stroke_mesh_for_rounded_rectangle, stroke_mesh_for_rounded_rectangle_with_radii,
        stroke_meshes_for_per_side_rectangle, stroke_meshes_for_per_side_rectangle_with_dash,
        vector_path_contains as core_vector_path_contains, vector_path_dashed_stroke_mesh,
        vector_path_stroke_mesh,
    },
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct DocumentEngine {
    document: Document,
}

fn collect_geometry_change_ids(
    changes: &[AppliedChange],
    ids: &mut std::collections::BTreeSet<NodeId>,
) {
    for change in changes {
        match change {
            AppliedChange::Composite { changes } => collect_geometry_change_ids(changes, ids),
            AppliedChange::GeometryChanged { id, .. } => {
                ids.insert(*id);
            }
            _ => {}
        }
    }
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
                BatchCommand::CreatePage { page } => {
                    commands.push(Command::CreatePage(Page {
                        id: parse_page_id(&page.id)?,
                        name: page.name,
                        position: parse_position_id(&page.position_id)?,
                    }));
                }
                // Resource Index admission must be reducible alongside the
                // nodes that reference it. This lets paste remain one Core
                // transaction instead of briefly exposing an orphan asset or
                // a dangling image node between two transactions.
                BatchCommand::RegisterAsset { asset } => {
                    commands.push(Command::RegisterAsset {
                        asset: asset_from_projection(asset)?,
                    });
                }
                BatchCommand::RegisterTextStyle { style } => {
                    commands.push(Command::RegisterTextStyle {
                        style: text_style_resource_from_projection(&style)?,
                    });
                }
                BatchCommand::RegisterPaintStyle { style } => {
                    commands.push(Command::RegisterPaintStyle {
                        style: paint_style_resource_from_projection(&style)?,
                    });
                }
                BatchCommand::SetTextStyle { style } => {
                    commands.push(Command::SetTextStyle {
                        style: text_style_resource_from_projection(&style)?,
                    });
                }
                BatchCommand::DeleteTextStyle { id } => {
                    commands.push(Command::DeleteTextStyle { id });
                }
                BatchCommand::SetPaintStyle { style } => {
                    commands.push(Command::SetPaintStyle {
                        style: paint_style_resource_from_projection(&style)?,
                    });
                }
                BatchCommand::DeletePaintStyle { id } => {
                    commands.push(Command::DeletePaintStyle { id });
                }
                BatchCommand::RegisterVariableCollection { collection } => {
                    commands.push(Command::RegisterVariableCollection {
                        collection: variable_collection_from_projection(&collection)?,
                    });
                }
                BatchCommand::RegisterVariable { variable } => {
                    commands.push(Command::RegisterVariable {
                        variable: variable_resource_from_projection(&variable)?,
                    });
                }
                BatchCommand::SetVariable { variable } => {
                    commands.push(Command::SetVariable {
                        variable: variable_resource_from_projection(&variable)?,
                    });
                }
                BatchCommand::DeleteVariable { id } => {
                    commands.push(Command::DeleteVariable { id });
                }
                BatchCommand::SetVariableCollection {
                    collection,
                    variables,
                } => commands.push(Command::SetVariableCollection {
                    collection: variable_collection_from_projection(&collection)?,
                    variables: variables
                        .iter()
                        .map(variable_resource_from_projection)
                        .collect::<Result<_, _>>()?,
                }),
                BatchCommand::DeleteVariableCollection { id } => {
                    commands.push(Command::DeleteVariableCollection { id });
                }
                BatchCommand::Create { node } => {
                    let text_properties =
                        text_properties_from_projection(node.text_properties.as_ref())?;
                    let auto_layout = auto_layout_from_projection(node.auto_layout.as_ref())?;
                    let fill_stack = node
                        .fill_stack
                        .as_ref()
                        .map(paint_stack_from_projection)
                        .transpose()?;
                    let stroke_stack = node
                        .stroke_stack
                        .as_ref()
                        .map(paint_stack_from_projection)
                        .transpose()?;
                    let paint_style_links = paint_style_links_from_projection(&node);
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
                    let node_id = node.id;
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
                        commands.push(Command::SetTextProperties {
                            id: node_id,
                            properties,
                        });
                    }
                    if auto_layout != AutoLayout::default() {
                        commands.push(Command::SetAutoLayout {
                            id: node_id,
                            layout: auto_layout,
                        });
                    }
                    if fill_stack.is_some() || stroke_stack.is_some() {
                        commands.push(Command::SetPaintStacks {
                            id: node_id,
                            fill_stack,
                            stroke_stack,
                        });
                    }
                    if !paint_style_links.is_empty() {
                        commands.push(Command::SetPaintStyleLinks {
                            id: node_id,
                            links: paint_style_links,
                        });
                    }
                }
                BatchCommand::Restore { node } => {
                    let text_properties =
                        text_properties_from_projection(node.text_properties.as_ref())?;
                    let auto_layout = auto_layout_from_projection(node.auto_layout.as_ref())?;
                    let fill_stack = node
                        .fill_stack
                        .as_ref()
                        .map(paint_stack_from_projection)
                        .transpose()?;
                    let stroke_stack = node
                        .stroke_stack
                        .as_ref()
                        .map(paint_stack_from_projection)
                        .transpose()?;
                    let paint_style_links = paint_style_links_from_projection(&node);
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
                    let node_id = node.id;
                    commands.push(Command::RestoreNode {
                        page_id,
                        node,
                        asset_id,
                        text_properties,
                    });
                    if auto_layout != AutoLayout::default() {
                        commands.push(Command::SetAutoLayout {
                            id: node_id,
                            layout: auto_layout,
                        });
                    }
                    if fill_stack.is_some() || stroke_stack.is_some() {
                        commands.push(Command::SetPaintStacks {
                            id: node_id,
                            fill_stack,
                            stroke_stack,
                        });
                    }
                    if !paint_style_links.is_empty() {
                        commands.push(Command::SetPaintStyleLinks {
                            id: node_id,
                            links: paint_style_links,
                        });
                    }
                }
                BatchCommand::ConvertToTextPath { node } => {
                    let text_properties =
                        text_properties_from_projection(node.text_properties.as_ref())?
                            .unwrap_or_default();
                    let node = node_from_projection(node)?;
                    if node.kind != NodeKind::TextPath {
                        return Err(JsValue::from_str("INVALID_TEXT_PATH_CONVERSION"));
                    }
                    let path = node
                        .vector_path
                        .clone()
                        .ok_or_else(|| JsValue::from_str("INVALID_VECTOR_PATH"))?;
                    commands.push(Command::ConvertToTextPath { id: node.id, path });
                    commands.push(Command::Rename {
                        id: node.id,
                        name: node.name,
                    });
                    commands.push(Command::SetText {
                        id: node.id,
                        text: node.text,
                    });
                    commands.push(Command::SetTextProperties {
                        id: node.id,
                        properties: text_properties,
                    });
                    commands.push(Command::SetNodeExtensions {
                        id: node.id,
                        extensions: node.extensions,
                    });
                }
                // The Worker resolves a partial Inspector patch to this complete node
                // payload before crossing the bridge. Keeping the bridge input fully
                // concrete makes replay deterministic and lets the Rust reducer own
                // the all-or-nothing validation of every derived core field.
                BatchCommand::Update {
                    node,
                    ignore_constraints,
                    plain_text_only,
                    rename_text_path,
                } => {
                    let text_properties =
                        text_properties_from_projection(node.text_properties.as_ref())?;
                    let auto_layout = auto_layout_from_projection(node.auto_layout.as_ref())?;
                    let fill_stack = node
                        .fill_stack
                        .as_ref()
                        .map(paint_stack_from_projection)
                        .transpose()?;
                    let stroke_stack = node
                        .stroke_stack
                        .as_ref()
                        .map(paint_stack_from_projection)
                        .transpose()?;
                    let paint_style_links = paint_style_links_from_projection(&node);
                    let asset_id = node
                        .asset_id
                        .as_deref()
                        .map(parse_id)
                        .transpose()?
                        .map(|id| AssetId(id.0));
                    let node = node_from_projection(node)?;
                    if plain_text_only {
                        let supports_plain_text = matches!(
                            node.kind,
                            NodeKind::CodeBlock
                                | NodeKind::ShapeWithText
                                | NodeKind::Sticky
                                | NodeKind::TableCell
                                | NodeKind::TextPath
                        );
                        let supports_properties =
                            matches!(node.kind, NodeKind::ShapeWithText | NodeKind::TextPath);
                        if !supports_plain_text
                            || (text_properties.is_some() && !supports_properties)
                        {
                            return Err(JsValue::from_str("INVALID_TEXT_PROPERTIES"));
                        }
                        commands.push(Command::SetText {
                            id: node.id,
                            text: node.text,
                        });
                        if node.kind == NodeKind::TextPath && rename_text_path {
                            commands.push(Command::Rename {
                                id: node.id,
                                name: node.name,
                            });
                        }
                        if let Some(properties) = text_properties {
                            commands.push(Command::SetTextProperties {
                                id: node.id,
                                properties,
                            });
                        }
                        continue;
                    }
                    if self
                        .document
                        .paint_style_links_for_node(node.id)
                        .cloned()
                        .unwrap_or_default()
                        != paint_style_links
                    {
                        commands.push(Command::SetPaintStyleLinks {
                            id: node.id,
                            links: paint_style_links,
                        });
                    }
                    let boolean_operation = node.boolean_operation;
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
                        parametric_shape: node.parametric_shape,
                        relative_transform: node.relative_transform,
                        opacity: node.opacity,
                        blend_mode: node.blend_mode,
                        drop_shadow: node.drop_shadow,
                        effect_stack: node.effect_stack,
                        corner_radius: node.corner_radius,
                        corner_radii: node.corner_radii,
                        corner_smoothing: node.corner_smoothing,
                        constraints: node.constraints,
                        visible: node.visible,
                        locked: node.locked,
                        contents_hidden: node.contents_hidden,
                        clips_content: Some(node.clips_content),
                    };
                    let geometry = if ignore_constraints {
                        Command::UpdateGeometryWithoutConstraints {
                            id: node.id,
                            x: node.x,
                            y: node.y,
                            width: node.width,
                            height: node.height,
                            rotation: node.rotation,
                        }
                    } else {
                        Command::UpdateGeometry {
                            id: node.id,
                            x: node.x,
                            y: node.y,
                            width: node.width,
                            height: node.height,
                            rotation: node.rotation,
                        }
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
                    if matches!(node.kind, NodeKind::Group | NodeKind::BooleanOperation)
                        && node.relative_transform.is_some()
                    {
                        commands.extend([appearance, geometry, rename]);
                    } else {
                        commands.extend([geometry, rename, appearance]);
                    }
                    // TextPath owns an immutable base path installed by
                    // ConvertToTextPath. A complete Inspector projection still
                    // carries that path, but replaying it through SetVectorPath
                    // would both violate the immutable contract and make every
                    // geometry/appearance edit fail Core validation. Only the
                    // node kinds with an authorable path emit this command.
                    if matches!(node.kind, NodeKind::Vector | NodeKind::Highlight) {
                        if let Some(path) = node.vector_path {
                            commands.push(Command::SetVectorPath { id: node.id, path });
                        }
                    }
                    if let Some(operation) = boolean_operation {
                        commands.push(Command::SetBooleanOperation {
                            id: node.id,
                            operation,
                        });
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
                    if matches!(
                        node.kind,
                        NodeKind::Text | NodeKind::ShapeWithText | NodeKind::TextPath
                    ) {
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
                    if auto_layout != self.document.auto_layout_for_node(node.id) {
                        commands.push(Command::SetAutoLayout {
                            id: node.id,
                            layout: auto_layout,
                        });
                    }
                    if fill_stack.is_some() || stroke_stack.is_some() {
                        commands.push(Command::SetPaintStacks {
                            id: node.id,
                            fill_stack,
                            stroke_stack,
                        });
                    }
                }
                BatchCommand::MoveVectorPoint { id, point_id, x, y } => {
                    commands.push(Command::MoveVectorPoint {
                        id: parse_id(&id)?,
                        point_id: PointId(parse_id(&point_id)?.0),
                        position: Point::new(x, y)
                            .map_err(|_| JsValue::from_str("INVALID_VECTOR_POINT"))?,
                    });
                }
                BatchCommand::SetVectorSubpathClosed {
                    id,
                    subpath_index,
                    closed,
                } => {
                    commands.push(Command::SetVectorSubpathClosed {
                        id: parse_id(&id)?,
                        subpath_index,
                        closed,
                    });
                }
                BatchCommand::InsertVectorPoint {
                    id,
                    subpath_index,
                    after_point_id,
                    point,
                } => {
                    commands.push(Command::InsertVectorPoint {
                        id: parse_id(&id)?,
                        subpath_index,
                        after_point_id: after_point_id
                            .as_deref()
                            .map(parse_id)
                            .transpose()?
                            .map(|id| PointId(id.0)),
                        point: vector_point_from_projection(point)?,
                    });
                }
                BatchCommand::SplitVectorSegment {
                    id,
                    subpath_index,
                    after_point_id,
                    t,
                    point_id,
                } => {
                    commands.push(Command::SplitVectorSegment {
                        id: parse_id(&id)?,
                        subpath_index,
                        after_point_id: PointId(parse_id(&after_point_id)?.0),
                        t,
                        point_id: PointId(parse_id(&point_id)?.0),
                    });
                }
                BatchCommand::ConnectVectorEndpoints {
                    id,
                    first_subpath_index,
                    first_point_id,
                    second_subpath_index,
                    second_point_id,
                } => {
                    commands.push(Command::ConnectVectorEndpoints {
                        id: parse_id(&id)?,
                        first_subpath_index,
                        first_point_id: PointId(parse_id(&first_point_id)?.0),
                        second_subpath_index,
                        second_point_id: PointId(parse_id(&second_point_id)?.0),
                    });
                }
                BatchCommand::SetMask { id, enabled } => {
                    commands.push(Command::SetMask {
                        id: parse_id(&id)?,
                        enabled,
                    });
                }
                BatchCommand::SetExtensions { id, extensions } => {
                    commands.push(Command::SetNodeExtensions {
                        id: parse_id(&id)?,
                        extensions,
                    });
                }
                BatchCommand::DeleteVectorPoint { id, point_id } => {
                    commands.push(Command::DeleteVectorPoint {
                        id: parse_id(&id)?,
                        point_id: PointId(parse_id(&point_id)?.0),
                    });
                }
                BatchCommand::SetVectorPointHandles {
                    id,
                    point_id,
                    handle_in,
                    handle_out,
                    point_type,
                } => {
                    let point_type = match point_type.as_str() {
                        "corner" => VectorPointType::Corner,
                        "mirrored" => VectorPointType::Mirrored,
                        "asymmetric" => VectorPointType::Asymmetric,
                        _ => return Err(JsValue::from_str("INVALID_VECTOR_POINT_TYPE")),
                    };
                    let handle = |value: Option<ProjectionVectorHandle>| {
                        value
                            .map(|handle| {
                                Point::new(handle.x, handle.y)
                                    .map_err(|_| JsValue::from_str("INVALID_VECTOR_HANDLE"))
                            })
                            .transpose()
                    };
                    commands.push(Command::SetVectorPointHandles {
                        id: parse_id(&id)?,
                        point_id: PointId(parse_id(&point_id)?.0),
                        handle_in: handle(handle_in)?,
                        handle_out: handle(handle_out)?,
                        point_type,
                    });
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
    #[serde(default)]
    text_styles: Option<Vec<ProjectionTextStyleResource>>,
    #[serde(default)]
    paint_styles: Option<Vec<ProjectionPaintStyleResource>>,
    #[serde(default)]
    variable_collections: Option<Vec<ProjectionVariableCollectionResource>>,
    #[serde(default)]
    variables: Option<Vec<ProjectionVariableResource>>,
    nodes: Vec<ProjectionNode>,
    #[serde(default)]
    retired_ids: Option<Vec<String>>,
}

fn validate_core_snapshot_version(snapshot: &CoreSnapshot) -> Result<(), &'static str> {
    if !(1..=73).contains(&snapshot.schema_version)
        || (snapshot.schema_version < 73
            && snapshot.nodes.iter().any(|node| {
                node.auto_layout.as_ref().is_some_and(|layout| {
                    layout.grid_items_positioning.is_some()
                        || layout.grid_row_anchor.is_some()
                        || layout.grid_column_anchor.is_some()
                })
            }))
        || (snapshot.schema_version < 72
            && snapshot.nodes.iter().any(|node| {
                node.auto_layout.as_ref().is_some_and(|layout| {
                    layout.grid_row_span.is_some() || layout.grid_column_span.is_some()
                })
            }))
        || (snapshot.schema_version < 71
            && snapshot.nodes.iter().any(|node| {
                node.auto_layout.as_ref().is_some_and(|layout| {
                    layout
                        .grid_rows
                        .iter()
                        .chain(&layout.grid_columns)
                        .any(|track| track.r#type == "hug")
                })
            }))
        || (snapshot.schema_version < 70
            && snapshot.nodes.iter().any(|node| {
                node.auto_layout.as_ref().is_some_and(|layout| {
                    layout.mode == "grid"
                        || !layout.grid_rows.is_empty()
                        || !layout.grid_columns.is_empty()
                        || layout.grid_row_gap.is_some()
                        || layout.grid_column_gap.is_some()
                })
            }))
        || (snapshot.schema_version < 69
            && snapshot.nodes.iter().any(|node| {
                node.text_properties.as_ref().is_some_and(|properties| {
                    properties.runs.iter().any(|run| {
                        run.variable_bindings
                            .as_ref()
                            .is_some_and(|value| !value.is_empty())
                    }) || properties.base_style.as_ref().is_some_and(|style| {
                        style
                            .variable_bindings
                            .as_ref()
                            .is_some_and(|value| !value.is_empty())
                    })
                })
            }))
        || (snapshot.schema_version < 68
            && snapshot.paint_styles.as_ref().is_some_and(|styles| {
                styles
                    .iter()
                    .any(|style| !style.variable_bindings.is_empty())
            }))
        || (snapshot.schema_version < 67
            && snapshot.text_styles.as_ref().is_some_and(|styles| {
                styles
                    .iter()
                    .any(|style| !style.variable_bindings.is_empty())
            }))
        || (snapshot.schema_version < 66
            && snapshot.text_styles.as_ref().is_some_and(|styles| {
                styles
                    .iter()
                    .any(|style| style.letter_spacing_unit.is_some())
            }))
        || (snapshot.schema_version < 65
            && (snapshot.text_styles.as_ref().is_some_and(|styles| {
                styles.iter().any(|style| {
                    !style.description_markdown.is_empty() || !style.documentation_links.is_empty()
                })
            }) || snapshot.paint_styles.as_ref().is_some_and(|styles| {
                styles.iter().any(|style| {
                    !style.description_markdown.is_empty() || !style.documentation_links.is_empty()
                })
            })))
        || (snapshot.schema_version < 64
            && snapshot.variables.as_ref().is_some_and(|values| {
                values
                    .iter()
                    .any(|variable| !variable.code_syntax.is_empty())
            }))
        || (snapshot.schema_version < 63
            && (snapshot
                .variable_collections
                .as_ref()
                .is_some_and(|values| !values.is_empty())
                || snapshot
                    .variables
                    .as_ref()
                    .is_some_and(|values| !values.is_empty())))
        || (snapshot.schema_version < 62
            && snapshot.nodes.iter().any(|node| {
                node.text_properties.as_ref().is_some_and(|properties| {
                    properties
                        .runs
                        .iter()
                        .any(|run| run.paint_style_id.is_some())
                        || properties
                            .base_style
                            .as_ref()
                            .is_some_and(|style| style.paint_style_id.is_some())
                })
            }))
        || (snapshot.schema_version < 61
            && snapshot.nodes.iter().any(|node| {
                node.fill_style_id.is_some()
                    || node.stroke_style_id.is_some()
                    || node.background_style_id.is_some()
            }))
        || (snapshot.schema_version < 60
            && snapshot
                .paint_styles
                .as_ref()
                .is_some_and(|styles| !styles.is_empty()))
        || (snapshot.schema_version < 59
            && snapshot
                .text_styles
                .as_ref()
                .is_some_and(|styles| !styles.is_empty()))
        || (snapshot.schema_version < 58
            && snapshot.nodes.iter().any(|node| {
                node.text_properties.as_ref().is_some_and(|properties| {
                    properties
                        .runs
                        .iter()
                        .any(|run| run.text_style_id.is_some())
                        || properties
                            .base_style
                            .as_ref()
                            .is_some_and(|style| style.text_style_id.is_some())
                })
            }))
        || (snapshot.schema_version < 57
            && snapshot.nodes.iter().any(|node| {
                node.text_properties.as_ref().is_some_and(|properties| {
                    properties
                        .runs
                        .iter()
                        .any(|run| !run.open_type_features.is_empty())
                        || properties
                            .base_style
                            .as_ref()
                            .is_some_and(|style| !style.open_type_features.is_empty())
                })
            }))
        || (snapshot.schema_version < 56
            && snapshot.resource_index.as_ref().is_some_and(|assets| {
                assets
                    .iter()
                    .any(|asset| asset.font_faces.iter().any(|face| !face.aliases.is_empty()))
            }))
        || (snapshot.schema_version < 55
            && snapshot
                .resource_index
                .as_ref()
                .is_some_and(|assets| assets.iter().any(|asset| !asset.font_faces.is_empty())))
        || (snapshot.schema_version < 22
            && snapshot
                .nodes
                .iter()
                .any(|node| node.fill_stack.is_some() || node.stroke_stack.is_some()))
        || (snapshot.schema_version < 23
            && snapshot.nodes.iter().any(|node| {
                [&node.fill_stack, &node.stroke_stack]
                    .into_iter()
                    .filter_map(Option::as_ref)
                    .flat_map(|stack| &stack.layers)
                    .any(|layer| {
                        layer
                            .image
                            .as_ref()
                            .is_some_and(|image| image.rotation_degrees != 0)
                    })
            }))
        || (snapshot.schema_version < 24
            && snapshot
                .nodes
                .iter()
                .any(|node| node.blend_mode == "pass-through"))
        || (snapshot.schema_version < 25
            && snapshot.nodes.iter().any(|node| {
                matches!(node.blend_mode.as_str(), "linear-burn" | "linear-dodge")
                    || [&node.fill_stack, &node.stroke_stack]
                        .into_iter()
                        .filter_map(Option::as_ref)
                        .flat_map(|stack| &stack.layers)
                        .any(|layer| {
                            matches!(layer.blend_mode.as_str(), "linear-burn" | "linear-dodge")
                        })
            }))
        || (snapshot.schema_version < 26
            && snapshot.nodes.iter().any(|node| {
                node.extensions
                    .get(makefigma_document_codec::NORMAL_BLEND_ISOLATION_EXTENSION)
                    .is_some_and(|value| value.as_slice() == [1])
            }))
        || (snapshot.schema_version < 27
            && snapshot.nodes.iter().any(|node| {
                [&node.fill_stack, &node.stroke_stack]
                    .into_iter()
                    .filter_map(Option::as_ref)
                    .flat_map(|stack| &stack.layers)
                    .any(|layer| {
                        layer
                            .image
                            .as_ref()
                            .is_some_and(|image| image.filters.is_some())
                    })
            }))
        || (snapshot.schema_version < 28
            && snapshot.nodes.iter().any(|node| {
                node.text_properties.as_ref().is_some_and(|properties| {
                    properties.text_truncation.as_deref() == Some("ending")
                        || properties.max_lines.is_some()
                })
            }))
        || (snapshot.schema_version < 29
            && snapshot.nodes.iter().any(|node| {
                node.text_properties.as_ref().is_some_and(|properties| {
                    properties.runs.iter().any(|run| run.fill_stack.is_some())
                })
            }))
        || (snapshot.schema_version < 30
            && snapshot.nodes.iter().any(|node| {
                node.text_properties
                    .as_ref()
                    .is_some_and(|properties| properties.base_style.is_some())
            }))
        || (snapshot.schema_version < 31
            && snapshot.nodes.iter().any(|node| {
                node.text_properties.as_ref().is_some_and(|properties| {
                    properties.runs.iter().any(|run| run.text_case.is_some())
                        || properties
                            .base_style
                            .as_ref()
                            .is_some_and(|style| style.text_case.is_some())
                })
            }))
        || (snapshot.schema_version < 32
            && snapshot
                .nodes
                .iter()
                .any(|node| node.kind == "textPath" && node.text_properties.is_some()))
        || (snapshot.schema_version < 33
            && snapshot.nodes.iter().any(|node| {
                node.text_properties
                    .as_ref()
                    .is_some_and(|properties| properties.paragraph.line_height_unit.is_some())
            }))
        || (snapshot.schema_version < 34
            && snapshot.nodes.iter().any(|node| {
                node.text_properties
                    .as_ref()
                    .is_some_and(|properties| properties.paragraph.paragraph_indent.is_some())
            }))
        || (snapshot.schema_version < 35
            && snapshot.nodes.iter().any(|node| {
                node.text_properties
                    .as_ref()
                    .is_some_and(|properties| properties.paragraph.text_wrap_style.is_some())
            }))
        || (snapshot.schema_version < 36
            && snapshot.nodes.iter().any(|node| {
                node.text_properties.as_ref().is_some_and(|properties| {
                    properties.runs.iter().any(|run| run.hyperlink.is_some())
                        || properties
                            .base_style
                            .as_ref()
                            .is_some_and(|style| style.hyperlink.is_some())
                })
            }))
        || (snapshot.schema_version < 37
            && snapshot.nodes.iter().any(|node| {
                node.text_properties.as_ref().is_some_and(|properties| {
                    properties
                        .runs
                        .iter()
                        .any(|run| run.text_decoration.is_some())
                        || properties
                            .base_style
                            .as_ref()
                            .is_some_and(|style| style.text_decoration.is_some())
                })
            }))
        || (snapshot.schema_version < 38
            && snapshot.nodes.iter().any(|node| {
                node.text_properties.as_ref().is_some_and(|properties| {
                    properties
                        .runs
                        .iter()
                        .any(|run| run.text_decoration_style.is_some())
                        || properties
                            .base_style
                            .as_ref()
                            .is_some_and(|style| style.text_decoration_style.is_some())
                })
            }))
        || (snapshot.schema_version < 39
            && snapshot.nodes.iter().any(|node| {
                node.text_properties.as_ref().is_some_and(|properties| {
                    properties
                        .runs
                        .iter()
                        .any(|run| run.text_decoration_offset.is_some())
                        || properties
                            .base_style
                            .as_ref()
                            .is_some_and(|style| style.text_decoration_offset.is_some())
                })
            }))
        || (snapshot.schema_version < 40
            && snapshot.nodes.iter().any(|node| {
                node.text_properties.as_ref().is_some_and(|properties| {
                    properties
                        .runs
                        .iter()
                        .any(|run| run.text_decoration_thickness.is_some())
                        || properties
                            .base_style
                            .as_ref()
                            .is_some_and(|style| style.text_decoration_thickness.is_some())
                })
            }))
        || (snapshot.schema_version < 41
            && snapshot.nodes.iter().any(|node| {
                node.text_properties.as_ref().is_some_and(|properties| {
                    properties
                        .runs
                        .iter()
                        .any(|run| run.text_decoration_color.is_some())
                        || properties
                            .base_style
                            .as_ref()
                            .is_some_and(|style| style.text_decoration_color.is_some())
                })
            }))
        || (snapshot.schema_version < 43
            && snapshot.nodes.iter().any(|node| {
                node.text_properties.as_ref().is_some_and(|properties| {
                    properties.runs.iter().any(|run| run.leading_trim.is_some())
                        || properties
                            .base_style
                            .as_ref()
                            .is_some_and(|style| style.leading_trim.is_some())
                })
            }))
        || (snapshot.schema_version < 44
            && snapshot.nodes.iter().any(|node| {
                node.text_properties
                    .as_ref()
                    .is_some_and(|properties| properties.paragraph.list_type.is_some())
            }))
        || (snapshot.schema_version < 45
            && snapshot.nodes.iter().any(|node| {
                node.text_properties.as_ref().is_some_and(|properties| {
                    properties
                        .paragraph
                        .list_spacing
                        .is_some_and(|value| value != 0.0)
                })
            }))
        || (snapshot.schema_version < 46
            && snapshot.nodes.iter().any(|node| {
                node.text_properties
                    .as_ref()
                    .is_some_and(|properties| !properties.paragraph_style_runs.is_empty())
            }))
        || (snapshot.schema_version < 47
            && snapshot.nodes.iter().any(|node| {
                node.text_properties
                    .as_ref()
                    .is_some_and(|properties| properties.paragraph.hanging_list == Some(true))
            }))
        || (snapshot.schema_version < 48
            && snapshot.nodes.iter().any(|node| {
                node.text_properties.as_ref().is_some_and(|properties| {
                    properties
                        .paragraph_style_runs
                        .iter()
                        .any(|run| run.list_type.is_some())
                })
            }))
        || (snapshot.schema_version < 49
            && snapshot.nodes.iter().any(|node| {
                node.text_properties.as_ref().is_some_and(|properties| {
                    properties
                        .paragraph_style_runs
                        .iter()
                        .any(|run| run.list_spacing.is_some())
                })
            }))
        || (snapshot.schema_version < 50
            && snapshot.nodes.iter().any(|node| {
                node.text_properties.as_ref().is_some_and(|properties| {
                    properties
                        .paragraph_style_runs
                        .iter()
                        .any(|run| run.paragraph_spacing.is_some())
                })
            }))
        || (snapshot.schema_version < 51
            && snapshot.nodes.iter().any(|node| {
                node.text_properties.as_ref().is_some_and(|properties| {
                    properties
                        .paragraph_style_runs
                        .iter()
                        .any(|run| run.paragraph_indent.is_some())
                })
            }))
        || (snapshot.schema_version < 52
            && snapshot.nodes.iter().any(|node| {
                node.text_properties.as_ref().is_some_and(|properties| {
                    properties
                        .paragraph_style_runs
                        .iter()
                        .any(|run| run.line_height.is_some() || run.line_height_unit.is_some())
                })
            }))
        || (snapshot.schema_version < 53
            && snapshot.nodes.iter().any(|node| {
                node.text_properties.as_ref().is_some_and(|properties| {
                    properties.paragraph.hanging_punctuation.unwrap_or(false)
                })
            }))
        || (snapshot.schema_version < 54
            && snapshot.nodes.iter().any(|node| {
                node.text_properties.as_ref().is_some_and(|properties| {
                    properties
                        .paragraph_style_runs
                        .iter()
                        .any(|run| run.text_wrap_style.is_some())
                })
            }))
        || (snapshot.schema_version < 42
            && snapshot.nodes.iter().any(|node| {
                node.text_properties.as_ref().is_some_and(|properties| {
                    properties
                        .runs
                        .iter()
                        .any(|run| run.text_decoration_skip_ink == Some(true))
                        || properties
                            .base_style
                            .as_ref()
                            .is_some_and(|style| style.text_decoration_skip_ink == Some(true))
                })
            }))
    {
        return Err("UNSUPPORTED_CORE_SNAPSHOT");
    }
    Ok(())
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
    #[serde(default)]
    font_faces: Vec<ProjectionFontFace>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionFontFace {
    face_index: u32,
    family: String,
    style: String,
    #[serde(default)]
    aliases: Vec<ProjectionFontNameAlias>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionFontNameAlias {
    family: String,
    style: String,
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

fn default_blend_mode() -> String {
    "normal".into()
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
    /// v22 stores the presence-bearing Paint Stack. `Some({ layers: [] })`
    /// deliberately differs from an absent legacy stack.
    #[serde(default)]
    fill_stack: Option<ProjectionPaintStack>,
    #[serde(default)]
    fill_style_id: Option<String>,
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
    stroke_stack: Option<ProjectionPaintStack>,
    #[serde(default)]
    stroke_style_id: Option<String>,
    #[serde(default)]
    background_style_id: Option<String>,
    #[serde(default)]
    stroke_width: f64,
    /// v16 persists Figma-compatible open-path endpoint styles, v17 adds
    /// independent closed-shape corner radii, v18 adds continuous corner
    /// smoothing, v19 adds ordered fill/stroke stacks, and v21 adds child
    /// Auto Layout `alignSelf`. Earlier snapshots
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
    parametric_shape: Option<ProjectionParametricShape>,
    #[serde(default)]
    vector_path: Option<ProjectionVectorPath>,
    /// ADR 0028's durable Boolean selector; operand children remain nodes.
    #[serde(default)]
    boolean_operation: Option<String>,
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
    #[serde(default = "default_blend_mode")]
    blend_mode: String,
    corner_radius: f64,
    #[serde(default)]
    corner_radii: Vec<f64>,
    #[serde(default)]
    corner_smoothing: f64,
    #[serde(default)]
    constraints: Option<ProjectionConstraints>,
    /// L3's Frame layout semantics; absence migrates to manual positioning.
    #[serde(default)]
    auto_layout: Option<ProjectionAutoLayout>,
    /// R3 compatibility projection of the first Drop Shadow.
    #[serde(default)]
    drop_shadow: Option<ProjectionDropShadow>,
    /// Ordered effect storage. Empty snapshots retain the legacy R3 field.
    #[serde(default)]
    effect_stack: Vec<ProjectionEffect>,
    #[serde(default)]
    text: String,
    visible: bool,
    locked: bool,
    #[serde(default)]
    contents_hidden: bool,
    #[serde(default)]
    clips_content: Option<bool>,
    /// Derived from G4's reserved Canonical extension. It is a projection
    /// convenience only; the extension remains the durable wire state.
    #[serde(default)]
    is_mask: bool,
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
#[serde(rename_all = "camelCase")]
struct ProjectionAutoLayout {
    mode: String,
    padding: [f64; 4],
    item_spacing: f64,
    #[serde(default)]
    track_spacing: Option<f64>,
    #[serde(default)]
    track_alignment: Option<String>,
    wrap: bool,
    primary_alignment: String,
    counter_alignment: String,
    primary_sizing: String,
    counter_sizing: String,
    #[serde(default)]
    min_width: Option<f64>,
    #[serde(default)]
    max_width: Option<f64>,
    #[serde(default)]
    min_height: Option<f64>,
    #[serde(default)]
    max_height: Option<f64>,
    #[serde(default)]
    absolute: bool,
    #[serde(default)]
    align_self: Option<String>,
    #[serde(default)]
    grid_rows: Vec<ProjectionGridTrack>,
    #[serde(default)]
    grid_columns: Vec<ProjectionGridTrack>,
    #[serde(default)]
    grid_row_gap: Option<f64>,
    #[serde(default)]
    grid_column_gap: Option<f64>,
    #[serde(default)]
    grid_row_span: Option<u32>,
    #[serde(default)]
    grid_column_span: Option<u32>,
    #[serde(default)]
    grid_items_positioning: Option<String>,
    #[serde(default)]
    grid_row_anchor: Option<u32>,
    #[serde(default)]
    grid_column_anchor: Option<u32>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionGridTrack {
    r#type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    value: Option<f64>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum ProjectionParametricShape {
    Polygon {
        #[serde(rename = "pointCount")]
        point_count: u32,
    },
    Star {
        #[serde(rename = "pointCount")]
        point_count: u32,
        #[serde(rename = "innerRatio")]
        inner_ratio: f64,
    },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionVectorPath {
    fill_rule: String,
    subpaths: Vec<ProjectionVectorSubpath>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionVectorSubpath {
    closed: bool,
    points: Vec<ProjectionVectorPoint>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionVectorPoint {
    id: String,
    x: f64,
    y: f64,
    #[serde(default)]
    handle_in: Option<ProjectionVectorHandle>,
    #[serde(default)]
    handle_out: Option<ProjectionVectorHandle>,
    point_type: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct ProjectionVectorHandle {
    x: f64,
    y: f64,
}

#[derive(Clone, Serialize, Deserialize)]
struct ProjectionTransform {
    a: f64,
    b: f64,
    c: f64,
    d: f64,
    e: f64,
    f: f64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionConstraints {
    horizontal: String,
    vertical: String,
}

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
    #[serde(default)]
    color: Option<ProjectionColor>,
    #[serde(default)]
    fill_stack: Option<ProjectionPaintStack>,
    #[serde(default)]
    text_case: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hyperlink: Option<ProjectionHyperlinkTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text_decoration: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text_decoration_style: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text_decoration_offset: Option<ProjectionTextDecorationOffset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text_decoration_thickness: Option<ProjectionTextDecorationThickness>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text_decoration_color: Option<ProjectionTextDecorationColor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text_decoration_skip_ink: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    leading_trim: Option<String>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    open_type_features: std::collections::BTreeMap<String, bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text_style_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    paint_style_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    variable_bindings: Option<Box<std::collections::BTreeMap<String, String>>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionHyperlinkTarget {
    r#type: String,
    value: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionTextStyle {
    #[serde(default)]
    font: Option<ProjectionFontReference>,
    font_size: f64,
    font_weight: u16,
    italic: bool,
    letter_spacing: f64,
    #[serde(default)]
    color: Option<ProjectionColor>,
    #[serde(default)]
    fill_stack: Option<ProjectionPaintStack>,
    #[serde(default)]
    text_case: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hyperlink: Option<ProjectionHyperlinkTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text_decoration: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text_decoration_style: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text_decoration_offset: Option<ProjectionTextDecorationOffset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text_decoration_thickness: Option<ProjectionTextDecorationThickness>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text_decoration_color: Option<ProjectionTextDecorationColor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text_decoration_skip_ink: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    leading_trim: Option<String>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    open_type_features: std::collections::BTreeMap<String, bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text_style_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    paint_style_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    variable_bindings: Option<Box<std::collections::BTreeMap<String, String>>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionTextStyleResource {
    id: String,
    #[serde(default)]
    key: String,
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    description_markdown: String,
    #[serde(default)]
    documentation_links: Vec<ProjectionDocumentationLink>,
    #[serde(default)]
    remote: bool,
    style: ProjectionTextStyle,
    #[serde(default)]
    letter_spacing_unit: Option<ProjectionTextStyleLetterSpacingUnit>,
    #[serde(default)]
    variable_bindings: BTreeMap<String, String>,
    paragraph: ProjectionParagraphStyle,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ProjectionTextStyleLetterSpacingUnit {
    Percent,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionPaintStyleResource {
    id: String,
    #[serde(default)]
    key: String,
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    description_markdown: String,
    #[serde(default)]
    documentation_links: Vec<ProjectionDocumentationLink>,
    #[serde(default)]
    remote: bool,
    paints: ProjectionPaintStack,
    #[serde(default)]
    variable_bindings: Vec<ProjectionPaintStyleVariableBinding>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionPaintStyleVariableBinding {
    paint_index: u32,
    #[serde(default)]
    stop_index: Option<u32>,
    variable_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionDocumentationLink {
    uri: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionVariableMode {
    mode_id: String,
    name: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionVariableCollectionResource {
    id: String,
    #[serde(default)]
    key: String,
    name: String,
    #[serde(default)]
    remote: bool,
    #[serde(default)]
    hidden_from_publishing: bool,
    modes: Vec<ProjectionVariableMode>,
    default_mode_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionVariableAlias {
    r#type: String,
    id: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(untagged)]
enum ProjectionVariableValue {
    Boolean(bool),
    Float(f64),
    String(String),
    Color(ProjectionColor),
    Alias(ProjectionVariableAlias),
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionVariableResource {
    id: String,
    #[serde(default)]
    key: String,
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    remote: bool,
    #[serde(default)]
    hidden_from_publishing: bool,
    collection_id: String,
    resolved_type: String,
    values_by_mode: std::collections::BTreeMap<String, ProjectionVariableValue>,
    #[serde(default)]
    scopes: Vec<String>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    code_syntax: std::collections::BTreeMap<String, String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionTextDecorationOffset {
    value: f64,
    unit: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionTextDecorationThickness {
    value: f64,
    unit: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionTextDecorationColor {
    color: ProjectionColor,
    visible: bool,
    opacity: f32,
    blend_mode: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionParagraphStyle {
    alignment: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    line_height: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    line_height_unit: Option<String>,
    paragraph_spacing: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    paragraph_indent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text_wrap_style: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    list_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    list_spacing: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hanging_list: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hanging_punctuation: Option<bool>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionParagraphStyleRun {
    start: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    indentation: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    list_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    list_spacing: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    paragraph_spacing: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    paragraph_indent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    line_height: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    line_height_unit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text_wrap_style: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionTextProperties {
    #[serde(default)]
    runs: Vec<ProjectionTextStyleRun>,
    paragraph: ProjectionParagraphStyle,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    paragraph_style_runs: Vec<ProjectionParagraphStyleRun>,
    auto_size: String,
    #[serde(default)]
    fallback_fonts: Vec<ProjectionFontReference>,
    #[serde(default)]
    text_truncation: Option<String>,
    #[serde(default)]
    max_lines: Option<u32>,
    #[serde(default)]
    base_style: Option<Box<ProjectionTextStyle>>,
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
struct ProjectionDropShadow {
    offset_x: f64,
    offset_y: f64,
    blur_radius: f64,
    spread: f64,
    color: ProjectionColor,
    visible: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionLayerBlur {
    radius: f64,
    visible: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionInnerShadow {
    offset_x: f64,
    offset_y: f64,
    blur_radius: f64,
    spread: f64,
    color: ProjectionColor,
    visible: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionBackgroundBlur {
    radius: f64,
    visible: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ProjectionEffect {
    DropShadow(ProjectionDropShadow),
    LayerBlur(ProjectionLayerBlur),
    InnerShadow(ProjectionInnerShadow),
    BackgroundBlur(ProjectionBackgroundBlur),
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
    #[serde(default)]
    gradient_paint: Option<ProjectionGradientPaint>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionPaintStack {
    layers: Vec<ProjectionPaintLayer>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionPaintLayer {
    #[serde(default)]
    paint: Option<ProjectionPaint>,
    #[serde(default)]
    image: Option<ProjectionImagePaint>,
    visible: bool,
    opacity: f32,
    blend_mode: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionImagePaint {
    asset_id: String,
    scale_mode: String,
    transform: ProjectionTransform,
    #[serde(default)]
    rotation_degrees: i16,
    #[serde(default)]
    filters: Option<ProjectionImageFilters>,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionImageFilters {
    #[serde(default)]
    exposure: Option<f32>,
    #[serde(default)]
    contrast: Option<f32>,
    #[serde(default)]
    saturation: Option<f32>,
    #[serde(default)]
    temperature: Option<f32>,
    #[serde(default)]
    tint: Option<f32>,
    #[serde(default)]
    highlights: Option<f32>,
    #[serde(default)]
    shadows: Option<f32>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionGradientPaint {
    kind: String,
    transform: ProjectionTransform,
    stops: Vec<ProjectionGradientStop>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionGradientStop {
    position: f32,
    color: ProjectionColor,
}

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum BatchCommand {
    CreatePage {
        page: ProjectionPage,
    },
    RegisterAsset {
        asset: ProjectionAsset,
    },
    RegisterTextStyle {
        style: ProjectionTextStyleResource,
    },
    RegisterPaintStyle {
        style: ProjectionPaintStyleResource,
    },
    SetTextStyle {
        style: ProjectionTextStyleResource,
    },
    DeleteTextStyle {
        id: String,
    },
    SetPaintStyle {
        style: ProjectionPaintStyleResource,
    },
    DeletePaintStyle {
        id: String,
    },
    RegisterVariableCollection {
        collection: ProjectionVariableCollectionResource,
    },
    RegisterVariable {
        variable: ProjectionVariableResource,
    },
    SetVariable {
        variable: ProjectionVariableResource,
    },
    DeleteVariable {
        id: String,
    },
    SetVariableCollection {
        collection: ProjectionVariableCollectionResource,
        variables: Vec<ProjectionVariableResource>,
    },
    DeleteVariableCollection {
        id: String,
    },
    Create {
        node: ProjectionNode,
    },
    Restore {
        node: ProjectionNode,
    },
    ConvertToTextPath {
        node: ProjectionNode,
    },
    Update {
        node: ProjectionNode,
        #[serde(default)]
        ignore_constraints: bool,
        #[serde(default)]
        plain_text_only: bool,
        #[serde(default)]
        rename_text_path: bool,
    },
    MoveVectorPoint {
        id: String,
        point_id: String,
        x: f64,
        y: f64,
    },
    SetVectorSubpathClosed {
        id: String,
        subpath_index: u32,
        closed: bool,
    },
    InsertVectorPoint {
        id: String,
        subpath_index: u32,
        after_point_id: Option<String>,
        point: ProjectionVectorPoint,
    },
    SplitVectorSegment {
        id: String,
        subpath_index: u32,
        after_point_id: String,
        t: f64,
        point_id: String,
    },
    ConnectVectorEndpoints {
        id: String,
        first_subpath_index: u32,
        first_point_id: String,
        second_subpath_index: u32,
        second_point_id: String,
    },
    SetMask {
        id: String,
        enabled: bool,
    },
    SetExtensions {
        id: String,
        extensions: std::collections::BTreeMap<String, Vec<u8>>,
    },
    DeleteVectorPoint {
        id: String,
        point_id: String,
    },
    SetVectorPointHandles {
        id: String,
        point_id: String,
        handle_in: Option<ProjectionVectorHandle>,
        handle_out: Option<ProjectionVectorHandle>,
        point_type: String,
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

    /// Sets the document identity before legacy projection hydration. The old
    /// browser path serialized and reparsed the entire hydrated document only
    /// to replace this field, doubling the live 100k-node state at peak.
    #[wasm_bindgen]
    pub fn seed_document_id(&mut self, document_id: &str) -> Result<(), JsValue> {
        let id = parse_document_id(document_id)?;
        if !self.document.seed_document_id(id) {
            return Err(JsValue::from_str("DOCUMENT_ID_SEED_AFTER_HYDRATION"));
        }
        Ok(())
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
        makefigma_document_codec::snapshot_from_document(
            &self.document,
            makefigma_document_codec::CURRENT_ENGINE_SEMANTICS_VERSION,
        )
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
        let schema_version = if self.document.nodes().any(|node| {
            let layout = self.document.auto_layout_for_node(node.id);
            layout.grid_items_positioning == GridItemsPositioning::Manual
                || layout.grid_row_anchor.is_some()
                || layout.grid_column_anchor.is_some()
        }) {
            73
        } else if self.document.nodes().any(|node| {
            let layout = self.document.auto_layout_for_node(node.id);
            layout.grid_row_span.is_some() || layout.grid_column_span.is_some()
        }) {
            72
        } else if self.document.nodes().any(|node| {
            let layout = self.document.auto_layout_for_node(node.id);
            layout
                .grid_rows
                .iter()
                .chain(&layout.grid_columns)
                .any(|track| matches!(track, GridTrack::Hug))
        }) {
            71
        } else if self
            .document
            .nodes()
            .any(|node| self.document.auto_layout_for_node(node.id).mode == LayoutMode::Grid)
        {
            70
        } else if self.document.nodes().any(|node| {
            self.document
                .text_properties_for_node(node.id)
                .is_some_and(|properties| {
                    properties
                        .runs
                        .iter()
                        .any(|run| !run.variable_bindings.is_empty())
                        || properties
                            .base_style
                            .as_ref()
                            .is_some_and(|style| !style.variable_bindings.is_empty())
                })
        }) {
            69
        } else if self
            .document
            .paint_styles()
            .any(|style| !style.variable_bindings.is_empty())
        {
            68
        } else if self
            .document
            .text_styles()
            .any(|style| !style.variable_bindings.is_empty())
        {
            67
        } else if self
            .document
            .text_styles()
            .any(|style| style.letter_spacing_unit == Some(TextStyleLetterSpacingUnit::Percent))
        {
            66
        } else if self.document.text_styles().any(|style| {
            !style.description_markdown.is_empty() || !style.documentation_links.is_empty()
        }) || self.document.paint_styles().any(|style| {
            !style.description_markdown.is_empty() || !style.documentation_links.is_empty()
        }) {
            65
        } else if self
            .document
            .variables()
            .any(|variable| !variable.code_syntax.is_empty())
        {
            64
        } else if self.document.variable_collections().next().is_some()
            || self.document.variables().next().is_some()
        {
            63
        } else if self.document.nodes().any(|node| {
            self.document
                .text_properties_for_node(node.id)
                .is_some_and(|properties| {
                    properties
                        .runs
                        .iter()
                        .any(|run| run.paint_style_id.is_some())
                        || properties
                            .base_style
                            .as_ref()
                            .is_some_and(|style| style.paint_style_id.is_some())
                })
        }) {
            62
        } else if self
            .document
            .nodes()
            .any(|node| self.document.paint_style_links_for_node(node.id).is_some())
        {
            61
        } else if self.document.paint_styles().next().is_some() {
            60
        } else if self.document.text_styles().next().is_some() {
            59
        } else if self.document.nodes().any(|node| {
            self.document
                .text_properties_for_node(node.id)
                .is_some_and(|properties| {
                    properties
                        .runs
                        .iter()
                        .any(|run| run.text_style_id.is_some())
                        || properties
                            .base_style
                            .as_ref()
                            .is_some_and(|style| style.text_style_id.is_some())
                })
        }) {
            58
        } else if self.document.nodes().any(|node| {
            self.document
                .text_properties_for_node(node.id)
                .is_some_and(|properties| {
                    properties
                        .runs
                        .iter()
                        .any(|run| !run.open_type_features.is_empty())
                        || properties
                            .base_style
                            .as_ref()
                            .is_some_and(|style| !style.open_type_features.is_empty())
                })
        }) {
            57
        } else if self
            .document
            .assets()
            .any(|asset| asset.font_faces.iter().any(|face| !face.aliases.is_empty()))
        {
            56
        } else if self
            .document
            .assets()
            .any(|asset| !asset.font_faces.is_empty())
        {
            55
        } else if self.document.nodes().any(|node| {
            self.document
                .text_properties_for_node(node.id)
                .is_some_and(|properties| {
                    properties
                        .paragraph_style_runs
                        .iter()
                        .any(|run| run.text_wrap_style.is_some())
                })
        }) {
            54
        } else if self.document.nodes().any(|node| {
            self.document
                .text_properties_for_node(node.id)
                .is_some_and(|properties| properties.paragraph.hanging_punctuation)
        }) {
            53
        } else if self.document.nodes().any(|node| {
            self.document
                .text_properties_for_node(node.id)
                .is_some_and(|properties| {
                    properties
                        .paragraph_style_runs
                        .iter()
                        .any(|run| run.line_height.is_some() || run.line_height_unit.is_some())
                })
        }) {
            52
        } else if self.document.nodes().any(|node| {
            self.document
                .text_properties_for_node(node.id)
                .is_some_and(|properties| {
                    properties
                        .paragraph_style_runs
                        .iter()
                        .any(|run| run.paragraph_indent.is_some())
                })
        }) {
            51
        } else if self.document.nodes().any(|node| {
            self.document
                .text_properties_for_node(node.id)
                .is_some_and(|properties| {
                    properties
                        .paragraph_style_runs
                        .iter()
                        .any(|run| run.paragraph_spacing.is_some())
                })
        }) {
            50
        } else if self.document.nodes().any(|node| {
            self.document
                .text_properties_for_node(node.id)
                .is_some_and(|properties| {
                    properties
                        .paragraph_style_runs
                        .iter()
                        .any(|run| run.list_spacing.is_some())
                })
        }) {
            49
        } else if self.document.nodes().any(|node| {
            self.document
                .text_properties_for_node(node.id)
                .is_some_and(|properties| {
                    properties
                        .paragraph_style_runs
                        .iter()
                        .any(|run| run.list_type.is_some())
                })
        }) {
            48
        } else if self.document.nodes().any(|node| {
            self.document
                .text_properties_for_node(node.id)
                .is_some_and(|properties| properties.paragraph.hanging_list)
        }) {
            47
        } else if self.document.nodes().any(|node| {
            self.document
                .text_properties_for_node(node.id)
                .is_some_and(|properties| !properties.paragraph_style_runs.is_empty())
        }) {
            46
        } else if self.document.nodes().any(|node| {
            self.document
                .text_properties_for_node(node.id)
                .is_some_and(|properties| properties.paragraph.list_spacing.is_some())
        }) {
            45
        } else if self.document.nodes().any(|node| {
            self.document
                .text_properties_for_node(node.id)
                .is_some_and(|properties| properties.paragraph.list_type.is_some())
        }) {
            44
        } else if self.document.nodes().any(|node| {
            self.document
                .text_properties_for_node(node.id)
                .is_some_and(|properties| {
                    properties.runs.iter().any(|run| run.leading_trim.is_some())
                        || properties
                            .base_style
                            .as_ref()
                            .is_some_and(|style| style.leading_trim.is_some())
                })
        }) {
            43
        } else if self.document.nodes().any(|node| {
            self.document
                .text_properties_for_node(node.id)
                .is_some_and(|properties| {
                    properties
                        .runs
                        .iter()
                        .any(|run| run.text_decoration_skip_ink == Some(true))
                        || properties
                            .base_style
                            .as_ref()
                            .is_some_and(|style| style.text_decoration_skip_ink == Some(true))
                })
        }) {
            42
        } else if self.document.nodes().any(|node| {
            self.document
                .text_properties_for_node(node.id)
                .is_some_and(|properties| {
                    properties
                        .runs
                        .iter()
                        .any(|run| run.text_decoration_color.is_some())
                        || properties
                            .base_style
                            .as_ref()
                            .is_some_and(|style| style.text_decoration_color.is_some())
                })
        }) {
            41
        } else if self.document.nodes().any(|node| {
            self.document
                .text_properties_for_node(node.id)
                .is_some_and(|properties| {
                    properties
                        .runs
                        .iter()
                        .any(|run| run.text_decoration_thickness.is_some())
                        || properties
                            .base_style
                            .as_ref()
                            .is_some_and(|style| style.text_decoration_thickness.is_some())
                })
        }) {
            40
        } else if self.document.nodes().any(|node| {
            self.document
                .text_properties_for_node(node.id)
                .is_some_and(|properties| {
                    properties
                        .runs
                        .iter()
                        .any(|run| run.text_decoration_offset.is_some())
                        || properties
                            .base_style
                            .as_ref()
                            .is_some_and(|style| style.text_decoration_offset.is_some())
                })
        }) {
            39
        } else if self.document.nodes().any(|node| {
            self.document
                .text_properties_for_node(node.id)
                .is_some_and(|properties| {
                    properties
                        .runs
                        .iter()
                        .any(|run| run.text_decoration_style.is_some())
                        || properties
                            .base_style
                            .as_ref()
                            .is_some_and(|style| style.text_decoration_style.is_some())
                })
        }) {
            38
        } else if self.document.nodes().any(|node| {
            self.document
                .text_properties_for_node(node.id)
                .is_some_and(|properties| {
                    properties
                        .runs
                        .iter()
                        .any(|run| run.text_decoration.is_some())
                        || properties
                            .base_style
                            .as_ref()
                            .is_some_and(|style| style.text_decoration.is_some())
                })
        }) {
            37
        } else if self.document.nodes().any(|node| {
            self.document
                .text_properties_for_node(node.id)
                .is_some_and(|properties| {
                    properties.runs.iter().any(|run| run.hyperlink.is_some())
                        || properties
                            .base_style
                            .as_ref()
                            .is_some_and(|style| style.hyperlink.is_some())
                })
        }) {
            36
        } else if self.document.nodes().any(|node| {
            self.document
                .text_properties_for_node(node.id)
                .is_some_and(|properties| properties.paragraph.text_wrap_style.is_some())
        }) {
            35
        } else if self.document.nodes().any(|node| {
            self.document
                .text_properties_for_node(node.id)
                .is_some_and(|properties| properties.paragraph.paragraph_indent.is_some())
        }) {
            34
        } else if self.document.nodes().any(|node| {
            self.document
                .text_properties_for_node(node.id)
                .is_some_and(|properties| properties.paragraph.line_height_unit.is_some())
        }) {
            33
        } else {
            32
        };
        let snapshot = CoreSnapshot {
            schema_version,
            document_id: format_document_id(self.document.id()),
            revision: self.document.revision,
            can_undo: self.document.can_undo(),
            can_redo: self.document.can_redo(),
            canonical_hash: self.document.canonical_hash_hex(),
            color_profile: format_document_color_profile(self.document.color_profile()),
            pages: Some(self.document.pages().map(projection_page).collect()),
            resource_index: Some(self.document.assets().map(projection_asset).collect()),
            text_styles: Some(
                self.document
                    .text_styles()
                    .map(projection_text_style_resource)
                    .collect(),
            ),
            paint_styles: Some(
                self.document
                    .paint_styles()
                    .map(projection_paint_style_resource)
                    .collect(),
            ),
            variable_collections: Some(
                self.document
                    .variable_collections()
                    .map(projection_variable_collection)
                    .collect(),
            ),
            variables: Some(
                self.document
                    .variables()
                    .map(projection_variable_resource)
                    .collect(),
            ),
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
                        self.document.auto_layout_for_node(node.id),
                        self.document.fill_stack_for_node(node.id),
                        self.document.stroke_stack_for_node(node.id),
                        self.document.paint_style_links_for_node(node.id),
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
                        // Canvas owns generated parametric outlines until the
                        // GPU path gains matching primitive representations.
                        NodeKind::Polygon | NodeKind::Star => {
                            makefigma_renderer_wgpu::SceneNodeKind::Group
                        }
                        NodeKind::Vector => makefigma_renderer_wgpu::SceneNodeKind::Group,
                        NodeKind::BooleanOperation => makefigma_renderer_wgpu::SceneNodeKind::Group,
                        NodeKind::Slice => makefigma_renderer_wgpu::SceneNodeKind::Group,
                        NodeKind::CodeBlock => makefigma_renderer_wgpu::SceneNodeKind::Group,
                        NodeKind::Component => makefigma_renderer_wgpu::SceneNodeKind::Frame,
                        NodeKind::Instance => makefigma_renderer_wgpu::SceneNodeKind::Frame,
                        NodeKind::Slot => makefigma_renderer_wgpu::SceneNodeKind::Frame,
                        NodeKind::ComponentSet => makefigma_renderer_wgpu::SceneNodeKind::Frame,
                        NodeKind::Connector => makefigma_renderer_wgpu::SceneNodeKind::Line,
                        NodeKind::Embed => makefigma_renderer_wgpu::SceneNodeKind::Rectangle,
                        NodeKind::Highlight => makefigma_renderer_wgpu::SceneNodeKind::Rectangle,
                        NodeKind::InteractiveSlideElement => {
                            makefigma_renderer_wgpu::SceneNodeKind::Rectangle
                        }
                        NodeKind::LinkUnfurl => makefigma_renderer_wgpu::SceneNodeKind::Rectangle,
                        NodeKind::Media => makefigma_renderer_wgpu::SceneNodeKind::Image,
                        NodeKind::ShapeWithText => {
                            makefigma_renderer_wgpu::SceneNodeKind::Rectangle
                        }
                        NodeKind::SlideGrid => makefigma_renderer_wgpu::SceneNodeKind::Group,
                        NodeKind::Slide => makefigma_renderer_wgpu::SceneNodeKind::Frame,
                        NodeKind::SlideRow => makefigma_renderer_wgpu::SceneNodeKind::Group,
                        NodeKind::Stamp => makefigma_renderer_wgpu::SceneNodeKind::Ellipse,
                        NodeKind::Sticky => makefigma_renderer_wgpu::SceneNodeKind::Rectangle,
                        NodeKind::Table => makefigma_renderer_wgpu::SceneNodeKind::Group,
                        NodeKind::TableCell => makefigma_renderer_wgpu::SceneNodeKind::Rectangle,
                        NodeKind::TextPath => makefigma_renderer_wgpu::SceneNodeKind::Text,
                        NodeKind::TransformGroup => makefigma_renderer_wgpu::SceneNodeKind::Group,
                        NodeKind::WashiTape => makefigma_renderer_wgpu::SceneNodeKind::Rectangle,
                        NodeKind::Widget => makefigma_renderer_wgpu::SceneNodeKind::Rectangle,
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
                if matches!(
                    node.kind,
                    NodeKind::Polygon | NodeKind::Star | NodeKind::Vector
                ) {
                    return None;
                }
                let (Paint::Solid(fill), Paint::Solid(stroke)) = (&node.fill, &node.stroke) else {
                    return None;
                };
                let stroke_rgba = css_executor_rgba(*stroke, node.opacity);
                if matches!(node.kind, NodeKind::Frame | NodeKind::Rectangle)
                    && (!node.stroke_weights.is_empty()
                        || !node.corner_radii.is_empty()
                        || node.corner_smoothing != 0.0)
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
                        NodeKind::Polygon | NodeKind::Star => {
                            unreachable!("parametric shapes use Canvas fallback")
                        }
                        NodeKind::Vector => unreachable!("Vector paths use Canvas fallback"),
                        NodeKind::BooleanOperation => {
                            unreachable!("Boolean paths use Canvas fallback")
                        }
                        NodeKind::Slice => unreachable!("Slice never paints"),
                        NodeKind::CodeBlock => unreachable!("Code blocks use Canvas fallback"),
                        NodeKind::Component => makefigma_renderer_wgpu::SceneNodeKind::Frame,
                        NodeKind::Instance => makefigma_renderer_wgpu::SceneNodeKind::Frame,
                        NodeKind::Slot => makefigma_renderer_wgpu::SceneNodeKind::Frame,
                        NodeKind::ComponentSet => makefigma_renderer_wgpu::SceneNodeKind::Frame,
                        NodeKind::Connector => makefigma_renderer_wgpu::SceneNodeKind::Line,
                        NodeKind::Embed => makefigma_renderer_wgpu::SceneNodeKind::Rectangle,
                        NodeKind::Highlight => makefigma_renderer_wgpu::SceneNodeKind::Rectangle,
                        NodeKind::InteractiveSlideElement => {
                            makefigma_renderer_wgpu::SceneNodeKind::Rectangle
                        }
                        NodeKind::LinkUnfurl => makefigma_renderer_wgpu::SceneNodeKind::Rectangle,
                        NodeKind::Media => makefigma_renderer_wgpu::SceneNodeKind::Image,
                        NodeKind::ShapeWithText => {
                            makefigma_renderer_wgpu::SceneNodeKind::Rectangle
                        }
                        NodeKind::SlideGrid => makefigma_renderer_wgpu::SceneNodeKind::Group,
                        NodeKind::Slide => makefigma_renderer_wgpu::SceneNodeKind::Frame,
                        NodeKind::SlideRow => makefigma_renderer_wgpu::SceneNodeKind::Group,
                        NodeKind::Stamp => makefigma_renderer_wgpu::SceneNodeKind::Ellipse,
                        NodeKind::Sticky => makefigma_renderer_wgpu::SceneNodeKind::Rectangle,
                        NodeKind::Table => makefigma_renderer_wgpu::SceneNodeKind::Group,
                        NodeKind::TableCell => makefigma_renderer_wgpu::SceneNodeKind::Rectangle,
                        NodeKind::TextPath => makefigma_renderer_wgpu::SceneNodeKind::Text,
                        NodeKind::TransformGroup => makefigma_renderer_wgpu::SceneNodeKind::Group,
                        NodeKind::WashiTape => makefigma_renderer_wgpu::SceneNodeKind::Rectangle,
                        NodeKind::Widget => makefigma_renderer_wgpu::SceneNodeKind::Rectangle,
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
        font_faces_json: &str,
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
            font_faces: serde_json::from_str(font_faces_json)
                .map_err(|_| JsValue::from_str("INVALID_ASSET_REFERENCE"))?,
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
        validate_core_snapshot_version(&snapshot).map_err(JsValue::from_str)?;
        let mut document = Document::with_id(parse_document_id(&snapshot.document_id)?);
        document.seed_color_profile(parse_document_color_profile(&snapshot.color_profile)?);
        for page in snapshot.pages.clone().unwrap_or_default() {
            let page = page_from_projection(page)?;
            if page.id == DEFAULT_PAGE_ID {
                document.seed_default_page(page).map_err(core_error)?;
            } else {
                document.seed_page(page).map_err(core_error)?;
            }
        }
        for asset in snapshot.resource_index.clone().unwrap_or_default() {
            document
                .seed_asset(asset_from_projection(asset)?)
                .map_err(core_error)?;
        }
        for collection in snapshot.variable_collections.clone().unwrap_or_default() {
            document
                .seed_variable_collection(variable_collection_from_projection(&collection)?)
                .map_err(core_error)?;
        }
        for variable in snapshot.variables.clone().unwrap_or_default() {
            document
                .seed_variable(variable_resource_from_projection(&variable)?)
                .map_err(core_error)?;
        }
        document.validate_variable_catalog().map_err(core_error)?;
        for style in snapshot.text_styles.clone().unwrap_or_default() {
            document
                .seed_text_style(text_style_resource_from_projection(&style)?)
                .map_err(core_error)?;
        }
        for style in snapshot.paint_styles.clone().unwrap_or_default() {
            document
                .seed_paint_style(paint_style_resource_from_projection(&style)?)
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
            let auto_layout = auto_layout_from_projection(node.auto_layout.as_ref())?;
            let fill_stack = node
                .fill_stack
                .as_ref()
                .map(paint_stack_from_projection)
                .transpose()?;
            let stroke_stack = node
                .stroke_stack
                .as_ref()
                .map(paint_stack_from_projection)
                .transpose()?;
            let paint_style_links = paint_style_links_from_projection(&node);
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
            document
                .seed_auto_layout(node_id, auto_layout)
                .map_err(core_error)?;
            document
                .seed_paint_stacks(node_id, fill_stack, stroke_stack)
                .map_err(core_error)?;
            document
                .seed_paint_style_links(node_id, paint_style_links)
                .map_err(core_error)?;
        }
        for id in snapshot.retired_ids.clone().unwrap_or_default() {
            document
                .seed_retired_id(parse_id(&id)?)
                .map_err(core_error)?;
        }
        document.validate_seeded_structure().map_err(core_error)?;
        document.revision = snapshot.revision;
        // Schema v1 predates tombstones, v2 canonical text, v3 canonical color, v4
        // Canonical sibling positions, v6 DocumentColorProfile, v7 Paint, v8
        // rotation, v9 stroke, v10 Document/Page ownership, v11 stable
        // DocumentId, v12 Resource Index, v13 node-level AssetId references, and
        // v14 canonical rich text properties, v15 image fills on regular
        // shape nodes (both use the existing node-level AssetId field).
        // v16 adds StrokeCap endpoint semantics to open paths, v17 adds
        // independent TL/TR/BR/BL corner radii, v18 adds continuous corner
        // smoothing, v19 adds ordered fill/stroke stacks, v20 adds Auto Layout,
        // v21 adds an optional child cross-axis alignment override, v22 carries
        // presence-bearing Paint Stacks, and v23 preserves ImagePaint rotation.
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
        // A Canonical batch defers `SetMask` until every sibling has been
        // created. Preserve that ordering during one-time hydration too: Core
        // validates a mask source against its following sibling, while the
        // seed API deliberately remains history-free.
        let mut deferred_masks = Vec::new();
        for command in batch {
            match command {
                BatchCommand::Create { node } => {
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
                    let text_properties =
                        text_properties_from_projection(node.text_properties.as_ref())?;
                    let auto_layout = auto_layout_from_projection(node.auto_layout.as_ref())?;
                    let fill_stack = node
                        .fill_stack
                        .as_ref()
                        .map(paint_stack_from_projection)
                        .transpose()?;
                    let stroke_stack = node
                        .stroke_stack
                        .as_ref()
                        .map(paint_stack_from_projection)
                        .transpose()?;
                    let paint_style_links = paint_style_links_from_projection(&node);
                    let node = node_from_projection(node)?;
                    let node_id = node.id;
                    if let Some(asset_id) = asset_id {
                        self.document
                            .seed_image_node_on_page(page_id, node, asset_id)
                    } else {
                        self.document.seed_node_on_page(page_id, node)
                    }
                    .map_err(core_error)?;
                    if let Some(properties) = text_properties {
                        self.document
                            .seed_text_properties(node_id, properties)
                            .map_err(core_error)?;
                    }
                    self.document
                        .seed_auto_layout(node_id, auto_layout)
                        .map_err(core_error)?;
                    self.document
                        .seed_paint_stacks(node_id, fill_stack, stroke_stack)
                        .map_err(core_error)?;
                    self.document
                        .seed_paint_style_links(node_id, paint_style_links)
                        .map_err(core_error)?;
                }
                BatchCommand::SetMask { id, enabled } => {
                    deferred_masks.push((parse_id(&id)?, enabled));
                }
                BatchCommand::CreatePage { .. }
                | BatchCommand::RegisterAsset { .. }
                | BatchCommand::RegisterTextStyle { .. }
                | BatchCommand::RegisterPaintStyle { .. }
                | BatchCommand::SetTextStyle { .. }
                | BatchCommand::DeleteTextStyle { .. }
                | BatchCommand::SetPaintStyle { .. }
                | BatchCommand::DeletePaintStyle { .. }
                | BatchCommand::RegisterVariableCollection { .. }
                | BatchCommand::RegisterVariable { .. }
                | BatchCommand::SetVariable { .. }
                | BatchCommand::DeleteVariable { .. }
                | BatchCommand::SetVariableCollection { .. }
                | BatchCommand::DeleteVariableCollection { .. }
                | BatchCommand::Update { .. }
                | BatchCommand::Restore { .. }
                | BatchCommand::ConvertToTextPath { .. }
                | BatchCommand::MoveVectorPoint { .. }
                | BatchCommand::SetVectorSubpathClosed { .. }
                | BatchCommand::InsertVectorPoint { .. }
                | BatchCommand::SplitVectorSegment { .. }
                | BatchCommand::ConnectVectorEndpoints { .. }
                | BatchCommand::DeleteVectorPoint { .. }
                | BatchCommand::SetVectorPointHandles { .. }
                | BatchCommand::SetExtensions { .. }
                | BatchCommand::Reposition { .. }
                | BatchCommand::Reparent { .. }
                | BatchCommand::Delete { .. } => {
                    return Err(JsValue::from_str("INVALID_SEED_BATCH"));
                }
            }
        }
        // A seed batch is the one-time creation path for fixtures and legacy
        // projections. It has no user transaction, so explicitly run the same
        // deterministic placement pass after all nested Frame layouts exist.
        self.document
            .reflow_seeded_auto_layout()
            .map_err(core_error)?;
        for (id, enabled) in deferred_masks {
            self.document.seed_mask(id, enabled).map_err(core_error)?;
        }
        self.document
            .validate_seeded_structure()
            .map_err(core_error)?;
        Ok(self.document.revision)
    }

    /// Adds trusted legacy fixture metadata before `seed_batch_json` installs
    /// image or font references. Bytes are deliberately not accepted here.
    #[wasm_bindgen]
    pub fn seed_assets_json(&mut self, value: &str) -> Result<(), JsValue> {
        let assets = serde_json::from_str::<Vec<ProjectionAsset>>(value)
            .map_err(|_| JsValue::from_str("INVALID_SEED_ASSETS"))?;
        for asset in assets {
            self.document
                .seed_asset(asset_from_projection(asset)?)
                .map_err(core_error)?;
        }
        Ok(())
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

    /// Creates a Page at an explicit Canonical PositionId. REST imports use
    /// this path so their source order is not replaced by ID-derived order in
    /// the browser before the equivalent protobuf operation reaches Service.
    #[wasm_bindgen]
    pub fn create_page_at_position(
        &mut self,
        transaction_id: &str,
        base_revision: u64,
        page_id: &str,
        name: &str,
        position_id: &str,
    ) -> Result<u64, JsValue> {
        self.submit_create_page(
            parse_id(transaction_id)?,
            base_revision,
            Page {
                id: parse_page_id(page_id)?,
                name: name.into(),
                position: parse_position_id(position_id)?,
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
        let node_kind = parse_kind(kind)?;
        let node = Node {
            id: parse_id(node_id)?,
            parent_id: None,
            position: PositionId::for_node(parse_id(node_id)?),
            name: name.into(),
            kind: node_kind.clone(),
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
            parametric_shape: default_parametric_shape(&node_kind),
            vector_path: None,
            boolean_operation: default_boolean_operation(&node_kind),
            relative_transform: None,
            opacity,
            blend_mode: BlendMode::Normal,
            drop_shadow: None,
            effect_stack: Vec::new(),
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
        let node_kind = parse_kind(kind)?;
        let node = Node {
            id: node_id,
            parent_id: None,
            position: PositionId::for_node(node_id),
            name: name.into(),
            kind: node_kind.clone(),
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
            parametric_shape: default_parametric_shape(&node_kind),
            vector_path: None,
            boolean_operation: default_boolean_operation(&node_kind),
            relative_transform: None,
            opacity,
            blend_mode: BlendMode::Normal,
            drop_shadow: None,
            effect_stack: Vec::new(),
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
        let node_kind = parse_kind(kind)?;
        let node = Node {
            id: parse_id(node_id)?,
            parent_id: None,
            position: PositionId::for_node(parse_id(node_id)?),
            name: name.into(),
            kind: node_kind.clone(),
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
            parametric_shape: default_parametric_shape(&node_kind),
            vector_path: None,
            boolean_operation: default_boolean_operation(&node_kind),
            relative_transform: None,
            opacity,
            blend_mode: BlendMode::Normal,
            drop_shadow: None,
            effect_stack: Vec::new(),
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
                parametric_shape: None,
                relative_transform: None,
                opacity,
                blend_mode: BlendMode::Normal,
                drop_shadow: None,
                effect_stack: Vec::new(),
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

    /// Executes a resize-shaped Update batch against a structurally shared,
    /// disposable document and returns only the nodes changed by Core. The live
    /// document's revision, history and operation-dedupe state remain untouched.
    /// The Engine Worker uses this during pointer movement so the transient
    /// Frame/child geometry is produced by the same reducer as pointer-up.
    #[wasm_bindgen]
    pub fn preview_resize_transaction_json(
        &self,
        transaction_id: &str,
        commands_json: &str,
    ) -> Result<String, JsValue> {
        let commands = serde_json::from_str::<Vec<BatchCommand>>(commands_json)
            .map_err(|_| JsValue::from_str("INVALID_PREVIEW_TRANSACTION"))?;
        if commands.is_empty()
            || !commands
                .iter()
                .all(|command| matches!(command, BatchCommand::Update { .. }))
        {
            return Err(JsValue::from_str("INVALID_PREVIEW_TRANSACTION"));
        }

        let mut preview = Self {
            document: self.document.clone(),
        };
        preview.submit_batch(parse_id(transaction_id)?, self.document.revision, commands)?;
        let mut changed_ids = std::collections::BTreeSet::new();
        if let Some(history) = preview.document.latest_undo_item() {
            collect_geometry_change_ids(&history.changes, &mut changed_ids);
        }
        let changed = changed_ids
            .into_iter()
            .filter_map(|id| preview.document.node(id))
            .map(|node| {
                projection_node(
                    node,
                    preview
                        .document
                        .page_for_node(node.id)
                        .unwrap_or(DEFAULT_PAGE_ID),
                    preview.document.asset_for_node(node.id),
                    preview.document.text_properties_for_node(node.id),
                    preview.document.auto_layout_for_node(node.id),
                    preview.document.fill_stack_for_node(node.id),
                    preview.document.stroke_stack_for_node(node.id),
                    preview.document.paint_style_links_for_node(node.id),
                )
            })
            .collect::<Vec<_>>();
        serde_json::to_string(&changed).map_err(|_| JsValue::from_str("INVALID_PREVIEW_PROJECTION"))
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
    makefigma_document_codec::CURRENT_ENGINE_SEMANTICS_VERSION
}

/// Builds a transient GPU instance projection from a validated Core snapshot
/// without borrowing the live browser editing engine. The renderer owns this
/// derived data only; edits and history remain on its separate DocumentEngine.
/// Keeping the projection receiver-free avoids a wasm-bindgen borrow spanning a
/// browser Worker render read and a later mutable transaction.
#[wasm_bindgen]
pub fn gpu_scene_instances_from_snapshot_json(
    snapshot_json: &str,
    page_id: &str,
) -> Result<String, JsValue> {
    let mut projection = DocumentEngine::new();
    projection.load_snapshot_json(snapshot_json)?;
    projection.gpu_scene_instances_json(page_id)
}

/// Returns the budgeted Core flattening for a JSON-projected VectorPath. This
/// is presentation data only; callers must never persist the returned points.
#[wasm_bindgen]
pub fn vector_path_geometry_json(path_json: &str, tolerance: f64) -> Result<String, JsValue> {
    let path = serde_json::from_str::<ProjectionVectorPath>(path_json)
        .map_err(|_| JsValue::from_str("INVALID_VECTOR_PATH"))?;
    let path = vector_path_from_projection(path)?;
    let flattened = flatten_vector_path(&path, tolerance)
        .map_err(|_| JsValue::from_str("INVALID_VECTOR_GEOMETRY"))?;
    Ok(serde_json::json!({
        "subpaths": flattened.subpaths.into_iter().map(|subpath| serde_json::json!({
            "closed": subpath.closed,
            "points": subpath.points.into_iter().map(|point| [point.x, point.y]).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "bounds": flattened.bounds.map(|bounds| serde_json::json!({
            "min": [bounds.min.x, bounds.min.y],
            "max": [bounds.max.x, bounds.max.y],
        })),
    }).to_string())
}

/// Finds the nearest editable original VectorPath segment for direct canvas
/// splitting. Its `t` is Core-derived and can be passed unchanged to the
/// Canonical SplitVectorSegment command.
#[wasm_bindgen]
pub fn vector_path_nearest_segment_json(
    path_json: &str,
    x: f64,
    y: f64,
    tolerance: f64,
    max_distance: f64,
) -> Result<String, JsValue> {
    let path = serde_json::from_str::<ProjectionVectorPath>(path_json)
        .map_err(|_| JsValue::from_str("INVALID_VECTOR_PATH"))?;
    let path = vector_path_from_projection(path)?;
    let hit = nearest_vector_path_segment(
        &path,
        Point::new(x, y).map_err(|_| JsValue::from_str("INVALID_VECTOR_POINT"))?,
        tolerance,
        max_distance,
    )
    .map_err(|_| JsValue::from_str("INVALID_VECTOR_GEOMETRY"))?;
    Ok(hit
        .map(|hit| {
            serde_json::json!({
                "subpathIndex": hit.subpath_index,
                "afterPointIndex": hit.after_point_index,
                "t": hit.t,
                "distance": hit.distance,
            })
        })
        .unwrap_or(serde_json::Value::Null)
        .to_string())
}

/// Returns the one Core-derived local contour for an ADR 0026 Polygon or Star.
/// It is transient presentation geometry only; the canonical document continues
/// to store the bounded parametric record rather than this generated point list.
#[wasm_bindgen]
pub fn parametric_shape_outline_json(
    width: f64,
    height: f64,
    shape_json: &str,
) -> Result<String, JsValue> {
    let projection = serde_json::from_str::<ProjectionParametricShape>(shape_json)
        .map_err(|_| JsValue::from_str("INVALID_PARAMETRIC_SHAPE"))?;
    let shape = match projection {
        ProjectionParametricShape::Polygon { point_count } => {
            ParametricShape::Polygon { point_count }
        }
        ProjectionParametricShape::Star {
            point_count,
            inner_ratio,
        } => ParametricShape::Star {
            point_count,
            inner_ratio,
        },
    };
    let points = parametric_shape_outline(width, height, shape)
        .map_err(|_| JsValue::from_str("INVALID_PARAMETRIC_GEOMETRY"))?;
    let bounds = Bounds::from_points(&points)
        .ok_or_else(|| JsValue::from_str("INVALID_PARAMETRIC_GEOMETRY"))?;
    Ok(serde_json::json!({
        "points": points.into_iter().map(|point| [point.x, point.y]).collect::<Vec<_>>(),
        "bounds": {
            "min": [bounds.min.x, bounds.min.y],
            "max": [bounds.max.x, bounds.max.y],
        },
    })
    .to_string())
}

/// Canonical non-zero fill containment for editable Polygon/Star nodes. The
/// document stores only parameters; this recomputes the bounded Core outline.
#[wasm_bindgen]
pub fn parametric_shape_contains_point_json(
    width: f64,
    height: f64,
    shape_json: &str,
    x: f64,
    y: f64,
) -> Result<bool, JsValue> {
    let projection = serde_json::from_str::<ProjectionParametricShape>(shape_json)
        .map_err(|_| JsValue::from_str("INVALID_PARAMETRIC_SHAPE"))?;
    let shape = match projection {
        ProjectionParametricShape::Polygon { point_count } => {
            ParametricShape::Polygon { point_count }
        }
        ProjectionParametricShape::Star {
            point_count,
            inner_ratio,
        } => ParametricShape::Star {
            point_count,
            inner_ratio,
        },
    };
    let outline = parametric_shape_outline(width, height, shape)
        .map_err(|_| JsValue::from_str("INVALID_PARAMETRIC_GEOMETRY"))?;
    let point = Point::new(x, y).map_err(|_| JsValue::from_str("INVALID_PARAMETRIC_POINT"))?;
    Ok(point_in_polygon(
        point,
        &outline,
        editor_core::geometry::FillRule::NonZero,
    ))
}

/// Returns one transient Boolean outline for two or more VectorPath operands.
/// The input and output are projection data only: the editable source paths and
/// BooleanOperation children remain Canonical, while Canvas, hit tests and
/// exporters can consume this one validated Rust-derived result.
#[wasm_bindgen]
pub fn boolean_vector_paths_json(
    operation: &str,
    operands_json: &str,
    tolerance: f64,
) -> Result<String, JsValue> {
    let operation = parse_boolean_operation(operation)?;
    let operands = serde_json::from_str::<Vec<ProjectionVectorPath>>(operands_json)
        .map_err(|_| JsValue::from_str("INVALID_BOOLEAN_OPERANDS"))?
        .into_iter()
        .map(vector_path_from_projection)
        .collect::<Result<Vec<_>, _>>()?;
    let flattened = boolean_vector_paths(operation, &operands, tolerance)
        .map_err(|_| JsValue::from_str("INVALID_BOOLEAN_GEOMETRY"))?;
    Ok(serde_json::json!({
        "fillRule": "nonZero",
        "subpaths": flattened.subpaths.into_iter().map(|subpath| serde_json::json!({
            "closed": subpath.closed,
            "points": subpath.points.into_iter().map(|point| [point.x, point.y]).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "bounds": flattened.bounds.map(|bounds| serde_json::json!({
            "min": [bounds.min.x, bounds.min.y],
            "max": [bounds.max.x, bounds.max.y],
        })),
    }).to_string())
}

/// Canonical fill containment for Worker hit tests. Open subpaths do not
/// contribute to fill containment; stroke hits use the separate mesh bridge.
#[wasm_bindgen]
pub fn vector_path_contains_json(
    path_json: &str,
    x: f64,
    y: f64,
    tolerance: f64,
) -> Result<bool, JsValue> {
    let path = serde_json::from_str::<ProjectionVectorPath>(path_json)
        .map_err(|_| JsValue::from_str("INVALID_VECTOR_PATH"))?;
    let path = vector_path_from_projection(path)?;
    core_vector_path_contains(
        &path,
        Point::new(x, y).map_err(|_| JsValue::from_str("INVALID_VECTOR_POINT"))?,
        tolerance,
    )
    .map_err(|_| JsValue::from_str("INVALID_VECTOR_GEOMETRY"))
}

/// Projects the Core VectorPath stroke mesh for Canvas fallback or a future
/// GPU upload. Unlike an HTML canvas stroke, this shares Core's joins, caps
/// and transient geometry budget with precise stroke hit testing.
#[wasm_bindgen]
pub fn vector_path_stroke_mesh_json(
    path_json: &str,
    tolerance: f64,
    width: f64,
    cap: &str,
    join: &str,
    miter_limit: f64,
) -> Result<String, JsValue> {
    let path = serde_json::from_str::<ProjectionVectorPath>(path_json)
        .map_err(|_| JsValue::from_str("INVALID_VECTOR_PATH"))?;
    let path = vector_path_from_projection(path)?;
    let mesh = vector_path_stroke_mesh(
        &path,
        tolerance,
        StrokeStyle {
            width,
            cap: parse_geometry_stroke_cap(cap)?,
            join: parse_geometry_stroke_join(join)?,
            miter_limit,
        },
    )
    .map_err(|_| JsValue::from_str("INVALID_VECTOR_STROKE"))?;
    Ok(serde_json::json!({
        "triangles": mesh.triangles.into_iter().map(|triangle| triangle.map(|point| [point.x, point.y])).collect::<Vec<_>>(),
        "bounds": mesh.bounds.map(|bounds| serde_json::json!({ "min": [bounds.min.x, bounds.min.y], "max": [bounds.max.x, bounds.max.y] })),
    }).to_string())
}

/// Expands a VectorPath stroke through the same Core tessellation used by the
/// Canvas fallback and stroke hit testing, then unions that mesh into editable
/// closed VectorPath contours for the Outline Stroke command.
#[wasm_bindgen]
pub fn vector_path_outline_json(
    path_json: &str,
    tolerance: f64,
    width: f64,
    cap: &str,
    join: &str,
    miter_limit: f64,
) -> Result<String, JsValue> {
    let path = serde_json::from_str::<ProjectionVectorPath>(path_json)
        .map_err(|_| JsValue::from_str("INVALID_VECTOR_PATH"))?;
    let path = vector_path_from_projection(path)?;
    let outlined = outline_vector_path(
        &path,
        tolerance,
        StrokeStyle {
            width,
            cap: parse_geometry_stroke_cap(cap)?,
            join: parse_geometry_stroke_join(join)?,
            miter_limit,
        },
    )
    .map_err(|_| JsValue::from_str("INVALID_VECTOR_OUTLINE"))?;
    Ok(serde_json::json!({
        "fillRule": "nonZero",
        "subpaths": outlined.subpaths.into_iter().map(|subpath| serde_json::json!({
            "closed": subpath.closed,
            "points": subpath.points.into_iter().map(|point| [point.x, point.y]).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "bounds": outlined.bounds.map(|bounds| serde_json::json!({
            "min": [bounds.min.x, bounds.min.y], "max": [bounds.max.x, bounds.max.y],
        })),
    }).to_string())
}

/// As [`vector_path_outline_json`], but open paths can use different standard
/// caps at their start and end. Decorative caps remain a Line rendering mode.
#[wasm_bindgen]
pub fn vector_path_outline_with_caps_json(
    path_json: &str,
    tolerance: f64,
    width: f64,
    start_cap: &str,
    end_cap: &str,
    join: &str,
    miter_limit: f64,
) -> Result<String, JsValue> {
    let path = serde_json::from_str::<ProjectionVectorPath>(path_json)
        .map_err(|_| JsValue::from_str("INVALID_VECTOR_PATH"))?;
    let path = vector_path_from_projection(path)?;
    let cap = parse_geometry_stroke_cap(start_cap)?;
    let outlined = outline_vector_path_with_caps(
        &path,
        tolerance,
        StrokeStyle {
            width,
            cap,
            join: parse_geometry_stroke_join(join)?,
            miter_limit,
        },
        cap,
        parse_geometry_stroke_cap(end_cap)?,
    )
    .map_err(|_| JsValue::from_str("INVALID_VECTOR_OUTLINE"))?;
    Ok(serde_json::json!({
        "fillRule": "nonZero",
        "subpaths": outlined.subpaths.into_iter().map(|subpath| serde_json::json!({
            "closed": subpath.closed,
            "points": subpath.points.into_iter().map(|point| [point.x, point.y]).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "bounds": outlined.bounds.map(|bounds| serde_json::json!({
            "min": [bounds.min.x, bounds.min.y], "max": [bounds.max.x, bounds.max.y],
        })),
    }).to_string())
}

#[wasm_bindgen]
pub fn vector_path_dashed_outline_json(
    path_json: &str,
    tolerance: f64,
    width: f64,
    dash_json: &str,
    cap: &str,
    join: &str,
    miter_limit: f64,
) -> Result<String, JsValue> {
    let path = serde_json::from_str::<ProjectionVectorPath>(path_json)
        .map_err(|_| JsValue::from_str("INVALID_VECTOR_PATH"))?;
    let path = vector_path_from_projection(path)?;
    let dash = serde_json::from_str::<Vec<f64>>(dash_json)
        .map_err(|_| JsValue::from_str("INVALID_STROKE_DASH"))?;
    let style = StrokeStyle {
        width,
        cap: parse_geometry_stroke_cap(cap)?,
        join: parse_geometry_stroke_join(join)?,
        miter_limit,
    };
    let outlined = outline_stroke_mesh(
        vector_path_dashed_stroke_mesh(&path, tolerance, style, &dash)
            .map_err(|_| JsValue::from_str("INVALID_VECTOR_OUTLINE"))?,
    )
    .map_err(|_| JsValue::from_str("INVALID_VECTOR_OUTLINE"))?;
    Ok(serde_json::json!({ "fillRule": "nonZero", "subpaths": outlined.subpaths.into_iter().map(|subpath| serde_json::json!({ "closed": subpath.closed, "points": subpath.points.into_iter().map(|point| [point.x, point.y]).collect::<Vec<_>>() })).collect::<Vec<_>>() }).to_string())
}

#[wasm_bindgen]
pub fn vector_path_stroke_contains_json(
    path_json: &str,
    x: f64,
    y: f64,
    tolerance: f64,
    width: f64,
    cap: &str,
    join: &str,
    miter_limit: f64,
) -> Result<bool, JsValue> {
    let path = serde_json::from_str::<ProjectionVectorPath>(path_json)
        .map_err(|_| JsValue::from_str("INVALID_VECTOR_PATH"))?;
    let path = vector_path_from_projection(path)?;
    let mesh = vector_path_stroke_mesh(
        &path,
        tolerance,
        StrokeStyle {
            width,
            cap: parse_geometry_stroke_cap(cap)?,
            join: parse_geometry_stroke_join(join)?,
            miter_limit,
        },
    )
    .map_err(|_| JsValue::from_str("INVALID_VECTOR_STROKE"))?;
    Ok(mesh.contains(Point::new(x, y).map_err(|_| JsValue::from_str("INVALID_VECTOR_POINT"))?))
}

fn parse_geometry_stroke_cap(value: &str) -> Result<StrokeCapStyle, JsValue> {
    match value {
        "butt" => Ok(StrokeCapStyle::Butt),
        "round" => Ok(StrokeCapStyle::Round),
        "square" => Ok(StrokeCapStyle::Square),
        _ => Err(JsValue::from_str("INVALID_STROKE_CAP")),
    }
}

fn parse_geometry_stroke_join(value: &str) -> Result<StrokeJoinStyle, JsValue> {
    match value {
        "miter" => Ok(StrokeJoinStyle::Miter),
        "bevel" => Ok(StrokeJoinStyle::Bevel),
        "round" => Ok(StrokeJoinStyle::Round),
        _ => Err(JsValue::from_str("INVALID_STROKE_JOIN")),
    }
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

/// Converts a solid straight Line and either standard or decorative endpoint
/// caps into one unioned editable outline. Dashed lines remain deliberately
/// excluded because their terminal-cap semantics differ per dash run.
#[wasm_bindgen]
pub fn line_outline_json(
    width: f64,
    stroke_width: f64,
    start_cap: &str,
    end_cap: &str,
    join: &str,
    miter_limit: f64,
) -> Result<String, JsValue> {
    let standard = |value: &str| match value {
        "none" => Some(StrokeCapStyle::Butt),
        "round" => Some(StrokeCapStyle::Round),
        "square" => Some(StrokeCapStyle::Square),
        _ => None,
    };
    let decorative = |value: &str| match value {
        "arrowLines" => Some(DecorativeCapStyle::ArrowLines),
        "arrowEquilateral" => Some(DecorativeCapStyle::ArrowEquilateral),
        "triangleFilled" => Some(DecorativeCapStyle::TriangleFilled),
        "diamondFilled" => Some(DecorativeCapStyle::DiamondFilled),
        "circleFilled" => Some(DecorativeCapStyle::CircleFilled),
        _ => None,
    };
    let start = standard(start_cap)
        .or_else(|| decorative(start_cap).map(|_| StrokeCapStyle::Butt))
        .ok_or_else(|| JsValue::from_str("INVALID_LINE_CAP"))?;
    let end = standard(end_cap)
        .or_else(|| decorative(end_cap).map(|_| StrokeCapStyle::Butt))
        .ok_or_else(|| JsValue::from_str("INVALID_LINE_CAP"))?;
    let style = StrokeStyle {
        width: stroke_width,
        cap: StrokeCapStyle::Butt,
        join: parse_geometry_stroke_join(join)?,
        miter_limit,
    };
    let mut mesh = stroke_mesh_for_polyline_with_caps(
        &[Point { x: 0.0, y: 0.0 }, Point { x: width, y: 0.0 }],
        style,
        start,
        end,
        false,
    )
    .map_err(|_| JsValue::from_str("INVALID_LINE_OUTLINE"))?;
    if let Some(cap) = decorative(start_cap) {
        mesh.triangles.extend(
            decorative_cap_mesh(cap, 0.0, -1.0, stroke_width)
                .map_err(|_| JsValue::from_str("INVALID_LINE_OUTLINE"))?
                .triangles,
        );
    }
    if let Some(cap) = decorative(end_cap) {
        mesh.triangles.extend(
            decorative_cap_mesh(cap, width, 1.0, stroke_width)
                .map_err(|_| JsValue::from_str("INVALID_LINE_OUTLINE"))?
                .triangles,
        );
    }
    let outlined =
        outline_stroke_mesh(mesh).map_err(|_| JsValue::from_str("INVALID_LINE_OUTLINE"))?;
    Ok(serde_json::json!({ "fillRule": "nonZero", "subpaths": outlined.subpaths.into_iter().map(|subpath| serde_json::json!({ "closed": subpath.closed, "points": subpath.points.into_iter().map(|point| [point.x, point.y]).collect::<Vec<_>>() })).collect::<Vec<_>>() }).to_string())
}

#[wasm_bindgen]
pub fn dashed_line_outline_json(
    width: f64,
    stroke_width: f64,
    dash_json: &str,
    cap: &str,
    join: &str,
    miter_limit: f64,
) -> Result<String, JsValue> {
    let dash_pattern = serde_json::from_str::<Vec<f64>>(dash_json)
        .map_err(|_| JsValue::from_str("INVALID_STROKE_DASH"))?;
    let style = StrokeStyle {
        width: stroke_width,
        cap: parse_geometry_stroke_cap(cap)?,
        join: parse_geometry_stroke_join(join)?,
        miter_limit,
    };
    let mesh = stroke_mesh_for_dashed_line(width, style, &dash_pattern)
        .map_err(|_| JsValue::from_str("INVALID_DASHED_LINE_OUTLINE"))?;
    let outlined =
        outline_stroke_mesh(mesh).map_err(|_| JsValue::from_str("INVALID_DASHED_LINE_OUTLINE"))?;
    Ok(serde_json::json!({ "fillRule": "nonZero", "subpaths": outlined.subpaths.into_iter().map(|subpath| serde_json::json!({ "closed": subpath.closed, "points": subpath.points.into_iter().map(|point| [point.x, point.y]).collect::<Vec<_>>() })).collect::<Vec<_>>() }).to_string())
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
    let mesh = stroke_mesh_for_dashed_line(
        width,
        StrokeStyle {
            width: stroke_width,
            cap,
            join,
            miter_limit,
        },
        &dash_pattern,
    )
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
    let points = raw_points
        .into_iter()
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
    let mesh = stroke_mesh_for_dashed_polyline(
        &points,
        StrokeStyle {
            width: stroke_width,
            cap,
            join,
            miter_limit,
        },
        &dash_pattern,
        closed,
    )
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
    let meshes =
        stroke_meshes_for_per_side_rectangle_with_dash(width, height, weights, align, Some(&dash))
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
        StrokeStyle {
            width: stroke_width,
            cap: StrokeCapStyle::Butt,
            join,
            miter_limit,
        },
        &dash_pattern,
    )
    .map_err(|_| JsValue::from_str("INVALID_DASHED_ROUNDED_RECTANGLE_STROKE_STYLE"))?;
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
        StrokeStyle {
            width: stroke_width,
            cap: StrokeCapStyle::Butt,
            join,
            miter_limit,
        },
        (!dash_pattern.is_empty()).then_some(dash_pattern.as_slice()),
    )
    .map_err(|_| JsValue::from_str("INVALID_CONTINUOUS_ROUNDED_RECTANGLE_STROKE_STYLE"))?;
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
            "visualRuns": line.visual_runs.into_iter().map(|run| serde_json::json!({
                "start": run.start,
                "end": run.end,
                "direction": match run.direction {
                    makefigma_graphics_core::TextDirection::LeftToRight => "ltr",
                    makefigma_graphics_core::TextDirection::RightToLeft => "rtl",
                },
            })).collect::<Vec<_>>(),
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
            "runIndex": glyph.run_index,
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

/// Rasterizes one explicit glyph with the same variation coordinates and
/// synthetic weight/style identity used by the owning metric Style Run.
#[wasm_bindgen]
pub fn rasterize_glyph_with_style_json(
    font_bytes: &[u8],
    face_index: u32,
    variation_axes_json: &str,
    font_weight: u16,
    italic: bool,
    glyph_id: u32,
    pixel_size: u16,
) -> Result<String, JsValue> {
    let variations = parse_font_variations(variation_axes_json)?;
    let raster = makefigma_graphics_core::rasterize_glyph_with_variations_and_style(
        font_bytes,
        face_index,
        &variations,
        glyph_id,
        pixel_size,
        makefigma_graphics_core::SyntheticFontStyle {
            font_weight,
            italic,
        },
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
            "visualCarets": line.visual_carets.into_iter().map(|caret| serde_json::json!({
                "byteOffset": caret.byte_offset,
                "xAdvance": caret.x_advance,
            })).collect::<Vec<_>>(),
            "glyphs": line.glyphs.into_iter().map(|glyph| serde_json::json!({
                "glyphId": glyph.glyph_id,
                "runIndex": glyph.run_index,
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
            "visualCarets": line.visual_carets.into_iter().map(|caret| serde_json::json!({
                "byteOffset": caret.byte_offset,
                "xAdvance": caret.x_advance,
            })).collect::<Vec<_>>(),
            "glyphs": line.glyphs.into_iter().map(|glyph| serde_json::json!({
                "glyphId": glyph.glyph_id,
                "runIndex": glyph.run_index,
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

/// Shapes metric-bearing Style Runs from one bounded concatenated font bundle.
/// `runs_json` references byte windows in that bundle so callers do not encode
/// large font files as JSON or persist them in the Canonical document.
#[wasm_bindgen]
pub fn layout_shaped_text_runs_json(
    font_bundle: &[u8],
    runs_json: &str,
    text: &str,
    max_width_px: f32,
) -> Result<String, JsValue> {
    let inputs = serde_json::from_str::<Vec<TextShapingRunInput>>(runs_json)
        .map_err(|_| JsValue::from_str("INVALID_TEXT_STYLE_RUNS"))?;
    let variations = inputs
        .iter()
        .map(|run| parse_font_variation_inputs(&run.variation_axes))
        .collect::<Result<Vec<_>, _>>()?;
    let features = inputs
        .iter()
        .map(|run| parse_open_type_feature_inputs(&run.open_type_features))
        .collect::<Result<Vec<_>, _>>()?;
    let runs = inputs
        .iter()
        .zip(&variations)
        .zip(&features)
        .map(|((run, variations), features)| {
            let font_end = run
                .font_offset
                .checked_add(run.font_length)
                .ok_or_else(|| JsValue::from_str("INVALID_TEXT_STYLE_FONT_RANGE"))?;
            let font_bytes = font_bundle
                .get(run.font_offset..font_end)
                .filter(|bytes| !bytes.is_empty())
                .ok_or_else(|| JsValue::from_str("INVALID_TEXT_STYLE_FONT_RANGE"))?;
            Ok(makefigma_graphics_core::TextShapingRun {
                font_bytes,
                face_index: run.face_index,
                variations,
                features,
                start: run.start,
                end: run.end,
                font_size: run.font_size,
                synthetic_style: makefigma_graphics_core::SyntheticFontStyle {
                    font_weight: run.font_weight,
                    italic: run.italic,
                },
                letter_spacing: run.letter_spacing,
            })
        })
        .collect::<Result<Vec<_>, JsValue>>()?;
    let layout = makefigma_graphics_core::layout_shaped_text_runs(&runs, text, max_width_px)
        .map_err(|_| JsValue::from_str("INVALID_TEXT_STYLE_LAYOUT_INPUT"))?;
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
            "visualCarets": line.visual_carets.into_iter().map(|caret| serde_json::json!({
                "byteOffset": caret.byte_offset,
                "xAdvance": caret.x_advance,
            })).collect::<Vec<_>>(),
            "glyphs": line.glyphs.into_iter().map(|glyph| serde_json::json!({
                "glyphId": glyph.glyph_id,
                "runIndex": glyph.run_index,
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
struct TextShapingRunInput {
    start: u32,
    end: u32,
    font_offset: usize,
    font_length: usize,
    #[serde(default)]
    face_index: u32,
    #[serde(default)]
    variation_axes: Vec<FontVariationInput>,
    #[serde(default)]
    open_type_features: Vec<OpenTypeFeatureInput>,
    font_size: f32,
    #[serde(default = "default_font_weight")]
    font_weight: u16,
    #[serde(default)]
    italic: bool,
    #[serde(default)]
    letter_spacing: f32,
}

#[derive(Deserialize)]
struct OpenTypeFeatureInput {
    tag: String,
    enabled: bool,
}

fn parse_open_type_feature_inputs(
    inputs: &[OpenTypeFeatureInput],
) -> Result<Vec<makefigma_graphics_core::OpenTypeFeature>, JsValue> {
    if inputs.len() > 128 {
        return Err(JsValue::from_str("INVALID_TEXT_STYLE_FEATURES"));
    }
    let mut previous: Option<&str> = None;
    let mut output = Vec::with_capacity(inputs.len());
    for input in inputs {
        let bytes = input.tag.as_bytes();
        if bytes.len() != 4
            || bytes
                .iter()
                .any(|byte| !byte.is_ascii_uppercase() && !byte.is_ascii_digit())
            || previous.is_some_and(|tag| tag >= input.tag.as_str())
        {
            return Err(JsValue::from_str("INVALID_TEXT_STYLE_FEATURES"));
        }
        output.push(makefigma_graphics_core::OpenTypeFeature {
            tag: [bytes[0], bytes[1], bytes[2], bytes[3]],
            enabled: input.enabled,
        });
        previous = Some(&input.tag);
    }
    Ok(output)
}

fn default_font_weight() -> u16 {
    400
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
    parse_font_variation_inputs(&values)
}

fn parse_font_variation_inputs(
    values: &[FontVariationInput],
) -> Result<Vec<makefigma_graphics_core::FontVariation>, JsValue> {
    values
        .iter()
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
        makefigma_document_codec::SnapshotError::UnsupportedFutureNode
        | makefigma_document_codec::SnapshotError::UnsupportedEngineSemantics => {
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
        "polygon" => Ok(NodeKind::Polygon),
        "star" => Ok(NodeKind::Star),
        "vector" => Ok(NodeKind::Vector),
        "booleanOperation" => Ok(NodeKind::BooleanOperation),
        "slice" => Ok(NodeKind::Slice),
        "codeBlock" => Ok(NodeKind::CodeBlock),
        "component" => Ok(NodeKind::Component),
        "instance" => Ok(NodeKind::Instance),
        "slot" => Ok(NodeKind::Slot),
        "componentSet" => Ok(NodeKind::ComponentSet),
        "connector" => Ok(NodeKind::Connector),
        "embed" => Ok(NodeKind::Embed),
        "highlight" => Ok(NodeKind::Highlight),
        "interactiveSlideElement" => Ok(NodeKind::InteractiveSlideElement),
        "linkUnfurl" => Ok(NodeKind::LinkUnfurl),
        "media" => Ok(NodeKind::Media),
        "shapeWithText" => Ok(NodeKind::ShapeWithText),
        "slideGrid" => Ok(NodeKind::SlideGrid),
        "slide" => Ok(NodeKind::Slide),
        "slideRow" => Ok(NodeKind::SlideRow),
        "stamp" => Ok(NodeKind::Stamp),
        "sticky" => Ok(NodeKind::Sticky),
        "table" => Ok(NodeKind::Table),
        "tableCell" => Ok(NodeKind::TableCell),
        "textPath" => Ok(NodeKind::TextPath),
        "transformGroup" => Ok(NodeKind::TransformGroup),
        "washiTape" => Ok(NodeKind::WashiTape),
        "widget" => Ok(NodeKind::Widget),
        _ => Err(JsValue::from_str("UNSUPPORTED_NODE_KIND")),
    }
}

fn default_boolean_operation(kind: &NodeKind) -> Option<BooleanOperation> {
    (kind == &NodeKind::BooleanOperation).then_some(BooleanOperation::Union)
}

fn format_boolean_operation(operation: BooleanOperation) -> String {
    match operation {
        BooleanOperation::Union => "union",
        BooleanOperation::Intersect => "intersect",
        BooleanOperation::Subtract => "subtract",
        BooleanOperation::Exclude => "exclude",
    }
    .into()
}

fn parse_boolean_operation(value: &str) -> Result<BooleanOperation, JsValue> {
    match value {
        "union" => Ok(BooleanOperation::Union),
        "intersect" => Ok(BooleanOperation::Intersect),
        "subtract" => Ok(BooleanOperation::Subtract),
        "exclude" => Ok(BooleanOperation::Exclude),
        _ => Err(JsValue::from_str("INVALID_BOOLEAN_OPERATION")),
    }
}

fn default_parametric_shape(kind: &NodeKind) -> Option<ParametricShape> {
    match kind {
        NodeKind::Polygon => Some(ParametricShape::Polygon { point_count: 5 }),
        NodeKind::Star => Some(ParametricShape::Star {
            point_count: 5,
            inner_ratio: 0.5,
        }),
        _ => None,
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
    if !matches!(
        kind,
        NodeKind::Frame | NodeKind::Rectangle | NodeKind::Ellipse
    ) || (kind == NodeKind::Ellipse && has_arc_data)
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

fn parse_blend_mode(value: &str) -> Result<BlendMode, JsValue> {
    match value {
        "normal" => Ok(BlendMode::Normal),
        "multiply" => Ok(BlendMode::Multiply),
        "screen" => Ok(BlendMode::Screen),
        "overlay" => Ok(BlendMode::Overlay),
        "darken" => Ok(BlendMode::Darken),
        "lighten" => Ok(BlendMode::Lighten),
        "color-dodge" => Ok(BlendMode::ColorDodge),
        "color-burn" => Ok(BlendMode::ColorBurn),
        "hard-light" => Ok(BlendMode::HardLight),
        "soft-light" => Ok(BlendMode::SoftLight),
        "difference" => Ok(BlendMode::Difference),
        "exclusion" => Ok(BlendMode::Exclusion),
        "hue" => Ok(BlendMode::Hue),
        "saturation" => Ok(BlendMode::Saturation),
        "color" => Ok(BlendMode::Color),
        "luminosity" => Ok(BlendMode::Luminosity),
        "pass-through" => Ok(BlendMode::PassThrough),
        "linear-burn" => Ok(BlendMode::LinearBurn),
        "linear-dodge" => Ok(BlendMode::LinearDodge),
        _ => Err(JsValue::from_str("INVALID_BLEND_MODE")),
    }
}

fn format_blend_mode(mode: BlendMode) -> &'static str {
    match mode {
        BlendMode::Normal => "normal",
        BlendMode::Multiply => "multiply",
        BlendMode::Screen => "screen",
        BlendMode::Overlay => "overlay",
        BlendMode::Darken => "darken",
        BlendMode::Lighten => "lighten",
        BlendMode::ColorDodge => "color-dodge",
        BlendMode::ColorBurn => "color-burn",
        BlendMode::HardLight => "hard-light",
        BlendMode::SoftLight => "soft-light",
        BlendMode::Difference => "difference",
        BlendMode::Exclusion => "exclusion",
        BlendMode::Hue => "hue",
        BlendMode::Saturation => "saturation",
        BlendMode::Color => "color",
        BlendMode::Luminosity => "luminosity",
        BlendMode::PassThrough => "pass-through",
        BlendMode::LinearBurn => "linear-burn",
        BlendMode::LinearDodge => "linear-dodge",
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

fn projection_paint_stack(stack: &PaintStack) -> ProjectionPaintStack {
    ProjectionPaintStack {
        layers: stack
            .layers
            .iter()
            .map(|layer| {
                let (paint, image) = match &layer.paint {
                    PaintLayerKind::Solid(color) => (
                        Some(ProjectionPaint {
                            css: color.to_css_srgb_hex(),
                            color: Some(projection_color(*color)),
                            gradient: None,
                            gradient_paint: None,
                        }),
                        None,
                    ),
                    PaintLayerKind::LinearGradient(gradient) => (
                        Some(ProjectionPaint {
                            css: gradient.stops[0].color.to_css_srgb_hex(),
                            color: None,
                            gradient: Some(ProjectionLinearGradient {
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
                            gradient_paint: None,
                        }),
                        None,
                    ),
                    PaintLayerKind::Image(image) => (
                        None,
                        Some(ProjectionImagePaint {
                            asset_id: format_uuid(NodeId(image.asset_id.0)),
                            scale_mode: match image.scale_mode {
                                ImageScaleMode::Fill => "fill",
                                ImageScaleMode::Fit => "fit",
                                ImageScaleMode::Crop => "crop",
                                ImageScaleMode::Tile => "tile",
                            }
                            .into(),
                            transform: ProjectionTransform {
                                a: image.transform.a,
                                b: image.transform.b,
                                c: image.transform.c,
                                d: image.transform.d,
                                e: image.transform.e,
                                f: image.transform.f,
                            },
                            rotation_degrees: image.rotation_degrees,
                            filters: image.filters.map(|filters| ProjectionImageFilters {
                                exposure: filters.exposure,
                                contrast: filters.contrast,
                                saturation: filters.saturation,
                                temperature: filters.temperature,
                                tint: filters.tint,
                                highlights: filters.highlights,
                                shadows: filters.shadows,
                            }),
                        }),
                    ),
                    PaintLayerKind::Gradient(value) => (
                        Some(ProjectionPaint {
                            css: value.stops[0].color.to_css_srgb_hex(),
                            color: None,
                            gradient: None,
                            gradient_paint: Some(ProjectionGradientPaint {
                                kind: match value.kind {
                                    GradientPaintKind::Radial => "radial",
                                    GradientPaintKind::Angular => "angular",
                                    GradientPaintKind::Diamond => "diamond",
                                }
                                .into(),
                                transform: ProjectionTransform {
                                    a: value.transform.a,
                                    b: value.transform.b,
                                    c: value.transform.c,
                                    d: value.transform.d,
                                    e: value.transform.e,
                                    f: value.transform.f,
                                },
                                stops: value
                                    .stops
                                    .iter()
                                    .map(|stop| ProjectionGradientStop {
                                        position: stop.position,
                                        color: projection_color(stop.color),
                                    })
                                    .collect(),
                            }),
                        }),
                        None,
                    ),
                };
                ProjectionPaintLayer {
                    paint,
                    image,
                    visible: layer.visible,
                    opacity: layer.opacity,
                    blend_mode: format_blend_mode(layer.blend_mode).into(),
                }
            })
            .collect(),
    }
}

fn paint_stack_from_projection(stack: &ProjectionPaintStack) -> Result<PaintStack, JsValue> {
    Ok(PaintStack {
        layers: stack
            .layers
            .iter()
            .map(|layer| {
                let paint = match (layer.paint.as_ref(), layer.image.as_ref()) {
                    (Some(paint), None) if paint.gradient_paint.is_some() => {
                        let gradient = paint.gradient_paint.as_ref().expect("guarded above");
                        PaintLayerKind::Gradient(
                            GradientPaint::new(
                                match gradient.kind.as_str() {
                                    "radial" => GradientPaintKind::Radial,
                                    "angular" => GradientPaintKind::Angular,
                                    "diamond" => GradientPaintKind::Diamond,
                                    _ => return Err(JsValue::from_str("INVALID_PAINT_STACK")),
                                },
                                editor_core::geometry::AffineTransform {
                                    a: gradient.transform.a,
                                    b: gradient.transform.b,
                                    c: gradient.transform.c,
                                    d: gradient.transform.d,
                                    e: gradient.transform.e,
                                    f: gradient.transform.f,
                                },
                                gradient
                                    .stops
                                    .iter()
                                    .map(|stop| {
                                        Ok(GradientStop {
                                            position: stop.position,
                                            color: color_from_projection(&stop.color)?,
                                        })
                                    })
                                    .collect::<Result<Vec<_>, JsValue>>()?,
                            )
                            .map_err(|_| JsValue::from_str("INVALID_GRADIENT"))?,
                        )
                    }
                    (Some(paint), None) => match paint_from_projection(
                        &paint.css,
                        paint.color.as_ref(),
                        paint.gradient.as_ref(),
                    )? {
                        Paint::Solid(color) => PaintLayerKind::Solid(color),
                        Paint::LinearGradient(gradient) => PaintLayerKind::LinearGradient(gradient),
                    },
                    (None, Some(image)) => PaintLayerKind::Image(ImagePaint {
                        asset_id: AssetId(parse_id(&image.asset_id)?.0),
                        scale_mode: match image.scale_mode.as_str() {
                            "fill" => ImageScaleMode::Fill,
                            "fit" => ImageScaleMode::Fit,
                            "crop" => ImageScaleMode::Crop,
                            "tile" => ImageScaleMode::Tile,
                            _ => return Err(JsValue::from_str("INVALID_PAINT_STACK")),
                        },
                        transform: editor_core::geometry::AffineTransform {
                            a: image.transform.a,
                            b: image.transform.b,
                            c: image.transform.c,
                            d: image.transform.d,
                            e: image.transform.e,
                            f: image.transform.f,
                        },
                        rotation_degrees: image.rotation_degrees,
                        filters: image.filters.map(|filters| ImageFilters {
                            exposure: filters.exposure,
                            contrast: filters.contrast,
                            saturation: filters.saturation,
                            temperature: filters.temperature,
                            tint: filters.tint,
                            highlights: filters.highlights,
                            shadows: filters.shadows,
                        }),
                    }),
                    _ => return Err(JsValue::from_str("INVALID_PAINT_STACK")),
                };
                Ok(PaintLayer {
                    paint,
                    visible: layer.visible,
                    opacity: layer.opacity,
                    blend_mode: parse_blend_mode(&layer.blend_mode)?,
                })
            })
            .collect::<Result<Vec<_>, JsValue>>()?,
    })
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
        font_faces: asset
            .font_faces
            .iter()
            .map(|face| ProjectionFontFace {
                face_index: face.face_index,
                family: face.family.clone(),
                style: face.style.clone(),
                aliases: face
                    .aliases
                    .iter()
                    .map(|alias| ProjectionFontNameAlias {
                        family: alias.family.clone(),
                        style: alias.style.clone(),
                    })
                    .collect(),
            })
            .collect(),
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
        font_faces: asset
            .font_faces
            .into_iter()
            .map(|face| FontFaceMetadata {
                face_index: face.face_index,
                family: face.family,
                style: face.style,
                aliases: face
                    .aliases
                    .into_iter()
                    .map(|alias| editor_core::FontNameAlias {
                        family: alias.family,
                        style: alias.style,
                    })
                    .collect(),
            })
            .collect(),
    })
}

fn projection_node(
    node: &Node,
    page_id: PageId,
    asset_id: Option<AssetId>,
    text_properties: Option<&TextProperties>,
    auto_layout: AutoLayout,
    fill_stack: Option<&PaintStack>,
    stroke_stack: Option<&PaintStack>,
    paint_style_links: Option<&PaintStyleLinks>,
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
            NodeKind::Polygon => "polygon",
            NodeKind::Star => "star",
            NodeKind::Vector => "vector",
            NodeKind::BooleanOperation => "booleanOperation",
            NodeKind::Slice => "slice",
            NodeKind::CodeBlock => "codeBlock",
            NodeKind::Component => "component",
            NodeKind::Instance => "instance",
            NodeKind::Slot => "slot",
            NodeKind::ComponentSet => "componentSet",
            NodeKind::Connector => "connector",
            NodeKind::Embed => "embed",
            NodeKind::Highlight => "highlight",
            NodeKind::InteractiveSlideElement => "interactiveSlideElement",
            NodeKind::LinkUnfurl => "linkUnfurl",
            NodeKind::Media => "media",
            NodeKind::ShapeWithText => "shapeWithText",
            NodeKind::SlideGrid => "slideGrid",
            NodeKind::Slide => "slide",
            NodeKind::SlideRow => "slideRow",
            NodeKind::Stamp => "stamp",
            NodeKind::Sticky => "sticky",
            NodeKind::Table => "table",
            NodeKind::TableCell => "tableCell",
            NodeKind::TextPath => "textPath",
            NodeKind::TransformGroup => "transformGroup",
            NodeKind::WashiTape => "washiTape",
            NodeKind::Widget => "widget",
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
        fills: node
            .fills
            .iter()
            .map(|paint| {
                let (css, color, gradient) = project_paint(paint);
                ProjectionPaint {
                    css,
                    color,
                    gradient,
                    gradient_paint: None,
                }
            })
            .collect(),
        fill_stack: fill_stack.map(projection_paint_stack),
        fill_style_id: paint_style_links.and_then(|links| links.fill.clone()),
        stroke,
        stroke_color,
        stroke_gradient,
        strokes: node
            .strokes
            .iter()
            .map(|paint| {
                let (css, color, gradient) = project_paint(paint);
                ProjectionPaint {
                    css,
                    color,
                    gradient,
                    gradient_paint: None,
                }
            })
            .collect(),
        stroke_stack: stroke_stack.map(projection_paint_stack),
        stroke_style_id: paint_style_links.and_then(|links| links.stroke.clone()),
        background_style_id: paint_style_links.and_then(|links| links.background.clone()),
        stroke_width: node.stroke_width,
        stroke_cap_start: format_stroke_cap(node.stroke_cap_start),
        stroke_cap_end: format_stroke_cap(node.stroke_cap_end),
        stroke_join: format_stroke_join(node.stroke_join),
        stroke_miter_limit: node.stroke_miter_limit,
        stroke_dash_pattern: node.stroke_dash_pattern.clone(),
        stroke_weights: node.stroke_weights.clone(),
        stroke_align: format_stroke_align(node.stroke_align),
        arc_data: node.arc_data.map(|arc| ProjectionArcData {
            starting_angle: arc.starting_angle,
            ending_angle: arc.ending_angle,
            inner_radius: arc.inner_radius,
        }),
        parametric_shape: node.parametric_shape.map(|shape| match shape {
            ParametricShape::Polygon { point_count } => {
                ProjectionParametricShape::Polygon { point_count }
            }
            ParametricShape::Star {
                point_count,
                inner_ratio,
            } => ProjectionParametricShape::Star {
                point_count,
                inner_ratio,
            },
        }),
        vector_path: node.vector_path.as_ref().map(projection_vector_path),
        boolean_operation: node.boolean_operation.map(format_boolean_operation),
        relative_transform: node.relative_transform.map(|matrix| ProjectionTransform {
            a: matrix.a,
            b: matrix.b,
            c: matrix.c,
            d: matrix.d,
            e: matrix.e,
            f: matrix.f,
        }),
        position_id: Some(format_position_id(node.position)),
        page_id: Some(format_page_id(page_id)),
        asset_id: asset_id.map(|id| format_uuid(NodeId(id.0))),
        text_properties: text_properties.map(projection_text_properties),
        opacity: node.opacity,
        blend_mode: format_blend_mode(node.blend_mode).into(),
        drop_shadow: node.drop_shadow.map(|shadow| ProjectionDropShadow {
            offset_x: shadow.offset_x,
            offset_y: shadow.offset_y,
            blur_radius: shadow.blur_radius,
            spread: shadow.spread,
            color: projection_color(shadow.color),
            visible: shadow.visible,
        }),
        effect_stack: node
            .effect_stack
            .iter()
            .copied()
            .map(projection_effect)
            .collect(),
        corner_radius: node.corner_radius,
        corner_radii: node.corner_radii.clone(),
        corner_smoothing: node.corner_smoothing,
        constraints: node.constraints.map(|value| ProjectionConstraints {
            horizontal: format_constraint_type(value.horizontal).into(),
            vertical: format_constraint_type(value.vertical).into(),
        }),
        auto_layout: projection_auto_layout(auto_layout),
        text: node.text.clone(),
        visible: node.visible,
        locked: node.locked,
        contents_hidden: node.contents_hidden,
        clips_content: Some(node.clips_content),
        is_mask: node
            .extensions
            .get("makefigma.mask.alpha.v1")
            .is_some_and(|value| value.as_slice() == [1]),
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
                color: run.color.map(projection_color),
                fill_stack: run.fill_stack.as_ref().map(projection_paint_stack),
                text_case: run.text_case.map(format_text_case).map(str::to_owned),
                hyperlink: run.hyperlink.as_ref().map(projection_hyperlink),
                text_decoration: run
                    .text_decoration
                    .map(format_text_decoration)
                    .map(str::to_owned),
                text_decoration_style: run
                    .text_decoration_style
                    .map(format_text_decoration_style)
                    .map(str::to_owned),
                text_decoration_offset: run
                    .text_decoration_offset
                    .map(projection_text_decoration_offset),
                text_decoration_thickness: run
                    .text_decoration_thickness
                    .map(projection_text_decoration_thickness),
                text_decoration_color: run
                    .text_decoration_color
                    .map(projection_text_decoration_color),
                text_decoration_skip_ink: run.text_decoration_skip_ink,
                leading_trim: run.leading_trim.map(|value| match value {
                    LeadingTrim::CapHeight => "capHeight".to_owned(),
                }),
                open_type_features: run
                    .open_type_features
                    .iter()
                    .map(|feature| (feature.tag.clone(), feature.enabled))
                    .collect(),
                text_style_id: run.text_style_id.clone(),
                paint_style_id: run.paint_style_id.clone(),
                variable_bindings: (!run.variable_bindings.is_empty())
                    .then(|| Box::new(run.variable_bindings.clone())),
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
            line_height_unit: properties
                .paragraph
                .line_height_unit
                .map(|unit| match unit {
                    LineHeightUnit::Percent => "percent".to_owned(),
                    LineHeightUnit::Auto => "auto".to_owned(),
                }),
            paragraph_spacing: properties.paragraph.paragraph_spacing,
            paragraph_indent: properties.paragraph.paragraph_indent,
            text_wrap_style: properties
                .paragraph
                .text_wrap_style
                .map(|style| match style {
                    TextWrapStyle::Auto => "auto".to_owned(),
                    TextWrapStyle::Balance => "balance".to_owned(),
                    TextWrapStyle::Pretty => "pretty".to_owned(),
                }),
            list_type: properties
                .paragraph
                .list_type
                .map(|list_type| match list_type {
                    TextListType::Ordered => "ordered".to_owned(),
                    TextListType::Unordered => "unordered".to_owned(),
                }),
            list_spacing: properties.paragraph.list_spacing,
            hanging_list: properties.paragraph.hanging_list.then_some(true),
            hanging_punctuation: properties.paragraph.hanging_punctuation.then_some(true),
        },
        paragraph_style_runs: properties
            .paragraph_style_runs
            .iter()
            .map(|run| ProjectionParagraphStyleRun {
                start: run.start,
                indentation: run.indentation,
                list_type: run.list_type.map(|value| match value {
                    ParagraphListType::None => "none".to_owned(),
                    ParagraphListType::Ordered => "ordered".to_owned(),
                    ParagraphListType::Unordered => "unordered".to_owned(),
                }),
                list_spacing: run.list_spacing,
                paragraph_spacing: run.paragraph_spacing,
                paragraph_indent: run.paragraph_indent,
                line_height: run.line_height,
                line_height_unit: run.line_height_unit.map(|value| match value {
                    LineHeightUnit::Percent => "percent".to_owned(),
                    LineHeightUnit::Auto => "auto".to_owned(),
                }),
                text_wrap_style: run.text_wrap_style.map(|value| match value {
                    TextWrapStyle::Auto => "auto".to_owned(),
                    TextWrapStyle::Balance => "balance".to_owned(),
                    TextWrapStyle::Pretty => "pretty".to_owned(),
                }),
            })
            .collect(),
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
        text_truncation: (properties.text_truncation == TextTruncation::Ending)
            .then(|| "ending".into()),
        max_lines: properties.max_lines,
        base_style: properties.base_style.as_ref().map(|style| {
            Box::new(ProjectionTextStyle {
                font: style.font.as_ref().map(projection_font_reference),
                font_size: style.font_size,
                font_weight: style.font_weight,
                italic: style.italic,
                letter_spacing: style.letter_spacing,
                color: style.color.map(projection_color),
                fill_stack: style.fill_stack.as_ref().map(projection_paint_stack),
                text_case: style.text_case.map(format_text_case).map(str::to_owned),
                hyperlink: style.hyperlink.as_ref().map(projection_hyperlink),
                text_decoration: style
                    .text_decoration
                    .map(format_text_decoration)
                    .map(str::to_owned),
                text_decoration_style: style
                    .text_decoration_style
                    .map(format_text_decoration_style)
                    .map(str::to_owned),
                text_decoration_offset: style
                    .text_decoration_offset
                    .map(projection_text_decoration_offset),
                text_decoration_thickness: style
                    .text_decoration_thickness
                    .map(projection_text_decoration_thickness),
                text_decoration_color: style
                    .text_decoration_color
                    .map(projection_text_decoration_color),
                text_decoration_skip_ink: style.text_decoration_skip_ink,
                leading_trim: style.leading_trim.map(|value| match value {
                    LeadingTrim::CapHeight => "capHeight".to_owned(),
                }),
                open_type_features: style
                    .open_type_features
                    .iter()
                    .map(|feature| (feature.tag.clone(), feature.enabled))
                    .collect(),
                text_style_id: style.text_style_id.clone(),
                paint_style_id: style.paint_style_id.clone(),
                variable_bindings: (!style.variable_bindings.is_empty())
                    .then(|| Box::new(style.variable_bindings.clone())),
            })
        }),
    }
}

fn projection_text_style_resource(resource: &TextStyleResource) -> ProjectionTextStyleResource {
    let mut properties = TextProperties::default();
    properties.paragraph = resource.paragraph.clone();
    properties.base_style = Some(resource.style.clone());
    let projected = projection_text_properties(&properties);
    ProjectionTextStyleResource {
        id: resource.id.clone(),
        key: resource.key.clone(),
        name: resource.name.clone(),
        description: resource.description.clone(),
        description_markdown: resource.description_markdown.clone(),
        documentation_links: resource
            .documentation_links
            .iter()
            .map(|uri| ProjectionDocumentationLink { uri: uri.clone() })
            .collect(),
        remote: resource.remote,
        style: *projected
            .base_style
            .expect("text style projection always has a base style"),
        letter_spacing_unit: resource.letter_spacing_unit.map(|unit| match unit {
            TextStyleLetterSpacingUnit::Percent => ProjectionTextStyleLetterSpacingUnit::Percent,
        }),
        variable_bindings: resource.variable_bindings.clone(),
        paragraph: projected.paragraph,
    }
}

fn text_style_resource_from_projection(
    resource: &ProjectionTextStyleResource,
) -> Result<TextStyleResource, JsValue> {
    let projected = ProjectionTextProperties {
        runs: Vec::new(),
        paragraph: resource.paragraph.clone(),
        paragraph_style_runs: Vec::new(),
        auto_size: "fixed".into(),
        fallback_fonts: Vec::new(),
        text_truncation: None,
        max_lines: None,
        base_style: Some(Box::new(resource.style.clone())),
    };
    let properties = text_properties_from_projection(Some(&projected))?
        .ok_or_else(|| JsValue::from_str("INVALID_TEXT_STYLE_RESOURCE"))?;
    Ok(TextStyleResource {
        id: resource.id.clone(),
        key: resource.key.clone(),
        name: resource.name.clone(),
        description: resource.description.clone(),
        description_markdown: resource.description_markdown.clone(),
        documentation_links: resource
            .documentation_links
            .iter()
            .map(|link| link.uri.clone())
            .collect(),
        remote: resource.remote,
        style: properties
            .base_style
            .ok_or_else(|| JsValue::from_str("INVALID_TEXT_STYLE_RESOURCE"))?,
        letter_spacing_unit: resource.letter_spacing_unit.map(|unit| match unit {
            ProjectionTextStyleLetterSpacingUnit::Percent => TextStyleLetterSpacingUnit::Percent,
        }),
        variable_bindings: resource.variable_bindings.clone(),
        paragraph: properties.paragraph,
    })
}

fn projection_paint_style_resource(resource: &PaintStyleResource) -> ProjectionPaintStyleResource {
    ProjectionPaintStyleResource {
        id: resource.id.clone(),
        key: resource.key.clone(),
        name: resource.name.clone(),
        description: resource.description.clone(),
        description_markdown: resource.description_markdown.clone(),
        documentation_links: resource
            .documentation_links
            .iter()
            .map(|uri| ProjectionDocumentationLink { uri: uri.clone() })
            .collect(),
        remote: resource.remote,
        paints: projection_paint_stack(&resource.paints),
        variable_bindings: resource
            .variable_bindings
            .iter()
            .map(|binding| ProjectionPaintStyleVariableBinding {
                paint_index: binding.paint_index,
                stop_index: binding.stop_index,
                variable_id: binding.variable_id.clone(),
            })
            .collect(),
    }
}

fn paint_style_resource_from_projection(
    resource: &ProjectionPaintStyleResource,
) -> Result<PaintStyleResource, JsValue> {
    let variable_bindings = resource
        .variable_bindings
        .iter()
        .map(|binding| PaintStyleVariableBinding {
            paint_index: binding.paint_index,
            stop_index: binding.stop_index,
            variable_id: binding.variable_id.clone(),
        })
        .collect::<Vec<_>>();
    if !variable_bindings
        .windows(2)
        .all(|pair| pair[0].target_key() < pair[1].target_key())
    {
        return Err(JsValue::from_str("INVALID_PAINT_STYLE_RESOURCE"));
    }
    Ok(PaintStyleResource {
        id: resource.id.clone(),
        key: resource.key.clone(),
        name: resource.name.clone(),
        description: resource.description.clone(),
        description_markdown: resource.description_markdown.clone(),
        documentation_links: resource
            .documentation_links
            .iter()
            .map(|link| link.uri.clone())
            .collect(),
        remote: resource.remote,
        paints: paint_stack_from_projection(&resource.paints)?,
        variable_bindings,
    })
}

fn projection_variable_collection(
    value: &VariableCollectionResource,
) -> ProjectionVariableCollectionResource {
    ProjectionVariableCollectionResource {
        id: value.id.clone(),
        key: value.key.clone(),
        name: value.name.clone(),
        remote: value.remote,
        hidden_from_publishing: value.hidden_from_publishing,
        modes: value
            .modes
            .iter()
            .map(|mode| ProjectionVariableMode {
                mode_id: mode.id.clone(),
                name: mode.name.clone(),
            })
            .collect(),
        default_mode_id: value.default_mode_id.clone(),
    }
}

fn variable_collection_from_projection(
    value: &ProjectionVariableCollectionResource,
) -> Result<VariableCollectionResource, JsValue> {
    Ok(VariableCollectionResource {
        id: value.id.clone(),
        key: value.key.clone(),
        name: value.name.clone(),
        remote: value.remote,
        hidden_from_publishing: value.hidden_from_publishing,
        modes: value
            .modes
            .iter()
            .map(|mode| VariableMode {
                id: mode.mode_id.clone(),
                name: mode.name.clone(),
            })
            .collect(),
        default_mode_id: value.default_mode_id.clone(),
    })
}

fn projection_variable_value(value: &VariableValue) -> ProjectionVariableValue {
    match value {
        VariableValue::Boolean(value) => ProjectionVariableValue::Boolean(*value),
        VariableValue::Color(value) => ProjectionVariableValue::Color(projection_color(*value)),
        VariableValue::Float(value) => ProjectionVariableValue::Float(*value),
        VariableValue::String(value) => ProjectionVariableValue::String(value.clone()),
        VariableValue::Alias(id) => ProjectionVariableValue::Alias(ProjectionVariableAlias {
            r#type: "VARIABLE_ALIAS".into(),
            id: id.clone(),
        }),
    }
}

fn variable_value_from_projection(
    value: &ProjectionVariableValue,
) -> Result<VariableValue, JsValue> {
    match value {
        ProjectionVariableValue::Boolean(value) => Ok(VariableValue::Boolean(*value)),
        ProjectionVariableValue::Color(value) => {
            Ok(VariableValue::Color(color_from_projection(value)?))
        }
        ProjectionVariableValue::Float(value) => Ok(VariableValue::Float(*value)),
        ProjectionVariableValue::String(value) => Ok(VariableValue::String(value.clone())),
        ProjectionVariableValue::Alias(value) if value.r#type == "VARIABLE_ALIAS" => {
            Ok(VariableValue::Alias(value.id.clone()))
        }
        ProjectionVariableValue::Alias(_) => Err(JsValue::from_str("INVALID_VARIABLE_ALIAS")),
    }
}

fn projection_variable_resource(value: &VariableResource) -> ProjectionVariableResource {
    ProjectionVariableResource {
        id: value.id.clone(),
        key: value.key.clone(),
        name: value.name.clone(),
        description: value.description.clone(),
        remote: value.remote,
        hidden_from_publishing: value.hidden_from_publishing,
        collection_id: value.collection_id.clone(),
        resolved_type: match value.resolved_type {
            VariableResolvedType::Boolean => "BOOLEAN",
            VariableResolvedType::Color => "COLOR",
            VariableResolvedType::Float => "FLOAT",
            VariableResolvedType::String => "STRING",
        }
        .into(),
        values_by_mode: value
            .values_by_mode
            .iter()
            .map(|(mode, value)| (mode.clone(), projection_variable_value(value)))
            .collect(),
        scopes: value.scopes.clone(),
        code_syntax: value.code_syntax.clone(),
    }
}

fn variable_resource_from_projection(
    value: &ProjectionVariableResource,
) -> Result<VariableResource, JsValue> {
    let resolved_type = match value.resolved_type.as_str() {
        "BOOLEAN" => VariableResolvedType::Boolean,
        "COLOR" => VariableResolvedType::Color,
        "FLOAT" => VariableResolvedType::Float,
        "STRING" => VariableResolvedType::String,
        _ => return Err(JsValue::from_str("INVALID_VARIABLE_TYPE")),
    };
    Ok(VariableResource {
        id: value.id.clone(),
        key: value.key.clone(),
        name: value.name.clone(),
        description: value.description.clone(),
        remote: value.remote,
        hidden_from_publishing: value.hidden_from_publishing,
        collection_id: value.collection_id.clone(),
        resolved_type,
        values_by_mode: value
            .values_by_mode
            .iter()
            .map(|(mode, value)| Ok((mode.clone(), variable_value_from_projection(value)?)))
            .collect::<Result<_, JsValue>>()?,
        scopes: value.scopes.clone(),
        code_syntax: value.code_syntax.clone(),
    })
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
                        Ok::<TextStyleRun, JsValue>(TextStyleRun {
                            start: run.start,
                            end: run.end,
                            font: run.font.as_ref().map(font_from_projection).transpose()?,
                            font_size: run.font_size,
                            font_weight: run.font_weight,
                            italic: run.italic,
                            letter_spacing: run.letter_spacing,
                            color: run.color.as_ref().map(color_from_projection).transpose()?,
                            fill_stack: run
                                .fill_stack
                                .as_ref()
                                .map(paint_stack_from_projection)
                                .transpose()?,
                            text_case: run
                                .text_case
                                .as_deref()
                                .map(text_case_from_projection)
                                .transpose()?
                                .flatten(),
                            hyperlink: run
                                .hyperlink
                                .as_ref()
                                .map(hyperlink_from_projection)
                                .transpose()?,
                            text_decoration: run
                                .text_decoration
                                .as_deref()
                                .map(text_decoration_from_projection)
                                .transpose()?
                                .flatten(),
                            text_decoration_style: run
                                .text_decoration_style
                                .as_deref()
                                .map(text_decoration_style_from_projection)
                                .transpose()?
                                .flatten(),
                            text_decoration_offset: run
                                .text_decoration_offset
                                .as_ref()
                                .map(text_decoration_offset_from_projection)
                                .transpose()?,
                            text_decoration_thickness: run
                                .text_decoration_thickness
                                .as_ref()
                                .map(text_decoration_thickness_from_projection)
                                .transpose()?,
                            text_decoration_color: run
                                .text_decoration_color
                                .as_ref()
                                .map(text_decoration_color_from_projection)
                                .transpose()?,
                            text_decoration_skip_ink: run
                                .text_decoration_skip_ink
                                .filter(|value| *value),
                            leading_trim: match run.leading_trim.as_deref() {
                                None | Some("none") => None,
                                Some("capHeight") => Some(LeadingTrim::CapHeight),
                                _ => return Err(JsValue::from_str("INVALID_TEXT_PROPERTIES")),
                            },
                            open_type_features: run
                                .open_type_features
                                .iter()
                                .map(|(tag, enabled)| OpenTypeFeature {
                                    tag: tag.clone(),
                                    enabled: *enabled,
                                })
                                .collect(),
                            text_style_id: run.text_style_id.clone(),
                            paint_style_id: run.paint_style_id.clone(),
                            variable_bindings: run
                                .variable_bindings
                                .as_deref()
                                .cloned()
                                .unwrap_or_default(),
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
                    line_height_unit: match properties.paragraph.line_height_unit.as_deref() {
                        None | Some("pixels") => None,
                        Some("percent") => Some(LineHeightUnit::Percent),
                        Some("auto") => Some(LineHeightUnit::Auto),
                        _ => return Err(JsValue::from_str("INVALID_TEXT_PROPERTIES")),
                    },
                    paragraph_spacing: properties.paragraph.paragraph_spacing,
                    paragraph_indent: properties.paragraph.paragraph_indent,
                    text_wrap_style: match properties.paragraph.text_wrap_style.as_deref() {
                        None | Some("auto") => None,
                        Some("balance") => Some(TextWrapStyle::Balance),
                        Some("pretty") => Some(TextWrapStyle::Pretty),
                        _ => return Err(JsValue::from_str("INVALID_TEXT_PROPERTIES")),
                    },
                    list_type: match properties.paragraph.list_type.as_deref() {
                        None | Some("none") => None,
                        Some("ordered") => Some(TextListType::Ordered),
                        Some("unordered") => Some(TextListType::Unordered),
                        _ => return Err(JsValue::from_str("INVALID_TEXT_PROPERTIES")),
                    },
                    list_spacing: properties
                        .paragraph
                        .list_spacing
                        .filter(|value| *value != 0.0),
                    hanging_list: properties.paragraph.hanging_list.unwrap_or(false),
                    hanging_punctuation: properties.paragraph.hanging_punctuation.unwrap_or(false),
                },
                paragraph_style_runs: properties
                    .paragraph_style_runs
                    .iter()
                    .map(|run| {
                        let list_type = match run.list_type.as_deref() {
                            None => None,
                            Some("none") => Some(ParagraphListType::None),
                            Some("ordered") => Some(ParagraphListType::Ordered),
                            Some("unordered") => Some(ParagraphListType::Unordered),
                            Some(_) => return Err(JsValue::from_str("INVALID_TEXT_PROPERTIES")),
                        };
                        Ok(ParagraphStyleRun {
                            start: run.start,
                            indentation: run.indentation,
                            list_type,
                            list_spacing: run.list_spacing,
                            paragraph_spacing: run.paragraph_spacing,
                            paragraph_indent: run.paragraph_indent,
                            line_height: run.line_height,
                            line_height_unit: match run.line_height_unit.as_deref() {
                                None | Some("pixels") => None,
                                Some("percent") => Some(LineHeightUnit::Percent),
                                Some("auto") => Some(LineHeightUnit::Auto),
                                Some(_) => {
                                    return Err(JsValue::from_str("INVALID_TEXT_PROPERTIES"));
                                }
                            },
                            text_wrap_style: match run.text_wrap_style.as_deref() {
                                None => None,
                                Some("auto") => Some(TextWrapStyle::Auto),
                                Some("balance") => Some(TextWrapStyle::Balance),
                                Some("pretty") => Some(TextWrapStyle::Pretty),
                                Some(_) => {
                                    return Err(JsValue::from_str("INVALID_TEXT_PROPERTIES"));
                                }
                            },
                        })
                    })
                    .collect::<Result<Vec<_>, JsValue>>()?,
                auto_size: match properties.auto_size.as_str() {
                    "fixed" => TextAutoSize::Fixed,
                    "height" => TextAutoSize::Height,
                    "widthAndHeight" => TextAutoSize::WidthAndHeight,
                    _ => return Err(JsValue::from_str("INVALID_TEXT_PROPERTIES")),
                },
                text_truncation: match properties.text_truncation.as_deref() {
                    None | Some("disabled") => TextTruncation::Disabled,
                    Some("ending") => TextTruncation::Ending,
                    _ => return Err(JsValue::from_str("INVALID_TEXT_PROPERTIES")),
                },
                max_lines: properties.max_lines,
                base_style: properties
                    .base_style
                    .as_ref()
                    .map(|style| {
                        Ok::<TextStyleRun, JsValue>(TextStyleRun {
                            start: 0,
                            end: 0,
                            font: style.font.as_ref().map(font_from_projection).transpose()?,
                            font_size: style.font_size,
                            font_weight: style.font_weight,
                            italic: style.italic,
                            letter_spacing: style.letter_spacing,
                            color: style
                                .color
                                .as_ref()
                                .map(color_from_projection)
                                .transpose()?,
                            fill_stack: style
                                .fill_stack
                                .as_ref()
                                .map(paint_stack_from_projection)
                                .transpose()?,
                            text_case: style
                                .text_case
                                .as_deref()
                                .map(text_case_from_projection)
                                .transpose()?
                                .flatten(),
                            hyperlink: style
                                .hyperlink
                                .as_ref()
                                .map(hyperlink_from_projection)
                                .transpose()?,
                            text_decoration: style
                                .text_decoration
                                .as_deref()
                                .map(text_decoration_from_projection)
                                .transpose()?
                                .flatten(),
                            text_decoration_style: style
                                .text_decoration_style
                                .as_deref()
                                .map(text_decoration_style_from_projection)
                                .transpose()?
                                .flatten(),
                            text_decoration_offset: style
                                .text_decoration_offset
                                .as_ref()
                                .map(text_decoration_offset_from_projection)
                                .transpose()?,
                            text_decoration_thickness: style
                                .text_decoration_thickness
                                .as_ref()
                                .map(text_decoration_thickness_from_projection)
                                .transpose()?,
                            text_decoration_color: style
                                .text_decoration_color
                                .as_ref()
                                .map(text_decoration_color_from_projection)
                                .transpose()?,
                            text_decoration_skip_ink: style
                                .text_decoration_skip_ink
                                .filter(|value| *value),
                            leading_trim: match style.leading_trim.as_deref() {
                                None | Some("none") => None,
                                Some("capHeight") => Some(LeadingTrim::CapHeight),
                                _ => return Err(JsValue::from_str("INVALID_TEXT_PROPERTIES")),
                            },
                            open_type_features: style
                                .open_type_features
                                .iter()
                                .map(|(tag, enabled)| OpenTypeFeature {
                                    tag: tag.clone(),
                                    enabled: *enabled,
                                })
                                .collect(),
                            text_style_id: style.text_style_id.clone(),
                            paint_style_id: style.paint_style_id.clone(),
                            variable_bindings: style
                                .variable_bindings
                                .as_deref()
                                .cloned()
                                .unwrap_or_default(),
                        })
                    })
                    .transpose()?,
                fallback_fonts: properties
                    .fallback_fonts
                    .iter()
                    .map(font_from_projection)
                    .collect::<Result<Vec<_>, JsValue>>()?,
            })
        })
        .transpose()
}

fn format_text_case(value: TextCase) -> &'static str {
    match value {
        TextCase::Original => "original",
        TextCase::Upper => "upper",
        TextCase::Lower => "lower",
        TextCase::Title => "title",
        TextCase::SmallCaps => "smallCaps",
        TextCase::SmallCapsForced => "smallCapsForced",
    }
}

fn projection_hyperlink(value: &HyperlinkTarget) -> ProjectionHyperlinkTarget {
    ProjectionHyperlinkTarget {
        r#type: match value.kind {
            HyperlinkType::Url => "URL",
            HyperlinkType::Node => "NODE",
        }
        .into(),
        value: value.value.clone(),
    }
}

fn format_text_decoration(value: TextDecoration) -> &'static str {
    match value {
        TextDecoration::Underline => "underline",
        TextDecoration::Strikethrough => "strikethrough",
    }
}

fn text_decoration_from_projection(value: &str) -> Result<Option<TextDecoration>, JsValue> {
    match value {
        "none" => Ok(None),
        "underline" => Ok(Some(TextDecoration::Underline)),
        "strikethrough" => Ok(Some(TextDecoration::Strikethrough)),
        _ => Err(JsValue::from_str("INVALID_TEXT_DECORATION")),
    }
}

fn format_text_decoration_style(value: TextDecorationStyle) -> &'static str {
    match value {
        TextDecorationStyle::Wavy => "wavy",
        TextDecorationStyle::Dotted => "dotted",
    }
}

fn text_decoration_style_from_projection(
    value: &str,
) -> Result<Option<TextDecorationStyle>, JsValue> {
    match value {
        "solid" => Ok(None),
        "wavy" => Ok(Some(TextDecorationStyle::Wavy)),
        "dotted" => Ok(Some(TextDecorationStyle::Dotted)),
        _ => Err(JsValue::from_str("INVALID_TEXT_DECORATION_STYLE")),
    }
}

fn projection_text_decoration_offset(
    value: TextDecorationOffset,
) -> ProjectionTextDecorationOffset {
    match value {
        TextDecorationOffset::Pixels(value) => ProjectionTextDecorationOffset {
            value,
            unit: "pixels".into(),
        },
        TextDecorationOffset::Percent(value) => ProjectionTextDecorationOffset {
            value,
            unit: "percent".into(),
        },
    }
}

fn text_decoration_offset_from_projection(
    value: &ProjectionTextDecorationOffset,
) -> Result<TextDecorationOffset, JsValue> {
    match value.unit.as_str() {
        "pixels" => Ok(TextDecorationOffset::Pixels(value.value)),
        "percent" => Ok(TextDecorationOffset::Percent(value.value)),
        _ => Err(JsValue::from_str("INVALID_TEXT_DECORATION_OFFSET")),
    }
}

fn projection_text_decoration_thickness(
    value: TextDecorationThickness,
) -> ProjectionTextDecorationThickness {
    match value {
        TextDecorationThickness::Pixels(value) => ProjectionTextDecorationThickness {
            value,
            unit: "pixels".into(),
        },
        TextDecorationThickness::Percent(value) => ProjectionTextDecorationThickness {
            value,
            unit: "percent".into(),
        },
    }
}

fn text_decoration_thickness_from_projection(
    value: &ProjectionTextDecorationThickness,
) -> Result<TextDecorationThickness, JsValue> {
    match value.unit.as_str() {
        "pixels" => Ok(TextDecorationThickness::Pixels(value.value)),
        "percent" => Ok(TextDecorationThickness::Percent(value.value)),
        _ => Err(JsValue::from_str("INVALID_TEXT_DECORATION_THICKNESS")),
    }
}

fn projection_text_decoration_color(value: TextDecorationColor) -> ProjectionTextDecorationColor {
    ProjectionTextDecorationColor {
        color: projection_color(value.color),
        visible: value.visible,
        opacity: value.opacity,
        blend_mode: format_blend_mode(value.blend_mode).into(),
    }
}

fn text_decoration_color_from_projection(
    value: &ProjectionTextDecorationColor,
) -> Result<TextDecorationColor, JsValue> {
    let blend_mode = parse_blend_mode(&value.blend_mode)?;
    if matches!(blend_mode, BlendMode::PassThrough) {
        return Err(JsValue::from_str("INVALID_TEXT_DECORATION_COLOR"));
    }
    Ok(TextDecorationColor {
        color: color_from_projection(&value.color)?,
        visible: value.visible,
        opacity: value.opacity,
        blend_mode,
    })
}

fn hyperlink_from_projection(
    value: &ProjectionHyperlinkTarget,
) -> Result<HyperlinkTarget, JsValue> {
    let kind = match value.r#type.as_str() {
        "URL" => HyperlinkType::Url,
        "NODE" => HyperlinkType::Node,
        _ => return Err(JsValue::from_str("INVALID_TEXT_HYPERLINK")),
    };
    Ok(HyperlinkTarget {
        kind,
        value: value.value.clone(),
    })
}

fn text_case_from_projection(value: &str) -> Result<Option<TextCase>, JsValue> {
    match value {
        "original" => Ok(None),
        "upper" => Ok(Some(TextCase::Upper)),
        "lower" => Ok(Some(TextCase::Lower)),
        "title" => Ok(Some(TextCase::Title)),
        "smallCaps" => Ok(Some(TextCase::SmallCaps)),
        "smallCapsForced" => Ok(Some(TextCase::SmallCapsForced)),
        _ => Err(JsValue::from_str("INVALID_TEXT_CASE")),
    }
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

fn paint_style_links_from_projection(node: &ProjectionNode) -> PaintStyleLinks {
    PaintStyleLinks {
        fill: node.fill_style_id.clone().filter(|value| !value.is_empty()),
        stroke: node
            .stroke_style_id
            .clone()
            .filter(|value| !value.is_empty()),
        background: node
            .background_style_id
            .clone()
            .filter(|value| !value.is_empty()),
    }
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
    let fills = node
        .fills
        .iter()
        .map(|paint| {
            paint_from_projection(&paint.css, paint.color.as_ref(), paint.gradient.as_ref())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let strokes = node
        .strokes
        .iter()
        .map(|paint| {
            paint_from_projection(&paint.css, paint.color.as_ref(), paint.gradient.as_ref())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let id = parse_id(&node.id)?;
    let position = node
        .position_id
        .as_deref()
        .map(parse_position_id)
        .transpose()?
        .unwrap_or_else(|| PositionId::for_node(id));
    let kind = parse_kind(&node.kind)?;
    let clips_content = node.clips_content.unwrap_or(kind == NodeKind::Frame);
    let boolean_operation = node
        .boolean_operation
        .as_deref()
        .map(parse_boolean_operation)
        .transpose()?
        .or_else(|| default_boolean_operation(&kind));
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
        arc_data: node.arc_data.map(|arc| ArcData {
            starting_angle: arc.starting_angle,
            ending_angle: arc.ending_angle,
            inner_radius: arc.inner_radius,
        }),
        parametric_shape: node.parametric_shape.map(|shape| match shape {
            ProjectionParametricShape::Polygon { point_count } => {
                ParametricShape::Polygon { point_count }
            }
            ProjectionParametricShape::Star {
                point_count,
                inner_ratio,
            } => ParametricShape::Star {
                point_count,
                inner_ratio,
            },
        }),
        vector_path: node
            .vector_path
            .map(vector_path_from_projection)
            .transpose()?,
        boolean_operation,
        relative_transform: node.relative_transform.map(|matrix| {
            editor_core::geometry::AffineTransform {
                a: matrix.a,
                b: matrix.b,
                c: matrix.c,
                d: matrix.d,
                e: matrix.e,
                f: matrix.f,
            }
        }),
        opacity: node.opacity,
        blend_mode: parse_blend_mode(&node.blend_mode)?,
        drop_shadow: node
            .drop_shadow
            .map(|shadow| {
                Ok::<DropShadow, JsValue>(DropShadow {
                    offset_x: shadow.offset_x,
                    offset_y: shadow.offset_y,
                    blur_radius: shadow.blur_radius,
                    spread: shadow.spread,
                    color: color_from_projection(&shadow.color)?,
                    visible: shadow.visible,
                })
            })
            .transpose()?,
        effect_stack: node
            .effect_stack
            .into_iter()
            .map(effect_from_projection)
            .collect::<Result<Vec<_>, _>>()?,
        corner_radius: node.corner_radius,
        corner_radii: node.corner_radii,
        corner_smoothing: node.corner_smoothing,
        constraints: node
            .constraints
            .map(|value| {
                Ok::<Constraints, JsValue>(Constraints {
                    horizontal: parse_constraint_type(&value.horizontal)?,
                    vertical: parse_constraint_type(&value.vertical)?,
                })
            })
            .transpose()?,
        text: node.text,
        visible: node.visible,
        locked: node.locked,
        contents_hidden: node.contents_hidden,
        clips_content,
        extensions: node.extensions.into_iter().collect(),
    })
}

fn projection_auto_layout(layout: AutoLayout) -> Option<ProjectionAutoLayout> {
    (layout != AutoLayout::default()).then(|| ProjectionAutoLayout {
        mode: match layout.mode {
            LayoutMode::None => "none",
            LayoutMode::Horizontal => "horizontal",
            LayoutMode::Vertical => "vertical",
            LayoutMode::Grid => "grid",
        }
        .into(),
        padding: layout.padding,
        item_spacing: layout.item_spacing,
        track_spacing: layout.track_spacing,
        track_alignment: (layout.track_alignment != WrapTrackAlignment::Auto)
            .then(|| format_wrap_track_alignment(layout.track_alignment).to_owned()),
        wrap: layout.wrap,
        primary_alignment: format_layout_alignment(layout.primary_alignment).into(),
        counter_alignment: format_layout_alignment(layout.counter_alignment).into(),
        primary_sizing: format_layout_sizing(layout.primary_sizing).into(),
        counter_sizing: format_layout_sizing(layout.counter_sizing).into(),
        min_width: layout.min_width,
        max_width: layout.max_width,
        min_height: layout.min_height,
        max_height: layout.max_height,
        absolute: layout.absolute,
        align_self: layout
            .align_self
            .map(format_layout_alignment)
            .map(str::to_owned),
        grid_rows: layout
            .grid_rows
            .into_iter()
            .map(projection_grid_track)
            .collect(),
        grid_columns: layout
            .grid_columns
            .into_iter()
            .map(projection_grid_track)
            .collect(),
        grid_row_gap: layout.grid_row_gap,
        grid_column_gap: layout.grid_column_gap,
        grid_row_span: layout.grid_row_span,
        grid_column_span: layout.grid_column_span,
        grid_items_positioning: (layout.grid_items_positioning == GridItemsPositioning::Manual)
            .then(|| "manual".into()),
        grid_row_anchor: layout.grid_row_anchor,
        grid_column_anchor: layout.grid_column_anchor,
    })
}

fn projection_grid_track(track: GridTrack) -> ProjectionGridTrack {
    match track {
        GridTrack::Flex(value) => ProjectionGridTrack {
            r#type: "flex".into(),
            value: Some(value),
        },
        GridTrack::Fixed(value) => ProjectionGridTrack {
            r#type: "fixed".into(),
            value: Some(value),
        },
        GridTrack::Hug => ProjectionGridTrack {
            r#type: "hug".into(),
            value: None,
        },
    }
}

fn grid_track_from_projection(track: &ProjectionGridTrack) -> Result<GridTrack, JsValue> {
    match track.r#type.as_str() {
        "flex" => Ok(GridTrack::Flex(
            track
                .value
                .ok_or_else(|| JsValue::from_str("INVALID_AUTO_LAYOUT"))?,
        )),
        "fixed" => Ok(GridTrack::Fixed(
            track
                .value
                .ok_or_else(|| JsValue::from_str("INVALID_AUTO_LAYOUT"))?,
        )),
        "hug" if track.value.is_none() => Ok(GridTrack::Hug),
        _ => Err(JsValue::from_str("INVALID_AUTO_LAYOUT")),
    }
}

fn auto_layout_from_projection(
    value: Option<&ProjectionAutoLayout>,
) -> Result<AutoLayout, JsValue> {
    let Some(value) = value else {
        return Ok(AutoLayout::default());
    };
    let mode = match value.mode.as_str() {
        "none" => LayoutMode::None,
        "horizontal" => LayoutMode::Horizontal,
        "vertical" => LayoutMode::Vertical,
        "grid" => LayoutMode::Grid,
        _ => return Err(JsValue::from_str("INVALID_AUTO_LAYOUT")),
    };
    let align_self = value
        .align_self
        .as_deref()
        .map(parse_layout_alignment)
        .transpose()?;
    if matches!(
        align_self,
        Some(LayoutAlignment::SpaceBetween | LayoutAlignment::Baseline)
    ) {
        return Err(JsValue::from_str("INVALID_AUTO_LAYOUT"));
    }
    let track_alignment = value
        .track_alignment
        .as_deref()
        .map(parse_wrap_track_alignment)
        .transpose()?
        .unwrap_or(WrapTrackAlignment::Auto);
    let grid_items_positioning = match value.grid_items_positioning.as_deref() {
        None | Some("rowAutoFlow") => GridItemsPositioning::RowAutoFlow,
        Some("manual") => GridItemsPositioning::Manual,
        Some(_) => return Err(JsValue::from_str("INVALID_AUTO_LAYOUT")),
    };
    let layout = AutoLayout {
        mode,
        padding: value.padding,
        item_spacing: value.item_spacing,
        track_spacing: value.track_spacing,
        track_alignment,
        wrap: value.wrap,
        primary_alignment: parse_layout_alignment(&value.primary_alignment)?,
        counter_alignment: parse_layout_alignment(&value.counter_alignment)?,
        primary_sizing: parse_layout_sizing(&value.primary_sizing)?,
        counter_sizing: parse_layout_sizing(&value.counter_sizing)?,
        min_width: value.min_width,
        max_width: value.max_width,
        min_height: value.min_height,
        max_height: value.max_height,
        absolute: value.absolute,
        align_self,
        grid_rows: value
            .grid_rows
            .iter()
            .map(grid_track_from_projection)
            .collect::<Result<_, _>>()?,
        grid_columns: value
            .grid_columns
            .iter()
            .map(grid_track_from_projection)
            .collect::<Result<_, _>>()?,
        grid_row_gap: value.grid_row_gap,
        grid_column_gap: value.grid_column_gap,
        grid_row_span: value.grid_row_span,
        grid_column_span: value.grid_column_span,
        grid_items_positioning,
        grid_row_anchor: value.grid_row_anchor,
        grid_column_anchor: value.grid_column_anchor,
    };
    if matches!(layout.primary_alignment, LayoutAlignment::Baseline)
        || matches!(layout.counter_alignment, LayoutAlignment::SpaceBetween)
        || (layout.counter_alignment == LayoutAlignment::Baseline
            && layout.mode != LayoutMode::Horizontal)
        || (!layout.wrap && layout.track_alignment != WrapTrackAlignment::Auto)
    {
        return Err(JsValue::from_str("INVALID_AUTO_LAYOUT"));
    }
    Ok(layout)
}

fn format_layout_alignment(value: LayoutAlignment) -> &'static str {
    match value {
        LayoutAlignment::Start => "start",
        LayoutAlignment::Center => "center",
        LayoutAlignment::End => "end",
        LayoutAlignment::SpaceBetween => "spaceBetween",
        LayoutAlignment::Baseline => "baseline",
    }
}

fn parse_layout_alignment(value: &str) -> Result<LayoutAlignment, JsValue> {
    match value {
        "start" => Ok(LayoutAlignment::Start),
        "center" => Ok(LayoutAlignment::Center),
        "end" => Ok(LayoutAlignment::End),
        "spaceBetween" => Ok(LayoutAlignment::SpaceBetween),
        "baseline" => Ok(LayoutAlignment::Baseline),
        _ => Err(JsValue::from_str("INVALID_AUTO_LAYOUT")),
    }
}

fn format_wrap_track_alignment(value: WrapTrackAlignment) -> &'static str {
    match value {
        WrapTrackAlignment::Auto => "auto",
        WrapTrackAlignment::SpaceBetween => "spaceBetween",
    }
}

fn parse_wrap_track_alignment(value: &str) -> Result<WrapTrackAlignment, JsValue> {
    match value {
        "auto" => Ok(WrapTrackAlignment::Auto),
        "spaceBetween" => Ok(WrapTrackAlignment::SpaceBetween),
        _ => Err(JsValue::from_str("INVALID_AUTO_LAYOUT")),
    }
}

fn format_layout_sizing(value: LayoutSizing) -> &'static str {
    match value {
        LayoutSizing::Fixed => "fixed",
        LayoutSizing::Hug => "hug",
        LayoutSizing::Fill => "fill",
    }
}

fn parse_layout_sizing(value: &str) -> Result<LayoutSizing, JsValue> {
    match value {
        "fixed" => Ok(LayoutSizing::Fixed),
        "hug" => Ok(LayoutSizing::Hug),
        "fill" => Ok(LayoutSizing::Fill),
        _ => Err(JsValue::from_str("INVALID_AUTO_LAYOUT")),
    }
}

fn projection_effect(effect: Effect) -> ProjectionEffect {
    match effect {
        Effect::DropShadow(shadow) => ProjectionEffect::DropShadow(ProjectionDropShadow {
            offset_x: shadow.offset_x,
            offset_y: shadow.offset_y,
            blur_radius: shadow.blur_radius,
            spread: shadow.spread,
            color: projection_color(shadow.color),
            visible: shadow.visible,
        }),
        Effect::LayerBlur(blur) => ProjectionEffect::LayerBlur(ProjectionLayerBlur {
            radius: blur.radius,
            visible: blur.visible,
        }),
        Effect::InnerShadow(shadow) => ProjectionEffect::InnerShadow(ProjectionInnerShadow {
            offset_x: shadow.offset_x,
            offset_y: shadow.offset_y,
            blur_radius: shadow.blur_radius,
            spread: shadow.spread,
            color: projection_color(shadow.color),
            visible: shadow.visible,
        }),
        Effect::BackgroundBlur(blur) => {
            ProjectionEffect::BackgroundBlur(ProjectionBackgroundBlur {
                radius: blur.radius,
                visible: blur.visible,
            })
        }
    }
}

fn effect_from_projection(effect: ProjectionEffect) -> Result<Effect, JsValue> {
    match effect {
        ProjectionEffect::DropShadow(shadow) => Ok(Effect::DropShadow(DropShadow {
            offset_x: shadow.offset_x,
            offset_y: shadow.offset_y,
            blur_radius: shadow.blur_radius,
            spread: shadow.spread,
            color: color_from_projection(&shadow.color)?,
            visible: shadow.visible,
        })),
        ProjectionEffect::LayerBlur(blur) => Ok(Effect::LayerBlur(LayerBlur {
            radius: blur.radius,
            visible: blur.visible,
        })),
        ProjectionEffect::InnerShadow(shadow) => Ok(Effect::InnerShadow(InnerShadow {
            offset_x: shadow.offset_x,
            offset_y: shadow.offset_y,
            blur_radius: shadow.blur_radius,
            spread: shadow.spread,
            color: color_from_projection(&shadow.color)?,
            visible: shadow.visible,
        })),
        ProjectionEffect::BackgroundBlur(blur) => Ok(Effect::BackgroundBlur(BackgroundBlur {
            radius: blur.radius,
            visible: blur.visible,
        })),
    }
}

fn projection_vector_path(path: &VectorPath) -> ProjectionVectorPath {
    ProjectionVectorPath {
        fill_rule: match path.fill_rule {
            FillRule::NonZero => "nonZero",
            FillRule::EvenOdd => "evenOdd",
        }
        .into(),
        subpaths: path
            .subpaths
            .iter()
            .map(|subpath| ProjectionVectorSubpath {
                closed: subpath.closed,
                points: subpath
                    .points
                    .iter()
                    .map(|point| ProjectionVectorPoint {
                        id: format_uuid(NodeId(point.id.0)),
                        x: point.position.x,
                        y: point.position.y,
                        handle_in: point.handle_in.map(|handle| ProjectionVectorHandle {
                            x: handle.x,
                            y: handle.y,
                        }),
                        handle_out: point.handle_out.map(|handle| ProjectionVectorHandle {
                            x: handle.x,
                            y: handle.y,
                        }),
                        point_type: match point.point_type {
                            VectorPointType::Corner => "corner",
                            VectorPointType::Mirrored => "mirrored",
                            VectorPointType::Asymmetric => "asymmetric",
                        }
                        .into(),
                    })
                    .collect(),
            })
            .collect(),
    }
}

fn vector_path_from_projection(path: ProjectionVectorPath) -> Result<VectorPath, JsValue> {
    let fill_rule = match path.fill_rule.as_str() {
        "nonZero" => FillRule::NonZero,
        "evenOdd" => FillRule::EvenOdd,
        _ => return Err(JsValue::from_str("INVALID_VECTOR_PATH")),
    };
    let subpaths = path
        .subpaths
        .into_iter()
        .map(|subpath| {
            Ok(VectorSubpath {
                closed: subpath.closed,
                points: subpath
                    .points
                    .into_iter()
                    .map(vector_point_from_projection)
                    .collect::<Result<Vec<_>, JsValue>>()?,
            })
        })
        .collect::<Result<Vec<_>, JsValue>>()?;
    Ok(VectorPath {
        fill_rule,
        subpaths,
    })
}

fn vector_point_from_projection(point: ProjectionVectorPoint) -> Result<VectorPoint, JsValue> {
    let point_type = match point.point_type.as_str() {
        "corner" => VectorPointType::Corner,
        "mirrored" => VectorPointType::Mirrored,
        "asymmetric" => VectorPointType::Asymmetric,
        _ => return Err(JsValue::from_str("INVALID_VECTOR_PATH")),
    };
    let position =
        Point::new(point.x, point.y).map_err(|_| JsValue::from_str("INVALID_VECTOR_POINT"))?;
    let handle = |handle: ProjectionVectorHandle| {
        Point::new(handle.x, handle.y).map_err(|_| JsValue::from_str("INVALID_VECTOR_HANDLE"))
    };
    Ok(VectorPoint {
        id: PointId(parse_id(&point.id)?.0),
        position,
        handle_in: point.handle_in.map(handle).transpose()?,
        handle_out: point.handle_out.map(handle).transpose()?,
        point_type,
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

    #[test]
    fn projection_parametric_shapes_accept_browser_camel_case_fields() {
        let polygon: ProjectionParametricShape =
            serde_json::from_str(r#"{"kind":"polygon","pointCount":5}"#).unwrap();
        assert!(matches!(
            polygon,
            ProjectionParametricShape::Polygon { point_count: 5 }
        ));

        let star: ProjectionParametricShape =
            serde_json::from_str(r#"{"kind":"star","pointCount":6,"innerRatio":0.45}"#).unwrap();
        assert!(matches!(
            star,
            ProjectionParametricShape::Star {
                point_count: 6,
                inner_ratio,
            } if (inner_ratio - 0.45).abs() < f64::EPSILON
        ));
    }

    #[test]
    fn parametric_shape_conversion_is_one_undoable_create_delete_reposition_batch() {
        let mut engine = DocumentEngine::new();
        let mut polygon: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-000000000611",
            "name": "Polygon", "kind": "polygon",
            "x": 10.0, "y": 20.0, "width": 90.0, "height": 50.0,
            "fill": "#d9f99d", "opacity": 1.0, "cornerRadius": 0.0,
            "text": "", "visible": true, "locked": false, "contentsHidden": false,
            "positionId": "00000000000000000000000000000061:00000000000000000000000000000000",
            "parametricShape": { "kind": "polygon", "pointCount": 3 }
        }))
        .unwrap();
        let mut root = polygon.clone();
        root.id = "00000000-0000-4000-8000-000000000610".into();
        root.name = "Root".into();
        root.kind = "frame".into();
        root.x = 0.0;
        root.y = 0.0;
        root.width = 400.0;
        root.height = 300.0;
        root.parametric_shape = None;
        root.parent_id = None;
        root.relative_transform = None;
        root.position_id =
            Some("00000000000000000000000000000060:00000000000000000000000000000000".into());
        polygon.parent_id = Some(root.id.clone());
        polygon.relative_transform = Some(ProjectionTransform {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            e: 10.0,
            f: 20.0,
        });
        engine
            .submit_batch(
                NodeId(0x611),
                0,
                vec![
                    BatchCommand::Create { node: root },
                    BatchCommand::Create {
                        node: polygon.clone(),
                    },
                ],
            )
            .unwrap();

        polygon.id = "00000000-0000-4000-8000-000000000612".into();
        polygon.name = "Polygon vector".into();
        polygon.kind = "vector".into();
        polygon.position_id =
            Some("00000000000000000000000000000612:00000000000000000000000000000000".into());
        polygon.parametric_shape = None;
        polygon.vector_path = Some(ProjectionVectorPath {
            fill_rule: "nonZero".into(),
            subpaths: vec![ProjectionVectorSubpath {
                closed: true,
                points: vec![
                    ProjectionVectorPoint {
                        id: "00000000-0000-4000-8000-000000000613".into(),
                        x: 45.0,
                        y: 0.0,
                        handle_in: None,
                        handle_out: None,
                        point_type: "corner".into(),
                    },
                    ProjectionVectorPoint {
                        id: "00000000-0000-4000-8000-000000000614".into(),
                        x: 90.0,
                        y: 50.0,
                        handle_in: None,
                        handle_out: None,
                        point_type: "corner".into(),
                    },
                    ProjectionVectorPoint {
                        id: "00000000-0000-4000-8000-000000000615".into(),
                        x: 0.0,
                        y: 50.0,
                        handle_in: None,
                        handle_out: None,
                        point_type: "corner".into(),
                    },
                ],
            }],
        });
        engine
            .submit_batch(
                NodeId(0x612),
                1,
                vec![
                    BatchCommand::Create { node: polygon },
                    BatchCommand::Delete {
                        ids: vec!["00000000-0000-4000-8000-000000000611".into()],
                    },
                    BatchCommand::Reposition {
                        position_ids: vec![PositionUpdate {
                            id: "00000000-0000-4000-8000-000000000612".into(),
                            position_id:
                                "00000000000000000000000000000061:00000000000000000000000000000000"
                                    .into(),
                        }],
                    },
                ],
            )
            .unwrap();

        assert_eq!(engine.document.revision, 2);
        assert_eq!(
            engine
                .document
                .node(parse_id("00000000-0000-4000-8000-000000000612").unwrap())
                .unwrap()
                .kind,
            NodeKind::Vector
        );
        engine.document.undo().unwrap();
        assert_eq!(
            engine
                .document
                .node(parse_id("00000000-0000-4000-8000-000000000611").unwrap())
                .unwrap()
                .kind,
            NodeKind::Polygon
        );
    }

    #[test]
    fn component_conversion_is_one_undoable_create_reparent_delete_reposition_batch() {
        let mut engine = DocumentEngine::new();
        let root_id = "00000000-0000-4000-8000-000000000620";
        let source_id = "00000000-0000-4000-8000-000000000621";
        let child_id = "00000000-0000-4000-8000-000000000622";
        let component_id = "00000000-0000-4000-8000-000000000623";
        let source_position = "00000000000000000000000000000061:00000000000000000000000000000000";
        let child_position = "00000000000000000000000000000062:00000000000000000000000000000000";
        let temporary_position =
            "fffffffffffffffffffffffffffffffe:00000000000000000000000000000623";

        let root: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": root_id, "name": "Root", "kind": "frame",
            "x": 0.0, "y": 0.0, "width": 400.0, "height": 300.0,
            "fill": "transparent", "opacity": 1.0, "cornerRadius": 0.0,
            "text": "", "visible": true, "locked": false, "contentsHidden": false,
            "positionId": "00000000000000000000000000000060:00000000000000000000000000000000"
        }))
        .unwrap();
        let mut source = root.clone();
        source.id = source_id.into();
        source.parent_id = Some(root_id.into());
        source.name = "Card".into();
        source.x = 10.0;
        source.y = 20.0;
        source.width = 160.0;
        source.height = 100.0;
        source.relative_transform = Some(ProjectionTransform {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            e: 10.0,
            f: 20.0,
        });
        source.position_id = Some(source_position.into());

        let mut child = root.clone();
        child.id = child_id.into();
        child.parent_id = Some(source_id.into());
        child.name = "Label background".into();
        child.kind = "rectangle".into();
        child.x = 4.0;
        child.y = 5.0;
        child.width = 80.0;
        child.height = 24.0;
        child.relative_transform = Some(ProjectionTransform {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            e: 4.0,
            f: 5.0,
        });
        child.position_id = Some(child_position.into());

        engine
            .submit_batch(
                NodeId(0x622),
                0,
                vec![
                    BatchCommand::Create { node: root.clone() },
                    BatchCommand::Create {
                        node: source.clone(),
                    },
                    BatchCommand::Create {
                        node: child.clone(),
                    },
                ],
            )
            .unwrap();

        let mut component = source.clone();
        component.id = component_id.into();
        component.kind = "component".into();
        component.position_id = Some(temporary_position.into());
        engine
            .submit_batch(
                NodeId(0x623),
                1,
                vec![
                    BatchCommand::Create { node: component },
                    BatchCommand::Reparent {
                        parent_ids: vec![ParentUpdate {
                            id: child_id.into(),
                            parent_id: Some(component_id.into()),
                            position_id: child_position.into(),
                        }],
                    },
                    BatchCommand::Delete {
                        ids: vec![source_id.into()],
                    },
                    BatchCommand::Reposition {
                        position_ids: vec![PositionUpdate {
                            id: component_id.into(),
                            position_id: source_position.into(),
                        }],
                    },
                ],
            )
            .unwrap();

        let source_core_id = parse_id(source_id).unwrap();
        let child_core_id = parse_id(child_id).unwrap();
        let component_core_id = parse_id(component_id).unwrap();
        assert_eq!(engine.document.revision, 2);
        assert!(engine.document.node(source_core_id).is_none());
        let component = engine.document.node(component_core_id).unwrap();
        assert_eq!(component.kind, NodeKind::Component);
        assert_eq!(
            component.position,
            parse_position_id(source_position).unwrap()
        );
        let child = engine.document.node(child_core_id).unwrap();
        assert_eq!(child.parent_id, Some(component_core_id));
        assert_eq!(child.x, 4.0);
        assert_eq!(child.y, 5.0);

        engine.document.undo().unwrap();
        assert!(engine.document.node(component_core_id).is_none());
        assert_eq!(
            engine.document.node(child_core_id).unwrap().parent_id,
            Some(source_core_id)
        );
        assert_eq!(
            engine.document.node(source_core_id).unwrap().kind,
            NodeKind::Frame
        );
    }

    #[test]
    fn component_set_last_child_reparent_dissolves_through_the_batch_bridge() {
        let mut engine = DocumentEngine::new();
        let set_id = "00000000-0000-4000-8000-000000000630";
        let component_id = "00000000-0000-4000-8000-000000000631";
        let component_set: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": set_id, "name": "Button variants", "kind": "componentSet",
            "x": 0.0, "y": 0.0, "width": 240.0, "height": 120.0,
            "fill": "transparent", "opacity": 1.0, "cornerRadius": 0.0,
            "text": "", "visible": true, "locked": false, "contentsHidden": false,
            "positionId": "00000000000000000000000000000063:00000000000000000000000000000000"
        }))
        .unwrap();
        let mut component = component_set.clone();
        component.id = component_id.into();
        component.parent_id = Some(set_id.into());
        component.name = "State=Default".into();
        component.kind = "component".into();
        component.width = 100.0;
        component.height = 40.0;
        component.position_id =
            Some("00000000000000000000000000000064:00000000000000000000000000000000".into());
        engine
            .submit_batch(
                NodeId(0x630),
                0,
                vec![
                    BatchCommand::Create {
                        node: component_set,
                    },
                    BatchCommand::Create { node: component },
                ],
            )
            .unwrap();
        let grouped_hash = engine.document.canonical_hash();

        engine
            .submit_batch(
                NodeId(0x631),
                1,
                vec![BatchCommand::Reparent {
                    parent_ids: vec![ParentUpdate {
                        id: component_id.into(),
                        parent_id: None,
                        position_id:
                            "00000000000000000000000000000065:00000000000000000000000000000000"
                                .into(),
                    }],
                }],
            )
            .unwrap();

        let set_core_id = parse_id(set_id).unwrap();
        let component_core_id = parse_id(component_id).unwrap();
        assert!(engine.document.node(set_core_id).is_none());
        assert_eq!(
            engine.document.node(component_core_id).unwrap().parent_id,
            None
        );

        engine.document.undo().unwrap();
        assert_eq!(engine.document.canonical_hash(), grouped_hash);
        assert_eq!(
            engine.document.node(component_core_id).unwrap().parent_id,
            Some(set_core_id)
        );
        assert_eq!(
            engine.document.node(set_core_id).unwrap().kind,
            NodeKind::ComponentSet
        );
    }

    #[test]
    fn parametric_shape_geometry_bridge_returns_core_derived_clockwise_outline() {
        let polygon: serde_json::Value = serde_json::from_str(
            &parametric_shape_outline_json(100.0, 80.0, r#"{"kind":"polygon","pointCount":5}"#)
                .unwrap(),
        )
        .unwrap();
        let points = polygon["points"].as_array().unwrap();
        assert_eq!(points.len(), 5);
        assert_eq!(points[0], serde_json::json!([50.0, 0.0]));
        assert_eq!(polygon["bounds"]["min"][1], serde_json::json!(0.0));
        assert!(polygon["bounds"]["max"][0].as_f64().unwrap() <= 100.0);

        let star: serde_json::Value = serde_json::from_str(
            &parametric_shape_outline_json(
                100.0,
                80.0,
                r#"{"kind":"star","pointCount":5,"innerRatio":0.4}"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(star["points"].as_array().unwrap().len(), 10);
    }

    #[test]
    fn parametric_shape_hit_bridge_uses_core_non_zero_fill() {
        assert!(
            parametric_shape_contains_point_json(
                100.0,
                80.0,
                r#"{"kind":"polygon","pointCount":5}"#,
                50.0,
                40.0
            )
            .unwrap()
        );
        assert!(
            !parametric_shape_contains_point_json(
                100.0,
                80.0,
                r#"{"kind":"polygon","pointCount":5}"#,
                0.0,
                79.0
            )
            .unwrap()
        );
        assert!(
            parametric_shape_contains_point_json(
                100.0,
                100.0,
                r#"{"kind":"star","pointCount":5,"innerRatio":0.4}"#,
                50.0,
                50.0
            )
            .unwrap()
        );
    }

    #[test]
    fn legacy_seed_assets_are_available_before_seeded_image_nodes() {
        let mut engine = DocumentEngine::new();
        engine
            .seed_assets_json(
                r#"[{"assetId":"00000000-0000-4000-8000-00000000a001","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","mediaType":"image/png","byteLength":172,"pixelWidth":24,"pixelHeight":16}]"#,
            )
            .unwrap();

        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../fixtures/documents/phase2-common-nodes.fixture.json"
        ))
        .unwrap();
        let mut node = fixture["nodes"][0].clone();
        node["id"] = serde_json::json!("00000000-0000-4000-8000-00000000a002");
        node["name"] = serde_json::json!("Seeded image");
        node["kind"] = serde_json::json!("image");
        node["assetId"] = serde_json::json!("00000000-0000-4000-8000-00000000a001");
        node["clipsContent"] = serde_json::json!(false);
        node["cornerRadius"] = node
            .get("radius")
            .cloned()
            .unwrap_or_else(|| serde_json::json!(0));
        node["locked"] = node
            .get("locked")
            .cloned()
            .unwrap_or_else(|| serde_json::json!(false));

        engine
            .seed_batch_json(
                &serde_json::to_string(&vec![serde_json::json!({
                    "type": "create",
                    "node": node,
                })])
                .unwrap(),
            )
            .unwrap();

        let snapshot: serde_json::Value = serde_json::from_str(&engine.snapshot_json()).unwrap();
        assert_eq!(snapshot["resourceIndex"].as_array().map(Vec::len), Some(1));
        assert_eq!(
            snapshot["nodes"][0]["assetId"],
            "00000000-0000-4000-8000-00000000a001"
        );
    }

    #[test]
    fn document_identity_is_seeded_without_a_snapshot_round_trip() {
        let mut engine = DocumentEngine::new();
        let document_id = "00000000-0000-4000-8000-00000000f002";
        engine.seed_document_id(document_id).unwrap();
        engine
            .seed_batch_json(
                r##"[{"type":"create","node":{"id":"00000000-0000-4000-8000-00000000f003","name":"Seeded rectangle","kind":"rectangle","x":0,"y":0,"width":10,"height":10,"rotation":0,"fill":"#ffffff","stroke":"#00000000","strokeWidth":0,"opacity":1,"cornerRadius":0,"visible":true,"locked":false,"text":"","positionId":"00000000000000000000000000000001:00000000000000000000000000000000"}}]"##,
            )
            .unwrap();

        let snapshot: serde_json::Value = serde_json::from_str(&engine.snapshot_json()).unwrap();
        assert_eq!(snapshot["documentId"], document_id);
        assert_eq!(
            engine.document.id(),
            DocumentId(parse_id(document_id).unwrap().0)
        );
    }

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
        assert!(
            mesh["triangles"]
                .as_array()
                .is_some_and(|triangles| triangles.len() > 2)
        );

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
            &stroke_mesh_for_rounded_rectangle_json(100.0, 60.0, 12.0, 8.0, "round", 4.0).unwrap(),
        )
        .unwrap();
        assert_eq!(rounded["bounds"]["min"], serde_json::json!([-4.0, -4.0]));
        assert_eq!(rounded["bounds"]["max"], serde_json::json!([104.0, 64.0]));

        let independent = serde_json::from_str::<serde_json::Value>(
            &stroke_mesh_for_rounded_rectangle_with_radii_json(
                100.0,
                60.0,
                "[12,24,8,16]",
                8.0,
                "round",
                4.0,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            independent["bounds"]["min"],
            serde_json::json!([-4.0, -4.0])
        );
        assert_eq!(
            independent["bounds"]["max"],
            serde_json::json!([104.0, 64.0])
        );

        let dashed_independent = serde_json::from_str::<serde_json::Value>(
            &stroke_mesh_for_dashed_rounded_rectangle_with_radii_json(
                100.0,
                60.0,
                "[12,24,8,16]",
                8.0,
                "[18,8]",
                "round",
                4.0,
            )
            .unwrap(),
        )
        .unwrap();
        assert!(
            dashed_independent["triangles"]
                .as_array()
                .is_some_and(|triangles| !triangles.is_empty())
        );

        let continuous = serde_json::from_str::<serde_json::Value>(
            &stroke_mesh_for_continuous_rounded_rectangle_with_radii_json(
                100.0,
                60.0,
                "[12,24,8,16]",
                0.5,
                8.0,
                "[18,8]",
                "round",
                4.0,
            )
            .unwrap(),
        )
        .unwrap();
        assert!(
            continuous["triangles"]
                .as_array()
                .is_some_and(|triangles| !triangles.is_empty())
        );

        let dashed = serde_json::from_str::<serde_json::Value>(
            &stroke_mesh_for_dashed_line_json(94.0, 10.0, "[8,4]", "square", "miter", 4.0).unwrap(),
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
        assert_eq!(
            per_side["meshes"][0]["bounds"]["min"],
            serde_json::json!([0.0, -6.0])
        );

        let dashed_per_side = serde_json::from_str::<serde_json::Value>(
            &stroke_meshes_for_per_side_rectangle_with_dash_json(
                100.0,
                80.0,
                "[6,2,4,8]",
                "outside",
                "[12,8]",
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            dashed_per_side["meshes"][0]["bounds"]["max"],
            serde_json::json!([92.0, 0.0])
        );

        let dashed_closed = serde_json::from_str::<serde_json::Value>(
            &stroke_mesh_for_dashed_polyline_json(
                "[[0,0],[100,0],[100,60],[0,60]]",
                4.0,
                "[120,20]",
                "butt",
                "miter",
                4.0,
                true,
            )
            .unwrap(),
        )
        .unwrap();
        assert!(
            dashed_closed["triangles"]
                .as_array()
                .is_some_and(|triangles| !triangles.is_empty())
        );
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
        assert!(
            arrow["triangles"]
                .as_array()
                .is_some_and(|triangles| !triangles.is_empty())
        );

        // Start dot: centred on the endpoint, radius size/2 = 8.
        let dot = serde_json::from_str::<serde_json::Value>(
            &decorative_cap_mesh_json("circleFilled", 0.0, -1.0, 4.0).unwrap(),
        )
        .unwrap();
        assert_eq!(dot["bounds"]["min"], serde_json::json!([-8.0, -8.0]));
        assert_eq!(dot["bounds"]["max"], serde_json::json!([8.0, 8.0]));
    }

    #[test]
    fn outlines_a_line_with_a_decorative_endpoint_as_closed_vectors() {
        let outline = serde_json::from_str::<serde_json::Value>(
            &line_outline_json(100.0, 3.0, "round", "arrowEquilateral", "round", 4.0).unwrap(),
        )
        .unwrap();
        let subpaths = outline["subpaths"].as_array().unwrap();
        assert!(!subpaths.is_empty());
        assert!(subpaths.iter().all(|path| {
            path["closed"] == serde_json::json!(true)
                && path["points"]
                    .as_array()
                    .is_some_and(|points| points.len() >= 3)
        }));
    }

    #[test]
    fn outlines_each_visible_dash_as_closed_vectors() {
        let outline = serde_json::from_str::<serde_json::Value>(
            &dashed_line_outline_json(40.0, 4.0, "[8,4]", "round", "round", 4.0).unwrap(),
        )
        .unwrap();
        let subpaths = outline["subpaths"].as_array().unwrap();
        assert_eq!(subpaths.len(), 4);
        assert!(
            subpaths
                .iter()
                .all(|path| path["closed"] == serde_json::json!(true))
        );
    }

    #[test]
    fn exposes_graphics_core_caret_map_without_utf8_splitting() {
        let layout = fallback_text_layout_json("A😀中", 2);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&layout).unwrap(),
            serde_json::json!({
                "lines": [
                    { "start": 0, "end": 5, "direction": "ltr", "visualRuns": [
                        { "start": 0, "end": 5, "direction": "ltr" },
                    ] },
                    { "start": 5, "end": 8, "direction": "ltr", "visualRuns": [
                        { "start": 5, "end": 8, "direction": "ltr" },
                    ] },
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
    fn exposes_fallback_mixed_bidi_runs_for_live_caret_affinity() {
        let layout =
            serde_json::from_str::<serde_json::Value>(&fallback_text_layout_json("AאבB", 20))
                .unwrap();
        let runs = layout["lines"][0]["visualRuns"].as_array().unwrap();
        assert_eq!(runs.len(), 3);
        assert_eq!(runs[0]["direction"], "ltr");
        assert_eq!(runs[1]["direction"], "rtl");
        assert_eq!(runs[2]["direction"], "ltr");
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
    fn exposes_deterministic_synthetic_font_style_rasters() {
        let regular = serde_json::from_str::<serde_json::Value>(
            &rasterize_glyph_with_style_json(
                font_test_data::NOTO_SERIF_DISPLAY_TRIMMED,
                0,
                "[]",
                400,
                false,
                1,
                48,
            )
            .unwrap(),
        )
        .unwrap();
        let bold_italic = serde_json::from_str::<serde_json::Value>(
            &rasterize_glyph_with_style_json(
                font_test_data::NOTO_SERIF_DISPLAY_TRIMMED,
                0,
                "[]",
                700,
                true,
                1,
                48,
            )
            .unwrap(),
        )
        .unwrap();

        assert_eq!(bold_italic["advanceX"], regular["advanceX"]);
        assert_eq!(bold_italic["ascent"], regular["ascent"]);
        assert_ne!(bold_italic["pixels"], regular["pixels"]);
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
        let positioned = result["lines"][0]["visualCarets"].as_array().unwrap();
        assert_eq!(positioned.first().unwrap()["xAdvance"], 0);
        assert_eq!(
            positioned.last().unwrap()["xAdvance"],
            result["lines"][0]["advance"]
        );
    }

    #[test]
    fn exposes_multi_run_font_sizes_through_a_bounded_font_bundle() {
        let font = font_test_data::NOTO_SERIF_DISPLAY_TRIMMED;
        let source = "office office";
        let runs = serde_json::json!([
            {
                "start": 0,
                "end": 7,
                "fontOffset": 0,
                "fontLength": font.len(),
                "faceIndex": 0,
                "variationAxes": [],
                "fontSize": 16.0,
                "letterSpacing": 0.0
            },
            {
                "start": 7,
                "end": source.len(),
                "fontOffset": 0,
                "fontLength": font.len(),
                "faceIndex": 0,
                "variationAxes": [],
                "fontSize": 32.0,
                "letterSpacing": 2.0
            }
        ]);
        let result = serde_json::from_str::<serde_json::Value>(
            &layout_shaped_text_runs_json(font, &runs.to_string(), source, 50.0).unwrap(),
        )
        .unwrap();

        assert_eq!(result["lines"].as_array().map(Vec::len), Some(2));
        assert_eq!(result["lines"][0]["end"], 7);
        assert_eq!(result["lines"][1]["start"], 7);
        assert!(
            result["lines"][1]["advance"].as_i64().unwrap()
                > result["lines"][0]["advance"].as_i64().unwrap()
        );
        assert!(
            result["lines"][0]["glyphs"]
                .as_array()
                .unwrap()
                .iter()
                .all(|glyph| glyph["runIndex"] == 0)
        );
        assert!(
            result["lines"][1]["glyphs"]
                .as_array()
                .unwrap()
                .iter()
                .all(|glyph| glyph["runIndex"] == 1)
        );
    }

    #[test]
    fn exposes_signed_tracking_through_the_multi_run_wasm_boundary() {
        let font = font_test_data::NOTO_SERIF_DISPLAY_TRIMMED;
        let source = "office";
        let request = |letter_spacing: f32| {
            serde_json::json!([{
                "start": 0,
                "end": source.len(),
                "fontOffset": 0,
                "fontLength": font.len(),
                "faceIndex": 0,
                "variationAxes": [],
                "fontSize": 16.0,
                "letterSpacing": letter_spacing
            }])
        };
        let layout = |letter_spacing| {
            serde_json::from_str::<serde_json::Value>(
                &layout_shaped_text_runs_json(
                    font,
                    &request(letter_spacing).to_string(),
                    source,
                    1_000.0,
                )
                .unwrap(),
            )
            .unwrap()
        };
        let untracked = layout(0.0);
        let expanded = layout(2.0);
        let tightened = layout(-0.25);

        assert!(
            expanded["lines"][0]["advance"].as_i64().unwrap()
                > untracked["lines"][0]["advance"].as_i64().unwrap()
        );
        assert!(
            tightened["lines"][0]["advance"].as_i64().unwrap()
                < untracked["lines"][0]["advance"].as_i64().unwrap()
        );
        assert_eq!(
            expanded["lines"][0]["visualCarets"]
                .as_array()
                .map(Vec::len),
            untracked["lines"][0]["visualCarets"]
                .as_array()
                .map(Vec::len)
        );
        for layout in [&expanded, &tightened] {
            assert_eq!(
                layout["lines"][0]["glyphs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|glyph| glyph["xAdvance"].as_i64().unwrap())
                    .sum::<i64>(),
                layout["lines"][0]["advance"].as_i64().unwrap()
            );
        }
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
    fn detached_gpu_scene_projection_leaves_the_editing_engine_mutable() {
        let mut engine = DocumentEngine::new();
        engine
            .create_node(
                "00000000-0000-0000-0000-000000000411",
                0,
                "00000000-0000-0000-0000-000000000422",
                "rectangle",
                "Card",
                0.0,
                0.0,
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
        let scene = gpu_scene_instances_from_snapshot_json(
            &engine.snapshot_json(),
            "00000000-0000-0000-0000-000000000001",
        )
        .unwrap();
        assert!(scene.contains("00000000-0000-0000-0000-000000000422"));

        engine
            .rename_node(
                "00000000-0000-0000-0000-000000000433",
                engine.document.revision,
                "00000000-0000-0000-0000-000000000422",
                "Edited",
            )
            .unwrap();
        assert!(engine.snapshot_json().contains("Edited"));
    }

    #[test]
    fn maps_uniform_closed_shape_alignments_to_gpu_outsets() {
        assert_eq!(
            shape_gpu_stroke_outset(NodeKind::Ellipse, false, StrokeAlign::Outside, 8.0, 1.0),
            8.0
        );
        assert_eq!(
            shape_gpu_stroke_outset(NodeKind::Ellipse, false, StrokeAlign::Center, 8.0, 1.0),
            4.0
        );
        assert_eq!(
            shape_gpu_stroke_outset(NodeKind::Ellipse, false, StrokeAlign::Inside, 8.0, 1.0),
            0.0
        );
        assert_eq!(
            shape_gpu_stroke_outset(NodeKind::Ellipse, true, StrokeAlign::Outside, 8.0, 1.0),
            0.0
        );
        assert_eq!(
            shape_gpu_stroke_outset(NodeKind::Rectangle, false, StrokeAlign::Outside, 8.0, 1.0),
            8.0
        );
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
                font_faces: Vec::new(),
            })
            .unwrap();
        let snapshot = source.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":32"));
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
                "[]",
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
        browser_rehydrated
            .load_snapshot_json(&local_snapshot)
            .unwrap();
        assert_eq!(browser_rehydrated.canonical_hash(), source.canonical_hash());
    }

    #[test]
    fn phase2_common_nodes_fixture_survives_service_wire_and_local_snapshot_round_trip() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../fixtures/documents/phase2-common-nodes.fixture.json"
        ))
        .unwrap();
        let nodes = fixture["nodes"].as_array().unwrap();
        let batch = nodes
            .iter()
            .map(|source| {
                // The fixture is a browser presentation document. Match the
                // transaction adapter at the durable boundary: `radius` is
                // projected to the Canonical `cornerRadius`, and absent
                // editable flags receive their deterministic defaults.
                let mut node = source.clone();
                node["cornerRadius"] = node
                    .get("radius")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!(0));
                node["locked"] = node
                    .get("locked")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!(false));
                serde_json::json!({ "type": "create", "node": node })
            })
            .collect::<Vec<_>>();

        let mut source = DocumentEngine::new();
        source
            .seed_batch_json(&serde_json::to_string(&batch).unwrap())
            .unwrap();
        let source_hash = source.canonical_hash();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&source.snapshot_json()).unwrap()["nodes"]
                .as_array()
                .map(Vec::len),
            Some(nodes.len())
        );

        // The Protobuf payload is the durable service boundary; the JSON
        // projection is the browser-local recovery boundary.
        let service_wire = source.snapshot_protobuf().unwrap();
        let mut service_rehydrated = DocumentEngine::new();
        service_rehydrated
            .load_snapshot_protobuf(&service_wire)
            .unwrap();
        assert_eq!(service_rehydrated.canonical_hash(), source_hash);

        let mut browser_rehydrated = DocumentEngine::new();
        browser_rehydrated
            .load_snapshot_json(&service_rehydrated.snapshot_json())
            .unwrap();
        assert_eq!(browser_rehydrated.canonical_hash(), source_hash);
    }

    #[test]
    fn effect_stack_fixture_node_accepts_a_third_ordered_shadow_update() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../fixtures/documents/phase2-common-nodes.fixture.json"
        ))
        .unwrap();
        let batch = fixture["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|source| {
                let mut node = source.clone();
                node["cornerRadius"] = node
                    .get("radius")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!(0));
                node["locked"] = node
                    .get("locked")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!(false));
                serde_json::json!({ "type": "create", "node": node })
            })
            .collect::<Vec<_>>();
        let mut engine = DocumentEngine::new();
        engine
            .seed_batch_json(&serde_json::to_string(&batch).unwrap())
            .unwrap();
        let mut card = serde_json::from_str::<serde_json::Value>(&engine.snapshot_json()).unwrap()
            ["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["name"] == "Asymmetric Card")
            .unwrap()
            .clone();
        let third = card["effectStack"].as_array().unwrap()[0].clone();
        card["effectStack"].as_array_mut().unwrap().push(third);
        engine
            .apply_transaction_json(
                "00000000-0000-4000-8000-00000000e101",
                engine.document.revision,
                &serde_json::to_string(&vec![
                    serde_json::json!({ "type": "update", "node": card }),
                ])
                .unwrap(),
            )
            .unwrap();
        let snapshot: serde_json::Value = serde_json::from_str(&engine.snapshot_json()).unwrap();
        assert_eq!(
            snapshot["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .find(|node| node["name"] == "Asymmetric Card")
                .unwrap()["effectStack"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
    }

    #[test]
    fn nested_auto_layout_frames_can_be_created_in_one_concrete_batch() {
        let mut template = DocumentEngine::new();
        template
            .create_node(
                "00000000-0000-0000-0000-000000000001",
                0,
                "00000000-0000-4000-8000-00000000f100",
                "frame",
                "Template",
                0.0,
                0.0,
                400.0,
                300.0,
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
        let base =
            serde_json::from_str::<serde_json::Value>(&template.snapshot_json()).unwrap()["nodes"]
                [0]
            .clone();
        let mut parent = base.clone();
        parent["id"] = serde_json::json!("00000000-0000-4000-8000-00000000f101");
        parent["name"] = serde_json::json!("Parent layout");
        parent["autoLayout"] = serde_json::json!({ "mode": "vertical", "padding": [20, 20, 20, 20], "itemSpacing": 16, "wrap": false, "primaryAlignment": "start", "counterAlignment": "start", "primarySizing": "fixed", "counterSizing": "fixed", "absolute": false });
        let mut child = base;
        child["id"] = serde_json::json!("00000000-0000-4000-8000-00000000f102");
        child["parentId"] = parent["id"].clone();
        child["name"] = serde_json::json!("Child layout");
        child["width"] = serde_json::json!(200.0);
        child["height"] = serde_json::json!(100.0);
        child["autoLayout"] = serde_json::json!({ "mode": "horizontal", "padding": [8, 8, 8, 8], "itemSpacing": 8, "wrap": false, "primaryAlignment": "start", "counterAlignment": "start", "primarySizing": "fixed", "counterSizing": "fixed", "absolute": false, "alignSelf": "end" });
        let mut engine = DocumentEngine::new();
        engine
            .apply_transaction_json(
                "00000000-0000-4000-8000-00000000f103",
                0,
                &serde_json::to_string(&vec![
                    serde_json::json!({ "type": "create", "node": parent }),
                    serde_json::json!({ "type": "create", "node": child }),
                ])
                .unwrap(),
            )
            .unwrap();
        let snapshot = serde_json::from_str::<serde_json::Value>(&engine.snapshot_json()).unwrap();
        assert_eq!(snapshot["nodes"].as_array().map(Vec::len), Some(2));
        assert_eq!(
            snapshot["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .find(|node| node["id"] == child["id"])
                .unwrap()["autoLayout"]["alignSelf"],
            "end"
        );
    }

    #[test]
    fn runtime_bridge_frame_batch_is_core_compatible() {
        let mut template = DocumentEngine::new();
        template
            .create_node(
                "00000000-0000-0000-0000-000000000001",
                0,
                "00000000-0000-4000-8000-00000000f200",
                "frame",
                "Template",
                0.0,
                0.0,
                100.0,
                100.0,
                0.0,
                "#00000000",
                "#00000000",
                0.0,
                1.0,
                0.0,
                true,
                false,
                "",
            )
            .unwrap();
        let mut frame = serde_json::from_str::<serde_json::Value>(&template.snapshot_json())
            .unwrap()["nodes"][0]
            .clone();
        frame["id"] = serde_json::json!("00000000-0000-4000-8000-00000000f201");
        frame["name"] = serde_json::json!("M1 card");
        frame["x"] = serde_json::json!(48.0);
        frame["y"] = serde_json::json!(64.0);
        frame["width"] = serde_json::json!(320.0);
        frame["height"] = serde_json::json!(180.0);
        frame["positionId"] =
            serde_json::json!("0000000000004000800000000000f201:00000000000000000000000000000000");
        frame["pageId"] = serde_json::json!("00000000-0000-0000-0000-000000000001");

        let mut engine = DocumentEngine::new();
        engine
            .apply_transaction_json(
                "00000000-0000-4000-8000-00000000f202",
                0,
                &serde_json::to_string(&vec![
                    serde_json::json!({ "type": "create", "node": frame.clone() }),
                    serde_json::json!({ "type": "update", "node": frame }),
                ])
                .unwrap(),
            )
            .unwrap();
        assert_eq!(engine.document.revision, 1);
    }

    #[test]
    fn prototype_extension_batch_reaches_the_canonical_reducer() {
        let mut engine = DocumentEngine::new();
        engine
            .create_node(
                "00000000-0000-0000-0000-000000000001",
                0,
                "00000000-0000-4000-8000-00000000f301",
                "frame",
                "Prototype",
                0.0,
                0.0,
                100.0,
                100.0,
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
        let extensions = serde_json::json!({
            "makefigma.prototype.metadata.v1": [123, 34, 115, 116, 97, 114, 116, 105, 110, 103, 80, 111, 105, 110, 116, 34, 58, 116, 114, 117, 101, 125]
        });
        engine.apply_transaction_json(
            "00000000-0000-4000-8000-00000000f302", engine.document.revision,
            &serde_json::to_string(&vec![serde_json::json!({ "type": "setExtensions", "id": "00000000-0000-4000-8000-00000000f301", "extensions": extensions })]).unwrap(),
        ).unwrap();
        let snapshot: serde_json::Value = serde_json::from_str(&engine.snapshot_json()).unwrap();
        assert!(snapshot["nodes"][0]["extensions"]["makefigma.prototype.metadata.v1"].is_array());
    }

    #[test]
    fn seeded_auto_layout_frames_reflow_after_the_entire_batch_is_hydrated() {
        let mut template = DocumentEngine::new();
        template
            .create_node(
                "00000000-0000-0000-0000-000000000001",
                0,
                "00000000-0000-4000-8000-00000000f120",
                "frame",
                "Template",
                0.0,
                0.0,
                400.0,
                300.0,
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
        let base =
            serde_json::from_str::<serde_json::Value>(&template.snapshot_json()).unwrap()["nodes"]
                [0]
            .clone();
        let layout = |mode: &str, padding: [u32; 4], spacing: u32| serde_json::json!({ "mode": mode, "padding": padding, "itemSpacing": spacing, "wrap": false, "primaryAlignment": "start", "counterAlignment": "start", "primarySizing": "fixed", "counterSizing": "fixed", "absolute": false });
        let mut parent = base.clone();
        parent["id"] = serde_json::json!("00000000-0000-4000-8000-00000000f121");
        parent["x"] = serde_json::json!(40.0);
        parent["y"] = serde_json::json!(60.0);
        parent["width"] = serde_json::json!(300.0);
        parent["height"] = serde_json::json!(200.0);
        parent["autoLayout"] = layout("vertical", [20, 20, 20, 20], 12);
        let mut child = base;
        child["id"] = serde_json::json!("00000000-0000-4000-8000-00000000f122");
        child["parentId"] = parent["id"].clone();
        child["x"] = serde_json::json!(999.0);
        child["y"] = serde_json::json!(999.0);
        child["width"] = serde_json::json!(120.0);
        child["height"] = serde_json::json!(80.0);
        child["autoLayout"] = layout("horizontal", [8, 8, 8, 8], 6);

        let mut engine = DocumentEngine::new();
        engine
            .seed_batch_json(
                &serde_json::to_string(&vec![
                    serde_json::json!({ "type": "create", "node": parent }),
                    serde_json::json!({ "type": "create", "node": child }),
                ])
                .unwrap(),
            )
            .unwrap();

        let snapshot: serde_json::Value = serde_json::from_str(&engine.snapshot_json()).unwrap();
        let child = snapshot["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["id"] == "00000000-0000-4000-8000-00000000f122")
            .unwrap();
        assert_eq!(
            (child["x"].as_f64(), child["y"].as_f64()),
            (Some(60.0), Some(80.0))
        );
        assert_eq!(engine.document.revision, 0);
    }

    #[test]
    fn nested_auto_layout_subtree_can_be_pasted_beside_its_source_frame() {
        let mut template = DocumentEngine::new();
        template
            .create_node(
                "00000000-0000-0000-0000-000000000001",
                0,
                "00000000-0000-4000-8000-00000000f110",
                "frame",
                "Template",
                0.0,
                0.0,
                400.0,
                300.0,
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
        let base =
            serde_json::from_str::<serde_json::Value>(&template.snapshot_json()).unwrap()["nodes"]
                [0]
            .clone();
        let layout = |mode: &str, padding: [u32; 4], spacing: u32| serde_json::json!({ "mode": mode, "padding": padding, "itemSpacing": spacing, "wrap": false, "primaryAlignment": "start", "counterAlignment": "start", "primarySizing": "fixed", "counterSizing": "fixed", "absolute": false });
        let frame = |id: &str,
                     parent_id: Option<&str>,
                     width: u32,
                     height: u32,
                     auto_layout: serde_json::Value| {
            let mut node = base.clone();
            node["id"] = serde_json::json!(id);
            node["parentId"] = parent_id
                .map(serde_json::Value::from)
                .unwrap_or(serde_json::Value::Null);
            node["positionId"] = serde_json::Value::Null;
            node["width"] = serde_json::json!(width);
            node["height"] = serde_json::json!(height);
            node["relativeTransform"] = serde_json::Value::Null;
            node["autoLayout"] = auto_layout;
            node
        };
        let root_id = "00000000-0000-4000-8000-00000000f111";
        let one_id = "00000000-0000-4000-8000-00000000f112";
        let two_id = "00000000-0000-4000-8000-00000000f113";
        let three_id = "00000000-0000-4000-8000-00000000f114";
        let root = frame(root_id, None, 960, 680, serde_json::Value::Null);
        let one = frame(
            one_id,
            Some(root_id),
            400,
            430,
            layout("vertical", [20, 20, 20, 20], 16),
        );
        let two = frame(
            two_id,
            Some(one_id),
            360,
            150,
            layout("horizontal", [16, 16, 16, 16], 12),
        );
        let three = frame(
            three_id,
            Some(two_id),
            210,
            118,
            layout("vertical", [8, 8, 8, 8], 6),
        );
        let mut engine = DocumentEngine::new();
        engine
            .seed_batch_json(
                &serde_json::to_string(
                    &vec![root, one, two, three]
                        .into_iter()
                        .map(|node| serde_json::json!({ "type": "create", "node": node }))
                        .collect::<Vec<_>>(),
                )
                .unwrap(),
            )
            .unwrap();
        let snapshot = serde_json::from_str::<serde_json::Value>(&engine.snapshot_json()).unwrap();
        let find = |id: &str| {
            snapshot["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .find(|node| node["id"] == id)
                .unwrap()
                .clone()
        };
        let copied_one_id = "00000000-0000-4000-8000-00000000f115";
        let copied_two_id = "00000000-0000-4000-8000-00000000f116";
        let copied_three_id = "00000000-0000-4000-8000-00000000f117";
        let mut copied_one = find(one_id);
        copied_one["id"] = serde_json::json!(copied_one_id);
        copied_one["parentId"] = serde_json::json!(root_id);
        copied_one["positionId"] = serde_json::Value::Null;
        let mut copied_two = find(two_id);
        copied_two["id"] = serde_json::json!(copied_two_id);
        copied_two["parentId"] = serde_json::json!(copied_one_id);
        copied_two["positionId"] = serde_json::Value::Null;
        let mut copied_three = find(three_id);
        copied_three["id"] = serde_json::json!(copied_three_id);
        copied_three["parentId"] = serde_json::json!(copied_two_id);
        copied_three["positionId"] = serde_json::Value::Null;
        engine
            .apply_transaction_json(
                "00000000-0000-4000-8000-00000000f118",
                engine.document.revision,
                &serde_json::to_string(
                    &vec![copied_one, copied_two, copied_three]
                        .into_iter()
                        .map(|node| serde_json::json!({ "type": "create", "node": node }))
                        .collect::<Vec<_>>(),
                )
                .unwrap(),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&engine.snapshot_json()).unwrap()["nodes"]
                .as_array()
                .map(Vec::len),
            Some(7)
        );
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
            parametric_shape: None,
            vector_path: None,
            boolean_operation: None,
            relative_transform: None,
            opacity: 1.0,
            blend_mode: BlendMode::Normal,
            drop_shadow: None,
            effect_stack: Vec::new(),
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
        extensions.insert(
            "phase3.autoLayout".to_string(),
            vec![0x00, 0xff, 0x7f, 0x80, 0x00],
        );
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
            extensions: extensions.clone(),
        };

        let mut source = DocumentEngine::new();
        source
            .submit_create(NodeId(16), 0, node, Origin::LocalUser)
            .unwrap();
        // Operation replay preserved the payloads verbatim.
        assert_eq!(source.document.node(id).unwrap().extensions, extensions);
        let source_hash = source.canonical_hash();

        // Durable Protobuf service boundary.
        let service_wire = source.snapshot_protobuf().unwrap();
        let mut service_rehydrated = DocumentEngine::new();
        service_rehydrated
            .load_snapshot_protobuf(&service_wire)
            .unwrap();
        assert_eq!(
            service_rehydrated.document.node(id).unwrap().extensions,
            extensions
        );
        assert_eq!(service_rehydrated.canonical_hash(), source_hash);

        // Browser-local JSON recovery boundary.
        let mut browser_rehydrated = DocumentEngine::new();
        browser_rehydrated
            .load_snapshot_json(&service_rehydrated.snapshot_json())
            .unwrap();
        assert_eq!(
            browser_rehydrated.document.node(id).unwrap().extensions,
            extensions
        );
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
            extensions: std::collections::BTreeMap::new(),
        };
        let mut source = DocumentEngine::new();
        source
            .submit_create(NodeId(16), 0, node, Origin::LocalUser)
            .unwrap();
        let wire = source.snapshot_protobuf().unwrap();

        let mut decoded =
            makefigma_protocol::v1::DocumentSnapshot::decode(wire.as_slice()).unwrap();
        let reference = &mut decoded.page_chunks[0].nodes[0];
        let mut inner =
            makefigma_protocol::v1::SceneNode::decode(reference.canonical_node.as_slice()).unwrap();
        inner.kind = 999; // a positive NodeKind tag no current engine defines
        reference.canonical_node = inner.encode_to_vec();
        let future_wire = decoded.encode_to_vec();

        // A client with an already-open document. The codec rejects the future
        // snapshot before `load_snapshot_protobuf` ever reassigns `self.document`
        // (the `?` short-circuits), so the open document cannot be mutated. We
        // assert the rejection at the codec layer directly: constructing the
        // wasm-bindgen JsValue error is not possible in a native test.
        let mut engine = DocumentEngine::new();
        engine
            .submit_create(NodeId(17), 0, existing_rect(NodeId(2)), Origin::LocalUser)
            .unwrap();
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
            snapshot_error_code(
                makefigma_document_codec::SnapshotError::UnsupportedEngineSemantics
            ),
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
            parametric_shape: None,
            vector_path: None,
            boolean_operation: None,
            relative_transform: None,
            opacity: 1.0,
            blend_mode: BlendMode::Normal,
            drop_shadow: None,
            effect_stack: Vec::new(),
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
                        parametric_shape: None,
                        relative_transform: None,
                        opacity: 1.0,
                        blend_mode: BlendMode::Normal,
                        drop_shadow: None,
                        effect_stack: Vec::new(),
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
            parametric_shape: None,
            vector_path: None,
            boolean_operation: None,
            relative_transform: None,
            opacity: 1.0,
            blend_mode: BlendMode::Normal,
            drop_shadow: None,
            effect_stack: Vec::new(),
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
            parametric_shape: None,
            vector_path: None,
            boolean_operation: None,
            relative_transform: None,
            opacity: 0.75,
            blend_mode: BlendMode::Normal,
            drop_shadow: None,
            effect_stack: Vec::new(),
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
            parametric_shape: None,
            vector_path: None,
            boolean_operation: None,
            relative_transform: None,
            opacity: 1.0,
            blend_mode: BlendMode::Normal,
            drop_shadow: None,
            effect_stack: Vec::new(),
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
            assert!(projection.contains(r#""schemaVersion":32"#), "{version}");

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
                "8664fbdb26dac860a74a33f2025fbe393728afbf1946e3dee90bfa1d71b7c6dc",
            ),
            (
                "v17",
                include_str!("../../../fixtures/documents/phase2-snapshot-v17.fixture.json"),
                "3155ab4d92590a80dc7d16e8ff8c7d10d8b2e6369f0e57e1f0d5340f53008cec",
            ),
            (
                "v18",
                include_str!("../../../fixtures/documents/phase2-snapshot-v18.fixture.json"),
                "f000b0641aaaf974ca1fd6f0150966fcbc5e4ce91a66ddf6ee93c305e38a0004",
            ),
            (
                "v19",
                include_str!("../../../fixtures/documents/phase2-snapshot-v19.fixture.json"),
                "0551e71ca4ba776f558cb3200915be9943c9115fe6c256ad1b6eb4a20cccf51f",
            ),
            (
                "v20",
                include_str!("../../../fixtures/documents/phase2-snapshot-v20.fixture.json"),
                "c6cda08ca5cb9e47bd16e23e2293f01b4e45117f949cd869f472291b614099e7",
            ),
            (
                "v21",
                include_str!("../../../fixtures/documents/phase2-snapshot-v21.fixture.json"),
                "aa7f66fb504872eb556cac1af60bbab41ca498e189ba60134f931c23f5153f63",
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
            if version >= "v20" {
                let root = migrated
                    .document
                    .node(parse_id("00000000-0000-4000-8000-000000000101").unwrap())
                    .unwrap();
                assert_eq!(
                    migrated.document.auto_layout_for_node(root.id).mode,
                    LayoutMode::Horizontal,
                    "{version}"
                );
            }
            if version >= "v21" {
                let root = migrated
                    .document
                    .node(parse_id("00000000-0000-4000-8000-000000000101").unwrap())
                    .unwrap();
                let root_layout = migrated.document.auto_layout_for_node(root.id);
                assert_eq!(root_layout.track_spacing, Some(20.0), "{version}");
                assert_eq!(
                    root_layout.track_alignment,
                    WrapTrackAlignment::SpaceBetween,
                    "{version}"
                );
                assert_eq!(
                    migrated.document.auto_layout_for_node(panel.id).align_self,
                    Some(LayoutAlignment::End),
                    "{version}"
                );
            }

            let projection = migrated.snapshot_json();
            assert!(projection.contains(r#""schemaVersion":32"#), "{version}");

            // Re-migrating the current projection is idempotent and Hash-stable.
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
            _ => panic!(
                "transparent stroke must remain a Solid transparent paint, not a gradient/empty"
            ),
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
            parametric_shape: None,
            vector_path: None,
            boolean_operation: None,
            relative_transform: None,
            opacity: 1.0,
            blend_mode: BlendMode::Normal,
            drop_shadow: None,
            effect_stack: Vec::new(),
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
                        parametric_shape: None,
                        vector_path: None,
                        boolean_operation: None,
                        relative_transform: None,
                        opacity: 1.0,
                        blend_mode: BlendMode::Normal,
                        drop_shadow: None,
                        effect_stack: Vec::new(),
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
                    parametric_shape: None,
                    vector_path: None,
                    boolean_operation: None,
                    relative_transform: None,
                    opacity: 1.0,
                    blend_mode: BlendMode::Normal,
                    drop_shadow: None,
                    effect_stack: Vec::new(),
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
            fill_stack: None,
            stroke_stack: None,
            fill_style_id: None,
            stroke_style_id: None,
            background_style_id: None,
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
            parametric_shape: None,
            vector_path: None,
            boolean_operation: None,
            relative_transform: None,
            position_id: None,
            page_id: None,
            opacity: 1.0,
            blend_mode: "normal".into(),
            drop_shadow: None,
            effect_stack: Vec::new(),
            corner_radius: 12.0,
            corner_radii: Vec::new(),
            corner_smoothing: 0.0,
            constraints: None,
            auto_layout: None,
            text: String::new(),
            visible: true,
            locked: false,
            contents_hidden: false,
            clips_content: Some(false),
            is_mask: false,
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
                            position_id:
                                "00000000000000000000000000000001:00000000000000000000000000000000"
                                    .into(),
                        }],
                    },
                    BatchCommand::Update {
                        node: first_as_group_child,
                        ignore_constraints: false,
                        plain_text_only: false,
                        rename_text_path: false,
                    },
                ],
            )
            .unwrap();
        assert_eq!(
            engine.document.node(first_id).unwrap().parent_id,
            Some(group_core_id)
        );
        assert_eq!(
            engine.document.node(first_id).unwrap().relative_transform,
            Some(editor_core::geometry::AffineTransform {
                a: 1.0,
                b: 0.0,
                c: 0.0,
                d: 1.0,
                e: 0.0,
                f: 0.0
            })
        );
        engine.document.undo().unwrap();
        assert_eq!(engine.document.node(first_id).unwrap().parent_id, None);
        assert_eq!(
            engine.document.node(first_id).unwrap().relative_transform,
            None
        );
        engine.document.redo().unwrap();
        assert_eq!(
            engine.document.node(first_id).unwrap().parent_id,
            Some(group_core_id)
        );

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
                            position_id:
                                "00000000000000000000000000000003:00000000000000000000000000000000"
                                    .into(),
                        }],
                    },
                    BatchCommand::Update {
                        node: nested_group,
                        ignore_constraints: false,
                        plain_text_only: false,
                        rename_text_path: false,
                    },
                ],
            )
            .unwrap();
        assert_eq!(
            engine.document.node(group_core_id).unwrap().parent_id,
            Some(outer_group_core_id)
        );

        let asset_id = "00000000-0000-4000-8000-000000000019";
        let image_id = "00000000-0000-4000-8000-000000000020";
        let mut pasted_image = node(image_id, "Pasted image");
        pasted_image.kind = "image".into();
        pasted_image.asset_id = Some(asset_id.into());
        let mut paste_engine = DocumentEngine::new();
        assert_eq!(
            paste_engine
                .submit_batch(
                    NodeId(19),
                    0,
                    vec![
                        BatchCommand::RegisterAsset {
                            asset: ProjectionAsset {
                                asset_id: asset_id.into(),
                                content_hash: "cd".repeat(32),
                                media_type: "image/png".into(),
                                byte_length: 128,
                                pixel_width: Some(16),
                                pixel_height: Some(8),
                                font_faces: Vec::new(),
                            },
                        },
                        BatchCommand::Create { node: pasted_image },
                    ],
                )
                .unwrap(),
            1
        );
        assert!(
            paste_engine
                .document
                .asset(AssetId(parse_id(asset_id).unwrap().0))
                .is_some()
        );
        assert!(
            paste_engine
                .document
                .node(parse_id(image_id).unwrap())
                .is_some()
        );
        paste_engine.undo().unwrap();
        assert!(
            paste_engine
                .document
                .asset(AssetId(parse_id(asset_id).unwrap().0))
                .is_none()
        );
        assert!(
            paste_engine
                .document
                .node(parse_id(image_id).unwrap())
                .is_none()
        );
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
                font_faces: Vec::new(),
            })
            .unwrap();
        let frame = ProjectionNode {
            id: frame_id.into(),
            parent_id: None,
            name: "Image frame".into(),
            kind: "frame".into(),
            asset_id: None,
            text_properties: None,
            fill_stack: None,
            stroke_stack: None,
            fill_style_id: None,
            stroke_style_id: None,
            background_style_id: None,
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
            parametric_shape: None,
            vector_path: None,
            boolean_operation: None,
            relative_transform: None,
            position_id: None,
            page_id: None,
            opacity: 1.0,
            blend_mode: "normal".into(),
            drop_shadow: None,
            effect_stack: Vec::new(),
            corner_radius: 24.0,
            corner_radii: vec![24.0, 32.0, 24.0, 18.0],
            corner_smoothing: 0.25,
            constraints: None,
            auto_layout: None,
            text: String::new(),
            visible: true,
            locked: false,
            contents_hidden: false,
            clips_content: Some(true),
            is_mask: false,
            extensions: Default::default(),
        };
        engine
            .submit_batch(
                NodeId(101),
                0,
                vec![BatchCommand::Create {
                    node: frame.clone(),
                }],
            )
            .unwrap();
        let mut image_filled = frame.clone();
        image_filled.asset_id = Some(asset_id.into());
        engine
            .submit_batch(
                NodeId(102),
                1,
                vec![BatchCommand::Update {
                    node: image_filled.clone(),
                    ignore_constraints: false,
                    plain_text_only: false,
                    rename_text_path: false,
                }],
            )
            .unwrap();
        let mut circular = image_filled;
        circular.corner_smoothing = 0.0;
        engine
            .submit_batch(
                NodeId(103),
                2,
                vec![BatchCommand::Update {
                    node: circular.clone(),
                    ignore_constraints: false,
                    plain_text_only: false,
                    rename_text_path: false,
                }],
            )
            .unwrap();
        let mut outside = circular;
        outside.stroke_align = "outside".into();
        assert_eq!(
            engine
                .submit_batch(
                    NodeId(104),
                    3,
                    vec![BatchCommand::Update {
                        node: outside,
                        ignore_constraints: false,
                        plain_text_only: false,
                        rename_text_path: false,
                    }],
                )
                .unwrap(),
            4
        );
        assert_eq!(
            engine
                .document
                .node(parse_id(frame_id).unwrap())
                .unwrap()
                .stroke_align,
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
            fill_stack: None,
            stroke_stack: None,
            fill_style_id: None,
            stroke_style_id: None,
            background_style_id: None,
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
            parametric_shape: None,
            vector_path: None,
            boolean_operation: None,
            relative_transform: None,
            position_id: None,
            page_id: None,
            opacity: 1.0,
            blend_mode: "normal".into(),
            drop_shadow: None,
            effect_stack: Vec::new(),
            corner_radius: 12.0,
            corner_radii: Vec::new(),
            corner_smoothing: 0.0,
            constraints: None,
            auto_layout: None,
            text: String::new(),
            visible: true,
            locked: false,
            contents_hidden: false,
            clips_content: Some(false),
            is_mask: false,
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
        let text = |value: &str, text_style_id: Option<&str>| ProjectionNode {
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
                    color: Some(ProjectionColor {
                        space: "srgb".into(),
                        components: [0.8, 0.1, 0.2],
                        alpha: 1.0,
                    }),
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
                    open_type_features: Default::default(),
                    text_style_id: text_style_id.map(str::to_owned),
                    paint_style_id: None,
                    variable_bindings: Default::default(),
                }],
                paragraph: ProjectionParagraphStyle {
                    alignment: "center".into(),
                    line_height: Some(150.0),
                    line_height_unit: Some("percent".into()),
                    paragraph_spacing: 4.0,
                    paragraph_indent: None,
                    text_wrap_style: None,
                    list_type: None,
                    list_spacing: None,
                    hanging_list: None,
                    hanging_punctuation: None,
                },
                paragraph_style_runs: vec![],
                auto_size: "height".into(),
                fallback_fonts: vec![],
                text_truncation: None,
                max_lines: None,
                base_style: None,
            }),
            fill_stack: None,
            stroke_stack: None,
            fill_style_id: None,
            stroke_style_id: None,
            background_style_id: None,
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
            parametric_shape: None,
            vector_path: None,
            boolean_operation: None,
            relative_transform: None,
            position_id: None,
            page_id: None,
            opacity: 1.0,
            blend_mode: "normal".into(),
            drop_shadow: None,
            effect_stack: Vec::new(),
            corner_radius: 0.0,
            corner_radii: Vec::new(),
            corner_smoothing: 0.0,
            constraints: None,
            auto_layout: None,
            text: value.into(),
            visible: true,
            locked: false,
            contents_hidden: false,
            clips_content: Some(false),
            is_mask: false,
            extensions: Default::default(),
        };
        engine
            .submit_batch(
                NodeId(16),
                0,
                vec![BatchCommand::Create {
                    node: text("Before", None),
                }],
            )
            .unwrap();
        engine
            .submit_batch(
                NodeId(17),
                1,
                vec![BatchCommand::Update {
                    node: text("After", None),
                    ignore_constraints: false,
                    plain_text_only: false,
                    rename_text_path: false,
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
        assert!(snapshot.contains("\"schemaVersion\":33"));
        assert!(snapshot.contains("\"textProperties\":{\"runs\":[{\"start\":0,\"end\":5"));
        assert!(snapshot.contains("\"color\":{\"space\":\"srgb\""));
        assert!(snapshot.contains("\"stroke\":\"#00000000\""));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(
            restored.document.text_properties_for_node(id).unwrap().runs[0].color,
            Some(Color::new(ColorSpace::Srgb, [0.8, 0.1, 0.2], 1.0).unwrap()),
        );
        assert_eq!(restored.document.node(id).unwrap().text, "After");
        assert_eq!(
            restored
                .document
                .text_properties_for_node(id)
                .unwrap()
                .paragraph
                .line_height_unit,
            Some(LineHeightUnit::Percent)
        );
        assert_eq!(
            restored
                .document
                .text_properties_for_node(id)
                .unwrap()
                .auto_size,
            TextAutoSize::Height
        );

        let mut mislabeled: CoreSnapshot = serde_json::from_str(&snapshot).unwrap();
        mislabeled.schema_version = 32;
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
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

        engine
            .submit_batch(
                NodeId(18),
                engine.document.revision,
                vec![BatchCommand::Update {
                    node: text("After", Some("S:heading")),
                    ignore_constraints: false,
                    plain_text_only: false,
                    rename_text_path: false,
                }],
            )
            .unwrap();
        let linked_snapshot = engine.snapshot_json();
        assert!(linked_snapshot.contains("\"schemaVersion\":58"));
        assert!(linked_snapshot.contains("\"textStyleId\":\"S:heading\""));
        let mut mislabeled_link: CoreSnapshot = serde_json::from_str(&linked_snapshot).unwrap();
        mislabeled_link.schema_version = 57;
        assert_eq!(
            validate_core_snapshot_version(&mislabeled_link),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );

        let mut paint_node = text("After", None);
        paint_node.text_properties.as_mut().unwrap().runs[0].paint_style_id =
            Some("S:accent".into());
        engine
            .submit_batch(
                NodeId(19),
                engine.document.revision,
                vec![BatchCommand::Update {
                    node: paint_node,
                    ignore_constraints: false,
                    plain_text_only: false,
                    rename_text_path: false,
                }],
            )
            .unwrap();
        let paint_snapshot = engine.snapshot_json();
        assert!(paint_snapshot.contains("\"schemaVersion\":62"));
        assert!(paint_snapshot.contains("\"paintStyleId\":\"S:accent\""));
        let mut mislabeled_paint: CoreSnapshot = serde_json::from_str(&paint_snapshot).unwrap();
        mislabeled_paint.schema_version = 61;
        assert_eq!(
            validate_core_snapshot_version(&mislabeled_paint),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v59_round_trips_the_text_style_catalog_and_v58_rejects_it() {
        let mut engine = DocumentEngine::new();
        let commands = serde_json::json!([{
            "type": "registerTextStyle",
            "style": {
                "id": "S:body",
                "key": "library-key",
                "name": "Body",
                "description": "Body copy",
                "remote": true,
                "style": {
                    "fontSize": 16.0,
                    "fontWeight": 400,
                    "italic": false,
                    "letterSpacing": 0.0
                },
                "paragraph": {
                    "alignment": "left",
                    "lineHeight": 24.0,
                    "paragraphSpacing": 6.0
                }
            }
        }]);
        engine
            .apply_transaction_json(
                "00000000-0000-4000-8000-000000000059",
                0,
                &commands.to_string(),
            )
            .unwrap();

        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":59"));
        assert!(snapshot.contains("\"textStyles\":[{\"id\":\"S:body\""));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), engine.canonical_hash());
        assert_eq!(restored.document.text_style("S:body").unwrap().name, "Body");

        let mut mislabeled: CoreSnapshot = serde_json::from_str(&snapshot).unwrap();
        mislabeled.schema_version = 58;
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v60_round_trips_the_paint_style_catalog_and_v59_rejects_it() {
        let mut engine = DocumentEngine::new();
        let commands = serde_json::json!([{
            "type": "registerPaintStyle",
            "style": {
                "id": "S:brand-fill",
                "key": "library-paint-key",
                "name": "Brand fill",
                "description": "Primary surface",
                "remote": true,
                "paints": { "layers": [] }
            }
        }]);
        engine
            .apply_transaction_json(
                "00000000-0000-4000-8000-000000000060",
                0,
                &commands.to_string(),
            )
            .unwrap();

        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":60"));
        assert!(snapshot.contains("\"paintStyles\":[{\"id\":\"S:brand-fill\""));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), engine.canonical_hash());
        assert_eq!(
            restored.document.paint_style("S:brand-fill").unwrap().name,
            "Brand fill"
        );

        let mut mislabeled: CoreSnapshot = serde_json::from_str(&snapshot).unwrap();
        mislabeled.schema_version = 59;
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v65_round_trips_style_publishable_metadata_and_v64_rejects_it() {
        let mut engine = DocumentEngine::new();
        let commands = serde_json::json!([
            {
                "type": "registerTextStyle",
                "style": {
                    "id": "S:body",
                    "key": "",
                    "name": "Body",
                    "description": "Body copy",
                    "descriptionMarkdown": "**Body** copy",
                    "documentationLinks": [{ "uri": "https://example.com/styles/body" }],
                    "remote": false,
                    "style": {
                        "fontSize": 16.0,
                        "fontWeight": 400,
                        "italic": false,
                        "letterSpacing": 0.0
                    },
                    "paragraph": {
                        "alignment": "left",
                        "lineHeight": 24.0,
                        "paragraphSpacing": 6.0
                    }
                }
            },
            {
                "type": "registerPaintStyle",
                "style": {
                    "id": "S:brand",
                    "key": "",
                    "name": "Brand",
                    "description": "Brand color",
                    "descriptionMarkdown": "**Brand** color",
                    "documentationLinks": [{ "uri": "https://example.com/styles/brand" }],
                    "remote": false,
                    "paints": { "layers": [] }
                }
            }
        ]);
        engine
            .apply_transaction_json(
                "00000000-0000-4000-8000-000000000065",
                0,
                &commands.to_string(),
            )
            .unwrap();

        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":65"));
        assert!(snapshot.contains("\"descriptionMarkdown\":\"**Body** copy\""));
        assert!(
            snapshot.contains(
                "\"documentationLinks\":[{\"uri\":\"https://example.com/styles/brand\"}]"
            )
        );
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), engine.canonical_hash());
        assert_eq!(
            restored
                .document
                .text_style("S:body")
                .unwrap()
                .description_markdown,
            "**Body** copy"
        );

        let mut mislabeled: CoreSnapshot = serde_json::from_str(&snapshot).unwrap();
        mislabeled.schema_version = 64;
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v66_round_trips_percent_text_style_tracking_and_v65_rejects_it() {
        let mut engine = DocumentEngine::new();
        let commands = serde_json::json!([{
            "type": "registerTextStyle",
            "style": {
                "id": "S:tracking",
                "key": "",
                "name": "Tracking",
                "description": "",
                "remote": false,
                "style": {
                    "fontSize": 16.0,
                    "fontWeight": 400,
                    "italic": false,
                    "letterSpacing": 10.0
                },
                "letterSpacingUnit": "percent",
                "paragraph": {
                    "alignment": "left",
                    "lineHeight": 24.0,
                    "paragraphSpacing": 0.0
                }
            }
        }]);
        engine
            .apply_transaction_json(
                "00000000-0000-4000-8000-000000000066",
                0,
                &commands.to_string(),
            )
            .unwrap();

        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":66"));
        assert!(snapshot.contains("\"letterSpacingUnit\":\"percent\""));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), engine.canonical_hash());
        assert_eq!(
            restored
                .document
                .text_style("S:tracking")
                .unwrap()
                .letter_spacing_unit,
            Some(TextStyleLetterSpacingUnit::Percent)
        );

        let mut mislabeled: CoreSnapshot = serde_json::from_str(&snapshot).unwrap();
        mislabeled.schema_version = 65;
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v67_round_trips_text_style_variable_bindings_and_v66_rejects_them() {
        let mut engine = DocumentEngine::new();
        let commands = serde_json::json!([
            {
                "type": "registerVariableCollection",
                "collection": {
                    "id": "VC:typography",
                    "key": "",
                    "name": "Typography",
                    "remote": false,
                    "hiddenFromPublishing": false,
                    "modes": [{ "modeId": "default", "name": "Default" }],
                    "defaultModeId": "default"
                }
            },
            {
                "type": "registerVariable",
                "variable": {
                    "id": "V:font-size",
                    "key": "",
                    "name": "Font size",
                    "description": "",
                    "remote": false,
                    "hiddenFromPublishing": false,
                    "collectionId": "VC:typography",
                    "resolvedType": "FLOAT",
                    "valuesByMode": { "default": 16.0 },
                    "scopes": ["FONT_SIZE"]
                }
            },
            {
                "type": "registerTextStyle",
                "style": {
                    "id": "S:bound",
                    "key": "",
                    "name": "Bound",
                    "description": "",
                    "remote": false,
                    "style": {
                        "fontSize": 16.0,
                        "fontWeight": 400,
                        "italic": false,
                        "letterSpacing": 0.0
                    },
                    "variableBindings": { "fontSize": "V:font-size" },
                    "paragraph": {
                        "alignment": "left",
                        "lineHeight": 24.0,
                        "paragraphSpacing": 0.0
                    }
                }
            }
        ]);
        engine
            .apply_transaction_json(
                "00000000-0000-4000-8000-000000000067",
                0,
                &commands.to_string(),
            )
            .unwrap();

        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":67"));
        assert!(snapshot.contains("\"variableBindings\":{\"fontSize\":\"V:font-size\"}"));
        let hash = engine.canonical_hash();
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), hash);
        assert_eq!(
            restored
                .document
                .text_style("S:bound")
                .unwrap()
                .variable_bindings
                .get("fontSize")
                .map(String::as_str),
            Some("V:font-size")
        );

        let mut mislabeled: CoreSnapshot = serde_json::from_str(&snapshot).unwrap();
        mislabeled.schema_version = 66;
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v68_round_trips_paint_style_variable_bindings_and_v67_rejects_them() {
        let mut engine = DocumentEngine::new();
        let commands = serde_json::json!([
            {
                "type": "registerVariableCollection",
                "collection": {
                    "id": "VC:colors", "key": "", "name": "Colors", "remote": false,
                    "hiddenFromPublishing": false,
                    "modes": [{ "modeId": "default", "name": "Default" }],
                    "defaultModeId": "default"
                }
            },
            {
                "type": "registerVariable",
                "variable": {
                    "id": "V:brand", "key": "", "name": "Brand", "description": "",
                    "remote": false, "hiddenFromPublishing": false, "collectionId": "VC:colors",
                    "resolvedType": "COLOR",
                    "valuesByMode": { "default": { "space": "srgb", "components": [1.0, 0.0, 0.0], "alpha": 1.0 } },
                    "scopes": ["ALL_FILLS"]
                }
            },
            {
                "type": "registerPaintStyle",
                "style": {
                    "id": "S:bound-paint", "key": "", "name": "Bound paint", "description": "", "remote": false,
                    "paints": { "layers": [{
                        "visible": true, "opacity": 1.0, "blendMode": "normal",
                        "paint": { "css": "#ff0000", "color": { "space": "srgb", "components": [1.0, 0.0, 0.0], "alpha": 1.0 } }
                    }] },
                    "variableBindings": [{ "paintIndex": 0, "variableId": "V:brand" }]
                }
            }
        ]);
        engine
            .apply_transaction_json(
                "00000000-0000-4000-8000-000000000068",
                0,
                &commands.to_string(),
            )
            .unwrap();

        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":68"));
        assert!(snapshot.contains("\"variableBindings\":[{\"paintIndex\":0,\"stopIndex\":null,\"variableId\":\"V:brand\"}]"));
        let hash = engine.canonical_hash();
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), hash);
        assert_eq!(
            restored
                .document
                .paint_style("S:bound-paint")
                .unwrap()
                .variable_bindings[0]
                .variable_id,
            "V:brand"
        );

        let mut mislabeled: CoreSnapshot = serde_json::from_str(&snapshot).unwrap();
        mislabeled.schema_version = 67;
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v69_round_trips_text_range_variable_bindings_and_v68_rejects_them() {
        let mut engine = DocumentEngine::new();
        let collection = VariableCollectionResource {
            id: "VC:text".into(),
            key: String::new(),
            name: "Text".into(),
            remote: false,
            hidden_from_publishing: false,
            modes: vec![VariableMode {
                id: "default".into(),
                name: "Default".into(),
            }],
            default_mode_id: "default".into(),
        };
        let variable = VariableResource {
            id: "V:size".into(),
            key: String::new(),
            name: "Size".into(),
            description: String::new(),
            remote: false,
            hidden_from_publishing: false,
            collection_id: collection.id.clone(),
            resolved_type: VariableResolvedType::Float,
            values_by_mode: [("default".into(), VariableValue::Float(24.0))].into(),
            scopes: vec!["FONT_SIZE".into()],
            code_syntax: BTreeMap::new(),
        };
        engine
            .document
            .seed_variable_collection(collection)
            .unwrap();
        engine.document.seed_variable(variable.clone()).unwrap();
        let mut text = existing_rect(NodeId(0x69));
        text.kind = NodeKind::Text;
        text.text = "A".into();
        engine
            .document
            .seed_node_on_page(DEFAULT_PAGE_ID, text)
            .unwrap();
        let properties = TextProperties {
            runs: vec![TextStyleRun {
                start: 0,
                end: 1,
                font: None,
                font_size: 24.0,
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
                variable_bindings: [("fontSize".into(), variable.id)].into(),
            }],
            ..TextProperties::default()
        };
        engine
            .document
            .seed_text_properties(NodeId(0x69), properties.clone())
            .unwrap();

        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":69"));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(
            restored.document.text_properties_for_node(NodeId(0x69)),
            Some(&properties)
        );
        let mut mislabeled: CoreSnapshot = serde_json::from_str(&snapshot).unwrap();
        mislabeled.schema_version = 68;
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v70_round_trips_grid_auto_layout_and_v69_rejects_it() {
        let mut engine = DocumentEngine::new();
        let mut frame = existing_rect(NodeId(0x70));
        frame.kind = NodeKind::Frame;
        frame.width = 320.0;
        frame.height = 200.0;
        engine
            .document
            .seed_node_on_page(DEFAULT_PAGE_ID, frame.clone())
            .unwrap();
        let layout = AutoLayout {
            mode: LayoutMode::Grid,
            grid_rows: vec![GridTrack::Fixed(64.0), GridTrack::Flex(1.0)],
            grid_columns: vec![GridTrack::Flex(2.0), GridTrack::Fixed(80.0)],
            grid_row_gap: Some(12.0),
            grid_column_gap: Some(20.0),
            ..AutoLayout::default()
        };
        engine
            .document
            .seed_auto_layout(frame.id, layout.clone())
            .unwrap();

        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":70"));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.document.auto_layout_for_node(frame.id), layout);
        let mut mislabeled: CoreSnapshot = serde_json::from_str(&snapshot).unwrap();
        mislabeled.schema_version = 69;
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v71_round_trips_grid_hug_tracks_and_v70_rejects_them() {
        let mut engine = DocumentEngine::new();
        let mut frame = existing_rect(NodeId(0x71));
        frame.kind = NodeKind::Frame;
        frame.width = 320.0;
        frame.height = 200.0;
        engine
            .document
            .seed_node_on_page(DEFAULT_PAGE_ID, frame.clone())
            .unwrap();
        let layout = AutoLayout {
            mode: LayoutMode::Grid,
            grid_rows: vec![GridTrack::Hug, GridTrack::Flex(1.0)],
            grid_columns: vec![GridTrack::Fixed(80.0)],
            ..AutoLayout::default()
        };
        engine
            .document
            .seed_auto_layout(frame.id, layout.clone())
            .unwrap();

        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":71"));
        assert!(snapshot.contains("\"type\":\"hug\""));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.document.auto_layout_for_node(frame.id), layout);
        let mut mislabeled: CoreSnapshot = serde_json::from_str(&snapshot).unwrap();
        mislabeled.schema_version = 70;
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v72_round_trips_grid_spans_and_v71_rejects_them() {
        let mut engine = DocumentEngine::new();
        let child = existing_rect(NodeId(0x72));
        engine
            .document
            .seed_node_on_page(DEFAULT_PAGE_ID, child.clone())
            .unwrap();
        let layout = AutoLayout {
            grid_row_span: Some(2),
            grid_column_span: Some(3),
            ..AutoLayout::default()
        };
        engine
            .document
            .seed_auto_layout(child.id, layout.clone())
            .unwrap();

        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":72"));
        assert!(snapshot.contains("\"gridRowSpan\":2"));
        assert!(snapshot.contains("\"gridColumnSpan\":3"));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.document.auto_layout_for_node(child.id), layout);
        let mut mislabeled: CoreSnapshot = serde_json::from_str(&snapshot).unwrap();
        mislabeled.schema_version = 71;
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v73_round_trips_grid_manual_placement_and_v72_rejects_it() {
        let mut engine = DocumentEngine::new();
        let mut frame = existing_rect(NodeId(0x73));
        frame.kind = NodeKind::Frame;
        engine
            .document
            .seed_node_on_page(DEFAULT_PAGE_ID, frame.clone())
            .unwrap();
        let layout = AutoLayout {
            mode: LayoutMode::Grid,
            grid_rows: vec![GridTrack::Fixed(64.0)],
            grid_columns: vec![GridTrack::Fixed(80.0)],
            grid_items_positioning: GridItemsPositioning::Manual,
            ..AutoLayout::default()
        };
        engine
            .document
            .seed_auto_layout(frame.id, layout.clone())
            .unwrap();

        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":73"));
        assert!(snapshot.contains("\"gridItemsPositioning\":\"manual\""));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.document.auto_layout_for_node(frame.id), layout);
        let mut mislabeled: CoreSnapshot = serde_json::from_str(&snapshot).unwrap();
        mislabeled.schema_version = 72;
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn batch_json_updates_and_deletes_local_styles() {
        let mut engine = DocumentEngine::new();
        let register = serde_json::json!([
            {
                "type": "registerTextStyle",
                "style": {
                    "id": "S:body",
                    "key": "",
                    "name": "Body",
                    "description": "Body copy",
                    "remote": false,
                    "style": {
                        "fontSize": 16.0,
                        "fontWeight": 400,
                        "italic": false,
                        "letterSpacing": 0.0
                    },
                    "paragraph": {
                        "alignment": "left",
                        "lineHeight": 24.0,
                        "paragraphSpacing": 6.0
                    }
                }
            },
            {
                "type": "registerPaintStyle",
                "style": {
                    "id": "S:brand",
                    "key": "",
                    "name": "Brand",
                    "description": "Brand fill",
                    "remote": false,
                    "paints": { "layers": [] }
                }
            }
        ]);
        engine
            .apply_transaction_json(
                "00000000-0000-4000-8000-000000000160",
                0,
                &register.to_string(),
            )
            .unwrap();

        let update = serde_json::json!([
            {
                "type": "setTextStyle",
                "style": {
                    "id": "S:body",
                    "key": "",
                    "name": "Typography/Body",
                    "description": "Updated body copy",
                    "remote": false,
                    "style": {
                        "fontSize": 16.0,
                        "fontWeight": 400,
                        "italic": false,
                        "letterSpacing": 0.0
                    },
                    "paragraph": {
                        "alignment": "left",
                        "lineHeight": 24.0,
                        "paragraphSpacing": 6.0
                    }
                }
            },
            {
                "type": "setPaintStyle",
                "style": {
                    "id": "S:brand",
                    "key": "",
                    "name": "Color/Brand",
                    "description": "Updated brand fill",
                    "remote": false,
                    "paints": { "layers": [] }
                }
            }
        ]);
        engine
            .apply_transaction_json(
                "00000000-0000-4000-8000-000000000161",
                1,
                &update.to_string(),
            )
            .unwrap();
        assert_eq!(
            engine.document.text_style("S:body").unwrap().name,
            "Typography/Body"
        );
        assert_eq!(
            engine.document.paint_style("S:brand").unwrap().name,
            "Color/Brand"
        );

        let delete = serde_json::json!([
            { "type": "deleteTextStyle", "id": "S:body" },
            { "type": "deletePaintStyle", "id": "S:brand" }
        ]);
        engine
            .apply_transaction_json(
                "00000000-0000-4000-8000-000000000162",
                2,
                &delete.to_string(),
            )
            .unwrap();
        assert!(engine.document.text_style("S:body").is_none());
        assert!(engine.document.paint_style("S:brand").is_none());
    }

    #[test]
    fn snapshot_v61_round_trips_paint_style_links_and_v60_rejects_them() {
        let mut engine = DocumentEngine::new();
        let node: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-000000000061",
            "name": "Styled frame", "kind": "frame",
            "x": 0.0, "y": 0.0, "width": 120.0, "height": 80.0,
            "fill": "#ffffff", "stroke": "#00000000", "strokeWidth": 0.0,
            "fillStyleId": "S:surface", "strokeStyleId": "S:border",
            "backgroundStyleId": "S:surface",
            "opacity": 1.0, "cornerRadius": 0.0,
            "text": "", "visible": true, "locked": false
        }))
        .unwrap();
        engine
            .submit_batch(NodeId(61), 0, vec![BatchCommand::Create { node }])
            .unwrap();

        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":61"));
        assert!(snapshot.contains("\"fillStyleId\":\"S:surface\""));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), engine.canonical_hash());
        assert_eq!(
            restored
                .document
                .paint_style_links_for_node(
                    parse_id("00000000-0000-4000-8000-000000000061").unwrap()
                )
                .unwrap()
                .stroke
                .as_deref(),
            Some("S:border")
        );

        let mut mislabeled: CoreSnapshot = serde_json::from_str(&snapshot).unwrap();
        mislabeled.schema_version = 60;
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn vector_path_geometry_bridge_preserves_relative_handles_and_fill_rule() {
        let path = serde_json::json!({
            "fillRule": "evenOdd",
            "subpaths": [{ "closed": true, "points": [
                { "id": "00000000-0000-0000-0000-000000000001", "x": 0.0, "y": 0.0, "handleOut": { "x": 25.0, "y": 30.0 }, "pointType": "corner" },
                { "id": "00000000-0000-0000-0000-000000000002", "x": 100.0, "y": 0.0, "handleIn": { "x": -25.0, "y": 30.0 }, "pointType": "corner" },
                { "id": "00000000-0000-0000-0000-000000000003", "x": 50.0, "y": 100.0, "pointType": "corner" }
            ] }]
        }).to_string();
        let flattened: serde_json::Value =
            serde_json::from_str(&vector_path_geometry_json(&path, 0.25).unwrap()).unwrap();
        assert!(flattened["subpaths"][0]["points"].as_array().unwrap().len() > 3);
        assert!(vector_path_contains_json(&path, 50.0, 70.0, 0.25).unwrap());
        let mesh: serde_json::Value = serde_json::from_str(
            &vector_path_stroke_mesh_json(&path, 0.25, 4.0, "round", "round", 4.0).unwrap(),
        )
        .unwrap();
        assert!(mesh["triangles"].as_array().unwrap().len() >= 6);
        assert!(
            vector_path_stroke_contains_json(&path, 50.0, 101.0, 0.25, 4.0, "round", "round", 4.0)
                .unwrap()
        );
        let outline: serde_json::Value = serde_json::from_str(
            &vector_path_outline_json(&path, 0.25, 4.0, "round", "round", 4.0).unwrap(),
        )
        .unwrap();
        assert_eq!(outline["fillRule"], "nonZero");
        assert!(
            outline["subpaths"]
                .as_array()
                .unwrap()
                .iter()
                .all(|subpath| subpath["closed"] == true)
        );
        assert!(
            outline["subpaths"]
                .as_array()
                .unwrap()
                .iter()
                .any(|subpath| subpath["points"].as_array().unwrap().len() >= 3)
        );
        let dashed: serde_json::Value = serde_json::from_str(
            &vector_path_dashed_outline_json(&path, 0.25, 4.0, "[12,6]", "round", "round", 4.0)
                .unwrap(),
        )
        .unwrap();
        assert!(dashed["subpaths"].as_array().unwrap().len() > 2);
        assert!(
            dashed["subpaths"]
                .as_array()
                .unwrap()
                .iter()
                .all(|subpath| subpath["closed"] == true)
        );
    }

    #[test]
    fn vector_path_nearest_segment_bridge_keeps_the_canonical_curve_parameter() {
        let path = serde_json::json!({
            "fillRule": "nonZero",
            "subpaths": [{ "closed": false, "points": [
                { "id": "00000000-0000-0000-0000-000000000001", "x": 0.0, "y": 0.0, "handleOut": { "x": 0.0, "y": 10.0 }, "pointType": "asymmetric" },
                { "id": "00000000-0000-0000-0000-000000000002", "x": 10.0, "y": 0.0, "handleIn": { "x": 0.0, "y": 10.0 }, "pointType": "asymmetric" }
            ] }]
        }).to_string();

        let hit: serde_json::Value = serde_json::from_str(
            &vector_path_nearest_segment_json(&path, 5.0, 7.5, 0.01, 1.0).unwrap(),
        )
        .unwrap();
        assert_eq!(hit["subpathIndex"], 0);
        assert_eq!(hit["afterPointIndex"], 0);
        assert!((hit["t"].as_f64().unwrap() - 0.5).abs() < 0.01);
        assert_eq!(
            vector_path_nearest_segment_json(&path, 5.0, 30.0, 0.01, 1.0).unwrap(),
            "null"
        );
    }

    #[test]
    fn boolean_vector_path_bridge_returns_transient_non_zero_outlines() {
        let operands = serde_json::json!([
            { "fillRule": "nonZero", "subpaths": [{ "closed": true, "points": [
                { "id": "00000000-0000-0000-0000-000000000101", "x": 0.0, "y": 0.0, "pointType": "corner" },
                { "id": "00000000-0000-0000-0000-000000000102", "x": 10.0, "y": 0.0, "pointType": "corner" },
                { "id": "00000000-0000-0000-0000-000000000103", "x": 10.0, "y": 10.0, "pointType": "corner" },
                { "id": "00000000-0000-0000-0000-000000000104", "x": 0.0, "y": 10.0, "pointType": "corner" }
            ] }] },
            { "fillRule": "nonZero", "subpaths": [{ "closed": true, "points": [
                { "id": "00000000-0000-0000-0000-000000000201", "x": 5.0, "y": 0.0, "pointType": "corner" },
                { "id": "00000000-0000-0000-0000-000000000202", "x": 15.0, "y": 0.0, "pointType": "corner" },
                { "id": "00000000-0000-0000-0000-000000000203", "x": 15.0, "y": 10.0, "pointType": "corner" },
                { "id": "00000000-0000-0000-0000-000000000204", "x": 5.0, "y": 10.0, "pointType": "corner" }
            ] }] }
        ]).to_string();
        let result: serde_json::Value =
            serde_json::from_str(&boolean_vector_paths_json("subtract", &operands, 0.25).unwrap())
                .unwrap();
        assert_eq!(result["fillRule"], "nonZero");
        assert_eq!(result["bounds"]["min"], serde_json::json!([0.0, 0.0]));
        assert_eq!(result["bounds"]["max"], serde_json::json!([5.0, 10.0]));
    }

    #[test]
    fn named_vector_point_batch_commands_reach_the_canonical_reducer() {
        let id = NodeId(7);
        let mut vector = existing_rect(id);
        vector.kind = NodeKind::Vector;
        vector.vector_path = Some(VectorPath {
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
        });
        let mut engine = DocumentEngine::new();
        engine.document.seed_node(vector).unwrap();
        engine
            .submit_batch(
                NodeId(8),
                0,
                vec![BatchCommand::MoveVectorPoint {
                    id: format_uuid(id),
                    point_id: format_uuid(NodeId(2)),
                    x: 25.0,
                    y: 5.0,
                }],
            )
            .unwrap();
        assert_eq!(
            engine
                .document
                .node(id)
                .unwrap()
                .vector_path
                .as_ref()
                .unwrap()
                .subpaths[0]
                .points[1]
                .position,
            Point { x: 25.0, y: 5.0 },
        );
        engine
            .submit_batch(
                NodeId(9),
                1,
                vec![BatchCommand::SetVectorSubpathClosed {
                    id: format_uuid(id),
                    subpath_index: 0,
                    closed: false,
                }],
            )
            .unwrap();
        assert!(
            !engine
                .document
                .node(id)
                .unwrap()
                .vector_path
                .as_ref()
                .unwrap()
                .subpaths[0]
                .closed
        );
        let split: BatchCommand = serde_json::from_value(serde_json::json!({
            "type": "splitVectorSegment",
            "id": format_uuid(id),
            "subpathIndex": 0,
            "afterPointId": format_uuid(NodeId(1)),
            "t": 0.5,
            "pointId": format_uuid(NodeId(4)),
        }))
        .unwrap();
        engine
            .submit_batch(NodeId(10), engine.document.revision, vec![split])
            .unwrap();
        assert_eq!(
            engine
                .document
                .node(id)
                .unwrap()
                .vector_path
                .as_ref()
                .unwrap()
                .subpaths[0]
                .points
                .len(),
            4
        );
    }

    #[test]
    fn browser_batch_commands_accept_camel_case_vector_fields() {
        let id = "00000000-0000-4000-8000-000000000001";
        let point_id = "00000000-0000-4000-8000-000000000002";
        let commands: Vec<BatchCommand> = serde_json::from_value(serde_json::json!([
            { "type": "moveVectorPoint", "id": id, "pointId": point_id, "x": 1.0, "y": 2.0 },
            { "type": "setVectorSubpathClosed", "id": id, "subpathIndex": 3, "closed": true },
            { "type": "insertVectorPoint", "id": id, "subpathIndex": 4, "afterPointId": point_id, "point": { "id": "00000000-0000-4000-8000-000000000003", "x": 3.0, "y": 4.0, "pointType": "corner" } },
            { "type": "splitVectorSegment", "id": id, "subpathIndex": 5, "afterPointId": point_id, "t": 0.5, "pointId": "00000000-0000-4000-8000-000000000004" },
            { "type": "connectVectorEndpoints", "id": id, "firstSubpathIndex": 6, "firstPointId": point_id, "secondSubpathIndex": 7, "secondPointId": "00000000-0000-4000-8000-000000000005" },
            { "type": "deleteVectorPoint", "id": id, "pointId": point_id },
            { "type": "setVectorPointHandles", "id": id, "pointId": point_id, "handleIn": { "x": -1.0, "y": 2.0 }, "handleOut": { "x": 3.0, "y": -4.0 }, "pointType": "asymmetric" },
            { "type": "reposition", "positionIds": [{ "id": id, "positionId": "00000000000000000000000000000001:00000000000000000000000000000002" }] },
            { "type": "reparent", "parentIds": [{ "id": id, "parentId": null, "positionId": "00000000000000000000000000000001:00000000000000000000000000000002" }] }
        ])).unwrap();

        assert!(
            matches!(commands[0], BatchCommand::MoveVectorPoint { ref point_id, .. } if point_id == "00000000-0000-4000-8000-000000000002")
        );
        assert!(matches!(
            commands[1],
            BatchCommand::SetVectorSubpathClosed {
                subpath_index: 3,
                ..
            }
        ));
        assert!(matches!(
            commands[2],
            BatchCommand::InsertVectorPoint {
                subpath_index: 4,
                after_point_id: Some(_),
                ..
            }
        ));
        assert!(matches!(
            commands[3],
            BatchCommand::SplitVectorSegment {
                subpath_index: 5,
                ..
            }
        ));
        assert!(matches!(
            commands[4],
            BatchCommand::ConnectVectorEndpoints {
                first_subpath_index: 6,
                second_subpath_index: 7,
                ..
            }
        ));
        assert!(matches!(
            commands[5],
            BatchCommand::DeleteVectorPoint { .. }
        ));
        assert!(matches!(
            commands[6],
            BatchCommand::SetVectorPointHandles {
                handle_in: Some(_),
                handle_out: Some(_),
                ..
            }
        ));
        assert!(
            matches!(commands[7], BatchCommand::Reposition { ref position_ids } if position_ids.len() == 1)
        );
        assert!(
            matches!(commands[8], BatchCommand::Reparent { ref parent_ids } if parent_ids.len() == 1)
        );
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
            fill_stack: None,
            stroke_stack: None,
            fill_style_id: None,
            stroke_style_id: None,
            background_style_id: None,
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
            parametric_shape: None,
            vector_path: None,
            boolean_operation: None,
            relative_transform: None,
            position_id: Some(
                "00000000000000000000000000000010:00000000000000000000000000000007".into(),
            ),
            page_id: None,
            opacity: 1.0,
            blend_mode: "normal".into(),
            drop_shadow: None,
            effect_stack: Vec::new(),
            corner_radius: 8.0,
            corner_radii: Vec::new(),
            corner_smoothing: 0.0,
            constraints: None,
            auto_layout: None,
            text: String::new(),
            visible: true,
            locked: false,
            contents_hidden: false,
            clips_content: Some(false),
            is_mask: false,
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
        assert!(snapshot.contains("\"schemaVersion\":32"));
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
    fn snapshot_v25_round_trips_rotated_image_paint_stacks() {
        let mut engine = DocumentEngine::new();
        let asset_id = AssetId(0xa001);
        engine
            .document
            .seed_asset(AssetReference {
                asset_id,
                content_hash: [0xaa; 32],
                media_type: "image/png".into(),
                byte_length: 172,
                dimensions: Some([24, 16]),
                font_faces: Vec::new(),
            })
            .unwrap();
        let node: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-000000000401",
            "name": "Image paint", "kind": "rectangle",
            "x": 0.0, "y": 0.0, "width": 120.0, "height": 80.0,
            "fill": "#ffffff", "stroke": "#00000000", "strokeWidth": 0.0,
            "opacity": 1.0, "cornerRadius": 0.0,
            "text": "", "visible": true, "locked": false,
            "fillStack": { "layers": [{
                "image": {
                    "assetId": "00000000-0000-0000-0000-00000000a001",
                    "scaleMode": "fill",
                    "transform": { "a": 1.0, "b": 0.0, "c": 0.0, "d": 1.0, "e": 0.0, "f": 0.0 },
                    "rotationDegrees": 90
                },
                "visible": true, "opacity": 0.5, "blendMode": "color-dodge"
            }]},
            "strokeStack": { "layers": [] }
        }))
        .unwrap();

        engine
            .submit_batch(NodeId(0x402), 0, vec![BatchCommand::Create { node }])
            .unwrap();
        let node_id = parse_id("00000000-0000-4000-8000-000000000401").unwrap();
        assert!(matches!(
            engine.document.fill_stack_for_node(node_id),
            Some(PaintStack { layers })
                if matches!(layers.as_slice(), [PaintLayer {
                    paint: PaintLayerKind::Image(ImagePaint { asset_id: value, scale_mode: ImageScaleMode::Fill, rotation_degrees: 90, .. }),
                    visible: true,
                    opacity,
                    blend_mode: BlendMode::ColorDodge,
                }] if *value == asset_id && (*opacity - 0.5).abs() < f32::EPSILON)
        ));
        assert_eq!(
            engine.document.stroke_stack_for_node(node_id),
            Some(&PaintStack::default())
        );

        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":32"));
        assert!(snapshot.contains("\"scaleMode\":\"fill\""));
        assert!(snapshot.contains("\"rotationDegrees\":90"));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(
            restored.document.fill_stack_for_node(node_id),
            engine.document.fill_stack_for_node(node_id)
        );
        assert_eq!(
            restored.document.stroke_stack_for_node(node_id),
            Some(&PaintStack::default())
        );

        let mut mislabeled: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        mislabeled["schemaVersion"] = serde_json::json!(22);
        let mislabeled: CoreSnapshot = serde_json::from_value(mislabeled).unwrap();
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );

        let mut legacy_v22: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        legacy_v22["schemaVersion"] = serde_json::json!(22);
        legacy_v22.as_object_mut().unwrap().remove("canonicalHash");
        legacy_v22["nodes"][0]["fillStack"]["layers"][0]["image"]
            .as_object_mut()
            .unwrap()
            .remove("rotationDegrees");
        let mut legacy_engine = DocumentEngine::new();
        legacy_engine
            .load_snapshot_json(&legacy_v22.to_string())
            .unwrap();
        assert!(matches!(
            &legacy_engine
                .document
                .fill_stack_for_node(node_id)
                .unwrap()
                .layers[0]
                .paint,
            PaintLayerKind::Image(ImagePaint {
                rotation_degrees: 0,
                ..
            })
        ));
    }

    #[test]
    fn snapshot_v27_round_trips_image_filters_and_v26_rejects_them() {
        let mut engine = DocumentEngine::new();
        let asset_id = AssetId(0xa011);
        engine
            .document
            .seed_asset(AssetReference {
                asset_id,
                content_hash: [0xab; 32],
                media_type: "image/png".into(),
                byte_length: 172,
                dimensions: Some([24, 16]),
                font_faces: Vec::new(),
            })
            .unwrap();
        let node: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-000000000411",
            "name": "Filtered image", "kind": "rectangle",
            "x": 0.0, "y": 0.0, "width": 120.0, "height": 80.0,
            "fill": "#ffffff", "stroke": "#00000000", "strokeWidth": 0.0,
            "opacity": 1.0, "cornerRadius": 0.0,
            "text": "", "visible": true, "locked": false,
            "fillStack": { "layers": [{
                "image": {
                    "assetId": "00000000-0000-0000-0000-00000000a011",
                    "scaleMode": "fill",
                    "transform": { "a": 1.0, "b": 0.0, "c": 0.0, "d": 1.0, "e": 0.0, "f": 0.0 },
                    "filters": { "exposure": 0.25, "shadows": -0.5 }
                },
                "visible": true, "opacity": 1.0, "blendMode": "normal"
            }]}
        }))
        .unwrap();
        engine
            .submit_batch(NodeId(0x412), 0, vec![BatchCommand::Create { node }])
            .unwrap();
        let node_id = parse_id("00000000-0000-4000-8000-000000000411").unwrap();

        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":32"));
        assert!(snapshot.contains("\"exposure\":0.25"));
        assert!(snapshot.contains("\"shadows\":-0.5"));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(
            restored.document.fill_stack_for_node(node_id),
            engine.document.fill_stack_for_node(node_id)
        );

        let mut mislabeled: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        mislabeled["schemaVersion"] = serde_json::json!(26);
        let mislabeled: CoreSnapshot = serde_json::from_value(mislabeled).unwrap();
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );

        let mut legacy_v26: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        legacy_v26["schemaVersion"] = serde_json::json!(26);
        legacy_v26.as_object_mut().unwrap().remove("canonicalHash");
        legacy_v26["nodes"][0]["fillStack"]["layers"][0]["image"]
            .as_object_mut()
            .unwrap()
            .remove("filters");
        let mut legacy_engine = DocumentEngine::new();
        legacy_engine
            .load_snapshot_json(&legacy_v26.to_string())
            .unwrap();
        assert!(matches!(
            &legacy_engine
                .document
                .fill_stack_for_node(node_id)
                .unwrap()
                .layers[0]
                .paint,
            PaintLayerKind::Image(ImagePaint { filters: None, .. })
        ));
    }

    #[test]
    fn snapshot_v28_round_trips_text_truncation_and_v27_rejects_it() {
        let mut engine = DocumentEngine::new();
        let node: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-000000000431",
            "name": "Truncated text", "kind": "text",
            "x": 0.0, "y": 0.0, "width": 100.0, "height": 40.0,
            "fill": "#111111", "stroke": "#00000000", "strokeWidth": 0.0,
            "opacity": 1.0, "cornerRadius": 0.0,
            "text": "one two three four", "visible": true, "locked": false,
            "textProperties": {
                "runs": [],
                "paragraph": { "alignment": "left", "lineHeight": 20.0, "paragraphSpacing": 0.0 },
                "autoSize": "fixed",
                "fallbackFonts": [],
                "textTruncation": "ending",
                "maxLines": 2
            }
        }))
        .unwrap();
        engine
            .submit_batch(NodeId(0x432), 0, vec![BatchCommand::Create { node }])
            .unwrap();
        let node_id = parse_id("00000000-0000-4000-8000-000000000431").unwrap();

        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":32"));
        assert!(snapshot.contains("\"textTruncation\":\"ending\""));
        assert!(snapshot.contains("\"maxLines\":2"));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(
            restored.document.text_properties_for_node(node_id),
            engine.document.text_properties_for_node(node_id)
        );

        let mut mislabeled: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        mislabeled["schemaVersion"] = serde_json::json!(27);
        let mislabeled: CoreSnapshot = serde_json::from_value(mislabeled).unwrap();
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );

        let mut legacy_v27: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        legacy_v27["schemaVersion"] = serde_json::json!(27);
        legacy_v27.as_object_mut().unwrap().remove("canonicalHash");
        legacy_v27["nodes"][0]["textProperties"]
            .as_object_mut()
            .unwrap()
            .remove("textTruncation");
        legacy_v27["nodes"][0]["textProperties"]
            .as_object_mut()
            .unwrap()
            .remove("maxLines");
        let mut legacy_engine = DocumentEngine::new();
        legacy_engine
            .load_snapshot_json(&legacy_v27.to_string())
            .unwrap();
        let properties = legacy_engine
            .document
            .text_properties_for_node(node_id)
            .cloned()
            .unwrap_or_default();
        assert_eq!(properties.text_truncation, TextTruncation::Disabled);
        assert_eq!(properties.max_lines, None);
    }

    #[test]
    fn snapshot_v29_round_trips_text_run_paint_stacks_and_v28_rejects_them() {
        let mut engine = DocumentEngine::new();
        let node: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-000000000441",
            "name": "Painted text", "kind": "text",
            "x": 0.0, "y": 0.0, "width": 100.0, "height": 40.0,
            "fill": "#111111", "stroke": "#00000000", "strokeWidth": 0.0,
            "opacity": 1.0, "cornerRadius": 0.0,
            "text": "AB", "visible": true, "locked": false,
            "textProperties": {
                "runs": [{
                    "start": 0, "end": 2, "fontSize": 16.0, "fontWeight": 500,
                    "italic": false, "letterSpacing": 0.0,
                    "fillStack": { "layers": [] }
                }],
                "paragraph": { "alignment": "left", "lineHeight": 20.0, "paragraphSpacing": 0.0 },
                "autoSize": "fixed", "fallbackFonts": []
            }
        }))
        .unwrap();
        engine
            .submit_batch(NodeId(0x442), 0, vec![BatchCommand::Create { node }])
            .unwrap();

        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":32"));
        assert!(snapshot.contains("\"fillStack\":{\"layers\":[]}"));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), engine.canonical_hash());

        let mut mislabeled: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        mislabeled["schemaVersion"] = serde_json::json!(28);
        let mislabeled: CoreSnapshot = serde_json::from_value(mislabeled).unwrap();
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v30_round_trips_empty_text_base_style_and_v29_rejects_it() {
        let mut engine = DocumentEngine::new();
        let node: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-000000000451",
            "name": "Empty styled text", "kind": "text",
            "x": 0.0, "y": 0.0, "width": 100.0, "height": 40.0,
            "fill": "#111111", "stroke": "#00000000", "strokeWidth": 0.0,
            "opacity": 1.0, "cornerRadius": 0.0,
            "text": "", "visible": true, "locked": false,
            "textProperties": {
                "runs": [],
                "baseStyle": {
                    "fontSize": 22.0, "fontWeight": 600,
                    "italic": true, "letterSpacing": 1.25,
                    "fillStack": { "layers": [] }
                },
                "paragraph": { "alignment": "left", "lineHeight": 26.0, "paragraphSpacing": 0.0 },
                "autoSize": "fixed", "fallbackFonts": []
            }
        }))
        .unwrap();
        engine
            .submit_batch(NodeId(0x452), 0, vec![BatchCommand::Create { node }])
            .unwrap();

        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":32"));
        assert!(snapshot.contains("\"baseStyle\""));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), engine.canonical_hash());

        let mut mislabeled: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        mislabeled["schemaVersion"] = serde_json::json!(29);
        let mislabeled: CoreSnapshot = serde_json::from_value(mislabeled).unwrap();
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v31_round_trips_text_case_and_v30_rejects_it() {
        let mut engine = DocumentEngine::new();
        let node: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-000000000461",
            "name": "Text case", "kind": "text",
            "x": 0.0, "y": 0.0, "width": 100.0, "height": 40.0,
            "fill": "#111111", "stroke": "#00000000", "strokeWidth": 0.0,
            "opacity": 1.0, "cornerRadius": 0.0,
            "text": "Case", "visible": true, "locked": false,
            "textProperties": {
                "runs": [{
                    "start": 0, "end": 4, "fontSize": 16.0, "fontWeight": 400,
                    "italic": false, "letterSpacing": 0.0, "textCase": "smallCapsForced"
                }],
                "paragraph": { "alignment": "left", "lineHeight": 20.0, "paragraphSpacing": 0.0 },
                "autoSize": "fixed", "fallbackFonts": []
            }
        }))
        .unwrap();
        engine
            .submit_batch(NodeId(0x462), 0, vec![BatchCommand::Create { node }])
            .unwrap();

        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":32"));
        assert!(snapshot.contains("\"textCase\":\"smallCapsForced\""));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), engine.canonical_hash());

        let mut mislabeled: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        mislabeled["schemaVersion"] = serde_json::json!(30);
        let mislabeled: CoreSnapshot = serde_json::from_value(mislabeled).unwrap();
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v32_round_trips_text_path_styles_and_v31_rejects_them() {
        let mut engine = DocumentEngine::new();
        let node: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-000000000471",
            "name": "Curved label", "kind": "textPath",
            "x": 0.0, "y": 0.0, "width": 100.0, "height": 40.0,
            "fill": "#111111", "stroke": "#00000000", "strokeWidth": 0.0,
            "opacity": 1.0, "cornerRadius": 0.0,
            "text": "Curve", "visible": true, "locked": false,
            "vectorPath": {
                "fillRule": "nonZero",
                "subpaths": [{
                    "closed": false,
                    "points": [
                        { "id": "00000000-0000-4000-8000-000000000472", "x": 0.0, "y": 20.0, "pointType": "corner" },
                        { "id": "00000000-0000-4000-8000-000000000473", "x": 100.0, "y": 20.0, "pointType": "corner" }
                    ]
                }]
            },
            "textProperties": {
                "runs": [{
                    "start": 0, "end": 5, "fontSize": 18.0, "fontWeight": 600,
                    "italic": false, "letterSpacing": 1.0
                }],
                "paragraph": { "alignment": "left", "lineHeight": 22.0, "paragraphSpacing": 0.0 },
                "autoSize": "fixed", "fallbackFonts": []
            }
        }))
        .unwrap();
        engine
            .submit_batch(NodeId(0x474), 0, vec![BatchCommand::Create { node }])
            .unwrap();

        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":32"));
        assert!(snapshot.contains("\"kind\":\"textPath\""));
        assert!(snapshot.contains("\"fontSize\":18.0"));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), engine.canonical_hash());

        let mut mislabeled: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        mislabeled["schemaVersion"] = serde_json::json!(31);
        let mut mislabeled: CoreSnapshot = serde_json::from_value(mislabeled).unwrap();
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
        mislabeled.nodes[0].text_properties = None;
        assert_eq!(validate_core_snapshot_version(&mislabeled), Ok(()));
    }

    #[test]
    fn snapshot_v34_round_trips_paragraph_indent_and_v33_rejects_it() {
        let mut engine = DocumentEngine::new();
        let node: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-00000000047a",
            "name": "Indented label", "kind": "shapeWithText",
            "x": 0.0, "y": 0.0, "width": 100.0, "height": 60.0,
            "fill": "#ffffff", "stroke": "#00000000", "strokeWidth": 0.0,
            "opacity": 1.0, "cornerRadius": 0.0,
            "text": "Inset", "visible": true, "locked": false,
            "shapeWithTextType": "ROUNDED_RECTANGLE",
            "textProperties": {
                "runs": [{
                    "start": 0, "end": 5, "fontSize": 18.0, "fontWeight": 400,
                    "italic": false, "letterSpacing": 0.0
                }],
                "paragraph": {
                    "alignment": "left", "lineHeight": 22.0,
                    "paragraphSpacing": 0.0, "paragraphIndent": 14.0
                },
                "autoSize": "fixed", "fallbackFonts": []
            }
        }))
        .unwrap();
        engine
            .submit_batch(NodeId(0x47b), 0, vec![BatchCommand::Create { node }])
            .unwrap();

        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":34"));
        assert!(snapshot.contains("\"paragraphIndent\":14.0"));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), engine.canonical_hash());

        let mut mislabeled: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        mislabeled["schemaVersion"] = serde_json::json!(33);
        let mislabeled: CoreSnapshot = serde_json::from_value(mislabeled).unwrap();
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v35_round_trips_text_wrap_style_and_v34_rejects_it() {
        let mut engine = DocumentEngine::new();
        let node: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-00000000047c",
            "name": "Balanced label", "kind": "shapeWithText",
            "x": 0.0, "y": 0.0, "width": 90.0, "height": 60.0,
            "fill": "#ffffff", "stroke": "#00000000", "strokeWidth": 0.0,
            "opacity": 1.0, "cornerRadius": 0.0,
            "text": "aa bb cc dd", "visible": true, "locked": false,
            "shapeWithTextType": "ROUNDED_RECTANGLE",
            "textProperties": {
                "runs": [{
                    "start": 0, "end": 11, "fontSize": 18.0, "fontWeight": 400,
                    "italic": false, "letterSpacing": 0.0
                }],
                "paragraph": {
                    "alignment": "left", "lineHeight": 22.0,
                    "paragraphSpacing": 0.0, "textWrapStyle": "balance"
                },
                "autoSize": "fixed", "fallbackFonts": []
            }
        }))
        .unwrap();
        engine
            .submit_batch(NodeId(0x47d), 0, vec![BatchCommand::Create { node }])
            .unwrap();

        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":35"));
        assert!(snapshot.contains("\"textWrapStyle\":\"balance\""));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), engine.canonical_hash());

        let mut mislabeled: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        mislabeled["schemaVersion"] = serde_json::json!(34);
        let mislabeled: CoreSnapshot = serde_json::from_value(mislabeled).unwrap();
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v36_round_trips_text_hyperlink_and_v35_rejects_it() {
        let mut engine = DocumentEngine::new();
        let node: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-00000000047e",
            "name": "Linked label", "kind": "text",
            "x": 0.0, "y": 0.0, "width": 90.0, "height": 30.0,
            "fill": "#111111", "stroke": "#00000000", "strokeWidth": 0.0,
            "opacity": 1.0, "cornerRadius": 0.0,
            "text": "Link", "visible": true, "locked": false,
            "textProperties": {
                "runs": [{
                    "start": 0, "end": 4, "fontSize": 16.0, "fontWeight": 400,
                    "italic": false, "letterSpacing": 0.0,
                    "hyperlink": { "type": "URL", "value": "https://example.com" }
                }],
                "paragraph": { "alignment": "left", "lineHeight": 20.0, "paragraphSpacing": 0.0 },
                "autoSize": "fixed", "fallbackFonts": []
            }
        }))
        .unwrap();
        engine
            .submit_batch(NodeId(0x47f), 0, vec![BatchCommand::Create { node }])
            .unwrap();
        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":36"));
        assert!(
            snapshot.contains("\"hyperlink\":{\"type\":\"URL\",\"value\":\"https://example.com\"}")
        );
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), engine.canonical_hash());

        let mut mislabeled: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        mislabeled["schemaVersion"] = serde_json::json!(35);
        let mislabeled: CoreSnapshot = serde_json::from_value(mislabeled).unwrap();
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v37_round_trips_text_decoration_and_v36_rejects_it() {
        let mut engine = DocumentEngine::new();
        let node: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-000000000480",
            "name": "Underlined label", "kind": "text",
            "x": 0.0, "y": 0.0, "width": 90.0, "height": 30.0,
            "fill": "#111111", "stroke": "#00000000", "strokeWidth": 0.0,
            "opacity": 1.0, "cornerRadius": 0.0,
            "text": "Line", "visible": true, "locked": false,
            "textProperties": {
                "runs": [{
                    "start": 0, "end": 4, "fontSize": 16.0, "fontWeight": 400,
                    "italic": false, "letterSpacing": 0.0,
                    "textDecoration": "underline"
                }],
                "paragraph": { "alignment": "left", "lineHeight": 20.0, "paragraphSpacing": 0.0 },
                "autoSize": "fixed", "fallbackFonts": []
            }
        }))
        .unwrap();
        engine
            .submit_batch(NodeId(0x480), 0, vec![BatchCommand::Create { node }])
            .unwrap();
        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":37"));
        assert!(snapshot.contains("\"textDecoration\":\"underline\""));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), engine.canonical_hash());

        let mut mislabeled: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        mislabeled["schemaVersion"] = serde_json::json!(36);
        let mislabeled: CoreSnapshot = serde_json::from_value(mislabeled).unwrap();
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v38_round_trips_text_decoration_style_and_v37_rejects_it() {
        let mut engine = DocumentEngine::new();
        let node: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-000000000485",
            "name": "Wavy label", "kind": "text",
            "x": 0.0, "y": 0.0, "width": 90.0, "height": 30.0,
            "fill": "#111111", "stroke": "#00000000", "strokeWidth": 0.0,
            "opacity": 1.0, "cornerRadius": 0.0,
            "text": "Wave", "visible": true, "locked": false,
            "textProperties": {
                "runs": [{
                    "start": 0, "end": 4, "fontSize": 16.0, "fontWeight": 400,
                    "italic": false, "letterSpacing": 0.0,
                    "textDecoration": "underline", "textDecorationStyle": "wavy"
                }],
                "paragraph": { "alignment": "left", "lineHeight": 20.0, "paragraphSpacing": 0.0 },
                "autoSize": "fixed", "fallbackFonts": []
            }
        }))
        .unwrap();
        engine
            .submit_batch(NodeId(0x486), 0, vec![BatchCommand::Create { node }])
            .unwrap();
        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":38"));
        assert!(snapshot.contains("\"textDecorationStyle\":\"wavy\""));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), engine.canonical_hash());

        let mut mislabeled: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        mislabeled["schemaVersion"] = serde_json::json!(37);
        let mislabeled: CoreSnapshot = serde_json::from_value(mislabeled).unwrap();
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v39_round_trips_text_decoration_offset_and_v38_rejects_it() {
        let mut engine = DocumentEngine::new();
        let node: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-000000000487",
            "name": "Offset label", "kind": "text",
            "x": 0.0, "y": 0.0, "width": 90.0, "height": 30.0,
            "fill": "#111111", "stroke": "#00000000", "strokeWidth": 0.0,
            "opacity": 1.0, "cornerRadius": 0.0,
            "text": "Line", "visible": true, "locked": false,
            "textProperties": {
                "runs": [{
                    "start": 0, "end": 4, "fontSize": 16.0, "fontWeight": 400,
                    "italic": false, "letterSpacing": 0.0,
                    "textDecoration": "underline",
                    "textDecorationOffset": { "value": -25.0, "unit": "percent" }
                }],
                "paragraph": { "alignment": "left", "lineHeight": 20.0, "paragraphSpacing": 0.0 },
                "autoSize": "fixed", "fallbackFonts": []
            }
        }))
        .unwrap();
        engine
            .submit_batch(NodeId(0x488), 0, vec![BatchCommand::Create { node }])
            .unwrap();
        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":39"));
        assert!(
            snapshot.contains("\"textDecorationOffset\":{\"value\":-25.0,\"unit\":\"percent\"}")
        );
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), engine.canonical_hash());

        let mut mislabeled: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        mislabeled["schemaVersion"] = serde_json::json!(38);
        let mislabeled: CoreSnapshot = serde_json::from_value(mislabeled).unwrap();
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v40_round_trips_text_decoration_thickness_and_v39_rejects_it() {
        let mut engine = DocumentEngine::new();
        let node: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-000000000489",
            "name": "Thick label", "kind": "text",
            "x": 0.0, "y": 0.0, "width": 90.0, "height": 30.0,
            "fill": "#111111", "stroke": "#00000000", "strokeWidth": 0.0,
            "opacity": 1.0, "cornerRadius": 0.0,
            "text": "Line", "visible": true, "locked": false,
            "textProperties": {
                "runs": [{
                    "start": 0, "end": 4, "fontSize": 16.0, "fontWeight": 400,
                    "italic": false, "letterSpacing": 0.0,
                    "textDecoration": "underline",
                    "textDecorationThickness": { "value": 12.5, "unit": "percent" }
                }],
                "paragraph": { "alignment": "left", "lineHeight": 20.0, "paragraphSpacing": 0.0 },
                "autoSize": "fixed", "fallbackFonts": []
            }
        }))
        .unwrap();
        engine
            .submit_batch(NodeId(0x48a), 0, vec![BatchCommand::Create { node }])
            .unwrap();
        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":40"));
        assert!(
            snapshot.contains("\"textDecorationThickness\":{\"value\":12.5,\"unit\":\"percent\"}")
        );
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), engine.canonical_hash());

        let mut mislabeled: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        mislabeled["schemaVersion"] = serde_json::json!(39);
        let mislabeled: CoreSnapshot = serde_json::from_value(mislabeled).unwrap();
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v41_round_trips_text_decoration_color_and_v40_rejects_it() {
        let mut engine = DocumentEngine::new();
        let node: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-00000000048b",
            "name": "Colored underline", "kind": "text",
            "x": 0.0, "y": 0.0, "width": 120.0, "height": 30.0,
            "fill": "#111111", "stroke": "#00000000", "strokeWidth": 0.0,
            "opacity": 1.0, "cornerRadius": 0.0,
            "text": "Color", "visible": true, "locked": false,
            "textProperties": {
                "runs": [{
                    "start": 0, "end": 5, "fontSize": 16.0, "fontWeight": 400,
                    "italic": false, "letterSpacing": 0.0,
                    "textDecoration": "underline",
                    "textDecorationColor": {
                        "color": { "space": "srgb", "components": [1.0, 0.25, 0.5], "alpha": 1.0 },
                        "visible": true, "opacity": 0.75, "blendMode": "multiply"
                    }
                }],
                "paragraph": { "alignment": "left", "lineHeight": 20.0, "paragraphSpacing": 0.0 },
                "autoSize": "fixed", "fallbackFonts": []
            }
        }))
        .unwrap();
        engine
            .submit_batch(NodeId(0x48c), 0, vec![BatchCommand::Create { node }])
            .unwrap();
        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":41"));
        assert!(snapshot.contains("\"textDecorationColor\":{"));
        assert!(snapshot.contains("\"blendMode\":\"multiply\""));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), engine.canonical_hash());

        let mut mislabeled: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        mislabeled["schemaVersion"] = serde_json::json!(40);
        let mislabeled: CoreSnapshot = serde_json::from_value(mislabeled).unwrap();
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v42_round_trips_text_decoration_skip_ink_and_v41_rejects_it() {
        let mut engine = DocumentEngine::new();
        let node: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-00000000048d",
            "name": "Skip ink", "kind": "text",
            "x": 0.0, "y": 0.0, "width": 120.0, "height": 30.0,
            "fill": "#111111", "stroke": "#00000000", "strokeWidth": 0.0,
            "opacity": 1.0, "cornerRadius": 0.0,
            "text": "glyph", "visible": true, "locked": false,
            "textProperties": {
                "runs": [{
                    "start": 0, "end": 5, "fontSize": 16.0, "fontWeight": 400,
                    "italic": false, "letterSpacing": 0.0,
                    "textDecoration": "underline", "textDecorationSkipInk": true
                }],
                "paragraph": { "alignment": "left", "lineHeight": 20.0, "paragraphSpacing": 0.0 },
                "autoSize": "fixed", "fallbackFonts": []
            }
        }))
        .unwrap();
        engine
            .submit_batch(NodeId(0x48e), 0, vec![BatchCommand::Create { node }])
            .unwrap();
        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":42"));
        assert!(snapshot.contains("\"textDecorationSkipInk\":true"));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), engine.canonical_hash());

        let mut mislabeled: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        mislabeled["schemaVersion"] = serde_json::json!(41);
        let mislabeled: CoreSnapshot = serde_json::from_value(mislabeled).unwrap();
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v43_round_trips_leading_trim_and_v42_rejects_it() {
        let mut engine = DocumentEngine::new();
        let node: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-00000000048f",
            "name": "Cap height", "kind": "text",
            "x": 0.0, "y": 0.0, "width": 120.0, "height": 30.0,
            "fill": "#111111", "stroke": "#00000000", "strokeWidth": 0.0,
            "opacity": 1.0, "cornerRadius": 0.0,
            "text": "Cap", "visible": true, "locked": false,
            "textProperties": {
                "runs": [{
                    "start": 0, "end": 3, "fontSize": 16.0, "fontWeight": 400,
                    "italic": false, "letterSpacing": 0.0, "leadingTrim": "capHeight"
                }],
                "paragraph": { "alignment": "left", "lineHeight": 24.0, "paragraphSpacing": 0.0 },
                "autoSize": "fixed", "fallbackFonts": []
            }
        }))
        .unwrap();
        engine
            .submit_batch(NodeId(0x490), 0, vec![BatchCommand::Create { node }])
            .unwrap();
        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":43"));
        assert!(snapshot.contains("\"leadingTrim\":\"capHeight\""));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), engine.canonical_hash());
        let mut mislabeled: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        mislabeled["schemaVersion"] = serde_json::json!(42);
        let mislabeled: CoreSnapshot = serde_json::from_value(mislabeled).unwrap();
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v44_round_trips_text_list_type_and_v43_rejects_it() {
        let mut engine = DocumentEngine::new();
        let node: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-000000000491",
            "name": "Ordered list", "kind": "text",
            "x": 0.0, "y": 0.0, "width": 120.0, "height": 60.0,
            "fill": "#111111", "stroke": "#00000000", "strokeWidth": 0.0,
            "opacity": 1.0, "cornerRadius": 0.0,
            "text": "One\nTwo", "visible": true, "locked": false,
            "textProperties": {
                "runs": [{
                    "start": 0, "end": 7, "fontSize": 16.0, "fontWeight": 400,
                    "italic": false, "letterSpacing": 0.0
                }],
                "paragraph": {
                    "alignment": "left", "lineHeight": 20.0,
                    "paragraphSpacing": 0.0, "listType": "ordered"
                },
                "autoSize": "fixed", "fallbackFonts": []
            }
        }))
        .unwrap();
        engine
            .submit_batch(NodeId(0x492), 0, vec![BatchCommand::Create { node }])
            .unwrap();
        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":44"));
        assert!(snapshot.contains("\"listType\":\"ordered\""));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), engine.canonical_hash());

        let mut mislabeled: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        mislabeled["schemaVersion"] = serde_json::json!(43);
        let mislabeled: CoreSnapshot = serde_json::from_value(mislabeled).unwrap();
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v45_round_trips_text_list_spacing_and_v44_rejects_it() {
        let mut engine = DocumentEngine::new();
        let node: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-000000000493",
            "name": "Spaced list", "kind": "text",
            "x": 0.0, "y": 0.0, "width": 120.0, "height": 68.0,
            "fill": "#111111", "stroke": "#00000000", "strokeWidth": 0.0,
            "opacity": 1.0, "cornerRadius": 0.0,
            "text": "One\nTwo", "visible": true, "locked": false,
            "textProperties": {
                "runs": [{
                    "start": 0, "end": 7, "fontSize": 16.0, "fontWeight": 400,
                    "italic": false, "letterSpacing": 0.0
                }],
                "paragraph": {
                    "alignment": "left", "lineHeight": 20.0,
                    "paragraphSpacing": 0.0, "listType": "ordered", "listSpacing": 8.0
                },
                "autoSize": "fixed", "fallbackFonts": []
            }
        }))
        .unwrap();
        engine
            .submit_batch(NodeId(0x493), 0, vec![BatchCommand::Create { node }])
            .unwrap();
        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":45"));
        assert!(snapshot.contains("\"listSpacing\":8.0"));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), engine.canonical_hash());

        let mut mislabeled: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        mislabeled["schemaVersion"] = serde_json::json!(44);
        let mislabeled: CoreSnapshot = serde_json::from_value(mislabeled).unwrap();
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v46_round_trips_paragraph_indentation_and_v45_rejects_it() {
        let mut engine = DocumentEngine::new();
        let node: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-000000000494",
            "name": "Nested list", "kind": "text",
            "x": 0.0, "y": 0.0, "width": 120.0, "height": 68.0,
            "fill": "#111111", "stroke": "#00000000", "strokeWidth": 0.0,
            "opacity": 1.0, "cornerRadius": 0.0,
            "text": "One\nTwo", "visible": true, "locked": false,
            "textProperties": {
                "runs": [{
                    "start": 0, "end": 7, "fontSize": 16.0, "fontWeight": 400,
                    "italic": false, "letterSpacing": 0.0
                }],
                "paragraph": {
                    "alignment": "left", "lineHeight": 20.0,
                    "paragraphSpacing": 0.0, "listType": "ordered"
                },
                "paragraphStyleRuns": [{ "start": 4, "indentation": 2 }],
                "autoSize": "fixed", "fallbackFonts": []
            }
        }))
        .unwrap();
        engine
            .submit_batch(NodeId(0x494), 0, vec![BatchCommand::Create { node }])
            .unwrap();
        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":46"));
        assert!(snapshot.contains("\"paragraphStyleRuns\":[{\"start\":4,\"indentation\":2}]"));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), engine.canonical_hash());

        let mut mislabeled: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        mislabeled["schemaVersion"] = serde_json::json!(45);
        let mislabeled: CoreSnapshot = serde_json::from_value(mislabeled).unwrap();
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v47_round_trips_hanging_list_and_v46_rejects_it() {
        let mut engine = DocumentEngine::new();
        let node: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-000000000495",
            "name": "Hanging list", "kind": "text",
            "x": 0.0, "y": 0.0, "width": 120.0, "height": 68.0,
            "fill": "#111111", "stroke": "#00000000", "strokeWidth": 0.0,
            "opacity": 1.0, "cornerRadius": 0.0,
            "text": "One\nTwo", "visible": true, "locked": false,
            "textProperties": {
                "runs": [{
                    "start": 0, "end": 7, "fontSize": 16.0, "fontWeight": 400,
                    "italic": false, "letterSpacing": 0.0
                }],
                "paragraph": {
                    "alignment": "left", "lineHeight": 20.0,
                    "paragraphSpacing": 0.0, "listType": "ordered", "hangingList": true
                },
                "autoSize": "fixed", "fallbackFonts": []
            }
        }))
        .unwrap();
        engine
            .submit_batch(NodeId(0x495), 0, vec![BatchCommand::Create { node }])
            .unwrap();
        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":47"));
        assert!(snapshot.contains("\"hangingList\":true"));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), engine.canonical_hash());

        let mut mislabeled: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        mislabeled["schemaVersion"] = serde_json::json!(46);
        let mislabeled: CoreSnapshot = serde_json::from_value(mislabeled).unwrap();
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v48_round_trips_paragraph_list_options_and_v47_rejects_it() {
        let mut engine = DocumentEngine::new();
        let node: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-000000000496",
            "name": "Mixed list", "kind": "text",
            "x": 0.0, "y": 0.0, "width": 120.0, "height": 68.0,
            "fill": "#111111", "stroke": "#00000000", "strokeWidth": 0.0,
            "opacity": 1.0, "cornerRadius": 0.0,
            "text": "One\nTwo", "visible": true, "locked": false,
            "textProperties": {
                "runs": [{
                    "start": 0, "end": 7, "fontSize": 16.0, "fontWeight": 400,
                    "italic": false, "letterSpacing": 0.0
                }],
                "paragraph": {
                    "alignment": "left", "lineHeight": 20.0,
                    "paragraphSpacing": 0.0, "listType": "ordered"
                },
                "paragraphStyleRuns": [{ "start": 4, "listType": "none" }],
                "autoSize": "fixed", "fallbackFonts": []
            }
        }))
        .unwrap();
        engine
            .submit_batch(NodeId(0x496), 0, vec![BatchCommand::Create { node }])
            .unwrap();
        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":48"));
        assert!(snapshot.contains("\"paragraphStyleRuns\":[{\"start\":4,\"listType\":\"none\"}]"));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), engine.canonical_hash());

        let mut mislabeled: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        mislabeled["schemaVersion"] = serde_json::json!(47);
        let mislabeled: CoreSnapshot = serde_json::from_value(mislabeled).unwrap();
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v49_round_trips_paragraph_list_spacing_and_v48_rejects_it() {
        let mut engine = DocumentEngine::new();
        let node: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-000000000497",
            "name": "Mixed list spacing", "kind": "text",
            "x": 0.0, "y": 0.0, "width": 120.0, "height": 68.0,
            "fill": "#111111", "stroke": "#00000000", "strokeWidth": 0.0,
            "opacity": 1.0, "cornerRadius": 0.0,
            "text": "One\nTwo", "visible": true, "locked": false,
            "textProperties": {
                "runs": [{
                    "start": 0, "end": 7, "fontSize": 16.0, "fontWeight": 400,
                    "italic": false, "letterSpacing": 0.0
                }],
                "paragraph": {
                    "alignment": "left", "lineHeight": 20.0,
                    "paragraphSpacing": 0.0, "listType": "ordered", "listSpacing": 8.0
                },
                "paragraphStyleRuns": [{ "start": 0, "listSpacing": 0.0 }],
                "autoSize": "fixed", "fallbackFonts": []
            }
        }))
        .unwrap();
        engine
            .submit_batch(NodeId(0x497), 0, vec![BatchCommand::Create { node }])
            .unwrap();
        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":49"));
        assert!(snapshot.contains("\"paragraphStyleRuns\":[{\"start\":0,\"listSpacing\":0.0}]"));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), engine.canonical_hash());

        let mut mislabeled: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        mislabeled["schemaVersion"] = serde_json::json!(48);
        let mislabeled: CoreSnapshot = serde_json::from_value(mislabeled).unwrap();
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v50_round_trips_paragraph_spacing_and_v49_rejects_it() {
        let mut engine = DocumentEngine::new();
        let node: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-000000000498",
            "name": "Mixed paragraph spacing", "kind": "text",
            "x": 0.0, "y": 0.0, "width": 120.0, "height": 68.0,
            "fill": "#111111", "stroke": "#00000000", "strokeWidth": 0.0,
            "opacity": 1.0, "cornerRadius": 0.0,
            "text": "One\nTwo", "visible": true, "locked": false,
            "textProperties": {
                "runs": [{
                    "start": 0, "end": 7, "fontSize": 16.0, "fontWeight": 400,
                    "italic": false, "letterSpacing": 0.0
                }],
                "paragraph": {
                    "alignment": "left", "lineHeight": 20.0,
                    "paragraphSpacing": 8.0
                },
                "paragraphStyleRuns": [{ "start": 0, "paragraphSpacing": 0.0 }],
                "autoSize": "fixed", "fallbackFonts": []
            }
        }))
        .unwrap();
        engine
            .submit_batch(NodeId(0x498), 0, vec![BatchCommand::Create { node }])
            .unwrap();
        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":50"));
        assert!(
            snapshot.contains("\"paragraphStyleRuns\":[{\"start\":0,\"paragraphSpacing\":0.0}]")
        );
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), engine.canonical_hash());

        let mut mislabeled: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        mislabeled["schemaVersion"] = serde_json::json!(49);
        let mislabeled: CoreSnapshot = serde_json::from_value(mislabeled).unwrap();
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v51_round_trips_paragraph_indent_and_v50_rejects_it() {
        let mut engine = DocumentEngine::new();
        let node: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-000000000499",
            "name": "Mixed paragraph indent", "kind": "text",
            "x": 0.0, "y": 0.0, "width": 120.0, "height": 68.0,
            "fill": "#111111", "stroke": "#00000000", "strokeWidth": 0.0,
            "opacity": 1.0, "cornerRadius": 0.0,
            "text": "One\nTwo", "visible": true, "locked": false,
            "textProperties": {
                "runs": [{
                    "start": 0, "end": 7, "fontSize": 16.0, "fontWeight": 400,
                    "italic": false, "letterSpacing": 0.0
                }],
                "paragraph": {
                    "alignment": "left", "lineHeight": 20.0,
                    "paragraphSpacing": 0.0, "paragraphIndent": 8.0
                },
                "paragraphStyleRuns": [{ "start": 0, "paragraphIndent": 0.0 }],
                "autoSize": "fixed", "fallbackFonts": []
            }
        }))
        .unwrap();
        engine
            .submit_batch(NodeId(0x499), 0, vec![BatchCommand::Create { node }])
            .unwrap();
        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":51"));
        assert!(
            snapshot.contains("\"paragraphStyleRuns\":[{\"start\":0,\"paragraphIndent\":0.0}]")
        );
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), engine.canonical_hash());

        let mut mislabeled: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        mislabeled["schemaVersion"] = serde_json::json!(50);
        let mislabeled: CoreSnapshot = serde_json::from_value(mislabeled).unwrap();
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v52_round_trips_paragraph_line_height_and_v51_rejects_it() {
        let mut engine = DocumentEngine::new();
        let node: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-00000000049a",
            "name": "Mixed paragraph line height", "kind": "text",
            "x": 0.0, "y": 0.0, "width": 120.0, "height": 68.0,
            "fill": "#111111", "stroke": "#00000000", "strokeWidth": 0.0,
            "opacity": 1.0, "cornerRadius": 0.0,
            "text": "One\nTwo", "visible": true, "locked": false,
            "textProperties": {
                "runs": [{
                    "start": 0, "end": 7, "fontSize": 16.0, "fontWeight": 400,
                    "italic": false, "letterSpacing": 0.0
                }],
                "paragraph": {
                    "alignment": "left", "lineHeight": 20.0,
                    "paragraphSpacing": 0.0
                },
                "paragraphStyleRuns": [{
                    "start": 0, "lineHeight": 150.0, "lineHeightUnit": "percent"
                }, { "start": 4, "lineHeightUnit": "auto" }],
                "autoSize": "fixed", "fallbackFonts": []
            }
        }))
        .unwrap();
        engine
            .submit_batch(NodeId(0x49a), 0, vec![BatchCommand::Create { node }])
            .unwrap();
        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":52"));
        assert!(snapshot.contains("\"lineHeightUnit\":\"percent\""));
        assert!(snapshot.contains("\"lineHeightUnit\":\"auto\""));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), engine.canonical_hash());

        let mut mislabeled: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        mislabeled["schemaVersion"] = serde_json::json!(51);
        let mislabeled: CoreSnapshot = serde_json::from_value(mislabeled).unwrap();
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v53_round_trips_hanging_punctuation_and_v52_rejects_it() {
        let mut engine = DocumentEngine::new();
        let node: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-00000000049b",
            "name": "Hanging punctuation", "kind": "text",
            "x": 0.0, "y": 0.0, "width": 120.0, "height": 24.0,
            "fill": "#111111", "stroke": "#00000000", "strokeWidth": 0.0,
            "opacity": 1.0, "cornerRadius": 0.0,
            "text": "“Text.”", "visible": true, "locked": false,
            "textProperties": {
                "runs": [{
                    "start": 0, "end": 11, "fontSize": 16.0, "fontWeight": 400,
                    "italic": false, "letterSpacing": 0.0
                }],
                "paragraph": {
                    "alignment": "left", "lineHeight": 20.0,
                    "paragraphSpacing": 0.0, "hangingPunctuation": true
                },
                "autoSize": "fixed", "fallbackFonts": []
            }
        }))
        .unwrap();
        engine
            .submit_batch(NodeId(0x49b), 0, vec![BatchCommand::Create { node }])
            .unwrap();
        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":53"));
        assert!(snapshot.contains("\"hangingPunctuation\":true"));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), engine.canonical_hash());

        let mut mislabeled: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        mislabeled["schemaVersion"] = serde_json::json!(52);
        let mislabeled: CoreSnapshot = serde_json::from_value(mislabeled).unwrap();
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v54_round_trips_paragraph_text_wrap_style_and_v53_rejects_it() {
        let mut engine = DocumentEngine::new();
        let node: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-00000000049c",
            "name": "Mixed paragraph wrapping", "kind": "text",
            "x": 0.0, "y": 0.0, "width": 120.0, "height": 48.0,
            "fill": "#111111", "stroke": "#00000000", "strokeWidth": 0.0,
            "opacity": 1.0, "cornerRadius": 0.0,
            "text": "One\nTwo", "visible": true, "locked": false,
            "textProperties": {
                "runs": [{
                    "start": 0, "end": 7, "fontSize": 16.0, "fontWeight": 400,
                    "italic": false, "letterSpacing": 0.0
                }],
                "paragraph": {
                    "alignment": "left", "lineHeight": 20.0,
                    "paragraphSpacing": 0.0, "textWrapStyle": "balance"
                },
                "paragraphStyleRuns": [{ "start": 4, "textWrapStyle": "auto" }],
                "autoSize": "fixed", "fallbackFonts": []
            }
        }))
        .unwrap();
        engine
            .submit_batch(NodeId(0x49c), 0, vec![BatchCommand::Create { node }])
            .unwrap();
        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":54"));
        assert!(snapshot.contains("\"textWrapStyle\":\"auto\""));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), engine.canonical_hash());

        let mut mislabeled: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        mislabeled["schemaVersion"] = serde_json::json!(53);
        let mislabeled: CoreSnapshot = serde_json::from_value(mislabeled).unwrap();
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v55_round_trips_font_face_metadata_and_v54_rejects_it() {
        let mut engine = DocumentEngine::new();
        engine
            .register_asset(
                "00000000-0000-0000-0000-000000000001",
                0,
                "00000000-0000-0000-0000-000000000055",
                &"55".repeat(32),
                "font/ttf",
                512,
                0,
                0,
                r#"[{"faceIndex":0,"family":"Acme Sans","style":"Regular"}]"#,
            )
            .unwrap();
        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":55"));
        assert!(snapshot.contains("\"family\":\"Acme Sans\""));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), engine.canonical_hash());

        let mut mislabeled: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        mislabeled["schemaVersion"] = serde_json::json!(54);
        let mislabeled: CoreSnapshot = serde_json::from_value(mislabeled).unwrap();
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v56_round_trips_localized_font_aliases_and_v55_rejects_them() {
        let mut engine = DocumentEngine::new();
        engine
            .register_asset(
                "00000000-0000-0000-0000-000000000001",
                0,
                "00000000-0000-0000-0000-000000000056",
                &"56".repeat(32),
                "font/ttf",
                512,
                0,
                0,
                r#"[{"faceIndex":0,"family":"Acme Sans","style":"Regular","aliases":[{"family":"思源黑体","style":"常规"}]}]"#,
            )
            .unwrap();
        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":56"));
        assert!(snapshot.contains("\"family\":\"思源黑体\""));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), engine.canonical_hash());

        let mut mislabeled: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        mislabeled["schemaVersion"] = serde_json::json!(55);
        let mislabeled: CoreSnapshot = serde_json::from_value(mislabeled).unwrap();
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn complete_text_path_update_changes_rotation_without_replacing_its_base_path() {
        let mut engine = DocumentEngine::new();
        let mut node: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-000000000481",
            "name": "Curved label", "kind": "textPath",
            "x": 10.0, "y": 20.0, "width": 100.0, "height": 40.0,
            "rotation": 0.0,
            "fill": "#111111", "stroke": "#00000000", "strokeWidth": 0.0,
            "opacity": 1.0, "cornerRadius": 0.0,
            "text": "Curve", "visible": true, "locked": false,
            "vectorPath": {
                "fillRule": "nonZero",
                "subpaths": [{
                    "closed": false,
                    "points": [
                        { "id": "00000000-0000-4000-8000-000000000482", "x": 0.0, "y": 20.0, "pointType": "corner" },
                        { "id": "00000000-0000-4000-8000-000000000483", "x": 100.0, "y": 20.0, "pointType": "corner" }
                    ]
                }]
            },
            "textProperties": {
                "runs": [{
                    "start": 0, "end": 5, "fontSize": 18.0, "fontWeight": 400,
                    "italic": false, "letterSpacing": 0.0
                }],
                "paragraph": { "alignment": "left", "lineHeight": 22.0, "paragraphSpacing": 0.0 },
                "autoSize": "fixed", "fallbackFonts": []
            }
        }))
        .unwrap();
        engine
            .submit_batch(
                NodeId(0x484),
                0,
                vec![BatchCommand::Create { node: node.clone() }],
            )
            .unwrap();
        let node_id = parse_id("00000000-0000-4000-8000-000000000481").unwrap();
        let original_path = engine.document.node(node_id).unwrap().vector_path.clone();
        node.rotation = 28.0;

        assert_eq!(
            engine
                .submit_batch(
                    NodeId(0x485),
                    1,
                    vec![BatchCommand::Update {
                        node,
                        ignore_constraints: false,
                        plain_text_only: false,
                        rename_text_path: false,
                    }],
                )
                .unwrap(),
            2,
        );
        let updated = engine.document.node(node_id).unwrap();
        assert_eq!(updated.rotation, 28.0);
        assert_eq!(updated.vector_path, original_path);
    }

    #[test]
    fn snapshot_v25_retains_v24_pass_through_nodes() {
        let mut engine = DocumentEngine::new();
        let node: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-000000000421",
            "name": "Pass through frame", "kind": "frame",
            "x": 0.0, "y": 0.0, "width": 120.0, "height": 80.0,
            "fill": "#ffffff", "stroke": "#00000000", "strokeWidth": 0.0,
            "opacity": 1.0, "blendMode": "pass-through", "cornerRadius": 0.0,
            "text": "", "visible": true, "locked": false
        }))
        .unwrap();
        engine
            .submit_batch(NodeId(0x422), 0, vec![BatchCommand::Create { node }])
            .unwrap();

        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":32"));
        assert!(snapshot.contains("\"blendMode\":\"pass-through\""));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        let node_id = parse_id("00000000-0000-4000-8000-000000000421").unwrap();
        assert_eq!(
            restored.document.node(node_id).unwrap().blend_mode,
            BlendMode::PassThrough
        );

        let mut mislabeled: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        mislabeled["schemaVersion"] = serde_json::json!(23);
        let mislabeled: CoreSnapshot = serde_json::from_value(mislabeled).unwrap();
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn snapshot_v26_requires_isolated_normal_markers_to_use_the_new_schema() {
        let mut engine = DocumentEngine::new();
        let node: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-000000000425",
            "name": "Isolated normal frame", "kind": "frame",
            "x": 0.0, "y": 0.0, "width": 120.0, "height": 80.0,
            "fill": "#ffffff", "stroke": "#00000000", "strokeWidth": 0.0,
            "opacity": 1.0, "blendMode": "normal", "cornerRadius": 0.0,
            "text": "", "visible": true, "locked": false,
            "extensions": {
                "makefigma.blend.normal-isolation.v1": [1]
            }
        }))
        .unwrap();
        engine
            .submit_batch(NodeId(0x426), 0, vec![BatchCommand::Create { node }])
            .unwrap();

        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":32"));
        assert!(snapshot.contains("\"makefigma.blend.normal-isolation.v1\":[1]"));
        let node_id = parse_id("00000000-0000-4000-8000-000000000425").unwrap();
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(
            restored
                .document
                .node(node_id)
                .unwrap()
                .extensions
                .get(makefigma_document_codec::NORMAL_BLEND_ISOLATION_EXTENSION),
            Some(&vec![1])
        );

        let mut mislabeled: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        mislabeled["schemaVersion"] = serde_json::json!(25);
        let mislabeled: CoreSnapshot = serde_json::from_value(mislabeled).unwrap();
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );

        let mut legacy: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        legacy["schemaVersion"] = serde_json::json!(25);
        legacy.as_object_mut().unwrap().remove("canonicalHash");
        legacy["nodes"][0]["extensions"]
            .as_object_mut()
            .unwrap()
            .remove(makefigma_document_codec::NORMAL_BLEND_ISOLATION_EXTENSION);
        let mut legacy_engine = DocumentEngine::new();
        legacy_engine
            .load_snapshot_json(&legacy.to_string())
            .unwrap();
        assert!(
            !legacy_engine
                .document
                .node(node_id)
                .unwrap()
                .extensions
                .contains_key(makefigma_document_codec::NORMAL_BLEND_ISOLATION_EXTENSION)
        );
    }

    #[test]
    fn snapshot_v25_requires_linear_blend_nodes_to_use_the_new_schema() {
        let mut engine = DocumentEngine::new();
        for (offset, blend_mode) in ["linear-burn", "linear-dodge"].into_iter().enumerate() {
            let node: ProjectionNode = serde_json::from_value(serde_json::json!({
                "id": format!("00000000-0000-4000-8000-00000000043{}", offset + 1),
                "name": "Linear blend", "kind": "rectangle",
                "x": offset as f64 * 140.0, "y": 0.0, "width": 120.0, "height": 80.0,
                "fill": "#ffffff", "stroke": "#00000000", "strokeWidth": 0.0,
                "opacity": 1.0, "blendMode": blend_mode, "cornerRadius": 0.0,
                "text": "", "visible": true, "locked": false
            }))
            .unwrap();
            engine
                .submit_batch(
                    NodeId(0x440 + offset as u128),
                    engine.document.revision,
                    vec![BatchCommand::Create { node }],
                )
                .unwrap();
        }
        let paint_layer_node: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-000000000433",
            "name": "Linear paint layer", "kind": "rectangle",
            "x": 280.0, "y": 0.0, "width": 120.0, "height": 80.0,
            "fill": "#ffffff", "stroke": "#00000000", "strokeWidth": 0.0,
            "opacity": 1.0, "blendMode": "normal", "cornerRadius": 0.0,
            "text": "", "visible": true, "locked": false,
            "fillStack": { "layers": [
                { "paint": { "css": "#cc3355" }, "visible": true, "opacity": 0.75, "blendMode": "linear-dodge" }
            ] }
        }))
        .unwrap();
        engine
            .submit_batch(
                NodeId(0x443),
                engine.document.revision,
                vec![BatchCommand::Create {
                    node: paint_layer_node,
                }],
            )
            .unwrap();

        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":32"));
        assert!(snapshot.contains("\"blendMode\":\"linear-burn\""));
        assert!(snapshot.contains("\"blendMode\":\"linear-dodge\""));
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(
            restored
                .document
                .node(parse_id("00000000-0000-4000-8000-000000000431").unwrap())
                .unwrap()
                .blend_mode,
            BlendMode::LinearBurn
        );
        assert_eq!(
            restored
                .document
                .fill_stack_for_node(parse_id("00000000-0000-4000-8000-000000000433").unwrap())
                .unwrap()
                .layers[0]
                .blend_mode,
            BlendMode::LinearDodge
        );

        let mut mislabeled: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        mislabeled["schemaVersion"] = serde_json::json!(24);
        let mislabeled: CoreSnapshot = serde_json::from_value(mislabeled).unwrap();
        assert_eq!(
            validate_core_snapshot_version(&mislabeled),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );

        let mut paint_only: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        paint_only["schemaVersion"] = serde_json::json!(24);
        for node in paint_only["nodes"].as_array_mut().unwrap() {
            node["blendMode"] = serde_json::json!("normal");
        }
        let paint_only: CoreSnapshot = serde_json::from_value(paint_only).unwrap();
        assert_eq!(
            validate_core_snapshot_version(&paint_only),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn non_linear_gradient_paint_stacks_survive_projection_history_and_snapshot_round_trip() {
        let mut engine = DocumentEngine::new();
        let node: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-000000000411",
            "name": "Gradient paint", "kind": "rectangle",
            "x": 0.0, "y": 0.0, "width": 120.0, "height": 80.0,
            "fill": "#ffffff", "stroke": "#00000000", "strokeWidth": 0.0,
            "opacity": 1.0, "cornerRadius": 0.0,
            "text": "", "visible": true, "locked": false,
            "fillStack": { "layers": [
                { "paint": { "css": "#ff0000", "gradientPaint": {
                    "kind": "radial", "transform": { "a": 1.5, "b": 0.25, "c": -0.1, "d": 1.2, "e": -0.2, "f": 0.1 },
                    "stops": [
                        { "position": 0.0, "color": { "space": "srgb", "components": [1.0, 0.0, 0.0], "alpha": 1.0 } },
                        { "position": 1.0, "color": { "space": "linear-srgb", "components": [0.0, 0.0, 1.0], "alpha": 0.5 } }
                    ]
                } }, "visible": true, "opacity": 0.75, "blendMode": "screen" },
                { "paint": { "css": "#00ff00", "gradientPaint": {
                    "kind": "diamond", "transform": { "a": 1.0, "b": 0.0, "c": 0.0, "d": 1.0, "e": 0.0, "f": 0.0 },
                    "stops": [
                        { "position": 0.0, "color": { "space": "srgb", "components": [0.0, 1.0, 0.0], "alpha": 1.0 } },
                        { "position": 1.0, "color": { "space": "srgb", "components": [0.0, 0.0, 0.0], "alpha": 0.0 } }
                    ]
                } }, "visible": true, "opacity": 1.0, "blendMode": "normal" }
            ] }
        })).unwrap();

        engine
            .submit_batch(NodeId(0x412), 0, vec![BatchCommand::Create { node }])
            .unwrap();
        let node_id = parse_id("00000000-0000-4000-8000-000000000411").unwrap();
        let committed_hash = engine.canonical_hash();
        let committed_projection = engine.snapshot_json();
        assert!(committed_projection.contains("\"kind\":\"radial\""));
        assert!(committed_projection.contains("\"kind\":\"diamond\""));
        assert!(matches!(
            engine.document.fill_stack_for_node(node_id),
            Some(PaintStack { layers }) if matches!(layers.as_slice(), [
                PaintLayer { paint: PaintLayerKind::Gradient(GradientPaint { kind: GradientPaintKind::Radial, .. }), .. },
                PaintLayer { paint: PaintLayerKind::Gradient(GradientPaint { kind: GradientPaintKind::Diamond, .. }), .. },
            ])
        ));

        engine.undo().unwrap();
        assert!(engine.document.node(node_id).is_none());
        engine.redo().unwrap();
        assert_eq!(engine.canonical_hash(), committed_hash);

        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&committed_projection).unwrap();
        assert_eq!(restored.canonical_hash(), committed_hash);
        assert_eq!(
            restored.document.fill_stack_for_node(node_id),
            engine.document.fill_stack_for_node(node_id)
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
                        fill_stack: None,
                        stroke_stack: None,
                        fill_style_id: None,
                        stroke_style_id: None,
                        background_style_id: None,
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
                        parametric_shape: None,
                        vector_path: None,
                        boolean_operation: None,
                        relative_transform: None,
                        position_id: None,
                        page_id: None,
                        opacity: 1.0,
                        blend_mode: "normal".into(),
                        drop_shadow: None,
                        effect_stack: Vec::new(),
                        corner_radius: 8.0,
                        corner_radii: Vec::new(),
                        corner_smoothing: 0.0,
                        constraints: None,
                        auto_layout: None,
                        text: String::new(),
                        visible: true,
                        locked: false,
                        contents_hidden: false,
                        clips_content: Some(false),
                        is_mask: false,
                        extensions: Default::default(),
                    },
                }],
            )
            .unwrap();
        let snapshot = engine.snapshot_json();
        assert!(snapshot.contains("\"schemaVersion\":32"));
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
        assert!(round_trip.contains("\"schemaVersion\":32"));
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
    fn alpha_mask_batch_projects_the_reserved_canonical_extension() {
        let mut engine = DocumentEngine::new();
        let mask_id = "00000000-0000-4000-8000-000000000101";
        let target_id = "00000000-0000-4000-8000-000000000102";
        for (transaction_id, node_id, name) in [
            ("00000000-0000-4000-8000-000000000201", mask_id, "Mask"),
            ("00000000-0000-4000-8000-000000000202", target_id, "Target"),
        ] {
            engine
                .create_node(
                    transaction_id,
                    engine.document.revision,
                    node_id,
                    "rectangle",
                    name,
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
        }
        engine
            .submit_batch(
                NodeId(0x203),
                2,
                vec![BatchCommand::SetMask {
                    id: mask_id.into(),
                    enabled: true,
                }],
            )
            .unwrap();
        let snapshot: serde_json::Value = serde_json::from_str(&engine.snapshot_json()).unwrap();
        assert_eq!(snapshot["nodes"][0]["isMask"], true);
        assert_eq!(
            snapshot["nodes"][0]["extensions"]["makefigma.mask.alpha.v1"],
            serde_json::json!([1])
        );
        engine.undo().unwrap();
        let undone: serde_json::Value = serde_json::from_str(&engine.snapshot_json()).unwrap();
        assert_eq!(undone["nodes"][0]["isMask"], false);
    }

    #[test]
    fn slice_projects_without_paint_and_survives_local_snapshot_round_trip() {
        let mut source = DocumentEngine::new();
        let mut slice = existing_rect(NodeId(0x304));
        slice.kind = NodeKind::Slice;
        slice.name = "Export area".into();
        slice.fill = "#00000000".into();
        slice.stroke = "#00000000".into();
        slice.stroke_width = 0.0;
        slice.stroke_align = StrokeAlign::Inside;
        slice.rotation = 22.5;
        source.document.seed_node(slice).unwrap();

        let snapshot: serde_json::Value = serde_json::from_str(&source.snapshot_json()).unwrap();
        assert_eq!(snapshot["nodes"][0]["kind"], "slice");
        assert_eq!(snapshot["nodes"][0]["strokeWidth"], 0.0);
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot.to_string()).unwrap();
        assert_eq!(restored.canonical_hash(), source.canonical_hash());
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
    fn imported_page_keeps_its_explicit_canonical_position() {
        let mut engine = DocumentEngine::new();
        let position = "40000000000000000000000000000000:00000000000000000000000000000000";
        engine
            .create_page_at_position(
                "00000000-0000-4000-8000-0000000000aa",
                0,
                "00000000-0000-4000-8000-0000000000bb",
                "Imported first page",
                position,
            )
            .unwrap();
        let snapshot: serde_json::Value = serde_json::from_str(&engine.snapshot_json()).unwrap();
        let imported = snapshot["pages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|page| page["name"] == "Imported first page")
            .unwrap();
        assert_eq!(imported["positionId"], position);
    }

    #[test]
    fn page_and_nodes_share_one_atomic_import_batch() {
        let mut engine = DocumentEngine::new();
        let page_id = "00000000-0000-4000-8000-0000000007a1";
        let page_position = "40000000000000000000000000000000:00000000000000000000000000000000";
        let node: ProjectionNode = serde_json::from_value(serde_json::json!({
            "id": "00000000-0000-4000-8000-0000000007a2",
            "pageId": page_id,
            "positionId": "80000000000000000000000000000000:00000000000000000000000000000000",
            "name": "Imported layer", "kind": "rectangle",
            "x": 10.0, "y": 20.0, "width": 40.0, "height": 30.0,
            "fill": "#ffffff", "opacity": 1.0, "cornerRadius": 0.0,
            "text": "", "visible": true, "locked": false, "contentsHidden": false
        }))
        .unwrap();
        engine
            .submit_batch(
                NodeId(0x7a0),
                0,
                vec![
                    BatchCommand::CreatePage {
                        page: ProjectionPage {
                            id: page_id.into(),
                            name: "Imported page".into(),
                            position_id: page_position.into(),
                        },
                    },
                    BatchCommand::Create { node },
                ],
            )
            .unwrap();
        assert_eq!(engine.document.revision, 1);
        assert_eq!(engine.document.pages().count(), 2);
        assert_eq!(
            engine
                .document
                .page(PageId(parse_id(page_id).unwrap().0))
                .unwrap()
                .position
                .key,
            0x40000000000000000000000000000000_u128
        );
        assert!(
            engine
                .document
                .node(parse_id("00000000-0000-4000-8000-0000000007a2").unwrap())
                .is_some()
        );
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
                    parametric_shape: None,
                    vector_path: None,
                    boolean_operation: None,
                    relative_transform: None,
                    opacity: 1.0,
                    blend_mode: BlendMode::Normal,
                    drop_shadow: None,
                    effect_stack: Vec::new(),
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
                    fill_stack: None,
                    stroke_stack: None,
                    fill_style_id: None,
                    stroke_style_id: None,
                    background_style_id: None,
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
                    parametric_shape: None,
                    vector_path: None,
                    boolean_operation: None,
                    relative_transform: None,
                    position_id: None,
                    page_id: None,
                    opacity: 1.0,
                    blend_mode: "normal".into(),
                    drop_shadow: None,
                    effect_stack: Vec::new(),
                    corner_radius: 12.0,
                    corner_radii: Vec::new(),
                    corner_smoothing: 0.0,
                    constraints: None,
                    auto_layout: None,
                    text: String::new(),
                    visible: true,
                    locked: false,
                    contents_hidden: false,
                    clips_content: Some(false),
                    is_mask: false,
                    extensions: Default::default(),
                },
                ignore_constraints: false,
                plain_text_only: false,
                rename_text_path: false,
            });
        }

        assert_eq!(engine.submit_batch(NodeId(1_001), 0, updates).unwrap(), 1);
        assert_eq!(engine.document.revision, 1);
        assert_eq!(engine.document.node(NodeId(1_000)).unwrap().x, 1_000.0);
        assert_eq!(engine.document.node(NodeId(1_000)).unwrap().y, -1_000.0);
    }

    #[test]
    fn resize_preview_is_read_only_and_matches_the_committed_core_projection() {
        let mut engine = DocumentEngine::new();
        let frame_id = "00000000-0000-4000-8000-000000001101";
        let child_id = "00000000-0000-4000-8000-000000001102";
        engine
            .create_node(
                "00000000-0000-4000-8000-000000001111",
                0,
                frame_id,
                "frame",
                "Frame",
                0.0,
                0.0,
                200.0,
                100.0,
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
        engine
            .create_node(
                "00000000-0000-4000-8000-000000001112",
                1,
                child_id,
                "rectangle",
                "Child",
                20.0,
                10.0,
                50.0,
                20.0,
                0.0,
                "#ff0000",
                "transparent",
                0.0,
                1.0,
                0.0,
                true,
                false,
                "",
            )
            .unwrap();

        let mut snapshot = serde_json::from_str::<CoreSnapshot>(&engine.snapshot_json()).unwrap();
        let mut child = snapshot
            .nodes
            .iter()
            .find(|node| node.id == child_id)
            .unwrap()
            .clone();
        child.parent_id = Some(frame_id.into());
        child.constraints = Some(ProjectionConstraints {
            horizontal: "stretch".into(),
            vertical: "center".into(),
        });
        engine
            .submit_batch(
                NodeId(1_113),
                2,
                vec![
                    BatchCommand::Reparent {
                        parent_ids: vec![ParentUpdate {
                            id: child_id.into(),
                            parent_id: Some(frame_id.into()),
                            position_id:
                                "00000000000000000000000000000001:00000000000000000000000000000000"
                                    .into(),
                        }],
                    },
                    BatchCommand::Update {
                        node: child,
                        ignore_constraints: false,
                        plain_text_only: false,
                        rename_text_path: false,
                    },
                ],
            )
            .unwrap();

        snapshot = serde_json::from_str::<CoreSnapshot>(&engine.snapshot_json()).unwrap();
        let mut frame = snapshot
            .nodes
            .iter()
            .find(|node| node.id == frame_id)
            .unwrap()
            .clone();
        frame.width = 300.0;
        frame.height = 200.0;
        let commands_json = serde_json::json!([{
            "type": "update",
            "node": frame,
        }])
        .to_string();
        let before_snapshot = engine.snapshot_json();
        let before_hash = engine.canonical_hash();
        let before_revision = engine.document.revision;

        let preview = serde_json::from_str::<Vec<ProjectionNode>>(
            &engine
                .preview_resize_transaction_json(
                    "00000000-0000-4000-8000-000000001114",
                    &commands_json,
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(engine.document.revision, before_revision);
        assert_eq!(engine.canonical_hash(), before_hash);
        assert_eq!(engine.snapshot_json(), before_snapshot);
        assert_eq!(preview.len(), 2);
        let preview_child = preview.iter().find(|node| node.id == child_id).unwrap();
        assert_eq!(preview_child.x, 20.0);
        assert_eq!(preview_child.y, 60.0);
        assert_eq!(preview_child.width, 150.0);
        assert_eq!(preview_child.height, 20.0);

        engine
            .apply_transaction_json(
                "00000000-0000-4000-8000-000000001115",
                before_revision,
                &commands_json,
            )
            .unwrap();
        let committed = serde_json::from_str::<CoreSnapshot>(&engine.snapshot_json()).unwrap();
        for preview_node in preview {
            let committed_node = committed
                .nodes
                .iter()
                .find(|node| node.id == preview_node.id)
                .unwrap();
            assert_eq!(
                serde_json::to_value(preview_node).unwrap(),
                serde_json::to_value(committed_node).unwrap()
            );
        }
    }

    #[test]
    fn variable_catalog_uses_snapshot_v63_and_round_trips() {
        let mut engine = DocumentEngine::new();
        let collection = VariableCollectionResource {
            id: "VC:theme".into(),
            key: String::new(),
            name: "Theme".into(),
            remote: false,
            hidden_from_publishing: false,
            modes: vec![VariableMode {
                id: "light".into(),
                name: "Light".into(),
            }],
            default_mode_id: "light".into(),
        };
        engine
            .document
            .seed_variable_collection(collection)
            .unwrap();
        engine
            .document
            .seed_variable(VariableResource {
                id: "V:gap".into(),
                key: String::new(),
                name: "Gap".into(),
                description: String::new(),
                remote: false,
                hidden_from_publishing: false,
                collection_id: "VC:theme".into(),
                resolved_type: VariableResolvedType::Float,
                values_by_mode: [("light".into(), VariableValue::Float(8.0))].into(),
                scopes: vec!["GAP".into()],
                code_syntax: std::collections::BTreeMap::new(),
            })
            .unwrap();
        let snapshot = engine.snapshot_json();
        let projected: CoreSnapshot = serde_json::from_str(&snapshot).unwrap();
        assert_eq!(projected.schema_version, 63);
        assert_eq!(projected.variable_collections.unwrap()[0].id, "VC:theme");
        assert_eq!(projected.variables.unwrap()[0].resolved_type, "FLOAT");
        let hash = engine.canonical_hash();
        let mut restored = DocumentEngine::new();
        restored.load_snapshot_json(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), hash);

        let mut syntax_engine = DocumentEngine::new();
        syntax_engine
            .document
            .seed_variable_collection(
                engine
                    .document
                    .variable_collection("VC:theme")
                    .unwrap()
                    .clone(),
            )
            .unwrap();
        let mut syntax_variable = engine.document.variable("V:gap").unwrap().clone();
        syntax_variable
            .code_syntax
            .insert("ANDROID".into(), "gap".into());
        syntax_engine
            .document
            .seed_variable(syntax_variable)
            .unwrap();
        let syntax_snapshot = syntax_engine.snapshot_json();
        let projected: CoreSnapshot = serde_json::from_str(&syntax_snapshot).unwrap();
        assert_eq!(projected.schema_version, 64);
        assert_eq!(
            projected.variables.unwrap()[0]
                .code_syntax
                .get("ANDROID")
                .map(String::as_str),
            Some("gap")
        );
        let mut rejected: CoreSnapshot = serde_json::from_str(&syntax_snapshot).unwrap();
        rejected.schema_version = 63;
        assert_eq!(
            validate_core_snapshot_version(&rejected),
            Err("UNSUPPORTED_CORE_SNAPSHOT")
        );
    }

    #[test]
    fn variable_catalog_commands_cross_the_wasm_transaction_boundary() {
        let mut engine = DocumentEngine::new();
        let before = engine.canonical_hash();
        let commands = serde_json::json!([
            {
                "type": "registerVariableCollection",
                "collection": {
                    "id": "VC:tokens",
                    "key": "",
                    "name": "Tokens",
                    "remote": false,
                    "hiddenFromPublishing": false,
                    "modes": [{ "modeId": "default", "name": "Mode 1" }],
                    "defaultModeId": "default"
                }
            },
            {
                "type": "registerVariable",
                "variable": {
                    "id": "V:spacing",
                    "key": "",
                    "name": "Spacing",
                    "description": "",
                    "remote": false,
                    "hiddenFromPublishing": false,
                    "collectionId": "VC:tokens",
                    "resolvedType": "FLOAT",
                    "valuesByMode": { "default": 0.0 },
                    "scopes": ["ALL_SCOPES"]
                }
            }
        ])
        .to_string();

        engine
            .apply_transaction_json("00000000-0000-4000-8000-000000001116", 0, &commands)
            .unwrap();
        let snapshot: CoreSnapshot = serde_json::from_str(&engine.snapshot_json()).unwrap();
        assert_eq!(snapshot.variable_collections.unwrap()[0].id, "VC:tokens");
        assert_eq!(snapshot.variables.unwrap()[0].id, "V:spacing");
        let after = engine.canonical_hash();
        assert_ne!(before, after);

        engine
            .apply_transaction_json(
                "00000000-0000-4000-8000-000000001117",
                1,
                &serde_json::json!([{
                    "type": "setVariable",
                    "variable": {
                        "id": "V:spacing", "key": "", "name": "Space", "description": "",
                        "remote": false, "hiddenFromPublishing": false, "collectionId": "VC:tokens",
                        "resolvedType": "FLOAT", "valuesByMode": { "default": 8.0 }, "scopes": ["GAP"]
                    }
                }]).to_string(),
            )
            .unwrap();
        let changed: CoreSnapshot = serde_json::from_str(&engine.snapshot_json()).unwrap();
        assert_eq!(changed.variables.unwrap()[0].name, "Space");
        engine
            .apply_transaction_json(
                "00000000-0000-4000-8000-000000001118",
                2,
                &serde_json::json!([{ "type": "deleteVariable", "id": "V:spacing" }]).to_string(),
            )
            .unwrap();
        let deleted: CoreSnapshot = serde_json::from_str(&engine.snapshot_json()).unwrap();
        assert!(deleted.variables.unwrap().is_empty());
        engine.undo().unwrap();
        let restored: CoreSnapshot = serde_json::from_str(&engine.snapshot_json()).unwrap();
        assert_eq!(restored.variables.unwrap()[0].name, "Space");

        engine.undo().unwrap();
        engine.undo().unwrap();
        assert_eq!(engine.canonical_hash(), before);
        engine.redo().unwrap();
        assert_eq!(engine.canonical_hash(), after);
    }
}
