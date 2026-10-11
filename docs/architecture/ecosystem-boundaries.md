# Ecosystem boundaries

The SDK is useful only if it makes the ecosystem more coherent, not if it
becomes one more place where the protocol is defined.

## Who owns what

| Repository | Owns | Never owns |
| --- | --- | --- |
| [`wvp`](https://github.com/dekrops/wvp) | Specifications, versions, vectors, conformance rules. **Normative** | Any implementation |
| [`verified-cli`](https://github.com/dekrops/verified-cli) | The public Rust crates (canonical encoding, protocol types, contract language, verifier, work-unit identity) and the `verified` command | Whom to trust, acceptance, a ledger |
| [`verified-python`](https://github.com/dekrops/verified-python) | The Python API over the same crates | Protocol rules, billing or compliance logic, a platform, key custody |
| **`verified-typescript`** | The TypeScript API, the WebAssembly binding, typed models, instrumentation primitives | The same |
| `verified` | The commercial Work Verification Platform | Being a required trust anchor |
| `agent-billing-center` | A reference application: billing agreements, acceptance, eligibility, settlement uniqueness | A second verifier |
| `agent-compliance-center` | A reference application: policy packs, result mapping, attestation bundles | A second evaluator |

Dependencies point one way: applications depend on an SDK or the crates; the
SDKs depend on the crates; the crates depend on the specification. Nothing
here depends on the platform, at build time or at run time.

## Where this SDK stops

| Request | Answer |
| --- | --- |
| "Tell me if this work is billable" | No. The SDK returns the reproduced decision, the identifiers a billing application compares, and the exact bytes. Eligibility, acceptance, invoicing and settlement are separate states owned by the billing application. |
| "Tell me if this session is compliant" | No. The SDK returns one decision per claim. Mapping decisions to PASS or FAIL, wording reasons, and bundling a session's claims are the compliance application's. |
| "Was this unit already billed?" | No. The SDK computes the unit's identity and nullifier. Uniqueness needs shared state, which is the settling party's. |
| "Give me a default trust registry" | No. |
| "Sign as the ERP from inside my agent" | Not in a way a relying party accepts. |
| "Submit this to the Verified platform" | Not yet. See below. |

The test for a feature: would a developer who bills nothing, runs no chatbot
and has no Verified account want it? If not, it belongs in an application.

## The platform client that is not here

There is no `Client`. The platform does not yet offer a stable, versioned API
with service credentials for an SDK to call. What this SDK produces is a
finished `wvp-0.2` package, as bytes.

When such an API exists, a client belongs in its own entry point
(`verified-typescript/platform`), so that verification and instrumentation
never depend on it. See
[decision 0009](../decisions/0009-no-platform-client-yet.md).

## Two SDKs, one facade

`verified-python` and `verified-typescript` bind the same five crates at the
same upstream tag. Their Rust facades are the same functions with the same
JSON in and out; one is compiled with PyO3, the other with wasm-bindgen.

| | `verified-python` | `verified-typescript` |
| --- | --- | --- |
| Result model | `VerificationResult`, `Decision`, `Property`, … | The same names |
| Member names | `snake_case` | `camelCase` |
| A result as a boolean | `bool(result)` raises | Always truthy; the language gives no hook |
| Session scope | context managers | `session.run(fn)`, `session.turn(fn)`, `session.tool(name, fn)` |
| Files | `TrustRegistry.load(path)` on the type | `readTrustRegistry(path)` in `verified-typescript/node` |
| Derived agent identifiers | UUID version 5 over name and version | The same value for the same name and version |
| Execution-trace format name | `verified-python-execution-trace-1` | `verified-typescript-execution-trace-1` |
| Framework adapters | OpenAI Agents SDK, LangGraph | None yet |

A package issued by one SDK verifies in the other, because both call the same
verifier.

## Risks, and what this repository does about each

| Risk | Mitigation here |
| --- | --- |
| **Semantic divergence** between implementations and applications | One implementation of the rules (the Rust crates), bound not rewritten. The published corpus runs in CI through the TypeScript API. |
| **Duplicated implementations** of signing, canonicalization, contracts | The SDK calls upstream for all of them, issuing included. |
| **Protocol ownership confusion** | `wvp` is pinned as a submodule and treated as the contract. Expectations are never edited. |
| **Confusing product boundaries** | No billing, compliance or platform logic; see the table above. |
| **Version drift** between consumers | The SDK pins an upstream tag by its commit, reports it at run time and on every result, and a test ties the pins together. |
| **Misleading verification** | The result type, `require…`, `trust` without a default, `stated` kept apart from verified values. |
| **SDK proliferation** | The facade's surface is bytes and JSON text, shared with the Python binding. |
| **Distribution complexity** | One WebAssembly module for every platform. No per-platform binary and no install script. |

## Proposed upstream changes

Three earlier proposals, made from `verified-python`, have been carried out
upstream: a producer in the library (`verified_verifier::issue`), the
`verify --json` shape as a library function (`Report::to_value`), and tagged
releases with a shared pin. This SDK was written after all three and uses
them. Still open:

1. **The binding facade in one place.** `rust/src` here and in
   `verified-python` are the same functions under two macro systems. A shared
   facade crate upstream, with thin PyO3 and wasm-bindgen wrappers, would
   remove the copy.
2. **A published WebAssembly build** of that facade, so that an SDK installs
   it instead of compiling it.
3. **Typed accessors on `Contract`**: declared inputs, kinds, accepted
   sources, requirement identifiers. Consumers currently read them from raw
   JSON.
4. **`Instant` formatting, `Trust::from_bytes`, and an SPKI helper.** Small
   conveniences every consumer has re-written.
5. **In the protocol:** a freshness or trusted-time input for key validity;
   a way to bind a turn claim to its session claim; a multi-claim object. All
   three are protocol changes, to be made in `wvp`, not worked around in an SDK.
6. **Naming:** decide whether "Work Record" means the file or the record of a
   verification, and use one meaning in product material, in the
   specifications and in SDK type names.

## When to extract a shared core

With two SDKs the question is now real. The facade is about 850 lines in each
repository and changes only when the pin moves, so the copy is cheap today.
Extraction becomes worth its cost when a third binding appears, or when the
two SDKs need to move their pins on a cadence the copy makes error-prone.
