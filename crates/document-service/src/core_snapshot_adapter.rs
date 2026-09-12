//! Protobuf snapshot ↔ canonical editor-core adapter used only by Document Service.

use std::collections::{HashMap, HashSet};

use editor_core::{
    ActorId, ArcData, AssetId, AssetReference, AutoLayout, BackgroundBlur, BlendMode,
    BooleanOperation, Command, ConstraintType, Constraints, Document, DocumentId, DropShadow,
    Effect, FillRule, FontReference, InnerShadow, LayerBlur, LayoutAlignment, LayoutMode,
    LayoutSizing, Node, NodeId, NodeKind, Page, PageId, ParagraphStyle, ParametricShape, PointId,
    PositionId, StrokeAlign, StrokeCap, StrokeJoin, TextAlign, TextAutoSize, TextProperties,
    TextStyleRun, VectorPath, VectorPoint, VectorPointType, VectorSubpath, WrapTrackAlignment,
    color::{Color, ColorSpace, DocumentColorProfile, GradientStop, LinearGradient, Paint},
};
use makefigma_protocol::v1;
use prost::Message;
use sha2::Digest;

use crate::{
    CanonicalReducer, DocumentState, Hash, Id, ReducedDocument, ReductionInput, ServiceError,
    operation_adapter::commands_from_payload,
};

pub const SNAPSHOT_FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy)]
pub struct CoreOperationReducer {
    engine_semantics_version: u32,
}

impl CoreOperationReducer {
    pub fn new(engine_semantics_version: u32) -> Self {
        Self {
            engine_semantics_version,
        }
    }
}

impl CanonicalReducer for CoreOperationReducer {
    fn apply(
        &self,
        current: &DocumentState,
        input: ReductionInput<'_>,
    ) -> Result<ReducedDocument, ServiceError> {
        if input.operation.engine_semantics_version != Some(self.engine_semantics_version) {
            return Err(ServiceError::EngineSemanticsUnsupported {
                minimum: self.engine_semantics_version,
            });
        }
        let mut document = makefigma_document_codec::document_from_snapshot(
            &current.snapshot,
            current.document_id,
            current.document_hash,
        )
        .map_err(|_| ServiceError::ReducerRejected)?;
        if document.revision != current.accepted_revision
            || input.operation.base_revision != document.revision
        {
            return Err(ServiceError::BaseRevisionConflict {
                expected: document.revision,
                actual: input.operation.base_revision,
            });
        }
        let commands = commands_from_payload(&input.operation.payload)?;
        validate_delete_subtree_completeness(&document, &commands)?;
        let transaction_id = NodeId(id(&input.operation.transaction_id)?);
        document
            .submit(
                editor_core::Transaction {
                    id: editor_core::TransactionId(transaction_id.0),
                    base_revision: document.revision,
                    commands,
                },
                editor_core::Origin::RemoteOperation,
            )
            .map_err(|_| ServiceError::ReducerRejected)?;
        let document_hash = document.canonical_hash();
        let snapshot = makefigma_document_codec::snapshot_from_document(
            &document,
            self.engine_semantics_version,
        )
        .map_err(|_| ServiceError::ReducerRejected)?;
        Ok(ReducedDocument {
            snapshot,
            document_hash,
        })
    }
}

/// Server-side guard that a container delete carries its complete subtree.
///
/// The TS resolver (`src/lib/transaction-batch.ts`) expands a container delete
/// into child-first `DeleteNode` commands in one transaction, and editor-core's
/// `Delete` incidentally rejects a node that still has children. This check
/// promotes that atomicity to an explicit, independently tested service-level
/// invariant so a malformed or malicious batch that omits descendants is
/// rejected *before* any mutation, rather than relying on command ordering.
///
/// A descendant "escapes" deletion legitimately only if the same batch also
/// reparents it out from under the deleted subtree, so reparent targets are
/// tracked against the post-batch parent, not the pre-batch one.
fn validate_delete_subtree_completeness(
    document: &Document,
    commands: &[Command],
) -> Result<(), ServiceError> {
    let deleted: HashSet<NodeId> = commands
        .iter()
        .filter_map(|command| match command {
            Command::Delete { id } => Some(*id),
            _ => None,
        })
        .collect();
    if deleted.is_empty() {
        return Ok(());
    }
    // Effective parent after the batch: a reparent moves the child's parent, so a
    // child reparented onto a surviving node is no longer part of the subtree.
    let mut effective_parent: HashMap<NodeId, Option<NodeId>> = HashMap::new();
    for node in document.nodes() {
        effective_parent.insert(node.id, node.parent_id);
    }
    for command in commands {
        if let Command::SetNodeParent { id, parent_id, .. } = command {
            effective_parent.insert(*id, *parent_id);
        }
    }
    // Every node whose effective parent is deleted must itself be deleted.
    for (&node_id, &parent) in &effective_parent {
        if let Some(parent) = parent {
            if deleted.contains(&parent) && !deleted.contains(&node_id) {
                return Err(ServiceError::ReducerRejected);
            }
        }
    }
    Ok(())
}

pub fn initial_document_state(
    document: &Document,
    tenant_id: Id,
    engine_semantics_version: u32,
) -> Result<DocumentState, ServiceError> {
    Ok(DocumentState {
        document_id: document.id().0.to_be_bytes(),
        tenant_id,
        accepted_revision: document.revision,
        document_hash: document.canonical_hash(),
        snapshot: makefigma_document_codec::snapshot_from_document(
            document,
            engine_semantics_version,
        )
        .map_err(|_| ServiceError::ReducerRejected)?,
    })
}

pub fn snapshot_from_document(
    document: &Document,
    engine_semantics_version: u32,
) -> Result<Vec<u8>, ServiceError> {
    let mut pages = document.pages().cloned().collect::<Vec<_>>();
    pages.sort_by_key(|page| (page.position, page.id));
    let page_chunks = pages
        .into_iter()
        .map(|page| {
            let nodes = document
                .ordered_nodes_on_page(page.id)
                .map_err(|_| ServiceError::ReducerRejected)?
                .into_iter()
                .map(|node| {
                    let encoded = node_to_proto(
                        node,
                        page.id,
                        document.asset_for_node(node.id),
                        document.text_properties_for_node(node.id),
                        document.auto_layout_for_node(node.id),
                    )
                    .encode_to_vec();
                    Ok(v1::SceneNodeRef {
                        node_id: id_to_bytes(node.id.0),
                        parent_id: node.parent_id.map(|id| id_to_bytes(id.0)),
                        page_id: id_to_bytes(page.id.0),
                        position_id: Some(position_to_proto(node.position)),
                        canonical_node: encoded,
                    })
                })
                .collect::<Result<Vec<_>, ServiceError>>()?;
            Ok(v1::PageChunk {
                format_version: SNAPSHOT_FORMAT_VERSION,
                page: Some(page_to_proto(&page)),
                nodes,
                content_hash: page_hash(document, page.id),
                extensions: Default::default(),
            })
        })
        .collect::<Result<Vec<_>, ServiceError>>()?;
    Ok(v1::DocumentSnapshot {
        format_version: SNAPSHOT_FORMAT_VERSION,
        engine_semantics_version,
        document_id: document_id_to_bytes(document.id()),
        revision: document.revision,
        content_hash: document.canonical_hash().to_vec(),
        page_chunks,
        resource_index: document.assets().map(asset_to_proto).collect(),
        extensions: Default::default(),
        document_color_profile: profile_to_proto(document.color_profile()) as i32,
        retired_node_ids: document.retired_ids().map(|id| id_to_bytes(id.0)).collect(),
    }
    .encode_to_vec())
}

pub fn document_from_snapshot(
    bytes: &[u8],
    expected_document_id: Id,
    expected_hash: Hash,
) -> Result<Document, ServiceError> {
    let snapshot =
        v1::DocumentSnapshot::decode(bytes).map_err(|_| ServiceError::ReducerRejected)?;
    if snapshot.format_version != SNAPSHOT_FORMAT_VERSION
        || snapshot.document_id.as_slice() != expected_document_id.as_slice()
    {
        return Err(ServiceError::ReducerRejected);
    }
    let mut document = Document::with_id(DocumentId(id(&snapshot.document_id)?));
    document.seed_color_profile(profile_from_proto(snapshot.document_color_profile)?);
    for asset in snapshot.resource_index {
        document
            .seed_asset(asset_from_proto(asset)?)
            .map_err(|_| ServiceError::ReducerRejected)?;
    }
    let mut page_hashes = Vec::new();
    for chunk in snapshot.page_chunks {
        if chunk.format_version != SNAPSHOT_FORMAT_VERSION {
            return Err(ServiceError::ReducerRejected);
        }
        let page = page_from_proto(chunk.page.ok_or(ServiceError::ReducerRejected)?)?;
        page_hashes.push((page.id, chunk.content_hash));
        if page.id != editor_core::DEFAULT_PAGE_ID {
            document
                .seed_page(page)
                .map_err(|_| ServiceError::ReducerRejected)?;
        }
        for reference in chunk.nodes {
            let node_proto = v1::SceneNode::decode(reference.canonical_node.as_slice())
                .map_err(|_| ServiceError::ReducerRejected)?;
            let (page_id, node, asset_id, text_properties, auto_layout) =
                node_from_proto(node_proto)?;
            if page_id.0 != id(&reference.page_id)?
                || node.id.0 != id(&reference.node_id)?
                || node.position
                    != position_from_proto(
                        reference.position_id.ok_or(ServiceError::ReducerRejected)?,
                    )?
            {
                return Err(ServiceError::ReducerRejected);
            }
            if node.parent_id.map(|id| id.0)
                != reference.parent_id.as_deref().map(id).transpose()?
            {
                return Err(ServiceError::ReducerRejected);
            }
            let node_id = node.id;
            if let Some(asset_id) = asset_id {
                document.seed_image_node_on_page(page_id, node, asset_id)
            } else {
                document.seed_node_on_page(page_id, node)
            }
            .map_err(|_| ServiceError::ReducerRejected)?;
            if let Some(properties) = text_properties {
                document
                    .seed_text_properties(node_id, properties)
                    .map_err(|_| ServiceError::ReducerRejected)?;
            }
            document
                .seed_auto_layout(node_id, auto_layout)
                .map_err(|_| ServiceError::ReducerRejected)?;
        }
    }
    for retired_id in snapshot.retired_node_ids {
        document
            .seed_retired_id(NodeId(id(&retired_id)?))
            .map_err(|_| ServiceError::ReducerRejected)?;
    }
    document.revision = snapshot.revision;
    if page_hashes
        .into_iter()
        .any(|(page_id, hash)| hash != page_hash(&document, page_id))
    {
        return Err(ServiceError::ReducerRejected);
    }
    let hash = document.canonical_hash();
    if snapshot.content_hash.as_slice() != hash.as_slice() || hash != expected_hash {
        return Err(ServiceError::ReducerRejected);
    }
    Ok(document)
}

