//! Canonical editor-core ↔ durable Protobuf snapshot conversion.
//!
//! This crate deliberately has no database or HTTP dependency so the same
//! validation path can be used by the Rust service and the browser WASM engine.

use editor_core::{
    ActorId, ArcData, AssetId, AssetReference, AutoLayout, BackgroundBlur, BlendMode,
    BooleanOperation, ConstraintType, Constraints, Document, DocumentId, DropShadow, Effect,
    FillRule, FontReference, InnerShadow, LayerBlur, LayoutAlignment, LayoutMode, LayoutSizing,
    Node, NodeId, NodeKind, Page, PageId, ParagraphStyle, ParametricShape, PointId, PositionId,
    StrokeAlign, StrokeCap, StrokeJoin, TextAlign, TextAutoSize, TextProperties, TextStyleRun,
    VectorPath, VectorPoint, VectorPointType, VectorSubpath, WrapTrackAlignment,
    color::{Color, ColorSpace, DocumentColorProfile, GradientStop, LinearGradient, Paint},
};
use makefigma_protocol::v1;
use prost::Message;
use sha2::Digest;
use std::collections::{BTreeMap, BTreeSet};

pub const SNAPSHOT_FORMAT_VERSION: u32 = 1;
pub type Hash = [u8; 32];
pub type Id = [u8; 16];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotError {
    Invalid,
    /// The snapshot carries a NodeKind minted by a newer engine version. The
    /// document is not corrupt; the current client is simply too old to open it
    /// without silently rewriting the unknown node. Kept distinct from `Invalid`
    /// so the UI can surface a read-only "requires a newer client" state instead
    /// of a generic corruption error (ADR 0023, P0-3).
    UnsupportedFutureNode,
}

struct DecodedNode {
    page_id: PageId,
    node: Node,
    asset_id: Option<AssetId>,
    text_properties: Option<TextProperties>,
    auto_layout: AutoLayout,
}

