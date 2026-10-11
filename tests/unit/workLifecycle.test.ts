// SPDX-License-Identifier: Apache-2.0

// The work lifecycle follows the protocol's transitions and no others.

import { expect, test } from "vitest";

import {
  AgentIdentity,
  AssemblyError,
  ContractError,
  canonicalize,
  Decision,
  Digest,
  LifecycleError,
  MalformedInputError,
  Verifier,
  Work,
  WorkContract,
  WorkState,
  type WorkUnitScope,
  workUnit,
} from "../../src/index.js";
import { Parties } from "../helpers.js";

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

test("a claim alone never yields a supported outcome", () => {
  const parties = new Parties();
  const work = parties.work();
  const states: WorkState[] = [work.state];
  expect(() => work.issue({ trust: parties.trust })).toThrow(LifecycleError);
  expect(() => work.issue({ trust: parties.trust })).toThrow(/no claim yet/);
  const claim = work.claim();
  states.push(work.state);
  expect(claim.evidence).toEqual([]);
  expect(claim.contract.equals(parties.contract.digest)).toBe(true);
  const issued = work.issue({ trust: parties.trust });
  states.push(work.state);
  expect(states).toEqual([WorkState.OPEN, WorkState.CLAIMED, WorkState.ISSUED]);
  expect(issued.decision).toBe(Decision.UNDETERMINED);
  expect(issued.issuerCheck.isComplete).toBe(true);
});

test("transitions happen once and in order", () => {
  const parties = new Parties();
  const work = parties.work();
  work.attach(parties.posting());
  work.claim();
  expect(() => work.claim()).toThrow(LifecycleError);
  expect(() => work.claim()).toThrow(/already fixed/);
  expect(() => work.attach(parties.listingComplete())).toThrow(/only while work is open/);
  work.issue({ trust: parties.trust });
  expect(() => work.issue({ trust: parties.trust })).toThrow(/already issued/);
  expect(work.issued).toBeDefined();
});

test("issue requires a registry", () => {
  const parties = new Parties();
  const work = parties.work();
  work.claim();
  expect(() => (work.issue as () => unknown)()).toThrow(TypeError);
  expect(() => work.issue({} as never)).toThrow(TypeError);
  expect(() => work.issue({ trust: null } as never)).toThrow(TypeError);
  // Nothing was issued on the way to the error.
  expect(work.state).toBe(WorkState.CLAIMED);
  expect(work.issued).toBeUndefined();
});

test("only signed evidence can be attached", () => {
  const parties = new Parties();
  const work = parties.work();
  const notEvidence = [
    { status: "posted" },
    "posted",
    { record: { kind: "posting", fields: { document: "D" } } },
    parties.posting().toWire(),
  ];
  for (const item of notEvidence) {
    expect(() => work.attach(item as never)).toThrow(TypeError);
    expect(() => work.attach(item as never)).toThrow(
      /not evidence until an identified source signs it/,
    );
  }
  expect(work.evidence).toEqual([]);
});

test("evidence of another tenant is refused", () => {
  const parties = new Parties();
  const other = new Parties("another-tenant", 20);
  const work = parties.work();
  expect(() => work.attach(other.posting())).toThrow(LifecycleError);
  expect(() => work.attach(other.posting())).toThrow(/another-tenant/);
  // Nothing of a refused batch is kept.
  expect(() => work.attach(parties.posting(), other.posting())).toThrow(LifecycleError);
  expect(work.evidence).toEqual([]);
});

test("inputs must be the contract's", () => {
  const parties = new Parties();
  const base = { contract: parties.contract, tenant: parties.tenant, claimant: parties.agent };
  expect(() => Work.begin({ ...base, inputs: {} })).toThrow(/declares the inputs/);
  expect(() => Work.begin({ ...base, inputs: { invoice: "INV-1", extra: "x" } })).toThrow(
    RangeError,
  );
  expect(() =>
    Work.begin({
      ...base,
      contract: "contracts/invoice-posting.json" as never,
      inputs: { invoice: "INV-1" },
    }),
  ).toThrow(/WorkContract/);
  expect(() =>
    Work.begin({ ...base, claimant: "invoice-agent", inputs: { invoice: "INV-1" } }),
  ).toThrow(/UUID/);
  expect(() => Work.begin({ ...base, inputs: { invoice: 1.5 } })).toThrow(TypeError);
});

