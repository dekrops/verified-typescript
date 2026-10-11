// Independently verifying packages someone else produced.
//
// Run with:  node examples/standalone-verification/verify-packages.ts
//
// You are a third party. You hold three package files and a trust registry
// that *you* decided on. You have no account, no network, no agent framework
// and no access to the system the work was done in.
//
// All three packages verify completely. Only one of them says the work was
// done.

import { fileURLToPath } from "node:url";

import { RequirementNotMet, Verifier } from "verified-typescript";
import { readContract, readPackage, readTrustRegistry } from "verified-typescript/node";

const here = (name: string): string => fileURLToPath(new URL(name, import.meta.url));

// Your registry, from your configuration. Never one that came with a package.
const trust = readTrustRegistry(here("trust.json"));
// The contract you agreed to, pinned by digest: a package about any other
// contract, or another tenant, is refused.
const contract = readContract(here("../contracts/invoice-posting.json"));
const verifier = new Verifier({ trust, expect: { tenant: "acme-synthetic", contract } });

for (const name of ["supported.json", "contradicted.json", "undetermined.json"]) {
  const result = verifier.verify(readPackage(here(name)));
  console.log(`\n--- ${name} ---`);
  console.log(result.explain());
  try {
    result.requireSupported({ issuerSigned: true });
    console.log("=> rely on it: the work is supported by the evidence");
  } catch (error) {
    if (!(error instanceof RequirementNotMet)) {
      throw error;
    }
    console.log(`=> do not rely on it: ${error.message}`);
  }
}

console.log("\n--- supported.json, without a trust registry ---");
const integrityOnly = new Verifier({ trust: null }).verify(readPackage(here("supported.json")));
console.log(`verification status   ${integrityOnly.verificationStatus}`);
console.log(`decision reproduced   ${integrityOnly.decision}`);
console.log(`the package says      ${integrityOnly.stated?.recordedDecision} (its issuer's claim)`);

console.log("\n--- supported.json, one byte changed ---");
const text = new TextDecoder().decode(readPackage(here("supported.json")).text);
const tampered = verifier.verify(text.replace("INV-123", "INV-124"));
console.log(`verification status   ${tampered.verificationStatus}: ${tampered.refusal?.code}`);
