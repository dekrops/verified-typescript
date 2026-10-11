// SPDX-License-Identifier: Apache-2.0

/**
 * Trust registries: the relying party's own statement of whom it trusts.
 *
 * A registry is verifier configuration. It is never taken from a package,
 * and this SDK has no default one. Without a registry a verifier establishes
 * package integrity and nothing else.
 *
 * @module
 */

import { callJson, decode, encode, type JsonObject } from "./bridge.js";
import { asBytes, text } from "./bytes.js";
import { Digest } from "./canonical.js";
import { ResourceLimitError } from "./errors.js";

/** The largest registry examined: 8 MiB. */
export const MAX_REGISTRY_BYTES = 8 * 1024 * 1024;

/** One key a relying party trusts, and exactly what for. */
export interface TrustedKey {
  readonly keyId: string;
  readonly algorithm: string;
  readonly publicKey: string;
  readonly issuer: string;
  readonly tenant: string;
  readonly sources: readonly string[];
  readonly validFrom: string;
  readonly validUntil: string | null;
  readonly revokedAt: string | null;
}

/**
 * A validated trust registry, with the exact bytes it was read from.
 *
 * Build one with {@link TrustRegistry.fromJson} or
 * {@link TrustRegistry.fromKeys} (or `readTrustRegistry` from
 * `verified-typescript/node`). Validation is the shared verifier's:
 * malformed records, unknown members (so a misspelt `revokedAt` is an error,
 * not silently no revocation), duplicate keys and unusable key material are
 * all refused here, when the registry is loaded, not in the middle of
 * verifying a package.
 */
export class TrustRegistry {
  readonly #text: Uint8Array;
  readonly #keys: readonly TrustedKey[];

  private constructor(registry: Uint8Array) {
    if (registry.length > MAX_REGISTRY_BYTES) {
      throw new ResourceLimitError(
        `trust registry: larger than ${MAX_REGISTRY_BYTES} bytes; not examined`,
      );
    }
    const parsed = callJson((native) => native.trust_registry(registry));
    this.#text = registry.slice();
    this.#keys = Object.freeze(
      (parsed["keys"] as JsonObject[]).map((key) =>
        Object.freeze({
          keyId: key["keyId"] as string,
          algorithm: key["algorithm"] as string,
          publicKey: key["publicKey"] as string,
          issuer: key["issuer"] as string,
          tenant: key["tenant"] as string,
          sources: Object.freeze([...(key["sources"] as string[])]),
          validFrom: key["validFrom"] as string,
          validUntil: key["validUntil"] as string | null,
          revokedAt: key["revokedAt"] as string | null,
        }),
      ),
    );
  }

  /** Reads registry JSON text: `{"keys": [...]}`. */
  static fromJson(registry: Uint8Array | string): TrustRegistry {
    return new TrustRegistry(asBytes(registry));
  }

  /**
   * Builds a registry from records in wire form.
   *
   * {@link SigningAuthority.trustedKey} produces such records. Composing a
   * registry is a decision to trust every key in it.
   */
  static fromKeys(keys: Iterable<object>): TrustRegistry {
    return new TrustRegistry(encode({ keys: [...keys] }, "registry"));
  }

  /** The keys, in registry order. */
  get keys(): readonly TrustedKey[] {
    return this.#keys;
  }

  /** The number of keys. */
  get size(): number {
    return this.#keys.length;
  }

  /** The key with this identifier, if the registry holds it. */
  find(keyId: string): TrustedKey | undefined {
    return this.#keys.find((key) => key.keyId === keyId);
  }

  /** The exact bytes this registry was read from. */
  toBytes(): Uint8Array {
    return this.#text.slice();
  }

  /** The registry as a JSON object. */
  toObject(): JsonObject {
    return decode(text(this.#text)) as JsonObject;
  }

  /** The SHA-256 of the registry's exact bytes: which registry was used. */
  get byteDigest(): Digest {
    return Digest.ofBytes(this.#text);
  }

  toString(): string {
    return `TrustRegistry(${this.#keys.length} keys, ${this.byteDigest})`;
  }
}
