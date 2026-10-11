// SPDX-License-Identifier: Apache-2.0

/**
 * Instrumenting an agent runtime, without changing how it runs.
 *
 * A {@link WorkSession} records what an agent runtime did: sessions, turns,
 * tool calls, and the work items it opened. It imposes no worker model or
 * tracing backend, and works the same for synchronous and asynchronous
 * functions.
 *
 * What a session records is an **execution trace**: the executor's own
 * account of itself. It is useful for correlation and debugging, and it is
 * not evidence. Three separate things can come out of a session, and they
 * must not be confused:
 *
 * - {@link WorkSession.exportTrace}: an unsigned trace. Telemetry.
 *   Establishes nothing.
 * - {@link WorkSession.traceEvidence}: a statement signed with the *agent
 *   runtime's own* key, of kind `AgentTrace`, committing to the trace.
 *   Authentic if the registry lists that key; it still only says what the
 *   agent says. A contract that asks the ERP will ignore it.
 * - {@link Work}: a claim with independently sourced evidence, issued as a
 *   package and verified by a relying party.
 *
 * @module
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { call, encode, type Json, type JsonObject } from "../bridge.js";
import { utf8 } from "../bytes.js";
import { Digest } from "../canonical.js";
import type { WorkContract } from "../contracts.js";
import { LifecycleError } from "../errors.js";
import {
  EvidenceKind,
  type EvidenceSource,
  type FieldValue,
  type SignedEvidence,
} from "../evidence.js";
import { type Clock, instant, now } from "../time.js";
import { randomUuid } from "../uuid.js";
import { AgentIdentity, Work } from "../work.js";

const TRACE_FORMAT = "verified-typescript-execution-trace-1";

/** Attributes merged into every event, for correlation with an existing tracer. */
export type TraceContext = () => Readonly<Record<string, string>>;

/** What happened, in a vocabulary every agent framework can map onto. */
export const EventKind = {
  SESSION_STARTED: "session_started",
  SESSION_ENDED: "session_ended",
  TURN_STARTED: "turn_started",
  TURN_ENDED: "turn_ended",
  TOOL_STARTED: "tool_started",
  TOOL_FINISHED: "tool_finished",
  TOOL_FAILED: "tool_failed",
  AGENT_STARTED: "agent_started",
  AGENT_ENDED: "agent_ended",
  WORK_BEGUN: "work_begun",
  EVIDENCE_ATTACHED: "evidence_attached",
  CLAIM_FIXED: "claim_fixed",
  PACKAGE_ISSUED: "package_issued",
  NOTE: "note",
} as const;
export type EventKind = (typeof EventKind)[keyof typeof EventKind];

/** Free-form attributes of an event. */
export type Attributes = Readonly<Record<string, unknown>>;

function attribute(value: unknown, where: string): Json {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    // The canonical encoding has no fractions. Telemetry often does.
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => attribute(item, where));
  }
  if (value !== null && typeof value === "object") {
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = attribute(item, `${where}.${key}`);
    }
    return out;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  throw new TypeError(`${where}: ${typeof value} is not a JSON value`);
}

/** One thing a runtime reported about its own execution. */
export interface TraceEvent {
  readonly sequence: number;
  readonly kind: EventKind;
  readonly at: string;
  readonly sessionId: string;
  readonly turn: string | null;
  readonly name: string | null;
  readonly correlationId: string | null;
  readonly attributes: Readonly<JsonObject>;
}

/**
 * An unsigned record of what a runtime says it did.
 *
 * **Not evidence, and not a verification artifact.** Nobody signed it and
 * nothing in it was observed by anyone but the executor. Its digest lets a
 * signed statement commit to it, and lets a reader check they hold the same
 * trace; it does not make the trace true.
 */
export class ExecutionTrace {
  readonly sessionId: string;
  readonly tenant: string;
  readonly agent: string;
  readonly events: readonly TraceEvent[];

