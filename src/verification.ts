// SPDX-License-Identifier: Apache-2.0

/**
 * Offline verification of Work Verification Protocol packages.
 *
 * Verification is performed by the shared Rust verifier. It reads no network
 * and no clock, and needs no account. The result keeps apart five things
 * that are easy to blur:
 *
 * 1. the package is **well formed and unaltered**
 *    ({@link VerificationResult.integrity});
 * 2. its evidence is **authentic** under *your* registry
 *    ({@link VerificationResult.evidenceSignatures},
 *    {@link VerificationResult.signerAuthority});
 * 3. the verification is **complete**
 *    ({@link VerificationResult.verificationStatus});
 * 4. the decision was **reproduced** ({@link VerificationResult.decision});
 * 5. the decision is the **outcome you need** (`requireSupported()`).
 *
 * A complete verification with a reproduced `CONTRADICTED` decision is a
 * successful verification of unsuccessful work. No check, here or anywhere,
 * establishes that a source told the truth.
 *
 * @module
 */

import { buildInfo, callJson, type Json, type JsonObject } from "./bridge.js";
import { asBytes } from "./bytes.js";
import { Digest, type DigestWire } from "./canonical.js";
import { WorkContract } from "./contracts.js";
import { RequirementNotMet, ResourceLimitError } from "./errors.js";
import { WorkPackage, WorkRecord } from "./records.js";
import { TrustRegistry } from "./trust.js";

/** The largest package examined unless a smaller bound is given: 32 MiB. */
export const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

/** How far a verification got. Not a judgement of the work. */
export const VerificationStatus = {
  /**
   * Every check the protocol defines ran and passed. The decision was
   * reproduced; it may be any of the three.
   */
  COMPLETE: "complete",
  /**
   * Integrity was established and nothing else: no trust registry was
   * supplied, so no signature was checked and no decision reproduced.
   */
  INCOMPLETE: "incomplete",
  /**
   * The package failed a protocol check. {@link VerificationResult.refusal}
   * names the first one.
   */
  REFUSED: "refused",
} as const;
export type VerificationStatus = (typeof VerificationStatus)[keyof typeof VerificationStatus];

/** What a contract yields from the evidence. */
export const Decision = {
  /** Every requirement is established by accepted evidence. */
  SUPPORTED: "SUPPORTED",
  /** At least one requirement is conclusively false under accepted evidence. */
  CONTRADICTED: "CONTRADICTED",
  /**
   * The accepted evidence does not settle at least one requirement. Missing
   * evidence lands here; it never becomes `CONTRADICTED` or `SUPPORTED`.
   */
  UNDETERMINED: "UNDETERMINED",
} as const;
export type Decision = (typeof Decision)[keyof typeof Decision];

/** The value of one requirement (strong Kleene logic). */
export const Truth = {
  TRUE: "TRUE",
  FALSE: "FALSE",
  UNKNOWN: "UNKNOWN",
} as const;
export type Truth = (typeof Truth)[keyof typeof Truth];

/** Whether one property was established. */
export const PropertyStatus = {
  ESTABLISHED: "established",
  /** The checks for the property did not run. Nothing is known about it. */
  NOT_CHECKED: "not_checked",
  /**
   * Issuer signature only: the package carries none. Nobody stands behind
   * the decision, which was reproduced regardless.
   */
  ABSENT: "absent",
  /** Source truthfulness only, always: no check can establish it. */
  NOT_ESTABLISHED: "not_established",
} as const;
export type PropertyStatus = (typeof PropertyStatus)[keyof typeof PropertyStatus];

/** One property of a verification, read on its own. */
export interface Property {
  readonly name: string;
  readonly status: PropertyStatus;
  readonly reason: string | null;
  readonly established: boolean;
}

/** The first protocol check a package failed. */
export interface Refusal {
  /** The protocol's refusal code. Stable; match on this. */
  readonly code: string;
  /** A description for people. Not stable; do not match on it. */
  readonly detail: string;
}

/** The reproduced value of one contract requirement. */
export interface RequirementValue {
  readonly id: string;
  readonly value: Truth;
}

/** Accepted records that describe one object differently. */
export interface Conflict {
  readonly kind: string;
  readonly facts: readonly string[];
  /** The fact the contract's conflict policy settled on, if it settled. */
  readonly resolvedTo: string | null;
}

