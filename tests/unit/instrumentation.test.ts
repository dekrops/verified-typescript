// SPDX-License-Identifier: Apache-2.0

// Instrumentation records execution. It never turns execution into evidence.

import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, test } from "vitest";

import { Decision, EvidenceKind, LifecycleError, Verifier, WorkState } from "../../src/index.js";
import {
  contentDigest,
  EventKind,
  type Scope,
  type TraceEvent,
  verifiedTool,
  WorkSession,
} from "../../src/instrumentation/index.js";
import { readContract } from "../../src/node.js";
import { CONTRACTS, Parties } from "../helpers.js";

const kinds = (session: WorkSession): string[] => session.events.map((event) => event.kind);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

class ConnectionError extends Error {}

test("a tool returning is not recorded as success", () => {
  const parties = new Parties();
  const postInvoice = verifiedTool(
    {
      workType: "invoice.post",
      contract: parties.contract,
      inputs: (invoiceId: string) => ({ invoice: invoiceId }),
    },
    (_invoiceId: string): string => "posted",
  );

  const session = new WorkSession({
    agent: parties.agent,
    tenant: parties.tenant,
    clock: parties.clock,
  });
  const work = session.run(() => {
    expect(postInvoice("INV-1")).toBe("posted");
    const [opened] = session.works;
    expect(session.works).toHaveLength(1);
    expect(opened?.state).toBe(WorkState.OPEN);
    expect(opened?.evidence).toEqual([]);
    expect(opened?.issued).toBeUndefined();
    return opened;
  });
  expect(kinds(session)).toEqual([
    "session_started",
    "work_begun",
    "tool_started",
    "tool_finished",
    "session_ended",
  ]);
  const finished = session.events[3] as TraceEvent;
  expect(JSON.stringify(finished.attributes)).not.toContain("posted");
  expect(decode(session.exportTrace().toBytes())).not.toContain("success");
  expect(session.events[2]?.attributes["claim"]).toBe(work?.claimId);

  // Evaluated with nothing but the tool's word, the claim is undetermined.
  work?.claim();
  expect(work?.issue({ trust: parties.trust }).decision).toBe(Decision.UNDETERMINED);
});

test("async tools and error paths", async () => {
  const parties = new Parties();
  const postInvoice = verifiedTool(
    {
      workType: "invoice.post",
      contract: () => readContract(join(CONTRACTS, "invoice-posting.json")),
      inputs: (invoiceId: string) => ({ invoice: invoiceId }),
    },
    async (invoiceId: string): Promise<string> => {
      await sleep(0);
      if (invoiceId === "INV-BAD") {
        throw new ConnectionError("erp.internal:8443 refused, token=secret");
      }
      return "ok";
    },
  );

  const session = new WorkSession({ agent: parties.agent, tenant: parties.tenant });
  let turn: Scope | undefined;
  await session.run(() =>
    session.turn(async (scope) => {
      turn = scope;
      expect(await postInvoice("INV-1")).toBe("ok");
      await expect(postInvoice("INV-BAD")).rejects.toBeInstanceOf(ConnectionError);
    }),
  );
  expect(turn?.correlationId).toBeTruthy();
  expect(turn?.name).toBe(`${session.sessionId}#1`);

  const failed = session.events.filter((event) => event.kind === EventKind.TOOL_FAILED);
  expect(failed).toHaveLength(1);
  // The error's type is recorded; its message, which may hold secrets, is not.
  expect(failed[0]?.attributes["error"]).toBe("ConnectionError");
  expect(decode(session.exportTrace().toBytes())).not.toContain("secret");
  expect(failed[0]?.turn).toBe(`${session.sessionId}#1`);
  // A failed tool leaves its work open; it is not contradicted by the failure.
  expect(session.works.map((work) => work.state)).toEqual([WorkState.OPEN, WorkState.OPEN]);
  expect(kinds(session).slice(-2)).toEqual(["turn_ended", "session_ended"]);
  // The tool's events lie inside the turn, in order.
  expect(kinds(session).filter((kind) => kind.startsWith("tool_"))).toEqual([
    "tool_started",
    "tool_finished",
    "tool_started",
    "tool_failed",
  ]);
});

