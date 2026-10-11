// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical encoding (`verified-json-v1`) and digests.
 *
 * Every digest and signature in the protocol is over canonical bytes. The
 * encoding is implemented once, in the shared Rust crate
 * `verified-canonical`; this module only calls it. It is not RFC 8785.
 *
 * @module
 */

import { call, jsonBytes } from "./bridge.js";
import { utf8 } from "./bytes.js";

const HEX = /^[0-9a-f]{64}$/;

/**
 * The canonical bytes of a JSON value.
 *
 * `value` is JSON text as bytes, or a plain JavaScript value. Fractional
 * numbers are refused: the encoding has integers only. A string is a JSON
 * string value, not JSON text.
 */
export function canonicalize(value: unknown): Uint8Array {
  const input = jsonBytes(value);
  return utf8(call((native) => native.canonicalize(input)));
}

/** The wire form of a digest. */
export interface DigestWire {
  algorithm: string;
  hex: string;
}

/**
 * A SHA-256 digest, as the protocol writes it.
 *
 * The wire form is `{"algorithm": "sha-256", "hex": "<64 hex>"}`; the
 * compact form, used in logs and by consuming applications, is
 * `sha-256:<64 hex>`.
 */
export class Digest {
  readonly hex: string;
  readonly algorithm: string;

  constructor(hex: string, algorithm = "sha-256") {
    if (algorithm !== "sha-256") {
      throw new RangeError(`unsupported digest algorithm ${JSON.stringify(algorithm)}`);
    }
    if (!HEX.test(hex)) {
      throw new RangeError("a sha-256 digest is 64 lowercase hexadecimal digits");
    }
    this.hex = hex;
    this.algorithm = algorithm;
    Object.freeze(this);
  }

  /** The digest of a JSON value's canonical bytes. */
  static ofJson(value: unknown): Digest {
    const input = jsonBytes(value);
    return new Digest(call((native) => native.canonical_digest(input)));
  }

  /** The digest of exact bytes, such as a file. No canonicalization. */
  static ofBytes(data: Uint8Array): Digest {
    return new Digest(call((native) => native.digest_bytes(data)));
  }

  /** Reads `sha-256:<hex>` or bare `<hex>`. */
  static parse(compact: string): Digest {
    return new Digest(compact.startsWith("sha-256:") ? compact.slice(8) : compact);
  }

  /** Reads the wire form. */
  static fromWire(value: DigestWire): Digest {
    return new Digest(String(value.hex), String(value.algorithm));
  }

  /** The wire form. */
  toWire(): DigestWire {
    return { algorithm: this.algorithm, hex: this.hex };
  }

  equals(other: Digest): boolean {
    return other.algorithm === this.algorithm && other.hex === this.hex;
  }

  /** `sha-256:<hex>`. */
  toString(): string {
    return `${this.algorithm}:${this.hex}`;
  }

  toJSON(): DigestWire {
    return this.toWire();
  }
}
