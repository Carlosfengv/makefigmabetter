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
    redo(): bigint;
    /**
     * Adds only an already-admitted Asset Service record to the Canonical
     * Resource Index. Bytes remain owned by the resource service.
     */
    register_asset(transaction_id: string, base_revision: bigint, asset_id: string, content_hash: string, media_type: string, byte_length: bigint, pixel_width: number, pixel_height: number): bigint;
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
     * Installs a trusted legacy projection without adding history. Unlike the narrow
     * v1 seed_node bridge, this carries the full v7 paint projection during one-time
     * hydration of older local records and fixtures.
     */
    seed_batch_json(value: string): bigint;
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

export function engine_semantics_version(): number;

/**
 * Returns a deterministic, UTF-8 byte-addressed fallback layout for selection,
 * caret, and IME clients. This boundary owns neither a canvas nor a font: the
 * presentation renderer may refine glyph positions without changing the saved
 * document text or its canonical byte offsets.
 */
export function fallback_text_layout_json(text: string, max_graphemes_per_line: number): string;

/**
 * Produces ICU4X line ranges and Rustybuzz advances from explicit font bytes.
 * The width is measured in em, so viewport zoom never changes the derived
 * source ranges. Glyph pixels remain a renderer-owned cache.
 */
export function layout_shaped_text_json(font_bytes: Uint8Array, face_index: number, text: string, max_width_em: number): string;

/**
 * Produces ICU4X line ranges at the same Variable Font coordinates used by
 * the shaping and glyph-raster stages.
 */
export function layout_shaped_text_with_variations_json(font_bytes: Uint8Array, face_index: number, variation_axes_json: string, text: string, max_width_em: number): string;

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

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_documentengine_free: (a: number, b: number) => void;
    readonly documentengine_apply_transaction_json: (a: number, b: number, c: number, d: bigint, e: number, f: number) => [bigint, number, number];
    readonly documentengine_can_redo: (a: number) => number;
    readonly documentengine_can_undo: (a: number) => number;
    readonly documentengine_canonical_hash: (a: number) => [number, number];
    readonly documentengine_create_node: (a: number, b: number, c: number, d: bigint, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number, z: number) => [bigint, number, number];
    readonly documentengine_create_node_on_page: (a: number, b: number, c: number, d: bigint, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number, z: number, a1: number, b1: number) => [bigint, number, number];
    readonly documentengine_create_page: (a: number, b: number, c: number, d: bigint, e: number, f: number, g: number, h: number) => [bigint, number, number];
    readonly documentengine_delete_nodes: (a: number, b: number, c: number, d: bigint, e: number, f: number) => [bigint, number, number];
    readonly documentengine_gpu_scene_instances_json: (a: number, b: number, c: number) => [number, number, number, number];
    readonly documentengine_load_snapshot_json: (a: number, b: number, c: number) => [bigint, number, number];
    readonly documentengine_load_snapshot_protobuf: (a: number, b: number, c: number) => [bigint, number, number];
    readonly documentengine_memory_stats_json: (a: number) => [number, number];
    readonly documentengine_move_nodes: (a: number, b: number, c: number, d: bigint, e: number, f: number) => [bigint, number, number];
    readonly documentengine_new: () => number;
    readonly documentengine_redo: (a: number) => [bigint, number, number];
    readonly documentengine_register_asset: (a: number, b: number, c: number, d: bigint, e: number, f: number, g: number, h: number, i: number, j: number, k: bigint, l: number, m: number) => [bigint, number, number];
    readonly documentengine_rename_node: (a: number, b: number, c: number, d: bigint, e: number, f: number, g: number, h: number) => [bigint, number, number];
    readonly documentengine_render_graph_plan_for_page_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly documentengine_render_graph_plan_json: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly documentengine_revision: (a: number) => bigint;
    readonly documentengine_seed_batch_json: (a: number, b: number, c: number) => [bigint, number, number];
    readonly documentengine_seed_node: (a: number, b: number, c: number, d: bigint, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number, z: number) => [bigint, number, number];
    readonly documentengine_set_document_color_profile: (a: number, b: number, c: number, d: bigint, e: number, f: number) => [bigint, number, number];
    readonly documentengine_snapshot_json: (a: number) => [number, number];
    readonly documentengine_snapshot_protobuf: (a: number) => [number, number, number, number];
    readonly documentengine_undo: (a: number) => [bigint, number, number];
    readonly documentengine_update_node: (a: number, b: number, c: number, d: bigint, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number) => [bigint, number, number];
    readonly engine_semantics_version: () => number;
    readonly fallback_text_layout_json: (a: number, b: number, c: number) => [number, number];
    readonly layout_shaped_text_json: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly layout_shaped_text_with_variations_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly preview_text_replacement_json: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly rasterize_glyph_json: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly rasterize_glyph_with_variations_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly shape_text_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
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