/** One condition of the `wvp-0.1` `order-transition` evaluator. */
export interface Condition {
  readonly id: string;
  readonly holds: boolean;
  readonly evidence: readonly string[];
}

/** Which agreement a `wvp-0.2` decision is about. */
export interface ContractReference {
  readonly id: string;
  readonly version: string;
  readonly digest: Digest;
}

/**
 * What the relying party expects a package to be about (`wvp-0.2`).
 *
 * A package verifies against its own claim and contract. That they are the
 * ones you mean can only be established from outside it. An expectation that
 * is not given is not checked; an unmet one refuses the package
 * (`TENANT_NOT_EXPECTED`, `CONTRACT_NOT_EXPECTED`, `CLAIM_NOT_EXPECTED`).
 */
export interface Expectations {
  readonly tenant?: string | undefined;
  /** The contract, its digest, or the digest as `sha-256:<hex>`. */
  readonly contract?: Digest | WorkContract | string | undefined;
  readonly claim?: string | undefined;
}

/** The expectations a verification was given and met. */
export interface ExpectationsMet {
  readonly tenant: string | null;
  readonly contract: Digest | null;
  readonly claim: string | null;
}

/** One evidence statement, as the package states it. */
export interface StatedStatement {
  readonly id: string;
  readonly kind: string;
  readonly source: string;
  readonly issuer: string;
  readonly keyId: string;
  readonly observedAt: string;
  readonly body: string;
  readonly claimed: boolean;
}

/**
 * What a package says about itself.
 *
 * **Stated, not verified.** These values are covered by the package's
 * commitment, so they are the values of exactly the package the result is
 * about; whether anyone stands behind them is what the result's properties
 * say. In particular {@link StatedContent.recordedDecision} is the issuer's
 * claim. Only {@link VerificationResult.decision} says a decision was
 * reproduced.
 */
export interface StatedContent {
  readonly claimId: string;
  readonly claimant: string;
  readonly inputs: Readonly<JsonObject> | null;
  readonly recordedDecision: string;
  readonly contractReference: string;
  readonly statements: readonly StatedStatement[];
  readonly issuerSignatureKeys: readonly string[];
  readonly claimedButAbsent: readonly string[];
}

function contractDigest(expect: Expectations): Digest | undefined {
  const contract = expect.contract;
  if (contract === undefined) {
    return undefined;
  }
  if (contract instanceof WorkContract) {
    return contract.digest;
  }
  return contract instanceof Digest ? contract : Digest.parse(contract);
}

function property(name: string, raw: JsonObject): Property {
  const status = raw["status"] as PropertyStatus;
  return Object.freeze({
    name,
    status,
    reason: (raw["reason"] as string | undefined) ?? null,
    established: status === PropertyStatus.ESTABLISHED,
  });
}

interface Fields {
  verificationStatus: VerificationStatus;
  refusal: Refusal | null;
  protocol: string | null;
  packageId: string | null;
  tenant: string | null;
  claimId: string | null;
  statementCount: number | null;
  contract: ContractReference | null;
  integrity: Property;
  evidenceSignatures: Property;
  signerAuthority: Property;
  decisionReproduced: Property;
  issuerSignature: Property;
  sourceTruthfulness: Property;
  decision: Decision | null;
  requirements: readonly RequirementValue[];
  ignored: readonly string[];
  conflicts: readonly Conflict[];
  conditions: readonly Condition[];
  workRecord: WorkRecord | null;
  recordMatched: boolean;
  expectationsMet: ExpectationsMet;
  verifiedIssuerKeys: readonly string[] | null;
  stated: StatedContent | null;
  trustRegistry: Digest | null;
  verifier: string;
  raw: Readonly<JsonObject>;
}

/**
 * What verifying one package established.
 *
 * Read the properties you need; there is deliberately no single "valid"
 * flag. A result is an object, so it is always truthy: `if (result)` tests
 * nothing. To enforce an outcome use {@link requireComplete} or
 * {@link requireSupported}.
 */
export class VerificationResult {
  readonly verificationStatus: VerificationStatus;
  /** Set exactly when the status is `refused`. */
  readonly refusal: Refusal | null;

  readonly protocol: string | null;
  /** The package identifier, recomputed by the verifier. */
  readonly packageId: string | null;
  readonly tenant: string | null;
  readonly claimId: string | null;
  readonly statementCount: number | null;
  readonly contract: ContractReference | null;

