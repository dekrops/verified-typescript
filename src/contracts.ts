// SPDX-License-Identifier: Apache-2.0

/**
 * Work contracts: what counts as done, as data.
 *
 * A contract is written in Work Contract Language 1. It is read and checked
 * by the shared Rust crate `verified-contract`; this module never evaluates
 * one.
 *
 * @module
 */

import { callJson, decode, encode, type JsonObject } from "./bridge.js";
import { asBytes, utf8 } from "./bytes.js";
import { Digest, type DigestWire } from "./canonical.js";

/**
 * A well-formed work contract and the digest that identifies it.
 *
 * The digest is over the contract's canonical text. It binds the language
 * version, the vocabulary, the accepted sources per kind of record, the
 * conflict policy, every policy value and the requirements. A relying party
 * pins the contract it means by this digest (see {@link Expectations}); the
 * identifier and version alone are only what the document says about itself.
 */
export class WorkContract {
  readonly id: string;
  readonly version: string;
  readonly language: string;
  readonly semantics: string;
  /** The contract digest: SHA-256 of the canonical text. */
  readonly digest: Digest;
  readonly #canonical: string;

  private constructor(contract: Uint8Array) {
    const summary = callJson((native) => native.contract_summary(contract));
    this.id = summary["id"] as string;
    this.version = summary["version"] as string;
    this.language = summary["language"] as string;
    this.semantics = summary["semantics"] as string;
    this.digest = Digest.fromWire(summary["digest"] as unknown as DigestWire);
    this.#canonical = summary["canonical"] as string;
  }

  /**
   * Reads contract JSON text. Throws {@link ContractError} if it is not a
   * well-formed contract.
   */
  static fromJson(contract: Uint8Array | string): WorkContract {
    return new WorkContract(asBytes(contract));
  }

  /** Reads a contract held as an object. */
  static fromObject(document: object): WorkContract {
    return new WorkContract(encode(document, "contract"));
  }

  /** The contract's canonical text. */
  get canonical(): Uint8Array {
    return utf8(this.#canonical);
  }

  /** The contract as a JSON object (a fresh copy). */
  toObject(): JsonObject {
    return decode(this.#canonical) as JsonObject;
  }

  /** The inputs a claim must supply, as the contract declares them. */
  get inputNames(): readonly string[] {
    return Object.keys(this.toObject()["inputs"] as JsonObject);
  }

  /**
   * For each kind of record, the sources the contract accepts.
   *
   * A validly signed record from any other source is authentic and is
   * ignored by evaluation. This is read from the contract for display; it is
   * the evaluator, not this property, that applies it.
   */
  get acceptedSources(): Readonly<Record<string, readonly string[]>> {
    const evidence = this.toObject()["evidence"] as JsonObject;
    return evidence["sources"] as Record<string, string[]>;
  }

  /** The identifiers of the contract's requirements, in order. */
  get requirementIds(): readonly string[] {
    return (this.toObject()["requires"] as JsonObject[]).map((item) => item["id"] as string);
  }

  equals(other: WorkContract): boolean {
    return other.#canonical === this.#canonical;
  }

  toString(): string {
    return `WorkContract(${this.id} ${this.version}, ${this.digest})`;
  }
}
