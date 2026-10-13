// SPDX-License-Identifier: Apache-2.0

// A recomputed authorization, replayed (a draft, and not part of the
// protocol).
//
// A work contract often requires that someone was authorized. A relying
// party that trusts neither a directory's flat list nor the enforcing
// system's word can hold the policy set and the entity records as signed
// evidence, and the decision follows from them by the Cedar policy language.
// A replay package carries a contract, signed statements and the result a
// first verifier arrived at. `replayDerivation` computes that result again
// from the evidence, under your trust registry, and compares.
//
// This is proposed for the protocol as RFC 0005 and is not part of it. The
// formats say `experimental`; this function may change or be removed.
//
// Every rule is in the shared Rust replayer (`verified-derivation`). Nothing
// in this file prepares, decides or compares anything.

import { callJson, encode, type JsonObject } from "./bridge.js";
import { Digest, type DigestWire } from "./canonical.js";
import { TrustRegistry } from "./trust.js";

/** Whether the presented result was computed again. */
export const ReplayOutcome = {
  /** Every commitment was computed again and is the one presented. Not a statement that anything was authorized. */
  REPRODUCED: "reproduced",
  /** A stage did not hold: see `stage`, `code` and `detail`. */
  NOT_REPRODUCED: "not-reproduced",
} as const;
export type ReplayOutcome = (typeof ReplayOutcome)[keyof typeof ReplayOutcome];

/** What the evidence yields for one work event. */
export const AuthorizationOutcome = {
  ALLOW: "ALLOW",
  DENY: "DENY",
  /** Not a denial. Nothing is established: see `reasons`. */
  UNDETERMINED: "UNDETERMINED",
} as const;
export type AuthorizationOutcome = (typeof AuthorizationOutcome)[keyof typeof AuthorizationOutcome];

/** One authorization, recomputed for one work event. */
export interface AuthorizationReplay {
  /** The work event's identifier. */
  readonly correlation: string;
  readonly outcome: AuthorizationOutcome;
  /** The failed guards. Empty for a definite outcome. */
  readonly reasons: readonly string[];
  /**
   * What Cedar itself returned, `Allow` or `Deny`; `null` if a guard failed
   * first and it was never asked. A diagnostic, never the outcome: Cedar
   * answers `Allow` when it has skipped a policy that failed to evaluate.
   */
  readonly engineDecision: string | null;
  readonly commitment: Digest;
  /** This verifier's own account: its engine and its messages. */
  readonly diagnostics: JsonObject;
}

/** A derivation a requirement depends on. */
export interface BoundDerivation {
  readonly correlation: string;
  readonly commitment: Digest;
  /** The identifier of the record it yielded; `null` if it yielded none. */
  readonly record: string | null;
}

/**
 * A contract requirement and the derivations it depends on, read from the
 * contract. It names every derivation the requirement can see, not the
 * record that decided it.
 */
export interface RequirementBinding {
  readonly requirement: string;
  readonly method: string;
  readonly methodVersion: string;
  readonly derivations: readonly BoundDerivation[];
}

/**
 * What a replay arrived at.
 *
 * - `reproduced` means this verifier computed the presented result again
 *   from the statements. It does not mean the action was authorized: look at
 *   each authorization's outcome and at the contract's decision.
 * - Nothing presented is believed. A result with consistent digests that the
 *   evidence does not yield is `not-reproduced`, with the member that
 *   differs.
 * - No source is shown to have told the truth.
 */
export interface DerivationReplay {
  readonly outcome: ReplayOutcome;
  /** The commitment of the derived evaluation, when reproduced. */
  readonly commitment: Digest | null;
  /** The contract's decision, when reproduced. */
  readonly decision: string | null;
  readonly authorizations: readonly AuthorizationReplay[];
  readonly bindings: readonly RequirementBinding[];
  /** Where a replay stopped: `PACKAGE`, `EVIDENCE`, `CONTRACT`, `PROFILE`, `DERIVATION` or `EVALUATION`. */
  readonly stage: string | null;
  readonly code: string | null;
  /** Each member that differs, with the presented and the computed value. */
  readonly detail: readonly string[];
  /** Always `true`: this is not a WVP verification and not a Work Record. */
  readonly draft: true;
  /** The report exactly as the shared replayer states it. */
  readonly raw: JsonObject;
}

type Raw = Record<string, unknown>;

const digest = (wire: unknown): Digest => {
  const { hex, algorithm } = wire as DigestWire;
  return new Digest(hex, algorithm);
};

const optional = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * Computes a presented recomputed authorization again from its evidence.
 *
 * `pack` is a replay package: a contract, a profile, signed statements with
 * their bodies, and the result a first verifier presented. `trust` is your
 * registry: a statement is read only from a key it trusts for the
 * statement's source, and the registry is never taken from the package.
 *
 * Offline. The time and memory the engine spends are not bounded: do not
 * call this on packages from parties you would not let run code.
 */
export function replayDerivation(pack: JsonObject, trust: TrustRegistry): DerivationReplay {
  if (!(trust instanceof TrustRegistry)) {
    throw new TypeError("trust is a TrustRegistry");
  }
  const carried = encode(pack, "package");
  const registry = trust.toBytes();
  const raw = callJson((native) => native.replay_derivation(carried, registry));
  const list = (name: string): Raw[] => (raw[name] as Raw[] | undefined) ?? [];
  return {
    outcome: raw["outcome"] as ReplayOutcome,
    commitment: raw["commitment"] === undefined ? null : digest(raw["commitment"]),
    decision: optional(raw["decision"]),
    authorizations: list("authorization").map((item) => ({
      correlation: item["correlation"] as string,
      outcome: item["outcome"] as AuthorizationOutcome,
      reasons: item["reasons"] as string[],
      engineDecision: optional(item["engineDecision"]),
      commitment: digest(item["commitment"]),
      diagnostics: item["diagnostics"] as JsonObject,
    })),
    bindings: list("bindings").map((item) => ({
      requirement: item["requirement"] as string,
      method: (item["method"] as Raw)["name"] as string,
      methodVersion: (item["method"] as Raw)["version"] as string,
      derivations: (item["derivations"] as Raw[]).map((bound) => ({
        correlation: bound["correlation"] as string,
        commitment: digest(bound["commitment"]),
        record: optional(bound["record"]),
      })),
    })),
    stage: optional(raw["stage"]),
    code: optional(raw["code"]),
    detail: (raw["detail"] as string[] | undefined) ?? [],
    draft: true,
    raw,
  };
}