fn page_hash(document: &Document, page_id: PageId) -> Vec<u8> {
    // PageChunk's hash is a stable subset of its document's canonical state. Full
    // document hash remains authoritative for service acceptance.
    let mut bytes = page_id.0.to_be_bytes().to_vec();
    for node in document.ordered_nodes_on_page(page_id).unwrap_or_default() {
        bytes.extend_from_slice(&node.id.0.to_be_bytes());
    }
    sha2::Sha256::digest(bytes).to_vec()
}

fn asset_to_proto(asset: &AssetReference) -> v1::ResourceIndexEntry {
    v1::ResourceIndexEntry {
        asset_id: id_to_bytes(asset.asset_id.0),
        content_hash: asset.content_hash.to_vec(),
        media_type: asset.media_type.clone(),
        byte_length: Some(asset.byte_length),
        pixel_width: asset.dimensions.map(|[width, _]| width),
        pixel_height: asset.dimensions.map(|[_, height]| height),
    }
}

fn asset_from_proto(asset: v1::ResourceIndexEntry) -> Result<AssetReference, ServiceError> {
    let content_hash: [u8; 32] = asset
        .content_hash
        .try_into()
        .map_err(|_| ServiceError::ReducerRejected)?;
    Ok(AssetReference {
        asset_id: AssetId(id(&asset.asset_id)?),
        content_hash,
        media_type: asset.media_type,
        byte_length: asset.byte_length.ok_or(ServiceError::ReducerRejected)?,
        dimensions: match (asset.pixel_width, asset.pixel_height) {
            (None, None) => None,
            (Some(width), Some(height)) => Some([width, height]),
            _ => return Err(ServiceError::ReducerRejected),
        },
    })
}

fn node_to_proto(
    node: &Node,
    page_id: PageId,
    asset_id: Option<AssetId>,
    text_properties: Option<&TextProperties>,
    auto_layout: AutoLayout,
) -> v1::SceneNode {
    v1::SceneNode {
        node_id: id_to_bytes(node.id.0),
        parent_id: node.parent_id.map(|id| id_to_bytes(id.0)),
        page_id: id_to_bytes(page_id.0),
        position_id: Some(position_to_proto(node.position)),
        name: node.name.clone(),
        kind: match node.kind {
            NodeKind::Frame => v1::NodeKind::Frame,
            NodeKind::Rectangle => v1::NodeKind::Rectangle,
            NodeKind::Ellipse => v1::NodeKind::Ellipse,
            NodeKind::Text => v1::NodeKind::Text,
            NodeKind::Image => v1::NodeKind::Image,
            NodeKind::Line => v1::NodeKind::Line,
            NodeKind::Group => v1::NodeKind::Group,
            NodeKind::Section => v1::NodeKind::Section,
            NodeKind::Polygon => v1::NodeKind::Polygon,
            NodeKind::Star => v1::NodeKind::Star,
            NodeKind::Vector => v1::NodeKind::Vector,
            NodeKind::BooleanOperation => v1::NodeKind::BooleanOperation,
            NodeKind::Slice => v1::NodeKind::Slice,
            NodeKind::CodeBlock => v1::NodeKind::CodeBlock,
            NodeKind::Component => v1::NodeKind::Component,
            NodeKind::Instance => v1::NodeKind::Instance,
            NodeKind::Slot => v1::NodeKind::Slot,
            NodeKind::ComponentSet => v1::NodeKind::ComponentSet,
            NodeKind::Connector => v1::NodeKind::Connector,
            NodeKind::Embed => v1::NodeKind::Embed,
            NodeKind::Highlight => v1::NodeKind::Highlight,
            NodeKind::InteractiveSlideElement => v1::NodeKind::InteractiveSlideElement,
            NodeKind::LinkUnfurl => v1::NodeKind::LinkUnfurl,
            NodeKind::Media => v1::NodeKind::Media,
            NodeKind::ShapeWithText => v1::NodeKind::ShapeWithText,
            NodeKind::SlideGrid => v1::NodeKind::SlideGrid,
            NodeKind::Slide => v1::NodeKind::Slide,
            NodeKind::SlideRow => v1::NodeKind::SlideRow,
            NodeKind::Stamp => v1::NodeKind::Stamp,
            NodeKind::Sticky => v1::NodeKind::Sticky,
            NodeKind::Table => v1::NodeKind::Table,
            NodeKind::TableCell => v1::NodeKind::TableCell,
            NodeKind::TextPath => v1::NodeKind::TextPath,
            NodeKind::TransformGroup => v1::NodeKind::TransformGroup,
            NodeKind::WashiTape => v1::NodeKind::WashiTape,
            NodeKind::Widget => v1::NodeKind::Widget,
        } as i32,
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        rotation: node.rotation,
        fill: Some(paint_to_proto(&node.fill)),
        stroke: Some(paint_to_proto(&node.stroke)),
        fills: node.fills.iter().map(paint_to_proto).collect(),
        strokes: node.strokes.iter().map(paint_to_proto).collect(),
        stroke_width: node.stroke_width,
        opacity: node.opacity,
        blend_mode: blend_mode_to_proto(node.blend_mode) as i32,
        corner_radius: node.corner_radius,
        corner_radii: node.corner_radii.clone(),
        corner_smoothing: node.corner_smoothing,
        constraints: node.constraints.map(constraints_to_proto),
        text: node.text.clone(),
        visible: node.visible,
        locked: node.locked,
        asset_id: asset_id.map(|id| id_to_bytes(id.0)),
        text_properties: text_properties.map(text_properties_to_proto),
        stroke_cap_start: stroke_cap_to_proto(node.stroke_cap_start) as i32,
        stroke_cap_end: stroke_cap_to_proto(node.stroke_cap_end) as i32,
        stroke_join: stroke_join_to_proto(node.stroke_join) as i32,
        stroke_miter_limit: node.stroke_miter_limit,
        stroke_dash_pattern: node.stroke_dash_pattern.clone(),
        stroke_weights: node.stroke_weights.clone(),
        stroke_align: stroke_align_to_proto(node.stroke_align) as i32,
        arc_data: node.arc_data.map(arc_to_proto),
        polygon_parameters: match node.parametric_shape {
            Some(ParametricShape::Polygon { point_count }) => {
                Some(v1::PolygonParameters { point_count })
            }
            _ => None,
        },
        star_parameters: match node.parametric_shape {
            Some(ParametricShape::Star {
                point_count,
                inner_ratio,
            }) => Some(v1::StarParameters {
                point_count,
                inner_ratio,
            }),
            _ => None,
        },
        relative_transform: node.relative_transform.map(transform_to_proto),
        contents_hidden: node.contents_hidden,
        clips_content: Some(node.clips_content),
        extensions: node.extensions.clone().into_iter().collect(),
        drop_shadow: node.drop_shadow.map(drop_shadow_to_proto),
        effect_stack: node
            .effect_stack
            .iter()
            .copied()
            .map(effect_to_proto)
            .collect(),
        vector_path: node.vector_path.as_ref().map(vector_path_to_proto),
        boolean_operation: node.boolean_operation.map(boolean_operation_to_proto),
        auto_layout: Some(auto_layout_to_proto(&auto_layout)),
        reactions: Vec::new(),
        prototype_metadata: None,
    }
}

fn node_from_proto(
    node: v1::SceneNode,
) -> Result<
    (
        PageId,
        Node,
        Option<AssetId>,
        Option<TextProperties>,
        AutoLayout,
    ),
    ServiceError,