test("evidence that does not fit the contract is an assembly error", () => {
  const parties = new Parties();
  const misfit = parties.gateway.record(
    "posting",
    { document: "D-1", unexpected: "x" },
    { subject: parties.subject() },
  );
  const work = parties.work();
  work.attach(misfit).claim();
  expect(() => work.issue({ trust: parties.trust })).toThrow(AssemblyError);
  expect(() => work.issue({ trust: parties.trust })).toThrow(
    /INPUT_MISMATCH.*ENVIRONMENT_NONCONFORMING/,
  );
  expect(work.state).toBe(WorkState.CLAIMED);
});

test("evidence observed after evaluation is refused", () => {
  const parties = new Parties();
  const work = parties.work();
  work.attach(parties.posting()).claim();
  expect(() => work.issue({ trust: parties.trust, evaluatedAt: "2026-03-01T09:00:00Z" })).toThrow(
    /INPUT_MISMATCH/,
  );
});

test("a time that names no instant is refused", () => {
  // Python refuses a naive datetime. A JavaScript Date always names an
  // instant, unless it is invalid.
  const parties = new Parties();
  expect(() =>
    parties.gateway.record(
      "posting",
      { document: "D" },
      { subject: parties.subject(), observedAt: new Date("not a date") },
    ),
  ).toThrow(RangeError);
  expect(() => parties.work().claim({ submittedAt: new Date(Number.NaN) })).toThrow(/no instant/);
  // Text is the verifier's to judge, and it does.
  expect(() =>
    parties.gateway.record(
      "posting",
      { document: "D" },
      { subject: parties.subject(), observedAt: "yesterday" },
    ),
  ).toThrow(/not well formed/);
});

test("fractions are refused, not rounded", () => {
  const parties = new Parties();
  expect(() =>
    parties.gateway.record(
      "posting",
      { document: "D", amount: 12.5 },
      { subject: parties.subject() },
    ),
  ).toThrow(/whole number/);
  expect(() => canonicalize({ amount: 12.5 })).toThrow(TypeError);
  expect(() => canonicalize({ amount: 12.5 })).toThrow(/no fractional numbers/);
  expect(() => canonicalize(new TextEncoder().encode('{"amount": 12.5}'))).toThrow(
    MalformedInputError,
  );
});

test("whole numbers are written as text, of any size", () => {
  const parties = new Parties();
  const record = parties.gateway.record(
    "posting",
    { document: "D", amount: 125_000, big: 12345678901234567890n, posted: true },
    { subject: parties.subject() },
  );
  expect((record.body()["record"] as { fields: unknown }).fields).toEqual({
    document: "D",
    amount: "125000",
    big: "12345678901234567890",
    posted: true,
  });
});

test("the same statement can serve several claims", () => {
  const parties = new Parties();
  const posting = parties.posting();
  const packages = [0, 1].map(() => {
    const work = parties.work();
    work.attach(posting, posting).claim();
    return work.issue({ trust: parties.trust });
  });
  expect(packages[0]?.packageId).not.toBe(packages[1]?.packageId);
  expect(packages.every((item) => item.decision === Decision.SUPPORTED)).toBe(true);
});

test("two different statements cannot share an identifier", () => {
  const parties = new Parties();
  const evidenceId = "00000000-0000-4000-8000-0000000000aa";
  const options = { subject: parties.subject(), evidenceId };
  const first = parties.gateway.record("posting", { document: "D-1" }, options);
  const second = parties.gateway.record("posting", { document: "D-2" }, options);
  const work = parties.work();
  work.attach(first);
  expect(() => work.attach(second)).toThrow(/share the identifier/);
  expect(work.evidence).toHaveLength(1);
});