test("a synchronous tool that throws is recorded by type and rethrown", () => {
  const parties = new Parties();
  const failing = verifiedTool({ workType: "lookup" }, (): string => {
    throw new RangeError("customer 4711 not found");
  });
  const session = new WorkSession({ agent: parties.agent, tenant: parties.tenant });
  expect(() => session.run(() => failing())).toThrow(RangeError);
  expect(kinds(session)).toEqual([
    "session_started",
    "tool_started",
    "tool_failed",
    "session_ended",
  ]);
  expect(session.events[2]?.attributes).toEqual({ error: "RangeError" });
  expect(session.events[3]?.attributes).toEqual({ error: "RangeError" });
  expect(decode(session.exportTrace().toBytes())).not.toContain("4711");
});

test("something thrown that is not an Error is recorded by its type", () => {
  const parties = new Parties();
  const session = new WorkSession({ agent: parties.agent, tenant: parties.tenant });
  expect(() =>
    session.run(() =>
      session.tool("odd", () => {
        throw "card 4111 1111 1111 1111 declined";
      }),
    ),
  ).toThrow();
  expect(session.events[2]?.attributes).toEqual({ error: "string" });
  expect(decode(session.exportTrace().toBytes())).not.toContain("4111");
});

test("a session that throws still ends and is no longer current", async () => {
  const parties = new Parties();
  const session = new WorkSession({ agent: parties.agent, tenant: parties.tenant });
  class AgentCrashed extends Error {}
  await expect(
    session.run(async (current) => {
      expect(WorkSession.current()).toBe(session);
      expect(current).toBe(session);
      await sleep(0);
      expect(WorkSession.current()).toBe(session);
      throw new AgentCrashed("agent crashed");
    }),
  ).rejects.toBeInstanceOf(AgentCrashed);
  expect(WorkSession.current()).toBeUndefined();
  expect(session.events.at(-1)?.kind).toBe(EventKind.SESSION_ENDED);
  expect(session.events.at(-1)?.attributes).toEqual({ error: "AgentCrashed" });
  expect(() => session.run(() => undefined)).toThrow(LifecycleError);
  expect(() => session.run(() => undefined)).toThrow(/runs once/);
});

test("a session is current only while it runs", () => {
  const parties = new Parties();
  expect(WorkSession.current()).toBeUndefined();
  const session = new WorkSession({ agent: parties.agent, tenant: parties.tenant });
  expect(WorkSession.current()).toBeUndefined();
  expect(session.run(() => WorkSession.current())).toBe(session);
  expect(WorkSession.current()).toBeUndefined();
  expect(session.events.at(-1)?.attributes).toEqual({});
});

test("concurrent sessions do not see each other", async () => {
  const seen = new Map<string, string[]>();
  const lookup = verifiedTool({ workType: "lookup" }, async (_name: string): Promise<string> => {
    await sleep(1);
    const session = WorkSession.current();
    if (session === undefined) {
      throw new Error("no session in this context");
    }
    return session.sessionId;
  });

  const run = async (name: string): Promise<void> => {
    const parties = new Parties(`tenant-${name}`);
    const session = new WorkSession({
      agent: parties.agent,
      tenant: parties.tenant,
      sessionId: name,
    });
    await session.run(async () => {
      const results = await session.turn(() =>
        Promise.all(Array.from({ length: 5 }, () => lookup(name))),
      );
      expect(new Set(results)).toEqual(new Set([name]));
      seen.set(
        name,
        session.events.map((event) => event.sessionId),
      );
    });
    expect(session.events.at(-1)?.kind).toBe(EventKind.SESSION_ENDED);
    expect(session.events.every((event) => event.sessionId === name)).toBe(true);
  };

  await Promise.all(Array.from({ length: 10 }, (_, i) => run(`session-${i}`)));
  expect(seen.size).toBe(10);
  for (const [name, sessions] of seen) {
    expect(new Set(sessions)).toEqual(new Set([name]));
    // Session start, turn start, five tools started and ended, turn end.
    expect(sessions).toHaveLength(1 + 1 + 10 + 1);
  }
  expect(WorkSession.current()).toBeUndefined();
});

