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
     * @returns {bigint}
     */
    get revision() {
        const ret = wasm.documentengine_revision(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
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
 * @returns {number}
 */
export function engine_semantics_version() {
    const ret = wasm.engine_semantics_version();
    return ret >>> 0;
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
