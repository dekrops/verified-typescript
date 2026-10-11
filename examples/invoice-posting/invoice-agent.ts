// An agent posts an invoice. Did the ERP actually post it?
//
// Run with:  node examples/invoice-posting/invoice-agent.ts
//
// Everything here is synthetic: the tenant, the systems, the invoices and
// the keys. Three parties appear, and keeping them apart is the whole point.
//
// - The **agent runtime** runs a tool and reports what the tool returned.
//   That is its own account of itself.
// - The **ERP gateway** sits beside the (simulated) ERP and signs what the
//   ERP holds. It has its own key, authorized for the source `erp`.
// - The **relying party** holds a trust registry it composed itself, and
//   verifies the resulting package offline.
//
// The same agent run is evaluated three times, against three states of the
// ERP. The agent says "posted" every time.

import { fileURLToPath } from "node:url";

import {
  AgentIdentity,
  AssemblyError,
  Ed25519Signer,
  EvidenceSource,
  RequirementNotMet,
  type SignedEvidence,
  SigningAuthority,
  type Subject,
  TrustRegistry,
  Verifier,
  Work,
} from "verified-typescript";
import { verifiedTool, WorkSession } from "verified-typescript/instrumentation";
import { readContract } from "verified-typescript/node";

const TENANT = "acme-synthetic";
const CONTRACT = readContract(
  fileURLToPath(new URL("../contracts/invoice-posting.json", import.meta.url)),
);
const VALID_FROM = "2026-01-01T00:00:00Z";
const seed = (n: number): Uint8Array => new Uint8Array(32).fill(n);

/**
 * A stand-in for the system of record. It can silently drop a posting, which
 * is exactly the failure an agent cannot see from the tool's return.
 */
class SimulatedErp {
  readonly postings = new Map<string, { invoice: string; amount: number }>();
  readonly dropsPostings: boolean;

  constructor(dropsPostings = false) {
    this.dropsPostings = dropsPostings;
  }

  async postInvoice(invoiceId: string, amountCents: number) {
    const document = `DOC-${invoiceId}`;
    if (!this.dropsPostings) {
      this.postings.set(document, { invoice: invoiceId, amount: amountCents });
    }
    // The API answers "accepted" either way.
    return { status: "accepted", document };
  }
}

// --- the agent runtime -------------------------------------------------------

const AGENT = new AgentIdentity("invoice-agent", { version: "1" });

const makeTool = (erp: SimulatedErp) =>
  verifiedTool(
    {
      workType: "invoice.post",
      contract: CONTRACT,
      inputs: (invoiceId: string, _amountCents: number) => ({ invoice: invoiceId }),
    },
    (invoiceId: string, amountCents: number) => erp.postInvoice(invoiceId, amountCents),
  );

// --- the ERP gateway: a separate party with a separate key -------------------

const GATEWAY_SIGNER = new Ed25519Signer({ keyId: "erp-gateway-1", seed: seed(11) });
const GATEWAY_AUTHORITY = new SigningAuthority({
  keyId: "erp-gateway-1",
  issuer: "00000000-0000-4000-8000-0000000000e1",
  tenant: TENANT,
  sources: ["erp"],
});

/** What the gateway signs after reading the ERP for one invoice. */
function observeErp(erp: SimulatedErp, invoiceId: string, vouchComplete: boolean) {
  const gateway = new EvidenceSource({
    system: "erp",
    authority: GATEWAY_AUTHORITY,
    signer: GATEWAY_SIGNER,
  });
  const subject: Subject = { system: "erp", kind: "invoice", key: invoiceId };
  const evidence: SignedEvidence[] = [];
  for (const [document, row] of erp.postings) {
    if (row.invoice === invoiceId) {
      evidence.push(gateway.record("posting", { document, ...row }, { subject }));
    }
  }
  if (vouchComplete) {
    // "These are all the postings I hold for this invoice." Only this lets a
    // contract conclude that there is none.
    evidence.push(gateway.complete("posting", { subject }));
  }
  return evidence;
}

// --- the agent's own key: authorized for its runtime, and nothing else -------

const AGENT_SIGNER = new Ed25519Signer({ keyId: "invoice-agent-runtime-1", seed: seed(12) });
const AGENT_AUTHORITY = new SigningAuthority({
  keyId: "invoice-agent-runtime-1",
  issuer: AGENT.id,
  tenant: TENANT,
  sources: ["agent-runtime"],
});

