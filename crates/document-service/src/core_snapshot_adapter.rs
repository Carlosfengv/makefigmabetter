//! Protobuf snapshot ↔ canonical editor-core adapter used only by Document Service.

use std::collections::{BTreeMap, HashMap, HashSet};

use editor_core::{
    ActorId, ArcData, AssetId, AssetReference, AutoLayout, BackgroundBlur, BlendMode,
    BooleanOperation, Command, ConstraintType, Constraints, Document, DocumentId, DropShadow,
    Effect, EffectStyleResource, FillRule, FontFaceMetadata, FontNameAlias, FontReference,
    GridAutoTracks, GridChildAlignment, GridItemsPositioning, GridStyleResource, GridTrack,
    HyperlinkTarget, HyperlinkType, InnerShadow, LayerBlur, LayoutAlignment, LayoutGrid,
    LayoutGridAlignment, LayoutGridPattern, LayoutMode, LayoutSizing, LeadingTrim, LineHeightUnit,
    Node, NodeId, NodeKind, OpenTypeFeature, Page, PageId, PaintStyleLinks, PaintStyleResource,
    PaintStyleVariableBinding, ParagraphListType, ParagraphStyle, ParagraphStyleRun,
    ParametricShape, PointId, PositionId, StrokeAlign, StrokeCap, StrokeJoin, TextAlign,
    TextAutoSize, TextCase, TextDecoration, TextDecorationColor, TextDecorationOffset,
    TextDecorationStyle, TextDecorationThickness, TextListType, TextProperties,
    TextStyleLetterSpacingUnit, TextStyleResource, TextStyleRun, TextTruncation, TextWrapStyle,
    VariableCollectionResource, VariableMode, VariableResolvedType, VariableResource,
    VariableValue, VectorPath, VectorPoint, VectorPointType, VectorSubpath, WrapTrackAlignment,
    color::{
        Color, ColorSpace, DocumentColorProfile, GradientPaint, GradientPaintKind, GradientStop,
        ImageFilters, ImagePaint, ImageScaleMode, LinearGradient, Paint, PaintLayer,
        PaintLayerKind, PaintStack,
    },
};
use makefigma_protocol::v1;
use prost::Message;
use sha2::Digest;