test("turns are numbered and scoped", () => {
  const parties = new Parties();
  const session = new WorkSession({
    agent: parties.agent,
    tenant: parties.tenant,
    sessionId: "S-1",
  });
  session.run(() => {
    session.turn(() => session.tool("credit", () => undefined));
    session.emit(EventKind.NOTE, { name: "between turns" });
    session.turn(() => undefined, { turnId: "custom" });
  });
  const named = (kind: EventKind): TraceEvent[] =>
    session.events.filter((event) => event.kind === kind);
  expect(named(EventKind.TURN_STARTED).map((event) => event.name)).toEqual(["S-1#1", "custom"]);
  expect(named(EventKind.TURN_STARTED).map((event) => event.turn)).toEqual(["S-1#1", "custom"]);
  expect(named(EventKind.TURN_ENDED).map((event) => event.turn)).toEqual(["S-1#1", "custom"]);
  expect(named(EventKind.TOOL_STARTED)[0]?.turn).toBe("S-1#1");
  expect(named(EventKind.TOOL_FINISHED)[0]?.turn).toBe("S-1#1");
  expect(named(EventKind.NOTE)[0]?.turn).toBeNull();
  expect(session.events.map((event) => event.sequence)).toEqual(
    session.events.map((_, index) => index),
  );
  // A turn's start and end share a correlation id; so do a tool's.
  for (const [started, ended] of [
    [EventKind.TURN_STARTED, EventKind.TURN_ENDED],
    [EventKind.TOOL_STARTED, EventKind.TOOL_FINISHED],
  ] as const) {
    expect(named(started)[0]?.correlationId).toBe(named(ended)[0]?.correlationId);
    expect(named(started)[0]?.correlationId).toBeTruthy();
  }
});

test("a tool call opened by an adapter is closed once, and only records", () => {
  const parties = new Parties();
  const session = new WorkSession({ agent: parties.agent, tenant: parties.tenant });
  session.run(() => {
    session.turn(() => {
      const first = session.startTool("post_invoice", {
        correlationId: "call_1",
        attributes: { agent: "invoice-agent" },
      });
      const second = session.startTool("post_invoice", { correlationId: "call_2" });
      second.close({ error: new ConnectionError("token=secret") });
      first.close();
      first.close();
      first.close({ error: new Error("late") });
    });
  });
  const tools = session.events.filter((event) => event.kind.startsWith("tool_"));
  expect(tools.map((event) => [event.kind, event.correlationId])).toEqual([
    ["tool_started", "call_1"],
    ["tool_started", "call_2"],
    ["tool_failed", "call_2"],
    ["tool_finished", "call_1"],
  ]);
  expect(tools[0]?.attributes).toEqual({ agent: "invoice-agent" });
  expect(tools[2]?.attributes).toEqual({ error: "ConnectionError" });
  expect(tools.every((event) => event.turn === `${session.sessionId}#1`)).toBe(true);
  expect(session.works).toEqual([]);
});

test("tools outside a session run untouched unless one is required", () => {
  const plain = verifiedTool({ workType: "plain" }, function addOne(x: number): number {
    return x + 1;
  });
  const strict = verifiedTool({ workType: "strict", requireSession: true }, () => undefined);
  expect(plain(1)).toBe(2);
  expect(plain.name).toBe("addOne");
  expect(() => strict()).toThrow(LifecycleError);
  expect(() => strict()).toThrow(/outside a WorkSession/);
  expect(() => verifiedTool({ workType: "x", inputs: () => ({}) }, () => undefined)).toThrow(
    /together/,
  );
  const parties = new Parties();
  expect(() =>
    verifiedTool({ workType: "x", contract: parties.contract }, () => undefined),
  ).toThrow(RangeError);

  // `this` reaches the tool, in and out of a session.
  const counter = {
    count: 41,
    bump: verifiedTool({ workType: "bump" }, function (this: { count: number }): number {
      this.count += 1;
      return this.count;
    }),
  };
  expect(counter.bump()).toBe(42);
  const session = new WorkSession({ agent: "counter", tenant: "tenant-synthetic" });
  expect(session.run(() => counter.bump())).toBe(43);
});

