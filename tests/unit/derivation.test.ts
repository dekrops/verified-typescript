// SPDX-License-Identifier: Apache-2.0

// Replaying a recomputed authorization: the API around the shared replayer.
//
// The rules are the replayer's, measured upstream against the first
// implementation. These tests cover what the TypeScript layer adds: types,
// refusals of bad input, and the things a replay must never be mistaken for.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import type { JsonObject } from "../../src/bridge.js";
import {
  AuthorizationOutcome,
  ReplayOutcome,
  replayDerivation,
  TrustRegistry,
} from "../../src/index.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/derivation/${name}`, import.meta.url)), "utf8");
const TRUST = TrustRegistry.fromJson(fixture("trust.json"));
const pack = (name: string): JsonObject =>
  (JSON.parse(fixture(`${name}.json`)) as { package: JsonObject }).package;

test("a package is reproduced from its evidence", () => {
  const replay = replayDerivation(pack("01-allowed"), TRUST);

  expect(replay.outcome).toBe(ReplayOutcome.REPRODUCED);
  expect(replay.draft).toBe(true);
  expect(replay.decision).toBe("SUPPORTED");
  expect(replay.commitment).not.toBeNull();
  expect(replay.authorizations).toHaveLength(1);
  const authorization = replay.authorizations[0];
  expect(authorization?.correlation).toBe("WF-7");
  expect(authorization?.outcome).toBe(AuthorizationOutcome.ALLOW);
  expect(authorization?.reasons).toEqual([]);
  expect(authorization?.engineDecision).toBe("Allow");
  expect([replay.stage, replay.code, replay.detail]).toEqual([null, null, []]);
});

test("Cedar's own answer is kept apart from the outcome", () => {
  const replay = replayDerivation(pack("09-evaluation-error"), TRUST);

  // Reproduced: this verifier arrived at the same undetermined result.
  expect(replay.outcome).toBe(ReplayOutcome.REPRODUCED);
  const authorization = replay.authorizations[0];
  // Cedar skipped a policy that failed to evaluate, and allowed.
  expect(authorization?.engineDecision).toBe("Allow");
  expect(authorization?.outcome).toBe(AuthorizationOutcome.UNDETERMINED);
  expect(authorization?.reasons).toEqual(["EVALUATION_ERROR"]);
  expect(replay.decision).toBe("UNDETERMINED");
});

test("a requirement is bound to the derivations it depends on", () => {
  const replay = replayDerivation(pack("15-two-requirements-one-derivation"), TRUST);

  expect(replay.bindings.map((binding) => binding.requirement)).toEqual([
    "APPROVAL_AUTHORIZED",
    "DECISION_NAMES_THE_ORDER",
  ]);
  const [first, second] = replay.bindings;
  expect(first?.derivations).toEqual(second?.derivations);
  expect(first?.method).toBe("verified-cedar-recomputation");
  expect(first?.derivations[0]?.commitment.hex).toBe(replay.authorizations[0]?.commitment.hex);
  expect(first?.derivations[0]?.record).not.toBeNull();
});

test("a presented result the evidence does not yield is not reproduced", () => {
  const replay = replayDerivation(pack("25-outcome-altered"), TRUST);

  expect(replay.outcome).toBe(ReplayOutcome.NOT_REPRODUCED);
  expect([replay.stage, replay.code]).toEqual(["DERIVATION", "NOT_REPRODUCED"]);
  expect(replay.detail[0]).toContain('presented "ALLOW" computed "DENY"');
  expect(replay.commitment).toBeNull();
  expect(replay.decision).toBeNull();
  expect(replay.authorizations).toEqual([]);
});

test("the registry is yours and never the package's", () => {
  const replay = replayDerivation(pack("01-allowed"), TrustRegistry.fromJson('{"keys":[]}'));

  expect([replay.outcome, replay.stage, replay.code]).toEqual([
    ReplayOutcome.NOT_REPRODUCED,
    "EVIDENCE",
    "UNKNOWN_KEY",
  ]);
});

test("what is not a replay package is not reproduced, and a bad registry is an error", () => {
  const other = replayDerivation({ package: "something-else" }, TRUST);
  expect([other.stage, other.code]).toEqual(["PACKAGE", "UNSUPPORTED_PACKAGE"]);

  expect(() => replayDerivation(pack("01-allowed"), { keys: [] } as never)).toThrow(TypeError);
});
