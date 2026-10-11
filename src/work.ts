// SPDX-License-Identifier: Apache-2.0

/**
 * The lifecycle of one claim about one unit of work.
 *
 * The states follow the protocol, not a convenient story:
 *
 * - `open`: a contract and its inputs are declared. Evidence is being
 *   collected. Nothing has been claimed and nothing is known.
 * - `claimed`: the claim is fixed. It names its contract by digest and lists
 *   exactly the evidence it relies on. Nothing has been evaluated. A claim
 *   is an assertion by the claimant and is never evidence for itself.
 * - `issued`: the contract was evaluated against the admitted evidence and
 *   the result sealed into a package, with a decision of `SUPPORTED`,
 *   `CONTRADICTED` or `UNDETERMINED`.
 *
 * There is no step from a claim alone to a supported outcome. A claim with
 * no accepted evidence is evaluated like any other and yields
 * `UNDETERMINED`.
 *
 * Issuing is not verifying. An issued package carries its issuer's decision;
 * a relying party establishes what it will rely on by verifying the package
 * under its own registry ({@link Verifier}). Acceptance, dispute,
 * finalization and settlement are states of other systems and are not
 * modelled here.
 *
 * @module
 */

import { buildInfo, call, callJson, encode, type JsonObject } from "./bridge.js";
import type { Digest } from "./canonical.js";
import { WorkContract } from "./contracts.js";
import { LifecycleError, SigningAuthorityError } from "./errors.js";
import { type FieldValue, fieldValue, SignedEvidence } from "./evidence.js";
import { WorkPackage } from "./records.js";
import { DECISION_SOURCE, encodeSignature, type Signer, type SigningAuthority } from "./signing.js";
import { type Clock, instant, now } from "./time.js";
import type { TrustRegistry } from "./trust.js";
import { derivedId, randomUuid, uuid } from "./uuid.js";
import { type Decision, resultOf, type VerificationResult } from "./verification.js";

/**
 * A named agent and the UUID the protocol knows it by.
 *
 * The protocol identifies a claimant by UUID. Give the UUID your identity
 * system assigned, or let one be derived from the name and version. A
 * derived identifier is only a stable label: it authenticates nobody.
 */
export class AgentIdentity {
  readonly name: string;
  readonly version: string;
  readonly id: string;

  constructor(name: string, options: { version?: string; id?: string } = {}) {
    this.name = name;
    this.version = options.version ?? "";
    this.id =
      options.id === undefined
        ? derivedId("agent", name, this.version)
        : uuid(options.id, "an agent's id");
    Object.freeze(this);
  }
}

/** Where a work item is in its lifecycle. */
export const WorkState = {
  OPEN: "open",
  CLAIMED: "claimed",
  ISSUED: "issued",
} as const;
export type WorkState = (typeof WorkState)[keyof typeof WorkState];

/**
 * A fixed claim: what the claimant asserts, against which contract, and
 * which evidence it relies on. An assertion, not a finding.
 */
export interface Claim {
  readonly id: string;
  readonly tenant: string;
  readonly claimant: string;
  readonly contract: Digest;
  readonly inputs: Readonly<Record<string, string | boolean>>;
  readonly evidence: readonly string[];
  readonly submittedAt: string;
}

/**
 * A package this process issued, and its issuer's own check of it.
 *
 * `decision` is what the contract yields from the evidence, as evaluated
 * here and reproduced by the shared verifier under the **issuer's**
 * registry. It is not an independent verification: a relying party verifies
 * `package` under a registry of its own choosing.
 */
export interface IssuedWork {
  readonly package: WorkPackage;
  readonly packageId: string;
  readonly decision: Decision;
  /** The verifier's report under the issuer's registry. Always complete. */
  readonly issuerCheck: VerificationResult;
}

/**
 * A party that stands behind decisions by signing them.
 *
 * Its authority must name the `wvp-decision` source. A key authorized only
 * for evidence cannot sign a decision that counts, and the reverse. Signing
 * a decision vouches for the evaluation, not for the sources.
 */
export class DecisionIssuer {
  readonly authority: SigningAuthority;
  readonly signer: Signer;

  constructor(options: { authority: SigningAuthority; signer: Signer }) {
    if (options.signer.keyId !== options.authority.keyId) {
      throw new SigningAuthorityError(
        `the signer holds key ${JSON.stringify(options.signer.keyId)} but the authority is ` +
          `declared for key ${JSON.stringify(options.authority.keyId)}`,
      );
    }
    if (!options.authority.speaksFor(DECISION_SOURCE)) {
      throw new SigningAuthorityError(
        `key ${JSON.stringify(options.authority.keyId)} is not declared for ` +
          `${JSON.stringify(DECISION_SOURCE)} and cannot sign decisions`,
      );
    }
    this.authority = options.authority;
    this.signer = options.signer;
  }
}

