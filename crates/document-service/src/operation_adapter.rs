//! Converts generated protobuf operation payloads into the canonical reducer input.
//! This is the only service-side location allowed to know both protocol and core.

use editor_core::{
    ActorId, Appearance, ArcData, AssetId, AssetReference, AutoLayout, BackgroundBlur, BlendMode,
    BooleanOperation, Command, ConstraintType, Constraints, DropShadow, Effect, FillRule,
    FontFaceMetadata, FontNameAlias, FontReference, HyperlinkTarget, HyperlinkType, InnerShadow,
    LayerBlur, LayoutAlignment, LayoutMode, LayoutSizing, LeadingTrim, LineHeightUnit, Node,
    NodeId, NodeKind, OpenTypeFeature, Page, PageId, PaintStyleResource, ParagraphListType,
    ParagraphStyle, ParagraphStyleRun, ParametricShape, PointId, PositionId, StrokeAlign,
    StrokeCap, StrokeJoin, TextAlign, TextAutoSize, TextCase, TextDecoration, TextDecorationColor,
    TextDecorationOffset, TextDecorationStyle, TextDecorationThickness, TextListType,
    TextProperties, TextStyleResource, TextStyleRun, TextTruncation, TextWrapStyle, VectorPath,
    VectorPoint, VectorPointType, VectorSubpath, WrapTrackAlignment,
    color::{
        Color, ColorSpace, DocumentColorProfile, GradientPaint, GradientPaintKind, GradientStop,
        ImageFilters, ImagePaint, ImageScaleMode, LinearGradient, Paint, PaintLayer,
        PaintLayerKind, PaintStack,
    },
    geometry::Point,
};
use makefigma_protocol::v1;
use prost::Message;

use crate::ServiceError;

pub fn commands_from_payload(payload: &[u8]) -> Result<Vec<Command>, ServiceError> {
    commands_from_payload_with_semantics(payload, u32::MAX)
}

pub fn commands_from_payload_with_semantics(
    payload: &[u8],
    engine_semantics_version: u32,
) -> Result<Vec<Command>, ServiceError> {
    let batch =
        v1::ResolvedOperationBatch::decode(payload).map_err(|_| ServiceError::InvalidEnvelope)?;
    if batch.operations.is_empty() {
        return Err(ServiceError::InvalidEnvelope);
    }
    if engine_semantics_version
        < makefigma_document_codec::TEXT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION
        && batch.operations.iter().any(|operation| {
            matches!(
                operation.kind,
                Some(v1::resolved_operation::Kind::RegisterTextStyle(_))
            )
        })
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::TEXT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version
        < makefigma_document_codec::PAINT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION
        && batch.operations.iter().any(|operation| {
            matches!(
                operation.kind,
                Some(v1::resolved_operation::Kind::RegisterPaintStyle(_))
            )
        })
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::PAINT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version < makefigma_document_codec::PAINT_STACK_ENGINE_SEMANTICS_VERSION
        && batch.operations.iter().any(operation_has_paint_stack)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::PAINT_STACK_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version
        < makefigma_document_codec::NON_LINEAR_GRADIENT_ENGINE_SEMANTICS_VERSION
        && batch
            .operations
            .iter()
            .any(operation_has_non_linear_gradient)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::NON_LINEAR_GRADIENT_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version < makefigma_document_codec::ADVANCED_BLEND_ENGINE_SEMANTICS_VERSION
        && batch.operations.iter().any(operation_has_advanced_blend)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::ADVANCED_BLEND_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version
        < makefigma_document_codec::IMAGE_PAINT_ROTATION_ENGINE_SEMANTICS_VERSION
        && batch.operations.iter().any(operation_has_rotated_image)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::IMAGE_PAINT_ROTATION_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version < makefigma_document_codec::PASS_THROUGH_ENGINE_SEMANTICS_VERSION
        && batch.operations.iter().any(operation_has_pass_through)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::PASS_THROUGH_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version < makefigma_document_codec::LINEAR_BLEND_ENGINE_SEMANTICS_VERSION
        && batch.operations.iter().any(operation_has_linear_blend)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::LINEAR_BLEND_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version
        < makefigma_document_codec::NORMAL_BLEND_ISOLATION_ENGINE_SEMANTICS_VERSION
        && batch
            .operations
            .iter()
            .any(operation_has_normal_blend_isolation)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::NORMAL_BLEND_ISOLATION_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version < makefigma_document_codec::IMAGE_FILTERS_ENGINE_SEMANTICS_VERSION
        && batch.operations.iter().any(operation_has_image_filters)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::IMAGE_FILTERS_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version < makefigma_document_codec::TEXT_TRUNCATION_ENGINE_SEMANTICS_VERSION
        && batch.operations.iter().any(operation_has_text_truncation)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::TEXT_TRUNCATION_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version
        < makefigma_document_codec::TEXT_RUN_PAINT_STACK_ENGINE_SEMANTICS_VERSION
        && batch
            .operations
            .iter()
            .any(operation_has_text_run_paint_stack)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::TEXT_RUN_PAINT_STACK_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version < makefigma_document_codec::TEXT_BASE_STYLE_ENGINE_SEMANTICS_VERSION
        && batch.operations.iter().any(operation_has_text_base_style)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::TEXT_BASE_STYLE_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version < makefigma_document_codec::TEXT_CASE_ENGINE_SEMANTICS_VERSION
        && batch.operations.iter().any(operation_has_text_case)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::TEXT_CASE_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version < makefigma_document_codec::TEXT_PATH_ENGINE_SEMANTICS_VERSION
        && batch.operations.iter().any(|operation| {
            matches!(
                operation.kind,
                Some(v1::resolved_operation::Kind::ConvertToTextPath(_))
            )
        })
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::TEXT_PATH_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version
        < makefigma_document_codec::LINE_HEIGHT_UNIT_ENGINE_SEMANTICS_VERSION
        && batch.operations.iter().any(operation_has_line_height_unit)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::LINE_HEIGHT_UNIT_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version
        < makefigma_document_codec::PARAGRAPH_INDENT_ENGINE_SEMANTICS_VERSION
        && batch.operations.iter().any(operation_has_paragraph_indent)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::PARAGRAPH_INDENT_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version < makefigma_document_codec::TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION
        && batch.operations.iter().any(operation_has_text_wrap_style)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version < makefigma_document_codec::TEXT_LIST_TYPE_ENGINE_SEMANTICS_VERSION
        && batch.operations.iter().any(operation_has_list_type)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::TEXT_LIST_TYPE_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version
        < makefigma_document_codec::TEXT_LIST_SPACING_ENGINE_SEMANTICS_VERSION
        && batch.operations.iter().any(operation_has_list_spacing)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::TEXT_LIST_SPACING_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version
        < makefigma_document_codec::PARAGRAPH_STYLE_RUNS_ENGINE_SEMANTICS_VERSION
        && batch
            .operations
            .iter()
            .any(operation_has_paragraph_style_runs)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::PARAGRAPH_STYLE_RUNS_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version
        < makefigma_document_codec::TEXT_HANGING_LIST_ENGINE_SEMANTICS_VERSION
        && batch.operations.iter().any(operation_has_hanging_list)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::TEXT_HANGING_LIST_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version
        < makefigma_document_codec::PARAGRAPH_LIST_OPTIONS_ENGINE_SEMANTICS_VERSION
        && batch
            .operations
            .iter()
            .any(operation_has_paragraph_list_options)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::PARAGRAPH_LIST_OPTIONS_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version
        < makefigma_document_codec::PARAGRAPH_LIST_SPACING_ENGINE_SEMANTICS_VERSION
        && batch
            .operations
            .iter()
            .any(operation_has_paragraph_list_spacing)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::PARAGRAPH_LIST_SPACING_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version
        < makefigma_document_codec::PARAGRAPH_SPACING_ENGINE_SEMANTICS_VERSION
        && batch.operations.iter().any(operation_has_paragraph_spacing)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::PARAGRAPH_SPACING_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version
        < makefigma_document_codec::PARAGRAPH_INDENT_RUN_ENGINE_SEMANTICS_VERSION
        && batch
            .operations
            .iter()
            .any(operation_has_paragraph_indent_run)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::PARAGRAPH_INDENT_RUN_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version
        < makefigma_document_codec::PARAGRAPH_LINE_HEIGHT_ENGINE_SEMANTICS_VERSION
        && batch
            .operations
            .iter()
            .any(operation_has_paragraph_line_height)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::PARAGRAPH_LINE_HEIGHT_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version
        < makefigma_document_codec::TEXT_HANGING_PUNCTUATION_ENGINE_SEMANTICS_VERSION
        && batch
            .operations
            .iter()
            .any(operation_has_hanging_punctuation)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::TEXT_HANGING_PUNCTUATION_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version
        < makefigma_document_codec::PARAGRAPH_TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION
        && batch
            .operations
            .iter()
            .any(operation_has_paragraph_text_wrap_style)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::PARAGRAPH_TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version < makefigma_document_codec::TEXT_HYPERLINK_ENGINE_SEMANTICS_VERSION
        && batch.operations.iter().any(operation_has_hyperlink)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::TEXT_HYPERLINK_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version < makefigma_document_codec::TEXT_DECORATION_ENGINE_SEMANTICS_VERSION
        && batch.operations.iter().any(operation_has_text_decoration)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::TEXT_DECORATION_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version
        < makefigma_document_codec::TEXT_DECORATION_STYLE_ENGINE_SEMANTICS_VERSION
        && batch
            .operations
            .iter()
            .any(operation_has_text_decoration_style)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::TEXT_DECORATION_STYLE_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version
        < makefigma_document_codec::TEXT_DECORATION_OFFSET_ENGINE_SEMANTICS_VERSION
        && batch
            .operations
            .iter()
            .any(operation_has_text_decoration_offset)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::TEXT_DECORATION_OFFSET_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version
        < makefigma_document_codec::TEXT_DECORATION_THICKNESS_ENGINE_SEMANTICS_VERSION
        && batch
            .operations
            .iter()
            .any(operation_has_text_decoration_thickness)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::TEXT_DECORATION_THICKNESS_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version
        < makefigma_document_codec::TEXT_DECORATION_COLOR_ENGINE_SEMANTICS_VERSION
        && batch
            .operations
            .iter()
            .any(operation_has_text_decoration_color)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::TEXT_DECORATION_COLOR_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version
        < makefigma_document_codec::TEXT_DECORATION_SKIP_INK_ENGINE_SEMANTICS_VERSION
        && batch
            .operations
            .iter()
            .any(operation_has_text_decoration_skip_ink)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::TEXT_DECORATION_SKIP_INK_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version < makefigma_document_codec::LEADING_TRIM_ENGINE_SEMANTICS_VERSION
        && batch.operations.iter().any(operation_has_leading_trim)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::LEADING_TRIM_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version
        < makefigma_document_codec::OPEN_TYPE_FEATURES_ENGINE_SEMANTICS_VERSION
        && batch
            .operations
            .iter()
            .any(operation_has_open_type_features)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::OPEN_TYPE_FEATURES_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version < makefigma_document_codec::TEXT_STYLE_LINK_ENGINE_SEMANTICS_VERSION
        && batch.operations.iter().any(operation_has_text_style_link)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::TEXT_STYLE_LINK_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version
        < makefigma_document_codec::FONT_FACE_METADATA_ENGINE_SEMANTICS_VERSION
        && batch
            .operations
            .iter()
            .any(operation_has_font_face_metadata)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::FONT_FACE_METADATA_ENGINE_SEMANTICS_VERSION,
        });
    }
    if engine_semantics_version
        < makefigma_document_codec::FONT_NAME_ALIASES_ENGINE_SEMANTICS_VERSION
        && batch.operations.iter().any(operation_has_font_name_aliases)
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: makefigma_document_codec::FONT_NAME_ALIASES_ENGINE_SEMANTICS_VERSION,
        });
    }
    let mut commands = Vec::with_capacity(batch.operations.len());
    for operation in batch.operations {
        let paint_stacks = paint_stack_command(&operation)?;
        commands.push(command_from_proto(operation)?);
        if let Some(command) = paint_stacks {
            commands.push(command);
        }
    }
    Ok(commands)
}

fn operation_has_paint_stack(operation: &v1::ResolvedOperation) -> bool {
    use v1::resolved_operation::Kind;
    match operation.kind.as_ref() {
        Some(Kind::CreateNode(value)) => value
            .node
            .as_ref()
            .is_some_and(|node| node.fill_stack.is_some() || node.stroke_stack.is_some()),
        Some(Kind::RestoreNode(value)) => value
            .node
            .as_ref()
            .is_some_and(|node| node.fill_stack.is_some() || node.stroke_stack.is_some()),
        Some(Kind::SetAppearance(value)) => {
            value.fill_stack.is_some() || value.stroke_stack.is_some()
        }
        _ => false,
    }
}

fn operation_has_non_linear_gradient(operation: &v1::ResolvedOperation) -> bool {
    use v1::resolved_operation::Kind;
    let stacks = match operation.kind.as_ref() {
        Some(Kind::CreateNode(value)) => value
            .node
            .as_ref()
            .map(|node| [&node.fill_stack, &node.stroke_stack]),
        Some(Kind::RestoreNode(value)) => value
            .node
            .as_ref()
            .map(|node| [&node.fill_stack, &node.stroke_stack]),
        Some(Kind::SetAppearance(value)) => Some([&value.fill_stack, &value.stroke_stack]),
        _ => None,
    };
    stacks
        .into_iter()
        .flatten()
        .filter_map(Option::as_ref)
        .any(|stack| {
            stack
                .layers
                .iter()
                .any(|layer| matches!(layer.kind, Some(v1::paint_layer::Kind::Gradient(_))))
        })
}

fn operation_has_advanced_blend(operation: &v1::ResolvedOperation) -> bool {
    use v1::resolved_operation::Kind;
    let (node_blend, stacks) = match operation.kind.as_ref() {
        Some(Kind::CreateNode(value)) => value.node.as_ref().map_or((None, None), |node| {
            (
                Some(node.blend_mode),
                Some([&node.fill_stack, &node.stroke_stack]),
            )
        }),
        Some(Kind::RestoreNode(value)) => value.node.as_ref().map_or((None, None), |node| {
            (
                Some(node.blend_mode),
                Some([&node.fill_stack, &node.stroke_stack]),
            )
        }),
        Some(Kind::SetAppearance(value)) => (
            Some(value.blend_mode),
            Some([&value.fill_stack, &value.stroke_stack]),
        ),
        _ => (None, None),
    };
    node_blend.is_some_and(proto_blend_requires_advanced)
        || stacks
            .into_iter()
            .flatten()
            .filter_map(Option::as_ref)
            .flat_map(|stack| &stack.layers)
            .any(|layer| proto_blend_requires_advanced(layer.blend_mode))
}

fn proto_blend_requires_advanced(value: i32) -> bool {
    matches!(
        v1::BlendMode::try_from(value),
        Ok(v1::BlendMode::ColorDodge
            | v1::BlendMode::ColorBurn
            | v1::BlendMode::HardLight
            | v1::BlendMode::SoftLight
            | v1::BlendMode::Difference
            | v1::BlendMode::Exclusion
            | v1::BlendMode::Hue
            | v1::BlendMode::Saturation
            | v1::BlendMode::Color
            | v1::BlendMode::Luminosity)
    )
}

