// SPDX-License-Identifier: Apache-2.0

/**
 * Work-unit identity: which unit of work a claim is about.
 *
 * A unit is identified by its tenant, a scope, an operation and the values
 * of the claim inputs the scope names. The identity stays the same across
 * contract versions, so that a new contract version is not a way to count
 * the same work twice. Computed by the shared Rust crate
 * `verified-work-unit`.
 *
 * This SDK computes identities and nullifiers. It does not, and cannot, say
 * whether a unit was already billed or settled: that needs shared state with
 * a first-write-wins rule, which belongs to whoever settles.
 *
 * @module
 */

import { callJson, encode, type JsonObject } from "./bridge.js";
import { Digest, type DigestWire } from "./canonical.js";

/** What counts as one unit of work, as the parties declared it. */
export interface WorkUnitScope {
  /** The name of the line of work. */
  readonly scope: string;
  /** What is done to the object. Different operations are different units. */
  readonly operation: string;
  /** The claim inputs that identify one unit, in order. */
  readonly identity: readonly string[];
}

/** The identity of one unit of work and, given the tenant's key, its nullifier. */
export interface WorkUnit {
  readonly version: string;
  /**
   * The identity's canonical text. **Plaintext**: it discloses the unit.
   * Share {@link WorkUnit.nullifier} where the unit itself should stay
   * private.
   */
  readonly identity: string;
  /** `hmac-sha-256:<hex>`. Equal nullifiers under one key are the same unit. */
  readonly nullifier: string | null;
  /** Pins the tenant's key without revealing it. */
  readonly keyCommitment: Digest | null;
}

/** What {@link workUnit} is given. Exactly one of `inputs` and `values`. */
export interface WorkUnitOptions {
  tenant: string;
  scope: WorkUnitScope;
  /** The claim's inputs; the scope picks the identifying ones. */
  inputs?: Readonly<Record<string, string | boolean>> | undefined;
  /** The identifying values, in the scope's order. */
  values?: readonly (string | boolean)[] | undefined;
  /**
   * The tenant's 32-byte nullifier key. Generating, storing and rotating it
   * is the caller's; whoever holds it can compute the nullifier of any
   * guessed unit, and rotating it changes every nullifier.
   */
  key?: Uint8Array | undefined;
}

/**
 * The work unit a claim is about.
 *
 * Values are compared exactly: `INV-01001` and `INV-1001` are different
 * units.
 */
export function workUnit(options: WorkUnitOptions): WorkUnit {
  if ((options.inputs === undefined) === (options.values === undefined)) {
    throw new RangeError("give exactly one of inputs and values");
  }
  const scope = encode(
    {
      scope: options.scope.scope,
      operation: options.scope.operation,
      identity: [...options.scope.identity],
    },
    "scope",
  );
  const values = options.values === undefined ? undefined : encode([...options.values], "values");
  const inputs = options.inputs === undefined ? undefined : encode(options.inputs, "inputs");
  const result = callJson((native) =>
    native.work_unit(options.tenant, scope, values, inputs, options.key),
  );
  const nullifier = result["nullifier"] as JsonObject | undefined;
  const commitment = result["keyCommitment"] as unknown as DigestWire | undefined;
  return Object.freeze({
    version: result["version"] as string,
    identity: result["identity"] as string,
    nullifier: nullifier === undefined ? null : `${nullifier["algorithm"]}:${nullifier["hex"]}`,
    keyCommitment: commitment === undefined ? null : Digest.fromWire(commitment),
  });
}
