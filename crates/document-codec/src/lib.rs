//! Canonical editor-core ↔ durable Protobuf snapshot conversion.
//!
//! This crate deliberately has no database or HTTP dependency so the same
//! validation path can be used by the Rust service and the browser WASM engine.

use editor_core::{
    ActorId, ArcData, AssetId, AssetReference, AutoLayout, BackgroundBlur, BlendMode,
    BooleanOperation, ConstraintType, Constraints, Document, DocumentId, DropShadow, Effect,
    EffectStyleResource, FillRule, FontFaceMetadata, FontNameAlias, FontReference, GridAutoTracks,
    GridChildAlignment, GridItemsPositioning, GridTrack, HyperlinkTarget, HyperlinkType,
    InnerShadow, LayerBlur, LayoutAlignment, LayoutMode, LayoutSizing, LeadingTrim, LineHeightUnit,
    Node, NodeId, NodeKind, OpenTypeFeature, Page, PageId, PaintStyleLinks, PaintStyleResource,
    PaintStyleVariableBinding, ParagraphListType, ParagraphStyle, ParagraphStyleRun,
    ParametricShape, PointId, PositionId, StrokeAlign, StrokeCap, StrokeJoin, TextAlign,
    TextAutoSize, TextCase, TextDecoration, TextDecorationColor, TextDecorationOffset,
    TextDecorationStyle, TextDecorationThickness, TextListType, TextProperties,
    TextStyleLetterSpacingUnit, TextStyleResource, TextStyleRun, TextTruncation, TextWrapStyle,
    VariableCollectionResource, VariableMode, VariableResolvedType, VariableResource,
    VariableValue, VectorPath, VectorPoint, VectorPointType, VectorSubpath, WrapTrackAlignment,
    can_parent_contain_child,
    color::{
        Color, ColorSpace, DocumentColorProfile, GradientPaint, GradientPaintKind, GradientStop,
        ImageFilters, ImagePaint, ImageScaleMode, LinearGradient, Paint, PaintLayer,
        PaintLayerKind, PaintStack,
    },
};
use makefigma_protocol::v1;
use prost::Message;
use sha2::Digest;
use std::collections::{BTreeMap, BTreeSet};

pub const SNAPSHOT_FORMAT_VERSION: u32 = 1;
pub const PAINT_STACK_ENGINE_SEMANTICS_VERSION: u32 = 4;
pub const NON_LINEAR_GRADIENT_ENGINE_SEMANTICS_VERSION: u32 = 5;
pub const ADVANCED_BLEND_ENGINE_SEMANTICS_VERSION: u32 = 6;
pub const IMAGE_PAINT_ROTATION_ENGINE_SEMANTICS_VERSION: u32 = 7;
pub const PASS_THROUGH_ENGINE_SEMANTICS_VERSION: u32 = 8;
pub const LINEAR_BLEND_ENGINE_SEMANTICS_VERSION: u32 = 9;
pub const NORMAL_BLEND_ISOLATION_ENGINE_SEMANTICS_VERSION: u32 = 10;
pub const IMAGE_FILTERS_ENGINE_SEMANTICS_VERSION: u32 = 11;
pub const TEXT_TRUNCATION_ENGINE_SEMANTICS_VERSION: u32 = 12;
pub const SHAPE_WITH_TEXT_TEXT_ENGINE_SEMANTICS_VERSION: u32 = 13;
pub const TEXT_RUN_PAINT_STACK_ENGINE_SEMANTICS_VERSION: u32 = 14;
pub const TEXT_BASE_STYLE_ENGINE_SEMANTICS_VERSION: u32 = 15;
pub const TEXT_CASE_ENGINE_SEMANTICS_VERSION: u32 = 16;
pub const TEXT_PATH_ENGINE_SEMANTICS_VERSION: u32 = 17;
pub const LINE_HEIGHT_UNIT_ENGINE_SEMANTICS_VERSION: u32 = 18;
pub const PARAGRAPH_INDENT_ENGINE_SEMANTICS_VERSION: u32 = 19;
pub const TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION: u32 = 20;
pub const TEXT_HYPERLINK_ENGINE_SEMANTICS_VERSION: u32 = 21;
pub const TEXT_DECORATION_ENGINE_SEMANTICS_VERSION: u32 = 22;
pub const TEXT_DECORATION_STYLE_ENGINE_SEMANTICS_VERSION: u32 = 23;
pub const TEXT_DECORATION_OFFSET_ENGINE_SEMANTICS_VERSION: u32 = 24;
pub const TEXT_DECORATION_THICKNESS_ENGINE_SEMANTICS_VERSION: u32 = 25;
pub const TEXT_DECORATION_COLOR_ENGINE_SEMANTICS_VERSION: u32 = 26;
pub const TEXT_DECORATION_SKIP_INK_ENGINE_SEMANTICS_VERSION: u32 = 27;
pub const LEADING_TRIM_ENGINE_SEMANTICS_VERSION: u32 = 28;
pub const TEXT_LIST_TYPE_ENGINE_SEMANTICS_VERSION: u32 = 29;
pub const TEXT_LIST_SPACING_ENGINE_SEMANTICS_VERSION: u32 = 30;
pub const PARAGRAPH_STYLE_RUNS_ENGINE_SEMANTICS_VERSION: u32 = 31;
pub const TEXT_HANGING_LIST_ENGINE_SEMANTICS_VERSION: u32 = 32;
pub const PARAGRAPH_LIST_OPTIONS_ENGINE_SEMANTICS_VERSION: u32 = 33;
pub const PARAGRAPH_LIST_SPACING_ENGINE_SEMANTICS_VERSION: u32 = 34;
pub const PARAGRAPH_SPACING_ENGINE_SEMANTICS_VERSION: u32 = 35;
pub const PARAGRAPH_INDENT_RUN_ENGINE_SEMANTICS_VERSION: u32 = 36;
pub const PARAGRAPH_LINE_HEIGHT_ENGINE_SEMANTICS_VERSION: u32 = 37;
pub const TEXT_HANGING_PUNCTUATION_ENGINE_SEMANTICS_VERSION: u32 = 38;
pub const PARAGRAPH_TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION: u32 = 39;
pub const FONT_FACE_METADATA_ENGINE_SEMANTICS_VERSION: u32 = 40;
pub const FONT_NAME_ALIASES_ENGINE_SEMANTICS_VERSION: u32 = 41;
pub const OPEN_TYPE_FEATURES_ENGINE_SEMANTICS_VERSION: u32 = 42;
pub const TEXT_STYLE_LINK_ENGINE_SEMANTICS_VERSION: u32 = 43;
pub const TEXT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION: u32 = 44;
pub const PAINT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION: u32 = 45;
pub const PAINT_STYLE_LINK_ENGINE_SEMANTICS_VERSION: u32 = 46;
pub const TEXT_PAINT_STYLE_LINK_ENGINE_SEMANTICS_VERSION: u32 = 47;
pub const VARIABLE_CATALOG_ENGINE_SEMANTICS_VERSION: u32 = 48;
pub const VARIABLE_CODE_SYNTAX_ENGINE_SEMANTICS_VERSION: u32 = 49;
pub const STYLE_LIFECYCLE_ENGINE_SEMANTICS_VERSION: u32 = 50;
pub const STYLE_PUBLISHABLE_METADATA_ENGINE_SEMANTICS_VERSION: u32 = 51;
pub const TEXT_STYLE_PERCENT_LETTER_SPACING_ENGINE_SEMANTICS_VERSION: u32 = 52;
pub const TEXT_STYLE_VARIABLE_BINDINGS_ENGINE_SEMANTICS_VERSION: u32 = 53;
pub const PAINT_STYLE_VARIABLE_BINDINGS_ENGINE_SEMANTICS_VERSION: u32 = 54;
pub const TEXT_RANGE_VARIABLE_BINDINGS_ENGINE_SEMANTICS_VERSION: u32 = 55;
pub const GRID_AUTO_LAYOUT_ENGINE_SEMANTICS_VERSION: u32 = 56;
pub const GRID_HUG_TRACK_ENGINE_SEMANTICS_VERSION: u32 = 57;
pub const GRID_SPAN_ENGINE_SEMANTICS_VERSION: u32 = 58;
pub const GRID_MANUAL_PLACEMENT_ENGINE_SEMANTICS_VERSION: u32 = 59;
pub const GRID_AUTO_ROWS_ENGINE_SEMANTICS_VERSION: u32 = 60;
pub const GRID_CHILD_ALIGNMENT_ENGINE_SEMANTICS_VERSION: u32 = 61;
pub const GRID_CONTAINER_HUG_ENGINE_SEMANTICS_VERSION: u32 = 62;
pub const TEXT_DECORATION_COLOR_VARIABLE_ENGINE_SEMANTICS_VERSION: u32 = 63;
pub const EFFECT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION: u32 = 64;
pub const NORMAL_BLEND_ISOLATION_EXTENSION: &str = "makefigma.blend.normal-isolation.v1";
pub const CURRENT_ENGINE_SEMANTICS_VERSION: u32 = EFFECT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION;
pub type Hash = [u8; 32];
pub type Id = [u8; 16];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotError {
    Invalid,
    /// The snapshot declares canonical behavior newer than this reader can
    /// preserve. Reject it before decoding nodes so an older client cannot
    /// silently rewrite a newer Paint or layout contract.
    UnsupportedEngineSemantics,
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
    fill_stack: Option<PaintStack>,
    stroke_stack: Option<PaintStack>,
    paint_style_links: PaintStyleLinks,
}

pub fn snapshot_from_document(
    document: &Document,
    engine_semantics_version: u32,
) -> Result<Vec<u8>, SnapshotError> {
    if engine_semantics_version < EFFECT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION
        && document.effect_styles().next().is_some()
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < TEXT_DECORATION_COLOR_VARIABLE_ENGINE_SEMANTICS_VERSION
        && (document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_text_decoration_color_variable)
        }) || document.text_styles().any(|style| {
            style
                .style
                .text_decoration_color
                .as_ref()
                .is_some_and(|color| color.variable_id.is_some())
        }))
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < GRID_CONTAINER_HUG_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            let layout = document.auto_layout_for_node(node.id);
            layout.mode == LayoutMode::Grid
                && (layout.primary_sizing == LayoutSizing::Hug
                    || layout.counter_sizing == LayoutSizing::Hug)
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < GRID_CHILD_ALIGNMENT_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            let layout = document.auto_layout_for_node(node.id);
            layout.grid_child_horizontal_align != GridChildAlignment::Auto
                || layout.grid_child_vertical_align != GridChildAlignment::Auto
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < GRID_AUTO_ROWS_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document.auto_layout_for_node(node.id).grid_auto_tracks == GridAutoTracks::Rows
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < GRID_MANUAL_PLACEMENT_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            let layout = document.auto_layout_for_node(node.id);
            layout.grid_items_positioning == GridItemsPositioning::Manual
                || layout.grid_row_anchor.is_some()
                || layout.grid_column_anchor.is_some()
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < GRID_SPAN_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            let layout = document.auto_layout_for_node(node.id);
            layout.grid_row_span.is_some() || layout.grid_column_span.is_some()
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < GRID_HUG_TRACK_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            let layout = document.auto_layout_for_node(node.id);
            layout
                .grid_rows
                .iter()
                .chain(&layout.grid_columns)
                .any(|track| matches!(track, GridTrack::Hug))
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < GRID_AUTO_LAYOUT_ENGINE_SEMANTICS_VERSION
        && document
            .nodes()
            .any(|node| document.auto_layout_for_node(node.id).mode == LayoutMode::Grid)
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < TEXT_RANGE_VARIABLE_BINDINGS_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_variable_bindings)
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < PAINT_STYLE_VARIABLE_BINDINGS_ENGINE_SEMANTICS_VERSION
        && document
            .paint_styles()
            .any(|style| !style.variable_bindings.is_empty())
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < TEXT_STYLE_VARIABLE_BINDINGS_ENGINE_SEMANTICS_VERSION
        && document
            .text_styles()
            .any(|style| !style.variable_bindings.is_empty())
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < TEXT_STYLE_PERCENT_LETTER_SPACING_ENGINE_SEMANTICS_VERSION
        && document
            .text_styles()
            .any(|style| style.letter_spacing_unit == Some(TextStyleLetterSpacingUnit::Percent))
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < STYLE_PUBLISHABLE_METADATA_ENGINE_SEMANTICS_VERSION
        && (document.text_styles().any(style_has_publishable_metadata)
            || document
                .paint_styles()
                .any(paint_style_has_publishable_metadata))
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < TEXT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION
        && document.text_styles().next().is_some()
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < PAINT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION
        && document.paint_styles().next().is_some()
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < VARIABLE_CATALOG_ENGINE_SEMANTICS_VERSION
        && (document.variable_collections().next().is_some()
            || document.variables().next().is_some())
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < VARIABLE_CODE_SYNTAX_ENGINE_SEMANTICS_VERSION
        && document
            .variables()
            .any(|variable| !variable.code_syntax.is_empty())
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < PAINT_STYLE_LINK_ENGINE_SEMANTICS_VERSION
        && document
            .nodes()
            .any(|node| document.paint_style_links_for_node(node.id).is_some())
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < FONT_FACE_METADATA_ENGINE_SEMANTICS_VERSION
        && document.assets().any(|asset| !asset.font_faces.is_empty())
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < FONT_NAME_ALIASES_ENGINE_SEMANTICS_VERSION
        && document
            .assets()
            .any(|asset| asset.font_faces.iter().any(|face| !face.aliases.is_empty()))
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < PAINT_STACK_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document.fill_stack_for_node(node.id).is_some()
                || document.stroke_stack_for_node(node.id).is_some()
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < NON_LINEAR_GRADIENT_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            [
                document.fill_stack_for_node(node.id),
                document.stroke_stack_for_node(node.id),
            ]
            .into_iter()
            .flatten()
            .any(paint_stack_has_non_linear_gradient)
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < ADVANCED_BLEND_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            node.blend_mode.requires_advanced_blend_semantics()
                || [
                    document.fill_stack_for_node(node.id),
                    document.stroke_stack_for_node(node.id),
                ]
                .into_iter()
                .flatten()
                .flat_map(|stack| &stack.layers)
                .any(|layer| layer.blend_mode.requires_advanced_blend_semantics())
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < IMAGE_PAINT_ROTATION_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            [
                document.fill_stack_for_node(node.id),
                document.stroke_stack_for_node(node.id),
            ]
            .into_iter()
            .flatten()
            .any(paint_stack_has_rotated_image)
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < PASS_THROUGH_ENGINE_SEMANTICS_VERSION
        && document
            .nodes()
            .any(|node| node.blend_mode.requires_pass_through_semantics())
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < LINEAR_BLEND_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            node.blend_mode.requires_linear_blend_semantics()
                || [
                    document.fill_stack_for_node(node.id),
                    document.stroke_stack_for_node(node.id),
                ]
                .into_iter()
                .flatten()
                .any(paint_stack_has_linear_blend)
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < NORMAL_BLEND_ISOLATION_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            node.extensions
                .get(NORMAL_BLEND_ISOLATION_EXTENSION)
                .is_some_and(|value| value.as_slice() == [1])
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < IMAGE_FILTERS_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            [
                document.fill_stack_for_node(node.id),
                document.stroke_stack_for_node(node.id),
            ]
            .into_iter()
            .flatten()
            .any(paint_stack_has_image_filters)
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < TEXT_TRUNCATION_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_truncation)
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < SHAPE_WITH_TEXT_TEXT_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            node.kind == NodeKind::ShapeWithText
                && document.text_properties_for_node(node.id).is_some()
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < TEXT_RUN_PAINT_STACK_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_fill_stack)
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < TEXT_BASE_STYLE_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_base_style)
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < TEXT_CASE_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_text_case)
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < TEXT_PATH_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            node.kind == NodeKind::TextPath && document.text_properties_for_node(node.id).is_some()
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < LINE_HEIGHT_UNIT_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_line_height_unit)
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < PARAGRAPH_INDENT_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_paragraph_indent)
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_text_wrap_style)
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < TEXT_LIST_TYPE_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_list_type)
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < TEXT_LIST_SPACING_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_list_spacing)
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < PARAGRAPH_STYLE_RUNS_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_paragraph_style_runs)
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < TEXT_HANGING_LIST_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_hanging_list)
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < PARAGRAPH_LIST_OPTIONS_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_paragraph_list_options)
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < PARAGRAPH_LIST_SPACING_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_paragraph_list_spacing)
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < PARAGRAPH_SPACING_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_paragraph_spacing)
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < PARAGRAPH_INDENT_RUN_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_paragraph_indent_run)
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < PARAGRAPH_LINE_HEIGHT_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_paragraph_line_height)
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < TEXT_HANGING_PUNCTUATION_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_hanging_punctuation)
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < PARAGRAPH_TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_paragraph_text_wrap_style)
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < TEXT_HYPERLINK_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_hyperlink)
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < TEXT_DECORATION_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_text_decoration)
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < TEXT_DECORATION_STYLE_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_text_decoration_style)
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < TEXT_DECORATION_OFFSET_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_text_decoration_offset)
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < TEXT_DECORATION_THICKNESS_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_text_decoration_thickness)
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < TEXT_DECORATION_COLOR_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_text_decoration_color)
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < TEXT_DECORATION_SKIP_INK_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_text_decoration_skip_ink)
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < LEADING_TRIM_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_leading_trim)
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < OPEN_TYPE_FEATURES_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_open_type_features)
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < TEXT_STYLE_LINK_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_text_style_link)
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    if engine_semantics_version < TEXT_PAINT_STYLE_LINK_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_paint_style_link)
        })
    {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
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
                            document.fill_stack_for_node(node.id),
                            document.stroke_stack_for_node(node.id),
                            document.paint_style_links_for_node(node.id),
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
        text_styles: document
            .text_styles()
            .map(text_style_resource_to_proto)
            .collect(),
        paint_styles: document
            .paint_styles()
            .map(paint_style_resource_to_proto)
            .collect(),
        variable_collections: document
            .variable_collections()
            .map(variable_collection_to_proto)
            .collect(),
        variables: document
            .variables()
            .map(variable_resource_to_proto)
            .collect(),
        effect_styles: document
            .effect_styles()
            .map(effect_style_resource_to_proto)
            .collect(),
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
    document_from_snapshot_with_engine_semantics(
        bytes,
        expected_document_id,
        expected_hash,
        CURRENT_ENGINE_SEMANTICS_VERSION,
    )
}