fn operation_has_rotated_image(operation: &v1::ResolvedOperation) -> bool {
    use v1::resolved_operation::Kind;
    let stacks = match operation.kind.as_ref() {
        Some(Kind::CreateNode(value)) => value
            .node
            .as_ref()
            .map(|node| [&node.fill_stack, &node.stroke_stack]),
        Some(Kind::RestoreNode(value)) => value
            .node
            .as_ref()
            .map(|node| [&node.fill_stack, &node.stroke_stack]),
        Some(Kind::SetAppearance(value)) => Some([&value.fill_stack, &value.stroke_stack]),
        _ => None,
    };
    stacks
        .into_iter()
        .flatten()
        .filter_map(Option::as_ref)
        .flat_map(|stack| &stack.layers)
        .any(|layer| {
            matches!(&layer.kind, Some(v1::paint_layer::Kind::Image(image)) if image.rotation_degrees != 0)
        })
}

fn operation_has_image_filters(operation: &v1::ResolvedOperation) -> bool {
    use v1::resolved_operation::Kind;
    let stacks = match operation.kind.as_ref() {
        Some(Kind::CreateNode(value)) => value
            .node
            .as_ref()
            .map(|node| [&node.fill_stack, &node.stroke_stack]),
        Some(Kind::RestoreNode(value)) => value
            .node
            .as_ref()
            .map(|node| [&node.fill_stack, &node.stroke_stack]),
        Some(Kind::SetAppearance(value)) => Some([&value.fill_stack, &value.stroke_stack]),
        _ => None,
    };
    stacks
        .into_iter()
        .flatten()
        .filter_map(Option::as_ref)
        .flat_map(|stack| &stack.layers)
        .any(|layer| {
            matches!(&layer.kind, Some(v1::paint_layer::Kind::Image(image)) if image.filters.is_some())
        })
}

fn operation_has_text_truncation(operation: &v1::ResolvedOperation) -> bool {
    use v1::resolved_operation::Kind;
    let properties = match operation.kind.as_ref() {
        Some(Kind::CreateNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::RestoreNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::SetTextProperties(value)) => value.properties.as_ref(),
        _ => None,
    };
    properties.is_some_and(|value| value.text_truncation.is_some() || value.max_lines.is_some())
}

fn operation_has_text_run_paint_stack(operation: &v1::ResolvedOperation) -> bool {
    use v1::resolved_operation::Kind;
    let properties = match operation.kind.as_ref() {
        Some(Kind::CreateNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::RestoreNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::SetTextProperties(value)) => value.properties.as_ref(),
        _ => None,
    };
    properties.is_some_and(|value| {
        value.runs.iter().any(|run| run.fill_stack.is_some())
            || value
                .base_style
                .as_ref()
                .is_some_and(|style| style.fill_stack.is_some())
    })
}

fn operation_has_text_base_style(operation: &v1::ResolvedOperation) -> bool {
    use v1::resolved_operation::Kind;
    let properties = match operation.kind.as_ref() {
        Some(Kind::CreateNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::RestoreNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::SetTextProperties(value)) => value.properties.as_ref(),
        _ => None,
    };
    properties.is_some_and(|value| value.base_style.is_some())
}

fn operation_has_text_case(operation: &v1::ResolvedOperation) -> bool {
    use v1::resolved_operation::Kind;
    match operation.kind.as_ref() {
        Some(Kind::SetTextProperties(value)) => {
            value.properties.as_ref().is_some_and(|properties| {
                properties.runs.iter().any(|run| run.text_case.is_some())
                    || properties
                        .base_style
                        .as_ref()
                        .is_some_and(|style| style.text_case.is_some())
            })
        }
        _ => false,
    }
}

fn operation_has_hyperlink(operation: &v1::ResolvedOperation) -> bool {
    use v1::resolved_operation::Kind;
    let properties = match operation.kind.as_ref() {
        Some(Kind::CreateNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::RestoreNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::SetTextProperties(value)) => value.properties.as_ref(),
        _ => None,
    };
    properties.is_some_and(|properties| {
        properties.runs.iter().any(|run| run.hyperlink.is_some())
            || properties
                .base_style
                .as_ref()
                .is_some_and(|style| style.hyperlink.is_some())
    })
}

fn operation_has_text_decoration(operation: &v1::ResolvedOperation) -> bool {
    use v1::resolved_operation::Kind;
    let properties = match operation.kind.as_ref() {
        Some(Kind::CreateNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::RestoreNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::SetTextProperties(value)) => value.properties.as_ref(),
        _ => None,
    };
    properties.is_some_and(|properties| {
        properties
            .runs
            .iter()
            .any(|run| run.text_decoration.is_some())
            || properties
                .base_style
                .as_ref()
                .is_some_and(|style| style.text_decoration.is_some())
    })
}

fn operation_has_text_decoration_style(operation: &v1::ResolvedOperation) -> bool {
    use v1::resolved_operation::Kind;
    let properties = match operation.kind.as_ref() {
        Some(Kind::CreateNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::RestoreNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::SetTextProperties(value)) => value.properties.as_ref(),
        _ => None,
    };
    properties.is_some_and(|properties| {
        properties
            .runs
            .iter()
            .any(|run| run.text_decoration_style.is_some())
            || properties
                .base_style
                .as_ref()
                .is_some_and(|style| style.text_decoration_style.is_some())
    })
}

fn operation_has_text_decoration_offset(operation: &v1::ResolvedOperation) -> bool {
    use v1::resolved_operation::Kind;
    let properties = match operation.kind.as_ref() {
        Some(Kind::CreateNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::RestoreNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::SetTextProperties(value)) => value.properties.as_ref(),
        _ => None,
    };
    properties.is_some_and(|properties| {
        properties
            .runs
            .iter()
            .any(|run| run.text_decoration_offset.is_some())
            || properties
                .base_style
                .as_ref()
                .is_some_and(|style| style.text_decoration_offset.is_some())
    })
}

fn operation_has_text_decoration_thickness(operation: &v1::ResolvedOperation) -> bool {
    use v1::resolved_operation::Kind;
    let properties = match operation.kind.as_ref() {
        Some(Kind::CreateNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::RestoreNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::SetTextProperties(value)) => value.properties.as_ref(),
        _ => None,
    };
    properties.is_some_and(|properties| {
        properties
            .runs
            .iter()
            .any(|run| run.text_decoration_thickness.is_some())
            || properties
                .base_style
                .as_ref()
                .is_some_and(|style| style.text_decoration_thickness.is_some())
    })
}

fn operation_has_text_decoration_color(operation: &v1::ResolvedOperation) -> bool {
    use v1::resolved_operation::Kind;
    let properties = match operation.kind.as_ref() {
        Some(Kind::CreateNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::RestoreNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::SetTextProperties(value)) => value.properties.as_ref(),
        _ => None,
    };
    properties.is_some_and(|properties| {
        properties
            .runs
            .iter()
            .any(|run| run.text_decoration_color.is_some())
            || properties
                .base_style
                .as_ref()
                .is_some_and(|style| style.text_decoration_color.is_some())
    })
}

fn operation_has_text_decoration_skip_ink(operation: &v1::ResolvedOperation) -> bool {
    use v1::resolved_operation::Kind;
    let properties = match operation.kind.as_ref() {
        Some(Kind::CreateNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::RestoreNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::SetTextProperties(value)) => value.properties.as_ref(),
        _ => None,
    };
    properties.is_some_and(|properties| {
        properties
            .runs
            .iter()
            .any(|run| run.text_decoration_skip_ink == Some(true))
            || properties
                .base_style
                .as_ref()
                .is_some_and(|style| style.text_decoration_skip_ink == Some(true))
    })
}

fn operation_has_leading_trim(operation: &v1::ResolvedOperation) -> bool {
    use v1::resolved_operation::Kind;
    let properties = match operation.kind.as_ref() {
        Some(Kind::CreateNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::RestoreNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::SetTextProperties(value)) => value.properties.as_ref(),
        _ => None,
    };
    properties.is_some_and(|properties| {
        properties.runs.iter().any(|run| run.leading_trim.is_some())
            || properties
                .base_style
                .as_ref()
                .is_some_and(|style| style.leading_trim.is_some())
    })
}

fn operation_has_open_type_features(operation: &v1::ResolvedOperation) -> bool {
    operation_text_properties(operation).is_some_and(|properties| {
        properties
            .runs
            .iter()
            .any(|run| !run.open_type_features.is_empty())
            || properties
                .base_style
                .as_ref()
                .is_some_and(|style| !style.open_type_features.is_empty())
    })
}

fn operation_has_text_style_link(operation: &v1::ResolvedOperation) -> bool {
    operation_text_properties(operation).is_some_and(|properties| {
        properties
            .runs
            .iter()
            .any(|run| run.text_style_id.is_some())
            || properties
                .base_style
                .as_ref()
                .is_some_and(|style| style.text_style_id.is_some())
    })
}

fn operation_text_properties(operation: &v1::ResolvedOperation) -> Option<&v1::TextProperties> {
    use v1::resolved_operation::Kind;
    match operation.kind.as_ref() {
        Some(Kind::CreateNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::RestoreNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::SetTextProperties(value)) => value.properties.as_ref(),
        _ => None,
    }
}

fn open_type_features_from_proto(
    features: Vec<v1::OpenTypeFeatureSetting>,
) -> Vec<OpenTypeFeature> {
    features
        .into_iter()
        .map(|feature| OpenTypeFeature {
            tag: feature.tag,
            enabled: feature.enabled,
        })
        .collect()
}

fn operation_has_line_height_unit(operation: &v1::ResolvedOperation) -> bool {
    use v1::resolved_operation::Kind;
    let properties = match operation.kind.as_ref() {
        Some(Kind::CreateNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::RestoreNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::SetTextProperties(value)) => value.properties.as_ref(),
        _ => None,
    };
    properties.is_some_and(|properties| {
        properties
            .paragraph
            .as_ref()
            .is_some_and(|paragraph| paragraph.line_height_unit.is_some())
    })
}

fn operation_has_paragraph_indent(operation: &v1::ResolvedOperation) -> bool {
    use v1::resolved_operation::Kind;
    let properties = match operation.kind.as_ref() {
        Some(Kind::CreateNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::RestoreNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::SetTextProperties(value)) => value.properties.as_ref(),
        _ => None,
    };
    properties.is_some_and(|properties| {
        properties
            .paragraph
            .as_ref()
            .is_some_and(|paragraph| paragraph.paragraph_indent.is_some())
    })
}

fn operation_has_text_wrap_style(operation: &v1::ResolvedOperation) -> bool {
    use v1::resolved_operation::Kind;
    let properties = match operation.kind.as_ref() {
        Some(Kind::CreateNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::RestoreNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::SetTextProperties(value)) => value.properties.as_ref(),
        _ => None,
    };
    properties.is_some_and(|properties| {
        properties
            .paragraph
            .as_ref()
            .is_some_and(|paragraph| paragraph.text_wrap_style.is_some())
    })
}

fn operation_has_list_type(operation: &v1::ResolvedOperation) -> bool {
    use v1::resolved_operation::Kind;
    let properties = match operation.kind.as_ref() {
        Some(Kind::CreateNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::RestoreNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::SetTextProperties(value)) => value.properties.as_ref(),
        _ => None,
    };
    properties.is_some_and(|properties| {
        properties
            .paragraph
            .as_ref()
            .is_some_and(|paragraph| paragraph.list_type.is_some())
    })
}

fn operation_has_list_spacing(operation: &v1::ResolvedOperation) -> bool {
    use v1::resolved_operation::Kind;
    let properties = match operation.kind.as_ref() {
        Some(Kind::CreateNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::RestoreNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::SetTextProperties(value)) => value.properties.as_ref(),
        _ => None,
    };
    properties.is_some_and(|properties| {
        properties
            .paragraph
            .as_ref()
            .is_some_and(|paragraph| paragraph.list_spacing.is_some_and(|value| value != 0.0))
    })
}

fn operation_has_paragraph_style_runs(operation: &v1::ResolvedOperation) -> bool {
    use v1::resolved_operation::Kind;
    let properties = match operation.kind.as_ref() {
        Some(Kind::CreateNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::RestoreNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::SetTextProperties(value)) => value.properties.as_ref(),
        _ => None,
    };
    properties.is_some_and(|properties| !properties.paragraph_style_runs.is_empty())
}

fn operation_has_paragraph_list_options(operation: &v1::ResolvedOperation) -> bool {
    use v1::resolved_operation::Kind;
    let properties = match operation.kind.as_ref() {
        Some(Kind::CreateNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::RestoreNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::SetTextProperties(value)) => value.properties.as_ref(),
        _ => None,
    };
    properties.is_some_and(|properties| {
        properties
            .paragraph_style_runs
            .iter()
            .any(|run| run.list_type.is_some())
    })
}

fn operation_has_paragraph_list_spacing(operation: &v1::ResolvedOperation) -> bool {
    use v1::resolved_operation::Kind;
    let properties = match operation.kind.as_ref() {
        Some(Kind::CreateNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::RestoreNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::SetTextProperties(value)) => value.properties.as_ref(),
        _ => None,
    };
    properties.is_some_and(|properties| {
        properties
            .paragraph_style_runs
            .iter()
            .any(|run| run.list_spacing.is_some())
    })
}

fn operation_has_paragraph_spacing(operation: &v1::ResolvedOperation) -> bool {
    use v1::resolved_operation::Kind;
    let properties = match operation.kind.as_ref() {
        Some(Kind::CreateNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::RestoreNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::SetTextProperties(value)) => value.properties.as_ref(),
        _ => None,
    };
    properties.is_some_and(|properties| {
        properties
            .paragraph_style_runs
            .iter()
            .any(|run| run.paragraph_spacing.is_some())
    })
}

fn operation_has_paragraph_indent_run(operation: &v1::ResolvedOperation) -> bool {
    use v1::resolved_operation::Kind;
    let properties = match operation.kind.as_ref() {
        Some(Kind::CreateNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::RestoreNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::SetTextProperties(value)) => value.properties.as_ref(),
        _ => None,
    };
    properties.is_some_and(|properties| {
        properties
            .paragraph_style_runs
            .iter()
            .any(|run| run.paragraph_indent.is_some())
    })
}

fn operation_has_paragraph_line_height(operation: &v1::ResolvedOperation) -> bool {
    use v1::resolved_operation::Kind;
    let properties = match operation.kind.as_ref() {
        Some(Kind::CreateNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::RestoreNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::SetTextProperties(value)) => value.properties.as_ref(),
        _ => None,
    };
    properties.is_some_and(|properties| {
        properties
            .paragraph_style_runs
            .iter()
            .any(|run| run.line_height.is_some() || run.line_height_unit.is_some())
    })
}

fn operation_has_paragraph_text_wrap_style(operation: &v1::ResolvedOperation) -> bool {
    use v1::resolved_operation::Kind;
    let properties = match operation.kind.as_ref() {
        Some(Kind::CreateNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::RestoreNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::SetTextProperties(value)) => value.properties.as_ref(),
        _ => None,
    };
    properties.is_some_and(|properties| {
        properties
            .paragraph_style_runs
            .iter()
            .any(|run| run.text_wrap_style.is_some())
    })
}

fn operation_has_hanging_list(operation: &v1::ResolvedOperation) -> bool {
    use v1::resolved_operation::Kind;
    let properties = match operation.kind.as_ref() {
        Some(Kind::CreateNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::RestoreNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::SetTextProperties(value)) => value.properties.as_ref(),
        _ => None,
    };
    properties.is_some_and(|properties| {
        properties
            .paragraph
            .as_ref()
            .is_some_and(|paragraph| paragraph.hanging_list == Some(true))
    })
}

fn operation_has_hanging_punctuation(operation: &v1::ResolvedOperation) -> bool {
    use v1::resolved_operation::Kind;
    let properties = match operation.kind.as_ref() {
        Some(Kind::CreateNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::RestoreNode(value)) => value
            .node
            .as_ref()
            .and_then(|node| node.text_properties.as_ref()),
        Some(Kind::SetTextProperties(value)) => value.properties.as_ref(),
        _ => None,
    };
    properties.is_some_and(|properties| {
        properties
            .paragraph
            .as_ref()
            .is_some_and(|paragraph| paragraph.hanging_punctuation == Some(true))
    })
}

