# Protocol compatibility

The Work Verification Protocol is a **draft** in every version. This page
states what this SDK implements, what it was measured against, and what it
does not do.

## What this build is made of

| | |
| --- | --- |
| SDK | `verified-typescript` 0.1.0, a developer preview |
| Verification crates | [`dekrops/verified-cli`](https://github.com/dekrops/verified-cli) `v0.1.3`, commit `519a2d200a05a6778f427cfeee14b5b7aafd277d`: `verified-history`, `verified-canonical`, `verified-protocol`, `verified-contract`, `verified-verifier`, `verified-work-unit` |
| Conformance corpus | [`dekrops/wvp`](https://github.com/dekrops/wvp) at `46ccd1d7c34d3a92e13a59f9235120f8d37395d7`, as the submodule `conformance/wvp` |
| Binding | One WebAssembly module, built with `wasm-bindgen` 0.2.129 |
| Runtime | Node.js 22 or later |

`buildInfo()` reports the same revision at run time, and every
`VerificationResult` carries it as `verifier`.

## Supported

| | `wvp-0.1` | `wvp-0.2` |
| --- | --- | --- |
| Offline verification, all thirteen checks | yes | yes |
| Canonical encoding `verified-json-v1` | yes | yes |
| Relying-party expectations (tenant, contract digest, claim) | not defined by the protocol; asking is an error | yes |
| Work record: computed, and compared with one supplied | not defined; asking is an error | yes |
| Issuing a package | **no** | yes |
| Issuer signature over the decision | verify only | verify and sign |

Also, outside packages: evidence statements (sign, read, authenticate), Work
Contract Language 1 (read, and evaluate through package assembly), work-unit
identity v1 (identity, nullifier, key commitment).

And, as a draft: work relation v1, reading only (`readHistory`). Given
relations and the records they name, it reports each relation as checked,
stated, contradicted or refused, whether a registered claim is a package's
claim, and each stream's completeness. It verifies no record, and this SDK
does not yet issue relations.

Statement chains and admission are bound in the module and run against the
corpus, but have no public TypeScript API yet.

## Measured against the corpus

Run on 2026-10-11 by `tests/conformance/corpus.test.ts`, through the public
API where one exists and through the module's functions where none does
(contract evaluation, statements, chains, admission). Every expectation is
compared in full, never by refusal code alone. With
`VERIFIED_CONFORMANCE_REQUIRED=1` a missing corpus fails instead of skipping.

Corpus files are handed to the verifier as published: their numbers are never
read into a JavaScript `number` and written back.

| Corpus | Result |
| --- | --- |
| `canonical-hash-v1.json` | 12 of 12 valid cases reproduce bytes and digest; 5 of 5 invalid cases refused |
| `wvp/v0.1`, 26 vectors | 26 reproduced: refusal code, or decision, statement count, integrity and issuer-signature state |
| `wvp/v0.2`, 28 vectors | 28 reproduced: as above, plus contract summary and the value of every requirement |
| `wvp/v0.2/expectations.json`, 7 cases | 7 reproduced |
| The two worked examples beside the specifications | Both verify completely as `SUPPORTED` |
| `work-contract/v1`, 82 case files and 5 differential batches | 641 cases reproduced: 81 case files and 560 cases in the 5 batches. 1 case file cannot be represented (below) |
| `work-unit/v1/vectors.json` | 3 of 3 key commitments and 10 of 10 identities and nullifiers |
| `evidence-statement/v1`, 39 vectors | 39 reproduced: 17 statement, 13 chain, 9 admission. **Not compared:** `verificationResultSha256` and `verificationStatus` of accepted admissions, which are the platform's result and are not computed by the shared crates |
| `work-relation/v1/vectors.json`, 41 cases | 41 reproduced: the whole reading of each, as the shared reader states it |
| `claim-registration/v1` (163 cases) | **Not run.** Claim registration is not bound in this release (see below) |

`72-scale-not-whole` gives a type a fractional `scale`. `verified-json-v1` has
no fractions, so the shared reader refuses the file's text before any contract
is read, as upstream documents. It is marked as an expected failure and is not
counted as conforming.

Agreement on a corpus is evidence of conformance, not proof. And since this
SDK calls the same crates as the Rust implementation, passing here shows that
the binding preserves their behaviour. It is not an independent
implementation agreeing with them.

## Runtimes

| Runtime | State |
| --- | --- |
| Node.js 22 and 24, on Linux, macOS and Windows | Tested in CI |
| Deno, Bun | Not tested, so not claimed. The core entry point uses only standard web APIs and WebAssembly, and is expected to work |
| Browsers | Not tested, so not claimed. Call `await ready()` first on the main thread. `verified-typescript/instrumentation` and `verified-typescript/node` do not load in a browser |
| Cloudflare Workers and other edge runtimes | Not tested, so not claimed. Some forbid compiling WebAssembly from bytes at run time, which this package does |

## Not supported, and why

| | State | Reason |
| --- | --- | --- |
| Claim registration v1 (agreements, receipts, registry log, audit, disputes) | Not bound | The Rust library exists at the pinned revision. It is a separate protocol with its own trust configuration. Binding it is mechanical and is on the roadmap. |
| Statement chains when producing evidence | Not offered | `EvidenceSource` signs unchained statements (`"chain": null`). A chain needs durable per-stream state (the last sequence and digest), which belongs to the source's deployment. |
| A public API for chains and admission | Not offered yet | The functions are bound and pass the corpus; no typed API is designed for them. |
| Issuing `wvp-0.1` | Not offered | `wvp-0.1` names a fixed evaluator; new work should use contracts as data. |
| An asynchronous `Signer` | Not offered | `Signer.sign` returns bytes, not a promise. A key held in a KMS needs a signer that blocks or signs ahead of the call. On the roadmap. |
| Framework adapters | None | Generic instrumentation only. Each adapter waits for tests against the real framework. |
| Platform client | Not built | See [ecosystem boundaries](architecture/ecosystem-boundaries.md). |
| Freshness or revocation *at verification time* | Not in the protocol | A key's validity is judged at the statement's asserted time, which its signer chose. |

## Readings and limits inherited from upstream

This SDK takes the upstream implementation's documented readings of the
specification as they are, including: duplicate object keys are refused;
base64 must be canonical; Ed25519 verification is strict and a registry
holding a small-order key is refused when loaded; a registry may omit
`validUntil` and `revokedAt` but may not contain unknown members; integers
beyond 4096 digits and packages beyond 32 MiB are not examined (an error, not
a refusal). The list is in upstream's
[`docs/protocol/compatibility.md`](https://github.com/dekrops/verified-cli/blob/main/docs/protocol/compatibility.md).

Two conventions are this SDK's own:

- A package *file* may end with exactly one line end, which is the file's and
  not the package's, as in the `verified` command. `readPackage(path)` and
  `WorkPackage.fromFile(bytes)` apply it. `verifier.verify(bytes)` takes the
  text itself and is strict.
- JSON given as a JavaScript value must hold whole numbers only: a safe
  integer as a `number`, anything larger as a `bigint`. JSON given as bytes
  is passed to the verifier untouched.

## Compatibility with `verified-python`

Both SDKs bind the same crates at the same tag, through the same facade. A
package issued by one verifies in the other. The result model and its names
are the same, in `camelCase` here. An `AgentIdentity` derived from a name and
version has the same UUID in both.

Differences a user will meet:

| | Here |
| --- | --- |
| A result as a boolean | Always truthy. Python raises; JavaScript offers no hook. Use `requireComplete()` or `requireSupported()` |
| Files | In `verified-typescript/node`, not on the types |
| Sessions | `session.run(fn)`, not a context manager |
| Execution-trace format | `verified-typescript-execution-trace-1`. Traces are telemetry and are not exchanged between the SDKs |
| Framework adapters | None yet |

## The name on npm

The bare name `verified` on npm belongs to an unrelated package. This SDK's
package name is `verified-typescript`, matching `verified-python` on PyPI.
Nothing has been published under it.