> {
    let page_id = PageId(id(&node.page_id)?);
    let kind = match v1::NodeKind::try_from(node.kind).map_err(|_| ServiceError::ReducerRejected)? {
        v1::NodeKind::Frame => NodeKind::Frame,
        v1::NodeKind::Rectangle => NodeKind::Rectangle,
        v1::NodeKind::Ellipse => NodeKind::Ellipse,
        v1::NodeKind::Text => NodeKind::Text,
        v1::NodeKind::Image => NodeKind::Image,
        v1::NodeKind::Line => NodeKind::Line,
        v1::NodeKind::Group => NodeKind::Group,
        v1::NodeKind::Section => NodeKind::Section,
        v1::NodeKind::Polygon => NodeKind::Polygon,
        v1::NodeKind::Star => NodeKind::Star,
        v1::NodeKind::Vector => NodeKind::Vector,
        v1::NodeKind::BooleanOperation => NodeKind::BooleanOperation,
        v1::NodeKind::Slice => NodeKind::Slice,
        v1::NodeKind::CodeBlock => NodeKind::CodeBlock,
        v1::NodeKind::Component => NodeKind::Component,
        v1::NodeKind::Instance => NodeKind::Instance,
        v1::NodeKind::Slot => NodeKind::Slot,
        v1::NodeKind::ComponentSet => NodeKind::ComponentSet,
        v1::NodeKind::Connector => NodeKind::Connector,
        v1::NodeKind::Embed => NodeKind::Embed,
        v1::NodeKind::Highlight => NodeKind::Highlight,
        v1::NodeKind::InteractiveSlideElement => NodeKind::InteractiveSlideElement,
        v1::NodeKind::LinkUnfurl => NodeKind::LinkUnfurl,
        v1::NodeKind::Media => NodeKind::Media,
        v1::NodeKind::ShapeWithText => NodeKind::ShapeWithText,
        v1::NodeKind::SlideGrid => NodeKind::SlideGrid,
        v1::NodeKind::Slide => NodeKind::Slide,
        v1::NodeKind::SlideRow => NodeKind::SlideRow,
        v1::NodeKind::Stamp => NodeKind::Stamp,
        v1::NodeKind::Sticky => NodeKind::Sticky,
        v1::NodeKind::Table => NodeKind::Table,
        v1::NodeKind::TableCell => NodeKind::TableCell,
        v1::NodeKind::TextPath => NodeKind::TextPath,
        v1::NodeKind::TransformGroup => NodeKind::TransformGroup,
        v1::NodeKind::WashiTape => NodeKind::WashiTape,
        v1::NodeKind::Widget => NodeKind::Widget,
        v1::NodeKind::Unspecified => return Err(ServiceError::ReducerRejected),
    };
    let clips_content = node.clips_content.unwrap_or(matches!(
        kind,
        NodeKind::Frame
            | NodeKind::Component
            | NodeKind::Instance
            | NodeKind::Slot
            | NodeKind::ComponentSet
    ));
    Ok((
        page_id,
        Node {
            id: NodeId(id(&node.node_id)?),
            parent_id: node.parent_id.as_deref().map(id).transpose()?.map(NodeId),
            position: position_from_proto(node.position_id.ok_or(ServiceError::ReducerRejected)?)?,
            name: node.name,
            kind,
            x: node.x,
            y: node.y,
            width: node.width,
            height: node.height,
            rotation: node.rotation,
            fill: paint_from_proto(node.fill.ok_or(ServiceError::ReducerRejected)?)?,
            stroke: paint_from_proto(node.stroke.ok_or(ServiceError::ReducerRejected)?)?,
            fills: node
                .fills
                .into_iter()
                .map(paint_from_proto)
                .collect::<Result<Vec<_>, _>>()?,
            strokes: node
                .strokes
                .into_iter()
                .map(paint_from_proto)
                .collect::<Result<Vec<_>, _>>()?,
            stroke_width: node.stroke_width,
            stroke_cap_start: stroke_cap_from_proto(node.stroke_cap_start)?,
            stroke_cap_end: stroke_cap_from_proto(node.stroke_cap_end)?,
            stroke_join: stroke_join_from_proto(node.stroke_join)?,
            stroke_miter_limit: if node.stroke_miter_limit == 0.0 {
                10.0
            } else {
                node.stroke_miter_limit
            },
            stroke_dash_pattern: node.stroke_dash_pattern,
            stroke_weights: node.stroke_weights,
            stroke_align: stroke_align_from_proto(node.stroke_align)?,
            arc_data: node.arc_data.map(arc_from_proto).transpose()?,
            parametric_shape: parametric_shape_from_proto(
                node.polygon_parameters,
                node.star_parameters,
            )?,
            vector_path: node.vector_path.map(vector_path_from_proto).transpose()?,
            boolean_operation: node
                .boolean_operation
                .map(boolean_operation_from_proto)
                .transpose()?,
            relative_transform: node
                .relative_transform
                .map(transform_from_proto)
                .transpose()?,
            opacity: node.opacity,
            blend_mode: blend_mode_from_proto(node.blend_mode)?,
            corner_radius: node.corner_radius,
            corner_radii: node.corner_radii,
            corner_smoothing: node.corner_smoothing,
            constraints: node.constraints.map(constraints_from_proto).transpose()?,
            text: node.text,
            visible: node.visible,
            locked: node.locked,
            contents_hidden: node.contents_hidden,
            clips_content,
            drop_shadow: node.drop_shadow.map(drop_shadow_from_proto).transpose()?,
            effect_stack: node
                .effect_stack
                .into_iter()
                .map(effect_from_proto)
                .collect::<Result<Vec<_>, _>>()?,
            extensions: node.extensions.into_iter().collect(),
        },
        node.asset_id.as_deref().map(id).transpose()?.map(AssetId),
        node.text_properties
            .map(text_properties_from_proto)
            .transpose()?,
        node.auto_layout
            .map(auto_layout_from_proto)
            .transpose()?
            .unwrap_or_default(),
    ))
}

fn drop_shadow_to_proto(shadow: DropShadow) -> v1::DropShadow {
    v1::DropShadow {
        offset_x: shadow.offset_x,
        offset_y: shadow.offset_y,
        blur_radius: shadow.blur_radius,
        spread: shadow.spread,
        color: Some(color_to_proto(shadow.color)),
        visible: shadow.visible,
    }
}

fn effect_to_proto(effect: Effect) -> v1::Effect {
    v1::Effect {
        kind: Some(match effect {
            Effect::DropShadow(shadow) => {
                v1::effect::Kind::DropShadow(drop_shadow_to_proto(shadow))
            }
            Effect::LayerBlur(blur) => v1::effect::Kind::LayerBlur(v1::LayerBlur {
                radius: blur.radius,
                visible: blur.visible,
            }),
            Effect::InnerShadow(shadow) => v1::effect::Kind::InnerShadow(v1::InnerShadow {
                offset_x: shadow.offset_x,
                offset_y: shadow.offset_y,
                blur_radius: shadow.blur_radius,
                spread: shadow.spread,
                color: Some(color_to_proto(shadow.color)),
                visible: shadow.visible,
            }),
            Effect::BackgroundBlur(blur) => v1::effect::Kind::BackgroundBlur(v1::BackgroundBlur {
                radius: blur.radius,
                visible: blur.visible,
            }),
        }),
    }
}

fn effect_from_proto(effect: v1::Effect) -> Result<Effect, ServiceError> {
    match effect.kind.ok_or(ServiceError::ReducerRejected)? {
        v1::effect::Kind::DropShadow(shadow) => {
            Ok(Effect::DropShadow(drop_shadow_from_proto(shadow)?))
        }
        v1::effect::Kind::LayerBlur(blur) => Ok(Effect::LayerBlur(LayerBlur {
            radius: blur.radius,
            visible: blur.visible,
        })),
        v1::effect::Kind::InnerShadow(shadow) => Ok(Effect::InnerShadow(InnerShadow {
            offset_x: shadow.offset_x,
            offset_y: shadow.offset_y,
            blur_radius: shadow.blur_radius,
            spread: shadow.spread,
            color: color_from_proto(shadow.color.ok_or(ServiceError::ReducerRejected)?)?,
            visible: shadow.visible,
        })),
        v1::effect::Kind::BackgroundBlur(blur) => Ok(Effect::BackgroundBlur(BackgroundBlur {
            radius: blur.radius,
            visible: blur.visible,
        })),
    }
}

fn drop_shadow_from_proto(shadow: v1::DropShadow) -> Result<DropShadow, ServiceError> {
    Ok(DropShadow {
        offset_x: shadow.offset_x,
        offset_y: shadow.offset_y,
        blur_radius: shadow.blur_radius,
        spread: shadow.spread,
        color: color_from_proto(shadow.color.ok_or(ServiceError::ReducerRejected)?)?,
        visible: shadow.visible,
    })
}

fn stroke_cap_to_proto(cap: StrokeCap) -> v1::StrokeCap {
    match cap {
        StrokeCap::None => v1::StrokeCap::None,
        StrokeCap::Round => v1::StrokeCap::Round,
        StrokeCap::Square => v1::StrokeCap::Square,
        StrokeCap::ArrowLines => v1::StrokeCap::ArrowLines,
        StrokeCap::ArrowEquilateral => v1::StrokeCap::ArrowEquilateral,
        StrokeCap::DiamondFilled => v1::StrokeCap::DiamondFilled,
        StrokeCap::TriangleFilled => v1::StrokeCap::TriangleFilled,
        StrokeCap::CircleFilled => v1::StrokeCap::CircleFilled,
    }
}

fn stroke_cap_from_proto(value: i32) -> Result<StrokeCap, ServiceError> {
    Ok(
        match v1::StrokeCap::try_from(value).map_err(|_| ServiceError::ReducerRejected)? {
            v1::StrokeCap::Unspecified | v1::StrokeCap::None => StrokeCap::None,
            v1::StrokeCap::Round => StrokeCap::Round,
            v1::StrokeCap::Square => StrokeCap::Square,
            v1::StrokeCap::ArrowLines => StrokeCap::ArrowLines,
            v1::StrokeCap::ArrowEquilateral => StrokeCap::ArrowEquilateral,
            v1::StrokeCap::DiamondFilled => StrokeCap::DiamondFilled,
            v1::StrokeCap::TriangleFilled => StrokeCap::TriangleFilled,
            v1::StrokeCap::CircleFilled => StrokeCap::CircleFilled,
        },
    )
}

fn stroke_join_to_proto(join: StrokeJoin) -> v1::StrokeJoin {
    match join {
        StrokeJoin::Miter => v1::StrokeJoin::Miter,
        StrokeJoin::Bevel => v1::StrokeJoin::Bevel,
        StrokeJoin::Round => v1::StrokeJoin::Round,
    }
}

fn stroke_join_from_proto(value: i32) -> Result<StrokeJoin, ServiceError> {
    Ok(
        match v1::StrokeJoin::try_from(value).map_err(|_| ServiceError::ReducerRejected)? {
            v1::StrokeJoin::Unspecified | v1::StrokeJoin::Miter => StrokeJoin::Miter,
            v1::StrokeJoin::Bevel => StrokeJoin::Bevel,
            v1::StrokeJoin::Round => StrokeJoin::Round,
        },
    )
}