  /** @internal Use {@link WorkSession.exportTrace}. */
  constructor(sessionId: string, tenant: string, agent: string, events: readonly TraceEvent[]) {
    this.sessionId = sessionId;
    this.tenant = tenant;
    this.agent = agent;
    this.events = events;
    Object.freeze(this);
  }

  toObject(): JsonObject {
    return {
      format: TRACE_FORMAT,
      sessionId: this.sessionId,
      tenant: this.tenant,
      agent: this.agent,
      events: this.events.map((event) => ({ ...event, attributes: { ...event.attributes } })),
    };
  }

  /** The trace's canonical text. */
  toBytes(): Uint8Array {
    const input = encode(this.toObject(), "trace");
    return utf8(call((native) => native.canonicalize(input)));
  }

  get digest(): Digest {
    return Digest.ofJson(this.toObject());
  }
}

/**
 * `sha-256:<hex>` of a text, for referring to content without carrying it.
 *
 * Evidence is disclosed in full to whoever holds a package. Sign a digest of
 * a message, not the message, when its text should stay where it is.
 */
export function contentDigest(content: string): string {
  return Digest.ofBytes(utf8(content)).toString();
}

function errorName(error: unknown): string {
  if (error instanceof Error) {
    return error.constructor.name || error.name;
  }
  return typeof error;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Runs `body`, then `done` exactly once: after it returns, after the promise
 * it returns settles, or when it throws.
 */
function around<T>(body: () => T, done: (failed: boolean, error?: unknown) => void): T {
  let result: T;
  try {
    result = body();
  } catch (error) {
    done(true, error);
    throw error;
  }
  if (isThenable(result)) {
    return Promise.resolve(result).then(
      (value) => {
        done(false);
        return value;
      },
      (error: unknown) => {
        done(true, error);
        throw error;
      },
    ) as T;
  }
  done(false);
  return result;
}

/**
 * A turn or a tool call that is still open.
 *
 * `name` is the turn's identifier or the tool's name; `correlationId` ties
 * the start and end events together.
 */
export class Scope {
  readonly name: string;
  readonly correlationId: string;
  readonly #session: WorkSession;
  readonly #ended: EventKind;
  readonly #failed: EventKind;
  readonly #turn: string | null;
  #closed = false;

  /** @internal Use {@link WorkSession.turn}, {@link WorkSession.tool} or {@link WorkSession.startTool}. */
  constructor(
    session: WorkSession,
    kinds: { started: EventKind; ended: EventKind; failed: EventKind },
    name: string,
    correlationId: string,
    attributes: Attributes,
    turn: string | null,
  ) {
    this.#session = session;
    this.#ended = kinds.ended;
    this.#failed = kinds.failed;
    this.#turn = turn;
    this.name = name;
    this.correlationId = correlationId;
    session.emit(kinds.started, { name, correlationId, attributes, turn });
  }

  /**
   * Ends the span. Pass what was thrown, if anything was: it is recorded by
   * type only, because its message may hold data that does not belong in a
   * trace. Closing twice records once.
   */
  close(failure?: { error: unknown }, attributes: Attributes = {}): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const base = { name: this.name, correlationId: this.correlationId, turn: this.#turn };
    if (failure === undefined) {
      this.#session.emit(this.#ended, { ...base, attributes });
    } else {
      this.#session.emit(this.#failed, {
        ...base,
        attributes: { ...attributes, error: errorName(failure.error) },
      });
    }
  }
}

const SESSIONS = new AsyncLocalStorage<WorkSession>();
const TURNS = new AsyncLocalStorage<string>();

/** What a {@link WorkSession} is constructed with. */
export interface WorkSessionOptions {
  agent: AgentIdentity | string;
  tenant: string;
  sessionId?: string | undefined;
  clock?: Clock | undefined;
  /** Called with every event as it is recorded. */
  onEvent?: ((event: TraceEvent) => void) | undefined;
  traceContext?: TraceContext | undefined;
}

