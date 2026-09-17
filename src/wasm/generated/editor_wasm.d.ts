/* tslint:disable */
/* eslint-disable */

export class DocumentEngine {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Accepts one concrete, all-or-nothing command batch from the Engine Worker.
     * The payload has no UI selection or live pointer state and therefore can be
     * replayed by the same reducer used by other runtimes.
     */
    apply_transaction_json(transaction_id: string, base_revision: bigint, commands_json: string): bigint;
    canonical_hash(): string;
    /**
     * A deliberately narrow first bridge operation. It proves that JS can submit a
     * versioned intent to the same Rust reducer used by the future backend service.
     */
    create_node(transaction_id: string, base_revision: bigint, node_id: string, kind: string, name: string, x: number, y: number, width: number, height: number, rotation: number, fill: string, stroke: string, stroke_width: number, opacity: number, corner_radius: number, visible: boolean, locked: boolean, text: string): bigint;
    create_node_on_page(transaction_id: string, base_revision: bigint, page_id: string, node_id: string, kind: string, name: string, x: number, y: number, width: number, height: number, rotation: number, fill: string, stroke: string, stroke_width: number, opacity: number, corner_radius: number, visible: boolean, locked: boolean, text: string): bigint;
    /**
     * Creates a durable top-level Figma-style Page. The worker decides which Page
     * is active for the current view; Page order and identity remain canonical.
     */
    create_page(transaction_id: string, base_revision: bigint, page_id: string, name: string): bigint;
    /**
     * Creates a Page at an explicit Canonical PositionId. REST imports use
     * this path so their source order is not replaced by ID-derived order in
     * the browser before the equivalent protobuf operation reaches Service.
     */
    create_page_at_position(transaction_id: string, base_revision: bigint, page_id: string, name: string, position_id: string): bigint;
    /**
     * `node_ids` is a comma-separated sequence of validated UUIDs. The format is
     * intentionally narrow because this is an internal Worker-to-WASM boundary.
     */
    delete_nodes(transaction_id: string, base_revision: bigint, node_ids: string): bigint;
    /**
     * Produces the 16-float solid-shape instance layout consumed by the
     * WebGPU/WGSL executor. It filters to one active Page and intentionally
     * leaves Image/Text to their own Render Graph passes.
     */
    gpu_scene_instances_json(page_id: string): string;
    /**
     * Restores a versioned Core snapshot. This deliberately restores no undo history:
     * snapshots represent a confirmed durable state, while a future journal will carry
     * operations that happened after it.
     */
    load_snapshot_json(value: string): bigint;
    load_snapshot_protobuf(bytes: Uint8Array): bigint;
    memory_stats_json(): string;
    /**
     * Keeps a pointer drag as one semantic history item, even when several nodes move.
     */
    move_nodes(transaction_id: string, base_revision: bigint, updates_json: string): bigint;
    constructor();
    /**
     * Executes a resize-shaped Update batch against a structurally shared,
     * disposable document and returns only the nodes changed by Core. The live
     * document's revision, history and operation-dedupe state remain untouched.
     * The Engine Worker uses this during pointer movement so the transient
     * Frame/child geometry is produced by the same reducer as pointer-up.
     */
    preview_resize_transaction_json(transaction_id: string, commands_json: string): string;
    redo(): bigint;
    /**
     * Adds only an already-admitted Asset Service record to the Canonical
     * Resource Index. Bytes remain owned by the resource service.
     */
    register_asset(transaction_id: string, base_revision: bigint, asset_id: string, content_hash: string, media_type: string, byte_length: bigint, pixel_width: number, pixel_height: number, font_faces_json: string): bigint;
    rename_node(transaction_id: string, base_revision: bigint, node_id: string, name: string): bigint;
    /**
     * Equivalent to [`Self::render_graph_plan_json`], scoped to the active
     * Canonical Page. A renderer must not accidentally schedule hidden pages
     * merely because their coordinates intersect the current viewport.
     */
    render_graph_plan_for_page_json(page_id: string, viewport_x: number, viewport_y: number, viewport_width: number, viewport_height: number): string;
    /**
     * Projects the current Canonical Document into the GPU-handle-free Rust
     * Render Graph plan. The Worker can execute this plan with WebGPU or use
     * its explicit Canvas fallback; neither path gets ownership of Document.
     */
    render_graph_plan_json(viewport_x: number, viewport_y: number, viewport_width: number, viewport_height: number): string;
    /**
     * Adds trusted legacy fixture metadata before `seed_batch_json` installs
     * image or font references. Bytes are deliberately not accepted here.
     */
    seed_assets_json(value: string): void;
    /**
     * Installs a trusted legacy projection without adding history. Unlike the narrow
     * v1 seed_node bridge, this carries the full v7 paint projection during one-time
     * hydration of older local records and fixtures.
     */
    seed_batch_json(value: string): bigint;
    /**
     * Sets the document identity before legacy projection hydration. The old
     * browser path serialized and reparsed the entire hydrated document only
     * to replace this field, doubling the live 100k-node state at peak.
     */
    seed_document_id(document_id: string): void;
    /**
     * Loads an existing local snapshot without turning document hydration into a user
     * undo step. Only the Worker uses this while bootstrapping the projection.
     */
    seed_node(transaction_id: string, base_revision: bigint, node_id: string, kind: string, name: string, x: number, y: number, width: number, height: number, rotation: number, fill: string, stroke: string, stroke_width: number, opacity: number, corner_radius: number, visible: boolean, locked: boolean, text: string): bigint;
    /**
     * Sets the Canonical default profile for the document. The profile does not
     * reinterpret existing explicit Colors; it governs future profile-aware assets.
     */
    set_document_color_profile(transaction_id: string, base_revision: bigint, profile: string): bigint;
    snapshot_json(): string;
    /**
     * Durable wire snapshot shared with the server-side Document Service. The
     * JSON projection remains local-storage-only; this payload is the boundary
     * used to safely bootstrap and recover a remote document.
     */
    snapshot_protobuf(): Uint8Array;
    undo(): bigint;
    /**
     * Applies geometry and name as one atomic Rust transaction, so a failed name
     * validation cannot leave a partially applied resize in the browser document.
     */
    update_node(transaction_id: string, base_revision: bigint, node_id: string, name: string, x: number, y: number, width: number, height: number, rotation: number, fill: string, stroke: string, stroke_width: number, opacity: number, corner_radius: number, visible: boolean, locked: boolean, text: string): bigint;
    readonly can_redo: boolean;
    readonly can_undo: boolean;
    readonly revision: bigint;
}

