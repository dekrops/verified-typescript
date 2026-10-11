// SPDX-License-Identifier: Apache-2.0

/**
 * Signed evidence: what an identified source says it observed.
 *
 * An evidence statement is an attributable, tamper-evident assertion. It is
 * not truth (a correctly signed statement can be false), not a claim, and
 * not a verification result. What makes one count for a claim is decided by
 * two separate parties: the **relying party's registry** says which key may
 * speak for which source system, and the **contract** says which sources
 * count for which kind of record.
 *
 * That is why an agent cannot upgrade its own account of what happened into
 * an observation by the system of record: its key is not authorized for that
 * system, and a relying party's verifier refuses the statement
 * (`SOURCE_NOT_AUTHORIZED`).
 *
 * @module
 */

import { call, callJson, decode, encode, type JsonObject } from "./bridge.js";
import { utf8 } from "./bytes.js";
import { Digest } from "./canonical.js";
import { SigningAuthorityError } from "./errors.js";
import type { RecordReference, SignedRelation } from "./history.js";
import { encodeSignature, type Signer, type SigningAuthority } from "./signing.js";
import { type Clock, epochSeconds, instant, now } from "./time.js";
import { TrustRegistry } from "./trust.js";
import { randomUuid, uuid } from "./uuid.js";
import type { Refusal } from "./verification.js";

const STATEMENT_PROTOCOL = "verified-evidence-statement-v1";

/**
 * How a statement came to be. A label on the statement.
 *
 * The kind does not confer authority: a statement labelled
 * `StateTransition` and signed by a key that cannot speak for the system it
 * names is refused all the same.
 */
export const EvidenceKind = {
  STATE_TRANSITION: "StateTransition",
  DATABASE_CHANGE: "DatabaseChange",
  API_RESPONSE: "ApiResponse",
  EVENT: "Event",
  DOCUMENT: "Document",
  AGENT_TRACE: "AgentTrace",
  SIGNED_ATTESTATION: "SignedAttestation",
  HUMAN_WITNESS: "HumanWitness",
  SENSOR_OBSERVATION: "SensorObservation",
  EXTERNAL_ASSERTION: "ExternalAssertion",
  CRYPTOGRAPHIC_PROOF: "CryptographicProof",
} as const;
export type EvidenceKind = (typeof EvidenceKind)[keyof typeof EvidenceKind];

const KINDS = new Set<string>(Object.values(EvidenceKind));

/** The business object a statement is about. */
export interface Subject {
  readonly system: string;
  readonly kind: string;
  readonly key: string;
}

/**
 * A field of a record or a claim input: text, a boolean or a whole number.
 * Numbers are written as text on the wire; fractions do not exist in the
 * protocol.
 */
export type FieldValue = string | boolean | number | bigint;

/** @internal The wire form of a field or an input. */
export function fieldValue(name: string, value: unknown, what: string): string | boolean {
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint" || (typeof value === "number" && Number.isSafeInteger(value))) {
    // The contract language writes every number as text.
    return value.toString();
  }
  throw new TypeError(
    `${what} ${JSON.stringify(name)}: a value is text, a boolean or a whole number. ` +
      "Write amounts as whole units of the contract's scale (12.50 EUR at scale 2 is 1250) " +
      "and times as seconds since 1970.",
  );
}

/**
 * Whether one statement is authentic under a relying party's registry.
 *
 * Authentic means: the registry holds the signing key, for the statement's
 * tenant, issuer and source system, valid at the asserted time, and the
 * signature verifies. It says who made the statement and that it was not
 * altered. It does not say the statement is true, and it is not a
 * verification of any claim.
 */
export interface Authentication {
  readonly authenticated: boolean;
  /** The first check that failed, or `null`. */
  readonly refusal: Refusal | null;
}

/**
 * A signed statement together with the body it commits to.
 *
 * Immutable, and reusable: the same signed statement may be attached to
 * several claims.
 */
export class SignedEvidence {
  readonly #statement: string;
  readonly #body: string;
  readonly #inner: JsonObject;
  readonly #keyId: string;