  /**
   * Steps 1 to 7: the components are well formed and are the ones the
   * package commits to.
   */
  readonly integrity: Property;
  /** Every evidence statement's signature verifies. */
  readonly evidenceSignatures: Property;
  /**
   * Every signer is authorized by *your* registry for its statement's
   * tenant, issuer, source and time.
   */
  readonly signerAuthority: Property;
  /** The decision recomputed from the package equals the one it carries. */
  readonly decisionReproduced: Property;
  /** Whether someone you trust for decisions signed this one. */
  readonly issuerSignature: Property;
  /** Always `not_established`. A correctly signed statement can be false. */
  readonly sourceTruthfulness: Property;

  /**
   * The **reproduced** decision, or `null` when none was reproduced. The
   * decision a package merely carries is never shown here; see
   * {@link StatedContent.recordedDecision}.
   */
  readonly decision: Decision | null;
  readonly requirements: readonly RequirementValue[];
  /** Authentic records the contract does not accept (wrong source or kind). */
  readonly ignored: readonly string[];
  readonly conflicts: readonly Conflict[];
  /** `wvp-0.1` only. */
  readonly conditions: readonly Condition[];

  /**
   * `wvp-0.2`: the work record computed from the package. It records a
   * verification only when this result is complete.
   */
  readonly workRecord: WorkRecord | null;
  /** Whether a work record you supplied was compared and matched. */
  readonly recordMatched: boolean;
  /** The expectations you gave. All were met; an unmet one is a refusal. */
  readonly expectationsMet: ExpectationsMet;
  /** The keys whose decision signatures were verified, if any were. */
  readonly verifiedIssuerKeys: readonly string[] | null;
  readonly stated: StatedContent | null;

  /** The byte digest of the registry used, or `null` if none was. */
  readonly trustRegistry: Digest | null;
  /** The verifier build: `verified-verifier-<upstream revision>`. */
  readonly verifier: string;
  /** The verifier's JSON, in the upstream `verify --json` shape. */
  readonly raw: Readonly<JsonObject>;

  /** @internal Results come from a {@link Verifier}. */
  constructor(fields: Fields) {
    this.verificationStatus = fields.verificationStatus;
    this.refusal = fields.refusal;
    this.protocol = fields.protocol;
    this.packageId = fields.packageId;
    this.tenant = fields.tenant;
    this.claimId = fields.claimId;
    this.statementCount = fields.statementCount;
    this.contract = fields.contract;
    this.integrity = fields.integrity;
    this.evidenceSignatures = fields.evidenceSignatures;
    this.signerAuthority = fields.signerAuthority;
    this.decisionReproduced = fields.decisionReproduced;
    this.issuerSignature = fields.issuerSignature;
    this.sourceTruthfulness = fields.sourceTruthfulness;
    this.decision = fields.decision;
    this.requirements = fields.requirements;
    this.ignored = fields.ignored;
    this.conflicts = fields.conflicts;
    this.conditions = fields.conditions;
    this.workRecord = fields.workRecord;
    this.recordMatched = fields.recordMatched;
    this.expectationsMet = fields.expectationsMet;
    this.verifiedIssuerKeys = fields.verifiedIssuerKeys;
    this.stated = fields.stated;
    this.trustRegistry = fields.trustRegistry;
    this.verifier = fields.verifier;
    this.raw = fields.raw;
    Object.freeze(this);
  }

  /**
   * Whether every check the protocol defines ran and passed.
   *
   * Completeness says nothing about which decision was reproduced.
   */
  get isComplete(): boolean {
    return this.verificationStatus === VerificationStatus.COMPLETE;
  }

  /** The six properties, in report order. */
  get properties(): readonly Property[] {
    return [
      this.integrity,
      this.evidenceSignatures,
      this.signerAuthority,
      this.decisionReproduced,
      this.issuerSignature,
      this.sourceTruthfulness,
    ];
  }

  /**
   * Returns the result if verification was complete; throws otherwise.
   *
   * A complete result may carry any decision. Use this to accept a package
   * as *verified*, whatever it says about the work.
   */
  requireComplete(): this {
    if (this.refusal !== null) {
      throw new RequirementNotMet(
        `the package was refused: ${this.refusal.code}: ${this.refusal.detail}`,
        this,
      );
    }
    if (!this.isComplete) {
      throw new RequirementNotMet(
        "verification is incomplete: no trust registry was supplied, so no signature " +
          "was checked and no decision was reproduced",
        this,
      );
    }
    return this;
  }

