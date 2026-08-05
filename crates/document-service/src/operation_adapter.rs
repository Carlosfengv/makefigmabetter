//! Converts generated protobuf operation payloads into the canonical reducer input.
//! This is the only service-side location allowed to know both protocol and core.

use editor_core::{
    ActorId, Appearance, AssetId, AssetReference, Command, FontReference, Node, NodeId, NodeKind,
    Page, PageId, ParagraphStyle, PositionId, TextAlign, TextAutoSize, TextProperties,
    TextStyleRun,
    color::{Color, ColorSpace, DocumentColorProfile, GradientStop, LinearGradient, Paint},
};
use makefigma_protocol::v1;
use prost::Message;

use crate::ServiceError;

pub fn commands_from_payload(payload: &[u8]) -> Result<Vec<Command>, ServiceError> {
    let batch =
        v1::ResolvedOperationBatch::decode(payload).map_err(|_| ServiceError::InvalidEnvelope)?;
    if batch.operations.is_empty() {
        return Err(ServiceError::InvalidEnvelope);
    }
    batch
        .operations
        .into_iter()
        .map(command_from_proto)
        .collect()
}

fn command_from_proto(operation: v1::ResolvedOperation) -> Result<Command, ServiceError> {
    use v1::resolved_operation::Kind;
    match operation.kind.ok_or(ServiceError::InvalidEnvelope)? {
        Kind::CreatePage(value) => Ok(Command::CreatePage(page_from_proto(
            value.page.ok_or(ServiceError::InvalidEnvelope)?,
        )?)),
        Kind::CreateNode(value) => {
            let (page_id, node, asset_id) =
                node_from_proto(value.node.ok_or(ServiceError::InvalidEnvelope)?)?;
            if let Some(asset_id) = asset_id {
                Ok(Command::CreateImageInPage {
                    page_id,
                    node,
                    asset_id,
                })
            } else {
                Ok(Command::CreateInPage { page_id, node })
            }
        }
        Kind::RestoreNode(value) => {
            let (page_id, node, asset_id, text_properties) =
                restored_node_from_proto(value.node.ok_or(ServiceError::InvalidEnvelope)?)?;
            Ok(Command::RestoreNode {
                page_id,
                node,
                asset_id,
                text_properties,
            })
        }
        Kind::UpdateGeometry(value) => Ok(Command::UpdateGeometry {
            id: node_id(&value.node_id)?,
            x: value.x,
            y: value.y,
            width: value.width,
            height: value.height,
            rotation: value.rotation,
        }),
        Kind::RenameNode(value) => Ok(Command::Rename {
            id: node_id(&value.node_id)?,
            name: value.name,
        }),
        Kind::SetAppearance(value) => Ok(Command::SetAppearance {
            id: node_id(&value.node_id)?,
            appearance: Appearance {
                fill: paint_from_proto(value.fill.ok_or(ServiceError::InvalidEnvelope)?)?,
                stroke: paint_from_proto(value.stroke.ok_or(ServiceError::InvalidEnvelope)?)?,
                stroke_width: value.stroke_width,
                opacity: value.opacity,
                corner_radius: value.corner_radius,
                visible: value.visible,
                locked: value.locked,
            },
        }),
        Kind::SetImageFill(value) => Ok(Command::SetNodeAsset {
            id: node_id(&value.node_id)?,
            asset_id: value.asset_id.as_deref().map(id).transpose()?.map(AssetId),
        }),
        Kind::SetText(value) => Ok(Command::SetText {
            id: node_id(&value.node_id)?,
            text: value.text,
        }),
        Kind::SetTextProperties(value) => Ok(Command::SetTextProperties {
            id: node_id(&value.node_id)?,
            properties: text_properties_from_proto(
                value.properties.ok_or(ServiceError::InvalidEnvelope)?,
            )?,
        }),
        Kind::SetNodePosition(value) => Ok(Command::SetNodePosition {
            id: node_id(&value.node_id)?,
            position: position_from_proto(value.position_id.ok_or(ServiceError::InvalidEnvelope)?)?,
        }),
        Kind::SetDocumentColorProfile(value) => Ok(Command::SetDocumentColorProfile {
            profile: profile_from_proto(value.profile)?,
        }),
        Kind::DeleteNode(value) => Ok(Command::Delete {
            id: node_id(&value.node_id)?,
        }),
        Kind::RegisterResource(value) => Ok(Command::RegisterAsset {
            asset: asset_from_proto(value.resource.ok_or(ServiceError::InvalidEnvelope)?)?,
        }),
    }
}