use crate::{
    CanonicalReducer, DocumentState, Hash, Id, ReducedDocument, ReductionInput, ServiceError,
    operation_adapter::commands_from_payload_with_semantics,
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
        let mut document = makefigma_document_codec::document_from_snapshot_with_engine_semantics(
            &current.snapshot,
            current.document_id,
            current.document_hash,
            self.engine_semantics_version,
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
        let commands = commands_from_payload_with_semantics(
            &input.operation.payload,
            self.engine_semantics_version,
        )?;
        if self.engine_semantics_version
            < makefigma_document_codec::SHAPE_WITH_TEXT_TEXT_ENGINE_SEMANTICS_VERSION
            && commands_require_shape_with_text_text_semantics(&document, &commands)
        {
            return Err(ServiceError::EngineSemanticsUnsupported {
                minimum: makefigma_document_codec::SHAPE_WITH_TEXT_TEXT_ENGINE_SEMANTICS_VERSION,
            });
        }
        if self.engine_semantics_version
            < makefigma_document_codec::TEXT_RUN_PAINT_STACK_ENGINE_SEMANTICS_VERSION
            && commands.iter().any(command_has_text_run_paint_stack)
        {
            return Err(ServiceError::EngineSemanticsUnsupported {
                minimum: makefigma_document_codec::TEXT_RUN_PAINT_STACK_ENGINE_SEMANTICS_VERSION,
            });
        }
        if self.engine_semantics_version
            < makefigma_document_codec::TEXT_BASE_STYLE_ENGINE_SEMANTICS_VERSION
            && commands.iter().any(command_has_text_base_style)
        {
            return Err(ServiceError::EngineSemanticsUnsupported {
                minimum: makefigma_document_codec::TEXT_BASE_STYLE_ENGINE_SEMANTICS_VERSION,
            });
        }
        if self.engine_semantics_version
            < makefigma_document_codec::TEXT_CASE_ENGINE_SEMANTICS_VERSION
            && commands.iter().any(command_has_text_case)
        {
            return Err(ServiceError::EngineSemanticsUnsupported {
                minimum: makefigma_document_codec::TEXT_CASE_ENGINE_SEMANTICS_VERSION,
            });
        }
        if self.engine_semantics_version
            < makefigma_document_codec::TEXT_PATH_ENGINE_SEMANTICS_VERSION
            && commands_require_text_path_semantics(&document, &commands)
        {
            return Err(ServiceError::EngineSemanticsUnsupported {
                minimum: makefigma_document_codec::TEXT_PATH_ENGINE_SEMANTICS_VERSION,
            });
        }
        if self.engine_semantics_version
            < makefigma_document_codec::LINE_HEIGHT_UNIT_ENGINE_SEMANTICS_VERSION
            && commands.iter().any(command_has_line_height_unit)
        {
            return Err(ServiceError::EngineSemanticsUnsupported {
                minimum: makefigma_document_codec::LINE_HEIGHT_UNIT_ENGINE_SEMANTICS_VERSION,
            });
        }
        if self.engine_semantics_version
            < makefigma_document_codec::PARAGRAPH_INDENT_ENGINE_SEMANTICS_VERSION
            && commands.iter().any(command_has_paragraph_indent)
        {
            return Err(ServiceError::EngineSemanticsUnsupported {
                minimum: makefigma_document_codec::PARAGRAPH_INDENT_ENGINE_SEMANTICS_VERSION,
            });
        }
        if self.engine_semantics_version
            < makefigma_document_codec::TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION
            && commands.iter().any(command_has_text_wrap_style)
        {
            return Err(ServiceError::EngineSemanticsUnsupported {
                minimum: makefigma_document_codec::TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION,
            });
        }
        if self.engine_semantics_version
            < makefigma_document_codec::TEXT_LIST_TYPE_ENGINE_SEMANTICS_VERSION
            && commands.iter().any(command_has_list_type)
        {
            return Err(ServiceError::EngineSemanticsUnsupported {
                minimum: makefigma_document_codec::TEXT_LIST_TYPE_ENGINE_SEMANTICS_VERSION,
            });
        }
        if self.engine_semantics_version
            < makefigma_document_codec::TEXT_LIST_SPACING_ENGINE_SEMANTICS_VERSION
            && commands.iter().any(command_has_list_spacing)
        {
            return Err(ServiceError::EngineSemanticsUnsupported {
                minimum: makefigma_document_codec::TEXT_LIST_SPACING_ENGINE_SEMANTICS_VERSION,
            });
        }
        if self.engine_semantics_version
            < makefigma_document_codec::PARAGRAPH_STYLE_RUNS_ENGINE_SEMANTICS_VERSION
            && commands.iter().any(command_has_paragraph_style_runs)
        {
            return Err(ServiceError::EngineSemanticsUnsupported {
                minimum: makefigma_document_codec::PARAGRAPH_STYLE_RUNS_ENGINE_SEMANTICS_VERSION,
            });
        }
        if self.engine_semantics_version
            < makefigma_document_codec::TEXT_HANGING_LIST_ENGINE_SEMANTICS_VERSION
            && commands.iter().any(command_has_hanging_list)
        {
            return Err(ServiceError::EngineSemanticsUnsupported {
                minimum: makefigma_document_codec::TEXT_HANGING_LIST_ENGINE_SEMANTICS_VERSION,
            });
        }
        if self.engine_semantics_version
            < makefigma_document_codec::PARAGRAPH_LIST_OPTIONS_ENGINE_SEMANTICS_VERSION
            && commands.iter().any(command_has_paragraph_list_options)
        {
            return Err(ServiceError::EngineSemanticsUnsupported {
                minimum: makefigma_document_codec::PARAGRAPH_LIST_OPTIONS_ENGINE_SEMANTICS_VERSION,
            });
        }
        if self.engine_semantics_version
            < makefigma_document_codec::PARAGRAPH_LIST_SPACING_ENGINE_SEMANTICS_VERSION
            && commands.iter().any(command_has_paragraph_list_spacing)
        {
            return Err(ServiceError::EngineSemanticsUnsupported {
                minimum: makefigma_document_codec::PARAGRAPH_LIST_SPACING_ENGINE_SEMANTICS_VERSION,
            });
        }
        if self.engine_semantics_version
            < makefigma_document_codec::PARAGRAPH_SPACING_ENGINE_SEMANTICS_VERSION
            && commands.iter().any(command_has_paragraph_spacing)
        {
            return Err(ServiceError::EngineSemanticsUnsupported {
                minimum: makefigma_document_codec::PARAGRAPH_SPACING_ENGINE_SEMANTICS_VERSION,
            });
        }
        if self.engine_semantics_version
            < makefigma_document_codec::PARAGRAPH_INDENT_RUN_ENGINE_SEMANTICS_VERSION
            && commands.iter().any(command_has_paragraph_indent_run)
        {
            return Err(ServiceError::EngineSemanticsUnsupported {
                minimum: makefigma_document_codec::PARAGRAPH_INDENT_RUN_ENGINE_SEMANTICS_VERSION,
            });
        }
        if self.engine_semantics_version
            < makefigma_document_codec::PARAGRAPH_LINE_HEIGHT_ENGINE_SEMANTICS_VERSION
            && commands.iter().any(command_has_paragraph_line_height)
        {
            return Err(ServiceError::EngineSemanticsUnsupported {
                minimum: makefigma_document_codec::PARAGRAPH_LINE_HEIGHT_ENGINE_SEMANTICS_VERSION,
            });
        }
        if self.engine_semantics_version
            < makefigma_document_codec::TEXT_HANGING_PUNCTUATION_ENGINE_SEMANTICS_VERSION
            && commands.iter().any(command_has_hanging_punctuation)
        {
            return Err(ServiceError::EngineSemanticsUnsupported {
                minimum:
                    makefigma_document_codec::TEXT_HANGING_PUNCTUATION_ENGINE_SEMANTICS_VERSION,
            });
        }
        if self.engine_semantics_version
            < makefigma_document_codec::PARAGRAPH_TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION
            && commands.iter().any(command_has_paragraph_text_wrap_style)
        {
            return Err(ServiceError::EngineSemanticsUnsupported {
                minimum:
                    makefigma_document_codec::PARAGRAPH_TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION,
            });
        }
        if self.engine_semantics_version
            < makefigma_document_codec::TEXT_HYPERLINK_ENGINE_SEMANTICS_VERSION
            && commands.iter().any(command_has_hyperlink)
        {
            return Err(ServiceError::EngineSemanticsUnsupported {
                minimum: makefigma_document_codec::TEXT_HYPERLINK_ENGINE_SEMANTICS_VERSION,
            });
        }
        if self.engine_semantics_version
            < makefigma_document_codec::TEXT_DECORATION_ENGINE_SEMANTICS_VERSION
            && commands.iter().any(command_has_text_decoration)
        {
            return Err(ServiceError::EngineSemanticsUnsupported {
                minimum: makefigma_document_codec::TEXT_DECORATION_ENGINE_SEMANTICS_VERSION,
            });
        }
        if self.engine_semantics_version
            < makefigma_document_codec::TEXT_DECORATION_STYLE_ENGINE_SEMANTICS_VERSION
            && commands.iter().any(command_has_text_decoration_style)
        {
            return Err(ServiceError::EngineSemanticsUnsupported {
                minimum: makefigma_document_codec::TEXT_DECORATION_STYLE_ENGINE_SEMANTICS_VERSION,
            });
        }
        if self.engine_semantics_version
            < makefigma_document_codec::TEXT_DECORATION_OFFSET_ENGINE_SEMANTICS_VERSION
            && commands.iter().any(command_has_text_decoration_offset)
        {
            return Err(ServiceError::EngineSemanticsUnsupported {
                minimum: makefigma_document_codec::TEXT_DECORATION_OFFSET_ENGINE_SEMANTICS_VERSION,
            });
        }
        if self.engine_semantics_version
            < makefigma_document_codec::TEXT_DECORATION_THICKNESS_ENGINE_SEMANTICS_VERSION
            && commands.iter().any(command_has_text_decoration_thickness)
        {
            return Err(ServiceError::EngineSemanticsUnsupported {
                minimum:
                    makefigma_document_codec::TEXT_DECORATION_THICKNESS_ENGINE_SEMANTICS_VERSION,
            });
        }
        if self.engine_semantics_version
            < makefigma_document_codec::TEXT_DECORATION_COLOR_ENGINE_SEMANTICS_VERSION
            && commands.iter().any(command_has_text_decoration_color)
        {
            return Err(ServiceError::EngineSemanticsUnsupported {
                minimum: makefigma_document_codec::TEXT_DECORATION_COLOR_ENGINE_SEMANTICS_VERSION,
            });
        }
        if self.engine_semantics_version
            < makefigma_document_codec::TEXT_DECORATION_COLOR_VARIABLE_ENGINE_SEMANTICS_VERSION
            && commands
                .iter()
                .any(command_has_text_decoration_color_variable)
        {
            return Err(ServiceError::EngineSemanticsUnsupported {
                minimum:
                    makefigma_document_codec::TEXT_DECORATION_COLOR_VARIABLE_ENGINE_SEMANTICS_VERSION,
            });
        }
        if self.engine_semantics_version
            < makefigma_document_codec::TEXT_DECORATION_SKIP_INK_ENGINE_SEMANTICS_VERSION
            && commands.iter().any(command_has_text_decoration_skip_ink)
        {
            return Err(ServiceError::EngineSemanticsUnsupported {
                minimum:
                    makefigma_document_codec::TEXT_DECORATION_SKIP_INK_ENGINE_SEMANTICS_VERSION,
            });
        }
        if self.engine_semantics_version
            < makefigma_document_codec::LEADING_TRIM_ENGINE_SEMANTICS_VERSION
            && commands.iter().any(command_has_leading_trim)
        {
            return Err(ServiceError::EngineSemanticsUnsupported {
                minimum: makefigma_document_codec::LEADING_TRIM_ENGINE_SEMANTICS_VERSION,
            });
        }
        if self.engine_semantics_version
            < makefigma_document_codec::OPEN_TYPE_FEATURES_ENGINE_SEMANTICS_VERSION
            && commands.iter().any(command_has_open_type_features)
        {
            return Err(ServiceError::EngineSemanticsUnsupported {
                minimum: makefigma_document_codec::OPEN_TYPE_FEATURES_ENGINE_SEMANTICS_VERSION,
            });
        }
        if self.engine_semantics_version
            < makefigma_document_codec::TEXT_STYLE_LINK_ENGINE_SEMANTICS_VERSION
            && commands.iter().any(command_has_text_style_link)
        {
            return Err(ServiceError::EngineSemanticsUnsupported {
                minimum: makefigma_document_codec::TEXT_STYLE_LINK_ENGINE_SEMANTICS_VERSION,
            });
        }
        if self.engine_semantics_version
            < makefigma_document_codec::TEXT_PAINT_STYLE_LINK_ENGINE_SEMANTICS_VERSION
            && commands.iter().any(command_has_paint_style_link)
        {
            return Err(ServiceError::EngineSemanticsUnsupported {
                minimum: makefigma_document_codec::TEXT_PAINT_STYLE_LINK_ENGINE_SEMANTICS_VERSION,
            });
        }
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

fn commands_require_shape_with_text_text_semantics(
    document: &Document,
    commands: &[Command],
) -> bool {
    let created_kinds = commands
        .iter()
        .filter_map(|command| match command {
            Command::Create(node) | Command::CreateInPage { node, .. } => {
                Some((node.id, &node.kind))
            }
            Command::CreateImageInPage { node, .. } => Some((node.id, &node.kind)),
            Command::RestoreNode { node, .. } => Some((node.id, &node.kind)),
            _ => None,
        })
        .collect::<HashMap<_, _>>();
    commands.iter().any(|command| match command {
        Command::SetTextProperties { id, .. } => {
            created_kinds
                .get(id)
                .is_some_and(|kind| **kind == NodeKind::ShapeWithText)
                || document
                    .node(*id)
                    .is_some_and(|node| node.kind == NodeKind::ShapeWithText)
        }
        Command::RestoreNode {
            node,
            text_properties,
            ..
        } => node.kind == NodeKind::ShapeWithText && text_properties.is_some(),
        _ => false,
    })
}

fn commands_require_text_path_semantics(document: &Document, commands: &[Command]) -> bool {
    let created_text_paths = commands
        .iter()
        .filter_map(|command| match command {
            Command::Create(node) | Command::CreateInPage { node, .. }
                if node.kind == NodeKind::TextPath =>
            {
                Some(node.id)
            }
            Command::RestoreNode { node, .. } if node.kind == NodeKind::TextPath => Some(node.id),
            _ => None,
        })
        .collect::<std::collections::HashSet<_>>();
    commands.iter().any(|command| match command {
        Command::ConvertToTextPath { .. } => true,
        Command::SetTextProperties { id, .. } => {
            created_text_paths.contains(id)
                || document
                    .node(*id)
                    .is_some_and(|node| node.kind == NodeKind::TextPath)
        }
        Command::RestoreNode {
            node,
            text_properties,
            ..
        } => node.kind == NodeKind::TextPath && text_properties.is_some(),
        _ => false,
    })
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
    if engine_semantics_version
        < makefigma_document_codec::TEXT_DECORATION_COLOR_VARIABLE_ENGINE_SEMANTICS_VERSION
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
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::GRID_CONTAINER_HUG_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            let layout = document.auto_layout_for_node(node.id);
            layout.mode == LayoutMode::Grid
                && (layout.primary_sizing == LayoutSizing::Hug
                    || layout.counter_sizing == LayoutSizing::Hug)
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::GRID_CHILD_ALIGNMENT_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            let layout = document.auto_layout_for_node(node.id);
            layout.grid_child_horizontal_align != GridChildAlignment::Auto
                || layout.grid_child_vertical_align != GridChildAlignment::Auto
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version < makefigma_document_codec::GRID_AUTO_ROWS_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document.auto_layout_for_node(node.id).grid_auto_tracks == GridAutoTracks::Rows
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::GRID_MANUAL_PLACEMENT_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            let layout = document.auto_layout_for_node(node.id);
            layout.grid_items_positioning == GridItemsPositioning::Manual
                || layout.grid_row_anchor.is_some()
                || layout.grid_column_anchor.is_some()
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version < makefigma_document_codec::GRID_SPAN_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            let layout = document.auto_layout_for_node(node.id);
            layout.grid_row_span.is_some() || layout.grid_column_span.is_some()
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version < makefigma_document_codec::GRID_HUG_TRACK_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            let layout = document.auto_layout_for_node(node.id);
            layout
                .grid_rows
                .iter()
                .chain(&layout.grid_columns)
                .any(|track| matches!(track, GridTrack::Hug))
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::GRID_AUTO_LAYOUT_ENGINE_SEMANTICS_VERSION
        && document
            .nodes()
            .any(|node| document.auto_layout_for_node(node.id).mode == LayoutMode::Grid)
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::PAINT_STYLE_VARIABLE_BINDINGS_ENGINE_SEMANTICS_VERSION
        && document
            .paint_styles()
            .any(|style| !style.variable_bindings.is_empty())
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::TEXT_STYLE_VARIABLE_BINDINGS_ENGINE_SEMANTICS_VERSION
        && document
            .text_styles()
            .any(|style| !style.variable_bindings.is_empty())
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::TEXT_STYLE_PERCENT_LETTER_SPACING_ENGINE_SEMANTICS_VERSION
        && document
            .text_styles()
            .any(|style| style.letter_spacing_unit == Some(TextStyleLetterSpacingUnit::Percent))
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::STYLE_PUBLISHABLE_METADATA_ENGINE_SEMANTICS_VERSION
        && (document.text_styles().any(|style| {
            !style.description_markdown.is_empty() || !style.documentation_links.is_empty()
        }) || document.paint_styles().any(|style| {
            !style.description_markdown.is_empty() || !style.documentation_links.is_empty()
        }))
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::TEXT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION
        && document.text_styles().next().is_some()
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::PAINT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION
        && document.paint_styles().next().is_some()
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::EFFECT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION
        && document.effect_styles().next().is_some()
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::GRID_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION
        && document.grid_styles().next().is_some()
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::VARIABLE_CATALOG_ENGINE_SEMANTICS_VERSION
        && (document.variable_collections().next().is_some()
            || document.variables().next().is_some())
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::PAINT_STYLE_LINK_ENGINE_SEMANTICS_VERSION
        && document
            .nodes()
            .any(|node| document.paint_style_links_for_node(node.id).is_some())
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::FONT_FACE_METADATA_ENGINE_SEMANTICS_VERSION
        && document.assets().any(|asset| !asset.font_faces.is_empty())
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::FONT_NAME_ALIASES_ENGINE_SEMANTICS_VERSION
        && document
            .assets()
            .any(|asset| asset.font_faces.iter().any(|face| !face.aliases.is_empty()))
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version < makefigma_document_codec::PAINT_STACK_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document.fill_stack_for_node(node.id).is_some()
                || document.stroke_stack_for_node(node.id).is_some()
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::NON_LINEAR_GRADIENT_ENGINE_SEMANTICS_VERSION
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
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::TEXT_RUN_PAINT_STACK_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_fill_stack)
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version < makefigma_document_codec::TEXT_BASE_STYLE_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_base_style)
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version < makefigma_document_codec::TEXT_CASE_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_text_case)
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::LINE_HEIGHT_UNIT_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_line_height_unit)
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::PARAGRAPH_INDENT_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_paragraph_indent)
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version < makefigma_document_codec::TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_text_wrap_style)
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version < makefigma_document_codec::TEXT_LIST_TYPE_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_list_type)
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::TEXT_LIST_SPACING_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_list_spacing)
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::PARAGRAPH_STYLE_RUNS_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_paragraph_style_runs)
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::TEXT_HANGING_LIST_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_hanging_list)
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::PARAGRAPH_LIST_OPTIONS_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_paragraph_list_options)
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::PARAGRAPH_LIST_SPACING_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_paragraph_list_spacing)
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::PARAGRAPH_SPACING_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_paragraph_spacing)
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::PARAGRAPH_INDENT_RUN_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_paragraph_indent_run)
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::PARAGRAPH_LINE_HEIGHT_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_paragraph_line_height)
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::TEXT_HANGING_PUNCTUATION_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_hanging_punctuation)
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::PARAGRAPH_TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_paragraph_text_wrap_style)
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version < makefigma_document_codec::TEXT_HYPERLINK_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_hyperlink)
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version < makefigma_document_codec::TEXT_DECORATION_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_text_decoration)
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::TEXT_DECORATION_STYLE_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_text_decoration_style)
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::TEXT_DECORATION_OFFSET_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_text_decoration_offset)
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::TEXT_DECORATION_THICKNESS_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_text_decoration_thickness)
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::TEXT_DECORATION_COLOR_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_text_decoration_color)
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::TEXT_DECORATION_SKIP_INK_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_text_decoration_skip_ink)
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version < makefigma_document_codec::LEADING_TRIM_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_leading_trim)
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::OPEN_TYPE_FEATURES_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_open_type_features)
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version < makefigma_document_codec::TEXT_STYLE_LINK_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_text_style_link)
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::TEXT_PAINT_STYLE_LINK_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_paint_style_link)
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version < makefigma_document_codec::ADVANCED_BLEND_ENGINE_SEMANTICS_VERSION
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
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::IMAGE_PAINT_ROTATION_ENGINE_SEMANTICS_VERSION
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
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version < makefigma_document_codec::PASS_THROUGH_ENGINE_SEMANTICS_VERSION
        && document
            .nodes()
            .any(|node| node.blend_mode.requires_pass_through_semantics())
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version < makefigma_document_codec::LINEAR_BLEND_ENGINE_SEMANTICS_VERSION
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
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::NORMAL_BLEND_ISOLATION_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            node.extensions
                .get(makefigma_document_codec::NORMAL_BLEND_ISOLATION_EXTENSION)
                .is_some_and(|value| value.as_slice() == [1])
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version < makefigma_document_codec::IMAGE_FILTERS_ENGINE_SEMANTICS_VERSION
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
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version < makefigma_document_codec::TEXT_TRUNCATION_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            document
                .text_properties_for_node(node.id)
                .is_some_and(text_properties_has_truncation)
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if engine_semantics_version
        < makefigma_document_codec::SHAPE_WITH_TEXT_TEXT_ENGINE_SEMANTICS_VERSION
        && document.nodes().any(|node| {
            node.kind == NodeKind::ShapeWithText
                && document.text_properties_for_node(node.id).is_some()
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
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
                        document.fill_stack_for_node(node.id),
                        document.stroke_stack_for_node(node.id),
                        document.paint_style_links_for_node(node.id),
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
        grid_styles: document
            .grid_styles()
            .map(grid_style_resource_to_proto)
            .collect(),
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
    if snapshot.engine_semantics_version
        > makefigma_document_codec::CURRENT_ENGINE_SEMANTICS_VERSION
    {
        return Err(ServiceError::EngineSemanticsUnsupported {
            minimum: snapshot.engine_semantics_version,
        });
    }
    let declared_engine_semantics_version = snapshot.engine_semantics_version;
    if declared_engine_semantics_version
        < makefigma_document_codec::GRID_CONTAINER_HUG_ENGINE_SEMANTICS_VERSION
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
        return Err(ServiceError::ReducerRejected);
    }
    if declared_engine_semantics_version
        < makefigma_document_codec::GRID_CHILD_ALIGNMENT_ENGINE_SEMANTICS_VERSION
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
        return Err(ServiceError::ReducerRejected);
    }
    if declared_engine_semantics_version
        < makefigma_document_codec::GRID_AUTO_ROWS_ENGINE_SEMANTICS_VERSION
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
        return Err(ServiceError::ReducerRejected);
    }
    if declared_engine_semantics_version
        < makefigma_document_codec::GRID_MANUAL_PLACEMENT_ENGINE_SEMANTICS_VERSION
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
        return Err(ServiceError::ReducerRejected);
    }
    if declared_engine_semantics_version
        < makefigma_document_codec::GRID_SPAN_ENGINE_SEMANTICS_VERSION
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
        return Err(ServiceError::ReducerRejected);
    }
    if declared_engine_semantics_version
        < makefigma_document_codec::GRID_HUG_TRACK_ENGINE_SEMANTICS_VERSION
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
        return Err(ServiceError::ReducerRejected);
    }
    if declared_engine_semantics_version
        < makefigma_document_codec::GRID_AUTO_LAYOUT_ENGINE_SEMANTICS_VERSION
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
        return Err(ServiceError::ReducerRejected);
    }
    let mut document = Document::with_id(DocumentId(id(&snapshot.document_id)?));
    document.seed_color_profile(profile_from_proto(snapshot.document_color_profile)?);
    for asset in snapshot.resource_index {
        if declared_engine_semantics_version
            < makefigma_document_codec::FONT_FACE_METADATA_ENGINE_SEMANTICS_VERSION
            && !asset.font_faces.is_empty()
        {
            return Err(ServiceError::ReducerRejected);
        }
        if declared_engine_semantics_version
            < makefigma_document_codec::FONT_NAME_ALIASES_ENGINE_SEMANTICS_VERSION
            && asset.font_faces.iter().any(|face| !face.aliases.is_empty())
        {
            return Err(ServiceError::ReducerRejected);
        }
        document
            .seed_asset(asset_from_proto(asset)?)
            .map_err(|_| ServiceError::ReducerRejected)?;
    }
    if declared_engine_semantics_version
        < makefigma_document_codec::TEXT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION
        && !snapshot.text_styles.is_empty()
    {
        return Err(ServiceError::ReducerRejected);
    }
    if declared_engine_semantics_version
        < makefigma_document_codec::STYLE_PUBLISHABLE_METADATA_ENGINE_SEMANTICS_VERSION
        && (snapshot.text_styles.iter().any(|style| {
            !style.description_markdown.is_empty() || !style.documentation_links.is_empty()
        }) || snapshot.paint_styles.iter().any(|style| {
            !style.description_markdown.is_empty() || !style.documentation_links.is_empty()
        }))
    {
        return Err(ServiceError::ReducerRejected);
    }
    if declared_engine_semantics_version
        < makefigma_document_codec::TEXT_STYLE_PERCENT_LETTER_SPACING_ENGINE_SEMANTICS_VERSION
        && snapshot.text_styles.iter().any(|style| {
            style.letter_spacing_unit == Some(v1::TextStyleLetterSpacingUnit::Percent as i32)
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if declared_engine_semantics_version
        < makefigma_document_codec::TEXT_STYLE_VARIABLE_BINDINGS_ENGINE_SEMANTICS_VERSION
        && snapshot
            .text_styles
            .iter()
            .any(|style| !style.variable_bindings.is_empty())
    {
        return Err(ServiceError::ReducerRejected);
    }
    if declared_engine_semantics_version
        < makefigma_document_codec::TEXT_DECORATION_COLOR_VARIABLE_ENGINE_SEMANTICS_VERSION
        && snapshot.text_styles.iter().any(|style| {
            style
                .style
                .as_ref()
                .and_then(|run| run.text_decoration_color.as_ref())
                .is_some_and(|color| color.variable_id.is_some())
        })
    {
        return Err(ServiceError::ReducerRejected);
    }
    if declared_engine_semantics_version
        < makefigma_document_codec::PAINT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION
        && !snapshot.paint_styles.is_empty()
    {
        return Err(ServiceError::ReducerRejected);
    }
    if declared_engine_semantics_version
        < makefigma_document_codec::EFFECT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION
        && !snapshot.effect_styles.is_empty()
    {
        return Err(ServiceError::ReducerRejected);
    }
    if declared_engine_semantics_version
        < makefigma_document_codec::GRID_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION
        && !snapshot.grid_styles.is_empty()
    {
        return Err(ServiceError::ReducerRejected);
    }
    if declared_engine_semantics_version
        < makefigma_document_codec::PAINT_STYLE_VARIABLE_BINDINGS_ENGINE_SEMANTICS_VERSION
        && snapshot
            .paint_styles
            .iter()
            .any(|style| !style.variable_bindings.is_empty())
    {
        return Err(ServiceError::ReducerRejected);
    }
    if declared_engine_semantics_version
        < makefigma_document_codec::VARIABLE_CATALOG_ENGINE_SEMANTICS_VERSION
        && (!snapshot.variable_collections.is_empty() || !snapshot.variables.is_empty())
    {
        return Err(ServiceError::ReducerRejected);
    }
    for collection in snapshot.variable_collections {
        document
            .seed_variable_collection(variable_collection_from_proto(collection)?)
            .map_err(|_| ServiceError::ReducerRejected)?;
    }
    for variable in snapshot.variables {
        document
            .seed_variable(variable_resource_from_proto(variable)?)
            .map_err(|_| ServiceError::ReducerRejected)?;
    }
    document
        .validate_variable_catalog()
        .map_err(|_| ServiceError::ReducerRejected)?;
    for style in snapshot.text_styles {
        document
            .seed_text_style(text_style_resource_from_proto(style)?)
            .map_err(|_| ServiceError::ReducerRejected)?;
    }
    for style in snapshot.paint_styles {
        document
            .seed_paint_style(paint_style_resource_from_proto(style)?)
            .map_err(|_| ServiceError::ReducerRejected)?;
    }
    for style in snapshot.effect_styles {
        document
            .seed_effect_style(effect_style_resource_from_proto(style)?)
            .map_err(|_| ServiceError::ReducerRejected)?;
    }
    for style in snapshot.grid_styles {
        document
            .seed_grid_style(grid_style_resource_from_proto(style)?)
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
            if declared_engine_semantics_version
                < makefigma_document_codec::PAINT_STACK_ENGINE_SEMANTICS_VERSION
                && (fill_stack.is_some() || stroke_stack.is_some())
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::TEXT_RUN_PAINT_STACK_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_fill_stack)
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::TEXT_BASE_STYLE_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_base_style)
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::TEXT_CASE_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_text_case)
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::LINE_HEIGHT_UNIT_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_line_height_unit)
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::PARAGRAPH_INDENT_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_paragraph_indent)
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_text_wrap_style)
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::TEXT_LIST_TYPE_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_list_type)
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::TEXT_LIST_SPACING_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_list_spacing)
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::PARAGRAPH_STYLE_RUNS_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_paragraph_style_runs)
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::TEXT_HANGING_LIST_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_hanging_list)
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::PARAGRAPH_LIST_OPTIONS_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_paragraph_list_options)
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::PARAGRAPH_LIST_SPACING_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_paragraph_list_spacing)
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::PARAGRAPH_SPACING_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_paragraph_spacing)
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::PARAGRAPH_INDENT_RUN_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_paragraph_indent_run)
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::PARAGRAPH_LINE_HEIGHT_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_paragraph_line_height)
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::TEXT_HANGING_PUNCTUATION_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_hanging_punctuation)
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::PARAGRAPH_TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_paragraph_text_wrap_style)
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::TEXT_HYPERLINK_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_hyperlink)
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::TEXT_DECORATION_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_text_decoration)
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::TEXT_DECORATION_STYLE_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_text_decoration_style)
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::TEXT_DECORATION_OFFSET_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_text_decoration_offset)
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::TEXT_DECORATION_THICKNESS_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_text_decoration_thickness)
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::TEXT_DECORATION_COLOR_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_text_decoration_color)
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::TEXT_DECORATION_COLOR_VARIABLE_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_text_decoration_color_variable)
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::TEXT_DECORATION_SKIP_INK_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_text_decoration_skip_ink)
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::LEADING_TRIM_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_leading_trim)
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::OPEN_TYPE_FEATURES_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_open_type_features)
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::TEXT_STYLE_LINK_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_text_style_link)
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::TEXT_PAINT_STYLE_LINK_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_paint_style_link)
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::PAINT_STYLE_LINK_ENGINE_SEMANTICS_VERSION
                && !paint_style_links.is_empty()
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::NON_LINEAR_GRADIENT_ENGINE_SEMANTICS_VERSION
                && [fill_stack.as_ref(), stroke_stack.as_ref()]
                    .into_iter()
                    .flatten()
                    .any(paint_stack_has_non_linear_gradient)
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::ADVANCED_BLEND_ENGINE_SEMANTICS_VERSION
                && (node.blend_mode.requires_advanced_blend_semantics()
                    || [fill_stack.as_ref(), stroke_stack.as_ref()]
                        .into_iter()
                        .flatten()
                        .flat_map(|stack| &stack.layers)
                        .any(|layer| layer.blend_mode.requires_advanced_blend_semantics()))
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::IMAGE_PAINT_ROTATION_ENGINE_SEMANTICS_VERSION
                && [fill_stack.as_ref(), stroke_stack.as_ref()]
                    .into_iter()
                    .flatten()
                    .any(paint_stack_has_rotated_image)
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::PASS_THROUGH_ENGINE_SEMANTICS_VERSION
                && node.blend_mode.requires_pass_through_semantics()
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::LINEAR_BLEND_ENGINE_SEMANTICS_VERSION
                && (node.blend_mode.requires_linear_blend_semantics()
                    || [fill_stack.as_ref(), stroke_stack.as_ref()]
                        .into_iter()
                        .flatten()
                        .any(paint_stack_has_linear_blend))
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::NORMAL_BLEND_ISOLATION_ENGINE_SEMANTICS_VERSION
                && node
                    .extensions
                    .get(makefigma_document_codec::NORMAL_BLEND_ISOLATION_EXTENSION)
                    .is_some_and(|value| value.as_slice() == [1])
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::IMAGE_FILTERS_ENGINE_SEMANTICS_VERSION
                && [fill_stack.as_ref(), stroke_stack.as_ref()]
                    .into_iter()
                    .flatten()
                    .any(paint_stack_has_image_filters)
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::TEXT_TRUNCATION_ENGINE_SEMANTICS_VERSION
                && text_properties
                    .as_ref()
                    .is_some_and(text_properties_has_truncation)
            {
                return Err(ServiceError::ReducerRejected);
            }
            if declared_engine_semantics_version
                < makefigma_document_codec::SHAPE_WITH_TEXT_TEXT_ENGINE_SEMANTICS_VERSION
                && node.kind == NodeKind::ShapeWithText
                && text_properties.is_some()
            {
                return Err(ServiceError::ReducerRejected);
            }
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
            document
                .seed_paint_stacks(node_id, fill_stack, stroke_stack)
                .map_err(|_| ServiceError::ReducerRejected)?;
            document
                .seed_paint_style_links(node_id, paint_style_links)
                .map_err(|_| ServiceError::ReducerRejected)?;
        }
    }
    for retired_id in snapshot.retired_node_ids {
        document
            .seed_retired_id(NodeId(id(&retired_id)?))
            .map_err(|_| ServiceError::ReducerRejected)?;
    }
    document
        .validate_seeded_structure()
        .map_err(|_| ServiceError::ReducerRejected)?;
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
            LayoutMode::Grid => v1::LayoutMode::Grid,
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

