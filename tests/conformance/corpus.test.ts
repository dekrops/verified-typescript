// SPDX-License-Identifier: Apache-2.0

// The published WVP conformance corpus, run through the public API.
//
// These are the same vectors the Rust, Scala and Python implementations run
// (`dekrops/wvp`, pinned as a submodule). Each expectation is compared in
// full, never by refusal code alone, and no expectation is ever edited here.

import { basename, dirname, join } from "node:path";
import { describe, expect, test } from "vitest";

import { callJson } from "../../src/bridge.js";
import {
  canonicalize,
  Digest,
  type DigestWire,
  MalformedInputError,
  readHistory,
  TrustRegistry,
  UnsupportedOperationError,
  type VerificationResult,
  VerificationStatus,
  Verifier,
  workUnit,
} from "../../src/index.js";
import { readPackage, readTrustRegistry } from "../../src/node.js";
import { corpusDir, load, loadExact, plain, vectorFiles, writeExact } from "../helpers.js";

const CORPUS = corpusDir();
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const stem = (path: string): string => basename(path, ".json");
const id = (path: string): string =>
  `${basename(dirname(dirname(path)))}/${basename(dirname(path))}/${stem(path)}`;
// biome-ignore lint/suspicious/noExplicitAny: corpus files are read as published
type Vector = any;