test("racing transitions happen exactly once", async () => {
  // JavaScript runs one transition at a time; this pins that a transition is
  // not split across an await, so that tasks racing for it cannot both win.
  const parties = new Parties();
  const work = parties.work();
  work.attach(parties.posting());
  const outcomes = await Promise.all(
    Array.from({ length: 8 }, async () => {
      await Promise.resolve();
      try {
        work.claim();
        return "claimed";
      } catch (error) {
        expect(error).toBeInstanceOf(LifecycleError);
        return "refused";
      }
    }),
  );
  expect(outcomes.filter((outcome) => outcome === "claimed")).toHaveLength(1);
});

test("a contract is identified by its digest", () => {
  const parties = new Parties();
  const document = parties.contract.toObject();
  expect(WorkContract.fromObject(document).equals(parties.contract)).toBe(true);
  expect(WorkContract.fromJson(parties.contract.canonical).equals(parties.contract)).toBe(true);
  expect(parties.contract.requirementIds).toEqual(["POSTED"]);
  expect(parties.contract.acceptedSources).toEqual({ posting: ["erp"] });
  expect(parties.contract.inputNames).toEqual(["invoice"]);
  const reworded = WorkContract.fromObject({
    ...document,
    identity: { id: "invoice-posting", version: "1.0.1" },
  });
  expect(reworded.digest.equals(parties.contract.digest)).toBe(false);
  expect(reworded.equals(parties.contract)).toBe(false);

  let thrown: unknown;
  try {
    WorkContract.fromObject({ ...document, requires: [] });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ContractError);
  expect(["CONTRACT_ILL_FORMED", "CONTRACT_MALFORMED"]).toContain((thrown as ContractError).code);
  expect(() => WorkContract.fromObject({ ...document, code: "return true" })).toThrow(
    ContractError,
  );
});

test("work-unit identity survives contract versions and claims", () => {
  const parties = new Parties();
  const scope: WorkUnitScope = {
    scope: "invoice-posting",
    operation: "post",
    identity: ["invoice"],
  };
  const key = new Uint8Array(32).fill(9);
  const tenant = parties.tenant;
  const first = workUnit({ tenant, scope, inputs: parties.work().inputs, key });
  const again = workUnit({ tenant, scope, values: ["INV-1"], key });
  expect(first).toEqual(again);
  expect(first.identity).toBe(
    '["work-unit-1","tenant-synthetic","invoice-posting","post",["INV-1"]]',
  );
  expect(first.nullifier).toMatch(/^hmac-sha-256:[0-9a-f]{64}$/);
  expect(first.keyCommitment).toBeInstanceOf(Digest);

  const different = [
    workUnit({ tenant: "another-tenant", scope, values: ["INV-1"], key }),
    workUnit({ tenant, scope, values: ["INV-01"], key }),
    workUnit({ tenant, scope, values: ["INV-1"], key: new Uint8Array(32).fill(8) }),
    workUnit({ tenant, scope: { ...scope, operation: "reverse" }, values: ["INV-1"], key }),
  ];
  expect(new Set([first, ...different].map((unit) => unit.nullifier)).size).toBe(5);

  const withoutKey = workUnit({ tenant, scope, values: ["INV-1"] });
  expect(withoutKey.identity).toBe(first.identity);
  expect(withoutKey.nullifier).toBeNull();
  expect(withoutKey.keyCommitment).toBeNull();
  expect(() => workUnit({ tenant, scope })).toThrow(/exactly one/);
  expect(() =>
    workUnit({ tenant, scope, values: ["INV-1"], inputs: { invoice: "INV-1" } }),
  ).toThrow(/exactly one/);
  expect(() => workUnit({ tenant, scope, values: ["INV-1"], key: new Uint8Array(31) })).toThrow(
    /32 bytes/,
  );
});