  /** @internal Use {@link EvidenceSource} or {@link SignedEvidence.fromWire}. */
  constructor(statementJson: string, bodyJson: string) {
    this.#statement = statementJson;
    this.#body = bodyJson;
    const signed = decode(statementJson) as JsonObject;
    this.#inner = signed["statement"] as JsonObject;
    this.#keyId = (signed["signature"] as JsonObject)["keyId"] as string;
  }

  /** The signed statement, `{"statement": …, "signature": …}`, canonical. */
  get statementJson(): Uint8Array {
    return utf8(this.#statement);
  }

  /** The body the statement's `payload` commits to, canonical. */
  get bodyJson(): Uint8Array {
    return utf8(this.#body);
  }

  #wrapped(name: string): string {
    return String((this.#inner[name] as JsonObject)["value"]);
  }

  get id(): string {
    return this.#wrapped("id");
  }

  get tenant(): string {
    return this.#wrapped("tenant");
  }

  get issuer(): string {
    return this.#wrapped("issuer");
  }

  /** The system the issuer says it observed. */
  get source(): string {
    return String((this.#inner["source"] as JsonObject)["system"]);
  }

  get kind(): EvidenceKind {
    return Object.keys(this.#inner["kind"] as JsonObject)[0] as EvidenceKind;
  }

  /** The asserted observation time. Asserted by the signer; not authenticated. */
  get observedAt(): string {
    return this.#wrapped("observedAt");
  }

  get keyId(): string {
    return this.#keyId;
  }

  /** The statement digest, which identifies it in chains and decisions. */
  get digest(): Digest {
    return Digest.ofJson(this.#inner);
  }

  /**
   * Checks this statement under `trust`: the protocol's ten statement
   * checks, in order, by the shared verifier.
   */
  authenticate(trust: TrustRegistry): Authentication {
    if (!(trust instanceof TrustRegistry)) {
      throw new TypeError("trust is a TrustRegistry");
    }
    const signed = this.statementJson;
    const registry = trust.toBytes();
    const outcome = callJson((native) => native.check_statement(signed, registry));
    if (outcome["outcome"] === "refused") {
      const refused = outcome["refusal"] as JsonObject;
      return {
        authenticated: false,
        refusal: { code: refused["code"] as string, detail: refused["detail"] as string },
      };
    }
    return { authenticated: true, refusal: null };
  }

  /** The signed statement as a JSON object. */
  statement(): JsonObject {
    return decode(this.#statement) as JsonObject;
  }

  /** The body as a JSON object. */
  body(): JsonObject {
    return decode(this.#body) as JsonObject;
  }

  /** `{"statement": signed, "body": body}`, for sending elsewhere. */
  toWire(): { statement: JsonObject; body: JsonObject } {
    return { statement: this.statement(), body: this.body() };
  }

  /**
   * Reads `{"statement": signed, "body": body}` received from elsewhere.
   *
   * Only the structure is checked. Authenticity is established when a
   * verifier checks the statement under a registry.
   */
  static fromWire(value: { statement: unknown; body: unknown }): SignedEvidence {
    const signed = encode(value.statement, "statement");
    const info = callJson((native) => native.check_statement(signed));
    if (info["outcome"] === "refused") {
      const refused = info["refusal"] as JsonObject;
      throw new RangeError(`not an evidence statement: ${refused["detail"]}`);
    }
    const body = encode(value.body, "body");
    return new SignedEvidence(
      call((native) => native.canonicalize(signed)),
      call((native) => native.canonicalize(body)),
    );
  }

  equals(other: SignedEvidence): boolean {
    return other.#statement === this.#statement && other.#body === this.#body;
  }

  toString(): string {
    return (
      `SignedEvidence(${this.kind} ${this.id} from ${JSON.stringify(this.source)}, ` +
      `key ${JSON.stringify(this.keyId)})`
    );
  }
}

/** What an {@link EvidenceSource} is constructed with. */
export interface EvidenceSourceOptions {
  /** The system this source observes. The authority must name it. */
  system: string;
  authority: SigningAuthority;
  signer: Signer;
  clock?: Clock | undefined;
}

/** What every signed statement may state besides its body. */
export interface StatementOptions {
  subject: Subject;
  evidenceKind?: EvidenceKind | undefined;
  /** Defaults to the source's clock. Asserted by the signer; not authenticated. */
  observedAt?: Date | string | undefined;
  observationId?: string | undefined;
  /** The statement's identifier (a UUID). A random one by default. */
  evidenceId?: string | undefined;
}

/** What a group relation may state besides its name and members. */
export interface GroupOptions {
  /** Defaults to the source's clock. Asserted by the signer; not authenticated. */
  observedAt?: Date | string | undefined;
  observationId?: string | undefined;
  /** The statement's identifier (a UUID). A random one by default. */
  evidenceId?: string | undefined;
  /** Starts a stream of this name with this relation. */
  stream?: string | undefined;
  /** Continues the stream of the relation signed before. */
  after?: SignedRelation | undefined;
}

/** What a completeness statement may state. */
export interface CompletenessOptions extends Omit<StatementOptions, "observedAt"> {
  /** The time the listing is complete as of: a `Date`, or seconds since 1970. */
  asOf?: Date | number | undefined;
  observedAt?: Date | undefined;
}

/**
 * An identified source that signs what it observed in one system.
 *
 * Construct one where the observation is actually made: in a gateway beside
 * the ERP, in the tool gateway, in the agent runtime for its own trace. The
 * `authority` must name `system`; otherwise construction fails, before
 * anything can be signed. The SDK will not sign an observation of a system
 * on behalf of a key that is not declared to speak for it.
 *
 * The local check is a guard against mistakes, not the security boundary.
 * The boundary is the relying party's registry, which a source cannot write.
 */
export class EvidenceSource {
  readonly system: string;
  readonly authority: SigningAuthority;
  readonly #signer: Signer;
  readonly #clock: Clock;

  constructor(options: EvidenceSourceOptions) {
    if (options.signer.keyId !== options.authority.keyId) {
      throw new SigningAuthorityError(
        `the signer holds key ${JSON.stringify(options.signer.keyId)} but the authority is ` +
          `declared for key ${JSON.stringify(options.authority.keyId)}`,
      );
    }
    options.authority.require({ source: options.system, tenant: options.authority.tenant });
    this.system = options.system;
    this.authority = options.authority;
    this.#signer = options.signer;
    this.#clock = options.clock ?? now;
  }

  #sign(
    body: JsonObject,
    options: StatementOptions,
    evidenceKind: EvidenceKind,
    observedAt: Date | string,
  ): SignedEvidence {
    if (!KINDS.has(evidenceKind)) {
      throw new RangeError(`${JSON.stringify(evidenceKind)} is not an evidence kind`);
    }
    const identifier =
      options.evidenceId === undefined ? randomUuid() : uuid(options.evidenceId, "evidenceId");
    const bodyJson = encode(body, "body");
    const statement: JsonObject = {
      protocol: STATEMENT_PROTOCOL,
      id: { value: identifier },
      tenant: { value: this.authority.tenant },
      kind: { [evidenceKind]: {} },
      subject: {
        system: options.subject.system,
        kind: options.subject.kind,
        key: options.subject.key,
      },
      issuer: { value: this.authority.issuer },
      source: {
        system: this.system,
        observationId: options.observationId ?? `${this.system}:${identifier}`,
      },
      observedAt: { value: instant(observedAt) },
      payload: {
        algorithm: "sha-256",
        hex: call((native) => native.payload_digest(bodyJson)),
      },
      chain: null,
    };
    const unsigned = encode(statement, "statement");
    const message = call((native) => native.statement_signing_input(unsigned));
    const signed = encode({ statement, signature: encodeSignature(this.#signer, message) });
    const info = callJson((native) => native.check_statement(signed));
    if (info["outcome"] === "refused") {
      const refused = info["refusal"] as JsonObject;
      throw new RangeError(`the statement is not well formed: ${refused["detail"]}`);
    }
    return new SignedEvidence(
      call((native) => native.canonicalize(signed)),
      call((native) => native.canonicalize(bodyJson)),
    );
  }

  /**
   * Signs one record this source observed.
   *
   * `kind` and `fields` are in the vocabulary of the contract the evidence
   * is meant for.
   */
  record(
    kind: string,
    fields: Readonly<Record<string, FieldValue>>,
    options: StatementOptions,
  ): SignedEvidence {
    const wire: JsonObject = {};
    for (const [name, value] of Object.entries(fields)) {
      wire[name] = fieldValue(name, value, "field");
    }
    return this.#sign(
      { record: { kind, fields: wire } },
      options,
      options.evidenceKind ?? EvidenceKind.EVENT,
      options.observedAt ?? this.#clock(),
    );
  }

  /**
   * Signs this source's statement that records belong to one group (work
   * relation v1, a draft).
   *
   * `members` name packages or work records, in any order. What a group is,
   * a session or a batch, is this source's to define. The statement says
   * the members belong together. It does not say the group is complete,
   * that its members are true, or that they agree.
   *
   * To let a reader see that no statement is missing, chain the relations
   * in a stream of their own: start one with `stream` and continue it with
   * `after`, the relation signed before. Nothing shows what follows the
   * last one.
   *
   * The layout is the shared library's, which refuses a relation a reader
   * would refuse; this method only supplies what the source states and
   * signs.
   */
  group(
    name: string,
    members: readonly RecordReference[],
    options: GroupOptions = {},
  ): SignedRelation {
    if (typeof name !== "string") {
      throw new TypeError("a group's name is text");
    }
    const identifier =
      options.evidenceId === undefined ? randomUuid() : uuid(options.evidenceId, "evidenceId");
    const stated = encode(
      {
        id: { value: identifier },
        issuer: { value: this.authority.issuer },
        observedAt: { value: instant(options.observedAt ?? this.#clock()) },
        source: {
          system: this.system,
          observationId: options.observationId ?? `${this.system}:${identifier}`,
        },
        tenant: { value: this.authority.tenant },
      },
      "stated",
    );
    const listed = encode(
      members.map((member) => {
        if (!(member?.digest instanceof Digest)) {
          throw new TypeError("members are record references");
        }
        return { kind: member.kind, hex: member.digest.hex };
      }),
      "members",
    );
    const after =
      options.after === undefined ? undefined : encode(options.after.statement, "after");
    const prepared = callJson((native) =>
      native.prepare_group_relation(name, listed, stated, options.stream, after),
    );
    const statement = prepared["statement"] as JsonObject;
    const unsigned = encode(statement, "statement");
    const message = call((native) => native.statement_signing_input(unsigned));
    return {
      statement: { statement, signature: encodeSignature(this.#signer, message) },
      body: prepared["body"] as JsonObject,
    };
  }

  /**
   * Signs this source's assertion that its records of `kind` for this
   * subject are complete as of a time.
   *
   * Sign this only when the source really has listed everything it holds.
   * It is what lets a contract conclude "there is none"; a false one is a
   * false statement by the source, which no verifier can detect.
   */
  complete(kind: string, options: CompletenessOptions): SignedEvidence {
    const observed = options.observedAt ?? this.#clock();
    let moment: number;
    if (options.asOf === undefined) {
      moment = epochSeconds(observed);
    } else if (options.asOf instanceof Date) {
      moment = epochSeconds(options.asOf);
    } else if (Number.isSafeInteger(options.asOf)) {
      moment = options.asOf;
    } else {
      throw new TypeError("asOf is a Date or whole seconds since 1970");
    }
    return this.#sign(
      { complete: { kind, asOf: String(moment) } },
      { ...options, observedAt: observed },
      options.evidenceKind ?? EvidenceKind.EXTERNAL_ASSERTION,
      observed,
    );
  }
}
