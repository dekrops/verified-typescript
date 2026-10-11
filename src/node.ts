// SPDX-License-Identifier: Apache-2.0

/**
 * File helpers for Node.js, Deno and Bun. The core package touches no file
 * system; these do, and nothing else.
 *
 * @module
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";

import { WorkContract } from "./contracts.js";
import { ResourceLimitError, TrustRegistryError } from "./errors.js";
import { WorkPackage, WorkRecord } from "./records.js";
import { MAX_REGISTRY_BYTES, TrustRegistry } from "./trust.js";
import { DEFAULT_MAX_BYTES } from "./verification.js";

type Path = string | URL;

/** Reads a registry file: `{"keys": [...]}`. */
export function readTrustRegistry(path: Path): TrustRegistry {
  let contents: Uint8Array;
  try {
    if (statSync(path).size > MAX_REGISTRY_BYTES) {
      throw new ResourceLimitError(
        `trust registry ${path}: larger than ${MAX_REGISTRY_BYTES} bytes`,
      );
    }
    contents = readFileSync(path);
  } catch (error) {
    if (error instanceof ResourceLimitError) {
      throw error;
    }
    throw new TrustRegistryError(`trust registry ${path}: cannot be read`, { cause: error });
  }
  return TrustRegistry.fromJson(contents);
}

/**
 * Reads a contract file. Throws `ContractError` if it is not a well-formed
 * contract.
 */
export function readContract(path: Path): WorkContract {
  return WorkContract.fromJson(readFileSync(path));
}

/**
 * Reads a package file, without examining it. A file larger than the
 * largest package a verifier examines is not read.
 */
export function readPackage(path: Path): WorkPackage {
  if (statSync(path).size > DEFAULT_MAX_BYTES + 2) {
    throw new ResourceLimitError(
      `package ${path}: larger than ${DEFAULT_MAX_BYTES} bytes; not examined`,
    );
  }
  return WorkPackage.fromFile(readFileSync(path));
}

/** Writes the package text, with no trailing line end. */
export function writePackage(path: Path, workPackage: WorkPackage): void {
  writeFileSync(path, workPackage.text);
}

/** Reads a work record file. */
export function readWorkRecord(path: Path): WorkRecord {
  return WorkRecord.fromJson(readFileSync(path));
}

/** Writes a work record's canonical text. */
export function writeWorkRecord(path: Path, record: WorkRecord): void {
  writeFileSync(path, record.toBytes());
}
