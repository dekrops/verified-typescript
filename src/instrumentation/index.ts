// SPDX-License-Identifier: Apache-2.0

/**
 * Agent instrumentation: sessions, turns, tools and traces.
 *
 * A separate entry point because it tracks asynchronous context with
 * `node:async_hooks`, which Node.js, Deno, Bun and Cloudflare Workers
 * (`nodejs_compat`) provide and browsers do not.
 *
 * @module
 */

export {
  type Attributes,
  contentDigest,
  type EmitOptions,
  EventKind,
  ExecutionTrace,
  Scope,
  type TraceContext,
  type TraceEvent,
  WorkSession,
  type WorkSessionOptions,
} from "./session.js";
export { type VerifiedToolOptions, verifiedTool } from "./tool.js";