/**
 * Returns one transient Boolean outline for two or more VectorPath operands.
 * The input and output are projection data only: the editable source paths and
 * BooleanOperation children remain Canonical, while Canvas, hit tests and
 * exporters can consume this one validated Rust-derived result.
 */
export function boolean_vector_paths_json(operation: string, operands_json: string, tolerance: number): string;

export function dashed_line_outline_json(width: number, stroke_width: number, dash_json: string, cap: string, join: string, miter_limit: number): string;

/**
 * Projects a decorative Line endpoint marker (arrowhead, diamond or dot) from
 * the same Core geometry the Canvas renderer, hit test and SVG export consume.
 * `endpoint`/`direction` place and orient the marker in the Line's local space
 * (`direction` is `-1` at the start, `1` at the end); `stroke_width` sizes it.
 */
export function decorative_cap_mesh_json(cap: string, endpoint: number, direction: number, stroke_width: number): string;

export function engine_semantics_version(): number;

/**
 * Returns a deterministic, UTF-8 byte-addressed fallback layout for selection,
 * caret, and IME clients. This boundary owns neither a canvas nor a font: the
 * presentation renderer may refine glyph positions without changing the saved
 * document text or its canonical byte offsets.
 */
export function fallback_text_layout_json(text: string, max_graphemes_per_line: number): string;

/**
 * Builds a transient GPU instance projection from a validated Core snapshot
 * without borrowing the live browser editing engine. The renderer owns this
 * derived data only; edits and history remain on its separate DocumentEngine.
 * Keeping the projection receiver-free avoids a wasm-bindgen borrow spanning a
 * browser Worker render read and a later mutable transaction.
 */
export function gpu_scene_instances_from_snapshot_json(snapshot_json: string, page_id: string): string;

/**
 * Produces ICU4X line ranges and Rustybuzz advances from explicit font bytes.
 * The width is measured in em, so viewport zoom never changes the derived
 * source ranges. Glyph pixels remain a renderer-owned cache.
 */
export function layout_shaped_text_json(font_bytes: Uint8Array, face_index: number, text: string, max_width_em: number): string;

/**
 * Shapes metric-bearing Style Runs from one bounded concatenated font bundle.
 * `runs_json` references byte windows in that bundle so callers do not encode
 * large font files as JSON or persist them in the Canonical document.
 */
export function layout_shaped_text_runs_json(font_bundle: Uint8Array, runs_json: string, text: string, max_width_px: number): string;