test("a trace is not evidence, and signing it does not make it about the ERP", () => {
  const parties = new Parties();
  const session = new WorkSession({
    agent: parties.agent,
    tenant: parties.tenant,
    clock: parties.clock,
  });
  const { issued, signed } = session.run(() => {
    const work = session.beginWork({ contract: parties.contract, inputs: { invoice: "INV-1" } });
    const trace = session.exportTrace();
    expect(() => work.attach(trace as never)).toThrow(TypeError);
    expect(() => work.attach(trace as never)).toThrow(/not evidence/);

    const statement = session.traceEvidence(parties.agentRuntime);
    expect(statement.kind).toBe(EvidenceKind.AGENT_TRACE);
    expect(statement.source).toBe("agent-runtime");
    expect(statement.keyId).toBe("agent-runtime-1");
    work.attach(statement).claim();
    return { issued: work.issue({ trust: parties.trust }), signed: statement };
  });
  const result = new Verifier({ trust: parties.trust }).verify(issued.package);
  expect(result.decision).toBe(Decision.UNDETERMINED);
  expect(result.ignored).toEqual([`e-${signed.id}`]);
  expect(kinds(session)).toContain("package_issued");
  expect(kinds(session)).toEqual(
    expect.arrayContaining(["work_begun", "evidence_attached", "claim_fixed"]),
  );

  // The gateway's key cannot be borrowed to sign the agent's trace as the ERP's.
  const other = new Parties("another-tenant", 30);
  expect(() => session.traceEvidence(other.agentRuntime)).toThrow(LifecycleError);
  expect(() => session.traceEvidence(other.agentRuntime)).toThrow(/another-tenant/);
});

test("trace context is attached as correlation only", () => {
  const parties = new Parties();
  const otel = (): Record<string, string> => ({
    trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
    span_id: "00f067aa0ba902b7",
  });
  const events: TraceEvent[] = [];
  const session = new WorkSession({
    agent: parties.agent,
    tenant: parties.tenant,
    traceContext: otel,
    onEvent: (event) => events.push(event),
  });
  session.run(() =>
    session.tool("credit", () => undefined, { attributes: { latency: 0.25, retries: 2 } }),
  );
  expect(session.events.every((event) => event.attributes["trace_id"] === otel()["trace_id"])).toBe(
    true,
  );
  // The canonical encoding has no fractions: a fraction is kept as text.
  expect(session.events[1]?.attributes["latency"]).toBe("0.25");
  expect(session.events[1]?.attributes["retries"]).toBe(2);
  expect(events).toEqual([...session.events]);
  expect(session.exportTrace().digest.equals(session.exportTrace().digest)).toBe(true);
  expect(session.exportTrace().toObject()["events"]).toHaveLength(session.events.length);
});

test("an attribute that is not data is refused, not dropped", () => {
  const session = new WorkSession({ agent: "a", tenant: "tenant-synthetic" });
  expect(() => session.emit(EventKind.NOTE, { attributes: { callback: () => undefined } })).toThrow(
    TypeError,
  );
  expect(session.events).toEqual([]);
});

test("content digest keeps text out of evidence", () => {
  const digest = contentDigest("I have credited your account with EUR 40.");
  expect(digest).toMatch(/^sha-256:[0-9a-f]{64}$/);
  expect(contentDigest("I have credited your account with EUR 40.")).toBe(digest);
  expect(contentDigest("I have credited your account with EUR 41.")).not.toBe(digest);
  // SHA-256 of the UTF-8 bytes, as any other tool computes it.
  expect(contentDigest("")).toBe(
    "sha-256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

test("a contract given as a function is read lazily", () => {
  let reads = 0;
  const tool = verifiedTool(
    {
      workType: "x",
      contract: () => {
        reads += 1;
        return readContract(join(CONTRACTS, "missing.json"));
      },
      inputs: () => ({ invoice: "I" }),
    },
    () => undefined,
  );
  tool(); // outside a session nothing is read
  expect(reads).toBe(0);
  const parties = new Parties();
  const session = new WorkSession({ agent: parties.agent, tenant: parties.tenant });
  expect(() => session.run(() => tool())).toThrow(/ENOENT/);
  expect(reads).toBe(1);
  expect(session.works).toEqual([]);
});

test("a contract given as a function is read once", () => {
  let reads = 0;
  const tool = verifiedTool(
    {
      workType: "invoice.post",
      contract: () => {
        reads += 1;
        return readContract(join(CONTRACTS, "invoice-posting.json"));
      },
      inputs: (invoice: string) => ({ invoice }),
    },
    (_invoice: string) => undefined,
  );
  const session = new WorkSession({ agent: "a", tenant: "tenant-synthetic" });
  session.run(() => {
    tool("INV-1");
    tool("INV-2");
  });
  expect(reads).toBe(1);
  expect(session.works.map((work) => work.inputs)).toEqual([
    { invoice: "INV-1" },
    { invoice: "INV-2" },
  ]);
  expect(session.works.map((work) => work.label)).toEqual(["invoice.post", "invoice.post"]);
});
