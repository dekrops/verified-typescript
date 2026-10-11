// SPDX-License-Identifier: Apache-2.0

// What a verification result may and may not be taken to mean.
//
// These tests pin security semantics, not API shape. A change that makes one
// of them fail is a change in what the SDK lets a developer believe.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  AssemblyError,
  Decision,
  DecisionIssuer,
  Ed25519Signer,
  EvidenceSource,
  type Expectations,
  type JsonObject,
  PropertyStatus,
  RequirementNotMet,
  ResourceLimitError,
  type Signer,
  SigningAuthority,
  SigningAuthorityError,
  TrustRegistry,
  TrustRegistryError,
  UnsupportedOperationError,
  VerificationStatus,
  Verifier,
  WorkContract,
  type WorkPackage,
} from "../../src/index.js";
import { readPackage, readTrustRegistry } from "../../src/node.js";
import { component, corpusDir, edit, editAndReseal, type Loose, Parties } from "../helpers.js";

function supported(parties: Parties, options: { signed?: boolean } = {}): WorkPackage {
  const work = parties.work();
  work.attach(parties.posting(), parties.listingComplete()).claim();
  return work.issue({
    trust: parties.trust,
    issuer: options.signed ? parties.issuer : undefined,
  }).package;
}

function undetermined(parties: Parties): WorkPackage {
  const work = parties.work();
  work.claim();
  return work.issue({ trust: parties.trust }).package;
}

