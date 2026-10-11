// SPDX-License-Identifier: Apache-2.0

// Framework-independent instrumentation for agent tools.

import type { WorkContract } from "../contracts.js";
import { LifecycleError } from "../errors.js";
import type { FieldValue } from "../evidence.js";
import { WorkSession } from "./session.js";

/** What {@link verifiedTool} is given. `contract` and `inputs` go together. */
export interface VerifiedToolOptions<Args extends unknown[]> {
  /** The name the call is recorded under. */
  workType: string;
  /**
   * The contract a call opens work under, or a function returning it, called
   * on the first call and never when the module is loaded.
   */
  contract?: WorkContract | (() => WorkContract) | undefined;
  /** Receives the call's arguments and returns the contract's inputs. */
  inputs?: ((...args: Args) => Readonly<Record<string, FieldValue>>) | undefined;
  /** Make calling the tool outside a session an error. */
  requireSession?: boolean | undefined;
}

/**
 * Instruments a tool an agent calls, for synchronous and asynchronous
 * functions alike.
 *
 * Inside a {@link WorkSession} each call:
 *
 * 1. records that the tool was called and whether it returned or threw,
 *    correlated with the session and turn;
 * 2. if `contract` and `inputs` are given, opens a {@link Work} for the call
 *    and leaves it `open`.
 *
 * That is all. **Returning without an error is not recorded as success**,
 * and no evidence is created: the tool is the agent's own hands, and the
 * agent saying an invoice was posted is not the ERP saying so. The opened
 * work waits for evidence from an identified source; find it in
 * {@link WorkSession.works}.
 *
 * Outside a session the function runs unchanged, unless `requireSession` is
 * set, in which case calling it is an error.
 */
export function verifiedTool<Args extends unknown[], Result>(
  options: VerifiedToolOptions<Args>,
  tool: (...args: Args) => Result,
): (...args: Args) => Result {
  if ((options.contract === undefined) !== (options.inputs === undefined)) {
    throw new RangeError("give contract and inputs together, or neither");
  }
  let loaded: WorkContract | undefined;
  const resolve = (): WorkContract => {
    if (loaded === undefined) {
      const contract = options.contract as WorkContract | (() => WorkContract);
      loaded = typeof contract === "function" ? contract() : contract;
    }
    return loaded;
  };

  const wrapped = function (this: unknown, ...args: Args): Result {
    const session = WorkSession.current();
    if (session === undefined) {
      if (options.requireSession === true) {
        throw new LifecycleError(
          `tool ${JSON.stringify(options.workType)} was called outside a WorkSession, ` +
            "and it requires one",
        );
      }
      return tool.apply(this, args);
    }
    const attributes: Record<string, string> = {};
    if (options.inputs !== undefined) {
      const work = session.beginWork({
        contract: resolve(),
        inputs: options.inputs(...args),
        label: options.workType,
      });
      attributes["claim"] = work.claimId;
    }
    return session.tool(options.workType, () => tool.apply(this, args), { attributes });
  };
  Object.defineProperty(wrapped, "name", { value: tool.name, configurable: true });
  return wrapped;
}