fn page_from_proto(page: v1::PageRef) -> Result<Page, ServiceError> {
    Ok(Page {
        id: PageId(id(&page.page_id)?),
        name: page.name,
        position: position_from_proto(page.position_id.ok_or(ServiceError::InvalidEnvelope)?)?,
    })
}

fn node_from_proto(node: v1::SceneNode) -> Result<(PageId, Node, Option<AssetId>), ServiceError> {
    let (page_id, node, asset_id, text_properties) = restored_node_from_proto(node)?;
    if text_properties.is_some() {
        // Rich-text node creation is represented as CreateNode followed by the
        // explicit SetTextProperties operation, so it is an independently
        // hashable and replayable reducer action.
        return Err(ServiceError::InvalidEnvelope);
    }
    Ok((page_id, node, asset_id))
}

/// `RestoreNode` carries every property needed to reconstruct a tombstone in a
/// persisted service snapshot. `CreateNode` continues to keep rich text in its
/// separately hashable SetTextProperties operation.
fn restored_node_from_proto(
    node: v1::SceneNode,
) -> Result<(PageId, Node, Option<AssetId>, Option<TextProperties>), ServiceError> {
    let text_properties = node.text_properties.map(text_properties_from_proto).transpose()?;
    let page_id = PageId(id(&node.page_id)?);
    let kind = match v1::NodeKind::try_from(node.kind).map_err(|_| ServiceError::InvalidEnvelope)? {
        v1::NodeKind::Frame => NodeKind::Frame,
        v1::NodeKind::Rectangle => NodeKind::Rectangle,
        v1::NodeKind::Ellipse => NodeKind::Ellipse,
        v1::NodeKind::Text => NodeKind::Text,
        v1::NodeKind::Image => NodeKind::Image,
        v1::NodeKind::Unspecified => return Err(ServiceError::InvalidEnvelope),
    };
    let parent_id = node.parent_id.as_deref().map(node_id).transpose()?;
    Ok((
        page_id,
        Node {
            id: node_id(&node.node_id)?,
            parent_id,
            position: position_from_proto(node.position_id.ok_or(ServiceError::InvalidEnvelope)?)?,
            name: node.name,
            kind,
            x: node.x,
            y: node.y,
            width: node.width,
            height: node.height,
            rotation: node.rotation,
            fill: paint_from_proto(node.fill.ok_or(ServiceError::InvalidEnvelope)?)?,
            stroke: paint_from_proto(node.stroke.ok_or(ServiceError::InvalidEnvelope)?)?,
            stroke_width: node.stroke_width,
            opacity: node.opacity,
            corner_radius: node.corner_radius,
            text: node.text,
            visible: node.visible,
            locked: node.locked,
        },
        node.asset_id.as_deref().map(id).transpose()?.map(AssetId),
        text_properties,
    ))
}

fn font_from_proto(font: v1::FontReference) -> Result<FontReference, ServiceError> {
    let mut variation_axes = std::collections::BTreeMap::new();
    for axis in font.variation_axes {
        if variation_axes
            .insert(axis.tag.clone(), axis.value)
            .is_some()
        {
            return Err(ServiceError::InvalidEnvelope);
        }
    }
    Ok(FontReference {
        asset_id: AssetId(id(&font.asset_id)?),
        face_index: font.face_index,
        variation_axes,
    })
}