/**
 * Variant of `layout_shaped_text_runs_json` whose JSON array supplies one
 * non-negative document-pixel first-line inset per hard-break paragraph.
 */
export function layout_shaped_text_runs_with_first_line_indents_json(font_bundle: Uint8Array, runs_json: string, text: string, max_width_px: number, first_line_indents_json: string): string;

/**
 * Shapes per-paragraph first-line indents and AUTO/BALANCE/PRETTY policies
 * through one bounded transient options boundary.
 */
export function layout_shaped_text_runs_with_paragraph_options_json(font_bundle: Uint8Array, runs_json: string, text: string, max_width_px: number, first_line_indents_json: string, paragraph_wrap_styles_json: string): string;

/**
 * Produces ICU4X line ranges at the same Variable Font coordinates used by
 * the shaping and glyph-raster stages.
 */
export function layout_shaped_text_with_variations_json(font_bytes: Uint8Array, face_index: number, variation_axes_json: string, text: string, max_width_em: number): string;

/**
 * Converts a solid straight Line and either standard or decorative endpoint
 * caps into one unioned editable outline. Dashed lines remain deliberately
 * excluded because their terminal-cap semantics differ per dash run.
 */
export function line_outline_json(width: number, stroke_width: number, start_cap: string, end_cap: string, join: string, miter_limit: number): string;

/**
 * Canonical non-zero fill containment for editable Polygon/Star nodes. The
 * document stores only parameters; this recomputes the bounded Core outline.
 */
export function parametric_shape_contains_point_json(width: number, height: number, shape_json: string, x: number, y: number): boolean;

/**
 * Returns the one Core-derived local contour for an ADR 0026 Polygon or Star.
 * It is transient presentation geometry only; the canonical document continues
 * to store the bounded parametric record rather than this generated point list.
 */
export function parametric_shape_outline_json(width: number, height: number, shape_json: string): string;

/**
 * Produces a transient text-edit/IME preview. It has no DocumentEngine
 * receiver by design: only a composition commit crosses into Canonical
 * Document as an atomic text transaction.
 */
export function preview_text_replacement_json(text: string, anchor: number, focus: number, replacement: string): string;

/**
 * Produces a bounded, deterministic glyph alpha mask from explicit font
 * bytes. The result is presentation-only input for a renderer-owned atlas;
 * neither the pixels nor the placement can enter Canonical Document state.
 */
export function rasterize_glyph_json(font_bytes: Uint8Array, face_index: number, glyph_id: number, pixel_size: number): string;

/**
 * Rasterizes one explicit glyph with the same variation coordinates and
 * synthetic weight/style identity used by the owning metric Style Run.
 */
export function rasterize_glyph_with_style_json(font_bytes: Uint8Array, face_index: number, variation_axes_json: string, font_weight: number, italic: boolean, glyph_id: number, pixel_size: number): string;

/**
 * Rasterizes at the same declared variation coordinates as shaping. Pixels
 * remain an ephemeral renderer resource and never enter Canonical Document.
 */
export function rasterize_glyph_with_variations_json(font_bytes: Uint8Array, face_index: number, variation_axes_json: string, glyph_id: number, pixel_size: number): string;

/**
 * Shapes text from explicit font bytes without using browser font metrics.
 * This is presentation-only data; persisted text and font references remain
 * owned by Canonical Document and commit through the normal transaction path.
 */
export function shape_text_json(font_bytes: Uint8Array, face_index: number, text: string, direction: string): string;

/**
 * Projects the shared Figma-style Corner Smoothing approximation. An empty
 * Dash array means solid; otherwise Core emits only the visible dash runs.
 */
export function stroke_mesh_for_continuous_rounded_rectangle_with_radii_json(width: number, height: number, radii_json: string, smoothing: number, stroke_width: number, dash_json: string, join: string, miter_limit: number): string;

/**
 * Projects the visible dashes of a straight Line from the same Core mesh
 * source used by hit testing and selection bounds.
 */
export function stroke_mesh_for_dashed_line_json(width: number, stroke_width: number, dash_json: string, cap: string, join: string, miter_limit: number): string;

/**
 * Projects visible dashes of an arbitrary open or closed polyline. A dashed
 * Frame/Rectangle uses this boundary so its corner joins are not re-derived
 * by Canvas.
 */
export function stroke_mesh_for_dashed_polyline_json(points_json: string, stroke_width: number, dash_json: string, cap: string, join: string, miter_limit: number, closed: boolean): string;

/**
 * Projects the canonical dashed independent-radius rounded-rectangle outline.
 */