/** What one event carries. */
export interface EmitOptions {
  name?: string | undefined;
  correlationId?: string | undefined;
  attributes?: Attributes | undefined;
  /** The turn the event belongs to. The current turn by default. */
  turn?: string | null | undefined;
}

/**
 * One run of an agent, as its runtime reports it.
 *
 * Run the agent inside {@link run}. While it runs, the session is the
 * current session of that asynchronous context, which is how
 * {@link verifiedTool} and framework adapters find it; concurrent sessions
 * do not see each other.
 *
 * A session never issues or verifies anything by ending. Work opened through
 * {@link beginWork} stays in whatever state it reached.
 */
export class WorkSession {
  readonly agent: AgentIdentity;
  readonly tenant: string;
  readonly sessionId: string;
  readonly #clock: Clock;
  readonly #onEvent: ((event: TraceEvent) => void) | undefined;
  readonly #traceContext: TraceContext | undefined;
  readonly #events: TraceEvent[] = [];
  readonly #works: Work[] = [];
  #turns = 0;
  #started = false;

  constructor(options: WorkSessionOptions) {
    this.agent =
      options.agent instanceof AgentIdentity ? options.agent : new AgentIdentity(options.agent);
    this.tenant = options.tenant;
    this.sessionId = options.sessionId ?? randomUuid();
    this.#clock = options.clock ?? now;
    this.#onEvent = options.onEvent;
    this.#traceContext = options.traceContext;
  }

  /** The session running in this asynchronous context, if any. */
  static current(): WorkSession | undefined {
    return SESSIONS.getStore();
  }

  // -- recording ------------------------------------------------------------