pub fn document_from_snapshot_with_engine_semantics(
    bytes: &[u8],
    expected_document_id: Id,
    expected_hash: Hash,
    supported_engine_semantics_version: u32,
) -> Result<Document, SnapshotError> {
    let snapshot = v1::DocumentSnapshot::decode(bytes).map_err(|_| SnapshotError::Invalid)?;
    if snapshot.format_version != SNAPSHOT_FORMAT_VERSION
        || snapshot.document_id.as_slice() != expected_document_id.as_slice()
    {
        return Err(SnapshotError::Invalid);
    }
    if snapshot.engine_semantics_version > supported_engine_semantics_version {
        return Err(SnapshotError::UnsupportedEngineSemantics);
    }
    let declared_engine_semantics_version = snapshot.engine_semantics_version;
    if declared_engine_semantics_version < GRID_CONTAINER_HUG_ENGINE_SEMANTICS_VERSION
        && snapshot
            .page_chunks
            .iter()
            .flat_map(|page| &page.nodes)
            .any(|node| {
                v1::SceneNode::decode(node.canonical_node.as_slice())
                    .ok()
                    .and_then(|node| node.auto_layout)
                    .is_some_and(|layout| {
                        layout.mode == v1::LayoutMode::Grid as i32
                            && (layout.primary_sizing == v1::LayoutSizing::Hug as i32
                                || layout.counter_sizing == v1::LayoutSizing::Hug as i32)
                    })
            })
    {
        return Err(SnapshotError::Invalid);
    }
    if declared_engine_semantics_version < GRID_CHILD_ALIGNMENT_ENGINE_SEMANTICS_VERSION
        && snapshot
            .page_chunks
            .iter()
            .flat_map(|page| &page.nodes)
            .any(|node| {
                v1::SceneNode::decode(node.canonical_node.as_slice())
                    .ok()
                    .and_then(|node| node.auto_layout)
                    .is_some_and(|layout| {
                        layout.grid_child_horizontal_align.is_some()
                            || layout.grid_child_vertical_align.is_some()
                    })
            })
    {
        return Err(SnapshotError::Invalid);
    }
    if declared_engine_semantics_version < GRID_AUTO_ROWS_ENGINE_SEMANTICS_VERSION
        && snapshot
            .page_chunks
            .iter()
            .flat_map(|page| &page.nodes)
            .any(|node| {
                v1::SceneNode::decode(node.canonical_node.as_slice())
                    .ok()
                    .and_then(|node| node.auto_layout)
                    .is_some_and(|layout| layout.grid_auto_tracks.is_some())
            })
    {
        return Err(SnapshotError::Invalid);
    }
    if declared_engine_semantics_version < GRID_MANUAL_PLACEMENT_ENGINE_SEMANTICS_VERSION
        && snapshot
            .page_chunks
            .iter()
            .flat_map(|page| &page.nodes)
            .any(|node| {
                v1::SceneNode::decode(node.canonical_node.as_slice())
                    .ok()
                    .and_then(|node| node.auto_layout)
                    .is_some_and(|layout| {
                        layout.grid_items_positioning.is_some()
                            || layout.grid_row_anchor.is_some()
                            || layout.grid_column_anchor.is_some()
                    })
            })
    {
        return Err(SnapshotError::Invalid);
    }
    if declared_engine_semantics_version < GRID_SPAN_ENGINE_SEMANTICS_VERSION
        && snapshot
            .page_chunks
            .iter()
            .flat_map(|page| &page.nodes)
            .any(|node| {
                v1::SceneNode::decode(node.canonical_node.as_slice())
                    .ok()
                    .and_then(|node| node.auto_layout)
                    .is_some_and(|layout| {
                        layout.grid_row_span.is_some() || layout.grid_column_span.is_some()
                    })
            })
    {
        return Err(SnapshotError::Invalid);
    }
    if declared_engine_semantics_version < GRID_HUG_TRACK_ENGINE_SEMANTICS_VERSION
        && snapshot
            .page_chunks
            .iter()
            .flat_map(|page| &page.nodes)
            .any(|node| {
                v1::SceneNode::decode(node.canonical_node.as_slice())
                    .ok()
                    .and_then(|node| node.auto_layout)
                    .is_some_and(|layout| {
                        layout
                            .grid_rows
                            .iter()
                            .chain(&layout.grid_columns)
                            .any(|track| track.r#type == v1::GridTrackType::Hug as i32)
                    })
            })
    {
        return Err(SnapshotError::Invalid);
    }
    if declared_engine_semantics_version < GRID_AUTO_LAYOUT_ENGINE_SEMANTICS_VERSION
        && snapshot
            .page_chunks
            .iter()
            .flat_map(|page| &page.nodes)
            .any(|node| {
                v1::SceneNode::decode(node.canonical_node.as_slice())
                    .ok()
                    .and_then(|node| node.auto_layout)
                    .is_some_and(|layout| {
                        layout.mode == v1::LayoutMode::Grid as i32
                            || !layout.grid_rows.is_empty()
                            || !layout.grid_columns.is_empty()
                            || layout.grid_row_gap.is_some()
                            || layout.grid_column_gap.is_some()
                    })
            })
    {
        return Err(SnapshotError::Invalid);
    }
    let mut document = Document::with_id(DocumentId(id(&snapshot.document_id)?));
    document.seed_color_profile(profile_from_proto(snapshot.document_color_profile)?);
    for asset in snapshot.resource_index {
        if declared_engine_semantics_version < FONT_FACE_METADATA_ENGINE_SEMANTICS_VERSION
            && !asset.font_faces.is_empty()
        {
            return Err(SnapshotError::Invalid);
        }
        if declared_engine_semantics_version < FONT_NAME_ALIASES_ENGINE_SEMANTICS_VERSION
            && asset.font_faces.iter().any(|face| !face.aliases.is_empty())
        {
            return Err(SnapshotError::Invalid);
        }
        document
            .seed_asset(asset_from_proto(asset)?)
            .map_err(|_| SnapshotError::Invalid)?;
    }
    if declared_engine_semantics_version < TEXT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION
        && !snapshot.text_styles.is_empty()
    {
        return Err(SnapshotError::Invalid);
    }
    if declared_engine_semantics_version < STYLE_PUBLISHABLE_METADATA_ENGINE_SEMANTICS_VERSION
        && (snapshot
            .text_styles
            .iter()
            .any(text_style_proto_has_publishable_metadata)
            || snapshot
                .paint_styles
                .iter()
                .any(paint_style_proto_has_publishable_metadata))
    {
        return Err(SnapshotError::Invalid);
    }
    if declared_engine_semantics_version
        < TEXT_STYLE_PERCENT_LETTER_SPACING_ENGINE_SEMANTICS_VERSION
        && snapshot.text_styles.iter().any(|style| {
            style.letter_spacing_unit == Some(v1::TextStyleLetterSpacingUnit::Percent as i32)
        })
    {
        return Err(SnapshotError::Invalid);
    }
    if declared_engine_semantics_version < TEXT_STYLE_VARIABLE_BINDINGS_ENGINE_SEMANTICS_VERSION
        && snapshot
            .text_styles
            .iter()
            .any(|style| !style.variable_bindings.is_empty())
    {
        return Err(SnapshotError::Invalid);
    }
    if declared_engine_semantics_version < TEXT_DECORATION_COLOR_VARIABLE_ENGINE_SEMANTICS_VERSION
        && snapshot.text_styles.iter().any(|style| {
            style
                .style
                .as_ref()
                .and_then(|run| run.text_decoration_color.as_ref())
                .is_some_and(|color| color.variable_id.is_some())
        })
    {
        return Err(SnapshotError::Invalid);
    }
    if declared_engine_semantics_version < PAINT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION
        && !snapshot.paint_styles.is_empty()
    {
        return Err(SnapshotError::Invalid);
    }
    if declared_engine_semantics_version < EFFECT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION
        && !snapshot.effect_styles.is_empty()
    {
        return Err(SnapshotError::Invalid);
    }
    if declared_engine_semantics_version < PAINT_STYLE_VARIABLE_BINDINGS_ENGINE_SEMANTICS_VERSION
        && snapshot
            .paint_styles
            .iter()
            .any(|style| !style.variable_bindings.is_empty())
    {
        return Err(SnapshotError::Invalid);
    }
    if declared_engine_semantics_version < VARIABLE_CATALOG_ENGINE_SEMANTICS_VERSION
        && (!snapshot.variable_collections.is_empty() || !snapshot.variables.is_empty())
    {
        return Err(SnapshotError::Invalid);
    }
    for collection in snapshot.variable_collections {
        document
            .seed_variable_collection(variable_collection_from_proto(collection)?)
            .map_err(|_| SnapshotError::Invalid)?;
    }
    for variable in snapshot.variables {
        if declared_engine_semantics_version < VARIABLE_CODE_SYNTAX_ENGINE_SEMANTICS_VERSION
            && !variable.code_syntax.is_empty()
        {
            return Err(SnapshotError::Invalid);
        }
        document
            .seed_variable(variable_resource_from_proto(variable)?)
            .map_err(|_| SnapshotError::Invalid)?;
    }
    document
        .validate_variable_catalog()
        .map_err(|_| SnapshotError::Invalid)?;
    for style in snapshot.text_styles {
        document
            .seed_text_style(text_style_resource_from_proto(style)?)
            .map_err(|_| SnapshotError::Invalid)?;
    }
    for style in snapshot.paint_styles {
        document
            .seed_paint_style(paint_style_resource_from_proto(style)?)
            .map_err(|_| SnapshotError::Invalid)?;
    }
    for style in snapshot.effect_styles {
        document
            .seed_effect_style(effect_style_resource_from_proto(style)?)
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
            let (
                page_id,
                node,
                asset_id,
                text_properties,
                auto_layout,
                fill_stack,
                stroke_stack,
                paint_style_links,
            ) = node_from_proto(node_proto)?;
            if declared_engine_semantics_version < PAINT_STACK_ENGINE_SEMANTICS_VERSION
                && (fill_stack.is_some() || stroke_stack.is_some())
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < NON_LINEAR_GRADIENT_ENGINE_SEMANTICS_VERSION
                && [fill_stack.as_ref(), stroke_stack.as_ref()]
                    .into_iter()
                    .flatten()
                    .any(paint_stack_has_non_linear_gradient)
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < ADVANCED_BLEND_ENGINE_SEMANTICS_VERSION
                && (node.blend_mode.requires_advanced_blend_semantics()
                    || [fill_stack.as_ref(), stroke_stack.as_ref()]
                        .into_iter()
                        .flatten()
                        .flat_map(|stack| &stack.layers)
                        .any(|layer| layer.blend_mode.requires_advanced_blend_semantics()))
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < IMAGE_PAINT_ROTATION_ENGINE_SEMANTICS_VERSION
                && [fill_stack.as_ref(), stroke_stack.as_ref()]
                    .into_iter()
                    .flatten()
                    .any(paint_stack_has_rotated_image)
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < PASS_THROUGH_ENGINE_SEMANTICS_VERSION
                && node.blend_mode.requires_pass_through_semantics()
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < LINEAR_BLEND_ENGINE_SEMANTICS_VERSION
                && (node.blend_mode.requires_linear_blend_semantics()
                    || [fill_stack.as_ref(), stroke_stack.as_ref()]
                        .into_iter()
                        .flatten()
                        .any(paint_stack_has_linear_blend))
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < NORMAL_BLEND_ISOLATION_ENGINE_SEMANTICS_VERSION
                && node
                    .extensions
                    .get(NORMAL_BLEND_ISOLATION_EXTENSION)
                    .is_some_and(|value| value.as_slice() == [1])
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < IMAGE_FILTERS_ENGINE_SEMANTICS_VERSION
                && [fill_stack.as_ref(), stroke_stack.as_ref()]
                    .into_iter()
                    .flatten()
                    .any(paint_stack_has_image_filters)
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < TEXT_TRUNCATION_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_truncation)
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < SHAPE_WITH_TEXT_TEXT_ENGINE_SEMANTICS_VERSION
                && node.kind == NodeKind::ShapeWithText
                && text_properties.is_some()
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < TEXT_RUN_PAINT_STACK_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_fill_stack)
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < TEXT_BASE_STYLE_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_base_style)
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < TEXT_CASE_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_text_case)
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < TEXT_PATH_ENGINE_SEMANTICS_VERSION
                && node.kind == NodeKind::TextPath
                && text_properties.is_some()
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < LINE_HEIGHT_UNIT_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_line_height_unit)
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < PARAGRAPH_INDENT_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_paragraph_indent)
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_text_wrap_style)
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < TEXT_LIST_TYPE_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_list_type)
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < TEXT_LIST_SPACING_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_list_spacing)
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < PARAGRAPH_STYLE_RUNS_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_paragraph_style_runs)
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < TEXT_HANGING_LIST_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_hanging_list)
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < PARAGRAPH_LIST_OPTIONS_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_paragraph_list_options)
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < PARAGRAPH_LIST_SPACING_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_paragraph_list_spacing)
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < PARAGRAPH_SPACING_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_paragraph_spacing)
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < PARAGRAPH_INDENT_RUN_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_paragraph_indent_run)
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < PARAGRAPH_LINE_HEIGHT_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_paragraph_line_height)
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < TEXT_HANGING_PUNCTUATION_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_hanging_punctuation)
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version
                < PARAGRAPH_TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_paragraph_text_wrap_style)
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < TEXT_HYPERLINK_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_hyperlink)
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < TEXT_DECORATION_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_text_decoration)
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < TEXT_DECORATION_STYLE_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_text_decoration_style)
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < TEXT_DECORATION_OFFSET_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_text_decoration_offset)
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version
                < TEXT_DECORATION_THICKNESS_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_text_decoration_thickness)
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < TEXT_DECORATION_COLOR_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_text_decoration_color)
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version
                < TEXT_DECORATION_COLOR_VARIABLE_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_text_decoration_color_variable)
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < TEXT_DECORATION_SKIP_INK_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_text_decoration_skip_ink)
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < LEADING_TRIM_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_leading_trim)
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < OPEN_TYPE_FEATURES_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_open_type_features)
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version
                < TEXT_RANGE_VARIABLE_BINDINGS_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_variable_bindings)
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < TEXT_STYLE_LINK_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_text_style_link)
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < TEXT_PAINT_STYLE_LINK_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_paint_style_link)
            {
                return Err(SnapshotError::Invalid);
            }
            if declared_engine_semantics_version < PAINT_STYLE_LINK_ENGINE_SEMANTICS_VERSION
                && !paint_style_links.is_empty()
            {
                return Err(SnapshotError::Invalid);
            }
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
                        fill_stack,
                        stroke_stack,
                        paint_style_links,
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
        document
            .seed_paint_stacks(
                decoded.node.id,
                decoded.fill_stack.clone(),
                decoded.stroke_stack.clone(),
            )
            .map_err(|_| SnapshotError::Invalid)?;
        document
            .seed_paint_style_links(decoded.node.id, decoded.paint_style_links.clone())
            .map_err(|_| SnapshotError::Invalid)?;
    }
    for retired_id in snapshot.retired_node_ids {
        document
            .seed_retired_id(NodeId(id(&retired_id)?))
            .map_err(|_| SnapshotError::Invalid)?;
    }
    document
        .validate_seeded_structure()
        .map_err(|_| SnapshotError::Invalid)?;
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
                || !can_parent_contain_child(&parent.node.kind, &node.kind)
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
        font_faces: asset
            .font_faces
            .iter()
            .map(|face| v1::FontFaceMetadata {
                face_index: face.face_index,
                family: face.family.clone(),
                style: face.style.clone(),
                aliases: face
                    .aliases
                    .iter()
                    .map(|alias| v1::FontNameAlias {
                        family: alias.family.clone(),
                        style: alias.style.clone(),
                    })
                    .collect(),
            })
            .collect(),
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
fn node_to_proto(
    node: &Node,
    page_id: PageId,
    asset_id: Option<AssetId>,
    text_properties: Option<&TextProperties>,
    auto_layout: AutoLayout,
    fill_stack: Option<&PaintStack>,
    stroke_stack: Option<&PaintStack>,
    paint_style_links: Option<&PaintStyleLinks>,
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
        fill_stack: fill_stack.map(paint_stack_to_proto),
        stroke_stack: stroke_stack.map(paint_stack_to_proto),
        fill_style_id: paint_style_links.and_then(|links| links.fill.clone()),
        stroke_style_id: paint_style_links.and_then(|links| links.stroke.clone()),
        background_style_id: paint_style_links.and_then(|links| links.background.clone()),
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
        Option<PaintStack>,
        Option<PaintStack>,
        PaintStyleLinks,
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
    let fill_stack = node.fill_stack.map(paint_stack_from_proto).transpose()?;
    let stroke_stack = node.stroke_stack.map(paint_stack_from_proto).transpose()?;
    let paint_style_links = PaintStyleLinks {
        fill: node.fill_style_id.clone(),
        stroke: node.stroke_style_id.clone(),
        background: node.background_style_id.clone(),
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
        fill_stack,
        stroke_stack,
        paint_style_links,
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
            LayoutMode::Grid => v1::LayoutMode::Grid,
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
        grid_rows: value.grid_rows.iter().map(grid_track_to_proto).collect(),
        grid_columns: value.grid_columns.iter().map(grid_track_to_proto).collect(),
        grid_row_gap: value.grid_row_gap,
        grid_column_gap: value.grid_column_gap,
        grid_row_span: value.grid_row_span,
        grid_column_span: value.grid_column_span,
        grid_items_positioning: (value.grid_items_positioning == GridItemsPositioning::Manual)
            .then_some(v1::GridItemsPositioning::Manual as i32),
        grid_row_anchor: value.grid_row_anchor,
        grid_column_anchor: value.grid_column_anchor,
        grid_auto_tracks: (value.grid_auto_tracks == GridAutoTracks::Rows)
            .then_some(v1::GridAutoTracks::Rows as i32),
        grid_child_horizontal_align: grid_child_alignment_to_proto(
            value.grid_child_horizontal_align,
        ),
        grid_child_vertical_align: grid_child_alignment_to_proto(value.grid_child_vertical_align),
    }
}
fn grid_child_alignment_to_proto(value: GridChildAlignment) -> Option<i32> {
    match value {
        GridChildAlignment::Auto => None,
        GridChildAlignment::Min => Some(v1::GridChildAlignment::Min as i32),
        GridChildAlignment::Center => Some(v1::GridChildAlignment::Center as i32),
        GridChildAlignment::Max => Some(v1::GridChildAlignment::Max as i32),
    }
}
fn grid_child_alignment_from_proto(
    value: Option<i32>,
) -> Result<GridChildAlignment, SnapshotError> {
    match value
        .map(v1::GridChildAlignment::try_from)
        .transpose()
        .map_err(|_| SnapshotError::Invalid)?
    {
        None | Some(v1::GridChildAlignment::Auto) => Ok(GridChildAlignment::Auto),
        Some(v1::GridChildAlignment::Min) => Ok(GridChildAlignment::Min),
        Some(v1::GridChildAlignment::Center) => Ok(GridChildAlignment::Center),
        Some(v1::GridChildAlignment::Max) => Ok(GridChildAlignment::Max),
        Some(v1::GridChildAlignment::Unspecified) => Err(SnapshotError::Invalid),
    }
}
fn grid_track_to_proto(value: &GridTrack) -> v1::GridTrack {
    let (r#type, value) = match value {
        GridTrack::Flex(value) => (v1::GridTrackType::Flex, *value),
        GridTrack::Fixed(value) => (v1::GridTrackType::Fixed, *value),
        GridTrack::Hug => (v1::GridTrackType::Hug, 0.0),
    };
    v1::GridTrack {
        r#type: r#type as i32,
        value,
    }
}
fn grid_track_from_proto(value: v1::GridTrack) -> Result<GridTrack, SnapshotError> {
    match v1::GridTrackType::try_from(value.r#type).map_err(|_| SnapshotError::Invalid)? {
        v1::GridTrackType::Flex => Ok(GridTrack::Flex(value.value)),
        v1::GridTrackType::Fixed => Ok(GridTrack::Fixed(value.value)),
        v1::GridTrackType::Hug => Ok(GridTrack::Hug),
        v1::GridTrackType::Unspecified => Err(SnapshotError::Invalid),
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
        v1::LayoutMode::Grid => LayoutMode::Grid,
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
    let grid_items_positioning = match value.grid_items_positioning {
        None => GridItemsPositioning::RowAutoFlow,
        Some(raw) => {
            match v1::GridItemsPositioning::try_from(raw).map_err(|_| SnapshotError::Invalid)? {
                v1::GridItemsPositioning::RowAutoFlow => GridItemsPositioning::RowAutoFlow,
                v1::GridItemsPositioning::Manual => GridItemsPositioning::Manual,
                v1::GridItemsPositioning::Unspecified => return Err(SnapshotError::Invalid),
            }
        }
    };
    let grid_auto_tracks = match value.grid_auto_tracks {
        None => GridAutoTracks::None,
        Some(raw) => match v1::GridAutoTracks::try_from(raw).map_err(|_| SnapshotError::Invalid)? {
            v1::GridAutoTracks::None => GridAutoTracks::None,
            v1::GridAutoTracks::Rows => GridAutoTracks::Rows,
            v1::GridAutoTracks::Unspecified => return Err(SnapshotError::Invalid),
        },
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
        grid_rows: value
            .grid_rows
            .into_iter()
            .map(grid_track_from_proto)
            .collect::<Result<_, _>>()?,
        grid_columns: value
            .grid_columns
            .into_iter()
            .map(grid_track_from_proto)
            .collect::<Result<_, _>>()?,
        grid_row_gap: value.grid_row_gap,
        grid_column_gap: value.grid_column_gap,
        grid_row_span: value.grid_row_span,
        grid_column_span: value.grid_column_span,
        grid_items_positioning,
        grid_row_anchor: value.grid_row_anchor,
        grid_column_anchor: value.grid_column_anchor,
        grid_auto_tracks,
        grid_child_horizontal_align: grid_child_alignment_from_proto(
            value.grid_child_horizontal_align,
        )?,
        grid_child_vertical_align: grid_child_alignment_from_proto(
            value.grid_child_vertical_align,
        )?,
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
        BlendMode::ColorDodge => v1::BlendMode::ColorDodge,
        BlendMode::ColorBurn => v1::BlendMode::ColorBurn,
        BlendMode::HardLight => v1::BlendMode::HardLight,
        BlendMode::SoftLight => v1::BlendMode::SoftLight,
        BlendMode::Difference => v1::BlendMode::Difference,
        BlendMode::Exclusion => v1::BlendMode::Exclusion,
        BlendMode::Hue => v1::BlendMode::Hue,
        BlendMode::Saturation => v1::BlendMode::Saturation,
        BlendMode::Color => v1::BlendMode::Color,
        BlendMode::Luminosity => v1::BlendMode::Luminosity,
        BlendMode::PassThrough => v1::BlendMode::PassThrough,
        BlendMode::LinearBurn => v1::BlendMode::LinearBurn,
        BlendMode::LinearDodge => v1::BlendMode::LinearDodge,
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
        Ok(v1::BlendMode::ColorDodge) => Ok(BlendMode::ColorDodge),
        Ok(v1::BlendMode::ColorBurn) => Ok(BlendMode::ColorBurn),
        Ok(v1::BlendMode::HardLight) => Ok(BlendMode::HardLight),
        Ok(v1::BlendMode::SoftLight) => Ok(BlendMode::SoftLight),
        Ok(v1::BlendMode::Difference) => Ok(BlendMode::Difference),
        Ok(v1::BlendMode::Exclusion) => Ok(BlendMode::Exclusion),
        Ok(v1::BlendMode::Hue) => Ok(BlendMode::Hue),
        Ok(v1::BlendMode::Saturation) => Ok(BlendMode::Saturation),
        Ok(v1::BlendMode::Color) => Ok(BlendMode::Color),
        Ok(v1::BlendMode::Luminosity) => Ok(BlendMode::Luminosity),
        Ok(v1::BlendMode::PassThrough) => Ok(BlendMode::PassThrough),
        Ok(v1::BlendMode::LinearBurn) => Ok(BlendMode::LinearBurn),
        Ok(v1::BlendMode::LinearDodge) => Ok(BlendMode::LinearDodge),
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
                fill_stack: run.fill_stack.as_ref().map(paint_stack_to_proto),
                text_case: run.text_case.map(text_case_to_proto),
                hyperlink: run.hyperlink.as_ref().map(hyperlink_to_proto),
                text_decoration: run.text_decoration.map(text_decoration_to_proto),
                text_decoration_style: run
                    .text_decoration_style
                    .map(text_decoration_style_to_proto),
                text_decoration_offset: run
                    .text_decoration_offset
                    .map(text_decoration_offset_to_proto),
                text_decoration_thickness: run
                    .text_decoration_thickness
                    .map(text_decoration_thickness_to_proto),
                text_decoration_skip_ink: run.text_decoration_skip_ink,
                leading_trim: run.leading_trim.map(leading_trim_to_proto),
                open_type_features: open_type_features_to_proto(&run.open_type_features),
                text_style_id: run.text_style_id.clone(),
                paint_style_id: run.paint_style_id.clone(),
                variable_bindings: style_variable_bindings_to_proto(&run.variable_bindings),
                text_decoration_color: run
                    .text_decoration_color
                    .as_deref()
                    .map(text_decoration_color_to_proto),
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
            line_height_unit: properties
                .paragraph
                .line_height_unit
                .map(line_height_unit_to_proto),
            paragraph_indent: properties.paragraph.paragraph_indent,
            text_wrap_style: properties
                .paragraph
                .text_wrap_style
                .map(text_wrap_style_to_proto),
            list_type: properties.paragraph.list_type.map(text_list_type_to_proto),
            list_spacing: properties.paragraph.list_spacing,
            hanging_list: properties.paragraph.hanging_list.then_some(true),
            hanging_punctuation: properties.paragraph.hanging_punctuation.then_some(true),
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
        text_truncation: (properties.text_truncation == TextTruncation::Ending)
            .then_some(v1::TextTruncation::Ending as i32),
        max_lines: properties.max_lines,
        base_style: properties
            .base_style
            .as_ref()
            .map(|style| v1::TextStyleRun {
                start: 0,
                end: 0,
                font: style.font.as_ref().map(font_to_proto),
                font_size: style.font_size,
                font_weight: u32::from(style.font_weight),
                italic: style.italic,
                letter_spacing: style.letter_spacing,
                color: style.color.map(color_to_proto),
                fill_stack: style.fill_stack.as_ref().map(paint_stack_to_proto),
                text_case: style.text_case.map(text_case_to_proto),
                hyperlink: style.hyperlink.as_ref().map(hyperlink_to_proto),
                text_decoration: style.text_decoration.map(text_decoration_to_proto),
                text_decoration_style: style
                    .text_decoration_style
                    .map(text_decoration_style_to_proto),
                text_decoration_offset: style
                    .text_decoration_offset
                    .map(text_decoration_offset_to_proto),
                text_decoration_thickness: style
                    .text_decoration_thickness
                    .map(text_decoration_thickness_to_proto),
                text_decoration_skip_ink: style.text_decoration_skip_ink,
                leading_trim: style.leading_trim.map(leading_trim_to_proto),
                open_type_features: open_type_features_to_proto(&style.open_type_features),
                text_style_id: style.text_style_id.clone(),
                paint_style_id: style.paint_style_id.clone(),
                variable_bindings: style_variable_bindings_to_proto(&style.variable_bindings),
                text_decoration_color: style
                    .text_decoration_color
                    .as_deref()
                    .map(text_decoration_color_to_proto),
            }),
        paragraph_style_runs: properties
            .paragraph_style_runs
            .iter()
            .map(|run| v1::ParagraphStyleRun {
                start: run.start,
                indentation: run.indentation,
                list_type: run.list_type.map(paragraph_list_type_to_proto),
                list_spacing: run.list_spacing,
                paragraph_spacing: run.paragraph_spacing,
                paragraph_indent: run.paragraph_indent,
                line_height: run.line_height,
                line_height_unit: run.line_height_unit.map(line_height_unit_to_proto),
                text_wrap_style: run.text_wrap_style.map(text_wrap_style_to_proto),
            })
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
                    open_type_features: open_type_features_from_proto(run.open_type_features)?,
                    text_style_id: run.text_style_id,
                    paint_style_id: run.paint_style_id,
                    variable_bindings: style_variable_bindings_from_proto(run.variable_bindings)?,
                    text_decoration_color: run
                        .text_decoration_color
                        .map(text_decoration_color_from_proto)
                        .transpose()?
                        .map(Box::new),
                })
            })
            .collect::<Result<_, SnapshotError>>()?,
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
            // Explicit zero is Figma's default and is not a semantics-30
            // capability. Keep malformed negative/non-finite values present so
            // Core validation rejects them instead of silently repairing data.
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
            .collect::<Result<_, SnapshotError>>()?,
        auto_size,
        text_truncation: match value.text_truncation {
            None => TextTruncation::Disabled,
            Some(raw) => {
                match v1::TextTruncation::try_from(raw).map_err(|_| SnapshotError::Invalid)? {
                    v1::TextTruncation::Disabled => TextTruncation::Disabled,
                    v1::TextTruncation::Ending => TextTruncation::Ending,
                    v1::TextTruncation::Unspecified => return Err(SnapshotError::Invalid),
                }
            }
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
                        .map_err(|_| SnapshotError::Invalid)?,
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
                    open_type_features: open_type_features_from_proto(style.open_type_features)?,
                    text_style_id: style.text_style_id,
                    paint_style_id: style.paint_style_id,
                    variable_bindings: style_variable_bindings_from_proto(style.variable_bindings)?,
                    text_decoration_color: style
                        .text_decoration_color
                        .map(text_decoration_color_from_proto)
                        .transpose()?
                        .map(Box::new),
                })
            })
            .transpose()?,
        fallback_fonts: value
            .fallback_fonts
            .into_iter()
            .map(font_from_proto)
            .collect::<Result<_, SnapshotError>>()?,
    })
}

