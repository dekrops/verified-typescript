# 0003. Three entry points

Status: accepted.

## Context

JavaScript runs in places with different capabilities. Verification needs
only WebAssembly. Finding "the current session" from inside a tool needs
asynchronous context tracking, which is `AsyncLocalStorage` from
`node:async_hooks`: present in Node.js, Deno, Bun and Cloudflare Workers
(with `nodejs_compat`), absent in browsers. Reading a file needs `node:fs`.

A single entry point that imports all three would make verification fail to
load in a browser for the sake of features a browser never uses.

## Decision

| Import | Holds | Imports |
| --- | --- | --- |
| `verified-typescript` | Verification, trust, contracts, evidence, signing, the work lifecycle, work-unit identity | Nothing but the module |
| `verified-typescript/instrumentation` | `WorkSession`, `verifiedTool`, traces | `node:async_hooks` |
| `verified-typescript/node` | `readTrustRegistry`, `readContract`, `readPackage`, `writePackage`, `readWorkRecord`, `writeWorkRecord` | `node:fs` |

The core types take and return bytes or strings. `TrustRegistry.fromJson`,
`WorkContract.fromJson` and `new WorkPackage(text)` have no path overloads.

## Consequences

- A path is never mistaken for package text. `verifier.verify(value)` takes a
  `WorkPackage`, bytes, or the package text as a string. A file goes through
  `readPackage`, which also strips the one line end a file ends with.
- A verify-only user in a browser loads no Node.js module.
- Three imports to learn instead of one.

## Would change if

`AsyncContext` reaches the language. Instrumentation could then move into the
core entry point.