export function stroke_mesh_for_dashed_rounded_rectangle_with_radii_json(width: number, height: number, radii_json: string, stroke_width: number, dash_json: string, join: string, miter_limit: number): string;

/**
 * Projects the canonical Rust stroke tessellation through the WASM boundary.
 * The returned triangles are presentation data only: neither a mesh nor its
 * cache can become durable document state. Keeping this conversion here gives
 * Canvas, WebGPU and export callers one finite, validated geometry source.
 */
export function stroke_mesh_for_polyline_json(points_json: string, width: number, cap: string, join: string, miter_limit: number, closed: boolean): string;

/**
 * Projects the canonical uniform rounded-rectangle stroke outline. This is a
 * presentation-only mesh; it cannot become document state and therefore
 * keeps the same finite validation boundary as polyline tessellation.
 */
export function stroke_mesh_for_rounded_rectangle_json(width: number, height: number, radius: number, stroke_width: number, join: string, miter_limit: number): string;

/**
 * Projects a canonical four-corner rounded-rectangle stroke outline. Radii
 * are TL/TR/BR/BL and are normalized by Core before tessellation.
 */
export function stroke_mesh_for_rounded_rectangle_with_radii_json(width: number, height: number, radii_json: string, stroke_width: number, join: string, miter_limit: number): string;

/**
 * Projects the four independently weighted square-corner rectangle edges
 * from Core. The ordered meshes retain their separate paint-stack passes.
 */
export function stroke_meshes_for_per_side_rectangle_json(width: number, height: number, weights_json: string, align: string): string;

/**
 * Projects independently weighted square-corner rectangle dashes from Core.
 * The dash phase intentionally restarts on each independent edge, matching
 * the existing per-side rendering contract.
 */
export function stroke_meshes_for_per_side_rectangle_with_dash_json(width: number, height: number, weights_json: string, align: string, dash_json: string): string;

/**
 * Canonical fill containment for Worker hit tests. Open subpaths do not
 * contribute to fill containment; stroke hits use the separate mesh bridge.
 */
export function vector_path_contains_json(path_json: string, x: number, y: number, tolerance: number): boolean;

export function vector_path_dashed_outline_json(path_json: string, tolerance: number, width: number, dash_json: string, cap: string, join: string, miter_limit: number): string;

/**
 * Returns the budgeted Core flattening for a JSON-projected VectorPath. This
 * is presentation data only; callers must never persist the returned points.
 */
export function vector_path_geometry_json(path_json: string, tolerance: number): string;

/**
 * Finds the nearest editable original VectorPath segment for direct canvas
 * splitting. Its `t` is Core-derived and can be passed unchanged to the
 * Canonical SplitVectorSegment command.
 */
export function vector_path_nearest_segment_json(path_json: string, x: number, y: number, tolerance: number, max_distance: number): string;

/**
 * Expands a VectorPath stroke through the same Core tessellation used by the
 * Canvas fallback and stroke hit testing, then unions that mesh into editable
 * closed VectorPath contours for the Outline Stroke command.
 */
export function vector_path_outline_json(path_json: string, tolerance: number, width: number, cap: string, join: string, miter_limit: number): string;

/**
 * As [`vector_path_outline_json`], but open paths can use different standard
 * caps at their start and end. Decorative caps remain a Line rendering mode.
 */
export function vector_path_outline_with_caps_json(path_json: string, tolerance: number, width: number, start_cap: string, end_cap: string, join: string, miter_limit: number): string;

export function vector_path_stroke_contains_json(path_json: string, x: number, y: number, tolerance: number, width: number, cap: string, join: string, miter_limit: number): boolean;

/**
 * Projects the Core VectorPath stroke mesh for Canvas fallback or a future
 * GPU upload. Unlike an HTML canvas stroke, this shares Core's joins, caps
 * and transient geometry budget with precise stroke hit testing.
 */
