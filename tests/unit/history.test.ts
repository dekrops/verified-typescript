// SPDX-License-Identifier: Apache-2.0

// Reading work relations: the API around the shared reader.
//
// The rules themselves are measured by the conformance corpus. These tests
// cover what the TypeScript layer adds: types, refusals of bad input, and
// the things a reading must never be mistaken for.

import { expect, test } from "vitest";

import {
  MalformedInputError,
  type OfferedRecord,
  RecordKind,
  ResourceLimitError,
  readHistory,
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