  /**
   * Returns the result if verification was complete and reproduced exactly
   * `decision`; throws {@link RequirementNotMet} otherwise.
   *
   * With `issuerSigned: true` the decision must also carry a signature from
   * a key your registry trusts for decisions. Without one the decision is
   * reproduced but nobody stands behind it.
   */
  requireDecision(decision: Decision, options: { issuerSigned?: boolean } = {}): this {
    this.requireComplete();
    if (this.decision !== decision) {
      throw new RequirementNotMet(
        `the reproduced decision is ${this.decision}, not ${decision}`,
        this,
      );
    }
    if (options.issuerSigned === true && !this.issuerSignature.established) {
      throw new RequirementNotMet(
        `the decision is ${decision} but its issuer signature is ${this.issuerSignature.status}`,
        this,
      );
    }
    return this;
  }

  /**
   * Refuses anything but a complete verification that reproduced
   * `SUPPORTED`.
   *
   * Throws for a refused package, an incomplete verification, and a
   * reproduced `CONTRADICTED` or `UNDETERMINED`. Passing means the signed
   * records, from signers your registry authorizes, establish every
   * requirement of the package's contract. It does not mean the sources told
   * the truth, and it is not acceptance, billing eligibility or settlement.
   */
  requireSupported(options: { issuerSigned?: boolean } = {}): this {
    return this.requireDecision(Decision.SUPPORTED, options);
  }

  /** A plain-text report of what was and was not established. */
  explain(): string {
    if (this.refusal !== null) {
      return [
        "Work Verification Protocol package",
        `refused               ${this.refusal.code}`,
        `                      ${this.refusal.detail}`,
        "Nothing else was established about this package.",
      ].join("\n");
    }
    const lines = [`Work Verification Protocol package (${this.protocol})`];
    const row = (label: string, value: string): void => {
      lines.push(`${label.padEnd(22)}${value}`);
    };
    const shown = (prop: Property, established: string): string => {
      if (prop.established) {
        return established;
      }
      const reason = prop.reason === null ? "" : `: ${prop.reason.replaceAll("_", " ")}`;
      return `${prop.status.replaceAll("_", " ")}${reason}`;
    };

    row("verification", this.verificationStatus);
    row("package", String(this.packageId));
    row("tenant", `${this.tenant} (as the package states)`);
    row("claim", String(this.claimId));
    row("package integrity", shown(this.integrity, "established"));
    if (this.contract !== null) {
      row("contract", `${this.contract.id} ${this.contract.version}, ${this.contract.digest}`);
    }
    row(
      "evidence signatures",
      shown(this.evidenceSignatures, `established (${this.statementCount} statements)`),
    );
    row(
      "signer authority",
      shown(this.signerAuthority, `established under registry ${this.trustRegistry}`),
    );
    row(
      "decision reproduced",
      shown(this.decisionReproduced, `${this.decision}, matches the package`),
    );
    for (const requirement of this.requirements) {
      lines.push(`  ${requirement.id.padEnd(30)}${requirement.value}`);
    }
    for (const condition of this.conditions) {
      lines.push(`  ${condition.id.padEnd(30)}${condition.holds ? "holds" : "does not hold"}`);
    }
    if (this.ignored.length > 0) {
      lines.push(
        `  ${this.ignored.length} authentic record(s) ignored: source not accepted by the contract`,
      );
    }
    if (this.conflicts.length > 0) {
      const open = this.conflicts.filter((conflict) => conflict.resolvedTo === null).length;
      lines.push(
        `  ${this.conflicts.length} conflict(s) among accepted records, ${open} unresolved`,
      );
    }
    row("issuer signature", shown(this.issuerSignature, "established"));
    const met = (["tenant", "contract", "claim"] as const).filter(
      (name) => this.expectationsMet[name] !== null,
    );
    if (met.length > 0) {
      row("expectations met", met.join(", "));
    }
    if (this.recordMatched) {
      row("work record", "the supplied record is about this package");
    }
    row("source truthfulness", "NOT established: no check can establish it");
    if (!this.isComplete) {
      lines.push("The decision this package carries is its issuer's claim; it was not reproduced.");
    }
    return lines.join("\n");
  }
}

const NOT_ESTABLISHED: Property = Object.freeze({
  name: "sourceTruthfulness",
  status: PropertyStatus.NOT_ESTABLISHED,
  reason: "no_check_can_establish_it",
  established: false,
});