fn operation_has_pass_through(operation: &v1::ResolvedOperation) -> bool {
    use v1::resolved_operation::Kind;
    let value = match operation.kind.as_ref() {
        Some(Kind::CreateNode(operation)) => operation.node.as_ref().map(|node| node.blend_mode),
        Some(Kind::RestoreNode(operation)) => operation.node.as_ref().map(|node| node.blend_mode),
        Some(Kind::SetAppearance(operation)) => Some(operation.blend_mode),
        _ => None,
    };
    value.is_some_and(|value| {
        matches!(
            v1::BlendMode::try_from(value),
            Ok(v1::BlendMode::PassThrough)
        )
    })
}

fn operation_has_linear_blend(operation: &v1::ResolvedOperation) -> bool {
    use v1::resolved_operation::Kind;
    let (value, stacks) = match operation.kind.as_ref() {
        Some(Kind::CreateNode(operation)) => operation.node.as_ref().map_or((None, None), |node| {
            (
                Some(node.blend_mode),
                Some([&node.fill_stack, &node.stroke_stack]),
            )
        }),
        Some(Kind::RestoreNode(operation)) => {
            operation.node.as_ref().map_or((None, None), |node| {
                (
                    Some(node.blend_mode),
                    Some([&node.fill_stack, &node.stroke_stack]),
                )
            })
        }
        Some(Kind::SetAppearance(operation)) => (
            Some(operation.blend_mode),
            Some([&operation.fill_stack, &operation.stroke_stack]),
        ),
        _ => (None, None),
    };
    value.is_some_and(|value| {
        matches!(
            v1::BlendMode::try_from(value),
            Ok(v1::BlendMode::LinearBurn | v1::BlendMode::LinearDodge)
        )
    }) || stacks
        .into_iter()
        .flatten()
        .filter_map(Option::as_ref)
        .flat_map(|stack| &stack.layers)
        .any(|layer| {
            matches!(
                v1::BlendMode::try_from(layer.blend_mode),
                Ok(v1::BlendMode::LinearBurn | v1::BlendMode::LinearDodge)
            )
        })
}

fn operation_has_normal_blend_isolation(operation: &v1::ResolvedOperation) -> bool {
    use v1::resolved_operation::Kind;
    let extensions = match operation.kind.as_ref() {
        Some(Kind::CreateNode(value)) => value.node.as_ref().map(|node| &node.extensions),
        Some(Kind::RestoreNode(value)) => value.node.as_ref().map(|node| &node.extensions),
        Some(Kind::SetNodeExtensions(value)) => Some(&value.extensions),
        _ => None,
    };
    extensions.is_some_and(|extensions| {
        extensions
            .get(makefigma_document_codec::NORMAL_BLEND_ISOLATION_EXTENSION)
            .is_some_and(|value| value.as_slice() == [1])
    })
}

fn paint_stack_command(operation: &v1::ResolvedOperation) -> Result<Option<Command>, ServiceError> {
    use v1::resolved_operation::Kind;
    let (node_id, fill_stack, stroke_stack) = match operation.kind.as_ref() {
        Some(Kind::CreateNode(value)) => {
            let node = value.node.as_ref().ok_or(ServiceError::InvalidEnvelope)?;
            (
                node_id(&node.node_id)?,
                node.fill_stack.clone(),
                node.stroke_stack.clone(),
            )
        }
        Some(Kind::RestoreNode(value)) => {
            let node = value.node.as_ref().ok_or(ServiceError::InvalidEnvelope)?;
            (
                node_id(&node.node_id)?,
                node.fill_stack.clone(),
                node.stroke_stack.clone(),
            )
        }
        Some(Kind::SetAppearance(value)) => (
            node_id(&value.node_id)?,
            value.fill_stack.clone(),
            value.stroke_stack.clone(),
        ),
        _ => return Ok(None),
    };
    if fill_stack.is_none() && stroke_stack.is_none() {
        return Ok(None);
    }
    Ok(Some(Command::SetPaintStacks {
        id: node_id,
        fill_stack: fill_stack.map(paint_stack_from_proto).transpose()?,
        stroke_stack: stroke_stack.map(paint_stack_from_proto).transpose()?,
    }))
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
        Kind::UpdateGeometry(value) => {
            let id = node_id(&value.node_id)?;
            Ok(if value.ignore_constraints {
                Command::UpdateGeometryWithoutConstraints {
                    id,
                    x: value.x,
                    y: value.y,
                    width: value.width,
                    height: value.height,
                    rotation: value.rotation,
                }
            } else {
                Command::UpdateGeometry {
                    id,
                    x: value.x,
                    y: value.y,
                    width: value.width,
                    height: value.height,
                    rotation: value.rotation,
                }
            })
        }
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
        Kind::ConvertToTextPath(value) => Ok(Command::ConvertToTextPath {
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
        Kind::RegisterTextStyle(value) => Ok(Command::RegisterTextStyle {
            style: text_style_resource_from_proto(
                value.style.ok_or(ServiceError::InvalidEnvelope)?,
            )?,
        }),
        Kind::RegisterPaintStyle(value) => Ok(Command::RegisterPaintStyle {
            style: paint_style_resource_from_proto(
                value.style.ok_or(ServiceError::InvalidEnvelope)?,
            )?,
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
        v1::BlendMode::ColorDodge => Ok(BlendMode::ColorDodge),
        v1::BlendMode::ColorBurn => Ok(BlendMode::ColorBurn),
        v1::BlendMode::HardLight => Ok(BlendMode::HardLight),
        v1::BlendMode::SoftLight => Ok(BlendMode::SoftLight),
        v1::BlendMode::Difference => Ok(BlendMode::Difference),
        v1::BlendMode::Exclusion => Ok(BlendMode::Exclusion),
        v1::BlendMode::Hue => Ok(BlendMode::Hue),
        v1::BlendMode::Saturation => Ok(BlendMode::Saturation),
        v1::BlendMode::Color => Ok(BlendMode::Color),
        v1::BlendMode::Luminosity => Ok(BlendMode::Luminosity),
        v1::BlendMode::PassThrough => Ok(BlendMode::PassThrough),
        v1::BlendMode::LinearBurn => Ok(BlendMode::LinearBurn),
        v1::BlendMode::LinearDodge => Ok(BlendMode::LinearDodge),
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
                    fill_stack: run.fill_stack.map(paint_stack_from_proto).transpose()?,
                    text_case: run
                        .text_case
                        .map(text_case_from_proto)
                        .transpose()?
                        .flatten(),
                    hyperlink: run.hyperlink.map(hyperlink_from_proto).transpose()?,
                    text_decoration: run
                        .text_decoration
                        .map(text_decoration_from_proto)
                        .transpose()?
                        .flatten(),
                    text_decoration_style: run
                        .text_decoration_style
                        .map(text_decoration_style_from_proto)
                        .transpose()?
                        .flatten(),
                    text_decoration_offset: run
                        .text_decoration_offset
                        .map(text_decoration_offset_from_proto)
                        .transpose()?
                        .flatten(),
                    text_decoration_thickness: run
                        .text_decoration_thickness
                        .map(text_decoration_thickness_from_proto)
                        .transpose()?
                        .flatten(),
                    text_decoration_skip_ink: run.text_decoration_skip_ink.filter(|value| *value),
                    leading_trim: run
                        .leading_trim
                        .map(leading_trim_from_proto)
                        .transpose()?
                        .flatten(),
                    open_type_features: open_type_features_from_proto(run.open_type_features),
                    text_style_id: run.text_style_id,
                    text_decoration_color: run
                        .text_decoration_color
                        .map(text_decoration_color_from_proto)
                        .transpose()?,
                })
            })
            .collect::<Result<_, ServiceError>>()?,
        paragraph: ParagraphStyle {
            alignment,
            line_height: paragraph.line_height,
            line_height_unit: paragraph
                .line_height_unit
                .map(line_height_unit_from_proto)
                .transpose()?
                .flatten(),
            paragraph_spacing: paragraph.paragraph_spacing,
            paragraph_indent: paragraph.paragraph_indent,
            text_wrap_style: paragraph
                .text_wrap_style
                .map(text_wrap_style_from_proto)
                .transpose()?
                .flatten(),
            list_type: paragraph
                .list_type
                .map(text_list_type_from_proto)
                .transpose()?
                .flatten(),
            list_spacing: paragraph.list_spacing.filter(|value| *value != 0.0),
            hanging_list: paragraph.hanging_list.unwrap_or(false),
            hanging_punctuation: paragraph.hanging_punctuation.unwrap_or(false),
        },
        paragraph_style_runs: value
            .paragraph_style_runs
            .into_iter()
            .map(|run| {
                Ok(ParagraphStyleRun {
                    start: run.start,
                    indentation: run.indentation,
                    list_type: run
                        .list_type
                        .map(paragraph_list_type_from_proto)
                        .transpose()?,
                    list_spacing: run.list_spacing,
                    paragraph_spacing: run.paragraph_spacing,
                    paragraph_indent: run.paragraph_indent,
                    line_height: run.line_height,
                    line_height_unit: run
                        .line_height_unit
                        .map(line_height_unit_from_proto)
                        .transpose()?
                        .flatten(),
                    text_wrap_style: run
                        .text_wrap_style
                        .map(paragraph_text_wrap_style_from_proto)
                        .transpose()?,
                })
            })
            .collect::<Result<_, ServiceError>>()?,
        auto_size,
        text_truncation: match value.text_truncation {
            None => TextTruncation::Disabled,
            Some(raw) => match v1::TextTruncation::try_from(raw)
                .map_err(|_| ServiceError::InvalidEnvelope)?
            {
                v1::TextTruncation::Disabled => TextTruncation::Disabled,
                v1::TextTruncation::Ending => TextTruncation::Ending,
                v1::TextTruncation::Unspecified => return Err(ServiceError::InvalidEnvelope),
            },
        },
        max_lines: value.max_lines,
        base_style: value
            .base_style
            .map(|style| {
                Ok(TextStyleRun {
                    start: style.start,
                    end: style.end,
                    font: style.font.map(font_from_proto).transpose()?,
                    font_size: style.font_size,
                    font_weight: u16::try_from(style.font_weight)
                        .map_err(|_| ServiceError::InvalidEnvelope)?,
                    italic: style.italic,
                    letter_spacing: style.letter_spacing,
                    color: style.color.map(color_from_proto).transpose()?,
                    fill_stack: style.fill_stack.map(paint_stack_from_proto).transpose()?,
                    text_case: style
                        .text_case
                        .map(text_case_from_proto)
                        .transpose()?
                        .flatten(),
                    hyperlink: style.hyperlink.map(hyperlink_from_proto).transpose()?,
                    text_decoration: style
                        .text_decoration
                        .map(text_decoration_from_proto)
                        .transpose()?
                        .flatten(),
                    text_decoration_style: style
                        .text_decoration_style
                        .map(text_decoration_style_from_proto)
                        .transpose()?
                        .flatten(),
                    text_decoration_offset: style
                        .text_decoration_offset
                        .map(text_decoration_offset_from_proto)
                        .transpose()?
                        .flatten(),
                    text_decoration_thickness: style
                        .text_decoration_thickness
                        .map(text_decoration_thickness_from_proto)
                        .transpose()?
                        .flatten(),
                    text_decoration_skip_ink: style.text_decoration_skip_ink.filter(|value| *value),
                    leading_trim: style
                        .leading_trim
                        .map(leading_trim_from_proto)
                        .transpose()?
                        .flatten(),
                    open_type_features: open_type_features_from_proto(style.open_type_features),
                    text_style_id: style.text_style_id,
                    text_decoration_color: style
                        .text_decoration_color
                        .map(text_decoration_color_from_proto)
                        .transpose()?,
                })
            })
            .transpose()?,
        fallback_fonts: value
            .fallback_fonts
            .into_iter()
            .map(font_from_proto)
            .collect::<Result<_, ServiceError>>()?,
    })
}

fn text_style_resource_from_proto(
    resource: v1::TextStyleResource,
) -> Result<TextStyleResource, ServiceError> {
    let properties = text_properties_from_proto(v1::TextProperties {
        runs: Vec::new(),
        paragraph: resource.paragraph,
        auto_size: v1::TextAutoSize::Fixed as i32,
        fallback_fonts: Vec::new(),
        text_truncation: None,
        max_lines: None,
        base_style: resource.style,
        paragraph_style_runs: Vec::new(),
    })?;
    Ok(TextStyleResource {
        id: resource.id,
        key: resource.key,
        name: resource.name,
        description: resource.description,
        remote: resource.remote,
        style: properties.base_style.ok_or(ServiceError::InvalidEnvelope)?,
        paragraph: properties.paragraph,
    })
}

fn paint_style_resource_from_proto(
    resource: v1::PaintStyleResource,
) -> Result<PaintStyleResource, ServiceError> {
    Ok(PaintStyleResource {
        id: resource.id,
        key: resource.key,
        name: resource.name,
        description: resource.description,
        remote: resource.remote,
        paints: paint_stack_from_proto(resource.paints.ok_or(ServiceError::InvalidEnvelope)?)?,
    })
}

fn text_wrap_style_from_proto(value: i32) -> Result<Option<TextWrapStyle>, ServiceError> {
    match v1::TextWrapStyle::try_from(value).map_err(|_| ServiceError::InvalidEnvelope)? {
        v1::TextWrapStyle::Auto => Ok(None),
        v1::TextWrapStyle::Balance => Ok(Some(TextWrapStyle::Balance)),
        v1::TextWrapStyle::Pretty => Ok(Some(TextWrapStyle::Pretty)),
        v1::TextWrapStyle::Unspecified => Err(ServiceError::InvalidEnvelope),
    }
}

fn paragraph_text_wrap_style_from_proto(value: i32) -> Result<TextWrapStyle, ServiceError> {
    match v1::TextWrapStyle::try_from(value).map_err(|_| ServiceError::InvalidEnvelope)? {
        v1::TextWrapStyle::Auto => Ok(TextWrapStyle::Auto),
        v1::TextWrapStyle::Balance => Ok(TextWrapStyle::Balance),
        v1::TextWrapStyle::Pretty => Ok(TextWrapStyle::Pretty),
        v1::TextWrapStyle::Unspecified => Err(ServiceError::InvalidEnvelope),
    }
}

fn text_list_type_from_proto(value: i32) -> Result<Option<TextListType>, ServiceError> {
    match v1::TextListType::try_from(value).map_err(|_| ServiceError::InvalidEnvelope)? {
        v1::TextListType::None => Ok(None),
        v1::TextListType::Ordered => Ok(Some(TextListType::Ordered)),
        v1::TextListType::Unordered => Ok(Some(TextListType::Unordered)),
        v1::TextListType::Unspecified => Err(ServiceError::InvalidEnvelope),
    }
}

fn paragraph_list_type_from_proto(value: i32) -> Result<ParagraphListType, ServiceError> {
    match v1::TextListType::try_from(value).map_err(|_| ServiceError::InvalidEnvelope)? {
        v1::TextListType::None => Ok(ParagraphListType::None),
        v1::TextListType::Ordered => Ok(ParagraphListType::Ordered),
        v1::TextListType::Unordered => Ok(ParagraphListType::Unordered),
        v1::TextListType::Unspecified => Err(ServiceError::InvalidEnvelope),
    }
}

