//! Converts generated protobuf operation payloads into the canonical reducer input.
//! This is the only service-side location allowed to know both protocol and core.

use editor_core::{
    ActorId, Appearance, ArcData, AssetId, AssetReference, AutoLayout, BackgroundBlur, BlendMode,
    BooleanOperation, Command, ConstraintType, Constraints, DropShadow, Effect, FillRule,
    FontReference, InnerShadow, LayerBlur, LayoutAlignment, LayoutMode, LayoutSizing, Node, NodeId,
    NodeKind, Page, PageId, ParagraphStyle, ParametricShape, PointId, PositionId, StrokeAlign,
    StrokeCap, StrokeJoin, TextAlign, TextAutoSize, TextProperties, TextStyleRun, VectorPath,
    VectorPoint, VectorPointType, VectorSubpath, WrapTrackAlignment,
    color::{Color, ColorSpace, DocumentColorProfile, GradientStop, LinearGradient, Paint},
    geometry::Point,
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
                fills: value
                    .fills
                    .into_iter()
                    .map(paint_from_proto)
                    .collect::<Result<Vec<_>, _>>()?,
                strokes: value
                    .strokes
                    .into_iter()
                    .map(paint_from_proto)
                    .collect::<Result<Vec<_>, _>>()?,
                stroke_width: value.stroke_width,
                stroke_cap_start: stroke_cap_from_proto(value.stroke_cap_start)?,
                stroke_cap_end: stroke_cap_from_proto(value.stroke_cap_end)?,
                stroke_join: stroke_join_from_proto(value.stroke_join)?,
                stroke_miter_limit: if value.stroke_miter_limit == 0.0 {
                    10.0
                } else {
                    value.stroke_miter_limit
                },
                stroke_dash_pattern: value.stroke_dash_pattern,
                stroke_weights: value.stroke_weights,
                stroke_align: stroke_align_from_proto(value.stroke_align)?,
                arc_data: value.arc_data.map(arc_from_proto).transpose()?,
                parametric_shape: parametric_shape_from_proto(
                    value.polygon_parameters,
                    value.star_parameters,
                )?,
                relative_transform: value
                    .relative_transform
                    .map(transform_from_proto)
                    .transpose()?,
                opacity: value.opacity,
                blend_mode: blend_mode_from_proto(value.blend_mode)?,
                drop_shadow: value.drop_shadow.map(drop_shadow_from_proto).transpose()?,
                effect_stack: value
                    .effect_stack
                    .into_iter()
                    .map(effect_from_proto)
                    .collect::<Result<Vec<_>, _>>()?,
                corner_radius: value.corner_radius,
                corner_radii: value.corner_radii,
                corner_smoothing: value.corner_smoothing,
                constraints: value.constraints.map(constraints_from_proto).transpose()?,
                visible: value.visible,
                locked: value.locked,
                contents_hidden: value.contents_hidden,
                clips_content: value.clips_content,
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
        Kind::SetNodeParent(value) => Ok(Command::SetNodeParent {
            id: node_id(&value.node_id)?,
            parent_id: value.parent_id.as_deref().map(node_id).transpose()?,
            position: position_from_proto(value.position_id.ok_or(ServiceError::InvalidEnvelope)?)?,
        }),
        Kind::SetVectorPath(value) => Ok(Command::SetVectorPath {
            id: node_id(&value.node_id)?,
            path: vector_path_from_proto(value.vector_path.ok_or(ServiceError::InvalidEnvelope)?)?,
        }),
        Kind::MoveVectorPoint(value) => Ok(Command::MoveVectorPoint {
            id: node_id(&value.node_id)?,
            point_id: PointId(id(&value.point_id)?),
            position: Point::new(value.x, value.y).map_err(|_| ServiceError::InvalidEnvelope)?,
        }),
        Kind::SetVectorSubpathClosed(value) => Ok(Command::SetVectorSubpathClosed {
            id: node_id(&value.node_id)?,
            subpath_index: value.subpath_index,
            closed: value.closed,
        }),
        Kind::InsertVectorPoint(value) => {
            let point = value.point.ok_or(ServiceError::InvalidEnvelope)?;
            let point_type = match v1::VectorPointType::try_from(point.point_type)
                .map_err(|_| ServiceError::InvalidEnvelope)?
            {
                v1::VectorPointType::Corner => VectorPointType::Corner,
                v1::VectorPointType::Mirrored => VectorPointType::Mirrored,
                v1::VectorPointType::Asymmetric => VectorPointType::Asymmetric,
                v1::VectorPointType::Unspecified => return Err(ServiceError::InvalidEnvelope),
            };
            let handle_in = match (point.handle_in_x, point.handle_in_y) {
                (None, None) => None,
                (Some(x), Some(y)) => {
                    Some(Point::new(x, y).map_err(|_| ServiceError::InvalidEnvelope)?)
                }
                _ => return Err(ServiceError::InvalidEnvelope),
            };
            let handle_out = match (point.handle_out_x, point.handle_out_y) {
                (None, None) => None,
                (Some(x), Some(y)) => {
                    Some(Point::new(x, y).map_err(|_| ServiceError::InvalidEnvelope)?)
                }
                _ => return Err(ServiceError::InvalidEnvelope),
            };
            Ok(Command::InsertVectorPoint {
                id: node_id(&value.node_id)?,
                subpath_index: value.subpath_index,
                after_point_id: value
                    .after_point_id
                    .as_deref()
                    .map(id)
                    .transpose()?
                    .map(PointId),
                point: VectorPoint {
                    id: PointId(id(&point.point_id)?),
                    position: Point::new(point.x, point.y)
                        .map_err(|_| ServiceError::InvalidEnvelope)?,
                    handle_in,
                    handle_out,
                    point_type,
                },
            })
        }
        Kind::DeleteVectorPoint(value) => Ok(Command::DeleteVectorPoint {
            id: node_id(&value.node_id)?,
            point_id: PointId(id(&value.point_id)?),
        }),
        Kind::SetVectorPointHandles(value) => {
            let point_type = match v1::VectorPointType::try_from(value.point_type)
                .map_err(|_| ServiceError::InvalidEnvelope)?
            {
                v1::VectorPointType::Corner => VectorPointType::Corner,
                v1::VectorPointType::Mirrored => VectorPointType::Mirrored,
                v1::VectorPointType::Asymmetric => VectorPointType::Asymmetric,
                v1::VectorPointType::Unspecified => return Err(ServiceError::InvalidEnvelope),
            };
            let handle = |x: Option<f64>, y: Option<f64>| match (x, y) {
                (None, None) => Ok(None),
                (Some(x), Some(y)) => Point::new(x, y)
                    .map(Some)
                    .map_err(|_| ServiceError::InvalidEnvelope),
                _ => Err(ServiceError::InvalidEnvelope),
            };
            Ok(Command::SetVectorPointHandles {
                id: node_id(&value.node_id)?,
                point_id: PointId(id(&value.point_id)?),
                handle_in: handle(value.handle_in_x, value.handle_in_y)?,
                handle_out: handle(value.handle_out_x, value.handle_out_y)?,
                point_type,
            })
        }
        Kind::SetBooleanOperation(value) => Ok(Command::SetBooleanOperation {
            id: node_id(&value.node_id)?,
            operation: boolean_operation_from_proto(value.operation)?,
        }),
        Kind::SetMask(value) => Ok(Command::SetMask {
            id: node_id(&value.node_id)?,
            enabled: value.enabled,
        }),
        Kind::SetNodeExtensions(value) => Ok(Command::SetNodeExtensions {
            id: node_id(&value.node_id)?,
            extensions: value.extensions.into_iter().collect(),
        }),
        Kind::SetAutoLayout(value) => Ok(Command::SetAutoLayout {
            id: node_id(&value.node_id)?,
            layout: auto_layout_from_proto(
                value.auto_layout.ok_or(ServiceError::InvalidEnvelope)?,
            )?,
        }),
        Kind::SplitVectorSegment(value) => Ok(Command::SplitVectorSegment {
            id: node_id(&value.node_id)?,
            subpath_index: value.subpath_index,
            after_point_id: PointId(id(&value.after_point_id)?),
            t: value.t,
            point_id: PointId(id(&value.point_id)?),
        }),
        Kind::ConnectVectorEndpoints(value) => Ok(Command::ConnectVectorEndpoints {
            id: node_id(&value.node_id)?,
            first_subpath_index: value.first_subpath_index,
            first_point_id: PointId(id(&value.first_point_id)?),
            second_subpath_index: value.second_subpath_index,
            second_point_id: PointId(id(&value.second_point_id)?),
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
    let text_properties = node
        .text_properties
        .map(text_properties_from_proto)
        .transpose()?;
    let page_id = PageId(id(&node.page_id)?);
    let kind = match v1::NodeKind::try_from(node.kind).map_err(|_| ServiceError::InvalidEnvelope)? {
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
        v1::NodeKind::Unspecified => return Err(ServiceError::InvalidEnvelope),
    };
    let clips_content = node.clips_content.unwrap_or(matches!(
        kind,
        NodeKind::Frame
            | NodeKind::Component
            | NodeKind::Instance
            | NodeKind::Slot
            | NodeKind::ComponentSet
    ));
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
            drop_shadow: node.drop_shadow.map(drop_shadow_from_proto).transpose()?,
            effect_stack: node
                .effect_stack
                .into_iter()
                .map(effect_from_proto)
                .collect::<Result<Vec<_>, _>>()?,
            corner_radius: node.corner_radius,
            corner_radii: node.corner_radii,
            corner_smoothing: node.corner_smoothing,
            constraints: node.constraints.map(constraints_from_proto).transpose()?,
            text: node.text,
            visible: node.visible,
            locked: node.locked,
            contents_hidden: node.contents_hidden,
            clips_content,
            extensions: node.extensions.into_iter().collect(),
        },
        node.asset_id.as_deref().map(id).transpose()?.map(AssetId),
        text_properties,
    ))
}