  /** Records one event. The primitive framework adapters build on. */
  emit(kind: EventKind, options: EmitOptions = {}): TraceEvent {
    const merged = { ...this.#traceContext?.(), ...options.attributes };
    const attributes: JsonObject = {};
    for (const [key, value] of Object.entries(merged)) {
      attributes[key] = attribute(value, key);
    }
    const event: TraceEvent = Object.freeze({
      sequence: this.#events.length,
      kind,
      at: instant(this.#clock()),
      sessionId: this.sessionId,
      turn: options.turn === undefined ? (TURNS.getStore() ?? null) : options.turn,
      name: options.name ?? null,
      correlationId: options.correlationId ?? null,
      attributes: Object.freeze(attributes),
    });
    this.#events.push(event);
    this.#onEvent?.(event);
    return event;
  }

  /**
   * Runs the agent inside this session. `body` may be synchronous or return
   * a promise; the session ends when it returns, settles or throws.
   *
   * A session runs once; start a new one for a new run.
   */
  run<T>(body: (session: this) => T): T {
    if (this.#started) {
      throw new LifecycleError("a session runs once; start a new one for a new run");
    }
    this.#started = true;
    return SESSIONS.run(this, () => {
      this.emit(EventKind.SESSION_STARTED, { name: this.agent.name });
      return around(
        () => body(this),
        (failed, error) => {
          this.emit(EventKind.SESSION_ENDED, {
            name: this.agent.name,
            attributes: failed ? { error: errorName(error) } : {},
          });
        },
      );
    });
  }

  /**
   * Runs one turn: one exchange within the session.
   *
   * The default identifier is `<session>#<n>`, counting from 1.
   */
  turn<T>(body: (turn: Scope) => T, options: { turnId?: string; attributes?: Attributes } = {}): T {
    this.#turns += 1;
    const name = options.turnId ?? `${this.sessionId}#${this.#turns}`;
    const scope = new Scope(
      this,
      {
        started: EventKind.TURN_STARTED,
        ended: EventKind.TURN_ENDED,
        failed: EventKind.TURN_ENDED,
      },
      name,
      randomUuid(),
      options.attributes ?? {},
      name,
    );
    return TURNS.run(name, () =>
      around(
        () => body(scope),
        (failed, error) => scope.close(failed ? { error } : undefined),
      ),
    );
  }

  /**
   * Opens a tool call and returns it open, for adapters whose framework
   * reports the start and the end of a call separately. Close it with
   * {@link Scope.close}.
   */
  startTool(
    name: string,
    options: { correlationId?: string | undefined; attributes?: Attributes | undefined } = {},
  ): Scope {
    return new Scope(
      this,
      {
        started: EventKind.TOOL_STARTED,
        ended: EventKind.TOOL_FINISHED,
        failed: EventKind.TOOL_FAILED,
      },
      name,
      options.correlationId ?? randomUuid(),
      options.attributes ?? {},
      TURNS.getStore() ?? null,
    );
  }

  /**
   * Runs a tool call. When `body` returns or throws, that is recorded;
   * neither says the operation took effect.
   */
  tool<T>(
    name: string,
    body: () => T,
    options: { correlationId?: string | undefined; attributes?: Attributes | undefined } = {},
  ): T {
    const scope = this.startTool(name, options);
    return around(body, (failed, error) => scope.close(failed ? { error } : undefined));
  }

  // -- work -----------------------------------------------------------------

  /**
   * Declares work under a contract, associated with this session.
   *
   * The work starts `open` and stays so until evidence from identified
   * sources is attached and a claim is fixed. The session records the work's
   * transitions in its trace.
   */
  beginWork(options: {
    contract: WorkContract;
    inputs: Readonly<Record<string, FieldValue>>;
    claimant?: AgentIdentity | string | undefined;
    label?: string | undefined;
  }): Work {
    const correlationId = randomUuid();
    const work = Work.begin({
      contract: options.contract,
      tenant: this.tenant,
      claimant: options.claimant ?? this.agent,
      inputs: options.inputs,
      clock: this.#clock,
      label: options.label,
      observer: (event, item, attributes) => {
        this.emit(event as EventKind, {
          name: item.label,
          correlationId,
          attributes: { claim: item.claimId, ...attributes },
        });
      },
    });
    this.#works.push(work);
    return work;
  }

  /** The work items opened in this session, in order. */
  get works(): readonly Work[] {
    return [...this.#works];
  }

  // -- output ---------------------------------------------------------------

  get events(): readonly TraceEvent[] {
    return [...this.#events];
  }

  /** The session's execution trace: unsigned telemetry, not evidence. */
  exportTrace(): ExecutionTrace {
    return new ExecutionTrace(this.sessionId, this.tenant, this.agent.id, this.events);
  }

  /**
   * Signs the trace as the agent runtime's own statement.
   *
   * The statement is of kind `AgentTrace`, from `source`, whose key must be
   * the agent runtime's own. It commits to the trace by digest and says only
   * that this runtime reports this trace. A relying party that trusts the
   * key learns who produced the trace and that it was not altered. It does
   * not learn that anything in it happened.
   */
  traceEvidence(source: EvidenceSource, options: { recordKind?: string } = {}): SignedEvidence {
    if (source.authority.tenant !== this.tenant) {
      throw new LifecycleError(
        `the source signs for tenant ${JSON.stringify(source.authority.tenant)}, ` +
          `and this session is tenant ${JSON.stringify(this.tenant)}`,
      );
    }
    const trace = this.exportTrace();
    return source.record(
      options.recordKind ?? "agent_trace",
      {
        session: this.sessionId,
        agent: this.agent.id,
        trace: trace.digest.toString(),
        events: trace.events.length,
      },
      {
        subject: { system: source.system, kind: "session", key: this.sessionId },
        evidenceKind: EvidenceKind.AGENT_TRACE,
        observationId: `${source.system}:trace:${this.sessionId}`,
      },
    );
  }

  toString(): string {
    return (
      `WorkSession(${this.sessionId}, agent ${JSON.stringify(this.agent.name)}, ` +
      `${this.#events.length} events)`
    );
  }
}
