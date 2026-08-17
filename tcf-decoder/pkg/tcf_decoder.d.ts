/* tslint:disable */
/* eslint-disable */

/**
 * Decode a TCF v2 consent string and return a JSON object with:
 * { version, purposes: [...], allows_storage, allows_ads }
 */
export function decodeTcf(consent_string: string): any;

/**
 * Evaluate routing decision for a given consent string and endpoint type.
 * Returns { decision: "Pass|Strip|Block", reason, affected_headers, affected_cookies }
 */
export function evaluateRouting(consent_string: string, is_ad_endpoint: boolean): any;

/**
 * Generate a TCF v2 string with given purposes enabled (bitmask, purposes 1-12).
 */
export function generateTcf(purposes_mask: number): string;

/**
 * Get all 12 IAB purposes with descriptions.
 */
export function getPurposes(): any[];

/**
 * Get sample TCF strings for quick testing.
 */
export function getSamples(): any[];

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly decodeTcf: (a: number, b: number) => [number, number, number];
    readonly evaluateRouting: (a: number, b: number, c: number) => [number, number, number];
    readonly generateTcf: (a: number) => [number, number];
    readonly getPurposes: () => [number, number];
    readonly getSamples: () => [number, number];
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_drop_slice: (a: number, b: number) => void;
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
