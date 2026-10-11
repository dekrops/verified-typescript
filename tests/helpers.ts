// SPDX-License-Identifier: Apache-2.0

// Shared fixtures. Every key, tenant and record here is synthetic.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AgentIdentity,
  type BeginOptions,
  type Clock,
  canonicalize,
  DecisionIssuer,
  Digest,
  Ed25519Signer,
  EvidenceSource,
  type SignedEvidence,
  SigningAuthority,
  type Subject,
  TrustRegistry,
  Work,
  type WorkContract,
  WorkPackage,
} from "../src/index.js";
import { readContract } from "../src/node.js";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const CONTRACTS = join(ROOT, "examples", "contracts");

/**
 * The published WVP conformance corpus, or `undefined`.
 *
 * `VERIFIED_CONFORMANCE_DIR` overrides the pinned submodule. With
 * `VERIFIED_CONFORMANCE_REQUIRED=1` a missing corpus is a failure, so a run
 * that claims conformance cannot skip silently.
 */
export function corpusDir(): string | undefined {
  const directory =
    process.env["VERIFIED_CONFORMANCE_DIR"] ?? join(ROOT, "conformance", "wvp", "test-vectors");
  if (existsSync(join(directory, "canonical-hash-v1.json"))) {
    return directory;
  }
  if (process.env["VERIFIED_CONFORMANCE_REQUIRED"]) {
    throw new Error(
      `VERIFIED_CONFORMANCE_REQUIRED is set but there is no corpus at ${directory}; ` +
        "run `git submodule update --init`",
    );
  }
  return undefined;
}

/** The `.json` files of a corpus directory, sorted. */
export function vectorFiles(...parts: string[]): string[] {
  const corpus = corpusDir();
  if (corpus === undefined) {
    return [];
  }
  const directory = join(corpus, ...parts);
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(directory, name));
}

/**
 * A number of a corpus file, kept as the text it was written with.
 *
 * The corpus holds integers larger than a JavaScript number and, in one
 * case, a fraction. Tests hand vectors to the verifier as they were
 * published, so numbers are never read into a `number` and written back.
 */
export class RawNumber {
  readonly source: string;

  constructor(source: string) {
    this.source = source;
  }
}

type Context = { source: string };

/** Reads JSON, keeping every number as its source text. */
export function readExact(jsonText: string): unknown {
  const revive = (_key: string, value: unknown, context: Context): unknown =>
    typeof value === "number" ? new RawNumber(context.source) : value;
  return JSON.parse(jsonText, revive as unknown as (key: string, value: unknown) => unknown);
}

/** Writes a value read by {@link readExact}, numbers verbatim. */
export function writeExact(value: unknown): Uint8Array {
  const write = (item: unknown): string => {
    if (item instanceof RawNumber) {
      return item.source;
    }
    if (Array.isArray(item)) {
      return `[${item.map(write).join(",")}]`;
    }
    if (item !== null && typeof item === "object") {
      const members = Object.entries(item).map(
        ([key, member]) => `${JSON.stringify(key)}:${write(member)}`,
      );
      return `{${members.join(",")}}`;
    }
    return JSON.stringify(item);
  };
  return new TextEncoder().encode(write(value));
}

/** A value read by {@link readExact} as plain data, numbers as numbers. */
export function plain(value: unknown): unknown {
  return JSON.parse(new TextDecoder().decode(writeExact(value)));
}

export function loadExact(path: string): Record<string, unknown> {
  return readExact(readFileSync(path, "utf8")) as Record<string, unknown>;
}

