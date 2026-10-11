// SPDX-License-Identifier: Apache-2.0

/**
 * Signers and the authority they are declared to have.
 *
 * The SDK never assumes it holds trusted credentials. A signature is
 * produced only through an explicit {@link Signer}, and only for what an
 * explicit {@link SigningAuthority} names. Whether a relying party *accepts*
 * the key for that authority is theirs to decide, in their own trust
 * registry.
 *
 * @module
 */

import { call, type JsonObject } from "./bridge.js";
import { base64Decode, base64Encode } from "./bytes.js";
import { SigningAuthorityError } from "./errors.js";
import { instant } from "./time.js";
import { uuid } from "./uuid.js";

/** The source name through which a registry authorizes a key to sign decisions. */
export const DECISION_SOURCE = "wvp-decision";

/**
 * Something that can produce Ed25519 signatures with one key.
 *
 * Implement this over a KMS, an HSM or a signing service. The SDK hands the
 * signer the exact bytes to sign (a domain prefix followed by canonical
 * text) and never sees the private key.
 *
 * `sign` is synchronous. A signer backed by a network service signs ahead
 * of the call or blocks; an asynchronous signer interface is on the roadmap.
 */
export interface Signer {
  /** The identifier a trust registry lists this key under. */
  readonly keyId: string;
  /** The 64-byte Ed25519 signature (RFC 8032) over `message`. */
  sign(message: Uint8Array): Uint8Array;
}

/** What a {@link SigningAuthority} is declared with. */
export interface SigningAuthorityOptions {
  keyId: string;
  /** The actor the key belongs to (a UUID). */
  issuer: string;
  tenant: string;
  /** The source systems the key may speak for. At least one. */
  sources: Iterable<string>;
}

/** The validity a relying party records for a key. */
export interface KeyValidity {
  validFrom: Date | string;
  validUntil?: Date | string | undefined;
  revokedAt?: Date | string | undefined;
}

/**
 * What one key is declared to be allowed to sign for.
 *
 * It mirrors one record of a trust registry: a key belongs to one issuer, is
 * trusted for one tenant, and may speak for the listed source systems and no
 * others. An agent runtime's key lists the runtime, not the ERP.
 *
 * Declaring an authority grants nothing. It scopes what this process will
 * ask the signer to sign, and it produces the registry record
 * ({@link trustedKey}) that a relying party may choose to adopt.
 */
export class SigningAuthority {
  readonly keyId: string;
  readonly issuer: string;
  readonly tenant: string;
  readonly sources: ReadonlySet<string>;

  constructor(options: SigningAuthorityOptions) {
    if (typeof options.sources === "string") {
      throw new TypeError("sources is a collection of source names, not one string");
    }
    const names = new Set(options.sources);
    if (names.size === 0) {
      throw new RangeError("an authority names at least one source");
    }
    this.keyId = options.keyId;
    this.issuer = uuid(options.issuer, "issuer");
    this.tenant = options.tenant;
    this.sources = names;
    Object.freeze(this);
  }

  /** Whether this authority names `source`. */
  speaksFor(source: string): boolean {
    return this.sources.has(source);
  }

  /** Throws unless this authority covers `source` for `tenant`. */
  require(scope: { source: string; tenant: string }): void {
    if (scope.tenant !== this.tenant) {
      throw new SigningAuthorityError(
        `key ${JSON.stringify(this.keyId)} is declared for tenant ` +
          `${JSON.stringify(this.tenant)}, not ${JSON.stringify(scope.tenant)}`,
      );
    }
    if (!this.sources.has(scope.source)) {
      throw new SigningAuthorityError(
        `key ${JSON.stringify(this.keyId)} is not declared to speak for source ` +
          `${JSON.stringify(scope.source)} (declared: ${[...this.sources].sort().join(", ")}). ` +
          "A key cannot sign an observation of a system it has no authority over.",
      );
    }
  }

  /**
   * The trust-registry record a relying party would hold for this key.
   *
   * `publicKey` is base64 of the DER `SubjectPublicKeyInfo`.
   */
  trustedKey(publicKey: string, validity: KeyValidity): JsonObject {
    const wrapped = (at: Date | string | undefined): JsonObject | null =>
      at === undefined ? null : { value: instant(at) };
    return {
      keyId: this.keyId,
      algorithm: "Ed25519",
      publicKey,
      issuer: { value: this.issuer },
      tenant: { value: this.tenant },
      sources: [...this.sources].sort(),
      validFrom: { value: instant(validity.validFrom) },
      validUntil: wrapped(validity.validUntil),
      revokedAt: wrapped(validity.revokedAt),
    };
  }
}

/**
 * An in-process Ed25519 signer holding its seed in memory.
 *
 * Suitable for tests, examples and development. A production evidence source
 * should keep its key in a KMS or HSM behind its own {@link Signer}.
 */
export class Ed25519Signer implements Signer {
  readonly keyId: string;
  readonly #seed: Uint8Array;

  constructor(options: { keyId: string; seed: Uint8Array }) {
    if (options.seed.length !== 32) {
      throw new RangeError("an Ed25519 seed is exactly 32 bytes");
    }
    this.keyId = options.keyId;
    this.#seed = options.seed.slice();
  }

  /** A signer with a fresh random key. */
  static generate(options: { keyId: string }): Ed25519Signer {
    return new Ed25519Signer({
      keyId: options.keyId,
      seed: crypto.getRandomValues(new Uint8Array(32)),
    });
  }

  /** The public key as a trust registry spells it. */
  get publicKey(): string {
    return call((native) => native.ed25519_public_key(this.#seed));
  }

  sign(message: Uint8Array): Uint8Array {
    return base64Decode(call((native) => native.ed25519_sign(this.#seed, message)));
  }

  toString(): string {
    return `Ed25519Signer(keyId=${JSON.stringify(this.keyId)})`;
  }
}

/** @internal Signs `message` and returns the wire signature object. */
export function encodeSignature(
  signer: Signer,
  message: Uint8Array,
): { scheme: string; keyId: string; encoded: string } {
  const signature = signer.sign(message);
  if (!(signature instanceof Uint8Array) || signature.length !== 64) {
    throw new SigningAuthorityError(
      `signer ${JSON.stringify(signer.keyId)} did not return 64 bytes; ` +
        "an Ed25519 signature is 64 bytes",
    );
  }
  return { scheme: "Ed25519", keyId: signer.keyId, encoded: base64Encode(signature) };
}
