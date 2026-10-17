/* tslint:disable */
/* eslint-disable */

/**
 * The demo bytes, owned by wasm memory. The worker copies the file in and drops its own
 * ArrayBuffer before parsing.
 */
export class ExtrasInput {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Zero-filled vector of `len` bytes.
     */
    constructor(len: number);
    /**
     * JS: `new Uint8Array(wasm.memory.buffer, input.ptr(), len).set(bytes)`
     */
    ptr(): number;
}

export function parse_demo_cache(buffer: Uint8Array): any;

export function parse_demo_cache_with_progress(buffer: Uint8Array, progress_callback: Function): any;

/**
 * Parses the Highlander extras (`ExtrasRaw`, contract section 2.5) or returns an error string.
 */
export function parse_demo_extras(buffer: Uint8Array, options: any, progress_callback: Function): any;

/**
 * Same result as `parse_demo_extras`. Consumes and frees `input` before the JS output is built.
 */
export function parse_demo_extras_input(input: ExtrasInput, options: any, progress_callback: Function): any;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly analyze_demo: (a: number) => number;
    readonly free_string: (a: number) => void;
    readonly parse_demo_cache: (a: number, b: number) => any;
    readonly parse_demo_cache_with_progress: (a: number, b: number, c: any) => any;
    readonly parse_demo_extras: (a: number, b: number, c: any, d: any) => any;
    readonly __wbg_extrasinput_free: (a: number, b: number) => void;
    readonly extrasinput_new: (a: number) => number;
    readonly extrasinput_ptr: (a: number) => number;
    readonly parse_demo_extras_input: (a: number, b: any, c: any) => any;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
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