describe.skipIf(CORPUS === undefined)("the WVP conformance corpus", () => {
  const corpus = CORPUS as string;

  // --- canonical encoding ----------------------------------------------------

  test("canonical encoding vectors", () => {
    const vectors: Vector = load(join(corpus, "canonical-hash-v1.json"));
    expect(vectors.canonicalizationVersion).toBe("verified-json-v1");
    expect(vectors.valid).toHaveLength(12);
    expect(vectors.invalid).toHaveLength(5);
    for (const item of vectors.valid) {
      const input = bytes(item.inputJson);
      expect(new TextDecoder().decode(canonicalize(input)), item.name).toBe(item.canonicalUtf8);
      expect(Digest.ofJson(input).hex, item.name).toBe(item.sha256);
    }
    for (const item of vectors.invalid) {
      expect(() => canonicalize(bytes(item.inputJson)), item.name).toThrow(MalformedInputError);
    }
  });

  // --- WVP packages ----------------------------------------------------------

  /** A result in the corpus's vocabulary, as the upstream harness states it. */
  function stated(result: VerificationResult): Record<string, unknown> {
    if (result.refusal !== null) {
      return { accept: false, error: result.refusal.code };
    }
    const reproduced = result.decision !== null;
    const out: Record<string, unknown> = {
      accept: true,
      integrity: result.integrity.established,
      decision: result.decision,
      statements: reproduced ? result.statementCount : null,
      issuerSignature: result.issuerSignature.status.replaceAll("_", " "),
    };
    if (result.contract !== null) {
      out["contract"] = {
        id: result.contract.id,
        version: result.contract.version,
        digest: result.contract.digest.toWire(),
      };
      out["requirements"] = result.requirements.map((item) => ({ id: item.id, value: item.value }));
    }
    return out;
  }

  const registry = (value: unknown): TrustRegistry | null =>
    value === null ? null : TrustRegistry.fromJson(JSON.stringify(value));

  const packageVectors = ["v0.1", "v0.2"].flatMap((version) =>
    ["valid", "must-reject", "invalid"].flatMap((kind) => vectorFiles("wvp", version, kind)),
  );

  test("the package corpus is the published size", () => {
    expect(packageVectors.filter((path) => path.split(/[\\/]/).includes("v0.1"))).toHaveLength(26);
    expect(packageVectors.filter((path) => path.split(/[\\/]/).includes("v0.2"))).toHaveLength(28);
  });

  test.each(packageVectors.map((path) => [id(path), path]))("package %s", (_name, path) => {
    const vector: Vector = load(path);
    const verifier = new Verifier({
      trust: registry(vector.registry),
      protocol: vector.protocol,
    });
    const result = verifier.verify(bytes(vector.packageJson));
    expect(stated(result)).toEqual(vector.expected);
    expect(vector.expected.accept).toBe(basename(dirname(path)) === "valid");
    // What every result must say, whatever the vector.
    expect(result.sourceTruthfulness.status).toBe("not_established");
    if (vector.registry === null) {
      expect(result.verificationStatus).not.toBe(VerificationStatus.COMPLETE);
      expect(result.decision).toBeNull();
    }
  });

  test("expectation cases", () => {
    const cases: Vector[] = load(join(corpus, "wvp", "v0.2", "expectations.json")) as Vector;
    expect(cases).toHaveLength(7);
    for (const item of cases) {
      const contract = item.expect.contract as DigestWire | undefined;
      const result = new Verifier({
        trust: registry(item.registry),
        protocol: "wvp-0.2",
      }).verify(bytes(item.packageJson), {
        expect: {
          tenant: item.expect.tenant,
          contract: contract === undefined ? undefined : Digest.fromWire(contract),
          claim: item.expect.claim,
        },
      });
      if (item.expected.accept) {
        expect(result.isComplete, item.description).toBe(true);
        expect(result.decision, item.description).toBe(item.expected.decision);
      } else {
        expect(result.refusal?.code, item.description).toBe(item.expected.error);
      }
    }
  });

  test.each(["wvp/v0.1/examples/order-transition", "wvp/v0.2/examples/invoice-processing"])(
    "worked example %s verifies as supported",
    (name) => {
      const example = join(dirname(corpus), "protocols", name);
      const result = new Verifier({
        trust: readTrustRegistry(join(example, "registry.json")),
      }).verify(readPackage(join(example, "package.json")));
      expect(result.requireSupported().isComplete).toBe(true);
    },
  );

  test("expectations are refused for a version that does not define them", () => {
    const vector: Vector = load(join(corpus, "wvp", "v0.1", "valid", "supported.json"));
    expect(() =>
      new Verifier({ trust: registry(vector.registry) }).verify(bytes(vector.packageJson), {
        expect: { tenant: "tenant-a" },
      }),
    ).toThrow(UnsupportedOperationError);
  });

  // --- Work Contract Language 1 ----------------------------------------------

  const contractCases = vectorFiles("work-contract", "v1", "cases");
  // `72-scale-not-whole` gives a type a fractional scale. verified-json-v1 has
  // no fractions, so the shared reader refuses the file's text before any
  // contract is read, exactly as upstream documents. It is not counted as
  // conforming.
  const unrepresentable = new Set(["72-scale-not-whole"]);

  const evaluate = (contract: unknown, environment: unknown): unknown =>
    callJson((native) => native.evaluate_contract(writeExact(contract), writeExact(environment)));

  test.each(
    contractCases
      .filter((path) => !unrepresentable.has(stem(path)))
      .map((path) => [stem(path), path]),
  )("contract case %s", (_name, path) => {
    const item = loadExact(path);
    expect(evaluate(item["contract"], item["environment"])).toEqual(plain(item["expected"]));
  });

  test.fails.each(
    contractCases
      .filter((path) => unrepresentable.has(stem(path)))
      .map((path) => [stem(path), path]),
  )("contract case %s cannot be represented in verified-json-v1", (_name, path) => {
    const item = loadExact(path);
    // The reader refuses the text, as documented in protocol-compatibility.md.
    expect(() => evaluate(item["contract"], item["environment"])).toThrow(MalformedInputError);
    // So the case's own expectation is not met, and the test is marked as failing.
    expect(evaluate(item["contract"], item["environment"])).toEqual(plain(item["expected"]));
  });

  test("the contract corpus is the published size", () => {
    expect(contractCases).toHaveLength(81 + unrepresentable.size);
  });

  test("contract differential batches", () => {
    const batches = vectorFiles("work-contract", "v1", "differential");
    expect(batches).toHaveLength(5);
    let total = 0;
    for (const path of batches) {
      const batch = loadExact(path) as Vector;
      for (const item of batch.cases) {
        expect(evaluate(batch.contract, item.environment), basename(path)).toEqual(
          plain(item.expected),
        );
        total += 1;
      }
    }
    expect(total).toBe(641 - 81);
  });

  // --- work-unit identity ------------------------------------------------------

  test("work-unit vectors", () => {
    const vectors: Vector = load(join(corpus, "work-unit", "v1", "vectors.json"));
    const keys = new Map<string, Vector>(vectors.keys.map((entry: Vector) => [entry.id, entry]));
    expect(keys.size).toBe(3);
    expect(vectors.cases).toHaveLength(10);
    for (const item of vectors.cases) {
      const entry = keys.get(item.key);
      const unit = workUnit({
        tenant: item.tenant,
        scope: item.scope,
        values: item.values,
        key: Uint8Array.from(Buffer.from(entry.secretHex, "hex")),
      });
      expect(unit.identity, item.name).toBe(item.identityCanonical);
      expect(unit.nullifier, item.name).toBe(`hmac-sha-256:${item.nullifier.hex}`);
      expect(unit.keyCommitment?.toWire(), item.name).toEqual(entry.commitment);
    }
  });

  // --- evidence statements, chains and admission ---------------------------------

  const statementVectors = ["valid", "must-reject", "invalid"].flatMap((kind) =>
    vectorFiles("evidence-statement", "v1", kind),
  );

  const refused = (result: Vector): Record<string, unknown> => ({
    accept: false,
    error: result.refusal.code,
  });

  function statementOutcome(vector: Vector, trust: Uint8Array): Record<string, unknown> {
    const result: Vector = callJson((native) =>
      native.check_statement(bytes(vector.input.signedStatementJson), trust),
    );
    if (result.outcome === "refused") {
      return refused(result);
    }
    return {
      accept: true,
      keyId: result.keyId,
      statementCanonicalUtf8: result.canonical,
      statementSha256: result.digest.hex,
      signingInputSha256: result.signingInputDigest.hex,
    };
  }

  // Statements and bodies are published as JSON text. They are spliced into a
  // list as they are, so nothing is parsed and written back on the way.
  const listOf = (texts: string[]): Uint8Array => bytes(`[${texts.join(",")}]`);

  function chainOutcome(vector: Vector, trust: Uint8Array): Record<string, unknown> {
    const anchor = vector.input.anchor;
    const result: Vector = callJson((native) =>
      native.verify_chain(
        listOf(vector.input.statements),
        trust,
        anchor === null ? undefined : bytes(JSON.stringify(anchor)),
      ),
    );
    if (result.outcome === "refused") {
      return refused(result);
    }
    return {
      accept: true,
      first: result.first,
      last: result.last,
      fromGenesis: result.fromGenesis,
      headSha256: result.head.digest.hex,
    };
  }

  function admissionOutcome(vector: Vector, trust: Uint8Array): Record<string, unknown> {
    const given = vector.input;
    const evidence = (given.statements as string[]).map(
      (statement, index) => `{"statement":${statement},"body":${given.bodies[index]}}`,
    );
    expect(given.bodies).toHaveLength(given.statements.length);
    const result: Vector = callJson((native) =>
      native.admit(
        given.tenant.value,
        bytes(JSON.stringify(given.claim.evidence.map((item: Vector) => item.value))),
        listOf(evidence),
        trust,
        bytes(
          JSON.stringify({
            packageId: given.packageId,
            claimId: given.claim.id,
            ingestedAt: given.ingestedAt,
            assembledAt: given.assembledAt,
          }),
        ),
      ),
    );
    if (result.outcome === "refused") {
      return refused(result);
    }
    return { accept: true, packageManifestSha256: result.manifestDigest.hex };
  }

  // The platform's verification result of an accepted admission is not
  // specified in the published material and is not computed by the shared
  // crates.
  const notCompared = new Set(["verificationResultSha256", "verificationStatus"]);

  test.each(statementVectors.map((path) => [id(path), path]))(
    "evidence statement %s",
    (_name, path) => {
      const vector: Vector = load(path);
      const trust = bytes(JSON.stringify(vector.registry));
      const outcome = {
        statement: statementOutcome,
        chain: chainOutcome,
        admission: admissionOutcome,
      }[vector.kind as "statement" | "chain" | "admission"](vector, trust);
      const expected = Object.fromEntries(
        Object.entries(vector.expected).filter(([key]) => !notCompared.has(key)),
      );
      expect(outcome).toEqual(expected);
    },
  );

  test("the evidence corpus is the published size", () => {
    const kinds = statementVectors.map((path) => (load(path) as Vector).kind);
    const count = (kind: string): number => kinds.filter((item) => item === kind).length;
    expect([count("statement"), count("chain"), count("admission")]).toEqual([17, 13, 9]);
  });

  // --- work relation v1 (draft) ----------------------------------------------

  const relationCases: Vector[] = (
    load(join(corpus, "work-relation", "v1", "vectors.json")) as Vector
  ).cases;

  test.each(relationCases.map((item) => [item.name as string, item]))(
    "work relation %s",
    (_name, item) => {
      const trust = TrustRegistry.fromJson(bytes(JSON.stringify(item.trust)));
      const reading = readHistory(item.relations, item.records, trust);
      // The whole reading: every record, every relation's standing, every
      // derived relation and every stream.
      expect(plain(reading.raw)).toEqual(item.expected);
      // And the typed view says what the reading says.
      expect(reading.relations.map((read) => read.standing)).toEqual(
        item.expected.relations.map((read: Vector) => read.standing),
      );
      expect(reading.records).toHaveLength(item.records.length);
      expect(reading.recordsVerified).toBe(false);
    },
  );

  test("the work relation corpus is the published size", () => {
    expect(relationCases).toHaveLength(41);
  });
});

test("a run that claims conformance cannot skip the corpus", () => {
  if (process.env["VERIFIED_CONFORMANCE_REQUIRED"]) {
    expect(CORPUS).toBeDefined();
  }
});
