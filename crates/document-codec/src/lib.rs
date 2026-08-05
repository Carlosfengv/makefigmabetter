//! Canonical editor-core ↔ durable Protobuf snapshot conversion.
//!
//! This crate deliberately has no database or HTTP dependency so the same
//! validation path can be used by the Rust service and the browser WASM engine.

use editor_core::{
    ActorId, AssetId, AssetReference, Document, DocumentId, FontReference, Node, NodeId, NodeKind,
    Page, PageId, ParagraphStyle, PositionId, TextAlign, TextAutoSize, TextProperties,
    TextStyleRun,
    color::{Color, ColorSpace, DocumentColorProfile, GradientStop, LinearGradient, Paint},
};
use makefigma_protocol::v1;
use prost::Message;
use sha2::Digest;

pub const SNAPSHOT_FORMAT_VERSION: u32 = 1;
pub type Hash = [u8; 32];
pub type Id = [u8; 16];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotError {
    Invalid,
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
    let mut page_hashes = Vec::new();
    for chunk in snapshot.page_chunks {
        if chunk.format_version != SNAPSHOT_FORMAT_VERSION {
            return Err(SnapshotError::Invalid);
        }
        let page = page_from_proto(chunk.page.ok_or(SnapshotError::Invalid)?)?;
        page_hashes.push((page.id, chunk.content_hash));
        if page.id != editor_core::DEFAULT_PAGE_ID {
            document
                .seed_page(page)
                .map_err(|_| SnapshotError::Invalid)?;
        }
        for reference in chunk.nodes {
            let node_proto = v1::SceneNode::decode(reference.canonical_node.as_slice())
                .map_err(|_| SnapshotError::Invalid)?;
            let (page_id, node, asset_id, text_properties) = node_from_proto(node_proto)?;
            if page_id.0 != id(&reference.page_id)?
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
            let node_id = node.id;
            if let Some(asset_id) = asset_id {
                document.seed_image_node_on_page(page_id, node, asset_id)
            } else {
                document.seed_node_on_page(page_id, node)
            }
            .map_err(|_| SnapshotError::Invalid)?;
            if let Some(properties) = text_properties {
                document
                    .seed_text_properties(node_id, properties)
                    .map_err(|_| SnapshotError::Invalid)?;
            }
        }
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
        } as i32,
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        rotation: node.rotation,
        fill: Some(paint_to_proto(&node.fill)),
        stroke: Some(paint_to_proto(&node.stroke)),
        stroke_width: node.stroke_width,
        opacity: node.opacity,
        corner_radius: node.corner_radius,
        text: node.text.clone(),
        visible: node.visible,
        locked: node.locked,
        asset_id: asset_id.map(|id| id_to_bytes(id.0)),
        text_properties: text_properties.map(text_properties_to_proto),
    }
}
fn node_from_proto(
    node: v1::SceneNode,
) -> Result<(PageId, Node, Option<AssetId>, Option<TextProperties>), SnapshotError> {
    let page_id = PageId(id(&node.page_id)?);
    let kind = match v1::NodeKind::try_from(node.kind).map_err(|_| SnapshotError::Invalid)? {
        v1::NodeKind::Frame => NodeKind::Frame,
        v1::NodeKind::Rectangle => NodeKind::Rectangle,
        v1::NodeKind::Ellipse => NodeKind::Ellipse,
        v1::NodeKind::Text => NodeKind::Text,
        v1::NodeKind::Image => NodeKind::Image,
        v1::NodeKind::Unspecified => return Err(SnapshotError::Invalid),
    };
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
            stroke_width: node.stroke_width,
            opacity: node.opacity,
            corner_radius: node.corner_radius,
            text: node.text,
            visible: node.visible,
            locked: node.locked,
        },
        node.asset_id.as_deref().map(id).transpose()?.map(AssetId),
        node.text_properties
            .map(text_properties_from_proto)
            .transpose()?,
    ))
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
        AssetId, AssetReference, DEFAULT_PAGE_ID, NodeKind, Page, PageId, ParagraphStyle,
        TextAlign, TextAutoSize, TextProperties, TextStyleRun, color::Color,
    };

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
                    kind: NodeKind::Rectangle,
                    x: 0.0,
                    y: 0.0,
                    width: 100.0,
                    height: 80.0,
                    rotation: 0.0,
                    fill: Paint::Solid(Color::from_srgb_u8([20, 30, 40], 255)),
                    stroke: Paint::Solid(Color::from_srgb_u8([0, 0, 0], 0)),
                    stroke_width: 0.0,
                    opacity: 1.0,
                    corner_radius: 0.0,
                    text: String::new(),
                    visible: true,
                    locked: false,
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
                    stroke_width: 0.0,
                    opacity: 1.0,
                    corner_radius: 4.0,
                    text: String::new(),
                    visible: true,
                    locked: false,
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
                    stroke_width: 0.0,
                    opacity: 1.0,
                    corner_radius: 0.0,
                    text: String::new(),
                    visible: true,
                    locked: false,
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
                    stroke_width: 0.0,
                    opacity: 1.0,
                    corner_radius: 0.0,
                    text: "Phase one".into(),
                    visible: true,
                    locked: false,
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
        let snapshot = snapshot_from_document(&document, 3).unwrap();
        let restored = document_from_wire_snapshot(&snapshot).unwrap();
        assert_eq!(restored.canonical_hash(), document.canonical_hash());
        assert_eq!(restored.pages().count(), 2);
        assert_eq!(restored.node(NodeId(8)).unwrap().parent_id, Some(NodeId(7)));
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
}
