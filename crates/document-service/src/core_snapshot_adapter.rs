//! Protobuf snapshot ↔ canonical editor-core adapter used only by Document Service.

use editor_core::{
    ActorId, AssetId, AssetReference, Document, DocumentId, FontReference, Node, NodeId, NodeKind,
    Page, PageId, ParagraphStyle, PositionId, TextAlign, TextAutoSize, TextProperties,
    TextStyleRun,
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
            let (page_id, node, asset_id, text_properties) = node_from_proto(node_proto)?;
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
) -> Result<(PageId, Node, Option<AssetId>, Option<TextProperties>), ServiceError> {
    let page_id = PageId(id(&node.page_id)?);
    let kind = match v1::NodeKind::try_from(node.kind).map_err(|_| ServiceError::ReducerRejected)? {
        v1::NodeKind::Frame => NodeKind::Frame,
        v1::NodeKind::Rectangle => NodeKind::Rectangle,
        v1::NodeKind::Ellipse => NodeKind::Ellipse,
        v1::NodeKind::Text => NodeKind::Text,
        v1::NodeKind::Image => NodeKind::Image,
        v1::NodeKind::Unspecified => return Err(ServiceError::ReducerRejected),
    };
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
        AssetId, AssetReference, DEFAULT_PAGE_ID, Document, DocumentId, Node, NodeId, NodeKind,
        PositionId, color::Color,
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
        let snapshot = snapshot_from_document(&document, 3).unwrap();
        let expected_document_id = 9_u128.to_be_bytes();
        let restored =
            document_from_snapshot(&snapshot, expected_document_id, document.canonical_hash())
                .unwrap();
        assert_eq!(restored.canonical_hash(), document.canonical_hash());
        assert_eq!(restored.asset(AssetId(42)).unwrap().media_type, "image/png");
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

        let create_page = |page_id: u128, name: &str| {
            v1::ResolvedOperationBatch {
                operations: vec![v1::ResolvedOperation {
                    kind: Some(v1::resolved_operation::Kind::CreatePage(v1::CreatePage {
                        page: Some(v1::PageRef {
                            page_id: page_id.to_be_bytes().to_vec(),
                            name: name.into(),
                            position_id: Some(v1::PositionId {
                                key: page_id.to_be_bytes().to_vec(),
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
                .submit(principal, &envelope(100, 0, create_page(2, "Ideas")))
                .unwrap()
                .accepted_revision,
            1
        );
        assert_eq!(
            service
                .submit(principal, &envelope(101, 1, create_page(3, "Ship")))
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
    }
}
