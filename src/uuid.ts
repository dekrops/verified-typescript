// SPDX-License-Identifier: Apache-2.0

// UUIDs: the protocol's identifiers for claims, statements and actors.

import { utf8 } from "./bytes.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAMESPACE = "6f1d5f0e-6c0b-5e0a-9d55-2a0f8a3f7c11";

/** A UUID in the protocol's spelling (lowercase), or a `RangeError`. */
export function uuid(value: string, what: string): string {
  if (!UUID.test(value)) {
    throw new RangeError(`${what} must be a UUID`);
  }
  return value.toLowerCase();
}

export function randomUuid(): string {
  return crypto.randomUUID();
}

function rotate(word: number, bits: number): number {
  return ((word << bits) | (word >>> (32 - bits))) >>> 0;
}

// SHA-1, for name-based UUIDs (RFC 9562, version 5) only. It labels things;
// nothing the protocol verifies depends on it. Every digest and signature of
// the protocol is computed by the WebAssembly module.
function sha1(message: Uint8Array): Uint8Array {
  const length = message.length;
  const padded = new Uint8Array((((length + 8) >> 6) + 1) << 6);
  padded.set(message);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((length * 8) / 2 ** 32));
  view.setUint32(padded.length - 4, (length * 8) >>> 0);
  const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const words = new Uint32Array(80);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      words[i] = view.getUint32(offset + i * 4);
    }
    for (let i = 16; i < 80; i += 1) {
      words[i] = rotate(
        (words[i - 3] as number) ^
          (words[i - 8] as number) ^
          (words[i - 14] as number) ^
          (words[i - 16] as number),
        1,
      );
    }
    let [a, b, c, d, e] = state as [number, number, number, number, number];
    for (let i = 0; i < 80; i += 1) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const next = (rotate(a, 5) + (f >>> 0) + e + k + (words[i] as number)) >>> 0;
      e = d;
      d = c;
      c = rotate(b, 30);
      b = a;
      a = next;
    }
    state[0] = ((state[0] as number) + a) >>> 0;
    state[1] = ((state[1] as number) + b) >>> 0;
    state[2] = ((state[2] as number) + c) >>> 0;
    state[3] = ((state[3] as number) + d) >>> 0;
    state[4] = ((state[4] as number) + e) >>> 0;
  }
  const digest = new Uint8Array(20);
  const out = new DataView(digest.buffer);
  state.forEach((word, index) => {
    out.setUint32(index * 4, word);
  });
  return digest;
}

function uuid5(namespace: string, name: string): string {
  const space = Uint8Array.from(namespace.replaceAll("-", "").match(/../g) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );
  const named = utf8(name);
  const input = new Uint8Array(space.length + named.length);
  input.set(space);
  input.set(named, space.length);
  const bytes = sha1(input).slice(0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A stable UUID for the given parts (length-prefixed, so `("ab", "c")` and
 * `("a", "bc")` differ). An SDK convention shared with `verified-python`,
 * not part of the protocol.
 */
export function derivedId(...parts: string[]): string {
  // Lengths count Unicode code points, as the Python SDK counts them.
  return uuid5(NAMESPACE, parts.map((part) => `${[...part].length}:${part}`).join(""));
}
