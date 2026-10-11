// SPDX-License-Identifier: Apache-2.0

// Reading work relations: the API around the shared reader.
//
// The rules themselves are measured by the conformance corpus. These tests
// cover what the TypeScript layer adds: types, refusals of bad input, and
// the things a reading must never be mistaken for.

import { expect, test } from "vitest";

import {
  Digest,
  Ed25519Signer,
  EvidenceSource,
  MalformedInputError,
  type OfferedRecord,
  packageReference,
  RecordKind,
  type RecordReference,
  ResourceLimitError,
  readHistory,
  SigningAuthority,
  Standing,
  TrustRegistry,
} from "../../src/index.js";

const EMPTY = TrustRegistry.fromJson('{"keys":[]}');

test("nothing given reads as nothing said", () => {
  const reading = readHistory([], [], EMPTY);

  expect(reading.relations).toEqual([]);
  expect(reading.records).toEqual([]);
  expect(reading.sameClaims).toEqual([]);
  expect(reading.streams).toEqual([]);
  expect(reading.recordsVerified).toBe(false);
  expect(reading.raw).toEqual({ records: [], relations: [], sameClaims: [], streams: [] });
});

test("a text is held only as a record of a kind this version defines", () => {
  const reading = readHistory(
    [],
    [
      { kind: "invoice", text: "{}" },
      { kind: RecordKind.WORK_RECORD, text: "{}" },
      { kind: "work-record", text: "not json" },
    ],
    EMPTY,
  );

  expect(reading.records).toEqual(["UNKNOWN_KIND", "MALFORMED_RECORD", "MALFORMED_RECORD"]);
});

test("a relation nobody you trust signed is refused, not an error", () => {
  const reading = readHistory([{ statement: {}, body: {} }], [], EMPTY);

  expect(reading.relations).toHaveLength(1);
  const relation = reading.relations[0];
  expect(relation?.standing).toBe(Standing.REFUSED);
  expect(relation?.code).toBe("MALFORMED");
  // Nobody the registry trusts said it, so no authority is named.
  expect(relation?.source).toBeNull();
  expect(relation?.keyId).toBeNull();
});

test("input that is not relations and records is an error of the input", () => {
  expect(() => readHistory([{ statement: {} } as never], [], EMPTY)).toThrow(MalformedInputError);
  expect(() => readHistory([], [{ kind: "work-record" } as never], EMPTY)).toThrow(
    MalformedInputError,
  );
  expect(() => readHistory([], [], { keys: [] } as never)).toThrow(TypeError);
});

test("a history is bounded", () => {
  const many: OfferedRecord[] = Array.from({ length: 1025 }, () => ({
    kind: "work-record",
    text: "{}",
  }));

  expect(() => readHistory([], many, EMPTY)).toThrow(ResourceLimitError);
});

// --- issuing a relation ------------------------------------------------------

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function source(system = "application"): { source: EvidenceSource; trust: TrustRegistry } {
  const signer = new Ed25519Signer({
    keyId: "test-application",
    seed: new Uint8Array(32).fill(21),
  });
  const authority = new SigningAuthority({
    keyId: signer.keyId,
    issuer: "00000000-0000-4000-8000-000000000901",
    tenant: "tenant-test",
    sources: [system],
  });
  return {
    source: new EvidenceSource({ system, authority, signer }),
    trust: TrustRegistry.fromKeys([
      authority.trustedKey(signer.publicKey, { validFrom: "2026-01-01T00:00:00Z" }),
    ]),
  };
}

const members = (): RecordReference[] => [
  packageReference(Digest.ofBytes(utf8("package 2"))),
  packageReference(Digest.ofBytes(utf8("package 1"))),
];

test("a source says that records belong to one group", () => {
  const { source: application, trust } = source();

  const relation = application.group("session-1", members());
  const reading = readHistory([relation], [], trust);

  expect(reading.relations).toHaveLength(1);
  const said = reading.relations[0];
  expect(said?.relation).toBe("groups");
  expect(said?.source).toBe("application");
  // Authentic and well carried. No record was given, so it is stated.
  expect(said?.standing).toBe(Standing.STATED);
  expect(new Set(said?.absent.map((reference) => reference.digest.hex))).toEqual(
    new Set(members().map((member) => member.digest.hex)),
  );
  // A group is a set: the one encoding orders its members.
  const groups = (relation.body["groups"] as { members: { digest: { hex: string } }[] }).members;
  const listed = groups.map((member) => member.digest.hex);
  expect(listed).toEqual([...listed].sort());
});

test("only a key the reader trusts for the source is heard", () => {
  const { source: application } = source();
  const { trust: other } = source("another-application");

  const reading = readHistory([application.group("session-1", members())], [], other);

  expect(reading.relations[0]?.standing).toBe(Standing.REFUSED);
  expect(reading.relations[0]?.code).toBe("SOURCE_NOT_AUTHORIZED");
});

test("relations chained in a stream show that none is missing", () => {
  const { source: application, trust } = source();

  const first = application.group("session-1", members(), { stream: "application/relations" });
  const second = application.group("session-2", members(), { after: first });

  const whole = readHistory([first, second], [], trust);
  const tail = readHistory([second], [], trust);
  expect(whole.streams.map((s) => [s.completeness, s.last])).toEqual([["UNINTERRUPTED", 1]]);
  // Without the first statement, what came before is not known.
  expect(tail.streams.map((s) => s.completeness)).toEqual(["UNKNOWN"]);
});

test("a group a reader would refuse is not signed", () => {
  const { source: application } = source();
  const first = application.group("session-1", members(), { stream: "application/relations" });
  const twice = [...members(), ...members().slice(0, 1)];

  expect(() => application.group("session-1", [])).toThrow(/relation/);
  expect(() => application.group("", members())).toThrow(/relation/);
  expect(() => application.group("session-1", twice)).toThrow(/relation/);
  expect(() =>
    application.group("session-1", [{ kind: "invoice", digest: Digest.ofBytes(utf8("x")) }]),
  ).toThrow(/member/);
  expect(() =>
    application.group("session-2", members(), { stream: "another", after: first }),
  ).toThrow(/not both/);
  expect(() => application.group("session-1", [Digest.ofBytes(utf8("x")) as never])).toThrow(
    TypeError,
  );
});
