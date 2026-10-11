// SPDX-License-Identifier: Apache-2.0

// Work relations (work relation v1, a draft): what authorities say about the
// records of one unit of work.
//
// One unit of work leaves several records: a package, a work record in a
// ledger, a registration at a claim registry. A work relation is a signed
// statement by which an authority says how records it knows are related.
// `readHistory` reads relations against the records given with them, under
// your trust registry, and reports each relation on its own.
//
// Every rule is in the shared Rust reader (`verified-history`). Nothing in
// this file decides anything about a relation.

import { callJson, encode, type JsonObject } from "./bridge.js";
import { Digest, type DigestWire } from "./canonical.js";
import { TrustRegistry } from "./trust.js";

/** The kinds of record a relation can name. */
export const RecordKind = {
  PACKAGE: "package",
  WORK_RECORD: "work-record",
  AGREEMENT: "agreement",
  CLAIM_COMMITMENT: "claim-commitment",
  RECEIPT: "receipt",
} as const;
export type RecordKind = (typeof RecordKind)[keyof typeof RecordKind];

/** How one relation stands, given the records in hand. */
export const Standing = {
  /**
   * Authentic, every record it names is held, and they state what it
   * states. Not a verification result.
   */
  CHECKED: "CHECKED",
  /**
   * Authentic, nothing held contradicts it, and a record it names was not
   * given. Read, and not checked.
   */
  STATED: "STATED",
  /** Authentic, and a held record states otherwise. */
  CONTRADICTED: "CONTRADICTED",
  /** Not a relation the reader accepts. */
  REFUSED: "REFUSED",
} as const;
export type Standing = (typeof Standing)[keyof typeof Standing];

/** What the presented statements of one stream show. */
export const StreamCompleteness = {
  /**
   * Step 0 and every step up to the last one presented are present.
   * Nothing is known about what follows.
   */
  UNINTERRUPTED: "UNINTERRUPTED",
  /** A step is missing, or the stream's first step was not presented. */
  UNKNOWN: "UNKNOWN",
} as const;
export type StreamCompleteness = (typeof StreamCompleteness)[keyof typeof StreamCompleteness];

/**
 * A record, named by its kind and that kind's own digest. A reference of one
 * kind never names a record of another.
 */
export interface RecordReference {
  readonly kind: string;
  readonly digest: Digest;
}

/** A record text, offered as one kind. It is held only as that kind. */
export interface OfferedRecord {
  readonly kind: string;
  readonly text: string;
}

/** A relation as it travels: a signed statement and the body it commits to. */
export interface CarriedRelation {
  readonly statement: unknown;
  readonly body: unknown;
}

/**
 * One relation as read: who said it, if anyone you trust did, and how it
 * stands.
 */
export interface RelationRead {
  readonly standing: Standing;
  /** The relation's name (`recorded`, `linked`, `groups`), once its body was read. */
  readonly relation: string | null;
  /** The source the statement speaks as, once the statement verified. */
  readonly source: string | null;
  readonly keyId: string | null;
  /** Why it is refused, or what a held record contradicts. */
  readonly code: string | null;
  /** The records it names that were not given, when it is `STATED`. */
  readonly absent: readonly RecordReference[];
}

/**
 * Whether one package's claim and one registered claim are the same claim.
 * Nobody signs this: it is computed from the three records.
 */
export interface SameClaim {
  readonly package: Digest;
  readonly claim: Digest;
  readonly agreement: Digest;
  /** `SAME_CLAIM`, or the first condition that does not hold. */
  readonly result: string;
  readonly same: boolean;
}

/** What the presented statements of one stream show. */
export interface StreamRead {
  readonly tenant: string;
  readonly issuer: string;
  readonly stream: string;
  /**
   * A {@link StreamCompleteness} value, or the chain code the stream fails
   * with (for example `CHAIN_EQUIVOCATION`).
   */
  readonly completeness: string;
  /** The last step presented, when the stream is uninterrupted. */
  readonly last: number | bigint | null;
}

/**
 * What a set of relations and records shows. Each part stands on its own:
 * there is no single result.
 *
 * - A relation shows that an authority said something within its scope. It
 *   does not show that the thing is true.
 * - `CHECKED` means the statement is consistent with the records in hand.
 *   **No record is verified here**: verify a package with `Verifier`.
 * - A record that was not given makes the relations to it `STATED`, never
 *   refused.
 * - Nothing is known about relations that were not presented, unless their
 *   authority chained them, and never about what follows the last one.
 */
export interface HistoryReading {
  /**
   * Each offered record, in the order given: the reference it is held
   * under, or why it is not held (`MALFORMED_RECORD`, `UNKNOWN_KIND`).
   */
  readonly records: readonly (RecordReference | string)[];
  readonly relations: readonly RelationRead[];
  readonly sameClaims: readonly SameClaim[];
  readonly streams: readonly StreamRead[];
  /** Always `false`: reading relations verifies no record. */
  readonly recordsVerified: false;
  /** The reading exactly as the shared reader states it. */
  readonly raw: JsonObject;
}

type Raw = Record<string, unknown>;

const digest = (wire: unknown): Digest => {
  const { hex, algorithm } = wire as DigestWire;
  return new Digest(hex, algorithm);
};

const reference = (raw: unknown): RecordReference => {
  const item = raw as Raw;
  return { kind: item["kind"] as string, digest: digest(item["digest"]) };
};

const optional = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * Reads work relations against the records given with them.
 *
 * `relations` are `{ statement, body }` objects: a signed evidence statement
 * and the relation body its payload commits to. `records` are record texts
 * with the kind each is offered as. Both are what a ledger exports for one
 * claim. `trust` is your registry: a relation is accepted only from a key it
 * trusts for the relation's source.
 *
 * Offline, and without a clock. It verifies no record.
 */
export function readHistory(
  relations: readonly CarriedRelation[],
  records: readonly OfferedRecord[],
  trust: TrustRegistry,
): HistoryReading {
  if (!(trust instanceof TrustRegistry)) {
    throw new TypeError("trust is a TrustRegistry");
  }
  const carried = encode(relations, "relations");
  const offered = encode(records, "records");
  const registry = trust.toBytes();
  const raw = callJson((native) => native.read_history(carried, offered, registry));
  const list = (name: string): Raw[] => raw[name] as Raw[];
  return {
    records: list("records").map((record) =>
      typeof record["error"] === "string" ? record["error"] : reference(record),
    ),
    relations: list("relations").map((read) => ({
      standing: read["standing"] as Standing,
      relation: optional(read["relation"]),
      source: optional(read["source"]),
      keyId: optional(read["keyId"]),
      code: optional(read["code"]),
      absent: ((read["absent"] as unknown[] | undefined) ?? []).map(reference),
    })),
    sameClaims: list("sameClaims").map((same) => ({
      package: digest(same["package"]),
      claim: digest(same["claim"]),
      agreement: digest(same["agreement"]),
      result: same["result"] as string,
      same: same["result"] === "SAME_CLAIM",
    })),
    streams: list("streams").map((stream) => ({
      tenant: (stream["tenant"] as Raw)["value"] as string,
      issuer: (stream["issuer"] as Raw)["value"] as string,
      stream: stream["stream"] as string,
      completeness: stream["completeness"] as string,
      last: (stream["last"] as number | bigint | undefined) ?? null,
    })),
    recordsVerified: false,
    raw,
  };
}
