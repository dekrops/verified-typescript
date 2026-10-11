# Architecture overview

`verified-typescript` is an idiomatic TypeScript API over a narrowly scoped
WebAssembly module compiled from Rust. The TypeScript side owns developer
experience; the Rust side owns every rule of the protocol.

```text
        WVP specifications and vectors            dekrops/wvp (normative)
                      │
        Rust verification crates                  dekrops/verified-cli, pinned
   canonical · protocol · contract · verifier · work-unit
                      │
        src/native  (wasm-bindgen)                rust/  — bytes and JSON text in, JSON text out
                      │
        verified-typescript  (TypeScript)         src/
   ┌──────────────┬───────────────┬──────────────────────────┐
   │ verification │ evidence      │ work                     │
   │ trust        │ signing       │ instrumentation/         │
   │ contracts    │ workUnit      │ node                     │
   └──────────────┴───────────────┴──────────────────────────┘
                      │
        your agent, your gateway, your verifier
```

## Three entry points

| Import | Holds | Runs where |
| --- | --- | --- |
| `verified-typescript` | Verification, trust, contracts, evidence, signing, the work lifecycle, work-unit identity | Anywhere WebAssembly does |
| `verified-typescript/instrumentation` | `WorkSession`, `verifiedTool`, traces | Runtimes with `node:async_hooks` |
| `verified-typescript/node` | `readTrustRegistry`, `readContract`, `readPackage`, `writePackage`, `readWorkRecord`, `writeWorkRecord` | Runtimes with `node:fs` |

The core entry point imports no `node:` module. See
[decision 0003](../decisions/0003-three-entry-points.md).

## The modules

| Module | Responsibility | Needs |
| --- | --- | --- |
| `verification` | `Verifier`, `VerificationResult`, `Expectations` | native |
| `trust` | `TrustRegistry`, `TrustedKey` | native |
| `contracts` | `WorkContract` | native |
| `records` | `WorkPackage`, `WorkRecord`: the exact bytes | native |
| `canonical` | `canonicalize`, `Digest` | native |
| `signing` | `Signer`, `SigningAuthority`, `Ed25519Signer` | native for the in-memory signer |
| `evidence` | `EvidenceSource`, `SignedEvidence` | native |
| `work` | `Work`, `Claim`, `IssuedWork`, `DecisionIssuer`: the lifecycle | native to issue |
| `workUnit` | `workUnit`, `WorkUnitScope` | native |
| `instrumentation/session` | `WorkSession`, `Scope`, `TraceEvent`, `ExecutionTrace` | `node:async_hooks`; native to export or sign a trace |
| `instrumentation/tool` | `verifiedTool` | `node:async_hooks` |
| `node` | File helpers | `node:fs` |
| `bridge` | The only importer of `src/native/` | |

Three uses are independent of one another:

- **Verify only.** `Verifier`, `TrustRegistry`. No client, no session.
- **Produce evidence only.** `EvidenceSource`, `SigningAuthority`, a `Signer`.
- **Instrument only.** `WorkSession`, `verifiedTool`. Recording events calls
  no native code; exporting a trace's canonical text or digest does.

## Design rules

1. **No protocol rule in TypeScript.** TypeScript never canonicalizes, hashes
   for the protocol, checks a signature, evaluates a contract or orders a
   check. It builds JSON, calls the module and wraps what comes back in typed,
   read-only values. A rule duplicated in TypeScript could drift; a rule that
   is only in Rust cannot.
2. **One doorway.** Only `bridge` imports the generated module. The
   WebAssembly is compiled on first use, never at import time. Importing the
   package opens no file and makes no network call.
3. **No silent fallback.** If the module cannot be loaded, native operations
   throw `NativeUnavailableError`. Nothing degrades to a weaker check.
4. **Results for outcomes, errors for operations.** A refused package, an
   incomplete verification and a contradicted claim are values. An oversized
   input, a broken registry, an unreadable file are errors.
   `RequirementNotMet` is thrown only by `require…`, at the caller's request.
5. **Bytes are kept.** A package is held as the bytes received and is never
   re-serialized. Consumers re-verify from bytes.
6. **Trust is an argument.** No default registry, no ambient credentials, no
   global state. The only context-local state is "the current session", which
   exists so that a wrapped tool can find it.
7. **Read-only, explicit types.** Classes with `readonly` fields, frozen where
   it matters, and `as const` objects for the closed vocabularies
   (`Decision`, `VerificationStatus`, `EvidenceKind`). No schema library: the
   wire formats are validated by the Rust side, exactly, and a second schema
   layer would be a second definition of the protocol.
8. **No runtime dependencies.** See
   [decision 0010](../decisions/0010-no-runtime-dependencies.md).
9. **No fractions.** A `number` must be a safe integer; larger integers are
   `bigint`. See [decision 0004](../decisions/0004-numbers.md).

## Synchronous and asynchronous use

Verification and signing are CPU-bound and synchronous. They are plain
functions; call them from async code directly. The WebAssembly module is
compiled synchronously on first use. On a browser's main thread, which may
refuse to compile a module of this size synchronously, call `await ready()`
once first.

`WorkSession.run`, `turn` and `tool` take a function that may return a value
or a promise, and end the span when it returns, settles or throws.
`verifiedTool` wraps synchronous and asynchronous functions alike. Session
state is tracked with `AsyncLocalStorage`, so concurrent sessions are
isolated.

The module runs on the calling thread. For very large packages (the limit is
32 MiB) a caller that must keep an event loop responsive should verify in a
worker.

`Signer.sign` is synchronous. A signer backed by a network service has to
block or sign ahead of the call. That is a real limitation for KMS-held keys,
and an asynchronous signer interface is on the [roadmap](../roadmap.md).

## What the SDK deliberately is not

- Not a platform client. See [ecosystem boundaries](ecosystem-boundaries.md).
- Not a tracing backend or an observability product.
- Not a policy engine: contracts are data, evaluated by the shared evaluator.
- Not a billing or compliance application.
- Not a key store.