fn text_style_resource_to_proto(resource: &TextStyleResource) -> v1::TextStyleResource {
    let mut properties = TextProperties::default();
    properties.paragraph = resource.paragraph.clone();
    properties.base_style = Some(resource.style.clone());
    let encoded = text_properties_to_proto(&properties);
    v1::TextStyleResource {
        id: resource.id.clone(),
        key: resource.key.clone(),
        name: resource.name.clone(),
        description: resource.description.clone(),
        remote: resource.remote,
        style: encoded.base_style,
        paragraph: encoded.paragraph,
        description_markdown: resource.description_markdown.clone(),
        documentation_links: resource
            .documentation_links
            .iter()
            .map(|uri| v1::DocumentationLink { uri: uri.clone() })
            .collect(),
        letter_spacing_unit: resource.letter_spacing_unit.map(|unit| match unit {
            TextStyleLetterSpacingUnit::Percent => v1::TextStyleLetterSpacingUnit::Percent as i32,
        }),
        variable_bindings: resource
            .variable_bindings
            .iter()
            .map(|(field, variable_id)| v1::StyleVariableBinding {
                field: field.clone(),
                variable_id: variable_id.clone(),
            })
            .collect(),
    }
}

fn style_has_publishable_metadata(resource: &TextStyleResource) -> bool {
    !resource.description_markdown.is_empty() || !resource.documentation_links.is_empty()
}

fn paint_style_has_publishable_metadata(resource: &PaintStyleResource) -> bool {
    !resource.description_markdown.is_empty() || !resource.documentation_links.is_empty()
}

fn text_style_proto_has_publishable_metadata(resource: &v1::TextStyleResource) -> bool {
    !resource.description_markdown.is_empty() || !resource.documentation_links.is_empty()
}

fn paint_style_proto_has_publishable_metadata(resource: &v1::PaintStyleResource) -> bool {
    !resource.description_markdown.is_empty() || !resource.documentation_links.is_empty()
}

fn text_style_resource_from_proto(
    resource: v1::TextStyleResource,
) -> Result<TextStyleResource, SnapshotError> {
    let variable_binding_count = resource.variable_bindings.len();
    let variable_bindings = resource
        .variable_bindings
        .into_iter()
        .map(|binding| (binding.field, binding.variable_id))
        .collect::<BTreeMap<_, _>>();
    if variable_bindings.len() != variable_binding_count {
        return Err(SnapshotError::Invalid);
    }
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
        description_markdown: resource.description_markdown,
        documentation_links: resource
            .documentation_links
            .into_iter()
            .map(|link| link.uri)
            .collect(),
        letter_spacing_unit: resource
            .letter_spacing_unit
            .map(
                |unit| match v1::TextStyleLetterSpacingUnit::try_from(unit) {
                    Ok(v1::TextStyleLetterSpacingUnit::Percent) => {
                        Ok(TextStyleLetterSpacingUnit::Percent)
                    }
                    _ => Err(SnapshotError::Invalid),
                },
            )
            .transpose()?,
        variable_bindings,
        remote: resource.remote,
        style: properties.base_style.ok_or(SnapshotError::Invalid)?,
        paragraph: properties.paragraph,
    })
}

fn paint_style_resource_to_proto(resource: &PaintStyleResource) -> v1::PaintStyleResource {
    v1::PaintStyleResource {
        id: resource.id.clone(),
        key: resource.key.clone(),
        name: resource.name.clone(),
        description: resource.description.clone(),
        remote: resource.remote,
        paints: Some(paint_stack_to_proto(&resource.paints)),
        description_markdown: resource.description_markdown.clone(),
        documentation_links: resource
            .documentation_links
            .iter()
            .map(|uri| v1::DocumentationLink { uri: uri.clone() })
            .collect(),
        variable_bindings: resource
            .variable_bindings
            .iter()
            .map(|binding| v1::PaintStyleVariableBinding {
                paint_index: binding.paint_index,
                stop_index: binding.stop_index,
                variable_id: binding.variable_id.clone(),
            })
            .collect(),
    }
}

fn paint_style_resource_from_proto(
    resource: v1::PaintStyleResource,
) -> Result<PaintStyleResource, SnapshotError> {
    let variable_bindings = resource
        .variable_bindings
        .into_iter()
        .map(|binding| PaintStyleVariableBinding {
            paint_index: binding.paint_index,
            stop_index: binding.stop_index,
            variable_id: binding.variable_id,
        })
        .collect::<Vec<_>>();
    if !variable_bindings
        .windows(2)
        .all(|pair| pair[0].target_key() < pair[1].target_key())
    {
        return Err(SnapshotError::Invalid);
    }
    Ok(PaintStyleResource {
        id: resource.id,
        key: resource.key,
        name: resource.name,
        description: resource.description,
        description_markdown: resource.description_markdown,
        documentation_links: resource
            .documentation_links
            .into_iter()
            .map(|link| link.uri)
            .collect(),
        remote: resource.remote,
        paints: paint_stack_from_proto(resource.paints.ok_or(SnapshotError::Invalid)?)?,
        variable_bindings,
    })
}

fn effect_style_resource_to_proto(resource: &EffectStyleResource) -> v1::EffectStyleResource {
    v1::EffectStyleResource {
        id: resource.id.clone(),
        key: resource.key.clone(),
        name: resource.name.clone(),
        description: resource.description.clone(),
        remote: resource.remote,
        effects: resource
            .effects
            .iter()
            .copied()
            .map(effect_to_proto)
            .collect(),
        description_markdown: resource.description_markdown.clone(),
        documentation_links: resource
            .documentation_links
            .iter()
            .map(|uri| v1::DocumentationLink { uri: uri.clone() })
            .collect(),
    }
}

fn effect_style_resource_from_proto(
    resource: v1::EffectStyleResource,
) -> Result<EffectStyleResource, SnapshotError> {
    Ok(EffectStyleResource {
        id: resource.id,
        key: resource.key,
        name: resource.name,
        description: resource.description,
        description_markdown: resource.description_markdown,
        documentation_links: resource
            .documentation_links
            .into_iter()
            .map(|link| link.uri)
            .collect(),
        remote: resource.remote,
        effects: resource
            .effects
            .into_iter()
            .map(effect_from_proto)
            .collect::<Result<Vec<_>, _>>()?,
    })
}

fn variable_collection_to_proto(
    value: &VariableCollectionResource,
) -> v1::VariableCollectionResource {
    v1::VariableCollectionResource {
        id: value.id.clone(),
        key: value.key.clone(),
        name: value.name.clone(),
        remote: value.remote,
        hidden_from_publishing: value.hidden_from_publishing,
        modes: value
            .modes
            .iter()
            .map(|mode| v1::VariableMode {
                mode_id: mode.id.clone(),
                name: mode.name.clone(),
            })
            .collect(),
        default_mode_id: value.default_mode_id.clone(),
    }
}

fn variable_collection_from_proto(
    value: v1::VariableCollectionResource,
) -> Result<VariableCollectionResource, SnapshotError> {
    Ok(VariableCollectionResource {
        id: value.id,
        key: value.key,
        name: value.name,
        remote: value.remote,
        hidden_from_publishing: value.hidden_from_publishing,
        modes: value
            .modes
            .into_iter()
            .map(|mode| VariableMode {
                id: mode.mode_id,
                name: mode.name,
            })
            .collect(),
        default_mode_id: value.default_mode_id,
    })
}

fn variable_value_to_proto(value: &VariableValue) -> v1::VariableValue {
    use v1::variable_value::Value;
    v1::VariableValue {
        value: Some(match value {
            VariableValue::Boolean(value) => Value::BooleanValue(*value),
            VariableValue::Color(value) => Value::ColorValue(color_to_proto(*value)),
            VariableValue::Float(value) => Value::FloatValue(*value),
            VariableValue::String(value) => Value::StringValue(value.clone()),
            VariableValue::Alias(value) => Value::AliasVariableId(value.clone()),
        }),
    }
}

fn variable_value_from_proto(value: v1::VariableValue) -> Result<VariableValue, SnapshotError> {
    use v1::variable_value::Value;
    match value.value.ok_or(SnapshotError::Invalid)? {
        Value::BooleanValue(value) => Ok(VariableValue::Boolean(value)),
        Value::ColorValue(value) => Ok(VariableValue::Color(color_from_proto(value)?)),
        Value::FloatValue(value) => Ok(VariableValue::Float(value)),
        Value::StringValue(value) => Ok(VariableValue::String(value)),
        Value::AliasVariableId(value) => Ok(VariableValue::Alias(value)),
    }
}

fn variable_resource_to_proto(value: &VariableResource) -> v1::VariableResource {
    let resolved_type = match value.resolved_type {
        VariableResolvedType::Boolean => v1::VariableResolvedType::Boolean,
        VariableResolvedType::Color => v1::VariableResolvedType::Color,
        VariableResolvedType::Float => v1::VariableResolvedType::Float,
        VariableResolvedType::String => v1::VariableResolvedType::String,
    };
    v1::VariableResource {
        id: value.id.clone(),
        key: value.key.clone(),
        name: value.name.clone(),
        description: value.description.clone(),
        remote: value.remote,
        hidden_from_publishing: value.hidden_from_publishing,
        collection_id: value.collection_id.clone(),
        resolved_type: resolved_type as i32,
        values_by_mode: value
            .values_by_mode
            .iter()
            .map(|(mode_id, value)| v1::VariableModeValue {
                mode_id: mode_id.clone(),
                value: Some(variable_value_to_proto(value)),
            })
            .collect(),
        scopes: value.scopes.clone(),
        code_syntax: value.code_syntax.clone(),
    }
}

fn variable_resource_from_proto(
    value: v1::VariableResource,
) -> Result<VariableResource, SnapshotError> {
    let resolved_type = match v1::VariableResolvedType::try_from(value.resolved_type)
        .map_err(|_| SnapshotError::Invalid)?
    {
        v1::VariableResolvedType::Boolean => VariableResolvedType::Boolean,
        v1::VariableResolvedType::Color => VariableResolvedType::Color,
        v1::VariableResolvedType::Float => VariableResolvedType::Float,
        v1::VariableResolvedType::String => VariableResolvedType::String,
        v1::VariableResolvedType::Unspecified => return Err(SnapshotError::Invalid),
    };
    let mut values_by_mode = BTreeMap::new();
    for entry in value.values_by_mode {
        if values_by_mode
            .insert(
                entry.mode_id,
                variable_value_from_proto(entry.value.ok_or(SnapshotError::Invalid)?)?,
            )
            .is_some()
        {
            return Err(SnapshotError::Invalid);
        }
    }
    Ok(VariableResource {
        id: value.id,
        key: value.key,
        name: value.name,
        description: value.description,
        remote: value.remote,
        hidden_from_publishing: value.hidden_from_publishing,
        collection_id: value.collection_id,
        resolved_type,
        values_by_mode,
        scopes: value.scopes,
        code_syntax: value.code_syntax,
    })
}

fn text_properties_has_truncation(properties: &TextProperties) -> bool {
    properties.text_truncation == TextTruncation::Ending || properties.max_lines.is_some()
}
fn text_properties_has_text_case(properties: &TextProperties) -> bool {
    properties.runs.iter().any(|run| run.text_case.is_some())
        || properties
            .base_style
            .as_ref()
            .is_some_and(|style| style.text_case.is_some())
}

fn text_properties_has_line_height_unit(properties: &TextProperties) -> bool {
    properties.paragraph.line_height_unit.is_some()
}

fn text_properties_has_paragraph_indent(properties: &TextProperties) -> bool {
    properties.paragraph.paragraph_indent.is_some()
}

fn text_properties_has_text_wrap_style(properties: &TextProperties) -> bool {
    properties.paragraph.text_wrap_style.is_some()
}

fn text_properties_has_list_type(properties: &TextProperties) -> bool {
    properties.paragraph.list_type.is_some()
}

fn text_properties_has_list_spacing(properties: &TextProperties) -> bool {
    properties.paragraph.list_spacing.is_some()
}

fn text_properties_has_paragraph_style_runs(properties: &TextProperties) -> bool {
    !properties.paragraph_style_runs.is_empty()
}

fn text_properties_has_paragraph_list_options(properties: &TextProperties) -> bool {
    properties
        .paragraph_style_runs
        .iter()
        .any(|run| run.list_type.is_some())
}

fn text_properties_has_paragraph_list_spacing(properties: &TextProperties) -> bool {
    properties
        .paragraph_style_runs
        .iter()
        .any(|run| run.list_spacing.is_some())
}

fn text_properties_has_paragraph_spacing(properties: &TextProperties) -> bool {
    properties
        .paragraph_style_runs
        .iter()
        .any(|run| run.paragraph_spacing.is_some())
}

fn text_properties_has_paragraph_indent_run(properties: &TextProperties) -> bool {
    properties
        .paragraph_style_runs
        .iter()
        .any(|run| run.paragraph_indent.is_some())
}

fn text_properties_has_paragraph_line_height(properties: &TextProperties) -> bool {
    properties
        .paragraph_style_runs
        .iter()
        .any(|run| run.line_height.is_some() || run.line_height_unit.is_some())
}

fn text_properties_has_paragraph_text_wrap_style(properties: &TextProperties) -> bool {
    properties
        .paragraph_style_runs
        .iter()
        .any(|run| run.text_wrap_style.is_some())
}

fn text_properties_has_hanging_list(properties: &TextProperties) -> bool {
    properties.paragraph.hanging_list
}

fn text_properties_has_hanging_punctuation(properties: &TextProperties) -> bool {
    properties.paragraph.hanging_punctuation
}

fn text_properties_has_hyperlink(properties: &TextProperties) -> bool {
    properties.runs.iter().any(|run| run.hyperlink.is_some())
        || properties
            .base_style
            .as_ref()
            .is_some_and(|style| style.hyperlink.is_some())
}

fn text_properties_has_text_decoration(properties: &TextProperties) -> bool {
    properties
        .runs
        .iter()
        .any(|run| run.text_decoration.is_some())
        || properties
            .base_style
            .as_ref()
            .is_some_and(|style| style.text_decoration.is_some())
}

fn text_properties_has_text_decoration_style(properties: &TextProperties) -> bool {
    properties
        .runs
        .iter()
        .any(|run| run.text_decoration_style.is_some())
        || properties
            .base_style
            .as_ref()
            .is_some_and(|style| style.text_decoration_style.is_some())
}

fn text_properties_has_text_decoration_offset(properties: &TextProperties) -> bool {
    properties
        .runs
        .iter()
        .any(|run| run.text_decoration_offset.is_some())
        || properties
            .base_style
            .as_ref()
            .is_some_and(|style| style.text_decoration_offset.is_some())
}

fn text_properties_has_text_decoration_thickness(properties: &TextProperties) -> bool {
    properties
        .runs
        .iter()
        .any(|run| run.text_decoration_thickness.is_some())
        || properties
            .base_style
            .as_ref()
            .is_some_and(|style| style.text_decoration_thickness.is_some())
}

fn text_properties_has_text_decoration_color(properties: &TextProperties) -> bool {
    properties
        .runs
        .iter()
        .any(|run| run.text_decoration_color.is_some())
        || properties
            .base_style
            .as_ref()
            .is_some_and(|style| style.text_decoration_color.is_some())
}

fn text_properties_has_text_decoration_color_variable(properties: &TextProperties) -> bool {
    properties.runs.iter().any(|run| {
        run.text_decoration_color
            .as_ref()
            .is_some_and(|color| color.variable_id.is_some())
    }) || properties.base_style.as_ref().is_some_and(|style| {
        style
            .text_decoration_color
            .as_ref()
            .is_some_and(|color| color.variable_id.is_some())
    })
}

fn text_properties_has_text_decoration_skip_ink(properties: &TextProperties) -> bool {
    properties
        .runs
        .iter()
        .any(|run| run.text_decoration_skip_ink == Some(true))
        || properties
            .base_style
            .as_ref()
            .is_some_and(|style| style.text_decoration_skip_ink == Some(true))
}

fn text_properties_has_leading_trim(properties: &TextProperties) -> bool {
    properties.runs.iter().any(|run| run.leading_trim.is_some())
        || properties
            .base_style
            .as_ref()
            .is_some_and(|style| style.leading_trim.is_some())
}

fn text_properties_has_open_type_features(properties: &TextProperties) -> bool {
    properties
        .runs
        .iter()
        .any(|run| !run.open_type_features.is_empty())
        || properties
            .base_style
            .as_ref()
            .is_some_and(|style| !style.open_type_features.is_empty())
}

fn text_properties_has_variable_bindings(properties: &TextProperties) -> bool {
    properties
        .runs
        .iter()
        .any(|run| !run.variable_bindings.is_empty())
        || properties
            .base_style
            .as_ref()
            .is_some_and(|style| !style.variable_bindings.is_empty())
}

fn style_variable_bindings_to_proto(
    bindings: &BTreeMap<String, String>,
) -> Vec<v1::StyleVariableBinding> {
    bindings
        .iter()
        .map(|(field, variable_id)| v1::StyleVariableBinding {
            field: field.clone(),
            variable_id: variable_id.clone(),
        })
        .collect()
}

