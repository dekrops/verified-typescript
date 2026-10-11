// Producing evidence from a business system without overstating its authority.
//
// Run with:  node examples/enterprise-evidence/order-gateway.ts
//
// A small integration watches a (simulated) order system and signs the state
// transitions it observes. The points this example makes:
//
// 1. Signing authority is configured explicitly and scoped: one key, one
//    issuer, one tenant, named source systems. The integration cannot sign
//    for a system outside that scope.
// 2. The signer is an interface. Here it is an in-memory test key; in
//    production it is your KMS or HSM, and the SDK never sees the private key.
// 3. What the integration hands to a relying party is a registry *record*
//    for its key. Whether to trust it is the relying party's decision.
// 4. A signature establishes who said something and that it was not altered.
//    It does not establish that it is true.
//
// Everything is synthetic.

import {
  type Authentication,
  Ed25519Signer,
  EvidenceKind,
  EvidenceSource,
  type Signer,
  SigningAuthority,
  SigningAuthorityError,
  TrustRegistry,
} from "verified-typescript";

const TENANT = "acme-synthetic";

/**
 * A signer that wraps another and logs every request, the way a KMS client
 * would. It satisfies `Signer` by shape alone.
 */
class AuditedSigner implements Signer {
  requests = 0;
  readonly inner: Signer;

  constructor(inner: Signer) {
    this.inner = inner;
  }

  get keyId(): string {
    return this.inner.keyId;
  }

  sign(message: Uint8Array): Uint8Array {
    this.requests += 1;
    const domain = new TextDecoder().decode(message.subarray(0, message.indexOf(0x0a)));
    console.log(
      `  [signer] request ${this.requests}: ${message.length} bytes under ${JSON.stringify(domain)}`,
    );
    return this.inner.sign(message);
  }
}

const show = (outcome: Authentication): string =>
  outcome.refusal === null ? "authenticated" : `refused: ${outcome.refusal.code}`;

const key = new Ed25519Signer({ keyId: "order-gateway-2026-1", seed: new Uint8Array(32).fill(31) });
const signer = new AuditedSigner(key);
const authority = new SigningAuthority({
  keyId: "order-gateway-2026-1",
  issuer: "00000000-0000-4000-8000-0000000000a1",
  tenant: TENANT,
  sources: ["order-system"],
});
const gateway = new EvidenceSource({ system: "order-system", authority, signer });

console.log("1. An observed state transition, signed by the gateway");
const observedAt = new Date(Date.UTC(2026, 2, 1, 10, 0, 0));
const evidence = gateway.record(
  "order_state",
  { order: "SO-1001", state: "shipped", changedAt: observedAt.getTime() / 1000 },
  {
    subject: { system: "order-system", kind: "order", key: "SO-1001" },
    evidenceKind: EvidenceKind.STATE_TRANSITION,
    observedAt,
    observationId: "order-system:change-log:88213",
  },
);
console.log(`  statement  ${evidence.id}`);
console.log(`  source     ${evidence.source} (kind ${evidence.kind})`);
console.log(`  observed   ${evidence.observedAt}  <- asserted by the signer, not authenticated`);
console.log(`  signed by  ${evidence.keyId}`);
console.log(`  digest     ${evidence.digest}`);

console.log("\n2. The same integration asked to speak for a system it has no authority over");
try {
  new EvidenceSource({ system: "payments", authority, signer });
} catch (error) {
  if (!(error instanceof SigningAuthorityError)) {
    throw error;
  }
  console.log(`  refused: ${error.message}`);
}

console.log("\n3. What a relying party is offered, and decides for itself");
const record = authority.trustedKey(key.publicKey, { validFrom: "2026-01-01T00:00:00Z" });
console.log(
  `  registry record for ${record["keyId"]}: sources ${JSON.stringify(record["sources"])}`,
);
const adopted = TrustRegistry.fromKeys([record]);
console.log(`  relying party that adopted the key:     ${show(evidence.authenticate(adopted))}`);
const narrower = TrustRegistry.fromKeys([{ ...record, sources: ["warehouse"] }]);
console.log(`  relying party that trusts it for less:  ${show(evidence.authenticate(narrower))}`);
const revoked = TrustRegistry.fromKeys([
  { ...record, revokedAt: { value: "2026-02-01T00:00:00Z" } },
]);
console.log(`  relying party that revoked it earlier:  ${show(evidence.authenticate(revoked))}`);

console.log("\n4. What the signature does not say");
console.log("  The statement is authentic. Whether SO-1001 really shipped is the order");
console.log("  system's word. No verifier can establish source truthfulness.");