fn hyperlink_from_proto(value: v1::HyperlinkTarget) -> Result<HyperlinkTarget, ServiceError> {
    let kind = match v1::HyperlinkType::try_from(value.r#type)
        .map_err(|_| ServiceError::InvalidEnvelope)?
    {
        v1::HyperlinkType::Url => HyperlinkType::Url,
        v1::HyperlinkType::Node => HyperlinkType::Node,
        v1::HyperlinkType::Unspecified => return Err(ServiceError::InvalidEnvelope),
    };
    Ok(HyperlinkTarget {
        kind,
        value: value.value,
    })
}

fn leading_trim_from_proto(value: i32) -> Result<Option<LeadingTrim>, ServiceError> {
    match v1::LeadingTrim::try_from(value).map_err(|_| ServiceError::InvalidEnvelope)? {
        v1::LeadingTrim::CapHeight => Ok(Some(LeadingTrim::CapHeight)),
        v1::LeadingTrim::None | v1::LeadingTrim::Unspecified => Ok(None),
    }
}

fn text_decoration_from_proto(value: i32) -> Result<Option<TextDecoration>, ServiceError> {
    Ok(Some(
        match v1::TextDecoration::try_from(value).map_err(|_| ServiceError::InvalidEnvelope)? {
            v1::TextDecoration::Underline => TextDecoration::Underline,
            v1::TextDecoration::Strikethrough => TextDecoration::Strikethrough,
            v1::TextDecoration::Unspecified => return Ok(None),
        },
    ))
}

fn text_decoration_style_from_proto(
    value: i32,
) -> Result<Option<TextDecorationStyle>, ServiceError> {
    match v1::TextDecorationStyle::try_from(value).map_err(|_| ServiceError::InvalidEnvelope)? {
        v1::TextDecorationStyle::Wavy => Ok(Some(TextDecorationStyle::Wavy)),
        v1::TextDecorationStyle::Dotted => Ok(Some(TextDecorationStyle::Dotted)),
        v1::TextDecorationStyle::Unspecified | v1::TextDecorationStyle::Solid => Ok(None),
    }
}

fn text_decoration_offset_from_proto(
    value: v1::TextDecorationOffset,
) -> Result<Option<TextDecorationOffset>, ServiceError> {
    match v1::TextDecorationOffsetUnit::try_from(value.unit)
        .map_err(|_| ServiceError::InvalidEnvelope)?
    {
        v1::TextDecorationOffsetUnit::Pixels => Ok(Some(TextDecorationOffset::Pixels(value.value))),
        v1::TextDecorationOffsetUnit::Percent => {
            Ok(Some(TextDecorationOffset::Percent(value.value)))
        }
        v1::TextDecorationOffsetUnit::Auto if value.value == 0.0 => Ok(None),
        v1::TextDecorationOffsetUnit::Auto | v1::TextDecorationOffsetUnit::Unspecified => {
            Err(ServiceError::InvalidEnvelope)
        }
    }
}

fn text_decoration_thickness_from_proto(
    value: v1::TextDecorationThickness,
) -> Result<Option<TextDecorationThickness>, ServiceError> {
    match v1::TextDecorationThicknessUnit::try_from(value.unit)
        .map_err(|_| ServiceError::InvalidEnvelope)?
    {
        v1::TextDecorationThicknessUnit::Pixels => {
            Ok(Some(TextDecorationThickness::Pixels(value.value)))
        }
        v1::TextDecorationThicknessUnit::Percent => {
            Ok(Some(TextDecorationThickness::Percent(value.value)))
        }
        v1::TextDecorationThicknessUnit::Auto if value.value == 0.0 => Ok(None),
        v1::TextDecorationThicknessUnit::Auto | v1::TextDecorationThicknessUnit::Unspecified => {
            Err(ServiceError::InvalidEnvelope)
        }
    }
}

fn text_decoration_color_from_proto(
    value: v1::TextDecorationColor,
) -> Result<TextDecorationColor, ServiceError> {
    let blend_mode = blend_mode_from_proto(value.blend_mode)?;
    if matches!(blend_mode, BlendMode::PassThrough) {
        return Err(ServiceError::InvalidEnvelope);
    }
    Ok(TextDecorationColor {
        color: color_from_proto(value.color.ok_or(ServiceError::InvalidEnvelope)?)?,
        visible: value.visible,
        opacity: value.opacity,
        blend_mode,
    })
}

fn line_height_unit_from_proto(value: i32) -> Result<Option<LineHeightUnit>, ServiceError> {
    match v1::LineHeightUnit::try_from(value).map_err(|_| ServiceError::InvalidEnvelope)? {
        v1::LineHeightUnit::Pixels => Ok(None),
        v1::LineHeightUnit::Percent => Ok(Some(LineHeightUnit::Percent)),
        v1::LineHeightUnit::Auto => Ok(Some(LineHeightUnit::Auto)),
        v1::LineHeightUnit::Unspecified => Err(ServiceError::InvalidEnvelope),
    }
}

fn text_case_from_proto(value: i32) -> Result<Option<TextCase>, ServiceError> {
    match v1::TextCase::try_from(value).map_err(|_| ServiceError::InvalidEnvelope)? {
        v1::TextCase::Original => Ok(None),
        v1::TextCase::Upper => Ok(Some(TextCase::Upper)),
        v1::TextCase::Lower => Ok(Some(TextCase::Lower)),
        v1::TextCase::Title => Ok(Some(TextCase::Title)),
        v1::TextCase::SmallCaps => Ok(Some(TextCase::SmallCaps)),
        v1::TextCase::SmallCapsForced => Ok(Some(TextCase::SmallCapsForced)),
        v1::TextCase::Unspecified => Err(ServiceError::InvalidEnvelope),
    }
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

fn paint_stack_from_proto(stack: v1::PaintStack) -> Result<PaintStack, ServiceError> {
    let stack = PaintStack {
        layers: stack
            .layers
            .into_iter()
            .map(paint_layer_from_proto)
            .collect::<Result<Vec<_>, _>>()?,
    };
    stack
        .is_valid()
        .then_some(stack)
        .ok_or(ServiceError::InvalidEnvelope)
}

fn gradient_paint_from_proto(gradient: v1::GradientPaint) -> Result<GradientPaint, ServiceError> {
    let kind = match v1::GradientPaintKind::try_from(gradient.kind)
        .map_err(|_| ServiceError::InvalidEnvelope)?
    {
        v1::GradientPaintKind::Radial => GradientPaintKind::Radial,
        v1::GradientPaintKind::Angular => GradientPaintKind::Angular,
        v1::GradientPaintKind::Diamond => GradientPaintKind::Diamond,
        v1::GradientPaintKind::Unspecified => return Err(ServiceError::InvalidEnvelope),
    };
    GradientPaint::new(
        kind,
        transform_from_proto(gradient.transform.ok_or(ServiceError::InvalidEnvelope)?)?,
        gradient
            .stops
            .into_iter()
            .map(|stop| {
                Ok(GradientStop {
                    position: stop.position,
                    color: color_from_proto(stop.color.ok_or(ServiceError::InvalidEnvelope)?)?,
                })
            })
            .collect::<Result<Vec<_>, ServiceError>>()?,
    )
    .map_err(|_| ServiceError::InvalidEnvelope)
}

fn paint_layer_from_proto(layer: v1::PaintLayer) -> Result<PaintLayer, ServiceError> {
    use v1::paint_layer::Kind;
    let paint = match layer.kind.ok_or(ServiceError::InvalidEnvelope)? {
        Kind::Solid(color) => PaintLayerKind::Solid(color_from_proto(color)?),
        Kind::LinearGradient(gradient) => PaintLayerKind::LinearGradient(
            match paint_from_proto(v1::Paint {
                kind: Some(v1::paint::Kind::LinearGradient(gradient)),
            })? {
                Paint::LinearGradient(gradient) => gradient,
                Paint::Solid(_) => unreachable!("linear gradient tag is stable"),
            },
        ),
        Kind::Image(image) => PaintLayerKind::Image(ImagePaint {
            asset_id: AssetId(id(&image.asset_id)?),
            scale_mode: match v1::ImageScaleMode::try_from(image.scale_mode)
                .map_err(|_| ServiceError::InvalidEnvelope)?
            {
                v1::ImageScaleMode::Fill => ImageScaleMode::Fill,
                v1::ImageScaleMode::Fit => ImageScaleMode::Fit,
                v1::ImageScaleMode::Crop => ImageScaleMode::Crop,
                v1::ImageScaleMode::Tile => ImageScaleMode::Tile,
                v1::ImageScaleMode::Unspecified => return Err(ServiceError::InvalidEnvelope),
            },
            transform: transform_from_proto(image.transform.ok_or(ServiceError::InvalidEnvelope)?)?,
            rotation_degrees: i16::try_from(image.rotation_degrees)
                .map_err(|_| ServiceError::InvalidEnvelope)?,
            filters: image.filters.map(image_filters_from_proto),
        }),
        Kind::Gradient(gradient) => PaintLayerKind::Gradient(gradient_paint_from_proto(gradient)?),
    };
    let layer = PaintLayer {
        paint,
        visible: layer.visible,
        opacity: layer.opacity,
        blend_mode: blend_mode_from_proto(layer.blend_mode)?,
    };
    layer
        .is_valid()
        .then_some(layer)
        .ok_or(ServiceError::InvalidEnvelope)
}

fn image_filters_from_proto(filters: v1::ImageFilters) -> ImageFilters {
    ImageFilters {
        exposure: filters.exposure,
        contrast: filters.contrast,
        saturation: filters.saturation,
        temperature: filters.temperature,
        tint: filters.tint,
        highlights: filters.highlights,
        shadows: filters.shadows,
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
                    .map(|alias| FontNameAlias {
                        family: alias.family,
                        style: alias.style,
                    })
                    .collect(),
            })
            .collect(),
    })
}

fn operation_has_font_face_metadata(operation: &v1::ResolvedOperation) -> bool {
    matches!(
        operation.kind.as_ref(),
        Some(v1::resolved_operation::Kind::RegisterResource(value))
            if value.resource.as_ref().is_some_and(|resource| !resource.font_faces.is_empty())
    )
}

