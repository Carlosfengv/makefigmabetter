/* @ts-self-types="./editor_wasm.d.ts" */

export class DocumentEngine {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DocumentEngineFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_documentengine_free(ptr, 0);
    }
    /**
     * Accepts one concrete, all-or-nothing command batch from the Engine Worker.
     * The payload has no UI selection or live pointer state and therefore can be
     * replayed by the same reducer used by other runtimes.
     * @param {string} transaction_id
     * @param {bigint} base_revision
     * @param {string} commands_json
     * @returns {bigint}
     */
    apply_transaction_json(transaction_id, base_revision, commands_json) {
        const ptr0 = passStringToWasm0(transaction_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(commands_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.documentengine_apply_transaction_json(this.__wbg_ptr, ptr0, len0, base_revision, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BigInt.asUintN(64, ret[0]);
    }
    /**
     * @returns {boolean}
     */
    get can_redo() {
        const ret = wasm.documentengine_can_redo(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {boolean}
     */
    get can_undo() {
        const ret = wasm.documentengine_can_undo(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {string}
     */
    canonical_hash() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.documentengine_canonical_hash(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * A deliberately narrow first bridge operation. It proves that JS can submit a
     * versioned intent to the same Rust reducer used by the future backend service.
     * @param {string} transaction_id
     * @param {bigint} base_revision
     * @param {string} node_id
     * @param {string} kind
     * @param {string} name
     * @param {number} x
     * @param {number} y
     * @param {number} width
     * @param {number} height
     * @param {number} rotation
     * @param {string} fill
     * @param {string} stroke
     * @param {number} stroke_width
     * @param {number} opacity
     * @param {number} corner_radius
     * @param {boolean} visible
     * @param {boolean} locked
     * @param {string} text
     * @returns {bigint}
     */
    create_node(transaction_id, base_revision, node_id, kind, name, x, y, width, height, rotation, fill, stroke, stroke_width, opacity, corner_radius, visible, locked, text) {
        const ptr0 = passStringToWasm0(transaction_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(node_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(kind, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(fill, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passStringToWasm0(stroke, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len6 = WASM_VECTOR_LEN;
        const ret = wasm.documentengine_create_node(this.__wbg_ptr, ptr0, len0, base_revision, ptr1, len1, ptr2, len2, ptr3, len3, x, y, width, height, rotation, ptr4, len4, ptr5, len5, stroke_width, opacity, corner_radius, visible, locked, ptr6, len6);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BigInt.asUintN(64, ret[0]);
    }
    /**
     * @param {string} transaction_id
     * @param {bigint} base_revision
     * @param {string} page_id
     * @param {string} node_id
     * @param {string} kind
     * @param {string} name
     * @param {number} x
     * @param {number} y
     * @param {number} width
     * @param {number} height
     * @param {number} rotation
     * @param {string} fill
     * @param {string} stroke
     * @param {number} stroke_width
     * @param {number} opacity
     * @param {number} corner_radius
     * @param {boolean} visible
     * @param {boolean} locked
     * @param {string} text
     * @returns {bigint}
     */
    create_node_on_page(transaction_id, base_revision, page_id, node_id, kind, name, x, y, width, height, rotation, fill, stroke, stroke_width, opacity, corner_radius, visible, locked, text) {
        const ptr0 = passStringToWasm0(transaction_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(page_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(node_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(kind, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passStringToWasm0(fill, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passStringToWasm0(stroke, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len6 = WASM_VECTOR_LEN;
        const ptr7 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len7 = WASM_VECTOR_LEN;
        const ret = wasm.documentengine_create_node_on_page(this.__wbg_ptr, ptr0, len0, base_revision, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, x, y, width, height, rotation, ptr5, len5, ptr6, len6, stroke_width, opacity, corner_radius, visible, locked, ptr7, len7);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BigInt.asUintN(64, ret[0]);
    }
    /**
     * Creates a durable top-level Figma-style Page. The worker decides which Page
     * is active for the current view; Page order and identity remain canonical.
     * @param {string} transaction_id
     * @param {bigint} base_revision
     * @param {string} page_id
     * @param {string} name
     * @returns {bigint}
     */
    create_page(transaction_id, base_revision, page_id, name) {
        const ptr0 = passStringToWasm0(transaction_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(page_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.documentengine_create_page(this.__wbg_ptr, ptr0, len0, base_revision, ptr1, len1, ptr2, len2);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BigInt.asUintN(64, ret[0]);
    }
    /**
     * `node_ids` is a comma-separated sequence of validated UUIDs. The format is
     * intentionally narrow because this is an internal Worker-to-WASM boundary.
     * @param {string} transaction_id
     * @param {bigint} base_revision
     * @param {string} node_ids
     * @returns {bigint}
     */
    delete_nodes(transaction_id, base_revision, node_ids) {
        const ptr0 = passStringToWasm0(transaction_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(node_ids, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.documentengine_delete_nodes(this.__wbg_ptr, ptr0, len0, base_revision, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BigInt.asUintN(64, ret[0]);
    }
    /**
     * Produces the 16-float solid-shape instance layout consumed by the
     * WebGPU/WGSL executor. It filters to one active Page and intentionally
     * leaves Image/Text to their own Render Graph passes.
     * @param {string} page_id
     * @returns {string}
     */
    gpu_scene_instances_json(page_id) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(page_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.documentengine_gpu_scene_instances_json(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Restores a versioned Core snapshot. This deliberately restores no undo history:
     * snapshots represent a confirmed durable state, while a future journal will carry
     * operations that happened after it.
     * @param {string} value
     * @returns {bigint}
     */
    load_snapshot_json(value) {
        const ptr0 = passStringToWasm0(value, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.documentengine_load_snapshot_json(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BigInt.asUintN(64, ret[0]);
    }
    /**
     * @param {Uint8Array} bytes
     * @returns {bigint}
     */
    load_snapshot_protobuf(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.documentengine_load_snapshot_protobuf(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BigInt.asUintN(64, ret[0]);
    }
    /**
     * @returns {string}
     */
    memory_stats_json() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.documentengine_memory_stats_json(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Keeps a pointer drag as one semantic history item, even when several nodes move.
     * @param {string} transaction_id
     * @param {bigint} base_revision
     * @param {string} updates_json
     * @returns {bigint}
     */
    move_nodes(transaction_id, base_revision, updates_json) {
        const ptr0 = passStringToWasm0(transaction_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(updates_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.documentengine_move_nodes(this.__wbg_ptr, ptr0, len0, base_revision, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BigInt.asUintN(64, ret[0]);
    }
    constructor() {
        const ret = wasm.documentengine_new();
        this.__wbg_ptr = ret;
        DocumentEngineFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {bigint}
     */
    redo() {
        const ret = wasm.documentengine_redo(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BigInt.asUintN(64, ret[0]);
    }
    /**
     * Adds only an already-admitted Asset Service record to the Canonical
     * Resource Index. Bytes remain owned by the resource service.
     * @param {string} transaction_id
     * @param {bigint} base_revision
     * @param {string} asset_id
     * @param {string} content_hash
     * @param {string} media_type
     * @param {bigint} byte_length
     * @param {number} pixel_width
     * @param {number} pixel_height
     * @returns {bigint}
     */
    register_asset(transaction_id, base_revision, asset_id, content_hash, media_type, byte_length, pixel_width, pixel_height) {
        const ptr0 = passStringToWasm0(transaction_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(asset_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(content_hash, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(media_type, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ret = wasm.documentengine_register_asset(this.__wbg_ptr, ptr0, len0, base_revision, ptr1, len1, ptr2, len2, ptr3, len3, byte_length, pixel_width, pixel_height);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BigInt.asUintN(64, ret[0]);
    }
    /**
     * @param {string} transaction_id
     * @param {bigint} base_revision
     * @param {string} node_id
     * @param {string} name
     * @returns {bigint}
     */
    rename_node(transaction_id, base_revision, node_id, name) {
        const ptr0 = passStringToWasm0(transaction_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(node_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.documentengine_rename_node(this.__wbg_ptr, ptr0, len0, base_revision, ptr1, len1, ptr2, len2);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BigInt.asUintN(64, ret[0]);
    }
    /**
     * Equivalent to [`Self::render_graph_plan_json`], scoped to the active
     * Canonical Page. A renderer must not accidentally schedule hidden pages
     * merely because their coordinates intersect the current viewport.
     * @param {string} page_id
     * @param {number} viewport_x
     * @param {number} viewport_y
     * @param {number} viewport_width
     * @param {number} viewport_height
     * @returns {string}
     */
    render_graph_plan_for_page_json(page_id, viewport_x, viewport_y, viewport_width, viewport_height) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(page_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.documentengine_render_graph_plan_for_page_json(this.__wbg_ptr, ptr0, len0, viewport_x, viewport_y, viewport_width, viewport_height);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Projects the current Canonical Document into the GPU-handle-free Rust
     * Render Graph plan. The Worker can execute this plan with WebGPU or use
     * its explicit Canvas fallback; neither path gets ownership of Document.
     * @param {number} viewport_x
     * @param {number} viewport_y
     * @param {number} viewport_width
     * @param {number} viewport_height
     * @returns {string}
     */
    render_graph_plan_json(viewport_x, viewport_y, viewport_width, viewport_height) {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.documentengine_render_graph_plan_json(this.__wbg_ptr, viewport_x, viewport_y, viewport_width, viewport_height);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {bigint}
     */
    get revision() {
        const ret = wasm.documentengine_revision(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * Adds trusted legacy fixture metadata before `seed_batch_json` installs
     * image or font references. Bytes are deliberately not accepted here.
     * @param {string} value
     */
    seed_assets_json(value) {
        const ptr0 = passStringToWasm0(value, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.documentengine_seed_assets_json(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Installs a trusted legacy projection without adding history. Unlike the narrow
     * v1 seed_node bridge, this carries the full v7 paint projection during one-time
     * hydration of older local records and fixtures.
     * @param {string} value
     * @returns {bigint}
     */
    seed_batch_json(value) {
        const ptr0 = passStringToWasm0(value, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.documentengine_seed_batch_json(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BigInt.asUintN(64, ret[0]);
    }
    /**
     * Loads an existing local snapshot without turning document hydration into a user
     * undo step. Only the Worker uses this while bootstrapping the projection.
     * @param {string} transaction_id
     * @param {bigint} base_revision
     * @param {string} node_id
     * @param {string} kind
     * @param {string} name
     * @param {number} x
     * @param {number} y
     * @param {number} width
     * @param {number} height
     * @param {number} rotation
     * @param {string} fill
     * @param {string} stroke
     * @param {number} stroke_width
     * @param {number} opacity
     * @param {number} corner_radius
     * @param {boolean} visible
     * @param {boolean} locked
     * @param {string} text
     * @returns {bigint}
     */
    seed_node(transaction_id, base_revision, node_id, kind, name, x, y, width, height, rotation, fill, stroke, stroke_width, opacity, corner_radius, visible, locked, text) {
        const ptr0 = passStringToWasm0(transaction_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(node_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(kind, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(fill, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passStringToWasm0(stroke, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len6 = WASM_VECTOR_LEN;
        const ret = wasm.documentengine_seed_node(this.__wbg_ptr, ptr0, len0, base_revision, ptr1, len1, ptr2, len2, ptr3, len3, x, y, width, height, rotation, ptr4, len4, ptr5, len5, stroke_width, opacity, corner_radius, visible, locked, ptr6, len6);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BigInt.asUintN(64, ret[0]);
    }
    /**
     * Sets the Canonical default profile for the document. The profile does not
     * reinterpret existing explicit Colors; it governs future profile-aware assets.
     * @param {string} transaction_id
     * @param {bigint} base_revision
     * @param {string} profile
     * @returns {bigint}
     */
    set_document_color_profile(transaction_id, base_revision, profile) {
        const ptr0 = passStringToWasm0(transaction_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(profile, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.documentengine_set_document_color_profile(this.__wbg_ptr, ptr0, len0, base_revision, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BigInt.asUintN(64, ret[0]);
    }
    /**
     * @returns {string}
     */
    snapshot_json() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.documentengine_snapshot_json(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Durable wire snapshot shared with the server-side Document Service. The
     * JSON projection remains local-storage-only; this payload is the boundary
     * used to safely bootstrap and recover a remote document.
     * @returns {Uint8Array}
     */
    snapshot_protobuf() {
        const ret = wasm.documentengine_snapshot_protobuf(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {bigint}
     */
    undo() {
        const ret = wasm.documentengine_undo(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BigInt.asUintN(64, ret[0]);
    }
    /**
     * Applies geometry and name as one atomic Rust transaction, so a failed name
     * validation cannot leave a partially applied resize in the browser document.
     * @param {string} transaction_id
     * @param {bigint} base_revision
     * @param {string} node_id
     * @param {string} name
     * @param {number} x
     * @param {number} y
     * @param {number} width
     * @param {number} height
     * @param {number} rotation
     * @param {string} fill
     * @param {string} stroke
     * @param {number} stroke_width
     * @param {number} opacity
     * @param {number} corner_radius
     * @param {boolean} visible
     * @param {boolean} locked
     * @param {string} text
     * @returns {bigint}
     */
    update_node(transaction_id, base_revision, node_id, name, x, y, width, height, rotation, fill, stroke, stroke_width, opacity, corner_radius, visible, locked, text) {
        const ptr0 = passStringToWasm0(transaction_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(node_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(fill, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(stroke, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len5 = WASM_VECTOR_LEN;
        const ret = wasm.documentengine_update_node(this.__wbg_ptr, ptr0, len0, base_revision, ptr1, len1, ptr2, len2, x, y, width, height, rotation, ptr3, len3, ptr4, len4, stroke_width, opacity, corner_radius, visible, locked, ptr5, len5);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BigInt.asUintN(64, ret[0]);
    }
}
if (Symbol.dispose) DocumentEngine.prototype[Symbol.dispose] = DocumentEngine.prototype.free;

/**
 * Returns one transient Boolean outline for two or more VectorPath operands.
 * The input and output are projection data only: the editable source paths and
 * BooleanOperation children remain Canonical, while Canvas, hit tests and
 * exporters can consume this one validated Rust-derived result.
 * @param {string} operation
 * @param {string} operands_json
 * @param {number} tolerance
 * @returns {string}
 */
export function boolean_vector_paths_json(operation, operands_json, tolerance) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(operation, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(operands_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.boolean_vector_paths_json(ptr0, len0, ptr1, len1, tolerance);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * @param {number} width
 * @param {number} stroke_width
 * @param {string} dash_json
 * @param {string} cap
 * @param {string} join
 * @param {number} miter_limit
 * @returns {string}
 */
export function dashed_line_outline_json(width, stroke_width, dash_json, cap, join, miter_limit) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(dash_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(cap, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(join, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.dashed_line_outline_json(width, stroke_width, ptr0, len0, ptr1, len1, ptr2, len2, miter_limit);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Projects a decorative Line endpoint marker (arrowhead, diamond or dot) from
 * the same Core geometry the Canvas renderer, hit test and SVG export consume.
 * `endpoint`/`direction` place and orient the marker in the Line's local space
 * (`direction` is `-1` at the start, `1` at the end); `stroke_width` sizes it.
 * @param {string} cap
 * @param {number} endpoint
 * @param {number} direction
 * @param {number} stroke_width
 * @returns {string}
 */
export function decorative_cap_mesh_json(cap, endpoint, direction, stroke_width) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(cap, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.decorative_cap_mesh_json(ptr0, len0, endpoint, direction, stroke_width);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * @returns {number}
 */
export function engine_semantics_version() {
    const ret = wasm.engine_semantics_version();
    return ret >>> 0;
}

/**
 * Returns a deterministic, UTF-8 byte-addressed fallback layout for selection,
 * caret, and IME clients. This boundary owns neither a canvas nor a font: the
 * presentation renderer may refine glyph positions without changing the saved
 * document text or its canonical byte offsets.
 * @param {string} text
 * @param {number} max_graphemes_per_line
 * @returns {string}
 */
export function fallback_text_layout_json(text, max_graphemes_per_line) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fallback_text_layout_json(ptr0, len0, max_graphemes_per_line);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Builds a transient GPU instance projection from a validated Core snapshot
 * without borrowing the live browser editing engine. The renderer owns this
 * derived data only; edits and history remain on its separate DocumentEngine.
 * Keeping the projection receiver-free avoids a wasm-bindgen borrow spanning a
 * browser Worker render read and a later mutable transaction.
 * @param {string} snapshot_json
 * @param {string} page_id
 * @returns {string}
 */
export function gpu_scene_instances_from_snapshot_json(snapshot_json, page_id) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(snapshot_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(page_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.gpu_scene_instances_from_snapshot_json(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Produces ICU4X line ranges and Rustybuzz advances from explicit font bytes.
 * The width is measured in em, so viewport zoom never changes the derived
 * source ranges. Glyph pixels remain a renderer-owned cache.
 * @param {Uint8Array} font_bytes
 * @param {number} face_index
 * @param {string} text
 * @param {number} max_width_em
 * @returns {string}
 */
export function layout_shaped_text_json(font_bytes, face_index, text, max_width_em) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passArray8ToWasm0(font_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.layout_shaped_text_json(ptr0, len0, face_index, ptr1, len1, max_width_em);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Produces ICU4X line ranges at the same Variable Font coordinates used by
 * the shaping and glyph-raster stages.
 * @param {Uint8Array} font_bytes
 * @param {number} face_index
 * @param {string} variation_axes_json
 * @param {string} text
 * @param {number} max_width_em
 * @returns {string}
 */
export function layout_shaped_text_with_variations_json(font_bytes, face_index, variation_axes_json, text, max_width_em) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passArray8ToWasm0(font_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(variation_axes_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.layout_shaped_text_with_variations_json(ptr0, len0, face_index, ptr1, len1, ptr2, len2, max_width_em);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Converts a solid straight Line and either standard or decorative endpoint
 * caps into one unioned editable outline. Dashed lines remain deliberately
 * excluded because their terminal-cap semantics differ per dash run.
 * @param {number} width
 * @param {number} stroke_width
 * @param {string} start_cap
 * @param {string} end_cap
 * @param {string} join
 * @param {number} miter_limit
 * @returns {string}
 */
export function line_outline_json(width, stroke_width, start_cap, end_cap, join, miter_limit) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(start_cap, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(end_cap, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(join, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.line_outline_json(width, stroke_width, ptr0, len0, ptr1, len1, ptr2, len2, miter_limit);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Canonical non-zero fill containment for editable Polygon/Star nodes. The
 * document stores only parameters; this recomputes the bounded Core outline.
 * @param {number} width
 * @param {number} height
 * @param {string} shape_json
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
export function parametric_shape_contains_point_json(width, height, shape_json, x, y) {
    const ptr0 = passStringToWasm0(shape_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.parametric_shape_contains_point_json(width, height, ptr0, len0, x, y);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}

/**
 * Returns the one Core-derived local contour for an ADR 0026 Polygon or Star.
 * It is transient presentation geometry only; the canonical document continues
 * to store the bounded parametric record rather than this generated point list.
 * @param {number} width
 * @param {number} height
 * @param {string} shape_json
 * @returns {string}
 */
export function parametric_shape_outline_json(width, height, shape_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(shape_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.parametric_shape_outline_json(width, height, ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Produces a transient text-edit/IME preview. It has no DocumentEngine
 * receiver by design: only a composition commit crosses into Canonical
 * Document as an atomic text transaction.
 * @param {string} text
 * @param {number} anchor
 * @param {number} focus
 * @param {string} replacement
 * @returns {string}
 */
export function preview_text_replacement_json(text, anchor, focus, replacement) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(replacement, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.preview_text_replacement_json(ptr0, len0, anchor, focus, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Produces a bounded, deterministic glyph alpha mask from explicit font
 * bytes. The result is presentation-only input for a renderer-owned atlas;
 * neither the pixels nor the placement can enter Canonical Document state.
 * @param {Uint8Array} font_bytes
 * @param {number} face_index
 * @param {number} glyph_id
 * @param {number} pixel_size
 * @returns {string}
 */
export function rasterize_glyph_json(font_bytes, face_index, glyph_id, pixel_size) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passArray8ToWasm0(font_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.rasterize_glyph_json(ptr0, len0, face_index, glyph_id, pixel_size);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Rasterizes at the same declared variation coordinates as shaping. Pixels
 * remain an ephemeral renderer resource and never enter Canonical Document.
 * @param {Uint8Array} font_bytes
 * @param {number} face_index
 * @param {string} variation_axes_json
 * @param {number} glyph_id
 * @param {number} pixel_size
 * @returns {string}
 */
export function rasterize_glyph_with_variations_json(font_bytes, face_index, variation_axes_json, glyph_id, pixel_size) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passArray8ToWasm0(font_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(variation_axes_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.rasterize_glyph_with_variations_json(ptr0, len0, face_index, ptr1, len1, glyph_id, pixel_size);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Shapes text from explicit font bytes without using browser font metrics.
 * This is presentation-only data; persisted text and font references remain
 * owned by Canonical Document and commit through the normal transaction path.
 * @param {Uint8Array} font_bytes
 * @param {number} face_index
 * @param {string} text
 * @param {string} direction
 * @returns {string}
 */
export function shape_text_json(font_bytes, face_index, text, direction) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passArray8ToWasm0(font_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(direction, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.shape_text_json(ptr0, len0, face_index, ptr1, len1, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Projects the shared Figma-style Corner Smoothing approximation. An empty
 * Dash array means solid; otherwise Core emits only the visible dash runs.
 * @param {number} width
 * @param {number} height
 * @param {string} radii_json
 * @param {number} smoothing
 * @param {number} stroke_width
 * @param {string} dash_json
 * @param {string} join
 * @param {number} miter_limit
 * @returns {string}
 */
export function stroke_mesh_for_continuous_rounded_rectangle_with_radii_json(width, height, radii_json, smoothing, stroke_width, dash_json, join, miter_limit) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(radii_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(dash_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(join, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.stroke_mesh_for_continuous_rounded_rectangle_with_radii_json(width, height, ptr0, len0, smoothing, stroke_width, ptr1, len1, ptr2, len2, miter_limit);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Projects the visible dashes of a straight Line from the same Core mesh
 * source used by hit testing and selection bounds.
 * @param {number} width
 * @param {number} stroke_width
 * @param {string} dash_json
 * @param {string} cap
 * @param {string} join
 * @param {number} miter_limit
 * @returns {string}
 */
export function stroke_mesh_for_dashed_line_json(width, stroke_width, dash_json, cap, join, miter_limit) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(dash_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(cap, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(join, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.stroke_mesh_for_dashed_line_json(width, stroke_width, ptr0, len0, ptr1, len1, ptr2, len2, miter_limit);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Projects visible dashes of an arbitrary open or closed polyline. A dashed
 * Frame/Rectangle uses this boundary so its corner joins are not re-derived
 * by Canvas.
 * @param {string} points_json
 * @param {number} stroke_width
 * @param {string} dash_json
 * @param {string} cap
 * @param {string} join
 * @param {number} miter_limit
 * @param {boolean} closed
 * @returns {string}
 */
export function stroke_mesh_for_dashed_polyline_json(points_json, stroke_width, dash_json, cap, join, miter_limit, closed) {
    let deferred6_0;
    let deferred6_1;
    try {
        const ptr0 = passStringToWasm0(points_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(dash_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(cap, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(join, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ret = wasm.stroke_mesh_for_dashed_polyline_json(ptr0, len0, stroke_width, ptr1, len1, ptr2, len2, ptr3, len3, miter_limit, closed);
        var ptr5 = ret[0];
        var len5 = ret[1];
        if (ret[3]) {
            ptr5 = 0; len5 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred6_0 = ptr5;
        deferred6_1 = len5;
        return getStringFromWasm0(ptr5, len5);
    } finally {
        wasm.__wbindgen_free(deferred6_0, deferred6_1, 1);
    }
}

/**
 * Projects the canonical dashed independent-radius rounded-rectangle outline.
 * @param {number} width
 * @param {number} height
 * @param {string} radii_json
 * @param {number} stroke_width
 * @param {string} dash_json
 * @param {string} join
 * @param {number} miter_limit
 * @returns {string}
 */
export function stroke_mesh_for_dashed_rounded_rectangle_with_radii_json(width, height, radii_json, stroke_width, dash_json, join, miter_limit) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(radii_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(dash_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(join, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.stroke_mesh_for_dashed_rounded_rectangle_with_radii_json(width, height, ptr0, len0, stroke_width, ptr1, len1, ptr2, len2, miter_limit);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Projects the canonical Rust stroke tessellation through the WASM boundary.
 * The returned triangles are presentation data only: neither a mesh nor its
 * cache can become durable document state. Keeping this conversion here gives
 * Canvas, WebGPU and export callers one finite, validated geometry source.
 * @param {string} points_json
 * @param {number} width
 * @param {string} cap
 * @param {string} join
 * @param {number} miter_limit
 * @param {boolean} closed
 * @returns {string}
 */
export function stroke_mesh_for_polyline_json(points_json, width, cap, join, miter_limit, closed) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(points_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(cap, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(join, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.stroke_mesh_for_polyline_json(ptr0, len0, width, ptr1, len1, ptr2, len2, miter_limit, closed);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Projects the canonical uniform rounded-rectangle stroke outline. This is a
 * presentation-only mesh; it cannot become document state and therefore
 * keeps the same finite validation boundary as polyline tessellation.
 * @param {number} width
 * @param {number} height
 * @param {number} radius
 * @param {number} stroke_width
 * @param {string} join
 * @param {number} miter_limit
 * @returns {string}
 */
export function stroke_mesh_for_rounded_rectangle_json(width, height, radius, stroke_width, join, miter_limit) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(join, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.stroke_mesh_for_rounded_rectangle_json(width, height, radius, stroke_width, ptr0, len0, miter_limit);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Projects a canonical four-corner rounded-rectangle stroke outline. Radii
 * are TL/TR/BR/BL and are normalized by Core before tessellation.
 * @param {number} width
 * @param {number} height
 * @param {string} radii_json
 * @param {number} stroke_width
 * @param {string} join
 * @param {number} miter_limit
 * @returns {string}
 */
export function stroke_mesh_for_rounded_rectangle_with_radii_json(width, height, radii_json, stroke_width, join, miter_limit) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(radii_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(join, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.stroke_mesh_for_rounded_rectangle_with_radii_json(width, height, ptr0, len0, stroke_width, ptr1, len1, miter_limit);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Projects the four independently weighted square-corner rectangle edges
 * from Core. The ordered meshes retain their separate paint-stack passes.
 * @param {number} width
 * @param {number} height
 * @param {string} weights_json
 * @param {string} align
 * @returns {string}
 */
export function stroke_meshes_for_per_side_rectangle_json(width, height, weights_json, align) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(weights_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(align, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.stroke_meshes_for_per_side_rectangle_json(width, height, ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Projects independently weighted square-corner rectangle dashes from Core.
 * The dash phase intentionally restarts on each independent edge, matching
 * the existing per-side rendering contract.
 * @param {number} width
 * @param {number} height
 * @param {string} weights_json
 * @param {string} align
 * @param {string} dash_json
 * @returns {string}
 */
export function stroke_meshes_for_per_side_rectangle_with_dash_json(width, height, weights_json, align, dash_json) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(weights_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(align, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(dash_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.stroke_meshes_for_per_side_rectangle_with_dash_json(width, height, ptr0, len0, ptr1, len1, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Canonical fill containment for Worker hit tests. Open subpaths do not
 * contribute to fill containment; stroke hits use the separate mesh bridge.
 * @param {string} path_json
 * @param {number} x
 * @param {number} y
 * @param {number} tolerance
 * @returns {boolean}
 */
export function vector_path_contains_json(path_json, x, y, tolerance) {
    const ptr0 = passStringToWasm0(path_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.vector_path_contains_json(ptr0, len0, x, y, tolerance);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}

/**
 * @param {string} path_json
 * @param {number} tolerance
 * @param {number} width
 * @param {string} dash_json
 * @param {string} cap
 * @param {string} join
 * @param {number} miter_limit
 * @returns {string}
 */
export function vector_path_dashed_outline_json(path_json, tolerance, width, dash_json, cap, join, miter_limit) {
    let deferred6_0;
    let deferred6_1;
    try {
        const ptr0 = passStringToWasm0(path_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(dash_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(cap, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(join, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ret = wasm.vector_path_dashed_outline_json(ptr0, len0, tolerance, width, ptr1, len1, ptr2, len2, ptr3, len3, miter_limit);
        var ptr5 = ret[0];
        var len5 = ret[1];
        if (ret[3]) {
            ptr5 = 0; len5 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred6_0 = ptr5;
        deferred6_1 = len5;
        return getStringFromWasm0(ptr5, len5);
    } finally {
        wasm.__wbindgen_free(deferred6_0, deferred6_1, 1);
    }
}

/**
 * Returns the budgeted Core flattening for a JSON-projected VectorPath. This
 * is presentation data only; callers must never persist the returned points.
 * @param {string} path_json
 * @param {number} tolerance
 * @returns {string}
 */
export function vector_path_geometry_json(path_json, tolerance) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(path_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.vector_path_geometry_json(ptr0, len0, tolerance);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Finds the nearest editable original VectorPath segment for direct canvas
 * splitting. Its `t` is Core-derived and can be passed unchanged to the
 * Canonical SplitVectorSegment command.
 * @param {string} path_json
 * @param {number} x
 * @param {number} y
 * @param {number} tolerance
 * @param {number} max_distance
 * @returns {string}
 */
export function vector_path_nearest_segment_json(path_json, x, y, tolerance, max_distance) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(path_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.vector_path_nearest_segment_json(ptr0, len0, x, y, tolerance, max_distance);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Expands a VectorPath stroke through the same Core tessellation used by the
 * Canvas fallback and stroke hit testing, then unions that mesh into editable
 * closed VectorPath contours for the Outline Stroke command.
 * @param {string} path_json
 * @param {number} tolerance
 * @param {number} width
 * @param {string} cap
 * @param {string} join
 * @param {number} miter_limit
 * @returns {string}
 */
export function vector_path_outline_json(path_json, tolerance, width, cap, join, miter_limit) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(path_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(cap, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(join, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.vector_path_outline_json(ptr0, len0, tolerance, width, ptr1, len1, ptr2, len2, miter_limit);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * As [`vector_path_outline_json`], but open paths can use different standard
 * caps at their start and end. Decorative caps remain a Line rendering mode.
 * @param {string} path_json
 * @param {number} tolerance
 * @param {number} width
 * @param {string} start_cap
 * @param {string} end_cap
 * @param {string} join
 * @param {number} miter_limit
 * @returns {string}
 */
export function vector_path_outline_with_caps_json(path_json, tolerance, width, start_cap, end_cap, join, miter_limit) {
    let deferred6_0;
    let deferred6_1;
    try {
        const ptr0 = passStringToWasm0(path_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(start_cap, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(end_cap, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(join, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ret = wasm.vector_path_outline_with_caps_json(ptr0, len0, tolerance, width, ptr1, len1, ptr2, len2, ptr3, len3, miter_limit);
        var ptr5 = ret[0];
        var len5 = ret[1];
        if (ret[3]) {
            ptr5 = 0; len5 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred6_0 = ptr5;
        deferred6_1 = len5;
        return getStringFromWasm0(ptr5, len5);
    } finally {
        wasm.__wbindgen_free(deferred6_0, deferred6_1, 1);
    }
}

/**
 * @param {string} path_json
 * @param {number} x
 * @param {number} y
 * @param {number} tolerance
 * @param {number} width
 * @param {string} cap
 * @param {string} join
 * @param {number} miter_limit
 * @returns {boolean}
 */
export function vector_path_stroke_contains_json(path_json, x, y, tolerance, width, cap, join, miter_limit) {
    const ptr0 = passStringToWasm0(path_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(cap, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(join, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.vector_path_stroke_contains_json(ptr0, len0, x, y, tolerance, width, ptr1, len1, ptr2, len2, miter_limit);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}

/**
 * Projects the Core VectorPath stroke mesh for Canvas fallback or a future
 * GPU upload. Unlike an HTML canvas stroke, this shares Core's joins, caps
 * and transient geometry budget with precise stroke hit testing.
 * @param {string} path_json
 * @param {number} tolerance
 * @param {number} width
 * @param {string} cap
 * @param {string} join
 * @param {number} miter_limit
 * @returns {string}
 */
export function vector_path_stroke_mesh_json(path_json, tolerance, width, cap, join, miter_limit) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(path_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(cap, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(join, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.vector_path_stroke_mesh_json(ptr0, len0, tolerance, width, ptr1, len1, ptr2, len2, miter_limit);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_344f42d3211c4765: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./editor_wasm_bg.js": import0,
    };
}

const DocumentEngineFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_documentengine_free(ptr, 1));

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('editor_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