fn style_variable_bindings_from_proto(
    bindings: Vec<v1::StyleVariableBinding>,
) -> Result<BTreeMap<String, String>, SnapshotError> {
    let count = bindings.len();
    let result = bindings
        .into_iter()
        .map(|binding| (binding.field, binding.variable_id))
        .collect::<BTreeMap<_, _>>();
    if result.len() != count {
        return Err(SnapshotError::Invalid);
    }
    Ok(result)
}

fn text_properties_has_text_style_link(properties: &TextProperties) -> bool {
    properties
        .runs
        .iter()
        .any(|run| run.text_style_id.is_some())
        || properties
            .base_style
            .as_ref()
            .is_some_and(|style| style.text_style_id.is_some())
}

fn text_properties_has_paint_style_link(properties: &TextProperties) -> bool {
    properties
        .runs
        .iter()
        .any(|run| run.paint_style_id.is_some())
        || properties
            .base_style
            .as_ref()
            .is_some_and(|style| style.paint_style_id.is_some())
}

fn open_type_features_to_proto(features: &[OpenTypeFeature]) -> Vec<v1::OpenTypeFeatureSetting> {
    features
        .iter()
        .map(|feature| v1::OpenTypeFeatureSetting {
            tag: feature.tag.clone(),
            enabled: feature.enabled,
        })
        .collect()
}

fn open_type_features_from_proto(
    features: Vec<v1::OpenTypeFeatureSetting>,
) -> Result<Vec<OpenTypeFeature>, SnapshotError> {
    Ok(features
        .into_iter()
        .map(|feature| OpenTypeFeature {
            tag: feature.tag,
            enabled: feature.enabled,
        })
        .collect())
}

fn leading_trim_to_proto(value: LeadingTrim) -> i32 {
    match value {
        LeadingTrim::CapHeight => v1::LeadingTrim::CapHeight as i32,
    }
}

fn leading_trim_from_proto(value: i32) -> Result<Option<LeadingTrim>, SnapshotError> {
    match v1::LeadingTrim::try_from(value).map_err(|_| SnapshotError::Invalid)? {
        v1::LeadingTrim::CapHeight => Ok(Some(LeadingTrim::CapHeight)),
        v1::LeadingTrim::None | v1::LeadingTrim::Unspecified => Ok(None),
    }
}

fn text_decoration_offset_to_proto(value: TextDecorationOffset) -> v1::TextDecorationOffset {
    let (value, unit) = match value {
        TextDecorationOffset::Pixels(value) => (value, v1::TextDecorationOffsetUnit::Pixels),
        TextDecorationOffset::Percent(value) => (value, v1::TextDecorationOffsetUnit::Percent),
    };
    v1::TextDecorationOffset {
        value,
        unit: unit as i32,
    }
}

fn text_decoration_offset_from_proto(
    value: v1::TextDecorationOffset,
) -> Result<Option<TextDecorationOffset>, SnapshotError> {
    match v1::TextDecorationOffsetUnit::try_from(value.unit).map_err(|_| SnapshotError::Invalid)? {
        v1::TextDecorationOffsetUnit::Pixels => Ok(Some(TextDecorationOffset::Pixels(value.value))),
        v1::TextDecorationOffsetUnit::Percent => {
            Ok(Some(TextDecorationOffset::Percent(value.value)))
        }
        v1::TextDecorationOffsetUnit::Auto if value.value == 0.0 => Ok(None),
        v1::TextDecorationOffsetUnit::Auto | v1::TextDecorationOffsetUnit::Unspecified => {
            Err(SnapshotError::Invalid)
        }
    }
}

fn text_decoration_thickness_to_proto(
    value: TextDecorationThickness,
) -> v1::TextDecorationThickness {
    let (value, unit) = match value {
        TextDecorationThickness::Pixels(value) => (value, v1::TextDecorationThicknessUnit::Pixels),
        TextDecorationThickness::Percent(value) => {
            (value, v1::TextDecorationThicknessUnit::Percent)
        }
    };
    v1::TextDecorationThickness {
        value,
        unit: unit as i32,
    }
}

fn text_decoration_thickness_from_proto(
    value: v1::TextDecorationThickness,
) -> Result<Option<TextDecorationThickness>, SnapshotError> {
    match v1::TextDecorationThicknessUnit::try_from(value.unit)
        .map_err(|_| SnapshotError::Invalid)?
    {
        v1::TextDecorationThicknessUnit::Pixels => {
            Ok(Some(TextDecorationThickness::Pixels(value.value)))
        }
        v1::TextDecorationThicknessUnit::Percent => {
            Ok(Some(TextDecorationThickness::Percent(value.value)))
        }
        v1::TextDecorationThicknessUnit::Auto if value.value == 0.0 => Ok(None),
        v1::TextDecorationThicknessUnit::Auto | v1::TextDecorationThicknessUnit::Unspecified => {
            Err(SnapshotError::Invalid)
        }
    }
}

fn text_decoration_color_to_proto(value: &TextDecorationColor) -> v1::TextDecorationColor {
    v1::TextDecorationColor {
        color: Some(color_to_proto(value.color)),
        visible: value.visible,
        opacity: value.opacity,
        blend_mode: blend_mode_to_proto(value.blend_mode) as i32,
        variable_id: value.variable_id.as_deref().map(str::to_owned),
    }
}

fn text_decoration_color_from_proto(
    value: v1::TextDecorationColor,
) -> Result<TextDecorationColor, SnapshotError> {
    let blend_mode = blend_mode_from_proto(value.blend_mode)?;
    if matches!(blend_mode, BlendMode::PassThrough) {
        return Err(SnapshotError::Invalid);
    }
    Ok(TextDecorationColor {
        color: color_from_proto(value.color.ok_or(SnapshotError::Invalid)?)?,
        visible: value.visible,
        opacity: value.opacity,
        blend_mode,
        variable_id: value.variable_id.map(String::into_boxed_str),
    })
}

fn text_decoration_style_to_proto(value: TextDecorationStyle) -> i32 {
    (match value {
        TextDecorationStyle::Wavy => v1::TextDecorationStyle::Wavy,
        TextDecorationStyle::Dotted => v1::TextDecorationStyle::Dotted,
    }) as i32
}

fn text_decoration_style_from_proto(
    value: i32,
) -> Result<Option<TextDecorationStyle>, SnapshotError> {
    match v1::TextDecorationStyle::try_from(value).map_err(|_| SnapshotError::Invalid)? {
        v1::TextDecorationStyle::Wavy => Ok(Some(TextDecorationStyle::Wavy)),
        v1::TextDecorationStyle::Dotted => Ok(Some(TextDecorationStyle::Dotted)),
        v1::TextDecorationStyle::Unspecified | v1::TextDecorationStyle::Solid => Ok(None),
    }
}

fn text_decoration_to_proto(value: TextDecoration) -> i32 {
    (match value {
        TextDecoration::Underline => v1::TextDecoration::Underline,
        TextDecoration::Strikethrough => v1::TextDecoration::Strikethrough,
    }) as i32
}

fn text_decoration_from_proto(value: i32) -> Result<Option<TextDecoration>, SnapshotError> {
    Ok(Some(
        match v1::TextDecoration::try_from(value).map_err(|_| SnapshotError::Invalid)? {
            v1::TextDecoration::Underline => TextDecoration::Underline,
            v1::TextDecoration::Strikethrough => TextDecoration::Strikethrough,
            v1::TextDecoration::Unspecified => return Ok(None),
        },
    ))
}

fn hyperlink_to_proto(value: &HyperlinkTarget) -> v1::HyperlinkTarget {
    v1::HyperlinkTarget {
        r#type: match value.kind {
            HyperlinkType::Url => v1::HyperlinkType::Url,
            HyperlinkType::Node => v1::HyperlinkType::Node,
        } as i32,
        value: value.value.clone(),
    }
}

fn hyperlink_from_proto(value: v1::HyperlinkTarget) -> Result<HyperlinkTarget, SnapshotError> {
    let kind =
        match v1::HyperlinkType::try_from(value.r#type).map_err(|_| SnapshotError::Invalid)? {
            v1::HyperlinkType::Url => HyperlinkType::Url,
            v1::HyperlinkType::Node => HyperlinkType::Node,
            v1::HyperlinkType::Unspecified => return Err(SnapshotError::Invalid),
        };
    Ok(HyperlinkTarget {
        kind,
        value: value.value,
    })
}

fn text_wrap_style_to_proto(value: TextWrapStyle) -> i32 {
    (match value {
        TextWrapStyle::Auto => v1::TextWrapStyle::Auto,
        TextWrapStyle::Balance => v1::TextWrapStyle::Balance,
        TextWrapStyle::Pretty => v1::TextWrapStyle::Pretty,
    }) as i32
}

fn paragraph_text_wrap_style_from_proto(value: i32) -> Result<TextWrapStyle, SnapshotError> {
    match v1::TextWrapStyle::try_from(value).map_err(|_| SnapshotError::Invalid)? {
        v1::TextWrapStyle::Auto => Ok(TextWrapStyle::Auto),
        v1::TextWrapStyle::Balance => Ok(TextWrapStyle::Balance),
        v1::TextWrapStyle::Pretty => Ok(TextWrapStyle::Pretty),
        v1::TextWrapStyle::Unspecified => Err(SnapshotError::Invalid),
    }
}

fn text_wrap_style_from_proto(value: i32) -> Result<Option<TextWrapStyle>, SnapshotError> {
    match v1::TextWrapStyle::try_from(value).map_err(|_| SnapshotError::Invalid)? {
        v1::TextWrapStyle::Auto => Ok(None),
        v1::TextWrapStyle::Balance => Ok(Some(TextWrapStyle::Balance)),
        v1::TextWrapStyle::Pretty => Ok(Some(TextWrapStyle::Pretty)),
        v1::TextWrapStyle::Unspecified => Err(SnapshotError::Invalid),
    }
}

fn text_list_type_to_proto(value: TextListType) -> i32 {
    (match value {
        TextListType::Ordered => v1::TextListType::Ordered,
        TextListType::Unordered => v1::TextListType::Unordered,
    }) as i32
}

fn text_list_type_from_proto(value: i32) -> Result<Option<TextListType>, SnapshotError> {
    match v1::TextListType::try_from(value).map_err(|_| SnapshotError::Invalid)? {
        v1::TextListType::None => Ok(None),
        v1::TextListType::Ordered => Ok(Some(TextListType::Ordered)),
        v1::TextListType::Unordered => Ok(Some(TextListType::Unordered)),
        v1::TextListType::Unspecified => Err(SnapshotError::Invalid),
    }
}

fn paragraph_list_type_to_proto(value: ParagraphListType) -> i32 {
    (match value {
        ParagraphListType::None => v1::TextListType::None,
        ParagraphListType::Ordered => v1::TextListType::Ordered,
        ParagraphListType::Unordered => v1::TextListType::Unordered,
    }) as i32
}

fn paragraph_list_type_from_proto(value: i32) -> Result<ParagraphListType, SnapshotError> {
    match v1::TextListType::try_from(value).map_err(|_| SnapshotError::Invalid)? {
        v1::TextListType::None => Ok(ParagraphListType::None),
        v1::TextListType::Ordered => Ok(ParagraphListType::Ordered),
        v1::TextListType::Unordered => Ok(ParagraphListType::Unordered),
        v1::TextListType::Unspecified => Err(SnapshotError::Invalid),
    }
}

fn line_height_unit_to_proto(value: LineHeightUnit) -> i32 {
    (match value {
        LineHeightUnit::Percent => v1::LineHeightUnit::Percent,
        LineHeightUnit::Auto => v1::LineHeightUnit::Auto,
    }) as i32
}

fn line_height_unit_from_proto(value: i32) -> Result<Option<LineHeightUnit>, SnapshotError> {
    match v1::LineHeightUnit::try_from(value).map_err(|_| SnapshotError::Invalid)? {
        v1::LineHeightUnit::Pixels => Ok(None),
        v1::LineHeightUnit::Percent => Ok(Some(LineHeightUnit::Percent)),
        v1::LineHeightUnit::Auto => Ok(Some(LineHeightUnit::Auto)),
        v1::LineHeightUnit::Unspecified => Err(SnapshotError::Invalid),
    }
}

fn text_case_to_proto(value: TextCase) -> i32 {
    (match value {
        TextCase::Original => v1::TextCase::Original,
        TextCase::Upper => v1::TextCase::Upper,
        TextCase::Lower => v1::TextCase::Lower,
        TextCase::Title => v1::TextCase::Title,
        TextCase::SmallCaps => v1::TextCase::SmallCaps,
        TextCase::SmallCapsForced => v1::TextCase::SmallCapsForced,
    }) as i32
}