fn constraints_to_proto(value: Constraints) -> v1::Constraints {
    let convert = |axis| match axis {
        ConstraintType::Min => v1::ConstraintType::Min,
        ConstraintType::Center => v1::ConstraintType::Center,
        ConstraintType::Max => v1::ConstraintType::Max,
        ConstraintType::Stretch => v1::ConstraintType::Stretch,
        ConstraintType::Scale => v1::ConstraintType::Scale,
    };
    v1::Constraints {
        horizontal: convert(value.horizontal) as i32,
        vertical: convert(value.vertical) as i32,
    }
}

fn constraints_from_proto(value: v1::Constraints) -> Result<Constraints, ServiceError> {
    let convert = |axis| match v1::ConstraintType::try_from(axis)
        .map_err(|_| ServiceError::ReducerRejected)?
    {
        v1::ConstraintType::Min => Ok(ConstraintType::Min),
        v1::ConstraintType::Center => Ok(ConstraintType::Center),
        v1::ConstraintType::Max => Ok(ConstraintType::Max),
        v1::ConstraintType::Stretch => Ok(ConstraintType::Stretch),
        v1::ConstraintType::Scale => Ok(ConstraintType::Scale),
        v1::ConstraintType::Unspecified => Err(ServiceError::ReducerRejected),
    };
    Ok(Constraints {
        horizontal: convert(value.horizontal)?,
        vertical: convert(value.vertical)?,
    })
}

fn auto_layout_to_proto(value: &AutoLayout) -> v1::AutoLayout {
    v1::AutoLayout {
        mode: match value.mode {
            LayoutMode::None => v1::LayoutMode::None,
            LayoutMode::Horizontal => v1::LayoutMode::Horizontal,
            LayoutMode::Vertical => v1::LayoutMode::Vertical,
        } as i32,
        padding_top: value.padding[0],
        padding_right: value.padding[1],
        padding_bottom: value.padding[2],
        padding_left: value.padding[3],
        item_spacing: value.item_spacing,
        track_spacing: value.track_spacing,
        wrap_track_alignment: (value.track_alignment != WrapTrackAlignment::Auto).then(
            || match value.track_alignment {
                WrapTrackAlignment::Auto => v1::WrapTrackAlignment::Auto,
                WrapTrackAlignment::SpaceBetween => v1::WrapTrackAlignment::SpaceBetween,
            } as i32,
        ),
        wrap: value.wrap,
        primary_alignment: alignment_to_proto(value.primary_alignment) as i32,
        counter_alignment: alignment_to_proto(value.counter_alignment) as i32,
        primary_sizing: sizing_to_proto(value.primary_sizing) as i32,
        counter_sizing: sizing_to_proto(value.counter_sizing) as i32,
        min_width: value.min_width,
        max_width: value.max_width,
        min_height: value.min_height,
        max_height: value.max_height,
        absolute: value.absolute,
        align_self: value
            .align_self
            .map(|value| alignment_to_proto(value) as i32),
    }
}

fn alignment_to_proto(value: LayoutAlignment) -> v1::LayoutAlignment {
    match value {
        LayoutAlignment::Start => v1::LayoutAlignment::Start,
        LayoutAlignment::Center => v1::LayoutAlignment::Center,
        LayoutAlignment::End => v1::LayoutAlignment::End,
        LayoutAlignment::SpaceBetween => v1::LayoutAlignment::SpaceBetween,
        LayoutAlignment::Baseline => v1::LayoutAlignment::Baseline,
    }
}

fn sizing_to_proto(value: LayoutSizing) -> v1::LayoutSizing {
    match value {
        LayoutSizing::Fixed => v1::LayoutSizing::Fixed,
        LayoutSizing::Hug => v1::LayoutSizing::Hug,
        LayoutSizing::Fill => v1::LayoutSizing::Fill,
    }
}

fn auto_layout_from_proto(value: v1::AutoLayout) -> Result<AutoLayout, ServiceError> {
    let mode =
        match v1::LayoutMode::try_from(value.mode).map_err(|_| ServiceError::ReducerRejected)? {
            v1::LayoutMode::None => LayoutMode::None,
            v1::LayoutMode::Horizontal => LayoutMode::Horizontal,
            v1::LayoutMode::Vertical => LayoutMode::Vertical,
            v1::LayoutMode::Unspecified => return Err(ServiceError::ReducerRejected),
        };
    let alignment = |value| match v1::LayoutAlignment::try_from(value)
        .map_err(|_| ServiceError::ReducerRejected)?
    {
        v1::LayoutAlignment::Start => Ok(LayoutAlignment::Start),
        v1::LayoutAlignment::Center => Ok(LayoutAlignment::Center),
        v1::LayoutAlignment::End => Ok(LayoutAlignment::End),
        v1::LayoutAlignment::SpaceBetween => Ok(LayoutAlignment::SpaceBetween),
        v1::LayoutAlignment::Baseline => Ok(LayoutAlignment::Baseline),
        v1::LayoutAlignment::Unspecified => Err(ServiceError::ReducerRejected),
    };
    let sizing = |value| match v1::LayoutSizing::try_from(value)
        .map_err(|_| ServiceError::ReducerRejected)?
    {
        v1::LayoutSizing::Fixed => Ok(LayoutSizing::Fixed),
        v1::LayoutSizing::Hug => Ok(LayoutSizing::Hug),
        v1::LayoutSizing::Fill => Ok(LayoutSizing::Fill),
        v1::LayoutSizing::Unspecified => Err(ServiceError::ReducerRejected),
    };
    let align_self = value.align_self.map(|value| alignment(value)).transpose()?;
    if matches!(
        align_self,
        Some(LayoutAlignment::SpaceBetween | LayoutAlignment::Baseline)
    ) {
        return Err(ServiceError::ReducerRejected);
    }
    let track_alignment = match value
        .wrap_track_alignment
        .map(v1::WrapTrackAlignment::try_from)
        .transpose()
        .map_err(|_| ServiceError::ReducerRejected)?
    {
        None | Some(v1::WrapTrackAlignment::Auto) => WrapTrackAlignment::Auto,
        Some(v1::WrapTrackAlignment::SpaceBetween) => WrapTrackAlignment::SpaceBetween,
        Some(v1::WrapTrackAlignment::Unspecified) => return Err(ServiceError::ReducerRejected),
    };
    let layout = AutoLayout {
        mode,
        padding: [
            value.padding_top,
            value.padding_right,
            value.padding_bottom,
            value.padding_left,
        ],
        item_spacing: value.item_spacing,
        track_spacing: value.track_spacing,
        track_alignment,
        wrap: value.wrap,
        primary_alignment: alignment(value.primary_alignment)?,
        counter_alignment: alignment(value.counter_alignment)?,
        primary_sizing: sizing(value.primary_sizing)?,
        counter_sizing: sizing(value.counter_sizing)?,
        min_width: value.min_width,
        max_width: value.max_width,
        min_height: value.min_height,
        max_height: value.max_height,
        absolute: value.absolute,
        align_self,
    };
    if matches!(layout.primary_alignment, LayoutAlignment::Baseline)
        || matches!(layout.counter_alignment, LayoutAlignment::SpaceBetween)
        || (layout.counter_alignment == LayoutAlignment::Baseline
            && layout.mode != LayoutMode::Horizontal)
        || (!layout.wrap && layout.track_alignment != WrapTrackAlignment::Auto)
    {
        return Err(ServiceError::ReducerRejected);
    }
    Ok(layout)
}

fn stroke_align_to_proto(align: StrokeAlign) -> v1::StrokeAlign {
    match align {
        StrokeAlign::Center => v1::StrokeAlign::Center,
        StrokeAlign::Inside => v1::StrokeAlign::Inside,
        StrokeAlign::Outside => v1::StrokeAlign::Outside,
    }
}

fn stroke_align_from_proto(value: i32) -> Result<StrokeAlign, ServiceError> {
    Ok(
        match v1::StrokeAlign::try_from(value).map_err(|_| ServiceError::ReducerRejected)? {
            v1::StrokeAlign::Unspecified | v1::StrokeAlign::Inside => StrokeAlign::Inside,
            v1::StrokeAlign::Center => StrokeAlign::Center,
            v1::StrokeAlign::Outside => StrokeAlign::Outside,
        },
    )
}

fn blend_mode_to_proto(mode: BlendMode) -> v1::BlendMode {
    match mode {
        BlendMode::Normal => v1::BlendMode::Normal,
        BlendMode::Multiply => v1::BlendMode::Multiply,
        BlendMode::Screen => v1::BlendMode::Screen,
        BlendMode::Overlay => v1::BlendMode::Overlay,
        BlendMode::Darken => v1::BlendMode::Darken,
        BlendMode::Lighten => v1::BlendMode::Lighten,
    }
}

fn blend_mode_from_proto(value: i32) -> Result<BlendMode, ServiceError> {
    match v1::BlendMode::try_from(value).map_err(|_| ServiceError::ReducerRejected)? {
        v1::BlendMode::Normal => Ok(BlendMode::Normal),
        v1::BlendMode::Multiply => Ok(BlendMode::Multiply),
        v1::BlendMode::Screen => Ok(BlendMode::Screen),
        v1::BlendMode::Overlay => Ok(BlendMode::Overlay),
        v1::BlendMode::Darken => Ok(BlendMode::Darken),
        v1::BlendMode::Lighten => Ok(BlendMode::Lighten),
    }
}