fn operation_has_font_name_aliases(operation: &v1::ResolvedOperation) -> bool {
    matches!(
        operation.kind.as_ref(),
        Some(v1::resolved_operation::Kind::RegisterResource(value))
            if value.resource.as_ref().is_some_and(|resource| {
                resource.font_faces.iter().any(|face| !face.aliases.is_empty())
            })
    )
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
        Command, Document, HyperlinkType, LeadingTrim, LineHeightUnit, Origin, ParagraphListType,
        ParagraphStyleRun, PointId, TextDecoration, TextDecorationColor, TextDecorationOffset,
        TextDecorationStyle, TextDecorationThickness, TextListType, TextTruncation, TextWrapStyle,
        Transaction, TransactionId, geometry::Point,
    };
    use makefigma_protocol::v1;
    use prost::Message;

    use super::{commands_from_payload, commands_from_payload_with_semantics};
    use crate::ServiceError;

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
    fn non_linear_gradient_operations_require_semantics_five() {
        let gradient = v1::GradientPaint {
            kind: v1::GradientPaintKind::Angular as i32,
            transform: Some(v1::Transform {
                a: 1.25,
                b: 0.1,
                c: -0.2,
                d: 1.5,
                e: -0.1,
                f: 0.2,
            }),
            stops: vec![
                v1::GradientStop {
                    position: 0.0,
                    color: Some(color()),
                },
                v1::GradientStop {
                    position: 1.0,
                    color: Some(color()),
                },
            ],
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetAppearance(
                    v1::AppearanceUpdate {
                        node_id: 7_u128.to_be_bytes().to_vec(),
                        fill: Some(paint()),
                        stroke: Some(paint()),
                        opacity: 1.0,
                        visible: true,
                        stroke_cap_start: v1::StrokeCap::None as i32,
                        stroke_cap_end: v1::StrokeCap::None as i32,
                        stroke_join: v1::StrokeJoin::Miter as i32,
                        stroke_align: v1::StrokeAlign::Inside as i32,
                        blend_mode: v1::BlendMode::Normal as i32,
                        fill_stack: Some(v1::PaintStack {
                            layers: vec![v1::PaintLayer {
                                visible: true,
                                opacity: 1.0,
                                blend_mode: v1::BlendMode::Normal as i32,
                                kind: Some(v1::paint_layer::Kind::Gradient(gradient)),
                            }],
                        }),
                        ..Default::default()
                    },
                )),
            }],
        }
        .encode_to_vec();

        assert!(matches!(
            commands_from_payload_with_semantics(&payload, makefigma_document_codec::NON_LINEAR_GRADIENT_ENGINE_SEMANTICS_VERSION - 1),
            Err(ServiceError::EngineSemanticsUnsupported { minimum })
                if minimum == makefigma_document_codec::NON_LINEAR_GRADIENT_ENGINE_SEMANTICS_VERSION
        ));
        assert!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::NON_LINEAR_GRADIENT_ENGINE_SEMANTICS_VERSION,
            )
            .is_ok()
        );
    }

    #[test]
    fn advanced_blend_operations_require_semantics_six() {
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetAppearance(
                    v1::AppearanceUpdate {
                        node_id: 8_u128.to_be_bytes().to_vec(),
                        fill: Some(paint()),
                        stroke: Some(paint()),
                        opacity: 1.0,
                        visible: true,
                        stroke_cap_start: v1::StrokeCap::None as i32,
                        stroke_cap_end: v1::StrokeCap::None as i32,
                        stroke_join: v1::StrokeJoin::Miter as i32,
                        stroke_align: v1::StrokeAlign::Inside as i32,
                        blend_mode: v1::BlendMode::Luminosity as i32,
                        ..Default::default()
                    },
                )),
            }],
        }
        .encode_to_vec();

        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::ADVANCED_BLEND_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(ServiceError::EngineSemanticsUnsupported { minimum })
                if minimum == makefigma_document_codec::ADVANCED_BLEND_ENGINE_SEMANTICS_VERSION
        ));
        assert!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::ADVANCED_BLEND_ENGINE_SEMANTICS_VERSION,
            )
            .is_ok()
        );
    }

    #[test]
    fn image_rotation_operations_require_semantics_seven() {
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetAppearance(
                    v1::AppearanceUpdate {
                        node_id: 9_u128.to_be_bytes().to_vec(),
                        fill: Some(paint()),
                        stroke: Some(paint()),
                        opacity: 1.0,
                        visible: true,
                        stroke_cap_start: v1::StrokeCap::None as i32,
                        stroke_cap_end: v1::StrokeCap::None as i32,
                        stroke_join: v1::StrokeJoin::Miter as i32,
                        stroke_align: v1::StrokeAlign::Inside as i32,
                        fill_stack: Some(v1::PaintStack {
                            layers: vec![v1::PaintLayer {
                                kind: Some(v1::paint_layer::Kind::Image(v1::ImagePaint {
                                    asset_id: 90_u128.to_be_bytes().to_vec(),
                                    scale_mode: v1::ImageScaleMode::Fill as i32,
                                    transform: Some(v1::Transform {
                                        a: 1.0,
                                        b: 0.0,
                                        c: 0.0,
                                        d: 1.0,
                                        e: 0.0,
                                        f: 0.0,
                                    }),
                                    rotation_degrees: 90,
                                    filters: None,
                                })),
                                visible: true,
                                opacity: 1.0,
                                blend_mode: v1::BlendMode::Normal as i32,
                            }],
                        }),
                        ..Default::default()
                    },
                )),
            }],
        }
        .encode_to_vec();

        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::IMAGE_PAINT_ROTATION_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(ServiceError::EngineSemanticsUnsupported { minimum })
                if minimum == makefigma_document_codec::IMAGE_PAINT_ROTATION_ENGINE_SEMANTICS_VERSION
        ));
        assert!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::IMAGE_PAINT_ROTATION_ENGINE_SEMANTICS_VERSION,
            )
            .is_ok()
        );

        let mut filtered = v1::ResolvedOperationBatch::decode(payload.as_slice()).unwrap();
        let Some(v1::resolved_operation::Kind::SetAppearance(appearance)) =
            filtered.operations[0].kind.as_mut()
        else {
            unreachable!()
        };
        let Some(v1::paint_layer::Kind::Image(image)) =
            appearance.fill_stack.as_mut().unwrap().layers[0]
                .kind
                .as_mut()
        else {
            unreachable!()
        };
        image.rotation_degrees = 0;
        image.filters = Some(v1::ImageFilters {
            exposure: Some(0.25),
            shadows: Some(-0.5),
            ..Default::default()
        });
        let filtered_payload = filtered.encode_to_vec();
        assert!(matches!(
            commands_from_payload_with_semantics(
                &filtered_payload,
                makefigma_document_codec::IMAGE_FILTERS_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(ServiceError::EngineSemanticsUnsupported { minimum })
                if minimum == makefigma_document_codec::IMAGE_FILTERS_ENGINE_SEMANTICS_VERSION
        ));
        assert!(
            commands_from_payload_with_semantics(
                &filtered_payload,
                makefigma_document_codec::IMAGE_FILTERS_ENGINE_SEMANTICS_VERSION,
            )
            .is_ok()
        );
    }

    #[test]
    fn pass_through_operations_require_semantics_eight() {
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetAppearance(
                    v1::AppearanceUpdate {
                        node_id: 10_u128.to_be_bytes().to_vec(),
                        fill: Some(paint()),
                        stroke: Some(paint()),
                        opacity: 1.0,
                        visible: true,
                        stroke_cap_start: v1::StrokeCap::None as i32,
                        stroke_cap_end: v1::StrokeCap::None as i32,
                        stroke_join: v1::StrokeJoin::Miter as i32,
                        stroke_align: v1::StrokeAlign::Inside as i32,
                        blend_mode: v1::BlendMode::PassThrough as i32,
                        ..Default::default()
                    },
                )),
            }],
        }
        .encode_to_vec();

        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::PASS_THROUGH_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(ServiceError::EngineSemanticsUnsupported { minimum })
                if minimum == makefigma_document_codec::PASS_THROUGH_ENGINE_SEMANTICS_VERSION
        ));
        assert!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::PASS_THROUGH_ENGINE_SEMANTICS_VERSION,
            )
            .is_ok()
        );
    }

    #[test]
    fn linear_blend_operations_require_semantics_nine() {
        for blend_mode in [v1::BlendMode::LinearBurn, v1::BlendMode::LinearDodge] {
            let payload = v1::ResolvedOperationBatch {
                operations: vec![v1::ResolvedOperation {
                    kind: Some(v1::resolved_operation::Kind::SetAppearance(
                        v1::AppearanceUpdate {
                            node_id: 10_u128.to_be_bytes().to_vec(),
                            fill: Some(paint()),
                            stroke: Some(paint()),
                            opacity: 1.0,
                            visible: true,
                            stroke_cap_start: v1::StrokeCap::None as i32,
                            stroke_cap_end: v1::StrokeCap::None as i32,
                            stroke_join: v1::StrokeJoin::Miter as i32,
                            stroke_align: v1::StrokeAlign::Inside as i32,
                            blend_mode: blend_mode as i32,
                            ..Default::default()
                        },
                    )),
                }],
            }
            .encode_to_vec();

            assert!(matches!(
                commands_from_payload_with_semantics(
                    &payload,
                    makefigma_document_codec::LINEAR_BLEND_ENGINE_SEMANTICS_VERSION - 1,
                ),
                Err(ServiceError::EngineSemanticsUnsupported { minimum })
                    if minimum == makefigma_document_codec::LINEAR_BLEND_ENGINE_SEMANTICS_VERSION
            ));
            assert!(
                commands_from_payload_with_semantics(
                    &payload,
                    makefigma_document_codec::LINEAR_BLEND_ENGINE_SEMANTICS_VERSION,
                )
                .is_ok()
            );
        }

        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetAppearance(
                    v1::AppearanceUpdate {
                        node_id: 10_u128.to_be_bytes().to_vec(),
                        fill: Some(paint()),
                        stroke: Some(paint()),
                        opacity: 1.0,
                        visible: true,
                        stroke_cap_start: v1::StrokeCap::None as i32,
                        stroke_cap_end: v1::StrokeCap::None as i32,
                        stroke_join: v1::StrokeJoin::Miter as i32,
                        stroke_align: v1::StrokeAlign::Inside as i32,
                        blend_mode: v1::BlendMode::Normal as i32,
                        fill_stack: Some(v1::PaintStack {
                            layers: vec![v1::PaintLayer {
                                kind: Some(v1::paint_layer::Kind::Solid(color())),
                                visible: true,
                                opacity: 0.75,
                                blend_mode: v1::BlendMode::LinearDodge as i32,
                            }],
                        }),
                        ..Default::default()
                    },
                )),
            }],
        }
        .encode_to_vec();
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::LINEAR_BLEND_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(ServiceError::EngineSemanticsUnsupported { minimum })
                if minimum == makefigma_document_codec::LINEAR_BLEND_ENGINE_SEMANTICS_VERSION
        ));
        assert!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::LINEAR_BLEND_ENGINE_SEMANTICS_VERSION,
            )
            .is_ok()
        );
    }

    #[test]
    fn isolated_normal_extension_operations_require_semantics_ten() {
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetNodeExtensions(
                    v1::SetNodeExtensions {
                        node_id: 10_u128.to_be_bytes().to_vec(),
                        extensions: [(
                            makefigma_document_codec::NORMAL_BLEND_ISOLATION_EXTENSION.to_string(),
                            vec![1],
                        )]
                        .into_iter()
                        .collect(),
                    },
                )),
            }],
        }
        .encode_to_vec();

        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::NORMAL_BLEND_ISOLATION_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(ServiceError::EngineSemanticsUnsupported { minimum })
                if minimum == makefigma_document_codec::NORMAL_BLEND_ISOLATION_ENGINE_SEMANTICS_VERSION
        ));
        assert!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::NORMAL_BLEND_ISOLATION_ENGINE_SEMANTICS_VERSION,
            )
            .is_ok()
        );

        let malformed = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetNodeExtensions(
                    v1::SetNodeExtensions {
                        node_id: 10_u128.to_be_bytes().to_vec(),
                        extensions: [(
                            makefigma_document_codec::NORMAL_BLEND_ISOLATION_EXTENSION.to_string(),
                            vec![2],
                        )]
                        .into_iter()
                        .collect(),
                    },
                )),
            }],
        }
        .encode_to_vec();
        assert!(
            commands_from_payload_with_semantics(
                &malformed,
                makefigma_document_codec::NORMAL_BLEND_ISOLATION_ENGINE_SEMANTICS_VERSION - 1,
            )
            .is_ok()
        );
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
            fill_stack: Some(v1::PaintStack { layers: Vec::new() }),
            stroke_stack: None,
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
                            fill_stack: None,
                            stroke_stack: None,
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
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::PAINT_STACK_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(ServiceError::EngineSemanticsUnsupported { minimum })
                if minimum == makefigma_document_codec::PAINT_STACK_ENGINE_SEMANTICS_VERSION
        ));
        assert!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::PAINT_STACK_ENGINE_SEMANTICS_VERSION,
            )
            .is_ok()
        );
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
        assert_eq!(
            document.fill_stack_for_node(editor_core::NodeId(7)),
            Some(&editor_core::color::PaintStack::default())
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
                            font_faces: Vec::new(),
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
    fn localized_font_aliases_require_semantics_v41_and_reach_core() {
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::RegisterResource(
                    v1::RegisterResource {
                        resource: Some(v1::ResourceIndexEntry {
                            asset_id: 10_u128.to_be_bytes().to_vec(),
                            content_hash: vec![5; 32],
                            media_type: "font/ttf".into(),
                            byte_length: Some(512),
                            pixel_width: None,
                            pixel_height: None,
                            font_faces: vec![v1::FontFaceMetadata {
                                face_index: 0,
                                family: "Acme Sans".into(),
                                style: "Regular".into(),
                                aliases: vec![v1::FontNameAlias {
                                    family: "思源黑体".into(),
                                    style: "常规".into(),
                                }],
                            }],
                        }),
                    },
                )),
            }],
        }
        .encode_to_vec();
        assert_eq!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::FONT_FACE_METADATA_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(ServiceError::EngineSemanticsUnsupported {
                minimum: makefigma_document_codec::FONT_FACE_METADATA_ENGINE_SEMANTICS_VERSION,
            })
        );
        let commands = commands_from_payload_with_semantics(
            &payload,
            makefigma_document_codec::FONT_NAME_ALIASES_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        let Command::RegisterAsset { asset } = &commands[0] else {
            panic!("expected font resource registration");
        };
        assert_eq!(asset.font_faces[0].family, "Acme Sans");
        assert_eq!(asset.font_faces[0].aliases[0].family, "思源黑体");
        assert_eq!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::FONT_NAME_ALIASES_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(ServiceError::EngineSemanticsUnsupported {
                minimum: makefigma_document_codec::FONT_NAME_ALIASES_ENGINE_SEMANTICS_VERSION,
            })
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

    #[test]
    fn geometry_ignore_constraints_maps_to_the_distinct_core_intent() {
        let operation = |ignore_constraints| v1::ResolvedOperation {
            kind: Some(v1::resolved_operation::Kind::UpdateGeometry(
                v1::GeometryUpdate {
                    node_id: 7_u128.to_be_bytes().to_vec(),
                    x: 10.0,
                    y: 20.0,
                    width: 300.0,
                    height: 200.0,
                    rotation: 15.0,
                    ignore_constraints,
                },
            )),
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![operation(false), operation(true)],
        }
        .encode_to_vec();

        assert!(matches!(
            commands_from_payload(&payload).unwrap().as_slice(),
            [
                Command::UpdateGeometry { id: editor_core::NodeId(7), width, .. },
                Command::UpdateGeometryWithoutConstraints { id: editor_core::NodeId(7), height, .. },
            ] if *width == 300.0 && *height == 200.0
        ));
    }

    #[test]
    fn text_truncation_operations_require_semantics_twelve() {
        let properties = v1::TextProperties {
            runs: vec![],
            paragraph: Some(v1::ParagraphStyle {
                alignment: v1::TextAlignment::Left as i32,
                line_height: Some(20.0),
                line_height_unit: None,
                paragraph_spacing: 0.0,
                paragraph_indent: None,
                text_wrap_style: None,
                list_type: None,
                list_spacing: None,
                hanging_list: None,
                hanging_punctuation: None,
            }),
            auto_size: v1::TextAutoSize::Fixed as i32,
            fallback_fonts: vec![],
            text_truncation: Some(v1::TextTruncation::Ending as i32),
            max_lines: Some(2),
            base_style: None,
            paragraph_style_runs: vec![],
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetTextProperties(
                    v1::SetTextProperties {
                        node_id: 7_u128.to_be_bytes().to_vec(),
                        properties: Some(properties),
                    },
                )),
            }],
        }
        .encode_to_vec();

        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::TEXT_TRUNCATION_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(ServiceError::EngineSemanticsUnsupported { minimum })
                if minimum == makefigma_document_codec::TEXT_TRUNCATION_ENGINE_SEMANTICS_VERSION
        ));
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::TEXT_TRUNCATION_ENGINE_SEMANTICS_VERSION,
            ).unwrap().as_slice(),
            [Command::SetTextProperties { properties, .. }]
                if properties.text_truncation == TextTruncation::Ending && properties.max_lines == Some(2)
        ));
    }

    #[test]
    fn text_run_paint_stack_operations_require_semantics_fourteen() {
        let properties = v1::TextProperties {
            runs: vec![v1::TextStyleRun {
                start: 0,
                end: 2,
                font_size: 16.0,
                font_weight: 500,
                fill_stack: Some(v1::PaintStack { layers: vec![] }),

                text_case: None,
                hyperlink: None,
                text_decoration: None,
                text_decoration_style: None,
                text_decoration_offset: None,
                text_decoration_thickness: None,
                text_decoration_skip_ink: None,
                leading_trim: None,
                open_type_features: Vec::new(),
                text_style_id: None,
                text_decoration_color: None,
                ..Default::default()
            }],
            paragraph: Some(v1::ParagraphStyle {
                alignment: v1::TextAlignment::Left as i32,
                line_height: Some(20.0),
                line_height_unit: None,
                paragraph_spacing: 0.0,
                paragraph_indent: None,
                text_wrap_style: None,
                list_type: None,
                list_spacing: None,
                hanging_list: None,
                hanging_punctuation: None,
            }),
            auto_size: v1::TextAutoSize::Fixed as i32,
            fallback_fonts: vec![],
            text_truncation: None,
            max_lines: None,
            base_style: None,
            paragraph_style_runs: vec![],
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetTextProperties(
                    v1::SetTextProperties {
                        node_id: 7_u128.to_be_bytes().to_vec(),
                        properties: Some(properties),
                    },
                )),
            }],
        }
        .encode_to_vec();

        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::TEXT_RUN_PAINT_STACK_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(ServiceError::EngineSemanticsUnsupported { minimum })
                if minimum == makefigma_document_codec::TEXT_RUN_PAINT_STACK_ENGINE_SEMANTICS_VERSION
        ));
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::TEXT_RUN_PAINT_STACK_ENGINE_SEMANTICS_VERSION,
            ).unwrap().as_slice(),
            [Command::SetTextProperties { properties, .. }]
                if properties.runs[0].fill_stack == Some(editor_core::color::PaintStack::default())
        ));
    }

    #[test]
    fn empty_text_base_style_operations_require_semantics_fifteen() {
        let properties = v1::TextProperties {
            runs: vec![],
            paragraph: Some(v1::ParagraphStyle {
                alignment: v1::TextAlignment::Left as i32,
                line_height: Some(20.0),
                line_height_unit: None,
                paragraph_spacing: 0.0,
                paragraph_indent: None,
                text_wrap_style: None,
                list_type: None,
                list_spacing: None,
                hanging_list: None,
                hanging_punctuation: None,
            }),
            auto_size: v1::TextAutoSize::Fixed as i32,
            fallback_fonts: vec![],
            text_truncation: None,
            max_lines: None,
            base_style: Some(v1::TextStyleRun {
                font_size: 22.0,
                font_weight: 600,
                italic: true,
                letter_spacing: 1.25,
                fill_stack: Some(v1::PaintStack { layers: vec![] }),

                text_case: None,
                hyperlink: None,
                text_decoration: None,
                text_decoration_style: None,
                text_decoration_offset: None,
                text_decoration_thickness: None,
                text_decoration_skip_ink: None,
                leading_trim: None,
                open_type_features: Vec::new(),
                text_style_id: None,
                text_decoration_color: None,
                ..Default::default()
            }),
            paragraph_style_runs: vec![],
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetTextProperties(
                    v1::SetTextProperties {
                        node_id: 7_u128.to_be_bytes().to_vec(),
                        properties: Some(properties),
                    },
                )),
            }],
        }
        .encode_to_vec();

        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::TEXT_BASE_STYLE_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(ServiceError::EngineSemanticsUnsupported { minimum })
                if minimum == makefigma_document_codec::TEXT_BASE_STYLE_ENGINE_SEMANTICS_VERSION
        ));
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::TEXT_BASE_STYLE_ENGINE_SEMANTICS_VERSION,
            ).unwrap().as_slice(),
            [Command::SetTextProperties { properties, .. }]
                if properties.base_style.as_ref().is_some_and(|style| style.font_size == 22.0 && style.start == 0 && style.end == 0)
        ));
    }

    #[test]
    fn text_case_operations_require_semantics_sixteen() {
        let properties = v1::TextProperties {
            runs: vec![v1::TextStyleRun {
                start: 0,
                end: 4,
                font_size: 16.0,
                font_weight: 400,
                text_case: Some(v1::TextCase::SmallCapsForced as i32),
                hyperlink: None,
                text_decoration: None,
                text_decoration_style: None,
                text_decoration_offset: None,
                text_decoration_thickness: None,
                text_decoration_skip_ink: None,
                leading_trim: None,
                open_type_features: Vec::new(),
                text_style_id: None,
                text_decoration_color: None,
                ..Default::default()
            }],
            paragraph: Some(v1::ParagraphStyle {
                alignment: v1::TextAlignment::Left as i32,
                line_height: Some(20.0),
                line_height_unit: None,
                paragraph_spacing: 0.0,
                paragraph_indent: None,
                text_wrap_style: None,
                list_type: None,
                list_spacing: None,
                hanging_list: None,
                hanging_punctuation: None,
            }),
            auto_size: v1::TextAutoSize::Fixed as i32,
            fallback_fonts: vec![],
            text_truncation: None,
            max_lines: None,
            base_style: None,
            paragraph_style_runs: vec![],
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetTextProperties(
                    v1::SetTextProperties {
                        node_id: 7_u128.to_be_bytes().to_vec(),
                        properties: Some(properties),
                    },
                )),
            }],
        }
        .encode_to_vec();

        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::TEXT_CASE_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(ServiceError::EngineSemanticsUnsupported { minimum })
                if minimum == makefigma_document_codec::TEXT_CASE_ENGINE_SEMANTICS_VERSION
        ));
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::TEXT_CASE_ENGINE_SEMANTICS_VERSION,
            )
            .unwrap()
            .as_slice(),
            [Command::SetTextProperties { properties, .. }]
                if properties.runs[0].text_case == Some(editor_core::TextCase::SmallCapsForced)
        ));
    }

    #[test]
    fn text_path_conversion_requires_semantics_seventeen() {
        let path = v1::VectorPath {
            fill_rule: v1::FillRule::NonZero as i32,
            subpaths: vec![v1::VectorSubpath {
                closed: false,
                points: vec![
                    v1::VectorPoint {
                        point_id: 1_u128.to_be_bytes().to_vec(),
                        x: 0.0,
                        y: 40.0,
                        handle_in_x: None,
                        handle_in_y: None,
                        handle_out_x: None,
                        handle_out_y: None,
                        point_type: v1::VectorPointType::Corner as i32,
                    },
                    v1::VectorPoint {
                        point_id: 2_u128.to_be_bytes().to_vec(),
                        x: 100.0,
                        y: 40.0,
                        handle_in_x: None,
                        handle_in_y: None,
                        handle_out_x: None,
                        handle_out_y: None,
                        point_type: v1::VectorPointType::Corner as i32,
                    },
                ],
            }],
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::ConvertToTextPath(
                    v1::ConvertToTextPath {
                        node_id: 7_u128.to_be_bytes().to_vec(),
                        vector_path: Some(path),
                    },
                )),
            }],
        }
        .encode_to_vec();

        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::TEXT_PATH_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(ServiceError::EngineSemanticsUnsupported { minimum })
                if minimum == makefigma_document_codec::TEXT_PATH_ENGINE_SEMANTICS_VERSION
        ));
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::TEXT_PATH_ENGINE_SEMANTICS_VERSION,
            )
            .unwrap()
            .as_slice(),
            [Command::ConvertToTextPath { id: editor_core::NodeId(7), path }]
                if path.subpaths[0].points.len() == 2 && !path.subpaths[0].closed
        ));
    }

    #[test]
    fn relative_line_height_operations_require_semantics_eighteen() {
        let properties = v1::TextProperties {
            runs: vec![],
            paragraph: Some(v1::ParagraphStyle {
                alignment: v1::TextAlignment::Left as i32,
                line_height: Some(150.0),
                paragraph_spacing: 0.0,
                paragraph_indent: None,
                text_wrap_style: None,
                list_type: None,
                list_spacing: None,
                hanging_list: None,
                hanging_punctuation: None,
                line_height_unit: Some(v1::LineHeightUnit::Percent as i32),
            }),
            auto_size: v1::TextAutoSize::Fixed as i32,
            fallback_fonts: vec![],
            text_truncation: None,
            max_lines: None,
            base_style: None,
            paragraph_style_runs: vec![],
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetTextProperties(
                    v1::SetTextProperties {
                        node_id: 7_u128.to_be_bytes().to_vec(),
                        properties: Some(properties),
                    },
                )),
            }],
        }
        .encode_to_vec();

        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::LINE_HEIGHT_UNIT_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(ServiceError::EngineSemanticsUnsupported { minimum })
                if minimum == makefigma_document_codec::LINE_HEIGHT_UNIT_ENGINE_SEMANTICS_VERSION
        ));
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::LINE_HEIGHT_UNIT_ENGINE_SEMANTICS_VERSION,
            )
            .unwrap()
            .as_slice(),
            [Command::SetTextProperties { properties, .. }]
                if properties.paragraph.line_height_unit == Some(LineHeightUnit::Percent)
        ));
    }

    #[test]
    fn paragraph_indent_operations_require_semantics_nineteen() {
        let properties = v1::TextProperties {
            runs: vec![],
            paragraph: Some(v1::ParagraphStyle {
                alignment: v1::TextAlignment::Left as i32,
                line_height: Some(20.0),
                paragraph_spacing: 0.0,
                line_height_unit: None,
                paragraph_indent: Some(14.0),
                text_wrap_style: None,
                list_type: None,
                list_spacing: None,
                hanging_list: None,
                hanging_punctuation: None,
            }),
            auto_size: v1::TextAutoSize::Fixed as i32,
            fallback_fonts: vec![],
            text_truncation: None,
            max_lines: None,
            base_style: None,
            paragraph_style_runs: vec![],
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetTextProperties(
                    v1::SetTextProperties {
                        node_id: 7_u128.to_be_bytes().to_vec(),
                        properties: Some(properties),
                    },
                )),
            }],
        }
        .encode_to_vec();

        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::PARAGRAPH_INDENT_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(ServiceError::EngineSemanticsUnsupported { minimum })
                if minimum == makefigma_document_codec::PARAGRAPH_INDENT_ENGINE_SEMANTICS_VERSION
        ));
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::PARAGRAPH_INDENT_ENGINE_SEMANTICS_VERSION,
            )
            .unwrap()
            .as_slice(),
            [Command::SetTextProperties { properties, .. }]
                if properties.paragraph.paragraph_indent == Some(14.0)
        ));
    }

    #[test]
    fn text_wrap_style_operations_require_semantics_twenty() {
        let properties = v1::TextProperties {
            runs: vec![],
            paragraph: Some(v1::ParagraphStyle {
                alignment: v1::TextAlignment::Left as i32,
                line_height: Some(20.0),
                paragraph_spacing: 0.0,
                line_height_unit: None,
                paragraph_indent: None,
                text_wrap_style: Some(v1::TextWrapStyle::Balance as i32),
                list_type: None,
                list_spacing: None,
                hanging_list: None,
                hanging_punctuation: None,
            }),
            auto_size: v1::TextAutoSize::Fixed as i32,
            fallback_fonts: vec![],
            text_truncation: None,
            max_lines: None,
            base_style: None,
            paragraph_style_runs: vec![],
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetTextProperties(
                    v1::SetTextProperties {
                        node_id: 7_u128.to_be_bytes().to_vec(),
                        properties: Some(properties),
                    },
                )),
            }],
        }
        .encode_to_vec();

        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(ServiceError::EngineSemanticsUnsupported { minimum })
                if minimum == makefigma_document_codec::TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION
        ));
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION,
            )
            .unwrap()
            .as_slice(),
            [Command::SetTextProperties { properties, .. }]
                if properties.paragraph.text_wrap_style == Some(TextWrapStyle::Balance)
        ));
    }

    #[test]
    fn text_hyperlink_operations_require_semantics_twenty_one() {
        let properties = v1::TextProperties {
            runs: vec![v1::TextStyleRun {
                start: 0,
                end: 1,
                font: None,
                font_size: 16.0,
                font_weight: 400,
                italic: false,
                letter_spacing: 0.0,
                color: None,
                fill_stack: None,
                text_case: None,
                hyperlink: Some(v1::HyperlinkTarget {
                    r#type: v1::HyperlinkType::Node as i32,
                    value: "1:2".into(),
                }),
                text_decoration: None,
                text_decoration_style: None,
                text_decoration_offset: None,
                text_decoration_thickness: None,
                text_decoration_skip_ink: None,
                leading_trim: None,
                open_type_features: Vec::new(),
                text_style_id: None,
                text_decoration_color: None,
            }],
            paragraph: Some(v1::ParagraphStyle {
                alignment: v1::TextAlignment::Left as i32,
                line_height: Some(20.0),
                paragraph_spacing: 0.0,
                line_height_unit: None,
                paragraph_indent: None,
                text_wrap_style: None,
                list_type: None,
                list_spacing: None,
                hanging_list: None,
                hanging_punctuation: None,
            }),
            auto_size: v1::TextAutoSize::Fixed as i32,
            fallback_fonts: vec![],
            text_truncation: None,
            max_lines: None,
            base_style: None,
            paragraph_style_runs: vec![],
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetTextProperties(
                    v1::SetTextProperties {
                        node_id: 7_u128.to_be_bytes().to_vec(),
                        properties: Some(properties),
                    },
                )),
            }],
        }
        .encode_to_vec();
        assert!(matches!(
            commands_from_payload_with_semantics(&payload, makefigma_document_codec::TEXT_HYPERLINK_ENGINE_SEMANTICS_VERSION - 1),
            Err(ServiceError::EngineSemanticsUnsupported { minimum })
                if minimum == makefigma_document_codec::TEXT_HYPERLINK_ENGINE_SEMANTICS_VERSION
        ));
        assert!(matches!(
            commands_from_payload_with_semantics(&payload, makefigma_document_codec::TEXT_HYPERLINK_ENGINE_SEMANTICS_VERSION).unwrap().as_slice(),
            [Command::SetTextProperties { properties, .. }]
                if properties.runs[0].hyperlink.as_ref().is_some_and(|link| link.kind == HyperlinkType::Node && link.value == "1:2")
        ));
    }

    #[test]
    fn text_decoration_operations_require_semantics_twenty_two() {
        let properties = v1::TextProperties {
            runs: vec![v1::TextStyleRun {
                start: 0,
                end: 1,
                font: None,
                font_size: 16.0,
                font_weight: 400,
                italic: false,
                letter_spacing: 0.0,
                color: None,
                fill_stack: None,
                text_case: None,
                hyperlink: None,
                text_decoration: Some(v1::TextDecoration::Underline as i32),
                text_decoration_style: None,
                text_decoration_offset: None,
                text_decoration_thickness: None,
                text_decoration_skip_ink: None,
                leading_trim: None,
                open_type_features: Vec::new(),
                text_style_id: None,
                text_decoration_color: None,
            }],
            paragraph: Some(v1::ParagraphStyle {
                alignment: v1::TextAlignment::Left as i32,
                line_height: Some(20.0),
                paragraph_spacing: 0.0,
                line_height_unit: None,
                paragraph_indent: None,
                text_wrap_style: None,
                list_type: None,
                list_spacing: None,
                hanging_list: None,
                hanging_punctuation: None,
            }),
            auto_size: v1::TextAutoSize::Fixed as i32,
            fallback_fonts: vec![],
            text_truncation: None,
            max_lines: None,
            base_style: None,
            paragraph_style_runs: vec![],
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetTextProperties(
                    v1::SetTextProperties {
                        node_id: 8_u128.to_be_bytes().to_vec(),
                        properties: Some(properties),
                    },
                )),
            }],
        }
        .encode_to_vec();
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::TEXT_DECORATION_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(ServiceError::EngineSemanticsUnsupported { minimum })
                if minimum == makefigma_document_codec::TEXT_DECORATION_ENGINE_SEMANTICS_VERSION
        ));
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::TEXT_DECORATION_ENGINE_SEMANTICS_VERSION,
            )
            .unwrap()
            .as_slice(),
            [Command::SetTextProperties { properties, .. }]
                if properties.runs[0].text_decoration == Some(TextDecoration::Underline)
        ));
    }

    #[test]
    fn text_decoration_style_operations_require_semantics_twenty_three() {
        let properties = v1::TextProperties {
            runs: vec![v1::TextStyleRun {
                start: 0,
                end: 1,
                font: None,
                font_size: 16.0,
                font_weight: 400,
                italic: false,
                letter_spacing: 0.0,
                color: None,
                fill_stack: None,
                text_case: None,
                hyperlink: None,
                text_decoration: Some(v1::TextDecoration::Underline as i32),
                text_decoration_style: Some(v1::TextDecorationStyle::Dotted as i32),
                text_decoration_offset: None,
                text_decoration_thickness: None,
                text_decoration_skip_ink: None,
                leading_trim: None,
                open_type_features: Vec::new(),
                text_style_id: None,
                text_decoration_color: None,
            }],
            paragraph: Some(v1::ParagraphStyle {
                alignment: v1::TextAlignment::Left as i32,
                line_height: Some(20.0),
                paragraph_spacing: 0.0,
                line_height_unit: None,
                paragraph_indent: None,
                text_wrap_style: None,
                list_type: None,
                list_spacing: None,
                hanging_list: None,
                hanging_punctuation: None,
            }),
            auto_size: v1::TextAutoSize::Fixed as i32,
            fallback_fonts: vec![],
            text_truncation: None,
            max_lines: None,
            base_style: None,
            paragraph_style_runs: vec![],
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetTextProperties(
                    v1::SetTextProperties {
                        node_id: 9_u128.to_be_bytes().to_vec(),
                        properties: Some(properties),
                    },
                )),
            }],
        }
        .encode_to_vec();
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::TEXT_DECORATION_STYLE_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(ServiceError::EngineSemanticsUnsupported { minimum })
                if minimum == makefigma_document_codec::TEXT_DECORATION_STYLE_ENGINE_SEMANTICS_VERSION
        ));
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::TEXT_DECORATION_STYLE_ENGINE_SEMANTICS_VERSION,
            )
            .unwrap()
            .as_slice(),
            [Command::SetTextProperties { properties, .. }]
                if properties.runs[0].text_decoration_style == Some(TextDecorationStyle::Dotted)
        ));
    }

    #[test]
    fn text_decoration_offset_operations_require_semantics_twenty_four() {
        let properties = v1::TextProperties {
            runs: vec![v1::TextStyleRun {
                start: 0,
                end: 1,
                font: None,
                font_size: 16.0,
                font_weight: 400,
                italic: false,
                letter_spacing: 0.0,
                color: None,
                fill_stack: None,
                text_case: None,
                hyperlink: None,
                text_decoration: Some(v1::TextDecoration::Underline as i32),
                text_decoration_style: None,
                text_decoration_offset: Some(v1::TextDecorationOffset {
                    value: -20.0,
                    unit: v1::TextDecorationOffsetUnit::Percent as i32,
                }),
                text_decoration_thickness: None,
                text_decoration_skip_ink: None,
                leading_trim: None,
                open_type_features: Vec::new(),
                text_style_id: None,
                text_decoration_color: None,
            }],
            paragraph: Some(v1::ParagraphStyle {
                alignment: v1::TextAlignment::Left as i32,
                line_height: Some(20.0),
                paragraph_spacing: 0.0,
                line_height_unit: None,
                paragraph_indent: None,
                text_wrap_style: None,
                list_type: None,
                list_spacing: None,
                hanging_list: None,
                hanging_punctuation: None,
            }),
            auto_size: v1::TextAutoSize::Fixed as i32,
            fallback_fonts: vec![],
            text_truncation: None,
            max_lines: None,
            base_style: None,
            paragraph_style_runs: vec![],
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetTextProperties(
                    v1::SetTextProperties {
                        node_id: 10_u128.to_be_bytes().to_vec(),
                        properties: Some(properties),
                    },
                )),
            }],
        }
        .encode_to_vec();
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::TEXT_DECORATION_OFFSET_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(ServiceError::EngineSemanticsUnsupported { minimum })
                if minimum == makefigma_document_codec::TEXT_DECORATION_OFFSET_ENGINE_SEMANTICS_VERSION
        ));
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::TEXT_DECORATION_OFFSET_ENGINE_SEMANTICS_VERSION,
            )
            .unwrap()
            .as_slice(),
            [Command::SetTextProperties { properties, .. }]
                if properties.runs[0].text_decoration_offset == Some(TextDecorationOffset::Percent(-20.0))
        ));
    }

    #[test]
    fn text_decoration_thickness_operations_require_semantics_twenty_five() {
        let properties = v1::TextProperties {
            runs: vec![v1::TextStyleRun {
                start: 0,
                end: 1,
                font: None,
                font_size: 16.0,
                font_weight: 400,
                italic: false,
                letter_spacing: 0.0,
                color: None,
                fill_stack: None,
                text_case: None,
                hyperlink: None,
                text_decoration: Some(v1::TextDecoration::Underline as i32),
                text_decoration_style: None,
                text_decoration_offset: None,
                text_decoration_thickness: Some(v1::TextDecorationThickness {
                    value: 10.0,
                    unit: v1::TextDecorationThicknessUnit::Percent as i32,
                }),
                text_decoration_skip_ink: None,
                leading_trim: None,
                open_type_features: Vec::new(),
                text_style_id: None,
                text_decoration_color: None,
            }],
            paragraph: Some(v1::ParagraphStyle {
                alignment: v1::TextAlignment::Left as i32,
                line_height: Some(20.0),
                paragraph_spacing: 0.0,
                line_height_unit: None,
                paragraph_indent: None,
                text_wrap_style: None,
                list_type: None,
                list_spacing: None,
                hanging_list: None,
                hanging_punctuation: None,
            }),
            auto_size: v1::TextAutoSize::Fixed as i32,
            fallback_fonts: vec![],
            text_truncation: None,
            max_lines: None,
            base_style: None,
            paragraph_style_runs: vec![],
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetTextProperties(
                    v1::SetTextProperties {
                        node_id: 11_u128.to_be_bytes().to_vec(),
                        properties: Some(properties),
                    },
                )),
            }],
        }
        .encode_to_vec();
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::TEXT_DECORATION_THICKNESS_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(ServiceError::EngineSemanticsUnsupported { minimum })
                if minimum == makefigma_document_codec::TEXT_DECORATION_THICKNESS_ENGINE_SEMANTICS_VERSION
        ));
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::TEXT_DECORATION_THICKNESS_ENGINE_SEMANTICS_VERSION,
            )
            .unwrap()
            .as_slice(),
            [Command::SetTextProperties { properties, .. }]
                if properties.runs[0].text_decoration_thickness == Some(TextDecorationThickness::Percent(10.0))
        ));
    }

    #[test]
    fn text_decoration_color_operations_require_semantics_twenty_six() {
        let properties = v1::TextProperties {
            runs: vec![v1::TextStyleRun {
                start: 0,
                end: 1,
                font: None,
                font_size: 16.0,
                font_weight: 400,
                italic: false,
                letter_spacing: 0.0,
                color: None,
                fill_stack: None,
                text_case: None,
                hyperlink: None,
                text_decoration: Some(v1::TextDecoration::Underline as i32),
                text_decoration_style: None,
                text_decoration_offset: None,
                text_decoration_thickness: None,
                text_decoration_skip_ink: None,
                leading_trim: None,
                open_type_features: Vec::new(),
                text_style_id: None,
                text_decoration_color: Some(v1::TextDecorationColor {
                    color: Some(color()),
                    visible: true,
                    opacity: 0.75,
                    blend_mode: v1::BlendMode::Multiply as i32,
                }),
            }],
            paragraph: Some(v1::ParagraphStyle {
                alignment: v1::TextAlignment::Left as i32,
                line_height: Some(20.0),
                paragraph_spacing: 0.0,
                line_height_unit: None,
                paragraph_indent: None,
                text_wrap_style: None,
                list_type: None,
                list_spacing: None,
                hanging_list: None,
                hanging_punctuation: None,
            }),
            auto_size: v1::TextAutoSize::Fixed as i32,
            fallback_fonts: vec![],
            text_truncation: None,
            max_lines: None,
            base_style: None,
            paragraph_style_runs: vec![],
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetTextProperties(
                    v1::SetTextProperties {
                        node_id: 12_u128.to_be_bytes().to_vec(),
                        properties: Some(properties),
                    },
                )),
            }],
        }
        .encode_to_vec();
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::TEXT_DECORATION_COLOR_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(ServiceError::EngineSemanticsUnsupported { minimum })
                if minimum == makefigma_document_codec::TEXT_DECORATION_COLOR_ENGINE_SEMANTICS_VERSION
        ));
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::TEXT_DECORATION_COLOR_ENGINE_SEMANTICS_VERSION,
            )
            .unwrap()
            .as_slice(),
            [Command::SetTextProperties { properties, .. }]
                if properties.runs[0].text_decoration_color == Some(TextDecorationColor {
                    color: editor_core::color::Color {
                        space: editor_core::color::ColorSpace::Srgb,
                        components: [0.2, 0.4, 0.6],
                        alpha: 1.0,
                    },
                    visible: true,
                    opacity: 0.75,
                    blend_mode: editor_core::BlendMode::Multiply,
                })
        ));
    }

    #[test]
    fn text_decoration_skip_ink_operations_require_semantics_twenty_seven() {
        let properties = v1::TextProperties {
            runs: vec![v1::TextStyleRun {
                start: 0,
                end: 1,
                font_size: 16.0,
                font_weight: 400,
                text_decoration: Some(v1::TextDecoration::Underline as i32),
                text_decoration_skip_ink: Some(true),
                leading_trim: None,
                open_type_features: Vec::new(),
                text_style_id: None,
                ..Default::default()
            }],
            paragraph: Some(v1::ParagraphStyle {
                alignment: v1::TextAlignment::Left as i32,
                line_height: Some(20.0),
                ..Default::default()
            }),
            auto_size: v1::TextAutoSize::Fixed as i32,
            ..Default::default()
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetTextProperties(
                    v1::SetTextProperties {
                        node_id: 13_u128.to_be_bytes().to_vec(),
                        properties: Some(properties),
                    },
                )),
            }],
        }
        .encode_to_vec();
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::TEXT_DECORATION_SKIP_INK_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(ServiceError::EngineSemanticsUnsupported { minimum })
                if minimum == makefigma_document_codec::TEXT_DECORATION_SKIP_INK_ENGINE_SEMANTICS_VERSION
        ));
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::TEXT_DECORATION_SKIP_INK_ENGINE_SEMANTICS_VERSION,
            )
            .unwrap()
            .as_slice(),
            [Command::SetTextProperties { properties, .. }]
                if properties.runs[0].text_decoration_skip_ink == Some(true)
        ));
    }

    #[test]
    fn leading_trim_operations_require_semantics_twenty_eight() {
        let properties = v1::TextProperties {
            runs: vec![v1::TextStyleRun {
                start: 0,
                end: 1,
                font_size: 16.0,
                font_weight: 400,
                leading_trim: Some(v1::LeadingTrim::CapHeight as i32),
                open_type_features: Vec::new(),
                text_style_id: None,
                ..Default::default()
            }],
            paragraph: Some(v1::ParagraphStyle {
                alignment: v1::TextAlignment::Left as i32,
                line_height: Some(24.0),
                ..Default::default()
            }),
            auto_size: v1::TextAutoSize::Fixed as i32,
            ..Default::default()
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetTextProperties(
                    v1::SetTextProperties {
                        node_id: 14_u128.to_be_bytes().to_vec(),
                        properties: Some(properties),
                    },
                )),
            }],
        }
        .encode_to_vec();
        assert!(matches!(
            commands_from_payload_with_semantics(&payload, makefigma_document_codec::LEADING_TRIM_ENGINE_SEMANTICS_VERSION - 1),
            Err(ServiceError::EngineSemanticsUnsupported { minimum })
                if minimum == makefigma_document_codec::LEADING_TRIM_ENGINE_SEMANTICS_VERSION
        ));
        assert!(matches!(
            commands_from_payload_with_semantics(&payload, makefigma_document_codec::LEADING_TRIM_ENGINE_SEMANTICS_VERSION).unwrap().as_slice(),
            [Command::SetTextProperties { properties, .. }]
                if properties.runs[0].leading_trim == Some(LeadingTrim::CapHeight)
        ));
    }

    #[test]
    fn open_type_feature_operations_require_semantics_forty_two() {
        let properties = v1::TextProperties {
            runs: vec![v1::TextStyleRun {
                start: 0,
                end: 1,
                font_size: 16.0,
                font_weight: 400,
                open_type_features: vec![v1::OpenTypeFeatureSetting {
                    tag: "LIGA".into(),
                    enabled: false,
                }],
                ..Default::default()
            }],
            paragraph: Some(v1::ParagraphStyle {
                alignment: v1::TextAlignment::Left as i32,
                line_height: Some(24.0),
                ..Default::default()
            }),
            auto_size: v1::TextAutoSize::Fixed as i32,
            ..Default::default()
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetTextProperties(
                    v1::SetTextProperties {
                        node_id: 14_u128.to_be_bytes().to_vec(),
                        properties: Some(properties),
                    },
                )),
            }],
        }
        .encode_to_vec();
        assert!(
            matches!(commands_from_payload_with_semantics(&payload, makefigma_document_codec::OPEN_TYPE_FEATURES_ENGINE_SEMANTICS_VERSION - 1), Err(ServiceError::EngineSemanticsUnsupported { minimum }) if minimum == makefigma_document_codec::OPEN_TYPE_FEATURES_ENGINE_SEMANTICS_VERSION)
        );
        assert!(
            matches!(commands_from_payload_with_semantics(&payload, makefigma_document_codec::OPEN_TYPE_FEATURES_ENGINE_SEMANTICS_VERSION).unwrap().as_slice(), [Command::SetTextProperties { properties, .. }] if properties.runs[0].open_type_features == [editor_core::OpenTypeFeature { tag: "LIGA".into(), enabled: false }])
        );
    }

    #[test]
    fn text_style_link_operations_require_semantics_forty_three() {
        let properties = v1::TextProperties {
            runs: vec![v1::TextStyleRun {
                start: 0,
                end: 1,
                font_size: 16.0,
                font_weight: 400,
                text_style_id: Some("S:heading".into()),
                ..Default::default()
            }],
            paragraph: Some(v1::ParagraphStyle {
                alignment: v1::TextAlignment::Left as i32,
                line_height: Some(24.0),
                ..Default::default()
            }),
            auto_size: v1::TextAutoSize::Fixed as i32,
            ..Default::default()
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetTextProperties(
                    v1::SetTextProperties {
                        node_id: 15_u128.to_be_bytes().to_vec(),
                        properties: Some(properties),
                    },
                )),
            }],
        }
        .encode_to_vec();
        assert!(
            matches!(commands_from_payload_with_semantics(&payload, makefigma_document_codec::TEXT_STYLE_LINK_ENGINE_SEMANTICS_VERSION - 1), Err(ServiceError::EngineSemanticsUnsupported { minimum }) if minimum == makefigma_document_codec::TEXT_STYLE_LINK_ENGINE_SEMANTICS_VERSION)
        );
        assert!(
            matches!(commands_from_payload_with_semantics(&payload, makefigma_document_codec::TEXT_STYLE_LINK_ENGINE_SEMANTICS_VERSION).unwrap().as_slice(), [Command::SetTextProperties { properties, .. }] if properties.runs[0].text_style_id.as_deref() == Some("S:heading"))
        );
    }

    #[test]
    fn text_style_catalog_operations_require_semantics_forty_four() {
        let style = v1::TextStyleResource {
            id: "S:body".into(),
            key: "library-key".into(),
            name: "Body".into(),
            description: "Body copy".into(),
            remote: true,
            style: Some(v1::TextStyleRun {
                font_size: 16.0,
                font_weight: 400,
                ..Default::default()
            }),
            paragraph: Some(v1::ParagraphStyle {
                alignment: v1::TextAlignment::Left as i32,
                line_height: Some(24.0),
                paragraph_spacing: 6.0,
                ..Default::default()
            }),
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::RegisterTextStyle(
                    v1::RegisterTextStyle { style: Some(style) },
                )),
            }],
        }
        .encode_to_vec();
        assert!(
            matches!(commands_from_payload_with_semantics(&payload, makefigma_document_codec::TEXT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION - 1), Err(ServiceError::EngineSemanticsUnsupported { minimum }) if minimum == makefigma_document_codec::TEXT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION)
        );
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::TEXT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION,
            )
            .unwrap()
            .as_slice(),
            [Command::RegisterTextStyle { style }]
                if style.id == "S:body"
                    && style.key == "library-key"
                    && style.style.font_size == 16.0
                    && style.paragraph.line_height == Some(24.0)
        ));
    }

    #[test]
    fn paint_style_catalog_operations_require_semantics_forty_five() {
        let style = v1::PaintStyleResource {
            id: "S:brand-fill".into(),
            key: "library-paint-key".into(),
            name: "Brand fill".into(),
            description: "Primary surface".into(),
            remote: true,
            paints: Some(v1::PaintStack { layers: Vec::new() }),
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::RegisterPaintStyle(
                    v1::RegisterPaintStyle { style: Some(style) },
                )),
            }],
        }
        .encode_to_vec();
        assert!(
            matches!(commands_from_payload_with_semantics(&payload, makefigma_document_codec::PAINT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION - 1), Err(ServiceError::EngineSemanticsUnsupported { minimum }) if minimum == makefigma_document_codec::PAINT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION)
        );
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::PAINT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION,
            )
            .unwrap()
            .as_slice(),
            [Command::RegisterPaintStyle { style }]
                if style.id == "S:brand-fill"
                    && style.key == "library-paint-key"
                    && style.paints.layers.is_empty()
        ));
    }

    #[test]
    fn text_list_type_operations_require_semantics_twenty_nine() {
        let properties = v1::TextProperties {
            paragraph: Some(v1::ParagraphStyle {
                alignment: v1::TextAlignment::Left as i32,
                line_height: Some(20.0),
                list_type: Some(v1::TextListType::Ordered as i32),
                ..Default::default()
            }),
            auto_size: v1::TextAutoSize::Fixed as i32,
            ..Default::default()
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetTextProperties(
                    v1::SetTextProperties {
                        node_id: 15_u128.to_be_bytes().to_vec(),
                        properties: Some(properties),
                    },
                )),
            }],
        }
        .encode_to_vec();
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::TEXT_LIST_TYPE_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(ServiceError::EngineSemanticsUnsupported { minimum })
                if minimum == makefigma_document_codec::TEXT_LIST_TYPE_ENGINE_SEMANTICS_VERSION
        ));
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::TEXT_LIST_TYPE_ENGINE_SEMANTICS_VERSION,
            )
            .unwrap()
            .as_slice(),
            [Command::SetTextProperties { properties, .. }]
                if properties.paragraph.list_type == Some(TextListType::Ordered)
        ));
    }

    #[test]
    fn text_list_spacing_operations_require_semantics_thirty() {
        let properties = v1::TextProperties {
            paragraph: Some(v1::ParagraphStyle {
                alignment: v1::TextAlignment::Left as i32,
                line_height: Some(20.0),
                list_type: Some(v1::TextListType::Ordered as i32),
                list_spacing: Some(8.0),
                hanging_list: None,
                hanging_punctuation: None,
                ..Default::default()
            }),
            auto_size: v1::TextAutoSize::Fixed as i32,
            ..Default::default()
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetTextProperties(
                    v1::SetTextProperties {
                        node_id: 16_u128.to_be_bytes().to_vec(),
                        properties: Some(properties),
                    },
                )),
            }],
        }
        .encode_to_vec();
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::TEXT_LIST_SPACING_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(ServiceError::EngineSemanticsUnsupported { minimum })
                if minimum == makefigma_document_codec::TEXT_LIST_SPACING_ENGINE_SEMANTICS_VERSION
        ));
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::TEXT_LIST_SPACING_ENGINE_SEMANTICS_VERSION,
            )
            .unwrap()
            .as_slice(),
            [Command::SetTextProperties { properties, .. }]
                if properties.paragraph.list_spacing == Some(8.0)
        ));
    }

    #[test]
    fn paragraph_style_run_operations_require_semantics_thirty_one() {
        let properties = v1::TextProperties {
            paragraph: Some(v1::ParagraphStyle {
                alignment: v1::TextAlignment::Left as i32,
                line_height: Some(20.0),
                list_type: Some(v1::TextListType::Ordered as i32),
                ..Default::default()
            }),
            paragraph_style_runs: vec![v1::ParagraphStyleRun {
                start: 4,
                indentation: Some(2),
                list_type: None,
                list_spacing: None,
                paragraph_spacing: None,
                paragraph_indent: None,
                line_height: None,
                line_height_unit: None,
                text_wrap_style: None,
            }],
            auto_size: v1::TextAutoSize::Fixed as i32,
            ..Default::default()
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetTextProperties(
                    v1::SetTextProperties {
                        node_id: 17_u128.to_be_bytes().to_vec(),
                        properties: Some(properties),
                    },
                )),
            }],
        }
        .encode_to_vec();
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::PARAGRAPH_STYLE_RUNS_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(ServiceError::EngineSemanticsUnsupported { minimum })
                if minimum == makefigma_document_codec::PARAGRAPH_STYLE_RUNS_ENGINE_SEMANTICS_VERSION
        ));
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::PARAGRAPH_STYLE_RUNS_ENGINE_SEMANTICS_VERSION,
            )
            .unwrap()
            .as_slice(),
            [Command::SetTextProperties { properties, .. }]
                if properties.paragraph_style_runs == vec![ParagraphStyleRun { start: 4, indentation: Some(2), list_type: None, list_spacing: None, paragraph_spacing: None, paragraph_indent: None, line_height: None, line_height_unit: None, text_wrap_style: None }]
        ));
    }

    #[test]
    fn text_hanging_list_operations_require_semantics_thirty_two() {
        let properties = v1::TextProperties {
            paragraph: Some(v1::ParagraphStyle {
                alignment: v1::TextAlignment::Left as i32,
                line_height: Some(20.0),
                list_type: Some(v1::TextListType::Ordered as i32),
                hanging_list: Some(true),
                hanging_punctuation: None,
                ..Default::default()
            }),
            auto_size: v1::TextAutoSize::Fixed as i32,
            ..Default::default()
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetTextProperties(
                    v1::SetTextProperties {
                        node_id: 18_u128.to_be_bytes().to_vec(),
                        properties: Some(properties),
                    },
                )),
            }],
        }
        .encode_to_vec();
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::TEXT_HANGING_LIST_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(ServiceError::EngineSemanticsUnsupported { minimum })
                if minimum == makefigma_document_codec::TEXT_HANGING_LIST_ENGINE_SEMANTICS_VERSION
        ));
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::TEXT_HANGING_LIST_ENGINE_SEMANTICS_VERSION,
            ).unwrap().as_slice(),
            [Command::SetTextProperties { properties, .. }]
                if properties.paragraph.hanging_list
        ));
    }

    #[test]
    fn paragraph_list_option_operations_require_semantics_thirty_three() {
        let properties = v1::TextProperties {
            paragraph: Some(v1::ParagraphStyle {
                alignment: v1::TextAlignment::Left as i32,
                line_height: Some(20.0),
                list_type: Some(v1::TextListType::Ordered as i32),
                ..Default::default()
            }),
            paragraph_style_runs: vec![v1::ParagraphStyleRun {
                start: 4,
                indentation: None,
                list_type: Some(v1::TextListType::None as i32),
                list_spacing: None,
                paragraph_spacing: None,
                paragraph_indent: None,
                line_height: None,
                line_height_unit: None,
                text_wrap_style: None,
            }],
            auto_size: v1::TextAutoSize::Fixed as i32,
            ..Default::default()
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetTextProperties(
                    v1::SetTextProperties {
                        node_id: 19_u128.to_be_bytes().to_vec(),
                        properties: Some(properties),
                    },
                )),
            }],
        }
        .encode_to_vec();
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::PARAGRAPH_LIST_OPTIONS_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(ServiceError::EngineSemanticsUnsupported { minimum })
                if minimum == makefigma_document_codec::PARAGRAPH_LIST_OPTIONS_ENGINE_SEMANTICS_VERSION
        ));
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::PARAGRAPH_LIST_OPTIONS_ENGINE_SEMANTICS_VERSION,
            ).unwrap().as_slice(),
            [Command::SetTextProperties { properties, .. }]
                if properties.paragraph_style_runs == vec![ParagraphStyleRun {
                    start: 4,
                    indentation: None,
                    list_type: Some(ParagraphListType::None),
                    list_spacing: None,
                    paragraph_spacing: None,
                    paragraph_indent: None,
                    line_height: None,
                    line_height_unit: None,
                    text_wrap_style: None,
                }]
        ));
    }

    #[test]
    fn paragraph_list_spacing_operations_require_semantics_thirty_four() {
        let properties = v1::TextProperties {
            paragraph: Some(v1::ParagraphStyle {
                alignment: v1::TextAlignment::Left as i32,
                line_height: Some(20.0),
                list_type: Some(v1::TextListType::Ordered as i32),
                list_spacing: Some(8.0),
                ..Default::default()
            }),
            paragraph_style_runs: vec![v1::ParagraphStyleRun {
                start: 0,
                indentation: None,
                list_type: None,
                list_spacing: Some(0.0),
                paragraph_spacing: None,
                paragraph_indent: None,
                line_height: None,
                line_height_unit: None,
                text_wrap_style: None,
            }],
            auto_size: v1::TextAutoSize::Fixed as i32,
            ..Default::default()
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetTextProperties(
                    v1::SetTextProperties {
                        node_id: 20_u128.to_be_bytes().to_vec(),
                        properties: Some(properties),
                    },
                )),
            }],
        }
        .encode_to_vec();
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::PARAGRAPH_LIST_SPACING_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(ServiceError::EngineSemanticsUnsupported { minimum })
                if minimum == makefigma_document_codec::PARAGRAPH_LIST_SPACING_ENGINE_SEMANTICS_VERSION
        ));
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::PARAGRAPH_LIST_SPACING_ENGINE_SEMANTICS_VERSION,
            ).unwrap().as_slice(),
            [Command::SetTextProperties { properties, .. }]
                if properties.paragraph_style_runs == vec![ParagraphStyleRun {
                    start: 0,
                    indentation: None,
                    list_type: None,
                    list_spacing: Some(0.0),
                    paragraph_spacing: None,
                    paragraph_indent: None,
                    line_height: None,
                    line_height_unit: None,
                    text_wrap_style: None,
                }]
        ));
    }

    #[test]
    fn paragraph_spacing_operations_require_semantics_thirty_five() {
        let properties = v1::TextProperties {
            paragraph: Some(v1::ParagraphStyle {
                alignment: v1::TextAlignment::Left as i32,
                line_height: Some(20.0),
                paragraph_spacing: 8.0,
                ..Default::default()
            }),
            paragraph_style_runs: vec![v1::ParagraphStyleRun {
                start: 0,
                indentation: None,
                list_type: None,
                list_spacing: None,
                paragraph_spacing: Some(0.0),
                paragraph_indent: None,
                line_height: None,
                line_height_unit: None,
                text_wrap_style: None,
            }],
            auto_size: v1::TextAutoSize::Fixed as i32,
            ..Default::default()
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetTextProperties(
                    v1::SetTextProperties {
                        node_id: 21_u128.to_be_bytes().to_vec(),
                        properties: Some(properties),
                    },
                )),
            }],
        }
        .encode_to_vec();
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::PARAGRAPH_SPACING_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(ServiceError::EngineSemanticsUnsupported { minimum })
                if minimum == makefigma_document_codec::PARAGRAPH_SPACING_ENGINE_SEMANTICS_VERSION
        ));
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::PARAGRAPH_SPACING_ENGINE_SEMANTICS_VERSION,
            ).unwrap().as_slice(),
            [Command::SetTextProperties { properties, .. }]
                if properties.paragraph_style_runs == vec![ParagraphStyleRun {
                    start: 0,
                    indentation: None,
                    list_type: None,
                    list_spacing: None,
                    paragraph_spacing: Some(0.0),
                    paragraph_indent: None,
                    line_height: None,
                    line_height_unit: None,
                    text_wrap_style: None,
                }]
        ));
    }

    #[test]
    fn paragraph_indent_run_operations_require_semantics_thirty_six() {
        let properties = v1::TextProperties {
            paragraph: Some(v1::ParagraphStyle {
                alignment: v1::TextAlignment::Left as i32,
                line_height: Some(20.0),
                paragraph_indent: Some(8.0),
                ..Default::default()
            }),
            paragraph_style_runs: vec![v1::ParagraphStyleRun {
                start: 0,
                indentation: None,
                list_type: None,
                list_spacing: None,
                paragraph_spacing: None,
                paragraph_indent: Some(0.0),
                line_height: None,
                line_height_unit: None,
                text_wrap_style: None,
            }],
            auto_size: v1::TextAutoSize::Fixed as i32,
            ..Default::default()
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetTextProperties(
                    v1::SetTextProperties {
                        node_id: 22_u128.to_be_bytes().to_vec(),
                        properties: Some(properties),
                    },
                )),
            }],
        }
        .encode_to_vec();
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::PARAGRAPH_INDENT_RUN_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(ServiceError::EngineSemanticsUnsupported { minimum })
                if minimum == makefigma_document_codec::PARAGRAPH_INDENT_RUN_ENGINE_SEMANTICS_VERSION
        ));
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::PARAGRAPH_INDENT_RUN_ENGINE_SEMANTICS_VERSION,
            ).unwrap().as_slice(),
            [Command::SetTextProperties { properties, .. }]
                if properties.paragraph_style_runs == vec![ParagraphStyleRun {
                    start: 0,
                    indentation: None,
                    list_type: None,
                    list_spacing: None,
                    paragraph_spacing: None,
                    paragraph_indent: Some(0.0),
                    line_height: None,
                    line_height_unit: None,
                    text_wrap_style: None,
                }]
        ));
    }

    #[test]
    fn paragraph_line_height_operations_require_semantics_thirty_seven() {
        let properties = v1::TextProperties {
            paragraph: Some(v1::ParagraphStyle {
                alignment: v1::TextAlignment::Left as i32,
                line_height: Some(20.0),
                ..Default::default()
            }),
            paragraph_style_runs: vec![v1::ParagraphStyleRun {
                start: 0,
                line_height: Some(150.0),
                line_height_unit: Some(v1::LineHeightUnit::Percent as i32),
                ..Default::default()
            }],
            auto_size: v1::TextAutoSize::Fixed as i32,
            ..Default::default()
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetTextProperties(
                    v1::SetTextProperties {
                        node_id: 23_u128.to_be_bytes().to_vec(),
                        properties: Some(properties),
                    },
                )),
            }],
        }
        .encode_to_vec();
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::PARAGRAPH_LINE_HEIGHT_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(ServiceError::EngineSemanticsUnsupported { minimum })
                if minimum == makefigma_document_codec::PARAGRAPH_LINE_HEIGHT_ENGINE_SEMANTICS_VERSION
        ));
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::PARAGRAPH_LINE_HEIGHT_ENGINE_SEMANTICS_VERSION,
            )
            .unwrap()
            .as_slice(),
            [Command::SetTextProperties { properties, .. }]
                if properties.paragraph_style_runs == vec![ParagraphStyleRun {
                    start: 0,
                    indentation: None,
                    list_type: None,
                    list_spacing: None,
                    paragraph_spacing: None,
                    paragraph_indent: None,
                    line_height: Some(150.0),
                    line_height_unit: Some(LineHeightUnit::Percent),
                    text_wrap_style: None,
                }]
        ));
    }

    #[test]
    fn hanging_punctuation_operations_require_semantics_thirty_eight() {
        let properties = v1::TextProperties {
            paragraph: Some(v1::ParagraphStyle {
                alignment: v1::TextAlignment::Left as i32,
                line_height: Some(20.0),
                hanging_punctuation: Some(true),
                ..Default::default()
            }),
            auto_size: v1::TextAutoSize::Fixed as i32,
            ..Default::default()
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetTextProperties(
                    v1::SetTextProperties {
                        node_id: 24_u128.to_be_bytes().to_vec(),
                        properties: Some(properties),
                    },
                )),
            }],
        }
        .encode_to_vec();
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::TEXT_HANGING_PUNCTUATION_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(ServiceError::EngineSemanticsUnsupported { minimum })
                if minimum == makefigma_document_codec::TEXT_HANGING_PUNCTUATION_ENGINE_SEMANTICS_VERSION
        ));
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::TEXT_HANGING_PUNCTUATION_ENGINE_SEMANTICS_VERSION,
            )
            .unwrap()
            .as_slice(),
            [Command::SetTextProperties { properties, .. }]
                if properties.paragraph.hanging_punctuation
        ));
    }

    #[test]
    fn paragraph_text_wrap_style_operations_require_semantics_thirty_nine() {
        let properties = v1::TextProperties {
            paragraph: Some(v1::ParagraphStyle {
                alignment: v1::TextAlignment::Left as i32,
                line_height: Some(20.0),
                text_wrap_style: Some(v1::TextWrapStyle::Balance as i32),
                ..Default::default()
            }),
            paragraph_style_runs: vec![v1::ParagraphStyleRun {
                start: 4,
                text_wrap_style: Some(v1::TextWrapStyle::Auto as i32),
                ..Default::default()
            }],
            auto_size: v1::TextAutoSize::Fixed as i32,
            ..Default::default()
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetTextProperties(
                    v1::SetTextProperties {
                        node_id: 25_u128.to_be_bytes().to_vec(),
                        properties: Some(properties),
                    },
                )),
            }],
        }
        .encode_to_vec();
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::PARAGRAPH_TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(ServiceError::EngineSemanticsUnsupported { minimum })
                if minimum == makefigma_document_codec::PARAGRAPH_TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION
        ));
        assert!(matches!(
            commands_from_payload_with_semantics(
                &payload,
                makefigma_document_codec::PARAGRAPH_TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION,
            )
            .unwrap()
            .as_slice(),
            [Command::SetTextProperties { properties, .. }]
                if properties.paragraph_style_runs == vec![ParagraphStyleRun {
                    start: 4,
                    indentation: None,
                    list_type: None,
                    list_spacing: None,
                    paragraph_spacing: None,
                    paragraph_indent: None,
                    line_height: None,
                    line_height_unit: None,
                    text_wrap_style: Some(TextWrapStyle::Auto),
                }]
        ));
    }
}
