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
    /**
     * `node_ids` is a comma-separated sequence of validated UUIDs. The format is
     * intentionally narrow because this is an internal Worker-to-WASM boundary.
     */
    delete_nodes(transaction_id: string, base_revision: bigint, node_ids: string): bigint;
    /**
     * Restores a versioned Core snapshot. This deliberately restores no undo history:
     * snapshots represent a confirmed durable state, while a future journal will carry
     * operations that happened after it.
     */
    load_snapshot_json(value: string): bigint;
    memory_stats_json(): string;
    /**
     * Keeps a pointer drag as one semantic history item, even when several nodes move.
     */
    move_nodes(transaction_id: string, base_revision: bigint, updates_json: string): bigint;
    constructor();
    redo(): bigint;
    rename_node(transaction_id: string, base_revision: bigint, node_id: string, name: string): bigint;
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

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_documentengine_free: (a: number, b: number) => void;
    readonly documentengine_apply_transaction_json: (a: number, b: number, c: number, d: bigint, e: number, f: number) => [bigint, number, number];
    readonly documentengine_can_redo: (a: number) => number;
    readonly documentengine_can_undo: (a: number) => number;
    readonly documentengine_canonical_hash: (a: number) => [number, number];
    readonly documentengine_create_node: (a: number, b: number, c: number, d: bigint, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number, z: number) => [bigint, number, number];
    readonly documentengine_delete_nodes: (a: number, b: number, c: number, d: bigint, e: number, f: number) => [bigint, number, number];
    readonly documentengine_load_snapshot_json: (a: number, b: number, c: number) => [bigint, number, number];
    readonly documentengine_memory_stats_json: (a: number) => [number, number];
    readonly documentengine_move_nodes: (a: number, b: number, c: number, d: bigint, e: number, f: number) => [bigint, number, number];
    readonly documentengine_new: () => number;
    readonly documentengine_redo: (a: number) => [bigint, number, number];
    readonly documentengine_rename_node: (a: number, b: number, c: number, d: bigint, e: number, f: number, g: number, h: number) => [bigint, number, number];
    readonly documentengine_revision: (a: number) => bigint;
    readonly documentengine_seed_batch_json: (a: number, b: number, c: number) => [bigint, number, number];
    readonly documentengine_seed_node: (a: number, b: number, c: number, d: bigint, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number, z: number) => [bigint, number, number];
    readonly documentengine_set_document_color_profile: (a: number, b: number, c: number, d: bigint, e: number, f: number) => [bigint, number, number];
    readonly documentengine_snapshot_json: (a: number) => [number, number];
    readonly documentengine_undo: (a: number) => [bigint, number, number];
    readonly documentengine_update_node: (a: number, b: number, c: number, d: bigint, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number) => [bigint, number, number];
    readonly engine_semantics_version: () => number;
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
