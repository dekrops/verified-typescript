// A support chatbot under two policies, attested per turn and per session.
//
// Run with:  node examples/chatbot-compliance/support-chatbot.ts
//
// Policies (synthetic):
//
// - a credit must not exceed EUR 100.00 in one turn;
// - credits must not exceed EUR 150.00 in one session.
//
// Each agent turn gets its own claim under the *turn* contract. The session
// gets one claim under the *session* contract. The session claim is
// evaluated on its own evidence: it is not the sum, the conjunction or any
// other function of the turn decisions. The example shows it both ways round.
//
// This example carries no compliance logic. The rules are in the two
// contract files; the shared evaluator applies them. Mapping a decision to
// "compliant" or "in breach", wording reasons and deciding what to do about
// it belong to an application such as Agent Compliance Center.
//
// Two things worth knowing about the contract language:
//
// - It has no arithmetic. A session total cannot be computed by the
//   contract; it is a value the tool gateway reports (`sessionTotal`) and
//   stands or falls with that source.
// - "No credit exceeded the limit" is a statement about *all* credits, and
//   can only be concluded when the tool gateway declares its listing
//   complete. If the gateway is unreachable, the answer is `UNDETERMINED`,
//   not "fine".

import { fileURLToPath } from "node:url";

import {
  AgentIdentity,
  Ed25519Signer,
  EvidenceKind,
  EvidenceSource,
  type JsonObject,
  type SignedEvidence,
  SigningAuthority,
  type Subject,
  TrustRegistry,
  Verifier,
  type Work,
  type WorkContract,
} from "verified-typescript";
import { contentDigest, verifiedTool, WorkSession } from "verified-typescript/instrumentation";
import { readContract } from "verified-typescript/node";

const TENANT = "acme-synthetic";
const contract = (name: string): WorkContract =>
  readContract(fileURLToPath(new URL(`../contracts/${name}.json`, import.meta.url)));
const TURN_CONTRACT = contract("support-chatbot-turn");
const SESSION_CONTRACT = contract("support-chatbot-session");
const AGENT = new AgentIdentity("support-agent", { version: "3" });

/**
 * An independent source with its own key, and the registry record a relying
 * party would hold for it.
 */
function source(system: string, seed: number): { source: EvidenceSource; key: JsonObject } {
  const signer = new Ed25519Signer({ keyId: `${system}-1`, seed: new Uint8Array(32).fill(seed) });
  const authority = new SigningAuthority({
    keyId: signer.keyId,
    issuer: `00000000-0000-4000-8000-0000000000${seed.toString(16).padStart(2, "0")}`,
    tenant: TENANT,
    sources: [system],
  });
  return {
    source: new EvidenceSource({ system, authority, signer }),
    key: authority.trustedKey(signer.publicKey, { validFrom: "2026-01-01T00:00:00Z" }),
  };
}

const chatPlatform = source("chat-platform", 21);
const toolGateway = source("tool-gateway", 22);
const TRUST = TrustRegistry.fromKeys([chatPlatform.key, toolGateway.key]);

interface Credit {
  id: string;
  session: string;
  turn: string;
  amount: number;
  sessionTotal: number;
}

/**
 * The system through which credits are actually issued. It keeps the ledger
 * of credits and signs what it holds; the agent does neither.
 */
class ToolGateway {
  readonly reachable: boolean;
  readonly credits: Credit[] = [];

  constructor(reachable = true) {
    this.reachable = reachable;
  }

  issueCredit(session: string, turn: string, cents: number): void {
    const before = this.credits
      .filter((credit) => credit.session === session)
      .reduce((sum, credit) => sum + credit.amount, 0);
    this.credits.push({
      id: `CR-${this.credits.length + 1}`,
      session,
      turn,
      amount: cents,
      sessionTotal: before + cents,
    });
  }

  /**
   * Signed credits for a session (or one turn of it), with a statement that
   * the listing is complete. An unreachable gateway says nothing.
   */
  evidence(session: string, turn?: string): SignedEvidence[] {
    if (!this.reachable) {
      return [];
    }
    const subject: Subject = { system: "support-chat", kind: "session", key: session };
    const signed = this.credits
      .filter(
        (credit) => credit.session === session && (turn === undefined || credit.turn === turn),
      )
      .map((credit) =>
        toolGateway.source.record(
          "credit",
          { ...credit },
          { subject, evidenceKind: EvidenceKind.API_RESPONSE },
        ),
      );
    return [...signed, toolGateway.source.complete("credit", { subject })];
  }
}

function runSession(
  title: string,
  script: [reply: string, credit: number | null][],
  gateway: ToolGateway,
): void {
  console.log(`\n=== ${title} ===`);
  const session = new WorkSession({ agent: AGENT, tenant: TENANT });
  const sid = session.sessionId;
  const issueCredit = verifiedTool({ workType: "credit.issue" }, (turn: string, cents: number) => {
    gateway.issueCredit(sid, turn, cents);
    return "credited";
  });

  const claims: [name: string, work: Work, contract: WorkContract][] = [];
  session.run(() => {
    script.forEach(([reply, credit], index) => {
      const turnId = session.turn((turn) => {
        if (credit !== null) {
          issueCredit(turn.name, credit);
        }
        return turn.name;
      });
      // The chat platform, not the agent, records that the turn happened. It
      // signs a digest of the reply; the text stays where it is.
      const turnRecord = chatPlatform.source.record(
        "turn",
        { id: turnId, session: sid, content: contentDigest(reply) },
        { subject: { system: "support-chat", kind: "turn", key: turnId } },
      );
      const work = session.beginWork({
        contract: TURN_CONTRACT,
        inputs: { session: sid, turn: turnId },
        label: "turn",
      });
      work.attach(turnRecord, ...gateway.evidence(sid, turnId));
      claims.push([`turn ${index + 1}`, work, TURN_CONTRACT]);
    });

    const sessionWork = session.beginWork({
      contract: SESSION_CONTRACT,
      inputs: { session: sid },
      label: "session",
    });
    sessionWork.attach(
      chatPlatform.source.record(
        "session",
        { id: sid, turns: script.length },
        { subject: { system: "support-chat", kind: "session", key: sid } },
      ),
      ...gateway.evidence(sid),
    );
    claims.push(["session", sessionWork, SESSION_CONTRACT]);
  });

  for (const [name, work, expected] of claims) {
    work.claim();
    const issued = work.issue({ trust: TRUST });
    const result = new Verifier({
      trust: TRUST,
      expect: { tenant: TENANT, contract: expected },
    }).verify(issued.package);
    const values = result.requirements.map((r) => `${r.id}=${r.value}`).join(", ");
    console.log(
      `${name.padEnd(8)} ${result.verificationStatus.padEnd(9)} ${String(result.decision).padEnd(13)} ${values}`,
    );
  }
}

runSession(
  "A. Every turn within its limit; the session over its limit",
  [
    ["Credited EUR 60.", 6_000],
    ["Another EUR 60.", 6_000],
    ["And EUR 40.", 4_000],
  ],
  new ToolGateway(),
);
runSession(
  "B. One turn over its limit; the session within its limit",
  [
    ["Hello.", null],
    ["Credited EUR 120.", 12_000],
  ],
  new ToolGateway(),
);
runSession(
  "C. The tool gateway cannot be reached: nothing is concluded",
  [["Credited EUR 20.", 2_000]],
  new ToolGateway(false),
);