test("a billing application gets identifiers, not a verdict", () => {
  // What a consumer such as Agent Billing Center re-verifies from.
  const parties = new Parties();
  const work = parties.work();
  work.attach(parties.posting()).claim();
  const issued = work.issue({ trust: parties.trust, issuer: parties.issuer });
  const result = new Verifier({ trust: parties.trust }).verify(issued.package);
  expect(result.packageId).toBe(issued.packageId);
  expect(issued.package.statedPackageId).toBe(issued.packageId);
  expect(result.packageId?.replace("wvp:sha-256:", "")).toBe(
    result.workRecord?.packageCommitment.hex,
  );
  expect(issued.package.byteDigest.equals(Digest.ofBytes(issued.package.text))).toBe(true);
  expect(result.stated?.claimant).toBe(parties.agent.id);
  expect(result.stated?.inputs).toEqual({ invoice: "INV-1" });
  expect(result.verifier).toMatch(/^verified-verifier-[0-9a-f]{40}$/);
  expect(result.trustRegistry?.equals(parties.trust.byteDigest)).toBe(true);
  expect("billable" in result).toBe(false);
  expect("accepted" in result).toBe(false);
});

test("agent identity is stable and explicit", () => {
  const id = (name: string, version?: string): string =>
    new AgentIdentity(name, version === undefined ? {} : { version }).id;
  expect(id("a", "1")).toBe(id("a", "1"));
  expect(id("a", "1")).not.toBe(id("a", "2"));
  expect(id("ab", "c")).not.toBe(id("a", "bc"));
  const given = "00000000-0000-4000-8000-000000000001";
  expect(new AgentIdentity("a", { id: given }).id).toBe(given);
  expect(new AgentIdentity("a", { id: given.toUpperCase() }).id).toBe(given);
  expect(() => new AgentIdentity("a", { id: "agent-1" })).toThrow(/UUID/);
});

test("canonical encoding is stable and ignores key order", () => {
  // A fixed pseudo-random sequence, so a failure can be reproduced.
  let state = 0x9e3779b9;
  const next = (bound: number): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % bound;
  };
  const texts = ["", "a", "é", "😀", '"quoted"', "line\nbreak", "\u0000", "b", "aa", "퟿"];
  const leaf = (): unknown => {
    const kind = next(6);
    if (kind === 0) return null;
    if (kind === 1) return next(2) === 0;
    if (kind === 2) return next(2_000_001) - 1_000_000;
    if (kind === 3) return Number.MAX_SAFE_INTEGER - next(1000);
    return texts[next(texts.length)];
  };
  const value = (depth: number): unknown => {
    const kind = depth === 0 ? 0 : next(3);
    if (kind === 1) {
      return Array.from({ length: next(5) }, () => value(depth - 1));
    }
    if (kind === 2) {
      return Object.fromEntries(
        Array.from({ length: next(5) }, () => [texts[next(texts.length)], value(depth - 1)]),
      );
    }
    return leaf();
  };
  for (let round = 0; round < 200; round += 1) {
    const item = value(3);
    const once = canonicalize(item);
    expect(decode(canonicalize(once))).toBe(decode(once));
    expect(JSON.parse(decode(once))).toEqual(item);
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      const reversed = Object.fromEntries(Object.entries(item).reverse());
      expect(decode(canonicalize(reversed))).toBe(decode(once));
    }
    expect(Digest.ofJson(item).equals(Digest.ofJson(once))).toBe(true);
  }
});

test("a string given to a verifier is package text, never a path", () => {
  // Python takes a str as a path and refuses one that looks like JSON. This
  // SDK's core reads no files, so a string is the package text itself.
  const parties = new Parties();
  const verifier = new Verifier({ trust: parties.trust });
  expect(verifier.verify('{"files": []}').refusal).not.toBeNull();
  const refused = verifier.verify("examples/standalone-verification/supported.json");
  expect(refused.refusal).not.toBeNull();
  expect(refused.decision).toBeNull();

  const work = parties.work();
  work.attach(parties.posting()).claim();
  const text = decode(work.issue({ trust: parties.trust }).package.text);
  verifier.verify(text).requireSupported();
});
