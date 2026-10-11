# Agent runtime integration

The goal is that adding verifiable work to an agent is as unobtrusive as
adding telemetry, while producing something telemetry cannot: a statement
about the work that a third party can check.

Everything on this page is in `verified-typescript/instrumentation`.

## The instrumentation contract

Everything a framework adapter needs is on `WorkSession`:

| Runtime event | Primitive |
| --- | --- |
| A run starts and ends | `session.run(fn)` |
| A turn or step starts and ends | `session.turn(fn, { turnId })` |
| A tool is called | `session.tool(name, fn, { correlationId })`, or `verifiedTool(options, fn)` |
| A tool call whose start and end arrive as separate callbacks | `const scope = session.startTool(name, …)`, later `scope.close()` |
| Anything else (agent start, handoff, model call) | `session.emit(EventKind.…, { name, attributes })` |
| Work is declared under a contract | `session.beginWork({ contract, inputs })` |
| Evidence arrives from a source | `work.attach(signedEvidence)` |
| The claim is fixed | `work.claim()` |
| The decision is issued | `work.issue({ trust })` |
| The trace is exported | `session.exportTrace()` |
| The runtime signs its own trace | `session.traceEvidence(agentRuntimeSource)` |
| Correlation with an existing tracer | `new WorkSession({ traceContext })` |
| Live events for a sink | `new WorkSession({ onEvent })` |

`run`, `turn` and `tool` take a function that returns a value or a promise.
The span ends when the function returns, when its promise settles, or when it
throws.

`WorkSession.current()` returns the session running in the current
asynchronous context (`AsyncLocalStorage`), which is how `verifiedTool` and
adapters find it without a global registry. Concurrent sessions do not see
each other.

## The line that must not be crossed

```text
 the agent's own account                 │  somebody else's observation
─────────────────────────────────────────┼──────────────────────────────────────
 TraceEvent, ExecutionTrace   (unsigned) │
 a tool's return value                   │  SignedEvidence from an EvidenceSource
 the model's final message               │  whose key the relying party's registry
 session.traceEvidence()  (signed by     │  authorizes for the system of record
   the runtime's own key, AgentTrace)    │
```

Nothing on the left becomes something on the right by being recorded, exported,
signed by the agent, or wrapped in a span.

Concretely, the SDK is built so that:

- `verifiedTool` does not record a return value or the word "success". It
  records that a call started and that it returned or threw.
- A thrown error is recorded by its type only; its message may hold secrets.
- `work.attach` accepts only `SignedEvidence`. Passing a trace, an object or a
  tool result is a `TypeError` that says why.
- `session.traceEvidence` produces an `AgentTrace` statement from the
  runtime's own system. A contract that asks the ERP ignores it, and the
  decision stays `UNDETERMINED`.
- Ending a session issues nothing and verifies nothing.

## The shape of an integration

```ts
import { WorkSession, verifiedTool } from "verified-typescript/instrumentation";

const postInvoice = verifiedTool(
  {
    workType: "invoice.post",
    contract,
    inputs: (invoiceId: string) => ({ invoice: invoiceId }),
  },
  async (invoiceId: string) => erp.post(invoiceId),
);

const session = new WorkSession({ agent: "invoice-agent", tenant: "acme" });
await session.run(() => runAgent({ tools: [postInvoice] }));

for (const work of session.works) {
  // each still open
  work.attach(...(await evidenceFromTheSystemOfRecord(work.inputs)));
  work.claim();
  const issued = work.issue({ trust: issuerRegistry });
  await store(issued.package.text); // the portable artifact
}
```

Where the evidence comes from is the integration's real design question, and
the SDK does not hide it. Usually the evidence source is a separate process
with its own key: a gateway beside the ERP, the tool gateway, the chat
platform. Evidence may arrive long after the run. A `Work` can be kept open
until it does; the trace and the claim identifier correlate the two.

## Turns and sessions

`session.turn(fn)` scopes events to a turn, named `<session>#<n>` by default.
For compliance-style attestation, each turn and the session are **separate
claims under separate contracts**:

```ts
const turnWork = session.beginWork({
  contract: turnContract,
  inputs: { session: sessionId, turn: turnId },
});
const sessionWork = session.beginWork({
  contract: sessionContract,
  inputs: { session: sessionId },
});
```

The session's decision comes from evaluating the session contract against the
session's evidence. It is not computed from the turn decisions, and the SDK
offers no function that would do so.

The protocol does not bind a turn claim to its session claim. That binding is
by convention (shared `session` input, shared evidence), and an application
that needs a checked binding must build one.

`contentDigest(text)` gives a `sha-256:` reference for a message, so that a
chat platform can sign *that a turn with this content happened* without the
text entering evidence. Evidence is disclosed in full to whoever holds a
package.

## Asynchronous context, and where it ends

`AsyncLocalStorage` follows promises, timers and `async` functions started
inside `session.run`. It does not follow work handed to another thread or
process, and a library that queues callbacks on its own and runs them later
may run them outside the context. A tool called there sees no session:
`verifiedTool` then runs the function unchanged, or throws if
`requireSession` is set. An adapter that hits this holds the session itself
and calls its methods directly, which is why every primitive is a method on
the session and not a free function.

`node:async_hooks` exists in Node.js, Deno, Bun and Cloudflare Workers (with
`nodejs_compat`). It does not exist in browsers. Only Node.js is tested.

## Framework adapters

None is included. The generic primitives are the whole of this release.

| Framework | Hook surface | State |
| --- | --- | --- |
| Generic callbacks | none needed; `WorkSession` is the adapter | Included (`verifiedTool`) |
| OpenAI Agents SDK (JavaScript) | run and agent lifecycle events, tool start and end | Not built |
| Vercel AI SDK | tool `execute`, step callbacks | Not built |
| LangGraph.js | callback handlers, as in the Python adapter | Not built |

An adapter is listed here as included only once it has tests against the real
framework, with a scripted model and no network. `verified-python` has two
built that way; they are the model for these.

## OpenTelemetry

Observability is not verification. A span is the runtime describing itself;
it is on the left side of the line above, however detailed it is.

The mapping between the two worlds is explicit and one-directional:

| OpenTelemetry | This SDK | Relationship |
| --- | --- | --- |
| trace id, span id | attributes on every `TraceEvent` | Correlation only. Supplied by `traceContext`; never trusted |
| a span for a tool call | `tool_started` / `tool_finished` / `tool_failed` | The same fact, recorded twice |
| span attributes, GenAI semantic conventions | `TraceEvent.attributes` | May be copied by the caller. They stay telemetry |
| an exported trace | `ExecutionTrace` | Unsigned. Its digest can be committed to by a signed `AgentTrace` statement |
| (nothing) | `Claim` | Spans make no claims |
| (nothing) | `SignedEvidence` from a system of record | Cannot be derived from a span |
| (nothing) | `VerificationResult` | Cannot be derived from a span |

To correlate, pass a function that returns the active identifiers. The SDK
does not import OpenTelemetry:

```ts
import { trace } from "@opentelemetry/api";

const session = new WorkSession({
  agent: "invoice-agent",
  tenant: "acme",
  traceContext: () => {
    const context = trace.getActiveSpan()?.spanContext();
    return context ? { trace_id: context.traceId, span_id: context.spanId } : {};
  },
});
```

In the other direction, put the claim identifier and, once known, the package
identifier on your spans as attributes, so that an engineer looking at a
trace can find the package that says what the work amounted to.

A fractional attribute value is recorded as text, because the canonical
encoding has no fractions.

There is no exporter that turns spans into evidence, and there will not be one.