export function load(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** A clock that advances one second each time it is read. */
export function tickingClock(start = Date.UTC(2026, 2, 1, 10, 0, 0)): Clock {
  let at = start;
  return () => {
    at += 1000;
    return new Date(at);
  };
}

/** An agent, an ERP gateway, a decision issuer and a relying party. */
export class Parties {
  readonly tenant: string;
  readonly contract: WorkContract;
  readonly clock: Clock;
  readonly agent: AgentIdentity;
  readonly gatewaySigner: Ed25519Signer;
  readonly gatewayAuthority: SigningAuthority;
  readonly agentSigner: Ed25519Signer;
  readonly agentAuthority: SigningAuthority;
  readonly issuerSigner: Ed25519Signer;
  readonly issuerAuthority: SigningAuthority;
  readonly trust: TrustRegistry;

  constructor(tenant = "tenant-synthetic", seed = 1) {
    const key = (n: number): Uint8Array => new Uint8Array(32).fill(n);
    this.tenant = tenant;
    this.contract = readContract(join(CONTRACTS, "invoice-posting.json"));
    this.clock = tickingClock();
    this.agent = new AgentIdentity("invoice-agent", { version: "1" });
    this.gatewaySigner = new Ed25519Signer({ keyId: "erp-gateway-1", seed: key(seed) });
    this.agentSigner = new Ed25519Signer({ keyId: "agent-runtime-1", seed: key(seed + 1) });
    this.issuerSigner = new Ed25519Signer({ keyId: "decision-issuer-1", seed: key(seed + 2) });
    this.gatewayAuthority = new SigningAuthority({
      keyId: "erp-gateway-1",
      issuer: "00000000-0000-4000-8000-0000000000e1",
      tenant,
      sources: ["erp"],
    });
    this.agentAuthority = new SigningAuthority({
      keyId: "agent-runtime-1",
      issuer: this.agent.id,
      tenant,
      sources: ["agent-runtime"],
    });
    this.issuerAuthority = new SigningAuthority({
      keyId: "decision-issuer-1",
      issuer: "00000000-0000-4000-8000-0000000000d1",
      tenant,
      sources: ["wvp-decision"],
    });
    const validFrom = "2026-01-01T00:00:00Z";
    this.trust = TrustRegistry.fromKeys([
      this.gatewayAuthority.trustedKey(this.gatewaySigner.publicKey, { validFrom }),
      this.agentAuthority.trustedKey(this.agentSigner.publicKey, { validFrom }),
      this.issuerAuthority.trustedKey(this.issuerSigner.publicKey, { validFrom }),
    ]);
  }

  get gateway(): EvidenceSource {
    return new EvidenceSource({
      system: "erp",
      authority: this.gatewayAuthority,
      signer: this.gatewaySigner,
      clock: this.clock,
    });
  }

  get agentRuntime(): EvidenceSource {
    return new EvidenceSource({
      system: "agent-runtime",
      authority: this.agentAuthority,
      signer: this.agentSigner,
      clock: this.clock,
    });
  }

  get issuer(): DecisionIssuer {
    return new DecisionIssuer({ authority: this.issuerAuthority, signer: this.issuerSigner });
  }

  subject(invoice = "INV-1"): Subject {
    return { system: "erp", kind: "invoice", key: invoice };
  }

  posting(invoice = "INV-1", document = "D-1"): SignedEvidence {
    return this.gateway.record(
      "posting",
      { document, invoice, amount: 125_000 },
      { subject: this.subject(invoice) },
    );
  }

  listingComplete(invoice = "INV-1"): SignedEvidence {
    return this.gateway.complete("posting", { subject: this.subject(invoice) });
  }

  work(invoice = "INV-1", options: Partial<BeginOptions> = {}): Work {
    return Work.begin({
      contract: this.contract,
      tenant: this.tenant,
      claimant: this.agent,
      inputs: { invoice },
      clock: this.clock,
      ...options,
    });
  }
}

// --- Tools for building packages that should be refused. Test code only. ---

const PATHS = [
  "claim.json",
  "contract.json",
  "decision.json",
  "evidence/bodies.json",
  "evidence/statements.json",
  "inputs.json",
];

// biome-ignore lint/suspicious/noExplicitAny: tests reach into arbitrary package JSON
export type Loose = any;

/** Changes a package and leaves its digests as they were. */
export function edit(workPackage: WorkPackage, change: (value: Loose) => void): WorkPackage {
  const value = JSON.parse(new TextDecoder().decode(workPackage.text));
  change(value);
  return new WorkPackage(canonicalize(value));
}

export function component(value: Loose, path: string): Loose {
  return value.files[PATHS.indexOf(path)].content;
}

/**
 * Recomputes every digest, the commitment and the identifier, as someone
 * who altered a package and wanted to hide it would.
 */
export function reseal(value: Loose): void {
  value.manifest.files.forEach((entry: Loose, index: number) => {
    entry.hash = Digest.ofJson(value.files[index].content).toWire();
  });
  const commitment = Digest.ofJson(value.manifest);
  value.packageCommitment = commitment.toWire();
  value.packageId = `wvp:sha-256:${commitment.hex}`;
}

export function editAndReseal(
  workPackage: WorkPackage,
  change: (value: Loose) => void,
): WorkPackage {
  return edit(workPackage, (value) => {
    change(value);
    reseal(value);
  });
}