/** @internal Builds a result from the verifier's JSON. */
export function resultOf(
  raw: JsonObject,
  trust: TrustRegistry | null,
  verifier: string,
): VerificationResult {
  const trustRegistry = trust === null ? null : trust.byteDigest;
  if (raw["outcome"] === "refused") {
    const refused = raw["refusal"] as JsonObject;
    const blank = (name: string): Property =>
      Object.freeze({
        name,
        status: PropertyStatus.NOT_CHECKED,
        reason: "package_refused",
        established: false,
      });
    return new VerificationResult({
      verificationStatus: VerificationStatus.REFUSED,
      refusal: Object.freeze({
        code: refused["code"] as string,
        detail: refused["detail"] as string,
      }),
      protocol: null,
      packageId: null,
      tenant: null,
      claimId: null,
      statementCount: null,
      contract: null,
      integrity: blank("packageIntegrity"),
      evidenceSignatures: blank("evidenceSignatures"),
      signerAuthority: blank("signerAuthority"),
      decisionReproduced: blank("decisionReproduced"),
      issuerSignature: blank("issuerSignature"),
      sourceTruthfulness: NOT_ESTABLISHED,
      decision: null,
      requirements: [],
      ignored: [],
      conflicts: [],
      conditions: [],
      workRecord: null,
      recordMatched: false,
      expectationsMet: { tenant: null, contract: null, claim: null },
      verifiedIssuerKeys: null,
      stated: null,
      trustRegistry,
      verifier,
      raw,
    });
  }

  const properties = raw["properties"] as Record<string, JsonObject>;
  const reproduced = properties["decisionReproduced"] as JsonObject;
  const established = reproduced["status"] === "established";
  const contract = raw["contract"] as JsonObject | undefined;
  const met = raw["expectationsMet"] as JsonObject;
  const stated = raw["stated"] as JsonObject;
  const statedClaim = stated["claim"] as JsonObject;
  const keys = raw["verifiedIssuerKeys"] as string[] | null | undefined;
  const record = raw["workRecord"] as JsonObject | undefined;
  const list = (name: string): JsonObject[] => (reproduced[name] as JsonObject[] | undefined) ?? [];
  const wire = (value: Json | undefined): DigestWire => value as unknown as DigestWire;

  return new VerificationResult({
    verificationStatus: raw["outcome"] as VerificationStatus,
    refusal: null,
    protocol: raw["protocol"] as string,
    packageId: raw["packageId"] as string,
    tenant: raw["tenant"] as string,
    claimId: raw["claim"] as string,
    statementCount: Number(raw["statements"]),
    contract:
      contract === undefined
        ? null
        : {
            id: contract["id"] as string,
            version: contract["version"] as string,
            digest: Digest.fromWire(wire(contract["digest"])),
          },
    integrity: property("packageIntegrity", properties["packageIntegrity"] as JsonObject),
    evidenceSignatures: property(
      "evidenceSignatures",
      properties["evidenceSignatures"] as JsonObject,
    ),
    signerAuthority: property("signerAuthority", properties["signerAuthority"] as JsonObject),
    decisionReproduced: property("decisionReproduced", reproduced),
    issuerSignature: property("issuerSignature", properties["issuerSignature"] as JsonObject),
    sourceTruthfulness: property(
      "sourceTruthfulness",
      properties["sourceTruthfulness"] as JsonObject,
    ),
    decision: established ? (reproduced["decision"] as Decision) : null,
    requirements: list("requirements").map((item) => ({
      id: item["id"] as string,
      value: item["value"] as Truth,
    })),
    ignored: (reproduced["ignored"] as string[] | undefined) ?? [],
    conflicts: list("conflicts").map((item) => ({
      kind: item["kind"] as string,
      facts: item["facts"] as string[],
      resolvedTo: item["resolvedTo"] as string | null,
    })),
    conditions: list("conditions").map((item) => ({
      id: item["id"] as string,
      holds: item["holds"] as boolean,
      evidence: item["evidence"] as string[],
    })),
    workRecord: record === undefined ? null : new WorkRecord(record),
    recordMatched: raw["recordMatched"] === true,
    expectationsMet: {
      tenant: met["tenant"] as string | null,
      contract: met["contract"] === null ? null : Digest.fromWire(wire(met["contract"])),
      claim: met["claim"] as string | null,
    },
    verifiedIssuerKeys: keys ?? null,
    stated: {
      claimId: statedClaim["id"] as string,
      claimant: statedClaim["claimant"] as string,
      inputs: statedClaim["inputs"] as JsonObject | null,
      recordedDecision: stated["recordedDecision"] as string,
      contractReference: stated["contractReference"] as string,
      statements: (stated["statements"] as JsonObject[]).map((item) => ({
        id: item["id"] as string,
        kind: item["kind"] as string,
        source: item["source"] as string,
        issuer: item["issuer"] as string,
        keyId: item["keyId"] as string,
        observedAt: item["observedAt"] as string,
        body: item["body"] as string,
        claimed: item["claimed"] as boolean,
      })),
      issuerSignatureKeys: stated["issuerSignatureKeys"] as string[],
      claimedButAbsent: stated["claimedButAbsent"] as string[],
    },
    trustRegistry,
    verifier,
    raw,
  });
}

