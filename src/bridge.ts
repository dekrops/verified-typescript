// SPDX-License-Identifier: Apache-2.0

// The single doorway to the WebAssembly module.
//
// Nothing else in the package imports `./native/`. The module is compiled on
// first use, never at import time, and a runtime that cannot run it gets an
// explicit capability error.

import { base64Decode, utf8 } from "./bytes.js";
import {
  AssemblyError,
  ContractError,
  MalformedInputError,
  NativeUnavailableError,
  ResourceLimitError,
  TrustRegistryError,
  UnsupportedOperationError,
  VerifiedError,
  WorkUnitError,
} from "./errors.js";
import * as glue from "./native/glue.js";
import { WASM_BASE64 } from "./native/wasm.js";

/**
 * A JSON value the protocol's encoding can hold. Numbers are whole: a
 * `number` must be a safe integer, and a `bigint` is written as an integer
 * of any size. There are no fractions.
 */
export type Json = null | boolean | string | number | bigint | Json[] | { [key: string]: Json };

/** A JSON object. */
export type JsonObject = { [key: string]: Json };

const CONTRACT_CODES = new Set([
  "CONTRACT_MALFORMED",
  "CONTRACT_ILL_FORMED",
  "ENVIRONMENT_MALFORMED",
  "ENVIRONMENT_NONCONFORMING",
  "WORK_LIMIT",
]);

const UNAVAILABLE =
  "the WebAssembly verification module could not be loaded in this runtime, so this operation " +
  "cannot be performed. Nothing was verified.";

type Native = typeof glue;
let loaded: Native | undefined;

function load(): Native {
  if (loaded === undefined) {
    try {
      glue.initSync({ module: base64Decode(WASM_BASE64) });
    } catch (error) {
      throw new NativeUnavailableError(
        `${UNAVAILABLE} If this is a browser's main thread, which may refuse to compile a ` +
          "module synchronously, call `await ready()` once before anything else.",
        { cause: error },
      );
    }
    loaded = glue;
  }
  return loaded;
}

/**
 * Compiles the WebAssembly module ahead of its first use.
 *
 * Optional in Node, Deno, Bun and workers, where the module is compiled
 * synchronously on first use. Needed on a browser's main thread, where
 * synchronous compilation of a module this size may be refused.
 */
export async function ready(): Promise<void> {
  if (loaded !== undefined) {
    return;
  }
  try {
    // Asynchronous instantiation; a no-op if the module is already loaded.
    await glue.default({ module_or_path: base64Decode(WASM_BASE64) });
    loaded = glue;
  } catch (error) {
    throw new NativeUnavailableError(UNAVAILABLE, { cause: error });
  }
}

/** Whether the WebAssembly module can be loaded. */
export function nativeAvailable(): boolean {
  try {
    load();
  } catch {
    return false;
  }
  return true;
}

function translate(error: unknown): never {
  const raw = error instanceof Error ? error.message : String(error);
  const split = raw.indexOf("\n");
  if (!(error instanceof Error) || split < 0) {
    // Not one of the module's own errors: a trap, or a fault in the glue.
    throw new VerifiedError(`the verification module failed: ${raw}`, { cause: error });
  }
  const code = raw.slice(0, split);
  const message = raw.slice(split + 1);
  switch (code) {
    case "RESOURCE_LIMIT":
      throw new ResourceLimitError(message);
    case "TRUST_REGISTRY":
      throw new TrustRegistryError(message);
    case "MALFORMED_JSON":
    case "MALFORMED_PACKAGE":
    case "WORK_RECORD":
    case "ASSEMBLY_INPUT":
      throw new MalformedInputError(message);
    case "EXPECTATIONS_UNDEFINED":
    case "RECORD_UNDEFINED":
      throw new UnsupportedOperationError(message);
    case "WORK_UNIT":
      throw new WorkUnitError(message);
    case "ASSEMBLY_REFUSED":
      throw new AssemblyError(code, message);
    case "USAGE":
      throw new RangeError(message);
    default:
      if (CONTRACT_CODES.has(code)) {
        throw new ContractError(code, message);
      }
      throw new VerifiedError(`${code}: ${message}`);
  }
}

/** Calls into the module, translating its errors. */
export function call<T>(use: (native: Native) => T): T {
  const native = load();
  try {
    return use(native);
  } catch (error) {
    translate(error);
  }
}

/** Calls a native function that returns JSON text, and reads the result. */
export function callJson(use: (native: Native) => string): JsonObject {
  return decode(call(use)) as JsonObject;
}

type Context = { source?: string };
const WHOLE = /^-?\d+$/;

/**
 * Reads JSON text from the module. A whole number too large for a `number`
 * is read as a `bigint`, never rounded.
 */
export function decode(jsonText: string): Json {
  const revive = (_key: string, value: unknown, context?: Context): unknown => {
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      const source = context?.source;
      if (source !== undefined && WHOLE.test(source)) {
        return BigInt(source);
      }
      throw new MalformedInputError(
        "a number in the verifier's output cannot be held exactly by this runtime",
      );
    }
    return value;
  };
  return JSON.parse(jsonText, revive as (key: string, value: unknown) => unknown) as Json;
}

function write(value: unknown, where: string, out: string[]): void {
  if (value === null || typeof value === "boolean") {
    out.push(String(value));
  } else if (typeof value === "string") {
    out.push(JSON.stringify(value));
  } else if (typeof value === "bigint") {
    out.push(value.toString());
  } else if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new TypeError(
        `${where}: the protocol's encoding has no fractional numbers; ` +
          "write amounts as text in the contract's scale",
      );
    }
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`${where}: ${value} is too large to be an exact number; use a bigint`);
    }
    out.push(Object.is(value, -0) ? "0" : String(value));
  } else if (Array.isArray(value)) {
    out.push("[");
    value.forEach((item, index) => {
      if (index > 0) {
        out.push(",");
      }
      write(item, `${where}[${index}]`, out);
    });
    out.push("]");
  } else if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(
        `${where}: ${prototype?.constructor?.name ?? "object"} is not a JSON value`,
      );
    }
    out.push("{");
    let first = true;
    for (const [key, item] of Object.entries(value)) {
      if (!first) {
        out.push(",");
      }
      first = false;
      out.push(JSON.stringify(key), ":");
      write(item, `${where}.${key}`, out);
    }
    out.push("}");
  } else {
    throw new TypeError(`${where}: ${typeof value} is not a JSON value`);
  }
}

/**
 * JSON text for the module. Not canonical: the module encodes. Fractions,
 * `undefined` and anything that is not plain data are refused, never
 * rounded or dropped.
 */
export function encode(value: unknown, where = "value"): Uint8Array {
  const out: string[] = [];
  write(value, where, out);
  return utf8(out.join(""));
}

/** Text or bytes of JSON as bytes; any other value as JSON text. */
export function jsonBytes(value: unknown, where = "value"): Uint8Array {
  return value instanceof Uint8Array ? value : encode(value, where);
}

/** What this build is made of. */
export function buildInfo(): JsonObject {
  return callJson((native) => native.build_info());
}
