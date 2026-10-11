// Regenerates the synthetic packages in this directory.
//
// Run with:  node examples/standalone-verification/make-fixtures.ts
//
// The keys are derived from fixed, published seeds. Anyone can sign with
// them. Never put them in a registry you rely on. A test fails if the
// checked-in files differ from what this script produces.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  AgentIdentity,
  DecisionIssuer,
  Ed25519Signer,
  EvidenceSource,
  type SignedEvidence,
  SigningAuthority,
  type Subject,
  TrustRegistry,
  Work,
} from "verified-typescript";
import { readContract } from "verified-typescript/node";

const here = (name: string): string => fileURLToPath(new URL(name, import.meta.url));
const TENANT = "acme-synthetic";
const CONTRACT = readContract(here("../contracts/invoice-posting.json"));

/** Every fixture, by file name. Fully deterministic. */
export function build(): Record<string, Uint8Array> {
  const start = Date.UTC(2026, 2, 1, 10, 0, 0);
  const minutes = (n: number): Date => new Date(start + n * 60_000);
  const hex = (n: number): string => n.toString(16).padStart(2, "0");

  const party = (keyId: string, seed: number, source: string) => ({
    authority: new SigningAuthority({
      keyId,
      issuer: `00000000-0000-4000-8000-0000000000${hex(seed)}`,
      tenant: TENANT,
      sources: [source],
    }),
    signer: new Ed25519Signer({ keyId, seed: new Uint8Array(32).fill(seed) }),
  });
  const erp = party("synthetic-erp-gateway", 51, "erp");
  const decisions = party("synthetic-decision-issuer", 52, "wvp-decision");
  const validFrom = "2026-01-01T00:00:00Z";
  const trust = TrustRegistry.fromKeys([
    erp.authority.trustedKey(erp.signer.publicKey, { validFrom }),
    decisions.authority.trustedKey(decisions.signer.publicKey, { validFrom }),
  ]);

  const gateway = new EvidenceSource({ system: "erp", ...erp });
  const issuer = new DecisionIssuer(decisions);
  const subject: Subject = { system: "erp", kind: "invoice", key: "INV-123" };
  const posting = gateway.record(
    "posting",
    { document: "DOC-1", invoice: "INV-123", amount: 125_000 },
    { subject, observedAt: minutes(0), evidenceId: "00000000-0000-4000-8000-000000000001" },
  );
  const complete = gateway.complete("posting", {
    subject,
    observedAt: minutes(0),
    evidenceId: "00000000-0000-4000-8000-000000000002",
  });

  const issue = (number: number, ...evidence: SignedEvidence[]): Uint8Array => {
    const work = Work.begin({
      contract: CONTRACT,
      tenant: TENANT,
      claimant: new AgentIdentity("invoice-agent", { version: "1" }),
      inputs: { invoice: "INV-123" },
      claimId: `00000000-0000-4000-8000-00000000050${number}`,
    });
    work.attach(...evidence);
    work.claim({ submittedAt: minutes(5) });
    return work.issue({
      trust,
      issuer,
      evaluatedAt: minutes(10),
      evidenceSetId: `00000000-0000-4000-8000-00000000090${number}`,
    }).package.text;
  };

  return {
    "trust.json": trust.toBytes(),
    "supported.json": issue(1, posting, complete),
    "contradicted.json": issue(2, complete),
    "undetermined.json": issue(3),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [name, content] of Object.entries(build())) {
    writeFileSync(here(name), content);
    console.log(`wrote ${name} (${content.length} bytes)`);
  }
}