fn grid_child_alignment_from_proto(value: Option<i32>) -> Result<GridChildAlignment, ServiceError> {
    match value
        .map(v1::GridChildAlignment::try_from)
        .transpose()
        .map_err(|_| ServiceError::ReducerRejected)?
    {
        None | Some(v1::GridChildAlignment::Auto) => Ok(GridChildAlignment::Auto),
        Some(v1::GridChildAlignment::Min) => Ok(GridChildAlignment::Min),
        Some(v1::GridChildAlignment::Center) => Ok(GridChildAlignment::Center),
        Some(v1::GridChildAlignment::Max) => Ok(GridChildAlignment::Max),
        Some(v1::GridChildAlignment::Unspecified) => Err(ServiceError::ReducerRejected),
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

fn grid_track_from_proto(value: v1::GridTrack) -> Result<GridTrack, ServiceError> {
    match v1::GridTrackType::try_from(value.r#type).map_err(|_| ServiceError::ReducerRejected)? {
        v1::GridTrackType::Flex => Ok(GridTrack::Flex(value.value)),
        v1::GridTrackType::Fixed => Ok(GridTrack::Fixed(value.value)),
        v1::GridTrackType::Hug => Ok(GridTrack::Hug),
        v1::GridTrackType::Unspecified => Err(ServiceError::ReducerRejected),
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
            v1::LayoutMode::Grid => LayoutMode::Grid,
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
    let grid_items_positioning = match value.grid_items_positioning {
        None => GridItemsPositioning::RowAutoFlow,
        Some(raw) => match v1::GridItemsPositioning::try_from(raw)
            .map_err(|_| ServiceError::ReducerRejected)?
        {
            v1::GridItemsPositioning::RowAutoFlow => GridItemsPositioning::RowAutoFlow,
            v1::GridItemsPositioning::Manual => GridItemsPositioning::Manual,
            v1::GridItemsPositioning::Unspecified => return Err(ServiceError::ReducerRejected),
        },
    };
    let grid_auto_tracks = match value.grid_auto_tracks {
        None => GridAutoTracks::None,
        Some(raw) => {
            match v1::GridAutoTracks::try_from(raw).map_err(|_| ServiceError::ReducerRejected)? {
                v1::GridAutoTracks::None => GridAutoTracks::None,
                v1::GridAutoTracks::Rows => GridAutoTracks::Rows,
                v1::GridAutoTracks::Unspecified => return Err(ServiceError::ReducerRejected),
            }
        }
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

fn blend_mode_from_proto(value: i32) -> Result<BlendMode, ServiceError> {
    match v1::BlendMode::try_from(value).map_err(|_| ServiceError::ReducerRejected)? {
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
                    paint_style_id: run.paint_style_id,
                    variable_bindings: style_variable_bindings_from_proto(run.variable_bindings)?,
                    text_decoration_color: run
                        .text_decoration_color
                        .map(text_decoration_color_from_proto)
                        .transpose()?
                        .map(Box::new),
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
                .map_err(|_| ServiceError::ReducerRejected)?
            {
                v1::TextTruncation::Disabled => TextTruncation::Disabled,
                v1::TextTruncation::Ending => TextTruncation::Ending,
                v1::TextTruncation::Unspecified => return Err(ServiceError::ReducerRejected),
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
                        .map_err(|_| ServiceError::ReducerRejected)?,
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
            .collect::<Result<_, ServiceError>>()?,
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
) -> Result<BTreeMap<String, String>, ServiceError> {
    let count = bindings.len();
    let result = bindings
        .into_iter()
        .map(|binding| (binding.field, binding.variable_id))
        .collect::<BTreeMap<_, _>>();
    if result.len() != count {
        return Err(ServiceError::ReducerRejected);
    }
    Ok(result)
}

fn text_style_resource_from_proto(
    resource: v1::TextStyleResource,
) -> Result<TextStyleResource, ServiceError> {
    let variable_binding_count = resource.variable_bindings.len();
    let variable_bindings = resource
        .variable_bindings
        .into_iter()
        .map(|binding| (binding.field, binding.variable_id))
        .collect::<BTreeMap<_, _>>();
    if variable_bindings.len() != variable_binding_count {
        return Err(ServiceError::ReducerRejected);
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
                    _ => Err(ServiceError::ReducerRejected),
                },
            )
            .transpose()?,
        variable_bindings,
        remote: resource.remote,
        style: properties.base_style.ok_or(ServiceError::ReducerRejected)?,
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
) -> Result<PaintStyleResource, ServiceError> {
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
        return Err(ServiceError::ReducerRejected);
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
        paints: paint_stack_from_proto(resource.paints.ok_or(ServiceError::ReducerRejected)?)?,
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
) -> Result<EffectStyleResource, ServiceError> {
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

fn layout_grid_to_proto(grid: &LayoutGrid) -> v1::LayoutGrid {
    v1::LayoutGrid {
        pattern: match grid.pattern {
            LayoutGridPattern::Rows => v1::LayoutGridPattern::Rows as i32,
            LayoutGridPattern::Columns => v1::LayoutGridPattern::Columns as i32,
            LayoutGridPattern::Grid => v1::LayoutGridPattern::Grid as i32,
        },
        alignment: grid.alignment.map(|alignment| match alignment {
            LayoutGridAlignment::Min => v1::LayoutGridAlignment::Min as i32,
            LayoutGridAlignment::Max => v1::LayoutGridAlignment::Max as i32,
            LayoutGridAlignment::Stretch => v1::LayoutGridAlignment::Stretch as i32,
            LayoutGridAlignment::Center => v1::LayoutGridAlignment::Center as i32,
        }),
        section_size: grid.section_size,
        count: grid.count,
        gutter_size: grid.gutter_size,
        offset: grid.offset,
        visible: grid.visible,
        color: grid.color.map(color_to_proto),
    }
}

fn layout_grid_from_proto(grid: v1::LayoutGrid) -> Result<LayoutGrid, ServiceError> {
    Ok(LayoutGrid {
        pattern: match v1::LayoutGridPattern::try_from(grid.pattern) {
            Ok(v1::LayoutGridPattern::Rows) => LayoutGridPattern::Rows,
            Ok(v1::LayoutGridPattern::Columns) => LayoutGridPattern::Columns,
            Ok(v1::LayoutGridPattern::Grid) => LayoutGridPattern::Grid,
            _ => return Err(ServiceError::InvalidEnvelope),
        },
        alignment: grid
            .alignment
            .map(
                |alignment| match v1::LayoutGridAlignment::try_from(alignment) {
                    Ok(v1::LayoutGridAlignment::Min) => Ok(LayoutGridAlignment::Min),
                    Ok(v1::LayoutGridAlignment::Max) => Ok(LayoutGridAlignment::Max),
                    Ok(v1::LayoutGridAlignment::Stretch) => Ok(LayoutGridAlignment::Stretch),
                    Ok(v1::LayoutGridAlignment::Center) => Ok(LayoutGridAlignment::Center),
                    _ => Err(ServiceError::InvalidEnvelope),
                },
            )
            .transpose()?,
        section_size: grid.section_size,
        count: grid.count,
        gutter_size: grid.gutter_size,
        offset: grid.offset,
        visible: grid.visible,
        color: grid.color.map(color_from_proto).transpose()?,
    })
}

fn grid_style_resource_to_proto(resource: &GridStyleResource) -> v1::GridStyleResource {
    v1::GridStyleResource {
        id: resource.id.clone(),
        key: resource.key.clone(),
        name: resource.name.clone(),
        description: resource.description.clone(),
        remote: resource.remote,
        layout_grids: resource
            .layout_grids
            .iter()
            .map(layout_grid_to_proto)
            .collect(),
        description_markdown: resource.description_markdown.clone(),
        documentation_links: resource
            .documentation_links
            .iter()
            .map(|uri| v1::DocumentationLink { uri: uri.clone() })
            .collect(),
    }
}

fn grid_style_resource_from_proto(
    resource: v1::GridStyleResource,
) -> Result<GridStyleResource, ServiceError> {
    Ok(GridStyleResource {
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
        layout_grids: resource
            .layout_grids
            .into_iter()
            .map(layout_grid_from_proto)
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
) -> Result<VariableCollectionResource, ServiceError> {
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

fn variable_value_from_proto(value: v1::VariableValue) -> Result<VariableValue, ServiceError> {
    use v1::variable_value::Value;
    match value.value.ok_or(ServiceError::ReducerRejected)? {
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
) -> Result<VariableResource, ServiceError> {
    let resolved_type = match v1::VariableResolvedType::try_from(value.resolved_type)
        .map_err(|_| ServiceError::ReducerRejected)?
    {
        v1::VariableResolvedType::Boolean => VariableResolvedType::Boolean,
        v1::VariableResolvedType::Color => VariableResolvedType::Color,
        v1::VariableResolvedType::Float => VariableResolvedType::Float,
        v1::VariableResolvedType::String => VariableResolvedType::String,
        v1::VariableResolvedType::Unspecified => return Err(ServiceError::ReducerRejected),
    };
    let mut values_by_mode = BTreeMap::new();
    for entry in value.values_by_mode {
        if values_by_mode
            .insert(
                entry.mode_id,
                variable_value_from_proto(entry.value.ok_or(ServiceError::ReducerRejected)?)?,
            )
            .is_some()
        {
            return Err(ServiceError::ReducerRejected);
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
) -> Vec<OpenTypeFeature> {
    features
        .into_iter()
        .map(|feature| OpenTypeFeature {
            tag: feature.tag,
            enabled: feature.enabled,
        })
        .collect()
}

fn leading_trim_to_proto(value: LeadingTrim) -> i32 {
    match value {
        LeadingTrim::CapHeight => v1::LeadingTrim::CapHeight as i32,
    }
}

fn leading_trim_from_proto(value: i32) -> Result<Option<LeadingTrim>, ServiceError> {
    match v1::LeadingTrim::try_from(value).map_err(|_| ServiceError::ReducerRejected)? {
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
) -> Result<Option<TextDecorationOffset>, ServiceError> {
    match v1::TextDecorationOffsetUnit::try_from(value.unit)
        .map_err(|_| ServiceError::ReducerRejected)?
    {
        v1::TextDecorationOffsetUnit::Pixels => Ok(Some(TextDecorationOffset::Pixels(value.value))),
        v1::TextDecorationOffsetUnit::Percent => {
            Ok(Some(TextDecorationOffset::Percent(value.value)))
        }
        v1::TextDecorationOffsetUnit::Auto if value.value == 0.0 => Ok(None),
        v1::TextDecorationOffsetUnit::Auto | v1::TextDecorationOffsetUnit::Unspecified => {
            Err(ServiceError::ReducerRejected)
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
) -> Result<Option<TextDecorationThickness>, ServiceError> {
    match v1::TextDecorationThicknessUnit::try_from(value.unit)
        .map_err(|_| ServiceError::ReducerRejected)?
    {
        v1::TextDecorationThicknessUnit::Pixels => {
            Ok(Some(TextDecorationThickness::Pixels(value.value)))
        }
        v1::TextDecorationThicknessUnit::Percent => {
            Ok(Some(TextDecorationThickness::Percent(value.value)))
        }
        v1::TextDecorationThicknessUnit::Auto if value.value == 0.0 => Ok(None),
        v1::TextDecorationThicknessUnit::Auto | v1::TextDecorationThicknessUnit::Unspecified => {
            Err(ServiceError::ReducerRejected)
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
) -> Result<TextDecorationColor, ServiceError> {
    let blend_mode = blend_mode_from_proto(value.blend_mode)?;
    if matches!(blend_mode, BlendMode::PassThrough) {
        return Err(ServiceError::ReducerRejected);
    }
    Ok(TextDecorationColor {
        color: color_from_proto(value.color.ok_or(ServiceError::ReducerRejected)?)?,
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
) -> Result<Option<TextDecorationStyle>, ServiceError> {
    match v1::TextDecorationStyle::try_from(value).map_err(|_| ServiceError::ReducerRejected)? {
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

fn text_decoration_from_proto(value: i32) -> Result<Option<TextDecoration>, ServiceError> {
    Ok(Some(
        match v1::TextDecoration::try_from(value).map_err(|_| ServiceError::ReducerRejected)? {
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

fn hyperlink_from_proto(value: v1::HyperlinkTarget) -> Result<HyperlinkTarget, ServiceError> {
    let kind = match v1::HyperlinkType::try_from(value.r#type)
        .map_err(|_| ServiceError::ReducerRejected)?
    {
        v1::HyperlinkType::Url => HyperlinkType::Url,
        v1::HyperlinkType::Node => HyperlinkType::Node,
        v1::HyperlinkType::Unspecified => return Err(ServiceError::ReducerRejected),
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

fn paragraph_text_wrap_style_from_proto(value: i32) -> Result<TextWrapStyle, ServiceError> {
    match v1::TextWrapStyle::try_from(value).map_err(|_| ServiceError::ReducerRejected)? {
        v1::TextWrapStyle::Auto => Ok(TextWrapStyle::Auto),
        v1::TextWrapStyle::Balance => Ok(TextWrapStyle::Balance),
        v1::TextWrapStyle::Pretty => Ok(TextWrapStyle::Pretty),
        v1::TextWrapStyle::Unspecified => Err(ServiceError::ReducerRejected),
    }
}

fn text_wrap_style_from_proto(value: i32) -> Result<Option<TextWrapStyle>, ServiceError> {
    match v1::TextWrapStyle::try_from(value).map_err(|_| ServiceError::ReducerRejected)? {
        v1::TextWrapStyle::Auto => Ok(None),
        v1::TextWrapStyle::Balance => Ok(Some(TextWrapStyle::Balance)),
        v1::TextWrapStyle::Pretty => Ok(Some(TextWrapStyle::Pretty)),
        v1::TextWrapStyle::Unspecified => Err(ServiceError::ReducerRejected),
    }
}

fn text_list_type_to_proto(value: TextListType) -> i32 {
    (match value {
        TextListType::Ordered => v1::TextListType::Ordered,
        TextListType::Unordered => v1::TextListType::Unordered,
    }) as i32
}

fn text_list_type_from_proto(value: i32) -> Result<Option<TextListType>, ServiceError> {
    match v1::TextListType::try_from(value).map_err(|_| ServiceError::ReducerRejected)? {
        v1::TextListType::None => Ok(None),
        v1::TextListType::Ordered => Ok(Some(TextListType::Ordered)),
        v1::TextListType::Unordered => Ok(Some(TextListType::Unordered)),
        v1::TextListType::Unspecified => Err(ServiceError::ReducerRejected),
    }
}

fn paragraph_list_type_to_proto(value: ParagraphListType) -> i32 {
    (match value {
        ParagraphListType::None => v1::TextListType::None,
        ParagraphListType::Ordered => v1::TextListType::Ordered,
        ParagraphListType::Unordered => v1::TextListType::Unordered,
    }) as i32
}

fn paragraph_list_type_from_proto(value: i32) -> Result<ParagraphListType, ServiceError> {
    match v1::TextListType::try_from(value).map_err(|_| ServiceError::ReducerRejected)? {
        v1::TextListType::None => Ok(ParagraphListType::None),
        v1::TextListType::Ordered => Ok(ParagraphListType::Ordered),
        v1::TextListType::Unordered => Ok(ParagraphListType::Unordered),
        v1::TextListType::Unspecified => Err(ServiceError::ReducerRejected),
    }
}

fn line_height_unit_to_proto(value: LineHeightUnit) -> i32 {
    (match value {
        LineHeightUnit::Percent => v1::LineHeightUnit::Percent,
        LineHeightUnit::Auto => v1::LineHeightUnit::Auto,
    }) as i32
}

fn line_height_unit_from_proto(value: i32) -> Result<Option<LineHeightUnit>, ServiceError> {
    match v1::LineHeightUnit::try_from(value).map_err(|_| ServiceError::ReducerRejected)? {
        v1::LineHeightUnit::Pixels => Ok(None),
        v1::LineHeightUnit::Percent => Ok(Some(LineHeightUnit::Percent)),
        v1::LineHeightUnit::Auto => Ok(Some(LineHeightUnit::Auto)),
        v1::LineHeightUnit::Unspecified => Err(ServiceError::ReducerRejected),
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

fn text_case_from_proto(value: i32) -> Result<Option<TextCase>, ServiceError> {
    match v1::TextCase::try_from(value).map_err(|_| ServiceError::ReducerRejected)? {
        v1::TextCase::Original => Ok(None),
        v1::TextCase::Upper => Ok(Some(TextCase::Upper)),
        v1::TextCase::Lower => Ok(Some(TextCase::Lower)),
        v1::TextCase::Title => Ok(Some(TextCase::Title)),
        v1::TextCase::SmallCaps => Ok(Some(TextCase::SmallCaps)),
        v1::TextCase::SmallCapsForced => Ok(Some(TextCase::SmallCapsForced)),
        v1::TextCase::Unspecified => Err(ServiceError::ReducerRejected),
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

fn command_has_text_run_paint_stack(command: &Command) -> bool {
    matches!(command, Command::SetTextProperties { properties, .. } if text_properties_has_fill_stack(properties))
}

fn command_has_text_base_style(command: &Command) -> bool {
    matches!(command, Command::SetTextProperties { properties, .. } if text_properties_has_base_style(properties))
}

fn command_has_text_case(command: &Command) -> bool {
    matches!(command, Command::SetTextProperties { properties, .. } if text_properties_has_text_case(properties))
}

fn command_has_line_height_unit(command: &Command) -> bool {
    matches!(command, Command::SetTextProperties { properties, .. } if text_properties_has_line_height_unit(properties))
        || matches!(command, Command::RestoreNode { text_properties: Some(properties), .. } if text_properties_has_line_height_unit(properties))
}

fn command_has_paragraph_indent(command: &Command) -> bool {
    matches!(command, Command::SetTextProperties { properties, .. } if text_properties_has_paragraph_indent(properties))
        || matches!(command, Command::RestoreNode { text_properties: Some(properties), .. } if text_properties_has_paragraph_indent(properties))
}

fn command_has_text_wrap_style(command: &Command) -> bool {
    matches!(command, Command::SetTextProperties { properties, .. } if text_properties_has_text_wrap_style(properties))
        || matches!(command, Command::RestoreNode { text_properties: Some(properties), .. } if text_properties_has_text_wrap_style(properties))
}

fn command_has_list_type(command: &Command) -> bool {
    matches!(command, Command::SetTextProperties { properties, .. } if text_properties_has_list_type(properties))
        || matches!(command, Command::RestoreNode { text_properties: Some(properties), .. } if text_properties_has_list_type(properties))
}

fn command_has_list_spacing(command: &Command) -> bool {
    matches!(command, Command::SetTextProperties { properties, .. } if text_properties_has_list_spacing(properties))
        || matches!(command, Command::RestoreNode { text_properties: Some(properties), .. } if text_properties_has_list_spacing(properties))
}

fn command_has_paragraph_style_runs(command: &Command) -> bool {
    matches!(command, Command::SetTextProperties { properties, .. } if text_properties_has_paragraph_style_runs(properties))
        || matches!(command, Command::RestoreNode { text_properties: Some(properties), .. } if text_properties_has_paragraph_style_runs(properties))
}

fn command_has_paragraph_list_options(command: &Command) -> bool {
    matches!(command, Command::SetTextProperties { properties, .. } if text_properties_has_paragraph_list_options(properties))
        || matches!(command, Command::RestoreNode { text_properties: Some(properties), .. } if text_properties_has_paragraph_list_options(properties))
}

fn command_has_paragraph_list_spacing(command: &Command) -> bool {
    matches!(command, Command::SetTextProperties { properties, .. } if text_properties_has_paragraph_list_spacing(properties))
        || matches!(command, Command::RestoreNode { text_properties: Some(properties), .. } if text_properties_has_paragraph_list_spacing(properties))
}

fn command_has_paragraph_spacing(command: &Command) -> bool {
    matches!(command, Command::SetTextProperties { properties, .. } if text_properties_has_paragraph_spacing(properties))
        || matches!(command, Command::RestoreNode { text_properties: Some(properties), .. } if text_properties_has_paragraph_spacing(properties))
}

fn command_has_paragraph_indent_run(command: &Command) -> bool {
    matches!(command, Command::SetTextProperties { properties, .. } if text_properties_has_paragraph_indent_run(properties))
        || matches!(command, Command::RestoreNode { text_properties: Some(properties), .. } if text_properties_has_paragraph_indent_run(properties))
}

fn command_has_paragraph_line_height(command: &Command) -> bool {
    matches!(command, Command::SetTextProperties { properties, .. } if text_properties_has_paragraph_line_height(properties))
        || matches!(command, Command::RestoreNode { text_properties: Some(properties), .. } if text_properties_has_paragraph_line_height(properties))
}

fn command_has_paragraph_text_wrap_style(command: &Command) -> bool {
    matches!(command, Command::SetTextProperties { properties, .. } if text_properties_has_paragraph_text_wrap_style(properties))
        || matches!(command, Command::RestoreNode { text_properties: Some(properties), .. } if text_properties_has_paragraph_text_wrap_style(properties))
}

fn command_has_hanging_list(command: &Command) -> bool {
    matches!(command, Command::SetTextProperties { properties, .. } if text_properties_has_hanging_list(properties))
        || matches!(command, Command::RestoreNode { text_properties: Some(properties), .. } if text_properties_has_hanging_list(properties))
}

fn command_has_hanging_punctuation(command: &Command) -> bool {
    matches!(command, Command::SetTextProperties { properties, .. } if text_properties_has_hanging_punctuation(properties))
        || matches!(command, Command::RestoreNode { text_properties: Some(properties), .. } if text_properties_has_hanging_punctuation(properties))
}

fn command_has_hyperlink(command: &Command) -> bool {
    matches!(command, Command::SetTextProperties { properties, .. } if text_properties_has_hyperlink(properties))
        || matches!(command, Command::RestoreNode { text_properties: Some(properties), .. } if text_properties_has_hyperlink(properties))
}

fn command_has_text_decoration(command: &Command) -> bool {
    matches!(command, Command::SetTextProperties { properties, .. } if text_properties_has_text_decoration(properties))
        || matches!(command, Command::RestoreNode { text_properties: Some(properties), .. } if text_properties_has_text_decoration(properties))
}

fn command_has_text_decoration_style(command: &Command) -> bool {
    matches!(command, Command::SetTextProperties { properties, .. } if text_properties_has_text_decoration_style(properties))
        || matches!(command, Command::RestoreNode { text_properties: Some(properties), .. } if text_properties_has_text_decoration_style(properties))
}

fn command_has_text_decoration_offset(command: &Command) -> bool {
    matches!(command, Command::SetTextProperties { properties, .. } if text_properties_has_text_decoration_offset(properties))
        || matches!(command, Command::RestoreNode { text_properties: Some(properties), .. } if text_properties_has_text_decoration_offset(properties))
}

fn command_has_text_decoration_thickness(command: &Command) -> bool {
    matches!(command, Command::SetTextProperties { properties, .. } if text_properties_has_text_decoration_thickness(properties))
        || matches!(command, Command::RestoreNode { text_properties: Some(properties), .. } if text_properties_has_text_decoration_thickness(properties))
}

fn command_has_text_decoration_color(command: &Command) -> bool {
    matches!(command, Command::SetTextProperties { properties, .. } if text_properties_has_text_decoration_color(properties))
        || matches!(command, Command::RestoreNode { text_properties: Some(properties), .. } if text_properties_has_text_decoration_color(properties))
}

fn command_has_text_decoration_color_variable(command: &Command) -> bool {
    matches!(command, Command::SetTextProperties { properties, .. } if text_properties_has_text_decoration_color_variable(properties))
        || matches!(command, Command::RestoreNode { text_properties: Some(properties), .. } if text_properties_has_text_decoration_color_variable(properties))
        || matches!(command, Command::RegisterTextStyle { style } | Command::SetTextStyle { style }
            if style.style.text_decoration_color.as_ref().is_some_and(|color| color.variable_id.is_some()))
}

fn command_has_text_decoration_skip_ink(command: &Command) -> bool {
    matches!(command, Command::SetTextProperties { properties, .. } if text_properties_has_text_decoration_skip_ink(properties))
        || matches!(command, Command::RestoreNode { text_properties: Some(properties), .. } if text_properties_has_text_decoration_skip_ink(properties))
}

fn command_has_leading_trim(command: &Command) -> bool {
    matches!(command, Command::SetTextProperties { properties, .. } if text_properties_has_leading_trim(properties))
        || matches!(command, Command::RestoreNode { text_properties: Some(properties), .. } if text_properties_has_leading_trim(properties))
}

fn command_has_open_type_features(command: &Command) -> bool {
    matches!(command, Command::SetTextProperties { properties, .. } if text_properties_has_open_type_features(properties))
        || matches!(command, Command::RestoreNode { text_properties: Some(properties), .. } if text_properties_has_open_type_features(properties))
}

fn command_has_text_style_link(command: &Command) -> bool {
    matches!(command, Command::SetTextProperties { properties, .. } if text_properties_has_text_style_link(properties))
        || matches!(command, Command::RestoreNode { text_properties: Some(properties), .. } if text_properties_has_text_style_link(properties))
}

fn command_has_paint_style_link(command: &Command) -> bool {
    matches!(command, Command::SetTextProperties { properties, .. } if text_properties_has_paint_style_link(properties))
        || matches!(command, Command::RestoreNode { text_properties: Some(properties), .. } if text_properties_has_paint_style_link(properties))
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

fn gradient_paint_from_proto(gradient: v1::GradientPaint) -> Result<GradientPaint, ServiceError> {
    let kind = match v1::GradientPaintKind::try_from(gradient.kind)
        .map_err(|_| ServiceError::ReducerRejected)?
    {
        v1::GradientPaintKind::Radial => GradientPaintKind::Radial,
        v1::GradientPaintKind::Angular => GradientPaintKind::Angular,
        v1::GradientPaintKind::Diamond => GradientPaintKind::Diamond,
        v1::GradientPaintKind::Unspecified => return Err(ServiceError::ReducerRejected),
    };
    GradientPaint::new(
        kind,
        transform_from_proto(gradient.transform.ok_or(ServiceError::ReducerRejected)?)?,
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
    .map_err(|_| ServiceError::ReducerRejected)
}

fn paint_layer_to_proto(layer: &PaintLayer) -> v1::PaintLayer {
    use v1::paint_layer::Kind;
    let kind = match &layer.paint {
        PaintLayerKind::Solid(color) => Kind::Solid(color_to_proto(*color)),
        PaintLayerKind::LinearGradient(gradient) => {
            let Some(v1::paint::Kind::LinearGradient(gradient)) =
                paint_to_proto(&Paint::LinearGradient(gradient.clone())).kind
            else {
                unreachable!("linear gradient conversion is stable")
            };
            Kind::LinearGradient(gradient)
        }
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
        .ok_or(ServiceError::ReducerRejected)
}

fn paint_layer_from_proto(layer: v1::PaintLayer) -> Result<PaintLayer, ServiceError> {
    use v1::paint_layer::Kind;
    let paint = match layer.kind.ok_or(ServiceError::ReducerRejected)? {
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
                .map_err(|_| ServiceError::ReducerRejected)?
            {
                v1::ImageScaleMode::Fill => ImageScaleMode::Fill,
                v1::ImageScaleMode::Fit => ImageScaleMode::Fit,
                v1::ImageScaleMode::Crop => ImageScaleMode::Crop,
                v1::ImageScaleMode::Tile => ImageScaleMode::Tile,
                v1::ImageScaleMode::Unspecified => return Err(ServiceError::ReducerRejected),
            },
            transform: transform_from_proto(image.transform.ok_or(ServiceError::ReducerRejected)?)?,
            rotation_degrees: i16::try_from(image.rotation_degrees)
                .map_err(|_| ServiceError::ReducerRejected)?,
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
        .ok_or(ServiceError::ReducerRejected)
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
        DEFAULT_PAGE_ID, Document, DocumentId, Effect, EffectStyleResource, FontReference,
        LayerBlur, LayoutAlignment, LayoutMode, Node, NodeId, NodeKind, Page, PageId,
        ParagraphStyle, PositionId, TextAlign, TextAutoSize, TextProperties, TextStyleRun,
        WrapTrackAlignment, color::Color, geometry::AffineTransform,
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
                font_faces: Vec::new(),
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
                    font_faces: Vec::new(),
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
                },
            ],
            paragraph: ParagraphStyle {
                alignment: TextAlign::Justify,
                line_height: Some(27.0),
                line_height_unit: None,
                paragraph_spacing: 6.0,
                paragraph_indent: None,
                text_wrap_style: None,
                list_type: None,
                list_spacing: None,
                hanging_list: false,
                hanging_punctuation: false,
            },
            paragraph_style_runs: Vec::new(),
            auto_size: TextAutoSize::Height,
            fallback_fonts: vec![fallback],
            text_truncation: TextTruncation::Disabled,
            max_lines: None,
            base_style: None,
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

    #[test]
    fn service_semantics_four_replays_and_persists_an_image_paint_stack() {
        let tenant_id = 2_u128.to_be_bytes();
        let actor_id = 7_u128.to_be_bytes();
        let mut document = Document::with_id(DocumentId(31));
        let asset = AssetReference {
            asset_id: AssetId(310),
            content_hash: [31; 32],
            media_type: "image/png".into(),
            byte_length: 64,
            dimensions: Some([8, 4]),
            font_faces: Vec::new(),
        };
        document.seed_asset(asset.clone()).unwrap();
        let mut node = leaf(NodeId(311), None, NodeKind::Rectangle);
        node.name = "Paint target".into();
        document
            .seed_node_on_page(DEFAULT_PAGE_ID, node.clone())
            .unwrap();
        let service = DocumentService::in_memory(CoreOperationReducer::new(
            makefigma_document_codec::PAINT_STACK_ENGINE_SEMANTICS_VERSION,
        ))
        .unwrap();
        service
            .create_document(
                initial_document_state(
                    &document,
                    tenant_id,
                    makefigma_document_codec::PAINT_STACK_ENGINE_SEMANTICS_VERSION,
                )
                .unwrap(),
                &[actor_id],
            )
            .unwrap();

        let stack = PaintStack {
            layers: vec![
                PaintLayer {
                    paint: PaintLayerKind::Solid(Color::from_srgb_u8([255, 0, 0], 255)),
                    visible: true,
                    opacity: 0.5,
                    blend_mode: BlendMode::Multiply,
                },
                PaintLayer {
                    paint: PaintLayerKind::Image(ImagePaint {
                        asset_id: asset.asset_id,
                        scale_mode: ImageScaleMode::Fit,
                        transform: AffineTransform::IDENTITY,
                        rotation_degrees: 0,
                        filters: None,
                    }),
                    visible: false,
                    opacity: 0.25,
                    blend_mode: BlendMode::Screen,
                },
            ],
        };
        let payload = v1::ResolvedOperationBatch {
            operations: vec![v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::SetAppearance(
                    v1::AppearanceUpdate {
                        node_id: node.id.0.to_be_bytes().to_vec(),
                        fill: Some(paint_to_proto(&node.fill)),
                        stroke: Some(paint_to_proto(&node.stroke)),
                        stroke_width: node.stroke_width,
                        opacity: node.opacity,
                        corner_radius: 0.0,
                        visible: node.visible,
                        locked: node.locked,
                        stroke_cap_start: v1::StrokeCap::None as i32,
                        stroke_cap_end: v1::StrokeCap::None as i32,
                        contents_hidden: node.contents_hidden,
                        stroke_join: v1::StrokeJoin::Miter as i32,
                        stroke_miter_limit: node.stroke_miter_limit,
                        stroke_dash_pattern: vec![],
                        stroke_weights: vec![],
                        stroke_align: v1::StrokeAlign::Inside as i32,
                        arc_data: None,
                        relative_transform: None,
                        clips_content: None,
                        corner_radii: vec![],
                        corner_smoothing: 0.0,
                        fills: vec![],
                        strokes: vec![],
                        constraints: None,
                        drop_shadow: None,
                        polygon_parameters: None,
                        star_parameters: None,
                        effect_stack: vec![],
                        auto_layout: None,
                        blend_mode: v1::BlendMode::Normal as i32,
                        fill_stack: Some(paint_stack_to_proto(&stack)),
                        stroke_stack: Some(v1::PaintStack { layers: vec![] }),
                    },
                )),
            }],
        }
        .encode_to_vec();
        let envelope = v1::OperationEnvelope {
            schema_version: 1,
            document_id: 31_u128.to_be_bytes().to_vec(),
            operation_id: 312_u128.to_be_bytes().to_vec(),
            transaction_id: 312_u128.to_be_bytes().to_vec(),
            actor_id: actor_id.to_vec(),
            session_id: 9_u128.to_be_bytes().to_vec(),
            client_sequence: 1,
            base_revision: 0,
            causal_parent_ids: vec![],
            payload_hash: Sha256::digest(&payload).to_vec(),
            payload,
            engine_semantics_version: Some(
                makefigma_document_codec::PAINT_STACK_ENGINE_SEMANTICS_VERSION,
            ),
        }
        .encode_to_vec();
        let principal = TrustedPrincipal {
            tenant_id,
            actor_id,
        };

        let accepted = service.submit(principal, &envelope).unwrap();
        assert_eq!(accepted.accepted_revision, 1);
        assert!(!accepted.idempotent_replay);
        assert!(
            service
                .submit(principal, &envelope)
                .unwrap()
                .idempotent_replay
        );
        let stored = service.load_document(31_u128.to_be_bytes()).unwrap();
        let restored = makefigma_document_codec::document_from_snapshot_with_engine_semantics(
            &stored.snapshot,
            stored.document_id,
            stored.document_hash,
            makefigma_document_codec::PAINT_STACK_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        let restored_node = restored.node(node.id).unwrap();
        assert_eq!(restored_node.fill, node.fill);
        assert_eq!(restored_node.stroke, node.stroke);
        assert!(matches!(&restored_node.fill, Paint::Solid(color) if color.to_srgb_u8()[3] == 0));
        assert!(matches!(&restored_node.stroke, Paint::Solid(color) if color.to_srgb_u8()[3] == 0));
        assert_eq!(restored.fill_stack_for_node(node.id), Some(&stack));
        assert_eq!(
            restored.stroke_stack_for_node(node.id),
            Some(&PaintStack::default())
        );
        assert_eq!(restored.canonical_hash(), stored.document_hash);
    }

    #[test]
    fn service_snapshot_adapter_requires_semantics_five_for_non_linear_gradients() {
        let mut document = Document::with_id(DocumentId(41));
        let mut node = leaf(NodeId(411), None, NodeKind::Rectangle);
        node.name = "Angular target".into();
        document
            .seed_node_on_page(DEFAULT_PAGE_ID, node.clone())
            .unwrap();
        let stack = PaintStack {
            layers: vec![PaintLayer {
                paint: PaintLayerKind::Gradient(
                    GradientPaint::new(
                        GradientPaintKind::Angular,
                        AffineTransform {
                            a: 0.75,
                            b: 0.25,
                            c: -0.125,
                            d: 1.25,
                            e: 0.1,
                            f: -0.2,
                        },
                        vec![
                            GradientStop {
                                position: 0.0,
                                color: Color::from_srgb_u8([255, 0, 0], 255),
                            },
                            GradientStop {
                                position: 0.45,
                                color: Color::from_srgb_u8([0, 255, 0], 192),
                            },
                            GradientStop {
                                position: 1.0,
                                color: Color::from_srgb_u8([0, 0, 255], 255),
                            },
                        ],
                    )
                    .unwrap(),
                ),
                visible: true,
                opacity: 0.75,
                blend_mode: BlendMode::Overlay,
            }],
        };
        document
            .seed_paint_stacks(node.id, Some(stack.clone()), None)
            .unwrap();

        assert!(
            snapshot_from_document(
                &document,
                makefigma_document_codec::NON_LINEAR_GRADIENT_ENGINE_SEMANTICS_VERSION - 1,
            )
            .is_err()
        );
        let snapshot = snapshot_from_document(
            &document,
            makefigma_document_codec::NON_LINEAR_GRADIENT_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        let restored = document_from_snapshot(
            &snapshot,
            document.id().0.to_be_bytes(),
            document.canonical_hash(),
        )
        .unwrap();

        assert_eq!(restored.fill_stack_for_node(node.id), Some(&stack));
        assert_eq!(restored.stroke_stack_for_node(node.id), None);
        assert_eq!(restored.canonical_hash(), document.canonical_hash());
    }

    #[test]
    fn service_snapshot_adapter_requires_semantics_six_for_advanced_blends() {
        let mut document = Document::with_id(DocumentId(42));
        let mut node = leaf(NodeId(421), None, NodeKind::Rectangle);
        node.name = "Blend target".into();
        node.blend_mode = BlendMode::Saturation;
        document
            .seed_node_on_page(DEFAULT_PAGE_ID, node.clone())
            .unwrap();
        let stack = PaintStack {
            layers: vec![PaintLayer {
                paint: PaintLayerKind::Solid(Color::from_srgb_u8([200, 40, 90], 255)),
                visible: true,
                opacity: 0.65,
                blend_mode: BlendMode::HardLight,
            }],
        };
        document
            .seed_paint_stacks(node.id, Some(stack.clone()), None)
            .unwrap();

        assert!(
            snapshot_from_document(
                &document,
                makefigma_document_codec::ADVANCED_BLEND_ENGINE_SEMANTICS_VERSION - 1,
            )
            .is_err()
        );
        let snapshot = snapshot_from_document(
            &document,
            makefigma_document_codec::ADVANCED_BLEND_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        let restored = document_from_snapshot(
            &snapshot,
            document.id().0.to_be_bytes(),
            document.canonical_hash(),
        )
        .unwrap();

        assert_eq!(
            restored.node(node.id).unwrap().blend_mode,
            BlendMode::Saturation
        );
        assert_eq!(restored.fill_stack_for_node(node.id), Some(&stack));
        assert_eq!(restored.canonical_hash(), document.canonical_hash());
    }

    #[test]
    fn service_snapshot_adapter_requires_semantics_seven_for_image_rotation() {
        let asset = AssetReference {
            asset_id: AssetId(430),
            content_hash: [43; 32],
            media_type: "image/png".into(),
            byte_length: 64,
            dimensions: Some([8, 4]),
            font_faces: Vec::new(),
        };
        let mut document = Document::with_id(DocumentId(43));
        document.seed_asset(asset.clone()).unwrap();
        let mut node = leaf(NodeId(431), None, NodeKind::Rectangle);
        node.name = "Rotated image".into();
        document
            .seed_node_on_page(DEFAULT_PAGE_ID, node.clone())
            .unwrap();
        let stack = PaintStack {
            layers: vec![PaintLayer {
                paint: PaintLayerKind::Image(ImagePaint {
                    asset_id: asset.asset_id,
                    scale_mode: ImageScaleMode::Fit,
                    transform: AffineTransform::IDENTITY,
                    rotation_degrees: 270,
                    filters: None,
                }),
                visible: true,
                opacity: 1.0,
                blend_mode: BlendMode::Normal,
            }],
        };
        document
            .seed_paint_stacks(node.id, Some(stack.clone()), None)
            .unwrap();

        assert!(
            snapshot_from_document(
                &document,
                makefigma_document_codec::IMAGE_PAINT_ROTATION_ENGINE_SEMANTICS_VERSION - 1,
            )
            .is_err()
        );
        let snapshot = snapshot_from_document(
            &document,
            makefigma_document_codec::IMAGE_PAINT_ROTATION_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        let restored = document_from_snapshot(
            &snapshot,
            document.id().0.to_be_bytes(),
            document.canonical_hash(),
        )
        .unwrap();
        assert_eq!(restored.fill_stack_for_node(node.id), Some(&stack));
        assert_eq!(restored.canonical_hash(), document.canonical_hash());
    }

    #[test]
    fn service_snapshot_adapter_requires_semantics_eleven_for_image_filters() {
        let asset = AssetReference {
            asset_id: AssetId(435),
            content_hash: [45; 32],
            media_type: "image/png".into(),
            byte_length: 64,
            dimensions: Some([8, 4]),
            font_faces: Vec::new(),
        };
        let mut document = Document::with_id(DocumentId(45));
        document.seed_asset(asset.clone()).unwrap();
        let mut node = leaf(NodeId(435), None, NodeKind::Rectangle);
        node.name = "Filtered image".into();
        document
            .seed_node_on_page(DEFAULT_PAGE_ID, node.clone())
            .unwrap();
        let stack = PaintStack {
            layers: vec![PaintLayer {
                paint: PaintLayerKind::Image(ImagePaint {
                    asset_id: asset.asset_id,
                    scale_mode: ImageScaleMode::Fill,
                    transform: AffineTransform::IDENTITY,
                    rotation_degrees: 0,
                    filters: Some(ImageFilters {
                        temperature: Some(-0.4),
                        highlights: Some(0.6),
                        ..Default::default()
                    }),
                }),
                visible: true,
                opacity: 1.0,
                blend_mode: BlendMode::Normal,
            }],
        };
        document
            .seed_paint_stacks(node.id, Some(stack.clone()), None)
            .unwrap();

        assert!(
            snapshot_from_document(
                &document,
                makefigma_document_codec::IMAGE_FILTERS_ENGINE_SEMANTICS_VERSION - 1,
            )
            .is_err()
        );
        let snapshot = snapshot_from_document(
            &document,
            makefigma_document_codec::IMAGE_FILTERS_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        let restored = document_from_snapshot(
            &snapshot,
            document.id().0.to_be_bytes(),
            document.canonical_hash(),
        )
        .unwrap();
        assert_eq!(restored.fill_stack_for_node(node.id), Some(&stack));
        assert_eq!(restored.canonical_hash(), document.canonical_hash());
    }

    #[test]
    fn service_snapshot_adapter_requires_semantics_eight_for_pass_through() {
        let mut document = Document::with_id(DocumentId(44));
        let mut frame = leaf(NodeId(441), None, NodeKind::Frame);
        frame.name = "Pass through frame".into();
        frame.blend_mode = BlendMode::PassThrough;
        document
            .seed_node_on_page(DEFAULT_PAGE_ID, frame.clone())
            .unwrap();

        assert!(
            snapshot_from_document(
                &document,
                makefigma_document_codec::PASS_THROUGH_ENGINE_SEMANTICS_VERSION - 1,
            )
            .is_err()
        );
        let snapshot = snapshot_from_document(
            &document,
            makefigma_document_codec::PASS_THROUGH_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        let restored = document_from_snapshot(
            &snapshot,
            document.id().0.to_be_bytes(),
            document.canonical_hash(),
        )
        .unwrap();
        assert_eq!(
            restored.node(frame.id).unwrap().blend_mode,
            BlendMode::PassThrough
        );
        assert_eq!(restored.canonical_hash(), document.canonical_hash());
    }

    #[test]
    fn service_snapshot_adapter_requires_semantics_nine_for_linear_blends() {
        let mut document = Document::with_id(DocumentId(45));
        let mut burn = leaf(NodeId(451), None, NodeKind::Rectangle);
        burn.name = "Linear burn".into();
        burn.blend_mode = BlendMode::LinearBurn;
        let mut dodge = leaf(NodeId(452), None, NodeKind::Rectangle);
        dodge.name = "Linear dodge".into();
        dodge.blend_mode = BlendMode::LinearDodge;
        document
            .seed_node_on_page(DEFAULT_PAGE_ID, burn.clone())
            .unwrap();
        document
            .seed_node_on_page(DEFAULT_PAGE_ID, dodge.clone())
            .unwrap();
        document
            .seed_paint_stacks(
                burn.id,
                Some(PaintStack {
                    layers: vec![PaintLayer {
                        paint: PaintLayerKind::Solid(Color::from_srgb_u8([200, 40, 90], 255)),
                        visible: true,
                        opacity: 0.75,
                        blend_mode: BlendMode::LinearBurn,
                    }],
                }),
                None,
            )
            .unwrap();

        assert!(
            snapshot_from_document(
                &document,
                makefigma_document_codec::LINEAR_BLEND_ENGINE_SEMANTICS_VERSION - 1,
            )
            .is_err()
        );
        let snapshot = snapshot_from_document(
            &document,
            makefigma_document_codec::LINEAR_BLEND_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        let restored = document_from_snapshot(
            &snapshot,
            document.id().0.to_be_bytes(),
            document.canonical_hash(),
        )
        .unwrap();
        assert_eq!(
            restored.node(burn.id).unwrap().blend_mode,
            BlendMode::LinearBurn
        );
        assert_eq!(
            restored.node(dodge.id).unwrap().blend_mode,
            BlendMode::LinearDodge
        );
        assert_eq!(
            restored.fill_stack_for_node(burn.id).unwrap().layers[0].blend_mode,
            BlendMode::LinearBurn
        );
        assert_eq!(restored.canonical_hash(), document.canonical_hash());
    }

    #[test]
    fn service_snapshot_adapter_requires_semantics_ten_for_isolated_normal() {
        let mut document = Document::with_id(DocumentId(46));
        let mut group = leaf(NodeId(461), None, NodeKind::Frame);
        group.name = "Isolated normal frame".into();
        group.extensions.insert(
            makefigma_document_codec::NORMAL_BLEND_ISOLATION_EXTENSION.into(),
            vec![1],
        );
        document
            .seed_node_on_page(DEFAULT_PAGE_ID, group.clone())
            .unwrap();

        assert!(
            snapshot_from_document(
                &document,
                makefigma_document_codec::NORMAL_BLEND_ISOLATION_ENGINE_SEMANTICS_VERSION - 1,
            )
            .is_err()
        );
        let snapshot = snapshot_from_document(
            &document,
            makefigma_document_codec::NORMAL_BLEND_ISOLATION_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        let restored = document_from_snapshot(
            &snapshot,
            document.id().0.to_be_bytes(),
            document.canonical_hash(),
        )
        .unwrap();
        assert_eq!(
            restored
                .node(group.id)
                .unwrap()
                .extensions
                .get(makefigma_document_codec::NORMAL_BLEND_ISOLATION_EXTENSION),
            Some(&vec![1])
        );
        assert_eq!(restored.canonical_hash(), document.canonical_hash());
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
        let wire = node_to_proto(
            &slice,
            DEFAULT_PAGE_ID,
            None,
            None,
            AutoLayout::default(),
            None,
            None,
            None,
        );
        assert_eq!(wire.kind, v1::NodeKind::Slice as i32);

        let (
            page_id,
            restored,
            asset_id,
            text_properties,
            auto_layout,
            fill_stack,
            stroke_stack,
            paint_style_links,
        ) = node_from_proto(wire).unwrap();
        assert_eq!(page_id, DEFAULT_PAGE_ID);
        assert_eq!(restored.kind, NodeKind::Slice);
        assert_eq!(restored.rotation, 22.5);
        assert_eq!(asset_id, None);
        assert_eq!(text_properties, None);
        assert_eq!(auto_layout, AutoLayout::default());
        assert_eq!(fill_stack, None);
        assert_eq!(stroke_stack, None);
        assert!(paint_style_links.is_empty());
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
                        ignore_constraints: false,
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
    fn service_idempotently_replays_a_cross_page_component_import_and_restores_its_metadata() {
        let semantics = makefigma_document_codec::CURRENT_ENGINE_SEMANTICS_VERSION;
        let document_id = 30_u128.to_be_bytes();
        let tenant_id = 2_u128.to_be_bytes();
        let actor_id = 7_u128.to_be_bytes();
        let service = DocumentService::in_memory(CoreOperationReducer::new(semantics)).unwrap();
        let document = Document::with_id(DocumentId(30));
        service
            .create_document(
                initial_document_state(&document, tenant_id, semantics).unwrap(),
                &[actor_id],
            )
            .unwrap();

        let pages = [
            Page {
                id: PageId(2),
                name: "Instances".into(),
                position: PositionId::for_node(NodeId(2)),
            },
            Page {
                id: PageId(3),
                name: "Library".into(),
                position: PositionId::for_node(NodeId(3)),
            },
        ];
        let mut instance = leaf(NodeId(101), None, NodeKind::Instance);
        instance.name = "Card instance".into();
        instance.extensions.insert(
            "figma.instance.metadata.v1".into(),
            br#"{"mainComponentId":"00000000-0000-0000-0000-000000000201","scaleFactor":1.25,"componentProperties":{"Enabled":true},"overrides":[{"id":"00000000-0000-0000-0000-000000000102","overriddenFields":["fill"]}],"isExposedInstance":false}"#.to_vec(),
        );
        let mut instance_child = leaf(NodeId(102), Some(instance.id), NodeKind::Rectangle);
        instance_child.name = "Locked hidden override".into();
        instance_child.visible = false;
        instance_child.locked = true;
        let mut component = leaf(NodeId(201), None, NodeKind::Component);
        component.name = "Remote card".into();
        component.extensions.insert(
            "figma.component.metadata.v1".into(),
            br#"{"key":"remote-card-key","remote":true,"description":"Cross-page component fixture","descriptionMarkdown":"","documentationLinks":[],"componentPropertyDefinitions":{"Enabled":{"type":"BOOLEAN","defaultValue":true}}}"#.to_vec(),
        );
        let mut source_slot = leaf(NodeId(202), Some(component.id), NodeKind::Slot);
        source_slot.name = "Content slot".into();
        source_slot.extensions.insert(
            "figma.slot.metadata.v1".into(),
            br#"{"propertyName":"Content"}"#.to_vec(),
        );
        let mut override_slot = leaf(NodeId(203), Some(component.id), NodeKind::Slot);
        override_slot.name = "Content override slot".into();
        override_slot.extensions.insert(
            "figma.slot.metadata.v1".into(),
            br#"{"propertyName":"Content override","sourceSlotId":"00000000-0000-0000-0000-000000000202"}"#.to_vec(),
        );
        let nodes = [
            (PageId(2), instance),
            (PageId(2), instance_child),
            (PageId(3), component),
            (PageId(3), source_slot),
            (PageId(3), override_slot),
        ];
        let mut operations = pages
            .iter()
            .cloned()
            .map(|page| v1::ResolvedOperation {
                kind: Some(v1::resolved_operation::Kind::CreatePage(v1::CreatePage {
                    page: Some(v1::PageRef {
                        page_id: page.id.0.to_be_bytes().to_vec(),
                        name: page.name,
                        position_id: Some(position_to_proto(page.position)),
                    }),
                })),
            })
            .collect::<Vec<_>>();
        operations.extend(nodes.iter().map(|(page_id, node)| v1::ResolvedOperation {
            kind: Some(v1::resolved_operation::Kind::CreateNode(v1::CreateNode {
                node: Some(node_to_proto(
                    node,
                    *page_id,
                    None,
                    None,
                    AutoLayout::default(),
                    None,
                    None,
                    None,
                )),
            })),
        }));
        let payload = v1::ResolvedOperationBatch { operations }.encode_to_vec();
        let envelope = v1::OperationEnvelope {
            schema_version: 1,
            document_id: document_id.to_vec(),
            operation_id: 31_u128.to_be_bytes().to_vec(),
            transaction_id: 31_u128.to_be_bytes().to_vec(),
            actor_id: actor_id.to_vec(),
            session_id: 9_u128.to_be_bytes().to_vec(),
            client_sequence: 31,
            base_revision: 0,
            causal_parent_ids: vec![],
            payload_hash: Sha256::digest(&payload).to_vec(),
            payload,
            engine_semantics_version: Some(semantics),
        }
        .encode_to_vec();
        let principal = TrustedPrincipal {
            tenant_id,
            actor_id,
        };
        let first = service.submit(principal, &envelope).unwrap();
        let replay = service.submit(principal, &envelope).unwrap();
        assert_eq!(first.accepted_revision, 1);
        assert!(replay.idempotent_replay);
        assert_eq!(replay.document_hash, first.document_hash);

        let stored = service.load_document(document_id).unwrap();
        let restored =
            document_from_snapshot(&stored.snapshot, stored.document_id, stored.document_hash)
                .unwrap();
        assert_eq!(restored.pages().count(), 3);
        assert_eq!(restored.nodes().count(), 5);
        assert_eq!(restored.canonical_hash(), first.document_hash);
        assert_eq!(
            restored
                .node(NodeId(101))
                .unwrap()
                .extensions
                .get("figma.instance.metadata.v1"),
            nodes[0].1.extensions.get("figma.instance.metadata.v1")
        );
        assert_eq!(
            restored
                .node(NodeId(203))
                .unwrap()
                .extensions
                .get("figma.slot.metadata.v1"),
            nodes[4].1.extensions.get("figma.slot.metadata.v1")
        );
        assert!(restored.node(NodeId(102)).unwrap().locked);
        assert!(!restored.node(NodeId(102)).unwrap().visible);
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

    #[test]
    fn service_snapshot_adapter_requires_semantics_twelve_for_text_truncation() {
        let mut document = Document::with_id(DocumentId(54));
        let mut text = leaf(NodeId(54), None, NodeKind::Text);
        text.name = "Truncated text".into();
        text.text = "one two three".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, text).unwrap();
        let properties = TextProperties {
            text_truncation: TextTruncation::Ending,
            max_lines: Some(2),
            ..TextProperties::default()
        };
        document
            .seed_text_properties(NodeId(54), properties.clone())
            .unwrap();

        assert!(
            snapshot_from_document(
                &document,
                makefigma_document_codec::TEXT_TRUNCATION_ENGINE_SEMANTICS_VERSION - 1,
            )
            .is_err()
        );
        let snapshot = snapshot_from_document(
            &document,
            makefigma_document_codec::TEXT_TRUNCATION_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        let restored =
            document_from_snapshot(&snapshot, 54_u128.to_be_bytes(), document.canonical_hash())
                .unwrap();
        assert_eq!(
            restored.text_properties_for_node(NodeId(54)),
            Some(&properties)
        );
    }

    #[test]
    fn service_snapshot_adapter_requires_semantics_fifty_seven_for_grid_hug_tracks() {
        let mut document = Document::with_id(DocumentId(71));
        let mut frame = leaf(NodeId(71), None, NodeKind::Frame);
        frame.name = "Grid".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, frame).unwrap();
        let layout = AutoLayout {
            mode: LayoutMode::Grid,
            grid_rows: vec![GridTrack::Hug],
            grid_columns: vec![GridTrack::Fixed(80.0)],
            ..AutoLayout::default()
        };
        document
            .seed_auto_layout(NodeId(71), layout.clone())
            .unwrap();

        assert!(
            snapshot_from_document(
                &document,
                makefigma_document_codec::GRID_AUTO_LAYOUT_ENGINE_SEMANTICS_VERSION,
            )
            .is_err()
        );
        let snapshot = snapshot_from_document(
            &document,
            makefigma_document_codec::GRID_HUG_TRACK_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        let restored =
            document_from_snapshot(&snapshot, 71_u128.to_be_bytes(), document.canonical_hash())
                .unwrap();
        assert_eq!(restored.auto_layout_for_node(NodeId(71)), layout);
    }

    #[test]
    fn service_snapshot_adapter_requires_semantics_fifty_eight_for_grid_spans() {
        let mut document = Document::with_id(DocumentId(72));
        let mut child = leaf(NodeId(72), None, NodeKind::Rectangle);
        child.name = "Spanning child".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, child).unwrap();
        let layout = AutoLayout {
            grid_row_span: Some(2),
            grid_column_span: Some(3),
            ..AutoLayout::default()
        };
        document
            .seed_auto_layout(NodeId(72), layout.clone())
            .unwrap();

        assert!(
            snapshot_from_document(
                &document,
                makefigma_document_codec::GRID_HUG_TRACK_ENGINE_SEMANTICS_VERSION,
            )
            .is_err()
        );
        let snapshot = snapshot_from_document(
            &document,
            makefigma_document_codec::GRID_SPAN_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        let restored =
            document_from_snapshot(&snapshot, 72_u128.to_be_bytes(), document.canonical_hash())
                .unwrap();
        assert_eq!(restored.auto_layout_for_node(NodeId(72)), layout);
    }

    #[test]
    fn service_snapshot_adapter_requires_semantics_fifty_nine_for_manual_grid() {
        let mut document = Document::with_id(DocumentId(73));
        let mut frame = leaf(NodeId(73), None, NodeKind::Frame);
        frame.name = "Manual grid".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, frame).unwrap();
        let layout = AutoLayout {
            mode: LayoutMode::Grid,
            grid_rows: vec![GridTrack::Fixed(50.0)],
            grid_columns: vec![GridTrack::Fixed(80.0)],
            grid_items_positioning: GridItemsPositioning::Manual,
            ..AutoLayout::default()
        };
        document
            .seed_auto_layout(NodeId(73), layout.clone())
            .unwrap();
        assert!(
            snapshot_from_document(
                &document,
                makefigma_document_codec::GRID_SPAN_ENGINE_SEMANTICS_VERSION,
            )
            .is_err()
        );
        let snapshot = snapshot_from_document(
            &document,
            makefigma_document_codec::GRID_MANUAL_PLACEMENT_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        let restored =
            document_from_snapshot(&snapshot, 73_u128.to_be_bytes(), document.canonical_hash())
                .unwrap();
        assert_eq!(restored.auto_layout_for_node(NodeId(73)), layout);
    }

    #[test]
    fn service_snapshot_adapter_requires_semantics_sixty_for_grid_auto_rows() {
        let mut document = Document::with_id(DocumentId(74));
        let mut frame = leaf(NodeId(74), None, NodeKind::Frame);
        frame.name = "Automatic rows".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, frame).unwrap();
        let layout = AutoLayout {
            mode: LayoutMode::Grid,
            grid_rows: vec![GridTrack::Flex(1.0)],
            grid_columns: vec![GridTrack::Flex(1.0)],
            grid_auto_tracks: GridAutoTracks::Rows,
            ..AutoLayout::default()
        };
        document
            .seed_auto_layout(NodeId(74), layout.clone())
            .unwrap();
        assert!(
            snapshot_from_document(
                &document,
                makefigma_document_codec::GRID_MANUAL_PLACEMENT_ENGINE_SEMANTICS_VERSION
            )
            .is_err()
        );
        let snapshot = snapshot_from_document(
            &document,
            makefigma_document_codec::GRID_AUTO_ROWS_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        let restored =
            document_from_snapshot(&snapshot, 74_u128.to_be_bytes(), document.canonical_hash())
                .unwrap();
        assert_eq!(restored.auto_layout_for_node(NodeId(74)), layout);
    }

    #[test]
    fn service_snapshot_adapter_requires_semantics_sixty_two_for_grid_container_hug() {
        let mut document = Document::with_id(DocumentId(76));
        let mut frame = leaf(NodeId(76), None, NodeKind::Frame);
        frame.name = "Hug grid".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, frame).unwrap();
        let layout = AutoLayout {
            mode: LayoutMode::Grid,
            primary_sizing: LayoutSizing::Hug,
            counter_sizing: LayoutSizing::Hug,
            grid_rows: vec![GridTrack::Fixed(64.0)],
            grid_columns: vec![GridTrack::Fixed(80.0)],
            ..AutoLayout::default()
        };
        document
            .seed_auto_layout(NodeId(76), layout.clone())
            .unwrap();
        assert!(
            snapshot_from_document(
                &document,
                makefigma_document_codec::GRID_CHILD_ALIGNMENT_ENGINE_SEMANTICS_VERSION,
            )
            .is_err()
        );
        let snapshot = snapshot_from_document(
            &document,
            makefigma_document_codec::GRID_CONTAINER_HUG_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        let restored =
            document_from_snapshot(&snapshot, 76_u128.to_be_bytes(), document.canonical_hash())
                .unwrap();
        assert_eq!(restored.auto_layout_for_node(NodeId(76)), layout);
    }

    #[test]
    fn service_snapshot_adapter_round_trips_effect_styles_at_semantics_sixty_four() {
        let mut document = Document::with_id(DocumentId(77));
        let style = EffectStyleResource {
            id: "S:elevation".into(),
            key: String::new(),
            name: "Elevation".into(),
            description: String::new(),
            description_markdown: String::new(),
            documentation_links: Vec::new(),
            remote: false,
            effects: vec![Effect::LayerBlur(LayerBlur {
                radius: 12.0,
                visible: true,
            })],
        };
        document.seed_effect_style(style.clone()).unwrap();
        assert!(
            snapshot_from_document(
                &document,
                makefigma_document_codec::EFFECT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION - 1,
            )
            .is_err()
        );
        let snapshot = snapshot_from_document(
            &document,
            makefigma_document_codec::EFFECT_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        let restored =
            document_from_snapshot(&snapshot, 77_u128.to_be_bytes(), document.canonical_hash())
                .unwrap();
        assert_eq!(restored.effect_style("S:elevation"), Some(&style));
        assert_eq!(restored.canonical_hash(), document.canonical_hash());
    }

    #[test]
    fn service_snapshot_adapter_round_trips_grid_styles_at_semantics_sixty_five() {
        let mut document = Document::with_id(DocumentId(77));
        let style = GridStyleResource {
            id: "S:columns".into(),
            key: String::new(),
            name: "Columns".into(),
            description: String::new(),
            description_markdown: String::new(),
            documentation_links: Vec::new(),
            remote: false,
            layout_grids: vec![LayoutGrid {
                pattern: LayoutGridPattern::Columns,
                alignment: Some(LayoutGridAlignment::Stretch),
                section_size: None,
                count: Some(12),
                gutter_size: Some(24.0),
                offset: Some(80.0),
                visible: true,
                color: None,
            }],
        };
        document.seed_grid_style(style.clone()).unwrap();
        assert!(
            snapshot_from_document(
                &document,
                makefigma_document_codec::GRID_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION - 1,
            )
            .is_err()
        );
        let snapshot = snapshot_from_document(
            &document,
            makefigma_document_codec::GRID_STYLE_CATALOG_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        let restored =
            document_from_snapshot(&snapshot, 77_u128.to_be_bytes(), document.canonical_hash())
                .unwrap();
        assert_eq!(restored.grid_style("S:columns"), Some(&style));
        assert_eq!(restored.canonical_hash(), document.canonical_hash());
    }

    #[test]
    fn service_snapshot_adapter_requires_semantics_thirteen_for_shape_text_styles() {
        let mut document = Document::with_id(DocumentId(55));
        let mut shape = leaf(NodeId(55), None, NodeKind::ShapeWithText);
        shape.name = "Decision".into();
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
            ..TextProperties::default()
        };
        document
            .seed_text_properties(NodeId(55), properties.clone())
            .unwrap();

        assert!(
            snapshot_from_document(
                &document,
                makefigma_document_codec::SHAPE_WITH_TEXT_TEXT_ENGINE_SEMANTICS_VERSION - 1,
            )
            .is_err()
        );
        let snapshot = snapshot_from_document(
            &document,
            makefigma_document_codec::SHAPE_WITH_TEXT_TEXT_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        let restored =
            document_from_snapshot(&snapshot, 55_u128.to_be_bytes(), document.canonical_hash())
                .unwrap();
        assert_eq!(
            restored.text_properties_for_node(NodeId(55)),
            Some(&properties)
        );
    }

    #[test]
    fn service_snapshot_adapter_round_trips_empty_text_base_style_at_semantics_fifteen() {
        let mut document = Document::with_id(DocumentId(56));
        let mut text = leaf(NodeId(56), None, NodeKind::Text);
        text.name = "Empty styled text".into();
        document.seed_node_on_page(DEFAULT_PAGE_ID, text).unwrap();
        let properties = TextProperties {
            base_style: Some(TextStyleRun {
                start: 0,
                end: 0,
                font: None,
                font_size: 22.0,
                font_weight: 650,
                italic: true,
                letter_spacing: 1.25,
                color: Some(Color::from_srgb_u8([255, 0, 0], 255)),
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
            }),
            ..TextProperties::default()
        };
        document
            .seed_text_properties(NodeId(56), properties.clone())
            .unwrap();

        assert!(
            snapshot_from_document(
                &document,
                makefigma_document_codec::TEXT_BASE_STYLE_ENGINE_SEMANTICS_VERSION - 1,
            )
            .is_err()
        );
        let snapshot = snapshot_from_document(
            &document,
            makefigma_document_codec::TEXT_BASE_STYLE_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        let restored =
            document_from_snapshot(&snapshot, 56_u128.to_be_bytes(), document.canonical_hash())
                .unwrap();
        assert_eq!(
            restored.text_properties_for_node(NodeId(56)),
            Some(&properties)
        );
        assert_eq!(restored.canonical_hash(), document.canonical_hash());
    }

    #[test]
    fn service_snapshot_adapter_round_trips_text_case_at_semantics_sixteen() {
        let mut document = Document::with_id(DocumentId(57));
        let mut text = leaf(NodeId(57), None, NodeKind::Text);
        text.name = "Text case".into();
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
                text_case: Some(TextCase::Title),
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

        assert!(
            snapshot_from_document(
                &document,
                makefigma_document_codec::TEXT_CASE_ENGINE_SEMANTICS_VERSION - 1,
            )
            .is_err()
        );
        let snapshot = snapshot_from_document(
            &document,
            makefigma_document_codec::TEXT_CASE_ENGINE_SEMANTICS_VERSION,
        )
        .unwrap();
        let restored =
            document_from_snapshot(&snapshot, 57_u128.to_be_bytes(), document.canonical_hash())
                .unwrap();
        assert_eq!(
            restored.text_properties_for_node(NodeId(57)),
            Some(&properties)
        );
        assert_eq!(restored.canonical_hash(), document.canonical_hash());
    }

    #[test]
    fn service_snapshot_adapter_round_trips_localized_font_aliases_at_semantics_forty_one() {
        let mut document = Document::with_id(DocumentId(75));
        let asset = AssetReference {
            asset_id: AssetId(75),
            content_hash: [7; 32],
            media_type: "font/ttf".into(),
            byte_length: 512,
            dimensions: None,
            font_faces: vec![FontFaceMetadata {
                face_index: 0,
                family: "Acme Sans".into(),
                style: "Regular".into(),
                aliases: vec![FontNameAlias {
                    family: "思源黑体".into(),
                    style: "常规".into(),
                }],
            }],
        };
        document.seed_asset(asset.clone()).unwrap();
        let required = makefigma_document_codec::FONT_NAME_ALIASES_ENGINE_SEMANTICS_VERSION;

        assert!(snapshot_from_document(&document, required - 1).is_err());
        let snapshot = snapshot_from_document(&document, required).unwrap();
        let restored = document_from_snapshot(
            &snapshot,
            document.id().0.to_be_bytes(),
            document.canonical_hash(),
        )
        .unwrap();
        assert_eq!(restored.asset(asset.asset_id), Some(&asset));

        let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
        mislabeled.engine_semantics_version = required - 1;
        assert_eq!(
            document_from_snapshot(
                &mislabeled.encode_to_vec(),
                document.id().0.to_be_bytes(),
                document.canonical_hash(),
            ),
            Err(ServiceError::ReducerRejected),
        );
    }

    #[test]
    fn service_snapshot_reader_rejects_mislabeled_text_semantics_eighteen_through_forty_three() {
        let cases = [
            (
                makefigma_document_codec::LINE_HEIGHT_UNIT_ENGINE_SEMANTICS_VERSION,
                TextProperties {
                    paragraph: ParagraphStyle {
                        line_height: Some(125.0),
                        line_height_unit: Some(LineHeightUnit::Percent),
                        ..TextProperties::default().paragraph
                    },
                    ..TextProperties::default()
                },
            ),
            (
                makefigma_document_codec::PARAGRAPH_INDENT_ENGINE_SEMANTICS_VERSION,
                TextProperties {
                    paragraph: ParagraphStyle {
                        paragraph_indent: Some(12.0),
                        ..TextProperties::default().paragraph
                    },
                    ..TextProperties::default()
                },
            ),
            (
                makefigma_document_codec::TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION,
                TextProperties {
                    paragraph: ParagraphStyle {
                        text_wrap_style: Some(TextWrapStyle::Pretty),
                        list_type: None,
                        list_spacing: None,
                        hanging_list: false,
                        hanging_punctuation: false,
                        ..TextProperties::default().paragraph
                    },
                    ..TextProperties::default()
                },
            ),
            (
                makefigma_document_codec::TEXT_HYPERLINK_ENGINE_SEMANTICS_VERSION,
                TextProperties {
                    runs: vec![TextStyleRun {
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
                        hyperlink: Some(HyperlinkTarget {
                            kind: HyperlinkType::Node,
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
                        paint_style_id: None,
                        variable_bindings: Default::default(),
                        text_decoration_color: None,
                    }],
                    ..TextProperties::default()
                },
            ),
            (
                makefigma_document_codec::TEXT_DECORATION_ENGINE_SEMANTICS_VERSION,
                TextProperties {
                    runs: vec![TextStyleRun {
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
                        text_decoration: Some(TextDecoration::Strikethrough),
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
                },
            ),
            (
                makefigma_document_codec::TEXT_DECORATION_STYLE_ENGINE_SEMANTICS_VERSION,
                TextProperties {
                    runs: vec![TextStyleRun {
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
                },
            ),
            (
                makefigma_document_codec::TEXT_DECORATION_OFFSET_ENGINE_SEMANTICS_VERSION,
                TextProperties {
                    runs: vec![TextStyleRun {
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
                        text_decoration: Some(TextDecoration::Underline),
                        text_decoration_style: None,
                        text_decoration_offset: Some(TextDecorationOffset::Pixels(2.5)),
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
                },
            ),
            (
                makefigma_document_codec::TEXT_DECORATION_THICKNESS_ENGINE_SEMANTICS_VERSION,
                TextProperties {
                    runs: vec![TextStyleRun {
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
                        text_decoration: Some(TextDecoration::Underline),
                        text_decoration_style: None,
                        text_decoration_offset: None,
                        text_decoration_thickness: Some(TextDecorationThickness::Pixels(2.0)),
                        text_decoration_skip_ink: None,
                        leading_trim: None,
                        open_type_features: Vec::new(),
                        text_style_id: None,
                        paint_style_id: None,
                        variable_bindings: Default::default(),
                        text_decoration_color: None,
                    }],
                    ..TextProperties::default()
                },
            ),
            (
                makefigma_document_codec::TEXT_DECORATION_COLOR_ENGINE_SEMANTICS_VERSION,
                TextProperties {
                    runs: vec![TextStyleRun {
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
                },
            ),
            (
                makefigma_document_codec::TEXT_DECORATION_SKIP_INK_ENGINE_SEMANTICS_VERSION,
                TextProperties {
                    runs: vec![TextStyleRun {
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
                        text_decoration: Some(TextDecoration::Underline),
                        text_decoration_style: None,
                        text_decoration_offset: None,
                        text_decoration_thickness: None,
                        text_decoration_skip_ink: Some(true),
                        leading_trim: None,
                        open_type_features: Vec::new(),
                        text_style_id: None,
                        paint_style_id: None,
                        variable_bindings: Default::default(),
                        text_decoration_color: None,
                    }],
                    ..TextProperties::default()
                },
            ),
            (
                makefigma_document_codec::LEADING_TRIM_ENGINE_SEMANTICS_VERSION,
                TextProperties {
                    runs: vec![TextStyleRun {
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
                        text_decoration: None,
                        text_decoration_style: None,
                        text_decoration_offset: None,
                        text_decoration_thickness: None,
                        text_decoration_skip_ink: None,
                        leading_trim: Some(LeadingTrim::CapHeight),
                        open_type_features: Vec::new(),
                        text_style_id: None,
                        paint_style_id: None,
                        variable_bindings: Default::default(),
                        text_decoration_color: None,
                    }],
                    ..TextProperties::default()
                },
            ),
            (
                makefigma_document_codec::TEXT_LIST_TYPE_ENGINE_SEMANTICS_VERSION,
                TextProperties {
                    paragraph: ParagraphStyle {
                        list_type: Some(TextListType::Unordered),
                        ..TextProperties::default().paragraph
                    },
                    ..TextProperties::default()
                },
            ),
            (
                makefigma_document_codec::TEXT_LIST_SPACING_ENGINE_SEMANTICS_VERSION,
                TextProperties {
                    paragraph: ParagraphStyle {
                        list_spacing: Some(8.0),
                        hanging_list: false,
                        hanging_punctuation: false,
                        ..TextProperties::default().paragraph
                    },
                    ..TextProperties::default()
                },
            ),
            (
                makefigma_document_codec::PARAGRAPH_STYLE_RUNS_ENGINE_SEMANTICS_VERSION,
                TextProperties {
                    paragraph_style_runs: vec![ParagraphStyleRun {
                        start: 0,
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
                },
            ),
            (
                makefigma_document_codec::TEXT_HANGING_LIST_ENGINE_SEMANTICS_VERSION,
                TextProperties {
                    paragraph: ParagraphStyle {
                        list_type: Some(TextListType::Ordered),
                        hanging_list: true,
                        hanging_punctuation: false,
                        ..TextProperties::default().paragraph
                    },
                    ..TextProperties::default()
                },
            ),
            (
                makefigma_document_codec::PARAGRAPH_LIST_OPTIONS_ENGINE_SEMANTICS_VERSION,
                TextProperties {
                    paragraph_style_runs: vec![ParagraphStyleRun {
                        start: 0,
                        indentation: None,
                        list_type: Some(ParagraphListType::Ordered),
                        list_spacing: None,
                        paragraph_spacing: None,
                        paragraph_indent: None,
                        line_height: None,
                        line_height_unit: None,
                        text_wrap_style: None,
                    }],
                    ..TextProperties::default()
                },
            ),
            (
                makefigma_document_codec::PARAGRAPH_LIST_SPACING_ENGINE_SEMANTICS_VERSION,
                TextProperties {
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
                },
            ),
            (
                makefigma_document_codec::PARAGRAPH_SPACING_ENGINE_SEMANTICS_VERSION,
                TextProperties {
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
                },
            ),
            (
                makefigma_document_codec::PARAGRAPH_INDENT_RUN_ENGINE_SEMANTICS_VERSION,
                TextProperties {
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
                },
            ),
            (
                makefigma_document_codec::PARAGRAPH_LINE_HEIGHT_ENGINE_SEMANTICS_VERSION,
                TextProperties {
                    paragraph_style_runs: vec![ParagraphStyleRun {
                        start: 0,
                        indentation: None,
                        list_type: None,
                        list_spacing: None,
                        paragraph_spacing: None,
                        paragraph_indent: None,
                        line_height: None,
                        line_height_unit: Some(LineHeightUnit::Auto),
                        text_wrap_style: None,
                    }],
                    ..TextProperties::default()
                },
            ),
            (
                makefigma_document_codec::TEXT_HANGING_PUNCTUATION_ENGINE_SEMANTICS_VERSION,
                TextProperties {
                    paragraph: ParagraphStyle {
                        hanging_punctuation: true,
                        ..TextProperties::default().paragraph
                    },
                    ..TextProperties::default()
                },
            ),
            (
                makefigma_document_codec::PARAGRAPH_TEXT_WRAP_STYLE_ENGINE_SEMANTICS_VERSION,
                TextProperties {
                    paragraph: ParagraphStyle {
                        text_wrap_style: Some(TextWrapStyle::Balance),
                        ..TextProperties::default().paragraph
                    },
                    paragraph_style_runs: vec![ParagraphStyleRun {
                        start: 0,
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
                },
            ),
            (
                makefigma_document_codec::TEXT_STYLE_LINK_ENGINE_SEMANTICS_VERSION,
                TextProperties {
                    runs: vec![TextStyleRun {
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
                        text_decoration: None,
                        text_decoration_style: None,
                        text_decoration_offset: None,
                        text_decoration_thickness: None,
                        text_decoration_skip_ink: None,
                        leading_trim: None,
                        open_type_features: Vec::new(),
                        text_style_id: Some("S:heading".into()),
                        paint_style_id: None,
                        variable_bindings: Default::default(),
                        text_decoration_color: None,
                    }],
                    ..TextProperties::default()
                },
            ),
        ];

        for (index, (required, properties)) in cases.into_iter().enumerate() {
            let id = 70 + index as u128;
            let mut document = Document::with_id(DocumentId(id));
            let mut text = leaf(NodeId(id), None, NodeKind::Text);
            text.name = format!("Text semantics {required}");
            text.text = "A".into();
            document.seed_node_on_page(DEFAULT_PAGE_ID, text).unwrap();
            document
                .seed_text_properties(NodeId(id), properties)
                .unwrap();
            assert!(
                snapshot_from_document(&document, required - 1).is_err(),
                "semantics {required} must reject a lower writer declaration",
            );
            let snapshot = snapshot_from_document(&document, required).unwrap();
            let mut mislabeled = v1::DocumentSnapshot::decode(snapshot.as_slice()).unwrap();
            mislabeled.engine_semantics_version = required - 1;
            assert_eq!(
                document_from_snapshot(
                    &mislabeled.encode_to_vec(),
                    id.to_be_bytes(),
                    document.canonical_hash(),
                ),
                Err(ServiceError::ReducerRejected),
                "semantics {required} must reject a lower declaration",
            );
        }
    }
}
