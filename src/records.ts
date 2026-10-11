// SPDX-License-Identifier: Apache-2.0

/**
 * The portable artifacts: packages and work records.
 *
 * Terminology differs between audiences, so to be exact:
 *
 * - A **package** ({@link WorkPackage}) is the portable file: claim,
 *   contract, signed evidence and decision, sealed by digest. Product
 *   material calls this file "the portable Work Record".
 * - A **work record** ({@link WorkRecord}) is, in the protocol's words, the
 *   record of one verification: fifteen values computed from a package. A
 *   relying party stores it and can later check that a package is the one
 *   the record is about.
 *
 * Holding either object establishes nothing. Only a
 * {@link VerificationResult} says what was checked.
 *
 * @module
 */

import { call, decode, encode, type JsonObject } from "./bridge.js";
import { asBytes, text, utf8 } from "./bytes.js";
import { Digest, type DigestWire } from "./canonical.js";
import { MalformedInputError } from "./errors.js";

/**
 * A package is canonical text, which has no trailing line end; a package
 * *file* conventionally has one. Exactly one is the file's, as in the
 * upstream command-line tool.
 */
export function stripFinalLineEnd(data: Uint8Array): Uint8Array {
  const end = data.length;
  if (end >= 2 && data[end - 2] === 0x0d && data[end - 1] === 0x0a) {
    return data.subarray(0, end - 2);
  }
  if (end >= 1 && data[end - 1] === 0x0a) {
    return data.subarray(0, end - 1);
  }
  return data;
}

/**
 * The exact bytes of a WVP package.
 *
 * The bytes are kept as received and are never re-serialized: consumers
 * re-verify from them, and a re-encoded package is a different file.
 */
export class WorkPackage {
  readonly #text: Uint8Array;

  /** Holds package text, without examining it. */
  constructor(packageText: Uint8Array | string) {
    this.#text = asBytes(packageText).slice();
  }

  /**
   * Holds the contents of a package file: the package text, less the one
   * line end a file conventionally ends with.
   */
  static fromFile(contents: Uint8Array): WorkPackage {
    return new WorkPackage(stripFinalLineEnd(contents));
  }

  /** The package text. */
  get text(): Uint8Array {
    return this.#text.slice();
  }

  /**
   * The SHA-256 of the package's bytes.
   *
   * Not the package commitment: issuer signatures lie outside the
   * commitment, so a signed and an unsigned package share an identifier and
   * differ in this digest.
   */
  get byteDigest(): Digest {
    return Digest.ofBytes(this.#text);
  }

  /**
   * The identifier the package states, **unverified**.
   *
   * Use {@link VerificationResult.packageId}, which the verifier recomputes,
   * for anything that matters.
   */
  get statedPackageId(): string | undefined {
    try {
      const value = (JSON.parse(text(this.#text)) as { packageId?: unknown }).packageId;
      return typeof value === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  }

  toString(): string {
    return `WorkPackage(${this.#text.length} bytes, ${this.byteDigest})`;
  }
}

/**
 * A work record: what one verification of a `wvp-0.2` package states.
 *
 * Every member is a function of the package, so two verifiers compute the
 * same record. It is a record of a *decision*, which may be `CONTRADICTED`
 * or `UNDETERMINED`; it is not an acceptance, and it is not a verification
 * result on its own. Pass it to {@link Verifier.verify} to check that a
 * package is the one it is about.
 */
export class WorkRecord {
  readonly members: Readonly<JsonObject>;

  constructor(members: JsonObject) {
    this.members = members;
  }

  /** Reads work record JSON. */
  static fromJson(record: Uint8Array | string): WorkRecord {
    const input = asBytes(record);
    const value = decode(call((native) => native.canonicalize(input)));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new MalformedInputError("a work record is a JSON object");
    }
    return new WorkRecord(value);
  }

  /** The record's canonical text. */
  toBytes(): Uint8Array {
    const input = encode(this.members, "work record");
    return utf8(call((native) => native.canonicalize(input)));
  }

  get claimId(): string {
    return String((this.members["claimId"] as JsonObject)["value"]);
  }

  /** The decision the package carries. Recorded, not re-established. */
  get decision(): string {
    return String(this.members["decision"]);
  }

  get contractId(): string {
    return String(this.members["contractId"]);
  }

  get contractVersion(): string {
    return String(this.members["contractVersion"]);
  }

  get contractDigest(): Digest {
    return Digest.fromWire(this.members["contract"] as unknown as DigestWire);
  }

  get packageCommitment(): Digest {
    return Digest.fromWire(this.members["packageCommitment"] as unknown as DigestWire);
  }
}