export function vector_path_stroke_mesh_json(path_json: string, tolerance: number, width: number, cap: string, join: string, miter_limit: number): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_documentengine_free: (a: number, b: number) => void;
    readonly boolean_vector_paths_json: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly dashed_line_outline_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number, number];
    readonly decorative_cap_mesh_json: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly documentengine_apply_transaction_json: (a: number, b: number, c: number, d: bigint, e: number, f: number) => [bigint, number, number];
    readonly documentengine_can_redo: (a: number) => number;
    readonly documentengine_can_undo: (a: number) => number;
    readonly documentengine_canonical_hash: (a: number) => [number, number];
    readonly documentengine_create_node: (a: number, b: number, c: number, d: bigint, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number, z: number) => [bigint, number, number];
    readonly documentengine_create_node_on_page: (a: number, b: number, c: number, d: bigint, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number, z: number, a1: number, b1: number) => [bigint, number, number];
    readonly documentengine_create_page: (a: number, b: number, c: number, d: bigint, e: number, f: number, g: number, h: number) => [bigint, number, number];
    readonly documentengine_create_page_at_position: (a: number, b: number, c: number, d: bigint, e: number, f: number, g: number, h: number, i: number, j: number) => [bigint, number, number];
    readonly documentengine_delete_nodes: (a: number, b: number, c: number, d: bigint, e: number, f: number) => [bigint, number, number];
    readonly documentengine_gpu_scene_instances_json: (a: number, b: number, c: number) => [number, number, number, number];
    readonly documentengine_load_snapshot_json: (a: number, b: number, c: number) => [bigint, number, number];
    readonly documentengine_load_snapshot_protobuf: (a: number, b: number, c: number) => [bigint, number, number];
    readonly documentengine_memory_stats_json: (a: number) => [number, number];
    readonly documentengine_move_nodes: (a: number, b: number, c: number, d: bigint, e: number, f: number) => [bigint, number, number];
    readonly documentengine_new: () => number;
    readonly documentengine_preview_resize_transaction_json: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly documentengine_redo: (a: number) => [bigint, number, number];
    readonly documentengine_register_asset: (a: number, b: number, c: number, d: bigint, e: number, f: number, g: number, h: number, i: number, j: number, k: bigint, l: number, m: number, n: number, o: number) => [bigint, number, number];
    readonly documentengine_rename_node: (a: number, b: number, c: number, d: bigint, e: number, f: number, g: number, h: number) => [bigint, number, number];
    readonly documentengine_render_graph_plan_for_page_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly documentengine_render_graph_plan_json: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly documentengine_revision: (a: number) => bigint;
    readonly documentengine_seed_assets_json: (a: number, b: number, c: number) => [number, number];
    readonly documentengine_seed_batch_json: (a: number, b: number, c: number) => [bigint, number, number];
    readonly documentengine_seed_document_id: (a: number, b: number, c: number) => [number, number];
    readonly documentengine_seed_node: (a: number, b: number, c: number, d: bigint, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number, z: number) => [bigint, number, number];
    readonly documentengine_set_document_color_profile: (a: number, b: number, c: number, d: bigint, e: number, f: number) => [bigint, number, number];
    readonly documentengine_snapshot_json: (a: number) => [number, number];
    readonly documentengine_snapshot_protobuf: (a: number) => [number, number, number, number];
    readonly documentengine_undo: (a: number) => [bigint, number, number];
    readonly documentengine_update_node: (a: number, b: number, c: number, d: bigint, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number) => [bigint, number, number];
    readonly engine_semantics_version: () => number;
    readonly fallback_text_layout_json: (a: number, b: number, c: number) => [number, number];
    readonly gpu_scene_instances_from_snapshot_json: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly layout_shaped_text_json: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly layout_shaped_text_runs_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly layout_shaped_text_runs_with_first_line_indents_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number, number];
    readonly layout_shaped_text_runs_with_paragraph_options_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number, number];
    readonly layout_shaped_text_with_variations_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly line_outline_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number, number];
    readonly parametric_shape_contains_point_json: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly parametric_shape_outline_json: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly preview_text_replacement_json: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly rasterize_glyph_json: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly rasterize_glyph_with_style_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number, number];
    readonly rasterize_glyph_with_variations_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly shape_text_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly stroke_mesh_for_continuous_rounded_rectangle_with_radii_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number, number];
    readonly stroke_mesh_for_dashed_line_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number, number];
    readonly stroke_mesh_for_dashed_polyline_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number, number];
    readonly stroke_mesh_for_dashed_rounded_rectangle_with_radii_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number, number];
    readonly stroke_mesh_for_polyline_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number, number];
    readonly stroke_mesh_for_rounded_rectangle_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly stroke_mesh_for_rounded_rectangle_with_radii_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly stroke_meshes_for_per_side_rectangle_json: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly stroke_meshes_for_per_side_rectangle_with_dash_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly vector_path_contains_json: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly vector_path_dashed_outline_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number, number];
    readonly vector_path_geometry_json: (a: number, b: number, c: number) => [number, number, number, number];
    readonly vector_path_nearest_segment_json: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly vector_path_outline_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number, number];
    readonly vector_path_outline_with_caps_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number, number];
    readonly vector_path_stroke_contains_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number];
    readonly vector_path_stroke_mesh_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