fn stroke_cap_from_proto(value: i32) -> Result<StrokeCap, ServiceError> {
    Ok(
        match v1::StrokeCap::try_from(value).map_err(|_| ServiceError::InvalidEnvelope)? {
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

fn stroke_join_from_proto(value: i32) -> Result<StrokeJoin, ServiceError> {
    Ok(
        match v1::StrokeJoin::try_from(value).map_err(|_| ServiceError::InvalidEnvelope)? {
            v1::StrokeJoin::Unspecified | v1::StrokeJoin::Miter => StrokeJoin::Miter,
            v1::StrokeJoin::Bevel => StrokeJoin::Bevel,
            v1::StrokeJoin::Round => StrokeJoin::Round,
        },
    )
}

fn stroke_align_from_proto(value: i32) -> Result<StrokeAlign, ServiceError> {
    Ok(
        match v1::StrokeAlign::try_from(value).map_err(|_| ServiceError::InvalidEnvelope)? {
            v1::StrokeAlign::Unspecified | v1::StrokeAlign::Inside => StrokeAlign::Inside,
            v1::StrokeAlign::Center => StrokeAlign::Center,
            v1::StrokeAlign::Outside => StrokeAlign::Outside,
        },
    )
}

fn blend_mode_from_proto(value: i32) -> Result<BlendMode, ServiceError> {
    match v1::BlendMode::try_from(value).map_err(|_| ServiceError::InvalidEnvelope)? {
        v1::BlendMode::Normal => Ok(BlendMode::Normal),
        v1::BlendMode::Multiply => Ok(BlendMode::Multiply),
        v1::BlendMode::Screen => Ok(BlendMode::Screen),
        v1::BlendMode::Overlay => Ok(BlendMode::Overlay),
        v1::BlendMode::Darken => Ok(BlendMode::Darken),
        v1::BlendMode::Lighten => Ok(BlendMode::Lighten),
    }
}

fn constraints_from_proto(value: v1::Constraints) -> Result<Constraints, ServiceError> {
    let convert = |axis| match v1::ConstraintType::try_from(axis)
        .map_err(|_| ServiceError::InvalidEnvelope)?
    {
        v1::ConstraintType::Min => Ok(ConstraintType::Min),
        v1::ConstraintType::Center => Ok(ConstraintType::Center),
        v1::ConstraintType::Max => Ok(ConstraintType::Max),
        v1::ConstraintType::Stretch => Ok(ConstraintType::Stretch),
        v1::ConstraintType::Scale => Ok(ConstraintType::Scale),
        v1::ConstraintType::Unspecified => Err(ServiceError::InvalidEnvelope),
    };
    Ok(Constraints {
        horizontal: convert(value.horizontal)?,
        vertical: convert(value.vertical)?,
    })
}

fn auto_layout_from_proto(value: v1::AutoLayout) -> Result<AutoLayout, ServiceError> {
    let mode =
        match v1::LayoutMode::try_from(value.mode).map_err(|_| ServiceError::InvalidEnvelope)? {
            v1::LayoutMode::None => LayoutMode::None,
            v1::LayoutMode::Horizontal => LayoutMode::Horizontal,
            v1::LayoutMode::Vertical => LayoutMode::Vertical,
            v1::LayoutMode::Unspecified => return Err(ServiceError::InvalidEnvelope),
        };
    let alignment = |value| match v1::LayoutAlignment::try_from(value)
        .map_err(|_| ServiceError::InvalidEnvelope)?
    {
        v1::LayoutAlignment::Start => Ok(LayoutAlignment::Start),
        v1::LayoutAlignment::Center => Ok(LayoutAlignment::Center),
        v1::LayoutAlignment::End => Ok(LayoutAlignment::End),
        v1::LayoutAlignment::SpaceBetween => Ok(LayoutAlignment::SpaceBetween),
        v1::LayoutAlignment::Baseline => Ok(LayoutAlignment::Baseline),
        v1::LayoutAlignment::Unspecified => Err(ServiceError::InvalidEnvelope),
    };
    let sizing = |value| match v1::LayoutSizing::try_from(value)
        .map_err(|_| ServiceError::InvalidEnvelope)?
    {
        v1::LayoutSizing::Fixed => Ok(LayoutSizing::Fixed),
        v1::LayoutSizing::Hug => Ok(LayoutSizing::Hug),
        v1::LayoutSizing::Fill => Ok(LayoutSizing::Fill),
        v1::LayoutSizing::Unspecified => Err(ServiceError::InvalidEnvelope),
    };
    let align_self = value.align_self.map(|value| alignment(value)).transpose()?;
    if matches!(
        align_self,
        Some(LayoutAlignment::SpaceBetween | LayoutAlignment::Baseline)
    ) {
        return Err(ServiceError::InvalidEnvelope);
    }
    let track_alignment = match value
        .wrap_track_alignment
        .map(v1::WrapTrackAlignment::try_from)
        .transpose()
        .map_err(|_| ServiceError::InvalidEnvelope)?
    {
        None | Some(v1::WrapTrackAlignment::Auto) => WrapTrackAlignment::Auto,
        Some(v1::WrapTrackAlignment::SpaceBetween) => WrapTrackAlignment::SpaceBetween,
        Some(v1::WrapTrackAlignment::Unspecified) => return Err(ServiceError::InvalidEnvelope),
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
        return Err(ServiceError::InvalidEnvelope);
    }
    Ok(layout)
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
        (Some(_), Some(_)) => Err(ServiceError::InvalidEnvelope),
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
fn vector_path_from_proto(path: v1::VectorPath) -> Result<VectorPath, ServiceError> {
    let fill_rule =
        match v1::FillRule::try_from(path.fill_rule).map_err(|_| ServiceError::InvalidEnvelope)? {
            v1::FillRule::NonZero => FillRule::NonZero,
            v1::FillRule::EvenOdd => FillRule::EvenOdd,
            v1::FillRule::Unspecified => return Err(ServiceError::InvalidEnvelope),
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
                            .map_err(|_| ServiceError::InvalidEnvelope)?
                        {
                            v1::VectorPointType::Corner => VectorPointType::Corner,
                            v1::VectorPointType::Mirrored => VectorPointType::Mirrored,
                            v1::VectorPointType::Asymmetric => VectorPointType::Asymmetric,
                            v1::VectorPointType::Unspecified => {
                                return Err(ServiceError::InvalidEnvelope);
                            }
                        };
                        let handle_in = match (point.handle_in_x, point.handle_in_y) {
                            (None, None) => None,
                            (Some(x), Some(y)) => Some(editor_core::geometry::Point { x, y }),
                            _ => return Err(ServiceError::InvalidEnvelope),
                        };
                        let handle_out = match (point.handle_out_x, point.handle_out_y) {
                            (None, None) => None,
                            (Some(x), Some(y)) => Some(editor_core::geometry::Point { x, y }),
                            _ => return Err(ServiceError::InvalidEnvelope),
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
fn boolean_operation_from_proto(operation: i32) -> Result<BooleanOperation, ServiceError> {
    match v1::BooleanOperation::try_from(operation).map_err(|_| ServiceError::InvalidEnvelope)? {
        v1::BooleanOperation::Union => Ok(BooleanOperation::Union),
        v1::BooleanOperation::Intersect => Ok(BooleanOperation::Intersect),
        v1::BooleanOperation::Subtract => Ok(BooleanOperation::Subtract),
        v1::BooleanOperation::Exclude => Ok(BooleanOperation::Exclude),
        v1::BooleanOperation::Unspecified => Err(ServiceError::InvalidEnvelope),
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

fn drop_shadow_from_proto(shadow: v1::DropShadow) -> Result<DropShadow, ServiceError> {
    Ok(DropShadow {
        offset_x: shadow.offset_x,
        offset_y: shadow.offset_y,
        blur_radius: shadow.blur_radius,
        spread: shadow.spread,
        color: color_from_proto(shadow.color.ok_or(ServiceError::InvalidEnvelope)?)?,
        visible: shadow.visible,
    })
}

fn effect_from_proto(effect: v1::Effect) -> Result<Effect, ServiceError> {
    match effect.kind.ok_or(ServiceError::InvalidEnvelope)? {
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
            color: color_from_proto(shadow.color.ok_or(ServiceError::InvalidEnvelope)?)?,
            visible: shadow.visible,
        })),
        v1::effect::Kind::BackgroundBlur(blur) => Ok(Effect::BackgroundBlur(BackgroundBlur {
            radius: blur.radius,
            visible: blur.visible,
        })),
    }
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
    use editor_core::{
        Command, Document, Origin, PointId, Transaction, TransactionId, geometry::Point,
    };
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

    fn auto_layout(
        mode: v1::LayoutMode,
        primary_alignment: v1::LayoutAlignment,
        counter_alignment: v1::LayoutAlignment,
        align_self: Option<v1::LayoutAlignment>,
    ) -> v1::AutoLayout {
        v1::AutoLayout {
            mode: mode as i32,
            padding_top: 0.0,
            padding_right: 0.0,
            padding_bottom: 0.0,
            padding_left: 0.0,
            item_spacing: 0.0,
            wrap: false,
            primary_alignment: primary_alignment as i32,
            counter_alignment: counter_alignment as i32,
            primary_sizing: v1::LayoutSizing::Fixed as i32,
            counter_sizing: v1::LayoutSizing::Fixed as i32,
            min_width: None,
            max_width: None,
            min_height: None,
            max_height: None,
            absolute: false,
            align_self: align_self.map(|value| value as i32),
            track_spacing: None,
            wrap_track_alignment: None,
        }
    }

    #[test]
    fn generated_import_page_nodes_then_mask_batch_maps_to_the_same_core_reducer_boundary() {
        let node = v1::SceneNode {
            node_id: 7_u128.to_be_bytes().to_vec(),
            parent_id: None,
            page_id: 2_u128.to_be_bytes().to_vec(),
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
            fills: Vec::new(),
            strokes: Vec::new(),
            stroke_width: 0.0,
            opacity: 1.0,
            blend_mode: v1::BlendMode::Normal as i32,
            drop_shadow: None,
            effect_stack: Vec::new(),
            polygon_parameters: None,
            star_parameters: None,
            vector_path: None,
            boolean_operation: None,
            corner_radius: 0.0,
            corner_radii: vec![],
            corner_smoothing: 0.0,
            constraints: None,
            text: String::new(),
            visible: true,
            locked: false,
            contents_hidden: false,
            clips_content: Some(false),
            text_properties: None,
            stroke_cap_start: v1::StrokeCap::None as i32,
            stroke_cap_end: v1::StrokeCap::None as i32,
            stroke_join: v1::StrokeJoin::Miter as i32,
            stroke_miter_limit: 10.0,
            stroke_dash_pattern: vec![],
            stroke_weights: vec![],
            stroke_align: v1::StrokeAlign::Inside as i32,
            arc_data: None,
            relative_transform: None,
            extensions: Default::default(),
            auto_layout: None,
            reactions: Vec::new(),
            prototype_metadata: None,
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![
                v1::ResolvedOperation {
                    kind: Some(v1::resolved_operation::Kind::CreatePage(v1::CreatePage {
                        page: Some(v1::PageRef {
                            page_id: 2_u128.to_be_bytes().to_vec(),
                            name: "Imported page".into(),
                            position_id: Some(v1::PositionId {
                                key: 2_u128.to_be_bytes().to_vec(),
                                actor_id: 0_u128.to_be_bytes().to_vec(),
                            }),
                        }),
                    })),
                },
                v1::ResolvedOperation {
                    kind: Some(v1::resolved_operation::Kind::CreateNode(v1::CreateNode {
                        node: Some(node),
                    })),
                },
                v1::ResolvedOperation {
                    kind: Some(v1::resolved_operation::Kind::CreateNode(v1::CreateNode {
                        node: Some(v1::SceneNode {
                            node_id: 8_u128.to_be_bytes().to_vec(),
                            parent_id: None,
                            page_id: 2_u128.to_be_bytes().to_vec(),
                            position_id: Some(v1::PositionId {
                                key: 8_u128.to_be_bytes().to_vec(),
                                actor_id: 0_u128.to_be_bytes().to_vec(),
                            }),
                            name: "Masked target".into(),
                            kind: v1::NodeKind::Rectangle as i32,
                            asset_id: None,
                            x: 24.0,
                            y: 0.0,
                            width: 100.0,
                            height: 80.0,
                            rotation: 0.0,
                            fill: Some(paint()),
                            stroke: Some(paint()),
                            fills: Vec::new(),
                            strokes: Vec::new(),
                            stroke_width: 0.0,
                            opacity: 1.0,
                            blend_mode: v1::BlendMode::Normal as i32,
                            drop_shadow: None,
                            effect_stack: Vec::new(),
                            polygon_parameters: None,
                            star_parameters: None,
                            vector_path: None,
                            boolean_operation: None,
                            corner_radius: 0.0,
                            corner_radii: vec![],
                            corner_smoothing: 0.0,
                            constraints: None,
                            text: String::new(),
                            visible: true,
                            locked: false,
                            contents_hidden: false,
                            clips_content: Some(false),
                            text_properties: None,
                            stroke_cap_start: v1::StrokeCap::None as i32,
                            stroke_cap_end: v1::StrokeCap::None as i32,
                            stroke_join: v1::StrokeJoin::Miter as i32,
                            stroke_miter_limit: 10.0,
                            stroke_dash_pattern: vec![],
                            stroke_weights: vec![],
                            stroke_align: v1::StrokeAlign::Inside as i32,
                            arc_data: None,
                            relative_transform: None,
                            extensions: Default::default(),
                            auto_layout: None,
                            reactions: Vec::new(),
                            prototype_metadata: None,
                        }),
                    })),
                },
                // CreateNode intentionally does not own the Phase 2 mask bit;
                // its dedicated operation must survive the same remote batch.
                v1::ResolvedOperation {
                    kind: Some(v1::resolved_operation::Kind::SetMask(v1::SetMask {
                        node_id: 7_u128.to_be_bytes().to_vec(),
                        enabled: true,
                    })),
                },
            ],
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
            Some(editor_core::PageId(2))
        );
        assert_eq!(
            document
                .node(editor_core::NodeId(7))
                .unwrap()
                .extensions
                .get("makefigma.mask.alpha.v1"),
            Some(&vec![1]),
        );
    }

    #[test]
    fn baseline_auto_layout_operation_is_durable_only_on_a_horizontal_counter_axis() {
        let operation = |layout| {
            v1::ResolvedOperationBatch {
                operations: vec![v1::ResolvedOperation {
                    kind: Some(v1::resolved_operation::Kind::SetAutoLayout(
                        v1::AutoLayoutUpdate {
                            node_id: 7_u128.to_be_bytes().to_vec(),
                            auto_layout: Some(layout),
                        },
                    )),
                }],
            }
            .encode_to_vec()
        };

        let valid = operation(auto_layout(
            v1::LayoutMode::Horizontal,
            v1::LayoutAlignment::Start,
            v1::LayoutAlignment::Baseline,
            None,
        ));
        assert!(matches!(
            commands_from_payload(&valid).unwrap().as_slice(),
            [Command::SetAutoLayout { id: editor_core::NodeId(7), layout }]
                if layout.mode == editor_core::LayoutMode::Horizontal
                    && layout.counter_alignment == editor_core::LayoutAlignment::Baseline
        ));

        let vertical = operation(auto_layout(
            v1::LayoutMode::Vertical,
            v1::LayoutAlignment::Start,
            v1::LayoutAlignment::Baseline,
            None,
        ));
        assert!(commands_from_payload(&vertical).is_err());

        let child_override = operation(auto_layout(
            v1::LayoutMode::None,
            v1::LayoutAlignment::Start,
            v1::LayoutAlignment::Start,
            Some(v1::LayoutAlignment::Baseline),
        ));
        assert!(commands_from_payload(&child_override).is_err());

        let counter_space_between = operation(auto_layout(
            v1::LayoutMode::Horizontal,
            v1::LayoutAlignment::Start,
            v1::LayoutAlignment::SpaceBetween,
            None,
        ));
        assert!(commands_from_payload(&counter_space_between).is_err());
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

    #[test]
    fn vector_path_operation_maps_to_the_atomic_core_command() {
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetVectorPath(
                    v1::SetVectorPath {
                        node_id: 7_u128.to_be_bytes().to_vec(),
                        vector_path: Some(v1::VectorPath {
                            fill_rule: v1::FillRule::EvenOdd as i32,
                            subpaths: vec![v1::VectorSubpath {
                                closed: true,
                                points: vec![
                                    v1::VectorPoint {
                                        point_id: 1_u128.to_be_bytes().to_vec(),
                                        x: 0.0,
                                        y: 0.0,
                                        handle_in_x: None,
                                        handle_in_y: None,
                                        handle_out_x: None,
                                        handle_out_y: None,
                                        point_type: v1::VectorPointType::Corner as i32,
                                    },
                                    v1::VectorPoint {
                                        point_id: 2_u128.to_be_bytes().to_vec(),
                                        x: 100.0,
                                        y: 0.0,
                                        handle_in_x: None,
                                        handle_in_y: None,
                                        handle_out_x: None,
                                        handle_out_y: None,
                                        point_type: v1::VectorPointType::Corner as i32,
                                    },
                                    v1::VectorPoint {
                                        point_id: 3_u128.to_be_bytes().to_vec(),
                                        x: 50.0,
                                        y: 100.0,
                                        handle_in_x: None,
                                        handle_in_y: None,
                                        handle_out_x: None,
                                        handle_out_y: None,
                                        point_type: v1::VectorPointType::Mirrored as i32,
                                    },
                                ],
                            }],
                        }),
                    },
                )),
            }],
        }
        .encode_to_vec();

        let commands = commands_from_payload(&payload).unwrap();
        assert!(
            matches!(commands.as_slice(), [Command::SetVectorPath { id: editor_core::NodeId(7), path }] if path.fill_rule == editor_core::FillRule::EvenOdd && path.subpaths[0].points[2].point_type == editor_core::VectorPointType::Mirrored)
        );
    }

    #[test]
    fn named_vector_point_operations_map_to_core_commands() {
        let payload = v1::ResolvedOperationBatch {
            operations: vec![
                v1::ResolvedOperation {
                    kind: Some(v1::resolved_operation::Kind::MoveVectorPoint(
                        v1::MoveVectorPoint {
                            node_id: 7_u128.to_be_bytes().to_vec(),
                            point_id: 4_u128.to_be_bytes().to_vec(),
                            x: 12.5,
                            y: 8.0,
                        },
                    )),
                },
                v1::ResolvedOperation {
                    kind: Some(v1::resolved_operation::Kind::SetVectorSubpathClosed(
                        v1::SetVectorSubpathClosed {
                            node_id: 7_u128.to_be_bytes().to_vec(),
                            subpath_index: 2,
                            closed: true,
                        },
                    )),
                },
            ],
        }
        .encode_to_vec();

        let commands = commands_from_payload(&payload).unwrap();
        assert!(matches!(
            commands.as_slice(),
            [
                Command::MoveVectorPoint { id: editor_core::NodeId(7), point_id: PointId(4), position },
                Command::SetVectorSubpathClosed { id: editor_core::NodeId(7), subpath_index: 2, closed: true },
            ] if *position == Point { x: 12.5, y: 8.0 }
        ));
    }

    #[test]
    fn vector_point_insert_and_delete_operations_map_to_core_commands() {
        let payload = v1::ResolvedOperationBatch {
            operations: vec![
                v1::ResolvedOperation {
                    kind: Some(v1::resolved_operation::Kind::InsertVectorPoint(
                        v1::InsertVectorPoint {
                            node_id: 7_u128.to_be_bytes().to_vec(),
                            subpath_index: 1,
                            after_point_id: Some(4_u128.to_be_bytes().to_vec()),
                            point: Some(v1::VectorPoint {
                                point_id: 5_u128.to_be_bytes().to_vec(),
                                x: 24.0,
                                y: 12.0,
                                handle_in_x: Some(-2.0),
                                handle_in_y: Some(1.0),
                                handle_out_x: None,
                                handle_out_y: None,
                                point_type: v1::VectorPointType::Asymmetric as i32,
                            }),
                        },
                    )),
                },
                v1::ResolvedOperation {
                    kind: Some(v1::resolved_operation::Kind::DeleteVectorPoint(
                        v1::DeleteVectorPoint {
                            node_id: 7_u128.to_be_bytes().to_vec(),
                            point_id: 5_u128.to_be_bytes().to_vec(),
                        },
                    )),
                },
            ],
        }
        .encode_to_vec();

        let commands = commands_from_payload(&payload).unwrap();
        assert!(matches!(
            commands.as_slice(),
            [
                Command::InsertVectorPoint { id: editor_core::NodeId(7), subpath_index: 1, after_point_id: Some(PointId(4)), point },
                Command::DeleteVectorPoint { id: editor_core::NodeId(7), point_id: PointId(5) },
            ] if point.id == PointId(5) && point.handle_in == Some(Point { x: -2.0, y: 1.0 }) && point.point_type == editor_core::VectorPointType::Asymmetric
        ));
    }

    #[test]
    fn split_vector_segment_operation_maps_to_core_command() {
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SplitVectorSegment(
                    v1::SplitVectorSegment {
                        node_id: 7_u128.to_be_bytes().to_vec(),
                        subpath_index: 1,
                        after_point_id: 4_u128.to_be_bytes().to_vec(),
                        t: 0.25,
                        point_id: 5_u128.to_be_bytes().to_vec(),
                    },
                )),
            }],
        }
        .encode_to_vec();

        assert!(
            matches!(commands_from_payload(&payload).unwrap().as_slice(), [
            Command::SplitVectorSegment { id: editor_core::NodeId(7), subpath_index: 1, after_point_id: PointId(4), t, point_id: PointId(5) },
        ] if *t == 0.25)
        );
    }

    #[test]
    fn connect_vector_endpoints_operation_maps_to_core_command() {
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::ConnectVectorEndpoints(
                    v1::ConnectVectorEndpoints {
                        node_id: 7_u128.to_be_bytes().to_vec(),
                        first_subpath_index: 1,
                        first_point_id: 4_u128.to_be_bytes().to_vec(),
                        second_subpath_index: 2,
                        second_point_id: 5_u128.to_be_bytes().to_vec(),
                    },
                )),
            }],
        }
        .encode_to_vec();

        assert!(matches!(
            commands_from_payload(&payload).unwrap().as_slice(),
            [Command::ConnectVectorEndpoints {
                id: editor_core::NodeId(7),
                first_subpath_index: 1,
                first_point_id: PointId(4),
                second_subpath_index: 2,
                second_point_id: PointId(5)
            },]
        ));
    }

    #[test]
    fn alpha_mask_operation_maps_to_core_command() {
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetMask(v1::SetMask {
                    node_id: 7_u128.to_be_bytes().to_vec(),
                    enabled: true,
                })),
            }],
        }
        .encode_to_vec();

        assert!(matches!(
            commands_from_payload(&payload).unwrap().as_slice(),
            [Command::SetMask {
                id: editor_core::NodeId(7),
                enabled: true
            },]
        ));
    }
}