function contradicted(parties: Parties): WorkPackage {
  const work = parties.work();
  work.attach(parties.listingComplete()).claim();
  return work.issue({ trust: parties.trust }).package;
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const temporary = (): string => mkdtempSync(join(tmpdir(), "verified-typescript-"));

// --- verification is not success ---------------------------------------------

describe("verification is not success", () => {
  test("the three decisions are all complete verifications", () => {
    const parties = new Parties();
    const verifier = new Verifier({ trust: parties.trust });
    for (const [workPackage, decision] of [
      [supported(parties), Decision.SUPPORTED],
      [undetermined(parties), Decision.UNDETERMINED],
      [contradicted(parties), Decision.CONTRADICTED],
    ] as const) {
      const result = verifier.verify(workPackage);
      expect(result.verificationStatus).toBe(VerificationStatus.COMPLETE);
      expect(result.decision).toBe(decision);
      expect(result.requireComplete()).toBe(result);
    }
  });

  test("requireSupported refuses contradicted and undetermined", () => {
    const parties = new Parties();
    const verifier = new Verifier({ trust: parties.trust });
    verifier.verify(supported(parties)).requireSupported();
    for (const workPackage of [contradicted(parties), undetermined(parties)]) {
      const result = verifier.verify(workPackage);
      let thrown: unknown;
      try {
        result.requireSupported();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(RequirementNotMet);
      // The handler can still tell what happened.
      const carried = (thrown as RequirementNotMet).result;
      expect(carried.isComplete).toBe(true);
      expect(carried.decision).not.toBe(Decision.SUPPORTED);
    }
  });

  test("a result offers no single flag to read as a boolean", () => {
    const parties = new Parties();
    const result = new Verifier({ trust: parties.trust }).verify(supported(parties));
    // JavaScript cannot make an object falsy or make truthiness throw, so the
    // guarantee here is that nothing on a result invites the mistake.
    for (const name of ["valid", "ok", "verified", "success", "isValid"]) {
      expect(name in result, name).toBe(false);
    }
    // A refused result is just as truthy as a supported one: truthiness says nothing.
    const refused = new Verifier({ trust: parties.trust }).verify("{}");
    expect(refused.verificationStatus).toBe(VerificationStatus.REFUSED);
    expect(Boolean(refused)).toBe(Boolean(result));
  });

  test("source truthfulness is never established", () => {
    const parties = new Parties();
    for (const trust of [parties.trust, null]) {
      const result = new Verifier({ trust }).verify(supported(parties, { signed: true }));
      expect(result.sourceTruthfulness.status).toBe(PropertyStatus.NOT_ESTABLISHED);
      expect(result.sourceTruthfulness.established).toBe(false);
      expect(result.explain()).toContain("source truthfulness   NOT established");
    }
  });

  test("missing evidence is undetermined, never contradicted or supported", () => {
    // A posting for another invoice, and no statement that the listing is
    // complete: nothing says the claimed invoice was not posted.
    const parties = new Parties();
    const work = parties.work("INV-1");
    work.attach(parties.posting("INV-2", "D-2")).claim();
    expect(work.issue({ trust: parties.trust }).decision).toBe(Decision.UNDETERMINED);
  });
});

// --- trust is the relying party's --------------------------------------------

function registryWith(parties: Parties, keyId: string, changes: JsonObject): TrustRegistry {
  const keys = parties.trust.toObject()["keys"] as JsonObject[];
  for (const key of keys) {
    if (key["keyId"] === keyId) {
      Object.assign(key, changes);
    }
  }
  return TrustRegistry.fromKeys(keys);
}

describe("trust is the relying party's", () => {
  test("without a registry nothing but integrity is established", () => {
    const parties = new Parties();
    const result = new Verifier({ trust: null }).verify(supported(parties, { signed: true }));
    expect(result.verificationStatus).toBe(VerificationStatus.INCOMPLETE);
    expect(result.integrity.established).toBe(true);
    expect(result.decision).toBeNull();
    expect(result.evidenceSignatures.status).toBe(PropertyStatus.NOT_CHECKED);
    expect(result.signerAuthority.reason).toBe("no_trust_registry");
    expect(result.issuerSignature.status).toBe(PropertyStatus.NOT_CHECKED);
    expect(result.verifiedIssuerKeys).toBeNull();
    // The package says SUPPORTED. That is only what it says.
    expect(result.stated?.recordedDecision).toBe("SUPPORTED");
    expect(() => result.requireSupported()).toThrow(RequirementNotMet);
    expect(() => result.requireSupported()).toThrow(/incomplete/);
    expect(() => result.requireComplete()).toThrow(/incomplete/);
  });

  test("trust must be stated and must be a registry", () => {
    const parties = new Parties();
    expect(() => new Verifier(undefined as never)).toThrow(TypeError);
    expect(() => new Verifier({} as never)).toThrow(TypeError);
    expect(() => new Verifier({ trust: undefined } as never)).toThrow(/no default/);
    expect(() => new Verifier({ trust: parties.trust.toObject() } as never)).toThrow(
      /TrustRegistry/,
    );
  });

  test("a key the relying party does not hold is refused", () => {
    const parties = new Parties();
    const stranger = new Parties("tenant-synthetic", 40);
    let result = new Verifier({ trust: stranger.trust }).verify(supported(parties));
    expect(result.refusal?.code).toBe("SIGNATURE_INVALID"); // same key id, another key

    const keys = parties.trust.toObject()["keys"] as JsonObject[];
    const withoutGateway = TrustRegistry.fromKeys(
      keys.filter((key) => key["keyId"] !== "erp-gateway-1"),
    );
    result = new Verifier({ trust: withoutGateway }).verify(supported(parties));
    expect(result.refusal?.code).toBe("UNKNOWN_KEY");
    expect(result.decision).toBeNull();
  });

  test("revoked and expired keys are refused", () => {
    const parties = new Parties();
    const workPackage = supported(parties);
    const before = { value: "2026-02-01T00:00:00Z" };
    for (const change of [{ revokedAt: before }, { validUntil: before }]) {
      const result = new Verifier({
        trust: registryWith(parties, "erp-gateway-1", change),
      }).verify(workPackage);
      expect(result.refusal?.code).toBe("KEY_NOT_VALID");
    }
    // Revoked after the statement was observed: the statement still counts.
    const later = { revokedAt: { value: "2027-01-01T00:00:00Z" } };
    new Verifier({ trust: registryWith(parties, "erp-gateway-1", later) })
      .verify(workPackage)
      .requireSupported();
  });

  test("a key trusted for another tenant or source is refused", () => {
    const parties = new Parties();
    const workPackage = supported(parties);
    const cases: [JsonObject, string][] = [
      [{ tenant: { value: "another-tenant" } }, "TENANT_MISMATCH"],
      [{ sources: ["crm"] }, "SOURCE_NOT_AUTHORIZED"],
      [{ issuer: { value: "00000000-0000-4000-8000-00000000ffff" } }, "ISSUER_MISMATCH"],
    ];
    for (const [change, code] of cases) {
      const result = new Verifier({
        trust: registryWith(parties, "erp-gateway-1", change),
      }).verify(workPackage);
      expect(result.refusal?.code, code).toBe(code);
    }
  });

  test("a misspelt registry member is an error, not a default", () => {
    const parties = new Parties();
    const keys = parties.trust.toObject()["keys"] as JsonObject[];
    (keys[0] as JsonObject)["revokedat"] = { value: "2026-02-01T00:00:00Z" };
    expect(() => TrustRegistry.fromKeys(keys)).toThrow(TrustRegistryError);
    expect(() => TrustRegistry.fromJson("{}")).toThrow(TrustRegistryError);
    expect(() => TrustRegistry.fromJson("not json")).toThrow(TrustRegistryError);
  });

  test("a registry cannot alias one key under two names", () => {
    const parties = new Parties();
    const keys = parties.trust.toObject()["keys"] as JsonObject[];
    const alias = { ...keys[0], keyId: "alias" };
    expect(() => TrustRegistry.fromKeys([...keys, alias])).toThrow(TrustRegistryError);
  });

  test("a missing registry file is a registry error", () => {
    expect(() => readTrustRegistry(join(temporary(), "nowhere.json"))).toThrow(TrustRegistryError);
  });
});

// --- expectations ------------------------------------------------------------

test("wrong tenant, contract and claim are refused", () => {
  const parties = new Parties();
  const workPackage = supported(parties);
  const verifier = new Verifier({ trust: parties.trust });
  const other = WorkContract.fromObject({
    ...parties.contract.toObject(),
    identity: { id: "invoice-posting", version: "2.0.0" },
  });
  const cases: [Expectations, string][] = [
    [{ tenant: "another-tenant" }, "TENANT_NOT_EXPECTED"],
    [{ contract: other }, "CONTRACT_NOT_EXPECTED"],
    [{ claim: "00000000-0000-4000-8000-000000000000" }, "CLAIM_NOT_EXPECTED"],
  ];
  for (const [expectations, code] of cases) {
    const result = verifier.verify(workPackage, { expect: expectations });
    expect(result.verificationStatus).toBe(VerificationStatus.REFUSED);
    expect(result.refusal?.code).toBe(code);
    expect(result.decision).toBeNull();
  }
  const met = verifier.verify(workPackage, {
    expect: { tenant: parties.tenant, contract: parties.contract },
  });
  expect(met.expectationsMet.tenant).toBe(parties.tenant);
  expect(met.expectationsMet.contract?.equals(parties.contract.digest)).toBe(true);
  expect(met.expectationsMet.claim).toBeNull();
  // The digest, in either spelling, pins the same contract.
  for (const contract of [parties.contract.digest, parties.contract.digest.toString()]) {
    verifier.verify(workPackage, { expect: { contract } }).requireSupported();
  }
});

// --- tampering ---------------------------------------------------------------

describe("tampering", () => {
  test("altered evidence is refused", () => {
    const parties = new Parties();
    const change = (value: Loose): void => {
      const bodies = component(value, "evidence/bodies.json") as Loose[];
      const record = bodies.find((item) => "record" in item.body).body.record;
      record.fields.invoice = "INV-999";
    };
    const verifier = new Verifier({ trust: parties.trust });
    expect(verifier.verify(edit(supported(parties), change)).refusal?.code).toBe(
      "COMPONENT_DIGEST",
    );
    // Hiding the change by recomputing every digest runs into the signature.
    const resealed = verifier.verify(editAndReseal(supported(parties), change));
    expect(resealed.refusal?.code).toBe("PAYLOAD_MISMATCH");
  });

  test("an overstated decision is refused even when resealed", () => {
    const parties = new Parties();
    const overstate = (value: Loose): void => {
      const decision = component(value, "decision.json");
      decision.decision = "SUPPORTED";
      decision.requirements[0].value = "TRUE";
    };
    for (const workPackage of [undetermined(parties), contradicted(parties)]) {
      const result = new Verifier({ trust: parties.trust }).verify(
        editAndReseal(workPackage, overstate),
      );
      expect(result.refusal?.code).toBe("DECISION_MISMATCH");
      // Without a registry the lie is not caught, and is not believed either.
      const unchecked = new Verifier({ trust: null }).verify(editAndReseal(workPackage, overstate));
      expect(unchecked.verificationStatus).toBe(VerificationStatus.INCOMPLETE);
      expect(unchecked.decision).toBeNull();
    }
  });

  test("dropping inconvenient evidence is refused", () => {
    const parties = new Parties();
    const drop = (value: Loose): void => {
      component(value, "evidence/bodies.json").length = 0;
      component(value, "evidence/statements.json").length = 0;
    };
    const result = new Verifier({ trust: parties.trust }).verify(
      editAndReseal(contradicted(parties), drop),
    );
    expect(result.refusal?.code).toBe("MISSING_EVIDENCE");
  });

  test("no single byte change yields a supported result", () => {
    const parties = new Parties();
    const original = supported(parties).text;
    const verifier = new Verifier({ trust: parties.trust });
    // A fixed pseudo-random sequence, so a failure can be reproduced.
    let state = 0x2545f491;
    const next = (bound: number): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state % bound;
    };
    for (let round = 0; round < 300; round += 1) {
      const index = next(original.length);
      const altered = original.slice();
      altered[index] = ((original[index] as number) + 1 + next(255)) % 256;
      expect(altered[index]).not.toBe(original[index]);
      const result = verifier.verify(altered);
      expect(result.verificationStatus, `byte ${index} -> ${altered[index]}`).toBe(
        VerificationStatus.REFUSED,
      );
      expect(result.decision).toBeNull();
    }
  });
});

// --- malformed and oversized input -------------------------------------------

describe("malformed and oversized input", () => {
  const malformed: [string, Uint8Array][] = [
    ["empty", bytes("")],
    ["not json", bytes("not json")],
    ["an empty object", bytes("{}")],
    ["an empty list", bytes("[]")],
    ["files is a number", bytes('{"files":1}')],
    ["not UTF-8", Uint8Array.of(0xff, 0xfe)],
    ["a duplicate key", bytes('{"a":1,"a":2}')],
    ["a fraction", bytes("0.5")],
  ];

  test.each(malformed)("%s is refused, not crashed on", (_name, input) => {
    const parties = new Parties();
    const result = new Verifier({ trust: parties.trust }).verify(input);
    expect(result.verificationStatus).toBe(VerificationStatus.REFUSED);
    expect(result.decision).toBeNull();
  });

  test("a reformatted package is not the package", () => {
    const parties = new Parties();
    const text = new TextDecoder().decode(supported(parties).text);
    const pretty = JSON.stringify(JSON.parse(text), null, 2);
    const result = new Verifier({ trust: parties.trust }).verify(pretty);
    expect(result.refusal?.code).toBe("NOT_CANONICAL");
  });

  test("resource limits are errors, not refusals", () => {
    const parties = new Parties();
    const workPackage = supported(parties);
    expect(() => new Verifier({ trust: parties.trust, maxBytes: 100 }).verify(workPackage)).toThrow(
      ResourceLimitError,
    );
    expect(() =>
      new Verifier({ trust: parties.trust, maxBytes: 100 }).verify(" ".repeat(4096)),
    ).toThrow(ResourceLimitError);
    expect(() => new Verifier({ trust: parties.trust }).verify("[".repeat(100_000))).toThrow(
      ResourceLimitError,
    );
    expect(() => new Verifier({ trust: parties.trust, maxBytes: 10 ** 12 })).toThrow(/maxBytes/);
    expect(() => new Verifier({ trust: parties.trust, maxBytes: 0 })).toThrow(RangeError);
    expect(() => new Verifier({ trust: parties.trust, maxBytes: 1.5 })).toThrow(RangeError);
  });

  test("a file may end with exactly one line end", () => {
    const parties = new Parties();
    const workPackage = supported(parties);
    const directory = temporary();
    const [one, two, crlf] = ["one.json", "two.json", "crlf.json"].map((name) =>
      join(directory, name),
    ) as [string, string, string];
    writeFileSync(one, Buffer.concat([workPackage.text, bytes("\n")]));
    writeFileSync(two, Buffer.concat([workPackage.text, bytes("\n\n")]));
    writeFileSync(crlf, Buffer.concat([workPackage.text, bytes("\r\n")]));
    const verifier = new Verifier({ trust: parties.trust });
    verifier.verify(readPackage(one)).requireSupported();
    verifier.verify(readPackage(crlf)).requireSupported();
    expect(verifier.verify(readPackage(two)).verificationStatus).toBe(VerificationStatus.REFUSED);
    // The line end is the file's. Bytes handed over directly are taken as they are.
    expect(verifier.verify(readFileSync(one)).verificationStatus).toBe(VerificationStatus.REFUSED);
  });
});

// --- issuer signatures -------------------------------------------------------

describe("issuer signatures", () => {
  test("an issuer signature is separate from a reproduced decision", () => {
    const parties = new Parties();
    const verifier = new Verifier({ trust: parties.trust });
    const unsigned = verifier.verify(supported(parties));
    expect(unsigned.issuerSignature.status).toBe(PropertyStatus.ABSENT);
    unsigned.requireSupported();
    expect(() => unsigned.requireSupported({ issuerSigned: true })).toThrow(RequirementNotMet);
    expect(() => unsigned.requireSupported({ issuerSigned: true })).toThrow(/issuer signature/);

    const signed = verifier.verify(supported(parties, { signed: true }));
    signed.requireSupported({ issuerSigned: true });
    expect(signed.verifiedIssuerKeys).toEqual(["decision-issuer-1"]);
    expect(signed.packageId).not.toBeNull();
  });

  test("a signed and an unsigned package share an identifier and differ in bytes", () => {
    const parties = new Parties();
    const fixed = {
      claimId: "00000000-0000-4000-8000-00000000c1a1",
      evidenceSetId: "00000000-0000-4000-8000-00000000e5e7",
      at: "2026-03-01T12:00:00Z",
    };
    const posting = parties.posting();
    const issue = (signed: boolean) => {
      const work = parties.work("INV-1", { claimId: fixed.claimId });
      work.attach(posting).claim({ submittedAt: fixed.at });
      return work.issue({
        trust: parties.trust,
        issuer: signed ? parties.issuer : undefined,
        evaluatedAt: fixed.at,
        evidenceSetId: fixed.evidenceSetId,
      });
    };
    const [unsigned, signed] = [issue(false), issue(true)];
    expect(signed.packageId).toBe(unsigned.packageId);
    expect(signed.package.byteDigest.equals(unsigned.package.byteDigest)).toBe(false);
  });

  test("an evidence key cannot sign a decision", () => {
    const parties = new Parties();
    expect(
      () =>
        new DecisionIssuer({ authority: parties.gatewayAuthority, signer: parties.gatewaySigner }),
    ).toThrow(SigningAuthorityError);
    expect(
      () =>
        new DecisionIssuer({ authority: parties.gatewayAuthority, signer: parties.gatewaySigner }),
    ).toThrow(/wvp-decision/);
    const lying = new SigningAuthority({
      keyId: "erp-gateway-1",
      issuer: parties.gatewayAuthority.issuer,
      tenant: parties.tenant,
      sources: ["wvp-decision"],
    });
    const work = parties.work();
    work.attach(parties.posting()).claim();
    const issue = (): unknown =>
      work.issue({
        trust: parties.trust,
        issuer: new DecisionIssuer({ authority: lying, signer: parties.gatewaySigner }),
      });
    expect(issue).toThrow(AssemblyError);
    expect(issue).toThrow(/ISSUER_SIGNATURE_INVALID/);
    expect(work.issued).toBeUndefined();
  });
});

// --- work records ------------------------------------------------------------

describe("work records", () => {
  test("a work record binds one package", () => {
    const parties = new Parties();
    const verifier = new Verifier({ trust: parties.trust });
    const [first, second] = [supported(parties), contradicted(parties)];
    const record = verifier.verify(first).workRecord;
    if (record === null) {
      throw new Error("a complete wvp-0.2 verification computes a work record");
    }
    expect(record.decision).toBe("SUPPORTED");
    expect(verifier.verify(first, { record }).recordMatched).toBe(true);
    expect(verifier.verify(first).recordMatched).toBe(false);
    const mismatch = verifier.verify(second, { record });
    expect(mismatch.refusal?.code).toBe("RECORD_MISMATCH");
  });

  test.skipIf(corpusDir() === undefined)("a work record for wvp-0.1 is an error", () => {
    const parties = new Parties();
    const vector = JSON.parse(
      readFileSync(join(corpusDir() as string, "wvp", "v0.1", "valid", "supported.json"), "utf8"),
    );
    const record = new Verifier({ trust: parties.trust }).verify(supported(parties)).workRecord;
    expect(record).not.toBeNull();
    expect(() =>
      new Verifier({ trust: TrustRegistry.fromJson(JSON.stringify(vector.registry)) }).verify(
        vector.packageJson,
        { record: record ?? undefined },
      ),
    ).toThrow(UnsupportedOperationError);
  });
});

// --- signing authority -------------------------------------------------------

describe("signing authority", () => {
  test("an agent key cannot speak for the ERP", () => {
    const parties = new Parties();
    const asErp = (): unknown =>
      new EvidenceSource({
        system: "erp",
        authority: parties.agentAuthority,
        signer: parties.agentSigner,
      });
    expect(asErp).toThrow(SigningAuthorityError);
    expect(asErp).toThrow(/not declared to speak for source "erp"/);
    expect(
      () =>
        new EvidenceSource({
          system: "erp",
          authority: parties.gatewayAuthority,
          signer: parties.agentSigner,
        }),
    ).toThrow(/holds key/);

    // A process that misdeclares its authority is stopped by the registry.
    const lying = new SigningAuthority({
      keyId: "agent-runtime-1",
      issuer: parties.agent.id,
      tenant: parties.tenant,
      sources: ["erp"],
    });
    const forged = new EvidenceSource({
      system: "erp",
      authority: lying,
      signer: parties.agentSigner,
      clock: parties.clock,
    }).record(
      "posting",
      { document: "D-1", invoice: "INV-1", amount: 1 },
      { subject: parties.subject() },
    );
    expect(forged.authenticate(parties.trust).refusal?.code).toBe("SOURCE_NOT_AUTHORIZED");
    const work = parties.work();
    work.attach(forged).claim();
    expect(() => work.issue({ trust: parties.trust })).toThrow(AssemblyError);
    expect(() => work.issue({ trust: parties.trust })).toThrow(/SOURCE_NOT_AUTHORIZED/);
  });

  test("an authentic agent trace does not support a claim about the ERP", () => {
    const parties = new Parties();
    const said = parties.agentRuntime.record(
      "posting",
      { document: "D-1", invoice: "INV-1", amount: 125_000 },
      { subject: parties.subject() },
    );
    expect(said.authenticate(parties.trust).authenticated).toBe(true);
    const work = parties.work();
    work.attach(said).claim();
    const issued = work.issue({ trust: parties.trust });
    const result = new Verifier({ trust: parties.trust }).verify(issued.package);
    // Authentic, authorized for its own source, and ignored by the contract.
    expect(result.evidenceSignatures.established).toBe(true);
    expect(result.signerAuthority.established).toBe(true);
    expect(result.decision).toBe(Decision.UNDETERMINED);
    expect(result.ignored).toEqual([`e-${said.id}`]);
  });

  test("a signer returning garbage is refused", () => {
    const parties = new Parties();
    const broken: Signer = {
      keyId: "erp-gateway-1",
      sign: () => new TextEncoder().encode("short"),
    };
    const source = new EvidenceSource({
      system: "erp",
      authority: parties.gatewayAuthority,
      signer: broken,
    });
    const record = (): unknown =>
      source.record("posting", { document: "D" }, { subject: parties.subject() });
    expect(record).toThrow(SigningAuthorityError);
    expect(record).toThrow(/64 bytes/);
  });

  test("a seed never appears when a signer is printed", () => {
    const signer = new Ed25519Signer({ keyId: "k", seed: new Uint8Array(32).fill(7) });
    for (const shown of [
      String(signer),
      JSON.stringify(signer),
      inspect(signer, { depth: null, showHidden: true }),
    ]) {
      expect(shown).not.toContain("07");
      expect(shown).not.toMatch(/7,\s*7/);
    }
    expect(Object.keys(signer)).toEqual(["keyId"]);
  });

  test("a signer keeps its own copy of the seed", () => {
    const seed = new Uint8Array(32).fill(7);
    const signer = new Ed25519Signer({ keyId: "k", seed });
    const before = signer.publicKey;
    seed.fill(0);
    expect(signer.publicKey).toBe(before);
    expect(() => new Ed25519Signer({ keyId: "k", seed: new Uint8Array(31) })).toThrow(/32 bytes/);
  });
});

// --- no silent fallback ------------------------------------------------------

describe("no silent fallback", () => {
  afterEach(() => {
    vi.doUnmock("../../src/native/glue.js");
    vi.resetModules();
  });

  test("without the WebAssembly module verification fails loudly", async () => {
    const parties = new Parties();
    const text = supported(parties).text;
    const registry = parties.trust.toBytes();

    vi.resetModules();
    vi.doMock("../../src/native/glue.js", () => {
      const unavailable = (): never => {
        throw new Error("WebAssembly is not available here");
      };
      return {
        initSync: unavailable,
        default: async () => unavailable(),
        // If anything fell back to calling these, it would look like a verification.
        verify: () => '{"outcome":"complete"}',
        trust_registry: () => '{"keys":[]}',
        build_info: () => '{"verifier":"fake"}',
        digest_bytes: () => "0".repeat(64),
      };
    });
    const broken = await import("../../src/index.js");
    expect(broken.nativeAvailable()).toBe(false);
    // Nothing can be loaded, so not even a registry can be read.
    expect(() => broken.TrustRegistry.fromJson(registry)).toThrow(broken.NativeUnavailableError);
    const verify = (): unknown => new broken.Verifier({ trust: null }).verify(text);
    expect(verify).toThrow(broken.NativeUnavailableError);
    expect(verify).toThrow(/Nothing was verified/);
    await expect(broken.ready()).rejects.toBeInstanceOf(broken.NativeUnavailableError);

    vi.doUnmock("../../src/native/glue.js");
    vi.resetModules();
    const restored = await import("../../src/index.js");
    expect(restored.nativeAvailable()).toBe(true);
    new restored.Verifier({ trust: restored.TrustRegistry.fromJson(registry) })
      .verify(text)
      .requireSupported();
  });
});