/** @internal Told of each transition of a work item. */
export type Observer = (event: string, work: Work, attributes: JsonObject) => void;

/** What {@link Work.begin} is given. */
export interface BeginOptions {
  contract: WorkContract;
  tenant: string;
  /** The claimant: an {@link AgentIdentity}, or its UUID. */
  claimant: AgentIdentity | string;
  /**
   * The values the contract declares a claim must supply (an invoice
   * number, a session identifier, a cutoff). They are what the claim is
   * *about*; they prove nothing.
   */
  inputs: Readonly<Record<string, FieldValue>>;
  /** The claim's identifier (a UUID). A random one by default. */
  claimId?: string | undefined;
  clock?: Clock | undefined;
  label?: string | undefined;
  /** @internal */
  observer?: Observer | undefined;
}

/** What {@link Work.issue} is given. */
export interface IssueOptions {
  /**
   * The registry the issuer authenticates evidence under. Required: an
   * issuer that cannot authenticate its evidence has no business issuing a
   * decision.
   */
  trust: TrustRegistry;
  /**
   * Signs the decision. Without one the package carries no issuer
   * signature: the decision can be reproduced by anyone, and nobody stands
   * behind it.
   */
  issuer?: DecisionIssuer | undefined;
  evaluatedAt?: Date | string | undefined;
  ingestedAt?: Date | string | undefined;
  assembledAt?: Date | string | undefined;
  /** The identifier of the evidence set (a UUID). Not the package identifier. */
  evidenceSetId?: string | undefined;
}

/**
 * One claim about one unit of work, from declaration to issued package.
 *
 * Create one with {@link Work.begin}. Each transition happens once.
 */
export class Work {
  readonly contract: WorkContract;
  readonly tenant: string;
  readonly claimant: string;
  readonly claimId: string;
  readonly label: string | undefined;
  readonly #inputs: Record<string, string | boolean>;
  readonly #clock: Clock;
  readonly #observer: Observer | undefined;
  readonly #evidence = new Map<string, SignedEvidence>();
  #state: WorkState = WorkState.OPEN;
  #claim: Claim | undefined;
  #issued: IssuedWork | undefined;

  private constructor(options: BeginOptions, claimant: string) {
    this.contract = options.contract;
    this.tenant = options.tenant;
    this.claimant = claimant;
    this.claimId = options.claimId === undefined ? randomUuid() : uuid(options.claimId, "claimId");
    this.label = options.label;
    this.#inputs = {};
    for (const [name, value] of Object.entries(options.inputs)) {
      this.#inputs[name] = fieldValue(name, value, "input");
    }
    this.#clock = options.clock ?? now;
    this.#observer = options.observer;
  }

  /** Declares work under a contract. */
  static begin(options: BeginOptions): Work {
    if (!(options.contract instanceof WorkContract)) {
      throw new TypeError("contract is a WorkContract: build one with WorkContract.fromJson(text)");
    }
    const claimant =
      options.claimant instanceof AgentIdentity
        ? options.claimant.id
        : uuid(options.claimant, "claimant");
    const declared = [...options.contract.inputNames].sort();
    const given = Object.keys(options.inputs).sort();
    if (declared.length !== given.length || declared.some((name, i) => name !== given[i])) {
      throw new RangeError(
        `contract ${options.contract.id} ${options.contract.version} declares the inputs ` +
          `${JSON.stringify(declared)}; got ${JSON.stringify(given)}`,
      );
    }
    const work = new Work(options, claimant);
    work.#notify("work_begun", { contract: options.contract.digest.toString() });
    return work;
  }