fn arc_to_proto(arc: ArcData) -> v1::ArcData {
    v1::ArcData {
        starting_angle: arc.starting_angle,
        ending_angle: arc.ending_angle,
        inner_radius: arc.inner_radius,
    }
}
fn arc_from_proto(arc: v1::ArcData) -> Result<ArcData, ServiceError> {
    Ok(ArcData {
        starting_angle: arc.starting_angle,
        ending_angle: arc.ending_angle,
        inner_radius: arc.inner_radius,
    })
}
fn parametric_shape_from_proto(
    polygon: Option<v1::PolygonParameters>,
    star: Option<v1::StarParameters>,
) -> Result<Option<ParametricShape>, ServiceError> {
    match (polygon, star) {
        (Some(_), Some(_)) => Err(ServiceError::ReducerRejected),
        (Some(parameters), None) => Ok(Some(ParametricShape::Polygon {
            point_count: parameters.point_count,
        })),
        (None, Some(parameters)) => Ok(Some(ParametricShape::Star {
            point_count: parameters.point_count,
            inner_ratio: parameters.inner_ratio,
        })),
        (None, None) => Ok(None),
    }
}
fn vector_path_to_proto(path: &VectorPath) -> v1::VectorPath {
    v1::VectorPath {
        fill_rule: match path.fill_rule {
            FillRule::NonZero => v1::FillRule::NonZero,
            FillRule::EvenOdd => v1::FillRule::EvenOdd,
        } as i32,
        subpaths: path
            .subpaths
            .iter()
            .map(|subpath| v1::VectorSubpath {
                closed: subpath.closed,
                points: subpath
                    .points
                    .iter()
                    .map(|point| v1::VectorPoint {
                        point_id: id_to_bytes(point.id.0),
                        x: point.position.x,
                        y: point.position.y,
                        handle_in_x: point.handle_in.map(|handle| handle.x),
                        handle_in_y: point.handle_in.map(|handle| handle.y),
                        handle_out_x: point.handle_out.map(|handle| handle.x),
                        handle_out_y: point.handle_out.map(|handle| handle.y),
                        point_type: match point.point_type {
                            VectorPointType::Corner => v1::VectorPointType::Corner,
                            VectorPointType::Mirrored => v1::VectorPointType::Mirrored,
                            VectorPointType::Asymmetric => v1::VectorPointType::Asymmetric,
                        } as i32,
                    })
                    .collect(),
            })
            .collect(),
    }
}
fn vector_path_from_proto(path: v1::VectorPath) -> Result<VectorPath, ServiceError> {
    let fill_rule =
        match v1::FillRule::try_from(path.fill_rule).map_err(|_| ServiceError::ReducerRejected)? {
            v1::FillRule::NonZero => FillRule::NonZero,
            v1::FillRule::EvenOdd => FillRule::EvenOdd,
            v1::FillRule::Unspecified => return Err(ServiceError::ReducerRejected),
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
                    .map(|point| {
                        let point_type = match v1::VectorPointType::try_from(point.point_type)
                            .map_err(|_| ServiceError::ReducerRejected)?
                        {
                            v1::VectorPointType::Corner => VectorPointType::Corner,
                            v1::VectorPointType::Mirrored => VectorPointType::Mirrored,
                            v1::VectorPointType::Asymmetric => VectorPointType::Asymmetric,
                            v1::VectorPointType::Unspecified => {
                                return Err(ServiceError::ReducerRejected);
                            }
                        };
                        let handle_in = match (point.handle_in_x, point.handle_in_y) {
                            (None, None) => None,
                            (Some(x), Some(y)) => Some(editor_core::geometry::Point { x, y }),
                            _ => return Err(ServiceError::ReducerRejected),
                        };
                        let handle_out = match (point.handle_out_x, point.handle_out_y) {
                            (None, None) => None,
                            (Some(x), Some(y)) => Some(editor_core::geometry::Point { x, y }),
                            _ => return Err(ServiceError::ReducerRejected),
                        };
                        Ok(VectorPoint {
                            id: PointId(id(&point.point_id)?),
                            position: editor_core::geometry::Point {
                                x: point.x,
                                y: point.y,
                            },
                            handle_in,
                            handle_out,
                            point_type,
                        })
                    })
                    .collect::<Result<Vec<_>, ServiceError>>()?,
            })
        })
        .collect::<Result<Vec<_>, ServiceError>>()?;
    Ok(VectorPath {
        fill_rule,
        subpaths,
    })
}
fn boolean_operation_to_proto(operation: BooleanOperation) -> i32 {
    (match operation {
        BooleanOperation::Union => v1::BooleanOperation::Union,
        BooleanOperation::Intersect => v1::BooleanOperation::Intersect,
        BooleanOperation::Subtract => v1::BooleanOperation::Subtract,
        BooleanOperation::Exclude => v1::BooleanOperation::Exclude,
    }) as i32
}
fn boolean_operation_from_proto(operation: i32) -> Result<BooleanOperation, ServiceError> {
    match v1::BooleanOperation::try_from(operation).map_err(|_| ServiceError::ReducerRejected)? {
        v1::BooleanOperation::Union => Ok(BooleanOperation::Union),
        v1::BooleanOperation::Intersect => Ok(BooleanOperation::Intersect),
        v1::BooleanOperation::Subtract => Ok(BooleanOperation::Subtract),
        v1::BooleanOperation::Exclude => Ok(BooleanOperation::Exclude),
        v1::BooleanOperation::Unspecified => Err(ServiceError::ReducerRejected),
    }
}
fn transform_to_proto(transform: editor_core::geometry::AffineTransform) -> v1::Transform {
    v1::Transform {
        a: transform.a,
        b: transform.b,
        c: transform.c,
        d: transform.d,
        e: transform.e,
        f: transform.f,
    }
}
fn transform_from_proto(
    transform: v1::Transform,
) -> Result<editor_core::geometry::AffineTransform, ServiceError> {
    Ok(editor_core::geometry::AffineTransform {
        a: transform.a,
        b: transform.b,
        c: transform.c,
        d: transform.d,
        e: transform.e,
        f: transform.f,
    })
}

fn font_to_proto(font: &FontReference) -> v1::FontReference {
    v1::FontReference {
        asset_id: id_to_bytes(font.asset_id.0),
        face_index: font.face_index,
        variation_axes: font
            .variation_axes
            .iter()
            .map(|(tag, value)| v1::FontVariation {
                tag: tag.clone(),
                value: *value,
            })
            .collect(),
    }
}

fn font_from_proto(font: v1::FontReference) -> Result<FontReference, ServiceError> {
    let mut variation_axes = std::collections::BTreeMap::new();
    for axis in font.variation_axes {
        if variation_axes
            .insert(axis.tag.clone(), axis.value)
            .is_some()
        {
            return Err(ServiceError::ReducerRejected);
        }
    }
    Ok(FontReference {
        asset_id: AssetId(id(&font.asset_id)?),
        face_index: font.face_index,
        variation_axes,
    })
}

fn text_properties_to_proto(properties: &TextProperties) -> v1::TextProperties {
    v1::TextProperties {
        runs: properties
            .runs
            .iter()
            .map(|run| v1::TextStyleRun {
                start: run.start,
                end: run.end,
                font: run.font.as_ref().map(font_to_proto),
                font_size: run.font_size,
                font_weight: u32::from(run.font_weight),
                italic: run.italic,
                letter_spacing: run.letter_spacing,
                color: run.color.map(color_to_proto),
            })
            .collect(),
        paragraph: Some(v1::ParagraphStyle {
            alignment: match properties.paragraph.alignment {
                TextAlign::Left => v1::TextAlignment::Left,
                TextAlign::Center => v1::TextAlignment::Center,
                TextAlign::Right => v1::TextAlignment::Right,
                TextAlign::Justify => v1::TextAlignment::Justify,
            } as i32,
            line_height: properties.paragraph.line_height,
            paragraph_spacing: properties.paragraph.paragraph_spacing,
        }),
        auto_size: match properties.auto_size {
            TextAutoSize::Fixed => v1::TextAutoSize::Fixed,
            TextAutoSize::Height => v1::TextAutoSize::Height,
            TextAutoSize::WidthAndHeight => v1::TextAutoSize::WidthAndHeight,
        } as i32,
        fallback_fonts: properties
            .fallback_fonts
            .iter()
            .map(font_to_proto)
            .collect(),
    }
}

fn text_properties_from_proto(value: v1::TextProperties) -> Result<TextProperties, ServiceError> {
    let paragraph = value.paragraph.ok_or(ServiceError::ReducerRejected)?;
    let alignment = match v1::TextAlignment::try_from(paragraph.alignment)
        .map_err(|_| ServiceError::ReducerRejected)?
    {
        v1::TextAlignment::Left => TextAlign::Left,
        v1::TextAlignment::Center => TextAlign::Center,
        v1::TextAlignment::Right => TextAlign::Right,
        v1::TextAlignment::Justify => TextAlign::Justify,
        v1::TextAlignment::Unspecified => return Err(ServiceError::ReducerRejected),
    };
    let auto_size = match v1::TextAutoSize::try_from(value.auto_size)
        .map_err(|_| ServiceError::ReducerRejected)?
    {
        v1::TextAutoSize::Fixed => TextAutoSize::Fixed,
        v1::TextAutoSize::Height => TextAutoSize::Height,
        v1::TextAutoSize::WidthAndHeight => TextAutoSize::WidthAndHeight,
        v1::TextAutoSize::Unspecified => return Err(ServiceError::ReducerRejected),
    };
    Ok(TextProperties {
        runs: value
            .runs
            .into_iter()
            .map(|run| {
                Ok(TextStyleRun {
                    start: run.start,
                    end: run.end,
                    font: run.font.map(font_from_proto).transpose()?,
                    font_size: run.font_size,
                    font_weight: u16::try_from(run.font_weight)
                        .map_err(|_| ServiceError::ReducerRejected)?,
                    italic: run.italic,
                    letter_spacing: run.letter_spacing,
                    color: run.color.map(color_from_proto).transpose()?,
                })
            })
            .collect::<Result<_, ServiceError>>()?,
        paragraph: ParagraphStyle {
            alignment,
            line_height: paragraph.line_height,
            paragraph_spacing: paragraph.paragraph_spacing,
        },
        auto_size,
        fallback_fonts: value
            .fallback_fonts
            .into_iter()
            .map(font_from_proto)
            .collect::<Result<_, ServiceError>>()?,
    })
}