pub fn snapshot_from_document(
    document: &Document,
    engine_semantics_version: u32,
) -> Result<Vec<u8>, SnapshotError> {
    let mut pages = document.pages().cloned().collect::<Vec<_>>();
    pages.sort_by_key(|page| (page.position, page.id));
    let page_chunks = pages
        .into_iter()
        .map(|page| {
            let nodes = document
                .ordered_nodes_on_page(page.id)
                .map_err(|_| SnapshotError::Invalid)?
                .into_iter()
                .map(|node| {
                    Ok(v1::SceneNodeRef {
                        node_id: id_to_bytes(node.id.0),
                        parent_id: node.parent_id.map(|id| id_to_bytes(id.0)),
                        page_id: id_to_bytes(page.id.0),
                        position_id: Some(position_to_proto(node.position)),
                        canonical_node: node_to_proto(
                            node,
                            page.id,
                            document.asset_for_node(node.id),
                            document.text_properties_for_node(node.id),
                            document.auto_layout_for_node(node.id),
                        )
                        .encode_to_vec(),
                    })
                })
                .collect::<Result<Vec<_>, SnapshotError>>()?;
            Ok(v1::PageChunk {
                format_version: SNAPSHOT_FORMAT_VERSION,
                page: Some(page_to_proto(&page)),
                nodes,
                content_hash: page_hash(document, page.id),
                extensions: Default::default(),
            })
        })
        .collect::<Result<Vec<_>, SnapshotError>>()?;
    Ok(v1::DocumentSnapshot {
        format_version: SNAPSHOT_FORMAT_VERSION,
        engine_semantics_version,
        document_id: id_to_bytes(document.id().0),
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

/// Restores only a fully self-consistent snapshot. `expected_*` binds an already
/// persisted service row to the snapshot bytes instead of trusting either alone.
pub fn document_from_snapshot(
    bytes: &[u8],
    expected_document_id: Id,
    expected_hash: Hash,
) -> Result<Document, SnapshotError> {
    let snapshot = v1::DocumentSnapshot::decode(bytes).map_err(|_| SnapshotError::Invalid)?;
    if snapshot.format_version != SNAPSHOT_FORMAT_VERSION
        || snapshot.document_id.as_slice() != expected_document_id.as_slice()
    {
        return Err(SnapshotError::Invalid);
    }
    let mut document = Document::with_id(DocumentId(id(&snapshot.document_id)?));
    document.seed_color_profile(profile_from_proto(snapshot.document_color_profile)?);
    for asset in snapshot.resource_index {
        document
            .seed_asset(asset_from_proto(asset)?)
            .map_err(|_| SnapshotError::Invalid)?;
    }
    let mut page_hashes = BTreeMap::new();
    let mut decoded_nodes = BTreeMap::new();
    for chunk in snapshot.page_chunks {
        if chunk.format_version != SNAPSHOT_FORMAT_VERSION {
            return Err(SnapshotError::Invalid);
        }
        let page = page_from_proto(chunk.page.ok_or(SnapshotError::Invalid)?)?;
        let chunk_page_id = page.id;
        if page_hashes
            .insert(chunk_page_id, chunk.content_hash)
            .is_some()
        {
            return Err(SnapshotError::Invalid);
        }
        if page.id == editor_core::DEFAULT_PAGE_ID {
            document
                .seed_default_page(page)
                .map_err(|_| SnapshotError::Invalid)?;
        } else {
            document
                .seed_page(page)
                .map_err(|_| SnapshotError::Invalid)?;
        }
        for reference in chunk.nodes {
            let node_proto = v1::SceneNode::decode(reference.canonical_node.as_slice())
                .map_err(|_| SnapshotError::Invalid)?;
            let (page_id, node, asset_id, text_properties, auto_layout) =
                node_from_proto(node_proto)?;
            if page_id != chunk_page_id
                || page_id.0 != id(&reference.page_id)?
                || node.id.0 != id(&reference.node_id)?
                || node.position
                    != position_from_proto(reference.position_id.ok_or(SnapshotError::Invalid)?)?
            {
                return Err(SnapshotError::Invalid);
            }
            if node.parent_id.map(|id| id.0)
                != reference.parent_id.as_deref().map(id).transpose()?
            {
                return Err(SnapshotError::Invalid);
            }
            if decoded_nodes
                .insert(
                    node.id,
                    DecodedNode {
                        page_id,
                        node,
                        asset_id,
                        text_properties,
                        auto_layout,
                    },
                )
                .is_some()
            {
                return Err(SnapshotError::Invalid);
            }
        }
    }
    let hydration_order = nodes_in_hydration_order(&decoded_nodes)?;
    for node_id in hydration_order {
        let decoded = decoded_nodes.get(&node_id).ok_or(SnapshotError::Invalid)?;
        if let Some(asset_id) = decoded.asset_id {
            document.seed_image_node_on_page(decoded.page_id, decoded.node.clone(), asset_id)
        } else {
            document.seed_node_on_page(decoded.page_id, decoded.node.clone())
        }
        .map_err(|_| SnapshotError::Invalid)?;
    }
    for decoded in decoded_nodes.values() {
        if let Some(properties) = decoded.text_properties.clone() {
            document
                .seed_text_properties(decoded.node.id, properties)
                .map_err(|_| SnapshotError::Invalid)?;
        }
        document
            .seed_auto_layout(decoded.node.id, decoded.auto_layout.clone())
            .map_err(|_| SnapshotError::Invalid)?;
    }
    for retired_id in snapshot.retired_node_ids {
        document
            .seed_retired_id(NodeId(id(&retired_id)?))
            .map_err(|_| SnapshotError::Invalid)?;
    }
    document.revision = snapshot.revision;
    if page_hashes
        .into_iter()
        .any(|(page_id, hash)| hash != page_hash(&document, page_id))
    {
        return Err(SnapshotError::Invalid);
    }
    let hash = document.canonical_hash();
    if snapshot.content_hash.as_slice() != hash.as_slice() || hash != expected_hash {
        return Err(SnapshotError::Invalid);
    }
    Ok(document)
}

/// Keeps wire ordering independent from hydration ordering. `ordered_nodes_on_page`
/// is part of the existing page-hash contract, so snapshots continue to use it for
/// serialization while this helper performs a stable parent-before-child traversal.
fn nodes_in_hydration_order(
    decoded: &BTreeMap<NodeId, DecodedNode>,
) -> Result<Vec<NodeId>, SnapshotError> {
    let mut children = BTreeMap::<NodeId, Vec<NodeId>>::new();
    let mut indegree = BTreeMap::<NodeId, usize>::new();
    let mut sibling_positions = BTreeSet::new();

    for (&node_id, decoded_node) in decoded {
        let node = &decoded_node.node;
        if !sibling_positions.insert((decoded_node.page_id, node.parent_id, node.position)) {
            return Err(SnapshotError::Invalid);
        }
        indegree.insert(node_id, 0);
    }

    for (&node_id, decoded_node) in decoded {
        let node = &decoded_node.node;
        if let Some(parent_id) = node.parent_id {
            let parent = decoded.get(&parent_id).ok_or(SnapshotError::Invalid)?;
            if parent.page_id != decoded_node.page_id
                || !matches!(
                    parent.node.kind,
                    NodeKind::Frame | NodeKind::Group | NodeKind::Section
                )
            {
                return Err(SnapshotError::Invalid);
            }
            *indegree.get_mut(&node_id).ok_or(SnapshotError::Invalid)? = 1;
            children.entry(parent_id).or_default().push(node_id);
        }
    }

    let key_for = |node_id: NodeId| {
        let decoded_node = decoded
            .get(&node_id)
            .expect("hydration nodes always refer to decoded entries");
        (
            decoded_node.page_id,
            decoded_node.node.parent_id,
            decoded_node.node.position,
            node_id,
        )
    };
    let mut ready = indegree
        .iter()
        .filter_map(|(&node_id, &degree)| (degree == 0).then(|| key_for(node_id)))
        .collect::<BTreeSet<_>>();
    let mut ordered = Vec::with_capacity(decoded.len());

    while let Some(key) = ready.pop_first() {
        let node_id = key.3;
        ordered.push(node_id);
        for child_id in children.get(&node_id).into_iter().flatten() {
            let degree = indegree.get_mut(child_id).ok_or(SnapshotError::Invalid)?;
            *degree = degree.checked_sub(1).ok_or(SnapshotError::Invalid)?;
            if *degree == 0 {
                ready.insert(key_for(*child_id));
            }
        }
    }

    (ordered.len() == decoded.len())
        .then_some(ordered)
        .ok_or(SnapshotError::Invalid)
}

/// Validates a standalone wire snapshot before it exists in a service row.
pub fn document_from_wire_snapshot(bytes: &[u8]) -> Result<Document, SnapshotError> {
    let snapshot = v1::DocumentSnapshot::decode(bytes).map_err(|_| SnapshotError::Invalid)?;
    let document_id: Id = snapshot
        .document_id
        .as_slice()
        .try_into()
        .map_err(|_| SnapshotError::Invalid)?;
    let hash: Hash = snapshot
        .content_hash
        .as_slice()
        .try_into()
        .map_err(|_| SnapshotError::Invalid)?;
    document_from_snapshot(bytes, document_id, hash)
}

/// Creates a new document root from an existing canonical wire snapshot. The
/// clone retains only semantic scene state: it receives a new identity and a
/// fresh revision chain, while the content hash remains valid because identity
/// and revision are intentionally not part of the canonical document hash.
pub fn clone_wire_snapshot(bytes: &[u8], target_document_id: Id) -> Result<Vec<u8>, SnapshotError> {
    let mut snapshot = v1::DocumentSnapshot::decode(bytes).map_err(|_| SnapshotError::Invalid)?;
    // Validate before changing the two transport-owned fields. This prevents a
    // clone endpoint from becoming a way to persist a malformed source root.
    document_from_wire_snapshot(bytes)?;
    snapshot.document_id = target_document_id.to_vec();
    snapshot.revision = 0;
    let cloned = snapshot.encode_to_vec();
    document_from_wire_snapshot(&cloned)?;
    Ok(cloned)
}

fn page_hash(document: &Document, page_id: PageId) -> Vec<u8> {
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
fn asset_from_proto(asset: v1::ResourceIndexEntry) -> Result<AssetReference, SnapshotError> {
    Ok(AssetReference {
        asset_id: AssetId(id(&asset.asset_id)?),
        content_hash: asset
            .content_hash
            .try_into()
            .map_err(|_| SnapshotError::Invalid)?,
        media_type: asset.media_type,
        byte_length: asset.byte_length.ok_or(SnapshotError::Invalid)?,
        dimensions: match (asset.pixel_width, asset.pixel_height) {
            (None, None) => None,
            (Some(width), Some(height)) => Some([width, height]),
            _ => return Err(SnapshotError::Invalid),
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
        vector_path: node.vector_path.as_ref().map(vector_path_to_proto),
        boolean_operation: node.boolean_operation.map(boolean_operation_to_proto),
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
    SnapshotError,
> {
    let page_id = PageId(id(&node.page_id)?);
    let kind = match v1::NodeKind::try_from(node.kind) {
        Ok(v1::NodeKind::Frame) => NodeKind::Frame,
        Ok(v1::NodeKind::Rectangle) => NodeKind::Rectangle,
        Ok(v1::NodeKind::Ellipse) => NodeKind::Ellipse,
        Ok(v1::NodeKind::Text) => NodeKind::Text,
        Ok(v1::NodeKind::Image) => NodeKind::Image,
        Ok(v1::NodeKind::Line) => NodeKind::Line,
        Ok(v1::NodeKind::Group) => NodeKind::Group,
        Ok(v1::NodeKind::Section) => NodeKind::Section,
        Ok(v1::NodeKind::Polygon) => NodeKind::Polygon,
        Ok(v1::NodeKind::Star) => NodeKind::Star,
        Ok(v1::NodeKind::Vector) => NodeKind::Vector,
        Ok(v1::NodeKind::BooleanOperation) => NodeKind::BooleanOperation,
        Ok(v1::NodeKind::Slice) => NodeKind::Slice,
        Ok(v1::NodeKind::CodeBlock) => NodeKind::CodeBlock,
        Ok(v1::NodeKind::Component) => NodeKind::Component,
        Ok(v1::NodeKind::Instance) => NodeKind::Instance,
        Ok(v1::NodeKind::Slot) => NodeKind::Slot,
        Ok(v1::NodeKind::ComponentSet) => NodeKind::ComponentSet,
        Ok(v1::NodeKind::Connector) => NodeKind::Connector,
        Ok(v1::NodeKind::Embed) => NodeKind::Embed,
        Ok(v1::NodeKind::Highlight) => NodeKind::Highlight,
        Ok(v1::NodeKind::InteractiveSlideElement) => NodeKind::InteractiveSlideElement,
        Ok(v1::NodeKind::LinkUnfurl) => NodeKind::LinkUnfurl,
        Ok(v1::NodeKind::Media) => NodeKind::Media,
        Ok(v1::NodeKind::ShapeWithText) => NodeKind::ShapeWithText,
        Ok(v1::NodeKind::SlideGrid) => NodeKind::SlideGrid,
        Ok(v1::NodeKind::Slide) => NodeKind::Slide,
        Ok(v1::NodeKind::SlideRow) => NodeKind::SlideRow,
        Ok(v1::NodeKind::Stamp) => NodeKind::Stamp,
        Ok(v1::NodeKind::Sticky) => NodeKind::Sticky,
        Ok(v1::NodeKind::Table) => NodeKind::Table,
        Ok(v1::NodeKind::TableCell) => NodeKind::TableCell,
        Ok(v1::NodeKind::TextPath) => NodeKind::TextPath,
        Ok(v1::NodeKind::TransformGroup) => NodeKind::TransformGroup,
        Ok(v1::NodeKind::WashiTape) => NodeKind::WashiTape,
        Ok(v1::NodeKind::Widget) => NodeKind::Widget,
        Ok(v1::NodeKind::Unspecified) => return Err(SnapshotError::Invalid),
        // A positive tag outside the known enum is a NodeKind minted by a newer
        // engine. Reject the whole snapshot with a distinguishable error so the
        // client degrades to read-only rather than rewriting the node (ADR 0023).
        Err(_) if node.kind > 0 => return Err(SnapshotError::UnsupportedFutureNode),
        Err(_) => return Err(SnapshotError::Invalid),
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
            position: position_from_proto(node.position_id.ok_or(SnapshotError::Invalid)?)?,
            name: node.name,
            kind,
            x: node.x,
            y: node.y,
            width: node.width,
            height: node.height,
            rotation: node.rotation,
            fill: paint_from_proto(node.fill.ok_or(SnapshotError::Invalid)?)?,
            stroke: paint_from_proto(node.stroke.ok_or(SnapshotError::Invalid)?)?,
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

fn drop_shadow_from_proto(shadow: v1::DropShadow) -> Result<DropShadow, SnapshotError> {
    Ok(DropShadow {
        offset_x: shadow.offset_x,
        offset_y: shadow.offset_y,
        blur_radius: shadow.blur_radius,
        spread: shadow.spread,
        color: color_from_proto(shadow.color.ok_or(SnapshotError::Invalid)?)?,
        visible: shadow.visible,
    })
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

fn effect_from_proto(effect: v1::Effect) -> Result<Effect, SnapshotError> {
    match effect.kind.ok_or(SnapshotError::Invalid)? {
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
            color: color_from_proto(shadow.color.ok_or(SnapshotError::Invalid)?)?,
            visible: shadow.visible,
        })),
        v1::effect::Kind::BackgroundBlur(blur) => Ok(Effect::BackgroundBlur(BackgroundBlur {
            radius: blur.radius,
            visible: blur.visible,
        })),
    }
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

fn stroke_cap_from_proto(value: i32) -> Result<StrokeCap, SnapshotError> {
    Ok(
        match v1::StrokeCap::try_from(value).map_err(|_| SnapshotError::Invalid)? {
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

fn stroke_join_from_proto(value: i32) -> Result<StrokeJoin, SnapshotError> {
    Ok(
        match v1::StrokeJoin::try_from(value).map_err(|_| SnapshotError::Invalid)? {
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

fn constraints_from_proto(value: v1::Constraints) -> Result<Constraints, SnapshotError> {
    let convert =
        |axis| match v1::ConstraintType::try_from(axis).map_err(|_| SnapshotError::Invalid)? {
            v1::ConstraintType::Min => Ok(ConstraintType::Min),
            v1::ConstraintType::Center => Ok(ConstraintType::Center),
            v1::ConstraintType::Max => Ok(ConstraintType::Max),
            v1::ConstraintType::Stretch => Ok(ConstraintType::Stretch),
            v1::ConstraintType::Scale => Ok(ConstraintType::Scale),
            v1::ConstraintType::Unspecified => Err(SnapshotError::Invalid),
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
            .map(|alignment| alignment_to_proto(alignment) as i32),
        track_spacing: value.track_spacing,
        wrap_track_alignment: (value.track_alignment != WrapTrackAlignment::Auto).then(
            || match value.track_alignment {
                WrapTrackAlignment::Auto => v1::WrapTrackAlignment::Auto,
                WrapTrackAlignment::SpaceBetween => v1::WrapTrackAlignment::SpaceBetween,
            } as i32,
        ),
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
fn auto_layout_from_proto(value: v1::AutoLayout) -> Result<AutoLayout, SnapshotError> {
    let mode = match v1::LayoutMode::try_from(value.mode).map_err(|_| SnapshotError::Invalid)? {
        v1::LayoutMode::None => LayoutMode::None,
        v1::LayoutMode::Horizontal => LayoutMode::Horizontal,
        v1::LayoutMode::Vertical => LayoutMode::Vertical,
        v1::LayoutMode::Unspecified => return Err(SnapshotError::Invalid),
    };
    let alignment =
        |value| match v1::LayoutAlignment::try_from(value).map_err(|_| SnapshotError::Invalid)? {
            v1::LayoutAlignment::Start => Ok(LayoutAlignment::Start),
            v1::LayoutAlignment::Center => Ok(LayoutAlignment::Center),
            v1::LayoutAlignment::End => Ok(LayoutAlignment::End),
            v1::LayoutAlignment::SpaceBetween => Ok(LayoutAlignment::SpaceBetween),
            v1::LayoutAlignment::Baseline => Ok(LayoutAlignment::Baseline),
            v1::LayoutAlignment::Unspecified => Err(SnapshotError::Invalid),
        };
    let sizing =
        |value| match v1::LayoutSizing::try_from(value).map_err(|_| SnapshotError::Invalid)? {
            v1::LayoutSizing::Fixed => Ok(LayoutSizing::Fixed),
            v1::LayoutSizing::Hug => Ok(LayoutSizing::Hug),
            v1::LayoutSizing::Fill => Ok(LayoutSizing::Fill),
            v1::LayoutSizing::Unspecified => Err(SnapshotError::Invalid),
        };
    let align_self = value.align_self.map(|raw| alignment(raw)).transpose()?;
    if matches!(
        align_self,
        Some(LayoutAlignment::SpaceBetween | LayoutAlignment::Baseline)
    ) {
        return Err(SnapshotError::Invalid);
    }
    let track_alignment = match value
        .wrap_track_alignment
        .map(v1::WrapTrackAlignment::try_from)
        .transpose()
        .map_err(|_| SnapshotError::Invalid)?
    {
        None | Some(v1::WrapTrackAlignment::Auto) => WrapTrackAlignment::Auto,
        Some(v1::WrapTrackAlignment::SpaceBetween) => WrapTrackAlignment::SpaceBetween,
        Some(v1::WrapTrackAlignment::Unspecified) => return Err(SnapshotError::Invalid),
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
        return Err(SnapshotError::Invalid);
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

fn stroke_align_from_proto(value: i32) -> Result<StrokeAlign, SnapshotError> {
    Ok(
        match v1::StrokeAlign::try_from(value).map_err(|_| SnapshotError::Invalid)? {
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

fn blend_mode_from_proto(value: i32) -> Result<BlendMode, SnapshotError> {
    match v1::BlendMode::try_from(value) {
        Ok(v1::BlendMode::Normal) => Ok(BlendMode::Normal),
        Ok(v1::BlendMode::Multiply) => Ok(BlendMode::Multiply),
        Ok(v1::BlendMode::Screen) => Ok(BlendMode::Screen),
        Ok(v1::BlendMode::Overlay) => Ok(BlendMode::Overlay),
        Ok(v1::BlendMode::Darken) => Ok(BlendMode::Darken),
        Ok(v1::BlendMode::Lighten) => Ok(BlendMode::Lighten),
        Err(_) => Err(SnapshotError::Invalid),
    }
}

fn arc_to_proto(arc: ArcData) -> v1::ArcData {
    v1::ArcData {
        starting_angle: arc.starting_angle,
        ending_angle: arc.ending_angle,
        inner_radius: arc.inner_radius,
    }
}
fn arc_from_proto(arc: v1::ArcData) -> Result<ArcData, SnapshotError> {
    Ok(ArcData {
        starting_angle: arc.starting_angle,
        ending_angle: arc.ending_angle,
        inner_radius: arc.inner_radius,
    })
}
fn parametric_shape_from_proto(
    polygon: Option<v1::PolygonParameters>,
    star: Option<v1::StarParameters>,
) -> Result<Option<ParametricShape>, SnapshotError> {
    match (polygon, star) {
        (Some(_), Some(_)) => Err(SnapshotError::Invalid),
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
fn vector_path_from_proto(path: v1::VectorPath) -> Result<VectorPath, SnapshotError> {
    let fill_rule =
        match v1::FillRule::try_from(path.fill_rule).map_err(|_| SnapshotError::Invalid)? {
            v1::FillRule::NonZero => FillRule::NonZero,
            v1::FillRule::EvenOdd => FillRule::EvenOdd,
            v1::FillRule::Unspecified => return Err(SnapshotError::Invalid),
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
                            .map_err(|_| SnapshotError::Invalid)?
                        {
                            v1::VectorPointType::Corner => VectorPointType::Corner,
                            v1::VectorPointType::Mirrored => VectorPointType::Mirrored,
                            v1::VectorPointType::Asymmetric => VectorPointType::Asymmetric,
                            v1::VectorPointType::Unspecified => return Err(SnapshotError::Invalid),
                        };
                        let handle_in = match (point.handle_in_x, point.handle_in_y) {
                            (None, None) => None,
                            (Some(x), Some(y)) => Some(editor_core::geometry::Point { x, y }),
                            _ => return Err(SnapshotError::Invalid),
                        };
                        let handle_out = match (point.handle_out_x, point.handle_out_y) {
                            (None, None) => None,
                            (Some(x), Some(y)) => Some(editor_core::geometry::Point { x, y }),
                            _ => return Err(SnapshotError::Invalid),
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
                    .collect::<Result<Vec<_>, SnapshotError>>()?,
            })
        })
        .collect::<Result<Vec<_>, SnapshotError>>()?;
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
fn boolean_operation_from_proto(operation: i32) -> Result<BooleanOperation, SnapshotError> {
    match v1::BooleanOperation::try_from(operation).map_err(|_| SnapshotError::Invalid)? {
        v1::BooleanOperation::Union => Ok(BooleanOperation::Union),
        v1::BooleanOperation::Intersect => Ok(BooleanOperation::Intersect),
        v1::BooleanOperation::Subtract => Ok(BooleanOperation::Subtract),
        v1::BooleanOperation::Exclude => Ok(BooleanOperation::Exclude),
        v1::BooleanOperation::Unspecified => Err(SnapshotError::Invalid),
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
) -> Result<editor_core::geometry::AffineTransform, SnapshotError> {
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

fn font_from_proto(font: v1::FontReference) -> Result<FontReference, SnapshotError> {
    let mut variation_axes = std::collections::BTreeMap::new();
    for axis in font.variation_axes {
        if variation_axes
            .insert(axis.tag.clone(), axis.value)
            .is_some()
        {
            return Err(SnapshotError::Invalid);
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

fn text_properties_from_proto(value: v1::TextProperties) -> Result<TextProperties, SnapshotError> {
    let paragraph = value.paragraph.ok_or(SnapshotError::Invalid)?;
    let alignment = match v1::TextAlignment::try_from(paragraph.alignment)
        .map_err(|_| SnapshotError::Invalid)?
    {
        v1::TextAlignment::Left => TextAlign::Left,
        v1::TextAlignment::Center => TextAlign::Center,
        v1::TextAlignment::Right => TextAlign::Right,
        v1::TextAlignment::Justify => TextAlign::Justify,
        v1::TextAlignment::Unspecified => return Err(SnapshotError::Invalid),
    };
    let auto_size =
        match v1::TextAutoSize::try_from(value.auto_size).map_err(|_| SnapshotError::Invalid)? {
            v1::TextAutoSize::Fixed => TextAutoSize::Fixed,
            v1::TextAutoSize::Height => TextAutoSize::Height,
            v1::TextAutoSize::WidthAndHeight => TextAutoSize::WidthAndHeight,
            v1::TextAutoSize::Unspecified => return Err(SnapshotError::Invalid),
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
                        .map_err(|_| SnapshotError::Invalid)?,
                    italic: run.italic,
                    letter_spacing: run.letter_spacing,
                    color: run.color.map(color_from_proto).transpose()?,
                })
            })
            .collect::<Result<_, SnapshotError>>()?,
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
            .collect::<Result<_, SnapshotError>>()?,
    })
}
fn page_to_proto(page: &Page) -> v1::PageRef {
    v1::PageRef {
        page_id: id_to_bytes(page.id.0),
        name: page.name.clone(),
        position_id: Some(position_to_proto(page.position)),
    }
}
fn page_from_proto(page: v1::PageRef) -> Result<Page, SnapshotError> {
    Ok(Page {
        id: PageId(id(&page.page_id)?),
        name: page.name,
        position: position_from_proto(page.position_id.ok_or(SnapshotError::Invalid)?)?,
    })
}
fn position_to_proto(position: PositionId) -> v1::PositionId {
    v1::PositionId {
        key: id_to_bytes(position.key),
        actor_id: id_to_bytes(position.actor.0),
    }
}
fn position_from_proto(position: v1::PositionId) -> Result<PositionId, SnapshotError> {
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
fn paint_from_proto(paint: v1::Paint) -> Result<Paint, SnapshotError> {
    use v1::paint::Kind;
    match paint.kind.ok_or(SnapshotError::Invalid)? {
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
                        color: color_from_proto(stop.color.ok_or(SnapshotError::Invalid)?)?,
                    })
                })
                .collect::<Result<Vec<_>, SnapshotError>>()?,
        )
        .map(Paint::LinearGradient)
        .map_err(|_| SnapshotError::Invalid),
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
fn color_from_proto(color: v1::Color) -> Result<Color, SnapshotError> {
    let space = match v1::ColorSpace::try_from(color.space).map_err(|_| SnapshotError::Invalid)? {
        v1::ColorSpace::Srgb => ColorSpace::Srgb,
        v1::ColorSpace::DisplayP3 => ColorSpace::DisplayP3,
        v1::ColorSpace::LinearSrgb => ColorSpace::LinearSrgb,
        v1::ColorSpace::Unspecified => return Err(SnapshotError::Invalid),
    };
    Color::new(space, [color.red, color.green, color.blue], color.alpha)
        .map_err(|_| SnapshotError::Invalid)
}
fn profile_to_proto(profile: DocumentColorProfile) -> v1::DocumentColorProfile {
    match profile {
        DocumentColorProfile::Srgb => v1::DocumentColorProfile::Srgb,
        DocumentColorProfile::DisplayP3 => v1::DocumentColorProfile::DisplayP3,
    }
}
fn profile_from_proto(value: i32) -> Result<DocumentColorProfile, SnapshotError> {
    match v1::DocumentColorProfile::try_from(value).map_err(|_| SnapshotError::Invalid)? {
        v1::DocumentColorProfile::Srgb => Ok(DocumentColorProfile::Srgb),
        v1::DocumentColorProfile::DisplayP3 => Ok(DocumentColorProfile::DisplayP3),
        v1::DocumentColorProfile::Unspecified => Err(SnapshotError::Invalid),
    }
}
fn id(value: &[u8]) -> Result<u128, SnapshotError> {
    Ok(u128::from_be_bytes(
        value.try_into().map_err(|_| SnapshotError::Invalid)?,
    ))
}
fn id_to_bytes(value: u128) -> Vec<u8> {
    value.to_be_bytes().to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use editor_core::{
        AssetId, AssetReference, DEFAULT_PAGE_ID, DropShadow, Effect, NodeKind, Page, PageId,
        ParagraphStyle, TextAlign, TextAutoSize, TextProperties, TextStyleRun, color::Color,
        geometry::AffineTransform,
    };

    fn node(id: u128, kind: NodeKind, parent_id: Option<NodeId>) -> Node {
        Node {
            id: NodeId(id),
            parent_id,
            position: PositionId::for_node(NodeId(id)),
            name: format!("Node {id}"),
            kind,
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 80.0,
            rotation: 0.0,
            fill: "#fff".into(),
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
            blend_mode: editor_core::BlendMode::Normal,
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
            extensions: Default::default(),
        }
    }

    #[test]
    fn wire_snapshot_round_trips_canonical_document() {
        let mut document = Document::with_id(DocumentId(9));
        document
            .seed_node_on_page(
                DEFAULT_PAGE_ID,
                Node {
                    id: NodeId(7),
                    parent_id: None,
                    position: PositionId::for_node(NodeId(7)),
                    name: "Card".into(),
                    kind: NodeKind::Frame,
                    x: 0.0,
                    y: 0.0,
                    width: 100.0,
                    height: 80.0,
                    rotation: 0.0,
                    fill: Paint::Solid(Color::from_srgb_u8([20, 30, 40], 255)),
                    stroke: Paint::Solid(Color::from_srgb_u8([0, 0, 0], 0)),
                    fills: vec![Paint::Solid(Color::from_srgb_u8([100, 120, 140], 255))],
                    strokes: vec![Paint::Solid(Color::from_srgb_u8([20, 30, 40], 255))],
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
                        a: 0.0,
                        b: 1.0,
                        c: -1.0,
                        d: 0.0,
                        e: 20.0,
                        f: 30.0,
                    }),
                    opacity: 1.0,
                    blend_mode: editor_core::BlendMode::Normal,
                    drop_shadow: Some(DropShadow {
                        offset_x: 3.0,
                        offset_y: 5.0,
                        blur_radius: 9.0,
                        spread: 1.0,
                        color: Color::from_srgb_u8([15, 23, 42], 96),
                        visible: true,
                    }),
                    effect_stack: vec![Effect::DropShadow(DropShadow {
                        offset_x: 3.0,
                        offset_y: 5.0,
                        blur_radius: 9.0,
                        spread: 1.0,
                        color: Color::from_srgb_u8([15, 23, 42], 96),
                        visible: true,
                    })],
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
        document
            .seed_node_on_page(
                DEFAULT_PAGE_ID,
                Node {
                    id: NodeId(8),
                    parent_id: Some(NodeId(7)),
                    position: PositionId::for_node(NodeId(8)),
                    name: "Nested frame".into(),
                    kind: NodeKind::Frame,
                    x: 8.0,
                    y: 8.0,
                    width: 80.0,
                    height: 60.0,
                    rotation: 0.0,
                    fill: Paint::Solid(Color::from_srgb_u8([230, 237, 255], 255)),
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
                    blend_mode: editor_core::BlendMode::Normal,
                    drop_shadow: None,
                    effect_stack: Vec::new(),
                    corner_radius: 4.0,
                    corner_radii: vec![],
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
            .seed_image_node_on_page(
                DEFAULT_PAGE_ID,
                Node {
                    id: NodeId(10),
                    parent_id: Some(NodeId(7)),
                    position: PositionId::for_node(NodeId(10)),
                    name: "Image".into(),
                    kind: NodeKind::Image,
                    x: 16.0,
                    y: 16.0,
                    width: 32.0,
                    height: 32.0,
                    rotation: 0.0,
                    fill: Paint::Solid(Color::from_srgb_u8([255, 255, 255], 255)),
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
                    blend_mode: editor_core::BlendMode::Normal,
                    drop_shadow: None,
                    effect_stack: Vec::new(),
                    corner_radius: 0.0,
                    corner_radii: vec![],
                    corner_smoothing: 0.0,
                    constraints: None,
                    text: String::new(),
                    visible: true,
                    locked: false,
                    contents_hidden: false,
                    clips_content: false,
                    extensions: std::collections::BTreeMap::new(),
                },
                AssetId(42),
            )
            .unwrap();
        document
            .seed_page(Page {
                id: PageId(9),
                name: "Ideas".into(),
                position: PositionId::for_node(NodeId(9)),
            })
            .unwrap();
        document
            .seed_node_on_page(
                PageId(9),
                Node {
                    id: NodeId(11),
                    parent_id: None,
                    position: PositionId::for_node(NodeId(11)),
                    name: "Heading".into(),
                    kind: NodeKind::Text,
                    x: 0.0,
                    y: 0.0,
                    width: 100.0,
                    height: 32.0,
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
                    relative_transform: None,
                    opacity: 1.0,
                    blend_mode: editor_core::BlendMode::Normal,
                    drop_shadow: None,
                    effect_stack: Vec::new(),
                    corner_radius: 0.0,
                    corner_radii: vec![],
                    corner_smoothing: 0.0,
                    constraints: None,
                    text: "Phase one".into(),
                    visible: true,
                    locked: false,
                    contents_hidden: false,
                    clips_content: false,
                    extensions: std::collections::BTreeMap::new(),
                },
            )
            .unwrap();
        document
            .seed_text_properties(
                NodeId(11),
                TextProperties {
                    runs: vec![TextStyleRun {
                        start: 0,
                        end: 9,
                        font: None,
                        font_size: 16.0,
                        font_weight: 500,
                        italic: false,
                        letter_spacing: 0.0,
                        color: None,
                    }],
                    paragraph: ParagraphStyle {
                        alignment: TextAlign::Left,
                        line_height: Some(20.0),
                        paragraph_spacing: 0.0,
                    },
                    auto_size: TextAutoSize::Height,
                    fallback_fonts: vec![],
                },
            )
            .unwrap();
        let auto_layout = AutoLayout {
            mode: LayoutMode::Horizontal,
            padding: [10.0, 12.0, 14.0, 16.0],
            item_spacing: 8.0,
            track_spacing: Some(11.0),
            track_alignment: WrapTrackAlignment::SpaceBetween,
            wrap: true,
            primary_alignment: LayoutAlignment::SpaceBetween,
            counter_alignment: LayoutAlignment::Baseline,
            ..AutoLayout::default()
        };
        document
            .seed_auto_layout(NodeId(7), auto_layout.clone())
            .unwrap();
        let snapshot = snapshot_from_document(&document, 3).unwrap();
        let restored = document_from_wire_snapshot(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), document.canonical_hash());
        assert_eq!(
            restored.node(NodeId(7)).unwrap().corner_radii,
            vec![4.0, 8.0, 12.0, 16.0]
        );
        assert_eq!(restored.node(NodeId(7)).unwrap().fills.len(), 1);
        assert_eq!(restored.node(NodeId(7)).unwrap().strokes.len(), 1);
        assert_eq!(restored.pages().count(), 2);
        assert_eq!(restored.node(NodeId(8)).unwrap().parent_id, Some(NodeId(7)));
        assert_eq!(
            restored.node(NodeId(7)).unwrap().relative_transform,
            Some(AffineTransform {
                a: 0.0,
                b: 1.0,
                c: -1.0,
                d: 0.0,
                e: 20.0,
                f: 30.0
            })
        );
        assert_eq!(
            restored
                .node(NodeId(7))
                .unwrap()
                .drop_shadow
                .unwrap()
                .blur_radius,
            9.0
        );
        assert_eq!(restored.node(NodeId(7)).unwrap().effect_stack.len(), 1);
        assert_eq!(restored.auto_layout_for_node(NodeId(7)), auto_layout);
        assert_eq!(restored.asset_for_node(NodeId(10)), Some(AssetId(42)));
        assert_eq!(
            restored
                .text_properties_for_node(NodeId(11))
                .unwrap()
                .runs
                .len(),
            1
        );
    }

    #[test]
    fn wire_snapshot_round_trips_a_live_boolean_operation_selector() {
        let mut document = Document::with_id(DocumentId(41));
        let mut boolean = node(7, NodeKind::BooleanOperation, None);
        boolean.boolean_operation = Some(BooleanOperation::Exclude);
        document
            .seed_node_on_page(DEFAULT_PAGE_ID, boolean)
            .unwrap();

        let restored =
            document_from_wire_snapshot(&snapshot_from_document(&document, 1).unwrap()).unwrap();
        assert_eq!(
            restored
                .node(NodeId(7))
                .and_then(|node| node.boolean_operation),
            Some(BooleanOperation::Exclude),
        );
    }

    #[test]
    fn wire_snapshot_round_trips_a_non_painting_slice() {
        let mut document = Document::with_id(DocumentId(42));
        let mut slice = node(7, NodeKind::Slice, None);
        slice.name = "Export area".into();
        slice.fill = "#00000000".into();
        slice.stroke = "#00000000".into();
        slice.stroke_align = StrokeAlign::Inside;
        slice.rotation = 15.0;
        document.seed_node_on_page(DEFAULT_PAGE_ID, slice).unwrap();

        let snapshot = snapshot_from_document(&document, 1).unwrap();
        let restored = document_from_wire_snapshot(&snapshot).unwrap();
        assert_eq!(restored.node(NodeId(7)).unwrap().kind, NodeKind::Slice);
        assert_eq!(restored.node(NodeId(7)).unwrap().rotation, 15.0);
        assert_eq!(restored.canonical_hash(), document.canonical_hash());
    }

    #[test]
    fn g_01_nested_group_snapshot_parent_order() {
        let mut document = Document::with_id(DocumentId(91));
        // The decreasing IDs intentionally make the stable page-hash ordering
        // place the leaf before its parent Group. Snapshot restoration must not
        // depend on that serialization order.
        document
            .seed_node_on_page(DEFAULT_PAGE_ID, node(300, NodeKind::Group, None))
            .unwrap();
        document
            .seed_node_on_page(
                DEFAULT_PAGE_ID,
                node(200, NodeKind::Group, Some(NodeId(300))),
            )
            .unwrap();
        document
            .seed_node_on_page(
                DEFAULT_PAGE_ID,
                node(100, NodeKind::Rectangle, Some(NodeId(200))),
            )
            .unwrap();

        let snapshot = snapshot_from_document(&document, 1).unwrap();
        let encoded = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        assert_eq!(
            encoded.page_chunks[0]
                .nodes
                .iter()
                .map(|reference| id(&reference.node_id).unwrap())
                .collect::<Vec<_>>(),
            vec![300, 100, 200]
        );

        let restored = document_from_wire_snapshot(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), document.canonical_hash());
        assert_eq!(
            restored.node(NodeId(100)).unwrap().parent_id,
            Some(NodeId(200))
        );
        assert_eq!(
            restored.node(NodeId(200)).unwrap().parent_id,
            Some(NodeId(300))
        );
    }

    /// A node authored by a future engine version carries opaque `extensions`
    /// payloads. P0-2 requires those bytes to survive a snapshot save/restore
    /// round-trip verbatim, and the canonical hash to stay stable once they do.
    #[test]
    fn wire_snapshot_preserves_unknown_node_extensions_byte_for_byte() {
        let mut extensions = std::collections::BTreeMap::new();
        // Two keys, inserted out of order, with non-UTF8 and empty payloads to
        // prove the transport treats them as opaque bytes rather than strings.
        extensions.insert(
            "phase3.autoLayout".to_string(),
            vec![0x00, 0xff, 0x10, 0x42, 0x00],
        );
        extensions.insert("phase3.blend".to_string(), Vec::<u8>::new());

        let mut document = Document::with_id(DocumentId(21));
        document
            .seed_node_on_page(
                DEFAULT_PAGE_ID,
                Node {
                    id: NodeId(7),
                    parent_id: None,
                    position: PositionId::for_node(NodeId(7)),
                    name: "Future".into(),
                    kind: NodeKind::Rectangle,
                    x: 1.0,
                    y: 2.0,
                    width: 100.0,
                    height: 80.0,
                    rotation: 0.0,
                    fill: Paint::Solid(Color::from_srgb_u8([10, 20, 30], 255)),
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
                    blend_mode: editor_core::BlendMode::Normal,
                    drop_shadow: None,
                    effect_stack: Vec::new(),
                    corner_radius: 0.0,
                    corner_radii: vec![],
                    corner_smoothing: 0.0,
                    constraints: None,
                    text: String::new(),
                    visible: true,
                    locked: false,
                    contents_hidden: false,
                    clips_content: false,
                    extensions: extensions.clone(),
                },
            )
            .unwrap();

        let snapshot = snapshot_from_document(&document, 1).unwrap();
        let restored = document_from_wire_snapshot(&snapshot).unwrap();

        // Byte-for-byte preservation of every key and payload.
        assert_eq!(restored.node(NodeId(7)).unwrap().extensions, extensions);
        // The extensions participate in the canonical hash, and a lossless
        // round-trip therefore reproduces it exactly.
        assert_eq!(restored.canonical_hash(), document.canonical_hash());

        // A second round-trip is idempotent: re-encoding the restored document
        // yields the identical wire bytes.
        let snapshot_again = snapshot_from_document(&restored, 1).unwrap();
        assert_eq!(snapshot_again, snapshot);
    }

    /// Empty `extensions` maps must not perturb the canonical hash, so documents
    /// authored before the field existed keep their historical digests.
    #[test]
    fn empty_node_extensions_do_not_change_canonical_hash() {
        fn card(extensions: std::collections::BTreeMap<String, Vec<u8>>) -> Document {
            let mut document = Document::with_id(DocumentId(22));
            document
                .seed_node_on_page(
                    DEFAULT_PAGE_ID,
                    Node {
                        id: NodeId(5),
                        parent_id: None,
                        position: PositionId::for_node(NodeId(5)),
                        name: "Card".into(),
                        kind: NodeKind::Rectangle,
                        x: 0.0,
                        y: 0.0,
                        width: 10.0,
                        height: 10.0,
                        rotation: 0.0,
                        fill: Paint::Solid(Color::from_srgb_u8([1, 2, 3], 255)),
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
                        blend_mode: editor_core::BlendMode::Normal,
                        drop_shadow: None,
                        effect_stack: Vec::new(),
                        corner_radius: 0.0,
                        corner_radii: vec![],
                        corner_smoothing: 0.0,
                        constraints: None,
                        text: String::new(),
                        visible: true,
                        locked: false,
                        contents_hidden: false,
                        clips_content: false,
                        extensions,
                    },
                )
                .unwrap();
            document
        }

        let empty = card(std::collections::BTreeMap::new());
        let mut with_payload_map = std::collections::BTreeMap::new();
        with_payload_map.insert("x".to_string(), vec![1u8]);
        let with_payload = card(with_payload_map);

        // The empty-map document hashes identically to one built before the
        // field existed (both skip the extensions contribution).
        assert_ne!(empty.canonical_hash(), with_payload.canonical_hash());
    }

    #[test]
    fn future_node_kind_is_rejected_as_requires_newer_client_not_corruption() {
        let mut document = Document::with_id(DocumentId(31));
        document
            .seed_node_on_page(
                DEFAULT_PAGE_ID,
                Node {
                    id: NodeId(7),
                    parent_id: None,
                    position: PositionId::for_node(NodeId(7)),
                    name: "Shape".into(),
                    kind: NodeKind::Rectangle,
                    x: 0.0,
                    y: 0.0,
                    width: 10.0,
                    height: 10.0,
                    rotation: 0.0,
                    fill: Paint::Solid(Color::from_srgb_u8([1, 2, 3], 255)),
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
                    blend_mode: editor_core::BlendMode::Normal,
                    drop_shadow: None,
                    effect_stack: Vec::new(),
                    corner_radius: 0.0,
                    corner_radii: vec![],
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
        let snapshot = snapshot_from_document(&document, 1).unwrap();

        // Rewrite the single node's kind to a tag no current engine mints,
        // simulating a Phase 3 NodeKind arriving at an older client.
        let mut decoded = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        let chunk = &mut decoded.page_chunks[0];
        let reference = &mut chunk.nodes[0];
        let mut node = v1::SceneNode::decode(reference.canonical_node.as_slice()).unwrap();
        node.kind = 999; // a positive NodeKind tag no current engine defines
        reference.canonical_node = node.encode_to_vec();
        let future_snapshot = decoded.encode_to_vec();

        // The distinguishable variant lets the client degrade to read-only rather
        // than reporting generic corruption (ADR 0023, P0-3).
        assert_eq!(
            document_from_wire_snapshot(&future_snapshot),
            Err(SnapshotError::UnsupportedFutureNode)
        );
        // A genuinely invalid tag (the reserved UNSPECIFIED zero) stays `Invalid`.
        let mut zero = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        let mut zero_node =
            v1::SceneNode::decode(zero.page_chunks[0].nodes[0].canonical_node.as_slice()).unwrap();
        zero_node.kind = 0;
        zero.page_chunks[0].nodes[0].canonical_node = zero_node.encode_to_vec();
        assert_eq!(
            document_from_wire_snapshot(&zero.encode_to_vec()),
            Err(SnapshotError::Invalid)
        );
    }
}