  #notify(event: string, attributes: JsonObject): void {
    this.#observer?.(event, this, attributes);
  }

  get state(): WorkState {
    return this.#state;
  }

  get inputs(): Readonly<Record<string, string | boolean>> {
    return { ...this.#inputs };
  }

  /** The evidence attached so far, in ascending order of identifier. */
  get evidence(): readonly SignedEvidence[] {
    return [...this.#evidence.keys()].sort().map((id) => this.#evidence.get(id) as SignedEvidence);
  }

  get issued(): IssuedWork | undefined {
    return this.#issued;
  }

  /**
   * Attaches signed evidence the claim will rely on.
   *
   * Attaching does not authenticate anything; that happens under a registry
   * when the package is issued and again whenever it is verified. Evidence
   * of another tenant is refused here, since a package carrying it would be
   * refused anyway.
   */
  attach(...evidence: SignedEvidence[]): this {
    if (this.#state !== WorkState.OPEN) {
      throw new LifecycleError(
        `evidence can be attached only while work is open; it is ${this.#state}. ` +
          "A fixed claim lists exactly the evidence it relies on.",
      );
    }
    for (const item of evidence) {
      if (!(item instanceof SignedEvidence)) {
        throw new TypeError(
          "only SignedEvidence can be attached: an execution trace, a tool's return value " +
            "or a log line is not evidence until an identified source signs it",
        );
      }
      if (item.tenant !== this.tenant) {
        throw new LifecycleError(
          `evidence ${item.id} belongs to tenant ${JSON.stringify(item.tenant)}, ` +
            `not ${JSON.stringify(this.tenant)}`,
        );
      }
      const existing = this.#evidence.get(item.id);
      if (existing !== undefined && !existing.equals(item)) {
        throw new LifecycleError(`two different statements share the identifier ${item.id}`);
      }
    }
    for (const item of evidence) {
      this.#evidence.set(item.id, item);
    }
    for (const item of evidence) {
      this.#notify("evidence_attached", {
        evidence: item.id,
        source: item.source,
        kind: item.kind,
      });
    }
    return this;
  }

  /**
   * Fixes the claim with the evidence attached so far.
   *
   * After this the evidence list is closed. The claim is the claimant's
   * assertion; it is not evaluated here and it supports nothing by itself.
   */
  claim(options: { submittedAt?: Date | string } = {}): Claim {
    if (this.#state !== WorkState.OPEN) {
      throw new LifecycleError(`the claim is already fixed (state ${this.#state})`);
    }
    const claim: Claim = Object.freeze({
      id: this.claimId,
      tenant: this.tenant,
      claimant: this.claimant,
      contract: this.contract.digest,
      inputs: Object.freeze({ ...this.#inputs }),
      evidence: Object.freeze([...this.#evidence.keys()].sort()),
      submittedAt: instant(options.submittedAt ?? this.#clock()),
    });
    this.#claim = claim;
    this.#state = WorkState.CLAIMED;
    this.#notify("claim_fixed", { evidence: [...claim.evidence] });
    return claim;
  }

  /**
   * Evaluates the contract against the claim's evidence and seals the
   * result into a `wvp-0.2` package.
   *
   * The package is returned only if the shared verifier reproduces its
   * decision completely under `trust`; otherwise {@link AssemblyError} names
   * the refusal (for example `SOURCE_NOT_AUTHORIZED` for a statement whose
   * key may not speak for the system it names).
   *
   * The decision may be `CONTRADICTED` or `UNDETERMINED`. Those are results,
   * not errors.
   */
  issue(options: IssueOptions): IssuedWork {
    const claim = this.#claim;
    if (this.#state === WorkState.OPEN || claim === undefined) {
      throw new LifecycleError(
        "there is no claim yet: call claim() to fix what is asserted and which evidence " +
          "it relies on",
      );
    }
    if (this.#state === WorkState.ISSUED) {
      throw new LifecycleError(
        "this work was already issued; a decision about new evidence is a new claim",
      );
    }
    const evaluated = instant(options.evaluatedAt ?? this.#clock());
    const parts = encode({
      tenant: this.tenant,
      contract: this.contract.toObject(),
      claim: {
        id: claim.id,
        claimant: claim.claimant,
        inputs: { ...claim.inputs },
        submittedAt: claim.submittedAt,
      },
      evidence: claim.evidence.map((id) => (this.#evidence.get(id) as SignedEvidence).toWire()),
      evaluation: {
        packageId:
          options.evidenceSetId === undefined
            ? randomUuid()
            : uuid(options.evidenceSetId, "evidenceSetId"),
        ingestedAt: options.ingestedAt === undefined ? evaluated : instant(options.ingestedAt),
        assembledAt: options.assembledAt === undefined ? evaluated : instant(options.assembledAt),
        evaluatedAt: evaluated,
      },
    });
    const registry = options.trust.toBytes();
    let issued = callJson((native) => native.assemble_package(parts, registry));
    if (options.issuer !== undefined) {
      options.issuer.authority.require({ source: DECISION_SOURCE, tenant: this.tenant });
      const unsigned = new WorkPackage(issued["package"] as string).text;
      const message = call((native) => native.decision_signing_input(unsigned));
      const signature = encodeSignature(options.issuer.signer, message);
      issued = callJson((native) =>
        native.attach_issuer_signature(unsigned, signature.keyId, signature.encoded, registry),
      );
    }
    const check = resultOf(
      issued["report"] as JsonObject,
      options.trust,
      buildInfo()["verifier"] as string,
    );
    if (check.decision === null || check.packageId === null) {
      throw new LifecycleError("the issuer's check did not reproduce a decision");
    }
    this.#issued = Object.freeze({
      package: new WorkPackage(issued["package"] as string),
      packageId: check.packageId,
      decision: check.decision,
      issuerCheck: check,
    });
    this.#state = WorkState.ISSUED;
    this.#notify("package_issued", {
      package: this.#issued.packageId,
      decision: this.#issued.decision,
    });
    return this.#issued;
  }

  toString(): string {
    return (
      `Work(claim ${this.claimId}, ${this.contract.id} ${this.contract.version}, ` +
      `${this.#state}, ${this.#evidence.size} evidence)`
    );
  }
}