fn text_case_from_proto(value: i32) -> Result<Option<TextCase>, SnapshotError> {
    match v1::TextCase::try_from(value).map_err(|_| SnapshotError::Invalid)? {
        v1::TextCase::Original => Ok(None),
        v1::TextCase::Upper => Ok(Some(TextCase::Upper)),
        v1::TextCase::Lower => Ok(Some(TextCase::Lower)),
        v1::TextCase::Title => Ok(Some(TextCase::Title)),
        v1::TextCase::SmallCaps => Ok(Some(TextCase::SmallCaps)),
        v1::TextCase::SmallCapsForced => Ok(Some(TextCase::SmallCapsForced)),
        v1::TextCase::Unspecified => Err(SnapshotError::Invalid),
    }
}
fn text_properties_has_fill_stack(properties: &TextProperties) -> bool {
    properties.runs.iter().any(|run| run.fill_stack.is_some())
        || properties
            .base_style
            .as_ref()
            .is_some_and(|style| style.fill_stack.is_some())
}
fn text_properties_has_base_style(properties: &TextProperties) -> bool {
    properties.base_style.is_some()
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

fn paint_stack_to_proto(stack: &PaintStack) -> v1::PaintStack {
    v1::PaintStack {
        layers: stack.layers.iter().map(paint_layer_to_proto).collect(),
    }
}

fn paint_stack_has_non_linear_gradient(stack: &PaintStack) -> bool {
    stack
        .layers
        .iter()
        .any(|layer| matches!(layer.paint, PaintLayerKind::Gradient(_)))
}

fn paint_stack_has_rotated_image(stack: &PaintStack) -> bool {
    stack.layers.iter().any(
        |layer| matches!(&layer.paint, PaintLayerKind::Image(image) if image.rotation_degrees != 0),
    )
}

fn paint_stack_has_image_filters(stack: &PaintStack) -> bool {
    stack.layers.iter().any(
        |layer| matches!(&layer.paint, PaintLayerKind::Image(image) if image.filters.is_some()),
    )
}

fn paint_stack_has_linear_blend(stack: &PaintStack) -> bool {
    stack
        .layers
        .iter()
        .any(|layer| layer.blend_mode.requires_linear_blend_semantics())
}

fn gradient_paint_to_proto(gradient: &GradientPaint) -> v1::GradientPaint {
    v1::GradientPaint {
        kind: match gradient.kind {
            GradientPaintKind::Radial => v1::GradientPaintKind::Radial,
            GradientPaintKind::Angular => v1::GradientPaintKind::Angular,
            GradientPaintKind::Diamond => v1::GradientPaintKind::Diamond,
        } as i32,
        transform: Some(transform_to_proto(gradient.transform)),
        stops: gradient
            .stops
            .iter()
            .map(|stop| v1::GradientStop {
                position: stop.position,
                color: Some(color_to_proto(stop.color)),
            })
            .collect(),
    }
}

fn gradient_paint_from_proto(gradient: v1::GradientPaint) -> Result<GradientPaint, SnapshotError> {
    let kind =
        match v1::GradientPaintKind::try_from(gradient.kind).map_err(|_| SnapshotError::Invalid)? {
            v1::GradientPaintKind::Radial => GradientPaintKind::Radial,
            v1::GradientPaintKind::Angular => GradientPaintKind::Angular,
            v1::GradientPaintKind::Diamond => GradientPaintKind::Diamond,
            v1::GradientPaintKind::Unspecified => return Err(SnapshotError::Invalid),
        };
    GradientPaint::new(
        kind,
        transform_from_proto(gradient.transform.ok_or(SnapshotError::Invalid)?)?,
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
    .map_err(|_| SnapshotError::Invalid)
}

fn paint_layer_to_proto(layer: &PaintLayer) -> v1::PaintLayer {
    use v1::paint_layer::Kind;
    let kind = match &layer.paint {
        PaintLayerKind::Solid(color) => Kind::Solid(color_to_proto(*color)),
        PaintLayerKind::LinearGradient(gradient) => Kind::LinearGradient(
            match paint_to_proto(&Paint::LinearGradient(gradient.clone())).kind {
                Some(v1::paint::Kind::LinearGradient(gradient)) => gradient,
                _ => unreachable!("linear gradient conversion is stable"),
            },
        ),
        PaintLayerKind::Image(image) => Kind::Image(v1::ImagePaint {
            asset_id: id_to_bytes(image.asset_id.0),
            scale_mode: match image.scale_mode {
                ImageScaleMode::Fill => v1::ImageScaleMode::Fill,
                ImageScaleMode::Fit => v1::ImageScaleMode::Fit,
                ImageScaleMode::Crop => v1::ImageScaleMode::Crop,
                ImageScaleMode::Tile => v1::ImageScaleMode::Tile,
            } as i32,
            transform: Some(transform_to_proto(image.transform)),
            rotation_degrees: i32::from(image.rotation_degrees),
            filters: image.filters.map(image_filters_to_proto),
        }),
        PaintLayerKind::Gradient(gradient) => Kind::Gradient(gradient_paint_to_proto(gradient)),
    };
    v1::PaintLayer {
        kind: Some(kind),
        visible: layer.visible,
        opacity: layer.opacity,
        blend_mode: blend_mode_to_proto(layer.blend_mode) as i32,
    }
}

fn paint_stack_from_proto(stack: v1::PaintStack) -> Result<PaintStack, SnapshotError> {
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
        .ok_or(SnapshotError::Invalid)
}

fn paint_layer_from_proto(layer: v1::PaintLayer) -> Result<PaintLayer, SnapshotError> {
    use v1::paint_layer::Kind;
    let paint = match layer.kind.ok_or(SnapshotError::Invalid)? {
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
                .map_err(|_| SnapshotError::Invalid)?
            {
                v1::ImageScaleMode::Fill => ImageScaleMode::Fill,
                v1::ImageScaleMode::Fit => ImageScaleMode::Fit,
                v1::ImageScaleMode::Crop => ImageScaleMode::Crop,
                v1::ImageScaleMode::Tile => ImageScaleMode::Tile,
                v1::ImageScaleMode::Unspecified => return Err(SnapshotError::Invalid),
            },
            transform: transform_from_proto(image.transform.ok_or(SnapshotError::Invalid)?)?,
            rotation_degrees: i16::try_from(image.rotation_degrees)
                .map_err(|_| SnapshotError::Invalid)?,
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
        .ok_or(SnapshotError::Invalid)
}

fn image_filters_to_proto(filters: ImageFilters) -> v1::ImageFilters {
    v1::ImageFilters {
        exposure: filters.exposure,
        contrast: filters.contrast,
        saturation: filters.saturation,
        temperature: filters.temperature,
        tint: filters.tint,
        highlights: filters.highlights,
        shadows: filters.shadows,
    }
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
        AssetId, AssetReference, DEFAULT_PAGE_ID, DropShadow, Effect, EffectStyleResource,
        LayerBlur, NodeKind, Page, PageId, PaintStyleResource, ParagraphStyle, TextAlign,
        TextAutoSize, TextProperties, TextStyleResource, TextStyleRun, color::Color,
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
    fn grid_auto_layout_is_version_gated_and_round_trips() {
        let mut document = Document::with_id(DocumentId(77));
        let frame = node(7, NodeKind::Frame, None);
        document
            .seed_node_on_page(DEFAULT_PAGE_ID, frame.clone())
            .unwrap();
        let layout = AutoLayout {
            mode: LayoutMode::Grid,
            padding: [8.0, 12.0, 16.0, 20.0],
            grid_rows: vec![GridTrack::Fixed(40.0), GridTrack::Flex(2.0)],
            grid_columns: vec![GridTrack::Flex(1.0), GridTrack::Flex(3.0)],
            grid_row_gap: Some(6.0),
            grid_column_gap: Some(10.0),
            ..AutoLayout::default()
        };
        document.seed_auto_layout(frame.id, layout.clone()).unwrap();
        assert_eq!(
            snapshot_from_document(&document, GRID_AUTO_LAYOUT_ENGINE_SEMANTICS_VERSION - 1),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let bytes = snapshot_from_document(&document, CURRENT_ENGINE_SEMANTICS_VERSION).unwrap();
        let restored = document_from_snapshot(
            &bytes,
            document.id().0.to_be_bytes(),
            document.canonical_hash(),
        )
        .unwrap();
        assert_eq!(restored.auto_layout_for_node(frame.id), layout);
        assert_eq!(restored.canonical_hash(), document.canonical_hash());
    }

    #[test]
    fn grid_hug_tracks_require_semantics_fifty_seven() {
        let mut document = Document::with_id(DocumentId(78));
        let frame = node(8, NodeKind::Frame, None);
        document
            .seed_node_on_page(DEFAULT_PAGE_ID, frame.clone())
            .unwrap();
        let layout = AutoLayout {
            mode: LayoutMode::Grid,
            grid_rows: vec![GridTrack::Hug],
            grid_columns: vec![GridTrack::Fixed(80.0)],
            ..AutoLayout::default()
        };
        document.seed_auto_layout(frame.id, layout.clone()).unwrap();
        assert_eq!(
            snapshot_from_document(&document, GRID_AUTO_LAYOUT_ENGINE_SEMANTICS_VERSION),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let bytes = snapshot_from_document(&document, CURRENT_ENGINE_SEMANTICS_VERSION).unwrap();
        let restored = document_from_snapshot(
            &bytes,
            document.id().0.to_be_bytes(),
            document.canonical_hash(),
        )
        .unwrap();
        assert_eq!(restored.auto_layout_for_node(frame.id), layout);
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
                font_faces: Vec::new(),
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
                        fill_stack: None,

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
                        paint_style_id: None,
                        variable_bindings: Default::default(),
                        text_decoration_color: None,
                    }],
                    paragraph: ParagraphStyle {
                        alignment: TextAlign::Left,
                        line_height: Some(20.0),
                        line_height_unit: None,
                        paragraph_spacing: 0.0,
                        paragraph_indent: None,
                        text_wrap_style: None,
                        list_type: None,
                        list_spacing: None,
                        hanging_list: false,
                        hanging_punctuation: false,
                    },
                    paragraph_style_runs: Vec::new(),
                    auto_size: TextAutoSize::Height,
                    fallback_fonts: vec![],
                    text_truncation: TextTruncation::Disabled,
                    max_lines: None,
                    base_style: None,
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
        document
            .seed_node_on_page(
                DEFAULT_PAGE_ID,
                node(8, NodeKind::Rectangle, Some(NodeId(7))),
            )
            .unwrap();
        document
            .seed_node_on_page(
                DEFAULT_PAGE_ID,
                node(9, NodeKind::Rectangle, Some(NodeId(7))),
            )
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
    fn wire_snapshot_rejects_an_incomplete_structural_container() {
        let mut document = Document::with_id(DocumentId(43));
        document
            .seed_node_on_page(DEFAULT_PAGE_ID, node(7, NodeKind::Group, None))
            .unwrap();
        let snapshot = snapshot_from_document(&document, 1).unwrap();

        assert_eq!(
            document_from_wire_snapshot(&snapshot),
            Err(SnapshotError::Invalid)
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
    fn grid_spans_require_semantics_fifty_eight() {
        let mut document = Document::with_id(DocumentId(79));
        let child = node(9, NodeKind::Rectangle, None);
        document
            .seed_node_on_page(DEFAULT_PAGE_ID, child.clone())
            .unwrap();
        let layout = AutoLayout {
            grid_row_span: Some(2),
            grid_column_span: Some(3),
            ..AutoLayout::default()
        };
        document.seed_auto_layout(child.id, layout.clone()).unwrap();
        assert_eq!(
            snapshot_from_document(&document, GRID_HUG_TRACK_ENGINE_SEMANTICS_VERSION),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let bytes = snapshot_from_document(&document, CURRENT_ENGINE_SEMANTICS_VERSION).unwrap();
        let restored = document_from_snapshot(
            &bytes,
            document.id().0.to_be_bytes(),
            document.canonical_hash(),
        )
        .unwrap();
        assert_eq!(restored.auto_layout_for_node(child.id), layout);
        assert_eq!(restored.canonical_hash(), document.canonical_hash());
    }

    #[test]
    fn grid_manual_placement_requires_semantics_fifty_nine() {
        let mut document = Document::with_id(DocumentId(80));
        let mut frame = node(10, NodeKind::Frame, None);
        frame.width = 100.0;
        frame.height = 100.0;
        document
            .seed_node_on_page(DEFAULT_PAGE_ID, frame.clone())
            .unwrap();
        let layout = AutoLayout {
            mode: LayoutMode::Grid,
            grid_rows: vec![GridTrack::Fixed(100.0)],
            grid_columns: vec![GridTrack::Fixed(100.0)],
            grid_items_positioning: GridItemsPositioning::Manual,
            ..AutoLayout::default()
        };
        document.seed_auto_layout(frame.id, layout.clone()).unwrap();
        assert_eq!(
            snapshot_from_document(&document, GRID_SPAN_ENGINE_SEMANTICS_VERSION),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let bytes = snapshot_from_document(&document, CURRENT_ENGINE_SEMANTICS_VERSION).unwrap();
        let restored = document_from_snapshot(
            &bytes,
            document.id().0.to_be_bytes(),
            document.canonical_hash(),
        )
        .unwrap();
        assert_eq!(restored.auto_layout_for_node(frame.id), layout);
    }

    #[test]
    fn grid_auto_rows_require_semantics_sixty() {
        let mut document = Document::with_id(DocumentId(81));
        let frame = node(11, NodeKind::Frame, None);
        document
            .seed_node_on_page(DEFAULT_PAGE_ID, frame.clone())
            .unwrap();
        let layout = AutoLayout {
            mode: LayoutMode::Grid,
            grid_rows: vec![GridTrack::Flex(1.0)],
            grid_columns: vec![GridTrack::Flex(1.0), GridTrack::Flex(1.0)],
            grid_auto_tracks: GridAutoTracks::Rows,
            ..AutoLayout::default()
        };
        document.seed_auto_layout(frame.id, layout.clone()).unwrap();
        assert_eq!(
            snapshot_from_document(&document, GRID_MANUAL_PLACEMENT_ENGINE_SEMANTICS_VERSION),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let bytes = snapshot_from_document(&document, CURRENT_ENGINE_SEMANTICS_VERSION).unwrap();
        let restored = document_from_snapshot(
            &bytes,
            document.id().0.to_be_bytes(),
            document.canonical_hash(),
        )
        .unwrap();
        assert_eq!(restored.auto_layout_for_node(frame.id), layout);
    }

    #[test]
    fn grid_child_alignment_requires_semantics_sixty_one() {
        let mut document = Document::with_id(DocumentId(82));
        let child = node(12, NodeKind::Rectangle, None);
        document
            .seed_node_on_page(DEFAULT_PAGE_ID, child.clone())
            .unwrap();
        let layout = AutoLayout {
            grid_child_horizontal_align: GridChildAlignment::Center,
            grid_child_vertical_align: GridChildAlignment::Max,
            ..AutoLayout::default()
        };
        document.seed_auto_layout(child.id, layout.clone()).unwrap();
        assert_eq!(
            snapshot_from_document(&document, GRID_AUTO_ROWS_ENGINE_SEMANTICS_VERSION),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let bytes = snapshot_from_document(&document, CURRENT_ENGINE_SEMANTICS_VERSION).unwrap();
        let restored = document_from_snapshot(
            &bytes,
            document.id().0.to_be_bytes(),
            document.canonical_hash(),
        )
        .unwrap();
        assert_eq!(restored.auto_layout_for_node(child.id), layout);
    }

    #[test]
    fn grid_container_hug_requires_semantics_sixty_two() {
        let mut document = Document::with_id(DocumentId(83));
        let mut frame = node(13, NodeKind::Frame, None);
        frame.width = 200.0;
        frame.height = 100.0;
        document
            .seed_node_on_page(DEFAULT_PAGE_ID, frame.clone())
            .unwrap();
        let layout = AutoLayout {
            mode: LayoutMode::Grid,
            primary_sizing: LayoutSizing::Hug,
            grid_rows: vec![GridTrack::Fixed(40.0)],
            grid_columns: vec![GridTrack::Fixed(80.0)],
            ..AutoLayout::default()
        };
        document.seed_auto_layout(frame.id, layout.clone()).unwrap();
        assert_eq!(
            snapshot_from_document(&document, GRID_CHILD_ALIGNMENT_ENGINE_SEMANTICS_VERSION),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let bytes = snapshot_from_document(&document, CURRENT_ENGINE_SEMANTICS_VERSION).unwrap();
        let restored = document_from_snapshot(
            &bytes,
            document.id().0.to_be_bytes(),
            document.canonical_hash(),
        )
        .unwrap();
        assert_eq!(restored.auto_layout_for_node(frame.id), layout);
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

    #[test]
    fn newer_engine_semantics_is_rejected_before_node_decode() {
        let document = Document::with_id(DocumentId(41));
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, CURRENT_ENGINE_SEMANTICS_VERSION + 1).unwrap();

        assert_eq!(
            document_from_snapshot(&snapshot, 41_u128.to_be_bytes(), hash),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        assert!(
            document_from_snapshot_with_engine_semantics(
                &snapshot,
                41_u128.to_be_bytes(),
                hash,
                CURRENT_ENGINE_SEMANTICS_VERSION + 1,
            )
            .is_ok()
        );
    }

    #[test]
    fn versioned_paint_stack_round_trips_presence_and_requires_semantics_four() {
        let mut document = Document::with_id(DocumentId(44));
        let asset = AssetReference {
            asset_id: AssetId(440),
            content_hash: [44; 32],
            media_type: "image/png".into(),
            byte_length: 16,
            dimensions: Some([2, 2]),
            font_faces: Vec::new(),
        };
        document.seed_asset(asset.clone()).unwrap();
        document
            .seed_node_on_page(DEFAULT_PAGE_ID, node(44, NodeKind::Rectangle, None))
            .unwrap();
        document
            .seed_paint_stacks(
                NodeId(44),
                Some(PaintStack::default()),
                Some(PaintStack {
                    layers: vec![PaintLayer {
                        paint: PaintLayerKind::Image(ImagePaint {
                            asset_id: asset.asset_id,
                            scale_mode: ImageScaleMode::Tile,
                            transform: editor_core::geometry::AffineTransform::IDENTITY,
                            rotation_degrees: 0,
                            filters: None,
                        }),
                        visible: false,
                        opacity: 0.25,
                        blend_mode: BlendMode::Screen,
                    }],
                }),
            )
            .unwrap();
        assert_eq!(
            snapshot_from_document(&document, PAINT_STACK_ENGINE_SEMANTICS_VERSION - 1),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );

        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, PAINT_STACK_ENGINE_SEMANTICS_VERSION).unwrap();
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &snapshot,
                44_u128.to_be_bytes(),
                hash,
                PAINT_STACK_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            44_u128.to_be_bytes(),
            hash,
            PAINT_STACK_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.fill_stack_for_node(NodeId(44)),
            Some(&PaintStack::default())
        );
        assert_eq!(
            restored
                .stroke_stack_for_node(NodeId(44))
                .unwrap()
                .layers
                .len(),
            1
        );
        assert_eq!(restored.canonical_hash(), hash);

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = PAINT_STACK_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                44_u128.to_be_bytes(),
                hash,
                PAINT_STACK_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn non_linear_gradient_round_trips_and_requires_semantics_five() {
        let mut document = Document::with_id(DocumentId(45));
        document
            .seed_node_on_page(DEFAULT_PAGE_ID, node(45, NodeKind::Rectangle, None))
            .unwrap();
        let gradient = GradientPaint::new(
            GradientPaintKind::Diamond,
            AffineTransform {
                a: 0.8,
                b: -0.2,
                c: 0.15,
                d: 1.1,
                e: 0.1,
                f: 0.05,
            },
            vec![
                GradientStop {
                    position: 0.0,
                    color: Color::from_srgb_u8([255, 0, 0], 255),
                },
                GradientStop {
                    position: 1.0,
                    color: Color::from_srgb_u8([0, 0, 255], 128),
                },
            ],
        )
        .unwrap();
        document
            .seed_paint_stacks(
                NodeId(45),
                Some(PaintStack {
                    layers: vec![PaintLayer {
                        paint: PaintLayerKind::Gradient(gradient.clone()),
                        visible: true,
                        opacity: 0.75,
                        blend_mode: BlendMode::Overlay,
                    }],
                }),
                None,
            )
            .unwrap();

        assert_eq!(
            snapshot_from_document(&document, NON_LINEAR_GRADIENT_ENGINE_SEMANTICS_VERSION - 1,),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, NON_LINEAR_GRADIENT_ENGINE_SEMANTICS_VERSION)
                .unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            45_u128.to_be_bytes(),
            hash,
            NON_LINEAR_GRADIENT_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.fill_stack_for_node(NodeId(45)).unwrap().layers[0].paint,
            PaintLayerKind::Gradient(gradient)
        );
        assert_eq!(restored.canonical_hash(), hash);
    }

    #[test]
    fn advanced_blend_modes_round_trip_and_require_semantics_six() {
        let mut document = Document::with_id(DocumentId(46));
        let mut blended = node(46, NodeKind::Rectangle, None);
        blended.blend_mode = BlendMode::Hue;
        document
            .seed_node_on_page(DEFAULT_PAGE_ID, blended)
            .unwrap();
        document
            .seed_paint_stacks(
                NodeId(46),
                Some(PaintStack {
                    layers: vec![PaintLayer {
                        paint: PaintLayerKind::Solid(Color::from_srgb_u8([20, 80, 160], 255)),
                        visible: true,
                        opacity: 0.8,
                        blend_mode: BlendMode::ColorBurn,
                    }],
                }),
                None,
            )
            .unwrap();

        assert_eq!(
            snapshot_from_document(&document, ADVANCED_BLEND_ENGINE_SEMANTICS_VERSION - 1),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, ADVANCED_BLEND_ENGINE_SEMANTICS_VERSION).unwrap();
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &snapshot,
                46_u128.to_be_bytes(),
                hash,
                ADVANCED_BLEND_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            46_u128.to_be_bytes(),
            hash,
            ADVANCED_BLEND_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.node(NodeId(46)).unwrap().blend_mode,
            BlendMode::Hue
        );
        assert_eq!(
            restored.fill_stack_for_node(NodeId(46)).unwrap().layers[0].blend_mode,
            BlendMode::ColorBurn
        );
        assert_eq!(restored.canonical_hash(), hash);
    }

    #[test]
    fn image_rotation_round_trips_and_requires_semantics_seven() {
        let asset = AssetReference {
            asset_id: AssetId(470),
            content_hash: [47; 32],
            media_type: "image/png".into(),
            byte_length: 64,
            dimensions: Some([8, 4]),
            font_faces: Vec::new(),
        };
        let mut document = Document::with_id(DocumentId(47));
        document.seed_asset(asset.clone()).unwrap();
        document
            .seed_node_on_page(DEFAULT_PAGE_ID, node(47, NodeKind::Rectangle, None))
            .unwrap();
        document
            .seed_paint_stacks(
                NodeId(47),
                Some(PaintStack {
                    layers: vec![PaintLayer {
                        paint: PaintLayerKind::Image(ImagePaint {
                            asset_id: asset.asset_id,
                            scale_mode: ImageScaleMode::Fill,
                            transform: AffineTransform::IDENTITY,
                            rotation_degrees: 90,
                            filters: None,
                        }),
                        visible: true,
                        opacity: 1.0,
                        blend_mode: BlendMode::Normal,
                    }],
                }),
                None,
            )
            .unwrap();

        assert_eq!(
            snapshot_from_document(&document, IMAGE_PAINT_ROTATION_ENGINE_SEMANTICS_VERSION - 1),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, IMAGE_PAINT_ROTATION_ENGINE_SEMANTICS_VERSION)
                .unwrap();
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &snapshot,
                47_u128.to_be_bytes(),
                hash,
                IMAGE_PAINT_ROTATION_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            47_u128.to_be_bytes(),
            hash,
            IMAGE_PAINT_ROTATION_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert!(matches!(
            &restored.fill_stack_for_node(NodeId(47)).unwrap().layers[0].paint,
            PaintLayerKind::Image(ImagePaint {
                rotation_degrees: 90,
                ..
            })
        ));
        assert_eq!(restored.canonical_hash(), hash);
    }

    #[test]
    fn pass_through_round_trips_and_requires_semantics_eight() {
        let mut document = Document::with_id(DocumentId(48));
        let mut frame = node(48, NodeKind::Frame, None);
        frame.blend_mode = BlendMode::PassThrough;
        document.seed_node_on_page(DEFAULT_PAGE_ID, frame).unwrap();

        assert_eq!(
            snapshot_from_document(&document, PASS_THROUGH_ENGINE_SEMANTICS_VERSION - 1),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, PASS_THROUGH_ENGINE_SEMANTICS_VERSION).unwrap();
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &snapshot,
                48_u128.to_be_bytes(),
                hash,
                PASS_THROUGH_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            48_u128.to_be_bytes(),
            hash,
            PASS_THROUGH_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.node(NodeId(48)).unwrap().blend_mode,
            BlendMode::PassThrough
        );
        assert_eq!(restored.canonical_hash(), hash);
    }

    #[test]
    fn linear_blends_round_trip_and_require_semantics_nine() {
        let mut document = Document::with_id(DocumentId(49));
        let mut burn = node(49, NodeKind::Rectangle, None);
        burn.blend_mode = BlendMode::LinearBurn;
        let mut dodge = node(50, NodeKind::Rectangle, None);
        dodge.blend_mode = BlendMode::LinearDodge;
        document.seed_node_on_page(DEFAULT_PAGE_ID, burn).unwrap();
        document.seed_node_on_page(DEFAULT_PAGE_ID, dodge).unwrap();
        document
            .seed_paint_stacks(
                NodeId(49),
                Some(PaintStack {
                    layers: vec![PaintLayer {
                        paint: PaintLayerKind::Solid(Color::from_srgb_u8([200, 40, 90], 255)),
                        visible: true,
                        opacity: 0.75,
                        blend_mode: BlendMode::LinearDodge,
                    }],
                }),
                None,
            )
            .unwrap();

        assert_eq!(
            snapshot_from_document(&document, LINEAR_BLEND_ENGINE_SEMANTICS_VERSION - 1),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, LINEAR_BLEND_ENGINE_SEMANTICS_VERSION).unwrap();
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &snapshot,
                49_u128.to_be_bytes(),
                hash,
                LINEAR_BLEND_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            49_u128.to_be_bytes(),
            hash,
            LINEAR_BLEND_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.node(NodeId(49)).unwrap().blend_mode,
            BlendMode::LinearBurn
        );
        assert_eq!(
            restored.node(NodeId(50)).unwrap().blend_mode,
            BlendMode::LinearDodge
        );
        assert_eq!(
            restored.fill_stack_for_node(NodeId(49)).unwrap().layers[0].blend_mode,
            BlendMode::LinearDodge
        );
        assert_eq!(restored.canonical_hash(), hash);
    }

    #[test]
    fn isolated_normal_round_trips_and_requires_semantics_ten() {
        let mut document = Document::with_id(DocumentId(51));
        let mut group = node(51, NodeKind::Frame, None);
        group
            .extensions
            .insert(NORMAL_BLEND_ISOLATION_EXTENSION.into(), vec![1]);
        document.seed_node_on_page(DEFAULT_PAGE_ID, group).unwrap();

        assert_eq!(
            snapshot_from_document(
                &document,
                NORMAL_BLEND_ISOLATION_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, NORMAL_BLEND_ISOLATION_ENGINE_SEMANTICS_VERSION)
                .unwrap();
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &snapshot,
                51_u128.to_be_bytes(),
                hash,
                NORMAL_BLEND_ISOLATION_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            51_u128.to_be_bytes(),
            hash,
            NORMAL_BLEND_ISOLATION_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored
                .node(NodeId(51))
                .unwrap()
                .extensions
                .get(NORMAL_BLEND_ISOLATION_EXTENSION),
            Some(&vec![1])
        );
        assert_eq!(restored.canonical_hash(), hash);

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = NORMAL_BLEND_ISOLATION_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                51_u128.to_be_bytes(),
                hash,
                NORMAL_BLEND_ISOLATION_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn image_filters_round_trip_and_require_semantics_eleven() {
        let asset = AssetReference {
            asset_id: AssetId(520),
            content_hash: [52; 32],
            media_type: "image/png".into(),
            byte_length: 64,
            dimensions: Some([8, 4]),
            font_faces: Vec::new(),
        };
        let mut document = Document::with_id(DocumentId(52));
        document.seed_asset(asset.clone()).unwrap();
        document
            .seed_node_on_page(DEFAULT_PAGE_ID, node(52, NodeKind::Rectangle, None))
            .unwrap();
        document
            .seed_paint_stacks(
                NodeId(52),
                Some(PaintStack {
                    layers: vec![PaintLayer {
                        paint: PaintLayerKind::Image(ImagePaint {
                            asset_id: asset.asset_id,
                            scale_mode: ImageScaleMode::Fill,
                            transform: AffineTransform::IDENTITY,
                            rotation_degrees: 0,
                            filters: Some(ImageFilters {
                                exposure: Some(0.25),
                                shadows: Some(-0.5),
                                ..ImageFilters::default()
                            }),
                        }),
                        visible: true,
                        opacity: 1.0,
                        blend_mode: BlendMode::Normal,
                    }],
                }),
                None,
            )
            .unwrap();

        assert_eq!(
            snapshot_from_document(&document, IMAGE_FILTERS_ENGINE_SEMANTICS_VERSION - 1),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, IMAGE_FILTERS_ENGINE_SEMANTICS_VERSION).unwrap();
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &snapshot,
                52_u128.to_be_bytes(),
                hash,
                IMAGE_FILTERS_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            52_u128.to_be_bytes(),
            hash,
            IMAGE_FILTERS_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert!(matches!(
            restored.fill_stack_for_node(NodeId(52)).unwrap().layers[0].paint,
            PaintLayerKind::Image(ImagePaint {
                filters: Some(ImageFilters { exposure: Some(value), shadows: Some(shadows), .. }),
                ..
            }) if (value - 0.25).abs() < f32::EPSILON && (shadows + 0.5).abs() < f32::EPSILON
        ));
        assert_eq!(restored.canonical_hash(), hash);

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = IMAGE_FILTERS_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                52_u128.to_be_bytes(),
                hash,
                IMAGE_FILTERS_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn text_truncation_round_trips_and_requires_semantics_twelve() {
        let mut document = Document::with_id(DocumentId(53));
        let mut text = node(53, NodeKind::Text, None);
        text.text = "one two three".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, text).unwrap();
        let properties = TextProperties {
            text_truncation: TextTruncation::Ending,
            max_lines: Some(2),
            ..TextProperties::default()
        };
        document
            .seed_text_properties(NodeId(53), properties.clone())
            .unwrap();

        assert_eq!(
            snapshot_from_document(&document, TEXT_TRUNCATION_ENGINE_SEMANTICS_VERSION - 1),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, TEXT_TRUNCATION_ENGINE_SEMANTICS_VERSION).unwrap();
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &snapshot,
                53_u128.to_be_bytes(),
                hash,
                TEXT_TRUNCATION_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            53_u128.to_be_bytes(),
            hash,
            TEXT_TRUNCATION_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.text_properties_for_node(NodeId(53)),
            Some(&properties)
        );
        assert_eq!(restored.canonical_hash(), hash);

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = TEXT_TRUNCATION_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                53_u128.to_be_bytes(),
                hash,
                TEXT_TRUNCATION_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn shape_with_text_sublayer_styles_require_semantics_thirteen() {
        let mut document = Document::with_id(DocumentId(54));
        let mut shape = node(54, NodeKind::ShapeWithText, None);
        shape.text = "Approve".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, shape).unwrap();
        let properties = TextProperties {
            runs: vec![TextStyleRun {
                start: 0,
                end: 7,
                font: None,
                font_size: 18.0,
                font_weight: 650,
                italic: false,
                letter_spacing: 1.5,
                color: None,
                fill_stack: None,

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
                paint_style_id: None,
                variable_bindings: Default::default(),
                text_decoration_color: None,
            }],
            paragraph: ParagraphStyle {
                alignment: TextAlign::Center,
                line_height: Some(24.0),
                line_height_unit: None,
                paragraph_spacing: 4.0,
                paragraph_indent: None,
                text_wrap_style: None,
                list_type: None,
                list_spacing: None,
                hanging_list: false,
                hanging_punctuation: false,
            },
            ..TextProperties::default()
        };
        document
            .seed_text_properties(NodeId(54), properties.clone())
            .unwrap();

        assert_eq!(
            snapshot_from_document(&document, SHAPE_WITH_TEXT_TEXT_ENGINE_SEMANTICS_VERSION - 1),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, SHAPE_WITH_TEXT_TEXT_ENGINE_SEMANTICS_VERSION)
                .unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            54_u128.to_be_bytes(),
            hash,
            SHAPE_WITH_TEXT_TEXT_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.text_properties_for_node(NodeId(54)),
            Some(&properties)
        );

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = SHAPE_WITH_TEXT_TEXT_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                54_u128.to_be_bytes(),
                hash,
                SHAPE_WITH_TEXT_TEXT_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn text_run_paint_stack_round_trips_and_requires_semantics_fourteen() {
        let mut document = Document::with_id(DocumentId(55));
        let mut text = node(55, NodeKind::Text, None);
        text.text = "AB".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, text).unwrap();
        let properties = TextProperties {
            runs: vec![TextStyleRun {
                start: 0,
                end: 2,
                font: None,
                font_size: 16.0,
                font_weight: 500,
                italic: false,
                letter_spacing: 0.0,
                color: None,
                fill_stack: Some(PaintStack::default()),

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
                paint_style_id: None,
                variable_bindings: Default::default(),
                text_decoration_color: None,
            }],
            ..TextProperties::default()
        };
        document
            .seed_text_properties(NodeId(55), properties.clone())
            .unwrap();

        assert_eq!(
            snapshot_from_document(&document, TEXT_RUN_PAINT_STACK_ENGINE_SEMANTICS_VERSION - 1,),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, TEXT_RUN_PAINT_STACK_ENGINE_SEMANTICS_VERSION)
                .unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            55_u128.to_be_bytes(),
            hash,
            TEXT_RUN_PAINT_STACK_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.text_properties_for_node(NodeId(55)),
            Some(&properties)
        );
        assert_eq!(restored.canonical_hash(), hash);

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = TEXT_RUN_PAINT_STACK_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                55_u128.to_be_bytes(),
                hash,
                TEXT_RUN_PAINT_STACK_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn empty_text_base_style_round_trips_and_requires_semantics_fifteen() {
        let mut document = Document::with_id(DocumentId(56));
        let mut shape = node(56, NodeKind::ShapeWithText, None);
        shape.text.clear();
        document.seed_node_on_page(DEFAULT_PAGE_ID, shape).unwrap();
        let properties = TextProperties {
            base_style: Some(TextStyleRun {
                start: 0,
                end: 0,
                font: None,
                font_size: 22.0,
                font_weight: 600,
                italic: true,
                letter_spacing: 1.25,
                color: None,
                fill_stack: Some(PaintStack::default()),

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
                paint_style_id: None,
                variable_bindings: Default::default(),
                text_decoration_color: None,
            }),
            ..TextProperties::default()
        };
        document
            .seed_text_properties(NodeId(56), properties.clone())
            .unwrap();

        assert_eq!(
            snapshot_from_document(&document, TEXT_BASE_STYLE_ENGINE_SEMANTICS_VERSION - 1),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, TEXT_BASE_STYLE_ENGINE_SEMANTICS_VERSION).unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            56_u128.to_be_bytes(),
            hash,
            TEXT_BASE_STYLE_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.text_properties_for_node(NodeId(56)),
            Some(&properties)
        );
        assert_eq!(restored.canonical_hash(), hash);

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = TEXT_BASE_STYLE_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                56_u128.to_be_bytes(),
                hash,
                TEXT_BASE_STYLE_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn text_case_round_trips_and_requires_semantics_sixteen() {
        let mut document = Document::with_id(DocumentId(57));
        let mut text = node(57, NodeKind::Text, None);
        text.text = "Case".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, text).unwrap();
        let properties = TextProperties {
            runs: vec![TextStyleRun {
                start: 0,
                end: 4,
                font: None,
                font_size: 16.0,
                font_weight: 400,
                italic: false,
                letter_spacing: 0.0,
                color: None,
                fill_stack: None,
                text_case: Some(TextCase::SmallCapsForced),
                hyperlink: None,
                text_decoration: None,
                text_decoration_style: None,
                text_decoration_offset: None,
                text_decoration_thickness: None,
                text_decoration_skip_ink: None,
                leading_trim: None,
                open_type_features: Vec::new(),
                text_style_id: None,
                paint_style_id: None,
                variable_bindings: Default::default(),
                text_decoration_color: None,
            }],
            ..TextProperties::default()
        };
        document
            .seed_text_properties(NodeId(57), properties.clone())
            .unwrap();

        assert_eq!(
            snapshot_from_document(&document, TEXT_CASE_ENGINE_SEMANTICS_VERSION - 1),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, TEXT_CASE_ENGINE_SEMANTICS_VERSION).unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            57_u128.to_be_bytes(),
            hash,
            TEXT_CASE_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.text_properties_for_node(NodeId(57)),
            Some(&properties)
        );
        assert_eq!(restored.canonical_hash(), hash);

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = TEXT_CASE_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                57_u128.to_be_bytes(),
                hash,
                TEXT_CASE_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn text_path_text_properties_round_trip_and_require_semantics_seventeen() {
        let mut document = Document::with_id(DocumentId(58));
        let mut text_path = node(58, NodeKind::TextPath, None);
        text_path.text = "Curve".into();
        text_path.vector_path = Some(VectorPath {
            fill_rule: FillRule::NonZero,
            subpaths: vec![VectorSubpath {
                closed: false,
                points: vec![
                    VectorPoint {
                        id: PointId(1),
                        position: editor_core::geometry::Point { x: 0.0, y: 40.0 },
                        handle_in: None,
                        handle_out: None,
                        point_type: VectorPointType::Corner,
                    },
                    VectorPoint {
                        id: PointId(2),
                        position: editor_core::geometry::Point { x: 100.0, y: 40.0 },
                        handle_in: None,
                        handle_out: None,
                        point_type: VectorPointType::Corner,
                    },
                ],
            }],
        });
        document
            .seed_node_on_page(DEFAULT_PAGE_ID, text_path)
            .unwrap();
        let properties = TextProperties {
            runs: vec![TextStyleRun {
                start: 0,
                end: 5,
                font: None,
                font_size: 18.0,
                font_weight: 600,
                italic: false,
                letter_spacing: 1.0,
                color: None,
                fill_stack: None,
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
                paint_style_id: None,
                variable_bindings: Default::default(),
                text_decoration_color: None,
            }],
            ..TextProperties::default()
        };
        document
            .seed_text_properties(NodeId(58), properties.clone())
            .unwrap();

        assert_eq!(
            snapshot_from_document(&document, TEXT_PATH_ENGINE_SEMANTICS_VERSION - 1),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, TEXT_PATH_ENGINE_SEMANTICS_VERSION).unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            58_u128.to_be_bytes(),
            hash,
            TEXT_PATH_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.text_properties_for_node(NodeId(58)),
            Some(&properties)
        );
        assert_eq!(restored.canonical_hash(), hash);

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = TEXT_PATH_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                58_u128.to_be_bytes(),
                hash,
                TEXT_PATH_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn relative_line_height_round_trips_and_requires_semantics_eighteen() {
        let mut document = Document::with_id(DocumentId(59));
        let mut text = node(59, NodeKind::Text, None);
        text.text = "Scale".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, text).unwrap();
        let properties = TextProperties {
            runs: vec![TextStyleRun {
                start: 0,
                end: 5,
                font: None,
                font_size: 20.0,
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
                text_decoration_skip_ink: None,
                leading_trim: None,
                open_type_features: Vec::new(),
                text_style_id: None,
                paint_style_id: None,
                variable_bindings: Default::default(),
                text_decoration_color: None,
            }],
            paragraph: ParagraphStyle {
                alignment: TextAlign::Left,
                line_height: Some(150.0),
                line_height_unit: Some(LineHeightUnit::Percent),
                paragraph_spacing: 0.0,
                paragraph_indent: None,
                text_wrap_style: None,
                list_type: None,
                list_spacing: None,
                hanging_list: false,
                hanging_punctuation: false,
            },
            ..TextProperties::default()
        };
        document
            .seed_text_properties(NodeId(59), properties.clone())
            .unwrap();

        assert_eq!(
            snapshot_from_document(&document, LINE_HEIGHT_UNIT_ENGINE_SEMANTICS_VERSION - 1),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, LINE_HEIGHT_UNIT_ENGINE_SEMANTICS_VERSION).unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            59_u128.to_be_bytes(),
            hash,
            LINE_HEIGHT_UNIT_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.text_properties_for_node(NodeId(59)),
            Some(&properties)
        );

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = LINE_HEIGHT_UNIT_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                59_u128.to_be_bytes(),
                hash,
                LINE_HEIGHT_UNIT_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn paragraph_indent_round_trips_and_requires_semantics_nineteen() {
        let mut document = Document::with_id(DocumentId(60));
        let mut text = node(60, NodeKind::Text, None);
        text.text = "Inset".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, text).unwrap();
        let properties = TextProperties {
            runs: vec![TextStyleRun {
                start: 0,
                end: 5,
                font: None,
                font_size: 20.0,
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
                text_decoration_skip_ink: None,
                leading_trim: None,
                open_type_features: Vec::new(),
                text_style_id: None,
                paint_style_id: None,
                variable_bindings: Default::default(),
                text_decoration_color: None,
            }],
            paragraph: ParagraphStyle {
                paragraph_indent: Some(16.0),
                text_wrap_style: None,
                list_type: None,
                list_spacing: None,
                hanging_list: false,
                hanging_punctuation: false,
                ..TextProperties::default().paragraph
            },
            ..TextProperties::default()
        };
        document
            .seed_text_properties(NodeId(60), properties.clone())
            .unwrap();

        assert_eq!(
            snapshot_from_document(&document, PARAGRAPH_INDENT_ENGINE_SEMANTICS_VERSION - 1),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, PARAGRAPH_INDENT_ENGINE_SEMANTICS_VERSION).unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            60_u128.to_be_bytes(),
            hash,
            PARAGRAPH_INDENT_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.text_properties_for_node(NodeId(60)),
            Some(&properties)
        );

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = PARAGRAPH_INDENT_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                60_u128.to_be_bytes(),
                hash,
                PARAGRAPH_INDENT_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn text_wrap_style_round_trips_and_requires_semantics_twenty() {
        let mut document = Document::with_id(DocumentId(61));
        let mut text = node(61, NodeKind::Text, None);
        text.text = "aa bb cc dd".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, text).unwrap();
        let properties = TextProperties {
            paragraph: ParagraphStyle {
                text_wrap_style: Some(TextWrapStyle::Balance),
                list_type: None,
                list_spacing: None,
                hanging_list: false,
                hanging_punctuation: false,
                ..TextProperties::default().paragraph
            },
            ..TextProperties::default()
        };
        document
            .seed_text_properties(NodeId(61), properties.clone())
            .unwrap();

        assert_eq!(
            snapshot_from_document(&document, TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION - 1),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION).unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            61_u128.to_be_bytes(),
            hash,
            TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.text_properties_for_node(NodeId(61)),
            Some(&properties)
        );

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                61_u128.to_be_bytes(),
                hash,
                TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn text_hyperlink_round_trips_and_requires_semantics_twenty_one() {
        let mut document = Document::with_id(DocumentId(62));
        let mut text = node(62, NodeKind::Text, None);
        text.text = "Link".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, text).unwrap();
        let properties = TextProperties {
            runs: vec![TextStyleRun {
                start: 0,
                end: 4,
                font: None,
                font_size: 16.0,
                font_weight: 400,
                italic: false,
                letter_spacing: 0.0,
                color: None,
                fill_stack: None,
                text_case: None,
                hyperlink: Some(HyperlinkTarget {
                    kind: HyperlinkType::Url,
                    value: "https://example.com".into(),
                }),
                text_decoration: None,
                text_decoration_style: None,
                text_decoration_offset: None,
                text_decoration_thickness: None,
                text_decoration_skip_ink: None,
                leading_trim: None,
                open_type_features: Vec::new(),
                text_style_id: None,
                paint_style_id: None,
                variable_bindings: Default::default(),
                text_decoration_color: None,
            }],
            ..TextProperties::default()
        };
        document
            .seed_text_properties(NodeId(62), properties.clone())
            .unwrap();
        assert_eq!(
            snapshot_from_document(&document, TEXT_HYPERLINK_ENGINE_SEMANTICS_VERSION - 1),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, TEXT_HYPERLINK_ENGINE_SEMANTICS_VERSION).unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            62_u128.to_be_bytes(),
            hash,
            TEXT_HYPERLINK_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.text_properties_for_node(NodeId(62)),
            Some(&properties)
        );

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = TEXT_HYPERLINK_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                62_u128.to_be_bytes(),
                hash,
                TEXT_HYPERLINK_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn text_decoration_round_trips_and_requires_semantics_twenty_two() {
        let mut document = Document::with_id(DocumentId(63));
        let mut text = node(63, NodeKind::Text, None);
        text.text = "Line".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, text).unwrap();
        let properties = TextProperties {
            runs: vec![TextStyleRun {
                start: 0,
                end: 4,
                font: None,
                font_size: 16.0,
                font_weight: 400,
                italic: false,
                letter_spacing: 0.0,
                color: None,
                fill_stack: None,
                text_case: None,
                hyperlink: None,
                text_decoration: Some(TextDecoration::Underline),
                text_decoration_style: None,
                text_decoration_offset: None,
                text_decoration_thickness: None,
                text_decoration_skip_ink: None,
                leading_trim: None,
                open_type_features: Vec::new(),
                text_style_id: None,
                paint_style_id: None,
                variable_bindings: Default::default(),
                text_decoration_color: None,
            }],
            ..TextProperties::default()
        };
        document
            .seed_text_properties(NodeId(63), properties.clone())
            .unwrap();
        assert_eq!(
            snapshot_from_document(&document, TEXT_DECORATION_ENGINE_SEMANTICS_VERSION - 1),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, TEXT_DECORATION_ENGINE_SEMANTICS_VERSION).unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            63_u128.to_be_bytes(),
            hash,
            TEXT_DECORATION_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.text_properties_for_node(NodeId(63)),
            Some(&properties)
        );

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = TEXT_DECORATION_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                63_u128.to_be_bytes(),
                hash,
                TEXT_DECORATION_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn text_decoration_style_round_trips_and_requires_semantics_twenty_three() {
        let mut document = Document::with_id(DocumentId(64));
        let mut text = node(64, NodeKind::Text, None);
        text.text = "Wave".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, text).unwrap();
        let properties = TextProperties {
            runs: vec![TextStyleRun {
                start: 0,
                end: 4,
                font: None,
                font_size: 16.0,
                font_weight: 400,
                italic: false,
                letter_spacing: 0.0,
                color: None,
                fill_stack: None,
                text_case: None,
                hyperlink: None,
                text_decoration: Some(TextDecoration::Underline),
                text_decoration_style: Some(TextDecorationStyle::Wavy),
                text_decoration_offset: None,
                text_decoration_thickness: None,
                text_decoration_skip_ink: None,
                leading_trim: None,
                open_type_features: Vec::new(),
                text_style_id: None,
                paint_style_id: None,
                variable_bindings: Default::default(),
                text_decoration_color: None,
            }],
            ..TextProperties::default()
        };
        document
            .seed_text_properties(NodeId(64), properties.clone())
            .unwrap();
        assert_eq!(
            snapshot_from_document(
                &document,
                TEXT_DECORATION_STYLE_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, TEXT_DECORATION_STYLE_ENGINE_SEMANTICS_VERSION)
                .unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            64_u128.to_be_bytes(),
            hash,
            TEXT_DECORATION_STYLE_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.text_properties_for_node(NodeId(64)),
            Some(&properties)
        );

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = TEXT_DECORATION_STYLE_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                64_u128.to_be_bytes(),
                hash,
                TEXT_DECORATION_STYLE_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn text_decoration_offset_round_trips_and_requires_semantics_twenty_four() {
        let mut document = Document::with_id(DocumentId(65));
        let mut text = node(65, NodeKind::Text, None);
        text.text = "Offset".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, text).unwrap();
        let style = TextStyleRun {
            start: 0,
            end: 6,
            font: None,
            font_size: 16.0,
            font_weight: 400,
            italic: false,
            letter_spacing: 0.0,
            color: None,
            fill_stack: None,
            text_case: None,
            hyperlink: None,
            text_decoration: Some(TextDecoration::Underline),
            text_decoration_style: None,
            text_decoration_offset: Some(TextDecorationOffset::Percent(-25.0)),
            text_decoration_thickness: None,
            text_decoration_skip_ink: None,
            leading_trim: None,
            open_type_features: Vec::new(),
            text_style_id: None,
            paint_style_id: None,
            variable_bindings: Default::default(),
            text_decoration_color: None,
        };
        let properties = TextProperties {
            runs: vec![style],
            ..TextProperties::default()
        };
        document
            .seed_text_properties(NodeId(65), properties.clone())
            .unwrap();
        assert_eq!(
            snapshot_from_document(
                &document,
                TEXT_DECORATION_OFFSET_ENGINE_SEMANTICS_VERSION - 1
            ),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, TEXT_DECORATION_OFFSET_ENGINE_SEMANTICS_VERSION)
                .unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            65_u128.to_be_bytes(),
            hash,
            TEXT_DECORATION_OFFSET_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.text_properties_for_node(NodeId(65)),
            Some(&properties)
        );

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = TEXT_DECORATION_OFFSET_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                65_u128.to_be_bytes(),
                hash,
                TEXT_DECORATION_OFFSET_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn text_decoration_thickness_round_trips_and_requires_semantics_twenty_five() {
        let mut document = Document::with_id(DocumentId(66));
        let mut text = node(66, NodeKind::Text, None);
        text.text = "Thick".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, text).unwrap();
        let style = TextStyleRun {
            start: 0,
            end: 5,
            font: None,
            font_size: 16.0,
            font_weight: 400,
            italic: false,
            letter_spacing: 0.0,
            color: None,
            fill_stack: None,
            text_case: None,
            hyperlink: None,
            text_decoration: Some(TextDecoration::Underline),
            text_decoration_style: None,
            text_decoration_offset: None,
            text_decoration_thickness: Some(TextDecorationThickness::Percent(12.5)),
            text_decoration_skip_ink: None,
            leading_trim: None,
            open_type_features: Vec::new(),
            text_style_id: None,
            paint_style_id: None,
            variable_bindings: Default::default(),
            text_decoration_color: None,
        };
        let properties = TextProperties {
            runs: vec![style],
            ..TextProperties::default()
        };
        document
            .seed_text_properties(NodeId(66), properties.clone())
            .unwrap();
        assert_eq!(
            snapshot_from_document(
                &document,
                TEXT_DECORATION_THICKNESS_ENGINE_SEMANTICS_VERSION - 1
            ),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot = snapshot_from_document(
            &document,
            TEXT_DECORATION_THICKNESS_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            66_u128.to_be_bytes(),
            hash,
            TEXT_DECORATION_THICKNESS_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.text_properties_for_node(NodeId(66)),
            Some(&properties)
        );

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version =
            TEXT_DECORATION_THICKNESS_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                66_u128.to_be_bytes(),
                hash,
                TEXT_DECORATION_THICKNESS_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn text_decoration_color_round_trips_and_requires_semantics_twenty_six() {
        let mut document = Document::with_id(DocumentId(67));
        let mut text = node(67, NodeKind::Text, None);
        text.text = "Color".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, text).unwrap();
        let properties = TextProperties {
            runs: vec![TextStyleRun {
                start: 0,
                end: 5,
                font: None,
                font_size: 16.0,
                font_weight: 400,
                italic: false,
                letter_spacing: 0.0,
                color: None,
                fill_stack: None,
                text_case: None,
                hyperlink: None,
                text_decoration: Some(TextDecoration::Underline),
                text_decoration_style: None,
                text_decoration_offset: None,
                text_decoration_thickness: None,
                text_decoration_skip_ink: None,
                leading_trim: None,
                open_type_features: Vec::new(),
                text_style_id: None,
                paint_style_id: None,
                variable_bindings: Default::default(),
                text_decoration_color: Some(Box::new(TextDecorationColor {
                    color: Color {
                        space: ColorSpace::Srgb,
                        components: [1.0, 0.25, 0.5],
                        alpha: 1.0,
                    },
                    visible: true,
                    opacity: 0.75,
                    blend_mode: BlendMode::Multiply,
                    variable_id: None,
                })),
            }],
            ..TextProperties::default()
        };
        document
            .seed_text_properties(NodeId(67), properties.clone())
            .unwrap();
        assert_eq!(
            snapshot_from_document(
                &document,
                TEXT_DECORATION_COLOR_ENGINE_SEMANTICS_VERSION - 1
            ),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, TEXT_DECORATION_COLOR_ENGINE_SEMANTICS_VERSION)
                .unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            67_u128.to_be_bytes(),
            hash,
            TEXT_DECORATION_COLOR_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.text_properties_for_node(NodeId(67)),
            Some(&properties)
        );

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = TEXT_DECORATION_COLOR_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                67_u128.to_be_bytes(),
                hash,
                TEXT_DECORATION_COLOR_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn text_decoration_color_variable_round_trips_and_requires_semantics_sixty_three() {
        let mut document = Document::with_id(DocumentId(167));
        let collection = VariableCollectionResource {
            id: "VC:decoration".into(),
            key: String::new(),
            name: "Decoration".into(),
            remote: false,
            hidden_from_publishing: false,
            modes: vec![VariableMode {
                id: "default".into(),
                name: "Default".into(),
            }],
            default_mode_id: "default".into(),
        };
        let variable = VariableResource {
            id: "V:decoration".into(),
            key: String::new(),
            name: "Decoration".into(),
            description: String::new(),
            remote: false,
            hidden_from_publishing: false,
            collection_id: collection.id.clone(),
            resolved_type: VariableResolvedType::Color,
            values_by_mode: [(
                "default".into(),
                VariableValue::Color(Color::from_srgb_u8([255, 64, 128], 255)),
            )]
            .into(),
            scopes: vec!["ALL_FILLS".into()],
            code_syntax: BTreeMap::new(),
        };
        document.seed_variable_collection(collection).unwrap();
        document.seed_variable(variable.clone()).unwrap();
        let mut text = node(167, NodeKind::Text, None);
        text.text = "Color".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, text).unwrap();
        let style = TextStyleRun {
            start: 0,
            end: 5,
            font: None,
            font_size: 16.0,
            font_weight: 400,
            italic: false,
            letter_spacing: 0.0,
            color: None,
            fill_stack: None,
            text_case: None,
            hyperlink: None,
            text_decoration: Some(TextDecoration::Underline),
            text_decoration_style: None,
            text_decoration_offset: None,
            text_decoration_thickness: None,
            text_decoration_skip_ink: None,
            leading_trim: None,
            open_type_features: Vec::new(),
            text_style_id: None,
            paint_style_id: None,
            variable_bindings: Default::default(),
            text_decoration_color: Some(Box::new(TextDecorationColor {
                color: Color::from_srgb_u8([255, 64, 128], 255),
                visible: true,
                opacity: 0.75,
                blend_mode: BlendMode::Normal,
                variable_id: Some(variable.id.into()),
            })),
        };
        let properties = TextProperties {
            runs: vec![style],
            ..TextProperties::default()
        };
        document
            .seed_text_properties(NodeId(167), properties.clone())
            .unwrap();
        assert_eq!(
            snapshot_from_document(
                &document,
                TEXT_DECORATION_COLOR_VARIABLE_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot = snapshot_from_document(
            &document,
            TEXT_DECORATION_COLOR_VARIABLE_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            167_u128.to_be_bytes(),
            hash,
            TEXT_DECORATION_COLOR_VARIABLE_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.text_properties_for_node(NodeId(167)),
            Some(&properties)
        );

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version =
            TEXT_DECORATION_COLOR_VARIABLE_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                167_u128.to_be_bytes(),
                hash,
                TEXT_DECORATION_COLOR_VARIABLE_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn text_decoration_skip_ink_round_trips_and_requires_semantics_twenty_seven() {
        let mut document = Document::with_id(DocumentId(68));
        let mut text = node(68, NodeKind::Text, None);
        text.text = "glyph".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, text).unwrap();
        let properties = TextProperties {
            runs: vec![TextStyleRun {
                start: 0,
                end: 5,
                font: None,
                font_size: 16.0,
                font_weight: 400,
                italic: false,
                letter_spacing: 0.0,
                color: None,
                fill_stack: None,
                text_case: None,
                hyperlink: None,
                text_decoration: Some(TextDecoration::Underline),
                text_decoration_style: None,
                text_decoration_offset: None,
                text_decoration_thickness: None,
                text_decoration_color: None,
                text_decoration_skip_ink: Some(true),
                leading_trim: None,
                open_type_features: Vec::new(),
                text_style_id: None,
                paint_style_id: None,
                variable_bindings: Default::default(),
            }],
            ..TextProperties::default()
        };
        document
            .seed_text_properties(NodeId(68), properties.clone())
            .unwrap();
        assert_eq!(
            snapshot_from_document(
                &document,
                TEXT_DECORATION_SKIP_INK_ENGINE_SEMANTICS_VERSION - 1
            ),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, TEXT_DECORATION_SKIP_INK_ENGINE_SEMANTICS_VERSION)
                .unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            68_u128.to_be_bytes(),
            hash,
            TEXT_DECORATION_SKIP_INK_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.text_properties_for_node(NodeId(68)),
            Some(&properties)
        );

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = TEXT_DECORATION_SKIP_INK_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                68_u128.to_be_bytes(),
                hash,
                TEXT_DECORATION_SKIP_INK_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn leading_trim_round_trips_and_requires_semantics_twenty_eight() {
        let mut document = Document::with_id(DocumentId(69));
        let mut text = node(69, NodeKind::Text, None);
        text.text = "Cap".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, text).unwrap();
        let properties = TextProperties {
            runs: vec![TextStyleRun {
                start: 0,
                end: 3,
                font: None,
                font_size: 16.0,
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
                leading_trim: Some(LeadingTrim::CapHeight),
                open_type_features: Vec::new(),
                text_style_id: None,
                paint_style_id: None,
                variable_bindings: Default::default(),
            }],
            ..TextProperties::default()
        };
        document
            .seed_text_properties(NodeId(69), properties.clone())
            .unwrap();
        assert_eq!(
            snapshot_from_document(&document, LEADING_TRIM_ENGINE_SEMANTICS_VERSION - 1),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, LEADING_TRIM_ENGINE_SEMANTICS_VERSION).unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            69_u128.to_be_bytes(),
            hash,
            LEADING_TRIM_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.text_properties_for_node(NodeId(69)),
            Some(&properties)
        );
        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = LEADING_TRIM_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                69_u128.to_be_bytes(),
                hash,
                LEADING_TRIM_ENGINE_SEMANTICS_VERSION
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn open_type_features_round_trip_and_require_semantics_forty_two() {
        let mut document = Document::with_id(DocumentId(170));
        let mut text = node(170, NodeKind::Text, None);
        text.text = "office".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, text).unwrap();
        let style = TextStyleRun {
            start: 0,
            end: 6,
            font: None,
            font_size: 16.0,
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
            open_type_features: vec![
                OpenTypeFeature {
                    tag: "KERN".into(),
                    enabled: false,
                },
                OpenTypeFeature {
                    tag: "LIGA".into(),
                    enabled: true,
                },
            ],
            text_style_id: None,
            paint_style_id: None,
            variable_bindings: Default::default(),
        };
        let properties = TextProperties {
            runs: vec![style],
            ..TextProperties::default()
        };
        document
            .seed_text_properties(NodeId(170), properties.clone())
            .unwrap();
        assert_eq!(
            snapshot_from_document(&document, OPEN_TYPE_FEATURES_ENGINE_SEMANTICS_VERSION - 1),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, OPEN_TYPE_FEATURES_ENGINE_SEMANTICS_VERSION).unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            170_u128.to_be_bytes(),
            hash,
            OPEN_TYPE_FEATURES_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.text_properties_for_node(NodeId(170)),
            Some(&properties)
        );
        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = OPEN_TYPE_FEATURES_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                170_u128.to_be_bytes(),
                hash,
                OPEN_TYPE_FEATURES_ENGINE_SEMANTICS_VERSION
            ),
            Err(SnapshotError::Invalid)
        );

        let mut linked_document = Document::with_id(DocumentId(171));
        let mut linked_text = node(171, NodeKind::Text, None);
        linked_text.text = "office".into();
        linked_document
            .seed_node_on_page(DEFAULT_PAGE_ID, linked_text)
            .unwrap();
        let mut linked_properties = properties;
        linked_properties.runs[0].open_type_features.clear();
        linked_properties.runs[0].text_style_id = Some("S:heading".into());
        linked_document
            .seed_text_properties(NodeId(171), linked_properties.clone())
            .unwrap();
        assert_eq!(
            snapshot_from_document(
                &linked_document,
                TEXT_STYLE_LINK_ENGINE_SEMANTICS_VERSION - 1
            ),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let linked_hash = linked_document.canonical_hash();
        let linked_snapshot =
            snapshot_from_document(&linked_document, TEXT_STYLE_LINK_ENGINE_SEMANTICS_VERSION)
                .unwrap();
        let linked_restored = document_from_snapshot_with_engine_semantics(
            &linked_snapshot,
            171_u128.to_be_bytes(),
            linked_hash,
            TEXT_STYLE_LINK_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            linked_restored.text_properties_for_node(NodeId(171)),
            Some(&linked_properties)
        );
        let mut mislabeled_link = v1::DocumentSnapshot::decode(linked_snapshot.as_slice()).unwrap();
        mislabeled_link.engine_semantics_version = TEXT_STYLE_LINK_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled_link.encode_to_vec(),
                171_u128.to_be_bytes(),
                linked_hash,
                TEXT_STYLE_LINK_ENGINE_SEMANTICS_VERSION
            ),
            Err(SnapshotError::Invalid)
        );

        let mut paint_linked_document = Document::with_id(DocumentId(175));
        let mut paint_linked_text = node(175, NodeKind::Text, None);
        paint_linked_text.text = "office".into();
        paint_linked_document
            .seed_node_on_page(DEFAULT_PAGE_ID, paint_linked_text)
            .unwrap();
        let mut paint_linked_properties = linked_properties;
        paint_linked_properties.runs[0].text_style_id = None;
        paint_linked_properties.runs[0].paint_style_id = Some("S:accent".into());
        paint_linked_document
            .seed_text_properties(NodeId(175), paint_linked_properties.clone())
            .unwrap();
        assert_eq!(
            snapshot_from_document(
                &paint_linked_document,
                TEXT_PAINT_STYLE_LINK_ENGINE_SEMANTICS_VERSION - 1
            ),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let paint_linked_hash = paint_linked_document.canonical_hash();
        let paint_linked_snapshot = snapshot_from_document(
            &paint_linked_document,
            TEXT_PAINT_STYLE_LINK_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        let paint_linked_restored = document_from_snapshot_with_engine_semantics(
            &paint_linked_snapshot,
            175_u128.to_be_bytes(),
            paint_linked_hash,
            TEXT_PAINT_STYLE_LINK_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            paint_linked_restored.text_properties_for_node(NodeId(175)),
            Some(&paint_linked_properties)
        );
    }

    #[test]
    fn text_style_catalog_round_trips_and_requires_semantics_forty_four() {
        let mut document = Document::with_id(DocumentId(172));
        let paragraph = TextProperties::default().paragraph;
        let style = TextStyleResource {
            id: "S:body".into(),
            key: "library-key".into(),
            name: "Body".into(),
            description: "Body text".into(),
            description_markdown: String::new(),
            documentation_links: Vec::new(),
            remote: true,
            style: TextStyleRun {
                start: 0,
                end: 0,
                font: None,
                font_size: 16.0,
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
                variable_bindings: Default::default(),
            },
            letter_spacing_unit: None,
            variable_bindings: BTreeMap::new(),
            paragraph,
        };
        document.seed_text_style(style.clone()).unwrap();
        assert_eq!(
            snapshot_from_document(&document, TEXT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION - 1,),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, TEXT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION).unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            172_u128.to_be_bytes(),
            hash,
            TEXT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(restored.text_style("S:body"), Some(&style));
        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = TEXT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                172_u128.to_be_bytes(),
                hash,
                TEXT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );

        let mut percent_document = Document::with_id(DocumentId(177));
        let mut percent_style = style.clone();
        percent_style.id = "S:tracking".into();
        percent_style.style.letter_spacing = 10.0;
        percent_style.letter_spacing_unit = Some(TextStyleLetterSpacingUnit::Percent);
        percent_document
            .seed_text_style(percent_style.clone())
            .unwrap();
        assert_eq!(
            snapshot_from_document(
                &percent_document,
                TEXT_STYLE_PERCENT_LETTER_SPACING_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let percent_hash = percent_document.canonical_hash();
        let percent_snapshot = snapshot_from_document(
            &percent_document,
            TEXT_STYLE_PERCENT_LETTER_SPACING_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        let percent_restored = document_from_snapshot_with_engine_semantics(
            &percent_snapshot,
            177_u128.to_be_bytes(),
            percent_hash,
            TEXT_STYLE_PERCENT_LETTER_SPACING_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            percent_restored.text_style("S:tracking"),
            Some(&percent_style)
        );
        let mut percent_mislabeled =
            v1::DocumentSnapshot::decode(percent_snapshot.as_slice()).unwrap();
        percent_mislabeled.engine_semantics_version =
            TEXT_STYLE_PERCENT_LETTER_SPACING_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &percent_mislabeled.encode_to_vec(),
                177_u128.to_be_bytes(),
                percent_hash,
                TEXT_STYLE_PERCENT_LETTER_SPACING_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );

        let mut bound_document = Document::with_id(DocumentId(178));
        bound_document
            .seed_variable_collection(VariableCollectionResource {
                id: "VC:typography".into(),
                key: String::new(),
                name: "Typography".into(),
                remote: false,
                hidden_from_publishing: false,
                modes: vec![VariableMode {
                    id: "default".into(),
                    name: "Default".into(),
                }],
                default_mode_id: "default".into(),
            })
            .unwrap();
        bound_document
            .seed_variable(VariableResource {
                id: "V:font-size".into(),
                key: String::new(),
                name: "Font size".into(),
                description: String::new(),
                remote: false,
                hidden_from_publishing: false,
                collection_id: "VC:typography".into(),
                resolved_type: VariableResolvedType::Float,
                values_by_mode: [("default".into(), VariableValue::Float(16.0))].into(),
                scopes: vec!["FONT_SIZE".into()],
                code_syntax: BTreeMap::new(),
            })
            .unwrap();
        let mut bound_style = style;
        bound_style.id = "S:bound".into();
        bound_style
            .variable_bindings
            .insert("fontSize".into(), "V:font-size".into());
        bound_document.seed_text_style(bound_style.clone()).unwrap();
        assert_eq!(
            snapshot_from_document(
                &bound_document,
                TEXT_STYLE_VARIABLE_BINDINGS_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let bound_hash = bound_document.canonical_hash();
        let bound_snapshot = snapshot_from_document(
            &bound_document,
            TEXT_STYLE_VARIABLE_BINDINGS_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        let bound_restored = document_from_snapshot_with_engine_semantics(
            &bound_snapshot,
            178_u128.to_be_bytes(),
            bound_hash,
            TEXT_STYLE_VARIABLE_BINDINGS_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(bound_restored.text_style("S:bound"), Some(&bound_style));
        let mut bound_mislabeled = v1::DocumentSnapshot::decode(bound_snapshot.as_slice()).unwrap();
        bound_mislabeled.engine_semantics_version =
            TEXT_STYLE_VARIABLE_BINDINGS_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &bound_mislabeled.encode_to_vec(),
                178_u128.to_be_bytes(),
                bound_hash,
                TEXT_STYLE_VARIABLE_BINDINGS_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );

        let mut duplicate = v1::DocumentSnapshot::decode(bound_snapshot.as_slice()).unwrap();
        duplicate.text_styles[0]
            .variable_bindings
            .push(v1::StyleVariableBinding {
                field: "fontSize".into(),
                variable_id: "V:font-size".into(),
            });
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &duplicate.encode_to_vec(),
                178_u128.to_be_bytes(),
                bound_hash,
                TEXT_STYLE_VARIABLE_BINDINGS_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn paint_style_catalog_round_trips_and_requires_semantics_forty_five() {
        let mut document = Document::with_id(DocumentId(173));
        let style = PaintStyleResource {
            id: "S:brand-fill".into(),
            key: "library-paint-key".into(),
            name: "Brand fill".into(),
            description: "Primary surface".into(),
            description_markdown: String::new(),
            documentation_links: Vec::new(),
            remote: true,
            paints: PaintStack::default(),
            variable_bindings: Vec::new(),
        };
        document.seed_paint_style(style.clone()).unwrap();
        assert_eq!(
            snapshot_from_document(&document, PAINT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION - 1),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, PAINT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION)
                .unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            173_u128.to_be_bytes(),
            hash,
            PAINT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(restored.paint_style("S:brand-fill"), Some(&style));
        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = PAINT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                173_u128.to_be_bytes(),
                hash,
                PAINT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );

        let mut bound_document = Document::with_id(DocumentId(179));
        bound_document
            .seed_variable_collection(VariableCollectionResource {
                id: "VC:colors".into(),
                key: String::new(),
                name: "Colors".into(),
                remote: false,
                hidden_from_publishing: false,
                modes: vec![VariableMode {
                    id: "default".into(),
                    name: "Default".into(),
                }],
                default_mode_id: "default".into(),
            })
            .unwrap();
        bound_document
            .seed_variable(VariableResource {
                id: "V:brand".into(),
                key: String::new(),
                name: "Brand".into(),
                description: String::new(),
                remote: false,
                hidden_from_publishing: false,
                collection_id: "VC:colors".into(),
                resolved_type: VariableResolvedType::Color,
                values_by_mode: [(
                    "default".into(),
                    VariableValue::Color(Color::from_srgb_u8([255, 0, 0], 255)),
                )]
                .into(),
                scopes: vec!["ALL_FILLS".into()],
                code_syntax: BTreeMap::new(),
            })
            .unwrap();
        let mut bound_style = style;
        bound_style.id = "S:bound-paint".into();
        bound_style.paints.layers.push(PaintLayer {
            paint: PaintLayerKind::Solid(Color::from_srgb_u8([255, 0, 0], 255)),
            visible: true,
            opacity: 1.0,
            blend_mode: BlendMode::Normal,
        });
        bound_style
            .variable_bindings
            .push(PaintStyleVariableBinding {
                paint_index: 0,
                stop_index: None,
                variable_id: "V:brand".into(),
            });
        bound_document
            .seed_paint_style(bound_style.clone())
            .unwrap();
        assert_eq!(
            snapshot_from_document(
                &bound_document,
                PAINT_STYLE_VARIABLE_BINDINGS_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let bound_hash = bound_document.canonical_hash();
        let bound_snapshot = snapshot_from_document(
            &bound_document,
            PAINT_STYLE_VARIABLE_BINDINGS_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        let bound_restored = document_from_snapshot_with_engine_semantics(
            &bound_snapshot,
            179_u128.to_be_bytes(),
            bound_hash,
            PAINT_STYLE_VARIABLE_BINDINGS_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            bound_restored.paint_style("S:bound-paint"),
            Some(&bound_style)
        );
        let mut bound_mislabeled = v1::DocumentSnapshot::decode(bound_snapshot.as_slice()).unwrap();
        bound_mislabeled.engine_semantics_version =
            PAINT_STYLE_VARIABLE_BINDINGS_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &bound_mislabeled.encode_to_vec(),
                179_u128.to_be_bytes(),
                bound_hash,
                PAINT_STYLE_VARIABLE_BINDINGS_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
        let mut duplicate = v1::DocumentSnapshot::decode(bound_snapshot.as_slice()).unwrap();
        duplicate.paint_styles[0]
            .variable_bindings
            .push(v1::PaintStyleVariableBinding {
                paint_index: 0,
                stop_index: None,
                variable_id: "V:brand".into(),
            });
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &duplicate.encode_to_vec(),
                179_u128.to_be_bytes(),
                bound_hash,
                PAINT_STYLE_VARIABLE_BINDINGS_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn effect_style_catalog_round_trips_and_requires_semantics_sixty_four() {
        let mut document = Document::with_id(DocumentId(181));
        let style = EffectStyleResource {
            id: "S:elevation".into(),
            key: "library-effect-key".into(),
            name: "Elevation".into(),
            description: "Soft elevation".into(),
            description_markdown: "**Soft elevation**".into(),
            documentation_links: vec!["https://example.com/elevation".into()],
            remote: true,
            effects: vec![Effect::LayerBlur(LayerBlur {
                radius: 8.0,
                visible: true,
            })],
        };
        document.seed_effect_style(style.clone()).unwrap();
        assert_eq!(
            snapshot_from_document(&document, EFFECT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION - 1),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, EFFECT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION)
                .unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            181_u128.to_be_bytes(),
            hash,
            EFFECT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(restored.effect_style("S:elevation"), Some(&style));

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = EFFECT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                181_u128.to_be_bytes(),
                hash,
                EFFECT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn text_range_variable_bindings_round_trip_and_require_semantics_fifty_five() {
        let mut document = Document::with_id(DocumentId(180));
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
        document.seed_variable_collection(collection).unwrap();
        document.seed_variable(variable.clone()).unwrap();
        let mut text = node(180, NodeKind::Text, None);
        text.text = "A".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, text).unwrap();
        let mut style = TextStyleRun {
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
            variable_bindings: BTreeMap::new(),
        };
        style
            .variable_bindings
            .insert("fontSize".into(), variable.id.clone());
        let properties = TextProperties {
            runs: vec![style],
            ..TextProperties::default()
        };
        document
            .seed_text_properties(NodeId(180), properties.clone())
            .unwrap();
        assert_eq!(
            snapshot_from_document(
                &document,
                TEXT_RANGE_VARIABLE_BINDINGS_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot = snapshot_from_document(
            &document,
            TEXT_RANGE_VARIABLE_BINDINGS_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            180_u128.to_be_bytes(),
            hash,
            TEXT_RANGE_VARIABLE_BINDINGS_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.text_properties_for_node(NodeId(180)),
            Some(&properties)
        );

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version =
            TEXT_RANGE_VARIABLE_BINDINGS_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                180_u128.to_be_bytes(),
                hash,
                TEXT_RANGE_VARIABLE_BINDINGS_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn style_publishable_metadata_round_trips_and_requires_semantics_fifty_one() {
        let mut document = Document::with_id(DocumentId(176));
        let text_style = TextStyleResource {
            id: "S:body".into(),
            key: String::new(),
            name: "Body".into(),
            description: "Body copy".into(),
            description_markdown: "**Body** copy".into(),
            documentation_links: vec!["https://example.com/styles/body".into()],
            remote: false,
            style: TextStyleRun {
                start: 0,
                end: 0,
                font: None,
                font_size: 16.0,
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
                variable_bindings: Default::default(),
            },
            letter_spacing_unit: None,
            variable_bindings: BTreeMap::new(),
            paragraph: TextProperties::default().paragraph,
        };
        let paint_style = PaintStyleResource {
            id: "S:brand".into(),
            key: String::new(),
            name: "Brand".into(),
            description: "Brand color".into(),
            description_markdown: "**Brand** color".into(),
            documentation_links: vec!["https://example.com/styles/brand".into()],
            remote: false,
            paints: PaintStack::default(),
            variable_bindings: Vec::new(),
        };
        document.seed_text_style(text_style.clone()).unwrap();
        document.seed_paint_style(paint_style.clone()).unwrap();

        assert_eq!(
            snapshot_from_document(
                &document,
                STYLE_PUBLISHABLE_METADATA_ENGINE_SEMANTICS_VERSION - 1,
            ),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot = snapshot_from_document(
            &document,
            STYLE_PUBLISHABLE_METADATA_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            176_u128.to_be_bytes(),
            hash,
            STYLE_PUBLISHABLE_METADATA_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(restored.text_style("S:body"), Some(&text_style));
        assert_eq!(restored.paint_style("S:brand"), Some(&paint_style));

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version =
            STYLE_PUBLISHABLE_METADATA_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                176_u128.to_be_bytes(),
                hash,
                STYLE_PUBLISHABLE_METADATA_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn paint_style_links_round_trip_and_require_semantics_forty_six() {
        let mut document = Document::with_id(DocumentId(174));
        let frame = node(174, NodeKind::Frame, None);
        document.seed_node_on_page(DEFAULT_PAGE_ID, frame).unwrap();
        let links = PaintStyleLinks {
            fill: Some("S:surface".into()),
            stroke: Some("S:border".into()),
            background: Some("S:surface".into()),
        };
        document
            .seed_paint_style_links(NodeId(174), links.clone())
            .unwrap();
        assert_eq!(
            snapshot_from_document(&document, PAINT_STYLE_LINK_ENGINE_SEMANTICS_VERSION - 1),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, PAINT_STYLE_LINK_ENGINE_SEMANTICS_VERSION).unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            174_u128.to_be_bytes(),
            hash,
            PAINT_STYLE_LINK_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.paint_style_links_for_node(NodeId(174)),
            Some(&links)
        );

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = PAINT_STYLE_LINK_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                174_u128.to_be_bytes(),
                hash,
                PAINT_STYLE_LINK_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn text_list_type_round_trips_and_requires_semantics_twenty_nine() {
        let mut document = Document::with_id(DocumentId(70));
        let mut text = node(70, NodeKind::Text, None);
        text.text = "One\nTwo".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, text).unwrap();
        let properties = TextProperties {
            paragraph: ParagraphStyle {
                list_type: Some(TextListType::Ordered),
                ..TextProperties::default().paragraph
            },
            ..TextProperties::default()
        };
        document
            .seed_text_properties(NodeId(70), properties.clone())
            .unwrap();
        assert_eq!(
            snapshot_from_document(&document, TEXT_LIST_TYPE_ENGINE_SEMANTICS_VERSION - 1),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, TEXT_LIST_TYPE_ENGINE_SEMANTICS_VERSION).unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            70_u128.to_be_bytes(),
            hash,
            TEXT_LIST_TYPE_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.text_properties_for_node(NodeId(70)),
            Some(&properties)
        );

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = TEXT_LIST_TYPE_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                70_u128.to_be_bytes(),
                hash,
                TEXT_LIST_TYPE_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn text_list_spacing_round_trips_and_requires_semantics_thirty() {
        let mut document = Document::with_id(DocumentId(71));
        let mut text = node(71, NodeKind::Text, None);
        text.text = "One\nTwo".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, text).unwrap();
        let properties = TextProperties {
            paragraph: ParagraphStyle {
                list_type: Some(TextListType::Ordered),
                list_spacing: Some(8.0),
                hanging_list: false,
                hanging_punctuation: false,
                ..TextProperties::default().paragraph
            },
            ..TextProperties::default()
        };
        document
            .seed_text_properties(NodeId(71), properties.clone())
            .unwrap();
        assert_eq!(
            snapshot_from_document(&document, TEXT_LIST_SPACING_ENGINE_SEMANTICS_VERSION - 1),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, TEXT_LIST_SPACING_ENGINE_SEMANTICS_VERSION).unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            71_u128.to_be_bytes(),
            hash,
            TEXT_LIST_SPACING_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.text_properties_for_node(NodeId(71)),
            Some(&properties)
        );

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = TEXT_LIST_SPACING_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                71_u128.to_be_bytes(),
                hash,
                TEXT_LIST_SPACING_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn paragraph_style_runs_round_trip_and_require_semantics_thirty_one() {
        let mut document = Document::with_id(DocumentId(72));
        let mut text = node(72, NodeKind::Text, None);
        text.text = "One\nTwo".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, text).unwrap();
        let properties = TextProperties {
            paragraph: ParagraphStyle {
                list_type: Some(TextListType::Ordered),
                ..TextProperties::default().paragraph
            },
            paragraph_style_runs: vec![ParagraphStyleRun {
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
            ..TextProperties::default()
        };
        document
            .seed_text_properties(NodeId(72), properties.clone())
            .unwrap();
        assert_eq!(
            snapshot_from_document(&document, PARAGRAPH_STYLE_RUNS_ENGINE_SEMANTICS_VERSION - 1),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, PARAGRAPH_STYLE_RUNS_ENGINE_SEMANTICS_VERSION)
                .unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            72_u128.to_be_bytes(),
            hash,
            PARAGRAPH_STYLE_RUNS_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.text_properties_for_node(NodeId(72)),
            Some(&properties)
        );

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = PARAGRAPH_STYLE_RUNS_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                72_u128.to_be_bytes(),
                hash,
                PARAGRAPH_STYLE_RUNS_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn paragraph_list_options_round_trip_and_require_semantics_thirty_three() {
        let mut document = Document::with_id(DocumentId(74));
        let mut text = node(74, NodeKind::Text, None);
        text.text = "One\nTwo".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, text).unwrap();
        let properties = TextProperties {
            paragraph: ParagraphStyle {
                list_type: Some(TextListType::Ordered),
                ..TextProperties::default().paragraph
            },
            paragraph_style_runs: vec![ParagraphStyleRun {
                start: 4,
                indentation: None,
                list_type: Some(ParagraphListType::None),
                list_spacing: None,
                paragraph_spacing: None,
                paragraph_indent: None,
                line_height: None,
                line_height_unit: None,
                text_wrap_style: None,
            }],
            ..TextProperties::default()
        };
        document
            .seed_text_properties(NodeId(74), properties.clone())
            .unwrap();
        assert_eq!(
            snapshot_from_document(
                &document,
                PARAGRAPH_LIST_OPTIONS_ENGINE_SEMANTICS_VERSION - 1
            ),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, PARAGRAPH_LIST_OPTIONS_ENGINE_SEMANTICS_VERSION)
                .unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            74_u128.to_be_bytes(),
            hash,
            PARAGRAPH_LIST_OPTIONS_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.text_properties_for_node(NodeId(74)),
            Some(&properties)
        );

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = PARAGRAPH_LIST_OPTIONS_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                74_u128.to_be_bytes(),
                hash,
                PARAGRAPH_LIST_OPTIONS_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn paragraph_list_spacing_round_trips_and_requires_semantics_thirty_four() {
        let mut document = Document::with_id(DocumentId(75));
        let mut text = node(75, NodeKind::Text, None);
        text.text = "One\nTwo".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, text).unwrap();
        let properties = TextProperties {
            paragraph: ParagraphStyle {
                list_type: Some(TextListType::Ordered),
                list_spacing: Some(8.0),
                ..TextProperties::default().paragraph
            },
            paragraph_style_runs: vec![ParagraphStyleRun {
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
            ..TextProperties::default()
        };
        document
            .seed_text_properties(NodeId(75), properties.clone())
            .unwrap();
        assert_eq!(
            snapshot_from_document(
                &document,
                PARAGRAPH_LIST_SPACING_ENGINE_SEMANTICS_VERSION - 1
            ),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, PARAGRAPH_LIST_SPACING_ENGINE_SEMANTICS_VERSION)
                .unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            75_u128.to_be_bytes(),
            hash,
            PARAGRAPH_LIST_SPACING_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.text_properties_for_node(NodeId(75)),
            Some(&properties)
        );

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = PARAGRAPH_LIST_SPACING_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                75_u128.to_be_bytes(),
                hash,
                PARAGRAPH_LIST_SPACING_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn paragraph_spacing_round_trips_and_requires_semantics_thirty_five() {
        let mut document = Document::with_id(DocumentId(76));
        let mut text = node(76, NodeKind::Text, None);
        text.text = "One\nTwo".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, text).unwrap();
        let properties = TextProperties {
            paragraph: ParagraphStyle {
                paragraph_spacing: 8.0,
                ..TextProperties::default().paragraph
            },
            paragraph_style_runs: vec![ParagraphStyleRun {
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
            ..TextProperties::default()
        };
        document
            .seed_text_properties(NodeId(76), properties.clone())
            .unwrap();
        assert_eq!(
            snapshot_from_document(&document, PARAGRAPH_SPACING_ENGINE_SEMANTICS_VERSION - 1),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, PARAGRAPH_SPACING_ENGINE_SEMANTICS_VERSION).unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            76_u128.to_be_bytes(),
            hash,
            PARAGRAPH_SPACING_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.text_properties_for_node(NodeId(76)),
            Some(&properties)
        );

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = PARAGRAPH_SPACING_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                76_u128.to_be_bytes(),
                hash,
                PARAGRAPH_SPACING_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn paragraph_indent_run_round_trips_and_requires_semantics_thirty_six() {
        let mut document = Document::with_id(DocumentId(77));
        let mut text = node(77, NodeKind::Text, None);
        text.text = "One\nTwo".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, text).unwrap();
        let properties = TextProperties {
            paragraph: ParagraphStyle {
                paragraph_indent: Some(8.0),
                ..TextProperties::default().paragraph
            },
            paragraph_style_runs: vec![ParagraphStyleRun {
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
            ..TextProperties::default()
        };
        document
            .seed_text_properties(NodeId(77), properties.clone())
            .unwrap();
        assert_eq!(
            snapshot_from_document(&document, PARAGRAPH_INDENT_RUN_ENGINE_SEMANTICS_VERSION - 1),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, PARAGRAPH_INDENT_RUN_ENGINE_SEMANTICS_VERSION)
                .unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            77_u128.to_be_bytes(),
            hash,
            PARAGRAPH_INDENT_RUN_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.text_properties_for_node(NodeId(77)),
            Some(&properties)
        );

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = PARAGRAPH_INDENT_RUN_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                77_u128.to_be_bytes(),
                hash,
                PARAGRAPH_INDENT_RUN_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn paragraph_line_height_round_trips_and_requires_semantics_thirty_seven() {
        let mut document = Document::with_id(DocumentId(78));
        let mut text = node(78, NodeKind::Text, None);
        text.text = "One\nTwo".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, text).unwrap();
        let properties = TextProperties {
            paragraph_style_runs: vec![ParagraphStyleRun {
                start: 0,
                indentation: None,
                list_type: None,
                list_spacing: None,
                paragraph_spacing: None,
                paragraph_indent: None,
                line_height: Some(150.0),
                line_height_unit: Some(LineHeightUnit::Percent),
                text_wrap_style: None,
            }],
            ..TextProperties::default()
        };
        document
            .seed_text_properties(NodeId(78), properties.clone())
            .unwrap();
        assert_eq!(
            snapshot_from_document(
                &document,
                PARAGRAPH_LINE_HEIGHT_ENGINE_SEMANTICS_VERSION - 1
            ),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, PARAGRAPH_LINE_HEIGHT_ENGINE_SEMANTICS_VERSION)
                .unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            78_u128.to_be_bytes(),
            hash,
            PARAGRAPH_LINE_HEIGHT_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.text_properties_for_node(NodeId(78)),
            Some(&properties)
        );

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = PARAGRAPH_LINE_HEIGHT_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                78_u128.to_be_bytes(),
                hash,
                PARAGRAPH_LINE_HEIGHT_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn text_hanging_punctuation_round_trips_and_requires_semantics_thirty_eight() {
        let mut document = Document::with_id(DocumentId(79));
        let mut text = node(79, NodeKind::Text, None);
        text.text = "“Text.”".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, text).unwrap();
        let properties = TextProperties {
            paragraph: ParagraphStyle {
                hanging_punctuation: true,
                ..TextProperties::default().paragraph
            },
            ..TextProperties::default()
        };
        document
            .seed_text_properties(NodeId(79), properties.clone())
            .unwrap();
        assert_eq!(
            snapshot_from_document(
                &document,
                TEXT_HANGING_PUNCTUATION_ENGINE_SEMANTICS_VERSION - 1
            ),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, TEXT_HANGING_PUNCTUATION_ENGINE_SEMANTICS_VERSION)
                .unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            79_u128.to_be_bytes(),
            hash,
            TEXT_HANGING_PUNCTUATION_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.text_properties_for_node(NodeId(79)),
            Some(&properties)
        );

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = TEXT_HANGING_PUNCTUATION_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                79_u128.to_be_bytes(),
                hash,
                TEXT_HANGING_PUNCTUATION_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn paragraph_text_wrap_style_round_trips_and_requires_semantics_thirty_nine() {
        let mut document = Document::with_id(DocumentId(80));
        let mut text = node(80, NodeKind::Text, None);
        text.text = "One\nTwo".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, text).unwrap();
        let properties = TextProperties {
            paragraph: ParagraphStyle {
                text_wrap_style: Some(TextWrapStyle::Balance),
                ..TextProperties::default().paragraph
            },
            paragraph_style_runs: vec![ParagraphStyleRun {
                start: 4,
                indentation: None,
                list_type: None,
                list_spacing: None,
                paragraph_spacing: None,
                paragraph_indent: None,
                line_height: None,
                line_height_unit: None,
                text_wrap_style: Some(TextWrapStyle::Auto),
            }],
            ..TextProperties::default()
        };
        document
            .seed_text_properties(NodeId(80), properties.clone())
            .unwrap();
        assert_eq!(
            snapshot_from_document(
                &document,
                PARAGRAPH_TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION - 1
            ),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot = snapshot_from_document(
            &document,
            PARAGRAPH_TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            80_u128.to_be_bytes(),
            hash,
            PARAGRAPH_TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.text_properties_for_node(NodeId(80)),
            Some(&properties)
        );

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version =
            PARAGRAPH_TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                80_u128.to_be_bytes(),
                hash,
                PARAGRAPH_TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn text_hanging_list_round_trips_and_requires_semantics_thirty_two() {
        let mut document = Document::with_id(DocumentId(73));
        let mut text = node(73, NodeKind::Text, None);
        text.text = "One\nTwo".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, text).unwrap();
        let properties = TextProperties {
            paragraph: ParagraphStyle {
                list_type: Some(TextListType::Ordered),
                hanging_list: true,
                hanging_punctuation: false,
                ..TextProperties::default().paragraph
            },
            ..TextProperties::default()
        };
        document
            .seed_text_properties(NodeId(73), properties.clone())
            .unwrap();
        assert_eq!(
            snapshot_from_document(&document, TEXT_HANGING_LIST_ENGINE_SEMANTICS_VERSION - 1),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, TEXT_HANGING_LIST_ENGINE_SEMANTICS_VERSION).unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            73_u128.to_be_bytes(),
            hash,
            TEXT_HANGING_LIST_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            restored.text_properties_for_node(NodeId(73)),
            Some(&properties)
        );

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = TEXT_HANGING_LIST_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                73_u128.to_be_bytes(),
                hash,
                TEXT_HANGING_LIST_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn localized_font_aliases_round_trip_and_require_semantics_forty_one() {
        let mut document = Document::with_id(DocumentId(74));
        let asset = AssetReference {
            asset_id: AssetId(74),
            content_hash: [7; 32],
            media_type: "font/ttf".into(),
            byte_length: 512,
            dimensions: None,
            font_faces: vec![editor_core::FontFaceMetadata {
                face_index: 0,
                family: "Acme Sans".into(),
                style: "Regular".into(),
                aliases: vec![editor_core::FontNameAlias {
                    family: "思源黑体".into(),
                    style: "常规".into(),
                }],
            }],
        };
        document.seed_asset(asset.clone()).unwrap();
        assert_eq!(
            snapshot_from_document(&document, FONT_NAME_ALIASES_ENGINE_SEMANTICS_VERSION - 1),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, FONT_NAME_ALIASES_ENGINE_SEMANTICS_VERSION).unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            74_u128.to_be_bytes(),
            hash,
            FONT_NAME_ALIASES_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(restored.asset(AssetId(74)), Some(&asset));

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = FONT_NAME_ALIASES_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                74_u128.to_be_bytes(),
                hash,
                FONT_NAME_ALIASES_ENGINE_SEMANTICS_VERSION,
            ),
            Err(SnapshotError::Invalid)
        );
    }

    #[test]
    fn variable_catalog_round_trips_and_requires_semantics_forty_eight() {
        let mut document = Document::with_id(DocumentId(920));
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
        document
            .seed_variable_collection(collection.clone())
            .unwrap();
        let variable = VariableResource {
            id: "V:surface".into(),
            key: String::new(),
            name: "Surface".into(),
            description: "Canvas".into(),
            remote: false,
            hidden_from_publishing: false,
            collection_id: collection.id.clone(),
            resolved_type: VariableResolvedType::Color,
            values_by_mode: [(
                "light".into(),
                VariableValue::Color(
                    Color::new(ColorSpace::DisplayP3, [1.0, 0.5, 0.0], 0.75).unwrap(),
                ),
            )]
            .into(),
            scopes: vec!["ALL_FILLS".into()],
            code_syntax: BTreeMap::new(),
        };
        document.seed_variable(variable.clone()).unwrap();
        document.validate_variable_catalog().unwrap();
        assert_eq!(
            snapshot_from_document(&document, VARIABLE_CATALOG_ENGINE_SEMANTICS_VERSION - 1),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let hash = document.canonical_hash();
        let snapshot =
            snapshot_from_document(&document, VARIABLE_CATALOG_ENGINE_SEMANTICS_VERSION).unwrap();
        let restored = document_from_snapshot_with_engine_semantics(
            &snapshot,
            920_u128.to_be_bytes(),
            hash,
            VARIABLE_CATALOG_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(restored.variable_collection("VC:theme"), Some(&collection));
        assert_eq!(restored.variable("V:surface"), Some(&variable));

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = VARIABLE_CATALOG_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled.encode_to_vec(),
                920_u128.to_be_bytes(),
                hash,
                VARIABLE_CATALOG_ENGINE_SEMANTICS_VERSION
            ),
            Err(SnapshotError::Invalid)
        );

        let mut syntax_document = Document::with_id(DocumentId(921));
        syntax_document
            .seed_variable_collection(collection.clone())
            .unwrap();
        let mut syntax_variable = variable.clone();
        syntax_variable
            .code_syntax
            .insert("WEB".into(), "--surface".into());
        syntax_document
            .seed_variable(syntax_variable.clone())
            .unwrap();
        assert_eq!(
            snapshot_from_document(
                &syntax_document,
                VARIABLE_CODE_SYNTAX_ENGINE_SEMANTICS_VERSION - 1
            ),
            Err(SnapshotError::UnsupportedEngineSemantics)
        );
        let syntax_hash = syntax_document.canonical_hash();
        let syntax_snapshot = snapshot_from_document(
            &syntax_document,
            VARIABLE_CODE_SYNTAX_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        let syntax_restored = document_from_snapshot_with_engine_semantics(
            &syntax_snapshot,
            921_u128.to_be_bytes(),
            syntax_hash,
            VARIABLE_CODE_SYNTAX_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        assert_eq!(
            syntax_restored.variable("V:surface"),
            Some(&syntax_variable)
        );
        let mut mislabeled_syntax =
            v1::DocumentSnapshot::decode(syntax_snapshot.as_slice()).unwrap();
        mislabeled_syntax.engine_semantics_version =
            VARIABLE_CODE_SYNTAX_ENGINE_SEMANTICS_VERSION - 1;
        assert_eq!(
            document_from_snapshot_with_engine_semantics(
                &mislabeled_syntax.encode_to_vec(),
                921_u128.to_be_bytes(),
                syntax_hash,
                VARIABLE_CODE_SYNTAX_ENGINE_SEMANTICS_VERSION
            ),
            Err(SnapshotError::Invalid)
        );
    }
}
