// SPDX-License-Identifier: Apache-2.0

/**
 * Errors thrown by the SDK.
 *
 * Errors are for *operational* failures: something prevented an operation
 * from being carried out, so nothing was concluded. Expected protocol
 * outcomes are never errors. A refused package, an incomplete verification
 * and a reproduced `CONTRADICTED` decision are all values of
 * {@link VerificationResult}.
 *
 * The one deliberate exception to that rule is {@link RequirementNotMet},
 * thrown only by the `require…` methods a caller invokes to turn a result
 * into an enforcement decision.
 *
 * @module
 */

import type { VerificationResult } from "./verification.js";

/** Base class of every error this SDK throws on purpose. */
export class VerifiedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The WebAssembly verification module could not be loaded in this runtime.
 *
 * Verification, canonical encoding, signing input and package assembly are
 * implemented by the shared Rust crates and are never approximated in
 * JavaScript. Without the module those operations fail with this error; they
 * do not fall back to a weaker check.
 */
export class NativeUnavailableError extends VerifiedError {}

/**
 * An input is not JSON the protocol's encoding can represent.
 *
 * This includes fractional numbers and duplicate object keys, which
 * `verified-json-v1` does not have.
 */
export class MalformedInputError extends VerifiedError {}

/**
 * An input exceeds a resource bound of this verifier.
 *
 * This is not a protocol refusal: the input was not examined, and a verifier
 * with other limits may accept it.
 */
export class ResourceLimitError extends VerifiedError {}

/**
 * A trust registry is missing, malformed or holds unusable key material.
 *
 * A configuration error of the relying party, never a statement about a
 * package.
 */
export class TrustRegistryError extends VerifiedError {}

/** A document is not a well-formed Work Contract Language contract. */
export class ContractError extends VerifiedError {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

/** A work-unit scope or its identifying values are not usable. */
export class WorkUnitError extends VerifiedError {}

/**
 * The protocol version at hand does not define the requested operation.
 *
 * For example relying-party expectations and work records exist only for
 * `wvp-0.2`. Ignoring the request would report more than was checked.
 */
export class UnsupportedOperationError extends VerifiedError {}

/**
 * A signature was requested outside the signer's declared authority.
 *
 * Thrown before anything is signed, when an evidence source is asked to
 * speak for a system, tenant or purpose its authority does not name.
 */
export class SigningAuthorityError extends VerifiedError {}

/** An operation is not valid in the current state of a work item or session. */
export class LifecycleError extends VerifiedError {}

/**
 * A package could not be issued.
 *
 * The shared verifier would not reproduce the package completely under the
 * issuer's registry. The message names the protocol refusal: for example
 * `SOURCE_NOT_AUTHORIZED` for a statement whose key may not speak for the
 * system it names, or `INPUT_MISMATCH` for a claim or evidence that does not
 * fit the contract.
 */
export class AssemblyError extends VerifiedError {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

/**
 * A `require…` check on a verification result failed.
 *
 * `result` is the full result, so a handler can still tell a refusal from an
 * incomplete verification from a reproduced `CONTRADICTED`.
 */
export class RequirementNotMet extends VerifiedError {
  readonly result: VerificationResult;

  constructor(message: string, result: VerificationResult) {
    super(message);
    this.result = result;
  }
}