fn text_properties_from_proto(value: v1::TextProperties) -> Result<TextProperties, ServiceError> {
    let paragraph = value.paragraph.ok_or(ServiceError::InvalidEnvelope)?;
    let alignment = match v1::TextAlignment::try_from(paragraph.alignment)
        .map_err(|_| ServiceError::InvalidEnvelope)?
    {
        v1::TextAlignment::Left => TextAlign::Left,
        v1::TextAlignment::Center => TextAlign::Center,
        v1::TextAlignment::Right => TextAlign::Right,
        v1::TextAlignment::Justify => TextAlign::Justify,
        v1::TextAlignment::Unspecified => return Err(ServiceError::InvalidEnvelope),
    };
    let auto_size = match v1::TextAutoSize::try_from(value.auto_size)
        .map_err(|_| ServiceError::InvalidEnvelope)?
    {
        v1::TextAutoSize::Fixed => TextAutoSize::Fixed,
        v1::TextAutoSize::Height => TextAutoSize::Height,
        v1::TextAutoSize::WidthAndHeight => TextAutoSize::WidthAndHeight,
        v1::TextAutoSize::Unspecified => return Err(ServiceError::InvalidEnvelope),
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
                        .map_err(|_| ServiceError::InvalidEnvelope)?,
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

fn paint_from_proto(paint: v1::Paint) -> Result<Paint, ServiceError> {
    use v1::paint::Kind;
    match paint.kind.ok_or(ServiceError::InvalidEnvelope)? {
        Kind::Solid(color) => Ok(Paint::Solid(color_from_proto(color)?)),
        Kind::LinearGradient(gradient) => {
            let stops = gradient
                .stops
                .into_iter()
                .map(|stop| {
                    Ok(GradientStop {
                        position: stop.position,
                        color: color_from_proto(stop.color.ok_or(ServiceError::InvalidEnvelope)?)?,
                    })
                })
                .collect::<Result<Vec<_>, ServiceError>>()?;
            LinearGradient::new(
                [gradient.start_x, gradient.start_y],
                [gradient.end_x, gradient.end_y],
                stops,
            )
            .map(Paint::LinearGradient)
            .map_err(|_| ServiceError::InvalidEnvelope)
        }
    }
}

fn color_from_proto(color: v1::Color) -> Result<Color, ServiceError> {
    let space =
        match v1::ColorSpace::try_from(color.space).map_err(|_| ServiceError::InvalidEnvelope)? {
            v1::ColorSpace::Srgb => ColorSpace::Srgb,
            v1::ColorSpace::DisplayP3 => ColorSpace::DisplayP3,
            v1::ColorSpace::LinearSrgb => ColorSpace::LinearSrgb,
            v1::ColorSpace::Unspecified => return Err(ServiceError::InvalidEnvelope),
        };
    Color::new(space, [color.red, color.green, color.blue], color.alpha)
        .map_err(|_| ServiceError::InvalidEnvelope)
}

fn profile_from_proto(value: i32) -> Result<DocumentColorProfile, ServiceError> {
    match v1::DocumentColorProfile::try_from(value).map_err(|_| ServiceError::InvalidEnvelope)? {
        v1::DocumentColorProfile::Srgb => Ok(DocumentColorProfile::Srgb),
        v1::DocumentColorProfile::DisplayP3 => Ok(DocumentColorProfile::DisplayP3),
        v1::DocumentColorProfile::Unspecified => Err(ServiceError::InvalidEnvelope),
    }
}

fn position_from_proto(position: v1::PositionId) -> Result<PositionId, ServiceError> {
    Ok(PositionId {
        key: id(&position.key)?,
        actor: ActorId(id(&position.actor_id)?),
    })
}

fn node_id(value: &[u8]) -> Result<NodeId, ServiceError> {
    Ok(NodeId(id(value)?))
}

fn asset_from_proto(asset: v1::ResourceIndexEntry) -> Result<AssetReference, ServiceError> {
    let content_hash: [u8; 32] = asset
        .content_hash
        .try_into()
        .map_err(|_| ServiceError::InvalidEnvelope)?;
    let dimensions = match (asset.pixel_width, asset.pixel_height) {
        (None, None) => None,
        (Some(width), Some(height)) => Some([width, height]),
        _ => return Err(ServiceError::InvalidEnvelope),
    };
    Ok(AssetReference {
        asset_id: AssetId(id(&asset.asset_id)?),
        content_hash,
        media_type: asset.media_type,
        byte_length: asset.byte_length.ok_or(ServiceError::InvalidEnvelope)?,
        dimensions,
    })
}

fn id(value: &[u8]) -> Result<u128, ServiceError> {
    let bytes: [u8; 16] = value
        .try_into()
        .map_err(|_| ServiceError::InvalidEnvelope)?;
    Ok(u128::from_be_bytes(bytes))
}

#[cfg(test)]
mod tests {
    use editor_core::{DEFAULT_PAGE_ID, Document, Origin, Transaction, TransactionId};
    use makefigma_protocol::v1;
    use prost::Message;

    use super::commands_from_payload;

    fn color() -> v1::Color {
        v1::Color {
            space: v1::ColorSpace::Srgb as i32,
            red: 0.2,
            green: 0.4,
            blue: 0.6,
            alpha: 1.0,
        }
    }

    fn paint() -> v1::Paint {
        v1::Paint {
            kind: Some(v1::paint::Kind::Solid(color())),
        }
    }

    #[test]
    fn generated_batch_maps_to_the_same_core_reducer_boundary() {
        let node = v1::SceneNode {
            node_id: 7_u128.to_be_bytes().to_vec(),
            parent_id: None,
            page_id: 1_u128.to_be_bytes().to_vec(),
            position_id: Some(v1::PositionId {
                key: 7_u128.to_be_bytes().to_vec(),
                actor_id: 0_u128.to_be_bytes().to_vec(),
            }),
            name: "Protocol card".into(),
            kind: v1::NodeKind::Rectangle as i32,
            asset_id: None,
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 80.0,
            rotation: 0.0,
            fill: Some(paint()),
            stroke: Some(paint()),
            stroke_width: 0.0,
            opacity: 1.0,
            corner_radius: 0.0,
            text: String::new(),
            visible: true,
            locked: false,
            text_properties: None,
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::CreateNode(v1::CreateNode {
                    node: Some(node),
                })),
            }],
        }
        .encode_to_vec();
        let commands = commands_from_payload(&payload).unwrap();
        let mut document = Document::empty();
        document
            .submit(
                Transaction {
                    id: TransactionId(1),
                    base_revision: 0,
                    commands,
                },
                Origin::RemoteOperation,
            )
            .unwrap();
        assert_eq!(
            document.page_for_node(editor_core::NodeId(7)),
            Some(DEFAULT_PAGE_ID)
        );
    }

    #[test]
    fn resource_registration_maps_to_a_canonical_byte_free_asset_reference() {
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::RegisterResource(
                    v1::RegisterResource {
                        resource: Some(v1::ResourceIndexEntry {
                            asset_id: 9_u128.to_be_bytes().to_vec(),
                            content_hash: vec![4; 32],
                            media_type: "image/png".into(),
                            byte_length: Some(128),
                            pixel_width: Some(16),
                            pixel_height: Some(8),
                        }),
                    },
                )),
            }],
        }
        .encode_to_vec();
        let commands = commands_from_payload(&payload).unwrap();
        let mut document = Document::empty();
        document
            .submit(
                Transaction {
                    id: TransactionId(2),
                    base_revision: 0,
                    commands,
                },
                Origin::RemoteOperation,
            )
            .unwrap();
        assert_eq!(
            document.asset(editor_core::AssetId(9)).unwrap().dimensions,
            Some([16, 8])
        );
    }
}
