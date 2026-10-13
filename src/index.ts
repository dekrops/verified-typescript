// SPDX-License-Identifier: Apache-2.0

/**
 * `verified-typescript`: the TypeScript SDK for the Work Verification
 * Protocol.
 *
 * This entry point runs anywhere WebAssembly does. Agent instrumentation,
 * which needs asynchronous context tracking, is in
 * `verified-typescript/instrumentation`; file helpers are in
 * `verified-typescript/node`.
 *
 * @module
 */

export {
  buildInfo,
  type Json,
  type JsonObject,
  nativeAvailable,
  ready,
} from "./bridge.js";
export { canonicalize, Digest, type DigestWire } from "./canonical.js";
export { WorkContract } from "./contracts.js";
export {
  AuthorizationOutcome,
  type AuthorizationReplay,
  type BoundDerivation,
  type DerivationReplay,
  ReplayOutcome,
  type RequirementBinding,
  replayDerivation,
} from "./derivation.js";
export {
  AssemblyError,
  ContractError,
  LifecycleError,
  MalformedInputError,
  NativeUnavailableError,
  RequirementNotMet,
  ResourceLimitError,
  SigningAuthorityError,
  TrustRegistryError,
  UnsupportedOperationError,
  VerifiedError,
  WorkUnitError,
} from "./errors.js";
export {
  type Authentication,
  type CompletenessOptions,
  EvidenceKind,
  EvidenceSource,
  type EvidenceSourceOptions,
  type FieldValue,
  type GroupOptions,
  SignedEvidence,
  type StatementOptions,
  type Subject,
} from "./evidence.js";
export {
  type CarriedRelation,
  type HistoryReading,
  type OfferedRecord,
  packageReference,
  RecordKind,
  type RecordReference,
  type RelationRead,
  readHistory,
  type SameClaim,
  type SignedRelation,
  Standing,
  StreamCompleteness,
  type StreamRead,
  workRecordReference,
} from "./history.js";
export { WorkPackage, WorkRecord } from "./records.js";
export {
  DECISION_SOURCE,
  Ed25519Signer,
  type KeyValidity,
  type Signer,
  SigningAuthority,
  type SigningAuthorityOptions,
} from "./signing.js";
export type { Clock } from "./time.js";
export { MAX_REGISTRY_BYTES, type TrustedKey, TrustRegistry } from "./trust.js";
export {
  type Condition,
  type Conflict,
  type ContractReference,
  DEFAULT_MAX_BYTES,
  Decision,
  type Expectations,
  type ExpectationsMet,
  type Property,
  PropertyStatus,
  type Refusal,
  type RequirementValue,
  type StatedContent,
  type StatedStatement,
  Truth,
  VerificationResult,
  VerificationStatus,
  Verifier,
  type VerifierOptions,
  type VerifyOptions,
} from "./verification.js";
export {
  AgentIdentity,
  type BeginOptions,
  type Claim,
  DecisionIssuer,
  type IssuedWork,
  type IssueOptions,
  Work,
  WorkState,
} from "./work.js";
export { type WorkUnit, type WorkUnitOptions, type WorkUnitScope, workUnit } from "./workUnit.js";

/** The version of this package. */
export const VERSION = "0.1.0";