/** What a {@link Verifier} is configured with. */
export interface VerifierOptions {
  /**
   * The relying party's registry, or `null`. Required, and never defaulted:
   * `null` is an explicit choice to establish integrity only.
   */
  trust: TrustRegistry | null;
  expect?: Expectations | undefined;
  /** Require one protocol version (`wvp-0.1` or `wvp-0.2`) instead of detecting it. */
  protocol?: string | undefined;
  /** A bound smaller than {@link DEFAULT_MAX_BYTES}. */
  maxBytes?: number | undefined;
}

/** What one call to {@link Verifier.verify} may add. */
export interface VerifyOptions {
  /** Overrides the verifier's expectations for this call. */
  expect?: Expectations | undefined;
  /**
   * A work record you hold. The package must be the one it is about, member
   * for member, or it is refused (`RECORD_MISMATCH`).
   */
  record?: WorkRecord | undefined;
}

/**
 * An offline verifier configured with the relying party's trust.
 *
 * `trust` has no default and must be written out. `new Verifier({ trust:
 * null })` is a legitimate, explicit choice: it establishes package
 * integrity only, and every result it returns is `incomplete` or `refused`,
 * never `complete`. A registry that travels with a package is not a trust
 * registry; load yours from your own configuration.
 *
 * A verifier holds no state between calls.
 */
export class Verifier {
  readonly trust: TrustRegistry | null;
  readonly #expect: Expectations | undefined;
  readonly #protocol: string | undefined;
  readonly #maxBytes: number;

  constructor(options: VerifierOptions) {
    // A plain-JavaScript caller can leave `trust` out; that must not read as null.
    if (options === null || typeof options !== "object" || options.trust === undefined) {
      throw new TypeError(
        "trust has no default: pass a TrustRegistry, or null to establish integrity only",
      );
    }
    if (options.trust !== null && !(options.trust instanceof TrustRegistry)) {
      throw new TypeError("trust is a TrustRegistry: build one with TrustRegistry.fromJson(text)");
    }
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > DEFAULT_MAX_BYTES) {
      throw new RangeError(`maxBytes is between 1 and ${DEFAULT_MAX_BYTES}`);
    }
    this.trust = options.trust;
    this.#expect = options.expect;
    this.#protocol = options.protocol;
    this.#maxBytes = maxBytes;
  }

  /**
   * Verifies a package and reports what was established.
   *
   * `package` is a {@link WorkPackage} or the package text, as bytes or as a
   * string. To verify a file, read it with `readPackage` from
   * `verified-typescript/node`.
   *
   * Returns a result for every package that could be examined, including
   * refused ones. Throws only when nothing could be concluded: an oversized
   * input, or a request the package's protocol version does not define.
   */
  verify(
    workPackage: WorkPackage | Uint8Array | string,
    options: VerifyOptions = {},
  ): VerificationResult {
    const packageText =
      workPackage instanceof WorkPackage ? workPackage.text : asBytes(workPackage);
    if (packageText.length > this.#maxBytes) {
      throw new ResourceLimitError(`package: larger than ${this.#maxBytes} bytes; not examined`);
    }
    const expect = options.expect ?? this.#expect ?? {};
    const digest = contractDigest(expect);
    const trust = this.trust?.toBytes();
    const record = options.record?.toBytes();
    const raw = callJson((native) =>
      native.verify(
        packageText,
        trust,
        this.#protocol,
        expect.tenant,
        digest?.hex,
        expect.claim,
        record,
        this.#maxBytes,
      ),
    );
    return resultOf(raw, this.trust, buildInfo()["verifier"] as string);
  }
}