fn page_to_proto(page: &Page) -> v1::PageRef {
    v1::PageRef {
        page_id: id_to_bytes(page.id.0),
        name: page.name.clone(),
        position_id: Some(position_to_proto(page.position)),
    }
}
fn page_from_proto(page: v1::PageRef) -> Result<Page, ServiceError> {
    Ok(Page {
        id: PageId(id(&page.page_id)?),
        name: page.name,
        position: position_from_proto(page.position_id.ok_or(ServiceError::ReducerRejected)?)?,
    })
}
fn position_to_proto(position: PositionId) -> v1::PositionId {
    v1::PositionId {
        key: id_to_bytes(position.key),
        actor_id: id_to_bytes(position.actor.0),
    }
}
fn position_from_proto(position: v1::PositionId) -> Result<PositionId, ServiceError> {
    Ok(PositionId {
        key: id(&position.key)?,
        actor: ActorId(id(&position.actor_id)?),
    })
}
fn paint_to_proto(paint: &Paint) -> v1::Paint {
    use v1::paint::Kind;
    let kind = match paint {
        Paint::Solid(color) => Kind::Solid(color_to_proto(*color)),
        Paint::LinearGradient(gradient) => Kind::LinearGradient(v1::LinearGradient {
            start_x: gradient.start[0],
            start_y: gradient.start[1],
            end_x: gradient.end[0],
            end_y: gradient.end[1],
            stops: gradient
                .stops
                .iter()
                .map(|stop| v1::GradientStop {
                    position: stop.position,
                    color: Some(color_to_proto(stop.color)),
                })
                .collect(),
        }),
    };
    v1::Paint { kind: Some(kind) }
}
fn paint_from_proto(paint: v1::Paint) -> Result<Paint, ServiceError> {
    use v1::paint::Kind;
    match paint.kind.ok_or(ServiceError::ReducerRejected)? {
        Kind::Solid(color) => Ok(Paint::Solid(color_from_proto(color)?)),
        Kind::LinearGradient(gradient) => LinearGradient::new(
            [gradient.start_x, gradient.start_y],
            [gradient.end_x, gradient.end_y],
            gradient
                .stops
                .into_iter()
                .map(|stop| {
                    Ok(GradientStop {
                        position: stop.position,
                        color: color_from_proto(stop.color.ok_or(ServiceError::ReducerRejected)?)?,
                    })
                })
                .collect::<Result<Vec<_>, ServiceError>>()?,
        )
        .map(Paint::LinearGradient)
        .map_err(|_| ServiceError::ReducerRejected),
    }
}
fn color_to_proto(color: Color) -> v1::Color {
    v1::Color {
        space: match color.space {
            ColorSpace::Srgb => v1::ColorSpace::Srgb,
            ColorSpace::DisplayP3 => v1::ColorSpace::DisplayP3,
            ColorSpace::LinearSrgb => v1::ColorSpace::LinearSrgb,
        } as i32,
        red: color.components[0],
        green: color.components[1],
        blue: color.components[2],
        alpha: color.alpha,
    }
}
fn color_from_proto(color: v1::Color) -> Result<Color, ServiceError> {
    let space =
        match v1::ColorSpace::try_from(color.space).map_err(|_| ServiceError::ReducerRejected)? {
            v1::ColorSpace::Srgb => ColorSpace::Srgb,
            v1::ColorSpace::DisplayP3 => ColorSpace::DisplayP3,
            v1::ColorSpace::LinearSrgb => ColorSpace::LinearSrgb,
            v1::ColorSpace::Unspecified => return Err(ServiceError::ReducerRejected),
        };
    Color::new(space, [color.red, color.green, color.blue], color.alpha)
        .map_err(|_| ServiceError::ReducerRejected)
}
fn profile_to_proto(profile: DocumentColorProfile) -> v1::DocumentColorProfile {
    match profile {
        DocumentColorProfile::Srgb => v1::DocumentColorProfile::Srgb,
        DocumentColorProfile::DisplayP3 => v1::DocumentColorProfile::DisplayP3,
    }
}
fn profile_from_proto(value: i32) -> Result<DocumentColorProfile, ServiceError> {
    match v1::DocumentColorProfile::try_from(value).map_err(|_| ServiceError::ReducerRejected)? {
        v1::DocumentColorProfile::Srgb => Ok(DocumentColorProfile::Srgb),
        v1::DocumentColorProfile::DisplayP3 => Ok(DocumentColorProfile::DisplayP3),
        v1::DocumentColorProfile::Unspecified => Err(ServiceError::ReducerRejected),
    }
}
fn id(value: &[u8]) -> Result<u128, ServiceError> {
    let bytes: [u8; 16] = value
        .try_into()
        .map_err(|_| ServiceError::ReducerRejected)?;
    Ok(u128::from_be_bytes(bytes))
}
fn id_to_bytes(value: u128) -> Vec<u8> {
    value.to_be_bytes().to_vec()
}
fn document_id_to_bytes(value: DocumentId) -> Vec<u8> {
    id_to_bytes(value.0)
}

#[cfg(test)]
mod tests {
    use editor_core::{
        AssetId, AssetReference, AutoLayout, BooleanOperation, ConstraintType, Constraints,
        DEFAULT_PAGE_ID, Document, DocumentId, FontReference, LayoutAlignment, LayoutMode, Node,
        NodeId, NodeKind, ParagraphStyle, PositionId, TextAlign, TextAutoSize, TextProperties,
        TextStyleRun, WrapTrackAlignment, color::Color, geometry::AffineTransform,
    };
    use sha2::Sha256;

    use crate::{DocumentService, TrustedPrincipal};

    use super::*;

    #[test]
    fn snapshot_round_trips_page_node_and_tombstone_state() {
        let mut document = Document::with_id(DocumentId(9));
        document
            .seed_node_on_page(
                DEFAULT_PAGE_ID,
                Node {
                    id: NodeId(7),
                    parent_id: None,
                    position: PositionId::for_node(NodeId(7)),
                    name: "Card".into(),
                    kind: NodeKind::Rectangle,
                    x: 0.0,
                    y: 0.0,
                    width: 100.0,
                    height: 80.0,
                    rotation: 0.0,
                    fill: Paint::Solid(Color::from_srgb_u8([20, 30, 40], 255)),
                    stroke: Paint::Solid(Color::from_srgb_u8([0, 0, 0], 0)),
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
                    relative_transform: Some(AffineTransform {
                        a: 1.0,
                        b: 0.0,
                        c: 0.0,
                        d: 1.0,
                        e: 24.0,
                        f: 12.0,
                    }),
                    opacity: 1.0,
                    blend_mode: BlendMode::Normal,
                    drop_shadow: None,
                    effect_stack: Vec::new(),
                    corner_radius: 0.0,
                    corner_radii: vec![4.0, 8.0, 12.0, 16.0],
                    corner_smoothing: 0.0,
                    constraints: None,
                    text: String::new(),
                    visible: true,
                    locked: false,
                    contents_hidden: false,
                    clips_content: false,
                    extensions: std::collections::BTreeMap::new(),
                },
            )
            .unwrap();
        document
            .seed_asset(AssetReference {
                asset_id: AssetId(42),
                content_hash: [8; 32],
                media_type: "image/png".into(),
                byte_length: 16,
                dimensions: Some([2, 2]),
            })
            .unwrap();
        let snapshot = snapshot_from_document(&document, 3).unwrap();
        let expected_document_id = 9_u128.to_be_bytes();
        let restored =
            document_from_snapshot(&snapshot, expected_document_id, document.canonical_hash())
                .unwrap();
        assert_eq!(restored.canonical_hash(), document.canonical_hash());
        assert_eq!(
            restored.node(NodeId(7)).unwrap().corner_radii,
            vec![4.0, 8.0, 12.0, 16.0]
        );
        assert_eq!(
            restored.node(NodeId(7)).unwrap().relative_transform,
            Some(AffineTransform {
                a: 1.0,
                b: 0.0,
                c: 0.0,
                d: 1.0,
                e: 24.0,
                f: 12.0
            })
        );
        assert_eq!(restored.asset(AssetId(42)).unwrap().media_type, "image/png");
    }

    #[test]
    fn snapshot_round_trips_a_flow_child_align_self() {
        let mut document = Document::with_id(DocumentId(19));
        let mut frame = leaf(NodeId(1), None, NodeKind::Frame);
        frame.name = "Layout frame".into();
        let mut child = leaf(NodeId(2), Some(NodeId(1)), NodeKind::Rectangle);
        child.name = "Aligned child".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, frame).unwrap();
        document.seed_node_on_page(DEFAULT_PAGE_ID, child).unwrap();
        let mut frame_layout = AutoLayout::default();
        frame_layout.mode = LayoutMode::Horizontal;
        frame_layout.wrap = true;
        frame_layout.counter_alignment = LayoutAlignment::Baseline;
        frame_layout.track_spacing = Some(9.0);
        frame_layout.track_alignment = WrapTrackAlignment::SpaceBetween;
        document.seed_auto_layout(NodeId(1), frame_layout).unwrap();
        let mut child_layout = AutoLayout::default();
        child_layout.align_self = Some(LayoutAlignment::End);
        document.seed_auto_layout(NodeId(2), child_layout).unwrap();

        let snapshot = snapshot_from_document(&document, 3).unwrap();
        let restored =
            document_from_snapshot(&snapshot, 19_u128.to_be_bytes(), document.canonical_hash())
                .unwrap();