// --- the relying party's registry, composed by the relying party -------------

const RELYING_PARTY_TRUST = TrustRegistry.fromKeys([
  GATEWAY_AUTHORITY.trustedKey(GATEWAY_SIGNER.publicKey, { validFrom: VALID_FROM }),
  AGENT_AUTHORITY.trustedKey(AGENT_SIGNER.publicKey, { validFrom: VALID_FROM }),
]);

async function scenario(
  title: string,
  erp: SimulatedErp,
  options: { gatewayReports: boolean; vouch: boolean },
): Promise<void> {
  console.log(`\n=== ${title} ===`);
  const postInvoice = makeTool(erp);
  const session = new WorkSession({ agent: AGENT, tenant: TENANT });
  const issued = await session.run(async () => {
    const answer = await session.turn(() => postInvoice("INV-123", 125_000));
    console.log(`agent reports          ${answer.status} (${answer.document})`);
    const [work] = session.works;
    if (work === undefined) {
      throw new Error("the tool opened no work");
    }
    console.log(`work after the tool    ${work.state}: nothing is established yet`);

    // The agent may sign its own trace. It is authentic and it is still only
    // the agent's word; the contract asks the ERP.
    const agentRuntime = new EvidenceSource({
      system: "agent-runtime",
      authority: AGENT_AUTHORITY,
      signer: AGENT_SIGNER,
    });
    work.attach(session.traceEvidence(agentRuntime));
    if (options.gatewayReports) {
      work.attach(...observeErp(erp, "INV-123", options.vouch));
    }
    work.claim();
    return work.issue({ trust: RELYING_PARTY_TRUST });
  });

  // A third party, later, with only the package and its own registry.
  const result = new Verifier({
    trust: RELYING_PARTY_TRUST,
    expect: { tenant: TENANT, contract: CONTRACT },
  }).verify(issued.package);
  console.log(`verification           ${result.verificationStatus}`);
  console.log(`decision reproduced    ${result.decision}`);
  for (const requirement of result.requirements) {
    console.log(`  ${requirement.id.padEnd(20)} ${requirement.value}`);
  }
  console.log(
    `ignored records        ${result.ignored.length} (authentic, but not from an accepted source)`,
  );
  try {
    result.requireSupported();
    console.log("requireSupported()     passed");
  } catch (error) {
    if (!(error instanceof RequirementNotMet)) {
      throw error;
    }
    console.log(`requireSupported()     refused: ${error.message}`);
  }
}

function impersonation(): void {
  console.log("\n=== The agent tries to sign as the ERP ===");
  try {
    new EvidenceSource({ system: "erp", authority: AGENT_AUTHORITY, signer: AGENT_SIGNER });
  } catch (error) {
    console.log(`refused locally        ${(error as Error).name}: ${(error as Error).message}`);
  }

  // A process that lies about its authority gets past the local guard. It
  // does not get past the relying party's registry.
  const lying = new SigningAuthority({
    keyId: "invoice-agent-runtime-1",
    issuer: AGENT.id,
    tenant: TENANT,
    sources: ["erp"],
  });
  const forged = new EvidenceSource({
    system: "erp",
    authority: lying,
    signer: AGENT_SIGNER,
  }).record(
    "posting",
    { document: "DOC-INV-123", invoice: "INV-123", amount: 125_000 },
    { subject: { system: "erp", kind: "invoice", key: "INV-123" } },
  );
  const work = Work.begin({
    contract: CONTRACT,
    tenant: TENANT,
    claimant: AGENT,
    inputs: { invoice: "INV-123" },
  });
  work.attach(forged).claim();
  try {
    work.issue({ trust: RELYING_PARTY_TRUST });
  } catch (error) {
    if (!(error instanceof AssemblyError)) {
      throw error;
    }
    console.log(`refused by the registry ${error.message}`);
  }
}

await scenario("1. The ERP posted it, and the gateway saw it", new SimulatedErp(), {
  gatewayReports: true,
  vouch: true,
});
await scenario("2. Only the agent's word: no evidence from the ERP", new SimulatedErp(), {
  gatewayReports: false,
  vouch: false,
});
await scenario(
  "3. The ERP dropped the posting, and says its listing is complete",
  new SimulatedErp(true),
  { gatewayReports: true, vouch: true },
);
impersonation();