        assert_eq!(restored.canonical_hash(), document.canonical_hash());
        assert_eq!(
            restored.auto_layout_for_node(NodeId(2)).align_self,
            Some(LayoutAlignment::End)
        );
        assert_eq!(
            restored.auto_layout_for_node(NodeId(1)).counter_alignment,
            LayoutAlignment::Baseline
        );
        assert_eq!(
            restored.auto_layout_for_node(NodeId(1)).track_spacing,
            Some(9.0)
        );
        assert_eq!(
            restored.auto_layout_for_node(NodeId(1)).track_alignment,
            WrapTrackAlignment::SpaceBetween
        );
    }

    #[test]
    fn snapshot_round_trips_rich_text_runs_fallbacks_and_variable_axes() {
        let mut document = Document::with_id(DocumentId(20));
        let mut text = leaf(NodeId(3), None, NodeKind::Text);
        text.name = "Mixed text".into();
        // Byte ranges deliberately cross a non-BMP scalar boundary: `A😀` is
        // five UTF-8 bytes and `中` is the following three bytes.
        text.text = "A😀中".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, text).unwrap();
        for asset_id in [AssetId(71), AssetId(72)] {
            document
                .seed_asset(AssetReference {
                    asset_id,
                    content_hash: [asset_id.0 as u8; 32],
                    media_type: "font/woff2".into(),
                    byte_length: 16,
                    dimensions: None,
                })
                .unwrap();
        }
        let primary = FontReference {
            asset_id: AssetId(71),
            face_index: 2,
            variation_axes: [("wdth".into(), 92.0), ("wght".into(), 650.0)]
                .into_iter()
                .collect(),
        };
        let fallback = FontReference {
            asset_id: AssetId(72),
            face_index: 0,
            variation_axes: Default::default(),
        };
        let properties = TextProperties {
            runs: vec![
                TextStyleRun {
                    start: 0,
                    end: 5,
                    font: Some(primary.clone()),
                    font_size: 18.0,
                    font_weight: 650,
                    italic: false,
                    letter_spacing: 0.25,
                    color: None,
                },
                TextStyleRun {
                    start: 5,
                    end: 8,
                    font: None,
                    font_size: 20.0,
                    font_weight: 500,
                    italic: true,
                    letter_spacing: 0.0,
                    color: Some(Color::from_srgb_u8([20, 40, 60], 255)),
                },
            ],
            paragraph: ParagraphStyle {
                alignment: TextAlign::Justify,
                line_height: Some(27.0),
                paragraph_spacing: 6.0,
            },
            auto_size: TextAutoSize::Height,
            fallback_fonts: vec![fallback],
        };
        document
            .seed_text_properties(NodeId(3), properties.clone())
            .unwrap();

        let snapshot = snapshot_from_document(&document, 3).unwrap();
        let restored =
            document_from_snapshot(&snapshot, 20_u128.to_be_bytes(), document.canonical_hash())
                .unwrap();

        assert_eq!(restored.canonical_hash(), document.canonical_hash());
        assert_eq!(
            restored.text_properties_for_node(NodeId(3)),
            Some(&properties)
        );
    }

    #[test]
    fn snapshot_round_trips_the_canonical_alpha_mask_extension() {
        let mut document = Document::with_id(DocumentId(21));
        let mut mask = leaf(NodeId(4), None, NodeKind::Rectangle);
        mask.name = "Alpha mask".into();
        // The mask bit deliberately remains an opaque Canonical extension at
        // the protobuf service boundary. WASM derives `isMask` from exactly
        // these bytes, so a service restore must not normalize or drop it.
        mask.extensions
            .insert("makefigma.mask.alpha.v1".into(), vec![1]);
        mask.extensions
            .insert("figma.mask.type".into(), b"ALPHA".to_vec());
        document.seed_node_on_page(DEFAULT_PAGE_ID, mask).unwrap();

        let snapshot = snapshot_from_document(&document, 3).unwrap();
        let restored =
            document_from_snapshot(&snapshot, 21_u128.to_be_bytes(), document.canonical_hash())
                .unwrap();

        assert_eq!(restored.canonical_hash(), document.canonical_hash());
        assert_eq!(
            restored
                .node(NodeId(4))
                .unwrap()
                .extensions
                .get("makefigma.mask.alpha.v1"),
            Some(&vec![1])
        );
        assert_eq!(
            restored
                .node(NodeId(4))
                .unwrap()
                .extensions
                .get("figma.mask.type"),
            Some(&b"ALPHA".to_vec())
        );
    }

    #[test]
    fn snapshot_round_trips_a_live_boolean_tree_and_its_operation() {
        let mut document = Document::with_id(DocumentId(22));
        let mut boolean = leaf(NodeId(5), None, NodeKind::BooleanOperation);
        boolean.name = "Boolean union".into();
        boolean.boolean_operation = Some(BooleanOperation::Union);
        let mut first = leaf(NodeId(6), Some(NodeId(5)), NodeKind::Rectangle);
        first.name = "First operand".into();
        let mut second = leaf(NodeId(7), Some(NodeId(5)), NodeKind::Ellipse);
        second.name = "Second operand".into();
        document
            .seed_node_on_page(DEFAULT_PAGE_ID, boolean)
            .unwrap();
        document.seed_node_on_page(DEFAULT_PAGE_ID, first).unwrap();
        document.seed_node_on_page(DEFAULT_PAGE_ID, second).unwrap();

        let snapshot = snapshot_from_document(&document, 3).unwrap();
        let restored =
            document_from_snapshot(&snapshot, 22_u128.to_be_bytes(), document.canonical_hash())
                .unwrap();

        assert_eq!(restored.canonical_hash(), document.canonical_hash());
        assert_eq!(
            restored.node(NodeId(5)).unwrap().boolean_operation,
            Some(BooleanOperation::Union)
        );
        assert_eq!(restored.node(NodeId(6)).unwrap().parent_id, Some(NodeId(5)));
        assert_eq!(restored.node(NodeId(7)).unwrap().parent_id, Some(NodeId(5)));
    }

    #[test]
    fn core_reducer_recovers_snapshot_and_continues_after_an_accepted_operation() {
        let document = Document::with_id(DocumentId(11));
        let service = DocumentService::in_memory(CoreOperationReducer::new(3)).unwrap();
        let tenant_id = 2_u128.to_be_bytes();
        let actor_id = 7_u128.to_be_bytes();
        service
            .create_document(
                initial_document_state(&document, tenant_id, 3).unwrap(),
                &[actor_id],
            )
            .unwrap();

        let create_page = |page_id: u128, position_key: u128, name: &str| {
            v1::ResolvedOperationBatch {
                operations: vec![v1::ResolvedOperation {
                    kind: Some(v1::resolved_operation::Kind::CreatePage(v1::CreatePage {
                        page: Some(v1::PageRef {
                            page_id: page_id.to_be_bytes().to_vec(),
                            name: name.into(),
                            position_id: Some(v1::PositionId {
                                key: position_key.to_be_bytes().to_vec(),
                                actor_id: 0_u128.to_be_bytes().to_vec(),
                            }),
                        }),
                    })),
                }],
            }
            .encode_to_vec()
        };
        let envelope = |operation_id: u128, base_revision: u64, payload: Vec<u8>| {
            v1::OperationEnvelope {
                schema_version: 1,
                document_id: 11_u128.to_be_bytes().to_vec(),
                operation_id: operation_id.to_be_bytes().to_vec(),
                transaction_id: operation_id.to_be_bytes().to_vec(),
                actor_id: actor_id.to_vec(),
                session_id: 9_u128.to_be_bytes().to_vec(),
                client_sequence: operation_id as u64,
                base_revision,
                causal_parent_ids: vec![],
                payload_hash: Sha256::digest(&payload).to_vec(),
                payload,
                engine_semantics_version: Some(3),
            }
            .encode_to_vec()
        };
        let principal = TrustedPrincipal {
            tenant_id,
            actor_id,
        };
        assert_eq!(
            service
                .submit(
                    principal,
                    &envelope(100, 0, create_page(2, 0x8000, "Ideas"))
                )
                .unwrap()
                .accepted_revision,
            1
        );
        assert_eq!(
            service
                .submit(principal, &envelope(101, 1, create_page(3, 0x4000, "Ship")))
                .unwrap()
                .accepted_revision,
            2
        );

        let persisted = service.load_document(11_u128.to_be_bytes()).unwrap();
        let restored = document_from_snapshot(
            &persisted.snapshot,
            persisted.document_id,
            persisted.document_hash,
        )
        .unwrap();
        assert_eq!(restored.revision, 2);
        assert_eq!(
            restored
                .page(editor_core::PageId(2))
                .map(|page| page.name.as_str()),
            Some("Ideas")
        );
        assert_eq!(
            restored
                .page(editor_core::PageId(3))
                .map(|page| page.name.as_str()),
            Some("Ship")
        );
        assert_eq!(
            restored
                .page(editor_core::PageId(2))
                .map(|page| page.position.key),
            Some(0x8000)
        );
        assert_eq!(
            restored
                .page(editor_core::PageId(3))
                .map(|page| page.position.key),
            Some(0x4000)
        );
    }

    fn container_with_child() -> Document {
        // A Frame (1) containing a Frame (2) containing a Rectangle (3): two levels
        // of nesting so a "forgot the deepest descendant" batch is testable. Nested
        // Frames (rather than Groups) keep the child-first delete valid end-to-end,
        // since Core auto-dissolves a Group when its final child leaves.
        let mut document = Document::with_id(DocumentId(21));
        let mut frame = leaf(NodeId(1), None, NodeKind::Frame);
        frame.name = "Frame".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, frame).unwrap();
        let mut inner = leaf(NodeId(2), Some(NodeId(1)), NodeKind::Frame);
        inner.name = "Inner".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, inner).unwrap();
        let mut rect = leaf(NodeId(3), Some(NodeId(2)), NodeKind::Rectangle);
        rect.name = "Rect".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, rect).unwrap();
        document
    }

    fn leaf(id: NodeId, parent_id: Option<NodeId>, kind: NodeKind) -> Node {
        let clips_content = kind == NodeKind::Frame;
        Node {
            id,
            parent_id,
            position: PositionId::for_node(id),
            name: String::new(),
            kind,
            x: 0.0,
            y: 0.0,
            width: 40.0,
            height: 40.0,
            rotation: 0.0,
            fill: Paint::Solid(Color::from_srgb_u8([0, 0, 0], 0)),
            stroke: Paint::Solid(Color::from_srgb_u8([0, 0, 0], 0)),
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
            clips_content,
            extensions: std::collections::BTreeMap::new(),
        }
    }

    #[test]
    fn service_snapshot_adapter_round_trips_slice_kind_and_world_geometry() {
        let mut slice = leaf(NodeId(17), None, NodeKind::Slice);
        slice.name = "Export area".into();
        slice.stroke_align = StrokeAlign::Inside;
        slice.rotation = 22.5;
        let wire = node_to_proto(&slice, DEFAULT_PAGE_ID, None, None, AutoLayout::default());
        assert_eq!(wire.kind, v1::NodeKind::Slice as i32);

        let (page_id, restored, asset_id, text_properties, auto_layout) =
            node_from_proto(wire).unwrap();
        assert_eq!(page_id, DEFAULT_PAGE_ID);
        assert_eq!(restored.kind, NodeKind::Slice);
        assert_eq!(restored.rotation, 22.5);
        assert_eq!(asset_id, None);
        assert_eq!(text_properties, None);
        assert_eq!(auto_layout, AutoLayout::default());
    }

    #[test]
    fn delete_subtree_guard_requires_every_descendant_of_a_deleted_container() {
        let document = container_with_child();

        // Deleting only the Frame while its Group + Rectangle survive is rejected.
        assert_eq!(
            validate_delete_subtree_completeness(&document, &[Command::Delete { id: NodeId(1) }]),
            Err(ServiceError::ReducerRejected)
        );
        // Deleting the Frame + Group but forgetting the deepest Rectangle is also rejected.
        assert_eq!(
            validate_delete_subtree_completeness(
                &document,
                &[
                    Command::Delete { id: NodeId(1) },
                    Command::Delete { id: NodeId(2) }
                ]
            ),
            Err(ServiceError::ReducerRejected)
        );
        // A complete child-first subtree delete is accepted.
        assert_eq!(
            validate_delete_subtree_completeness(
                &document,
                &[
                    Command::Delete { id: NodeId(3) },
                    Command::Delete { id: NodeId(2) },
                    Command::Delete { id: NodeId(1) },
                ]
            ),
            Ok(())
        );
    }

    #[test]
    fn delete_subtree_guard_allows_a_descendant_reparented_out_of_the_deleted_subtree() {
        let document = container_with_child();
        // The Rectangle is rehomed onto the page root, so deleting the Frame + Group
        // that no longer contain it is a complete subtree removal.
        let commands = vec![
            Command::SetNodeParent {
                id: NodeId(3),
                parent_id: None,
                position: PositionId::for_node(NodeId(3)),
            },
            Command::Delete { id: NodeId(2) },
            Command::Delete { id: NodeId(1) },
        ];
        assert_eq!(
            validate_delete_subtree_completeness(&document, &commands),
            Ok(())
        );

        // But reparenting the survivor *within* the doomed subtree does not save it.
        let commands = vec![
            Command::SetNodeParent {
                id: NodeId(3),
                parent_id: Some(NodeId(1)),
                position: PositionId::for_node(NodeId(3)),
            },
            Command::Delete { id: NodeId(2) },
            Command::Delete { id: NodeId(1) },
        ];
        assert_eq!(
            validate_delete_subtree_completeness(&document, &commands),
            Err(ServiceError::ReducerRejected)
        );
    }

    #[test]
    fn service_replays_a_frame_resize_and_persists_the_constrained_child_geometry() {
        let service = DocumentService::in_memory(CoreOperationReducer::new(3)).unwrap();
        let tenant_id = 2_u128.to_be_bytes();
        let actor_id = 7_u128.to_be_bytes();
        let mut document = Document::with_id(DocumentId(23));
        let mut frame = leaf(NodeId(1), None, NodeKind::Frame);
        frame.name = "Resizable frame".into();
        frame.width = 100.0;
        frame.height = 100.0;
        let mut child = leaf(NodeId(2), Some(NodeId(1)), NodeKind::Rectangle);
        child.name = "Pinned and stretched child".into();
        child.x = 20.0;
        child.y = 10.0;
        child.width = 40.0;
        child.height = 20.0;
        child.constraints = Some(Constraints {
            horizontal: ConstraintType::Max,
            vertical: ConstraintType::Stretch,
        });
        document.seed_node_on_page(DEFAULT_PAGE_ID, frame).unwrap();
        document.seed_node_on_page(DEFAULT_PAGE_ID, child).unwrap();
        service
            .create_document(
                initial_document_state(&document, tenant_id, 3).unwrap(),
                &[actor_id],
            )
            .unwrap();

        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::UpdateGeometry(
                    v1::GeometryUpdate {
                        node_id: 1_u128.to_be_bytes().to_vec(),
                        x: 0.0,
                        y: 0.0,
                        width: 200.0,
                        height: 160.0,
                        rotation: 0.0,
                    },
                )),
            }],
        }
        .encode_to_vec();
        let envelope = v1::OperationEnvelope {
            schema_version: 1,
            document_id: 23_u128.to_be_bytes().to_vec(),
            operation_id: 24_u128.to_be_bytes().to_vec(),
            transaction_id: 24_u128.to_be_bytes().to_vec(),
            actor_id: actor_id.to_vec(),
            session_id: 9_u128.to_be_bytes().to_vec(),
            client_sequence: 24,
            base_revision: 0,
            causal_parent_ids: vec![],
            payload_hash: Sha256::digest(&payload).to_vec(),
            payload,
            engine_semantics_version: Some(3),
        }
        .encode_to_vec();

        assert_eq!(
            service
                .submit(
                    TrustedPrincipal {
                        tenant_id,
                        actor_id
                    },
                    &envelope
                )
                .unwrap()
                .accepted_revision,
            1
        );
        let stored = service.load_document(23_u128.to_be_bytes()).unwrap();
        let restored =
            document_from_snapshot(&stored.snapshot, stored.document_id, stored.document_hash)
                .unwrap();
        let child = restored.node(NodeId(2)).unwrap();
        assert_eq!(stored.accepted_revision, 1);
        assert_eq!(
            child.constraints,
            Some(Constraints {
                horizontal: ConstraintType::Max,
                vertical: ConstraintType::Stretch,
            })
        );
        assert_eq!(
            (child.x, child.y, child.width, child.height),
            (120.0, 10.0, 40.0, 80.0)
        );
    }

    #[test]
    fn service_rejects_an_incomplete_subtree_delete_before_any_mutation() {
        let service = DocumentService::in_memory(CoreOperationReducer::new(3)).unwrap();
        let tenant_id = 2_u128.to_be_bytes();
        let actor_id = 7_u128.to_be_bytes();
        let mut document = container_with_child();
        document.revision = 0;
        service
            .create_document(
                initial_document_state(&document, tenant_id, 3).unwrap(),
                &[actor_id],
            )
            .unwrap();
        let principal = TrustedPrincipal {
            tenant_id,
            actor_id,
        };
        let document_id = 21_u128.to_be_bytes();

        let delete_only_frame = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::DeleteNode(v1::DeleteNode {
                    node_id: 1_u128.to_be_bytes().to_vec(),
                })),
            }],
        }
        .encode_to_vec();
        let envelope = |operation_id: u128, payload: Vec<u8>| {
            v1::OperationEnvelope {
                schema_version: 1,
                document_id: document_id.to_vec(),
                operation_id: operation_id.to_be_bytes().to_vec(),
                transaction_id: operation_id.to_be_bytes().to_vec(),
                actor_id: actor_id.to_vec(),
                session_id: 9_u128.to_be_bytes().to_vec(),
                client_sequence: operation_id as u64,
                base_revision: 0,
                causal_parent_ids: vec![],
                payload_hash: Sha256::digest(&payload).to_vec(),
                payload,
                engine_semantics_version: Some(3),
            }
            .encode_to_vec()
        };

        assert_eq!(
            service.submit(principal, &envelope(50, delete_only_frame)),
            Err(ServiceError::ReducerRejected)
        );
        // The document is untouched: revision and every node survive.
        let after = service.load_document(document_id).unwrap();
        assert_eq!(after.accepted_revision, 0);
        let restored =
            document_from_snapshot(&after.snapshot, after.document_id, after.document_hash)
                .unwrap();
        assert!(restored.node(NodeId(1)).is_some());
        assert!(restored.node(NodeId(3)).is_some());

        // A complete child-first subtree delete in one batch is accepted and removes all three.
        let delete_subtree = v1::ResolvedOperationBatch {
            operations: [3_u128, 2, 1]
                .into_iter()
                .map(|node| v1::ResolvedOperation {
                    kind: Some(v1::resolved_operation::Kind::DeleteNode(v1::DeleteNode {
                        node_id: node.to_be_bytes().to_vec(),
                    })),
                })
                .collect(),
        }
        .encode_to_vec();
        assert_eq!(
            service
                .submit(principal, &envelope(51, delete_subtree))
                .unwrap()
                .accepted_revision,
            1
        );
        let after = service.load_document(document_id).unwrap();
        let restored =
            document_from_snapshot(&after.snapshot, after.document_id, after.document_hash)
                .unwrap();
        assert!(restored.node(NodeId(1)).is_none());
        assert!(restored.node(NodeId(2)).is_none());
        assert!(restored.node(NodeId(3)).is_none());
    }
}
