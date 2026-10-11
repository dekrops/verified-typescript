# Roadmap

An honest account of where this is, in three horizons. Nothing below is a
commitment to a date.

## Now (0.1, this repository)

Working and tested:

- **Offline verification** of `wvp-0.1` and `wvp-0.2` packages through the
  shared Rust verifier, with structured results that keep refusal,
  incompleteness and the reproduced decision apart.
- **Typed models**: trust registries, contracts, evidence, claims, packages,
  work records, verification results.
- **Evidence production** with explicit, scoped signing authority and a
  pluggable signer.
- **A work lifecycle** (`open`, `claimed`, `issued`) that issues `wvp-0.2`
  packages, each checked by the shared verifier before it is returned.
- **Work-unit identity** and nullifiers.
- **Generic agent instrumentation**: sessions, turns, tools, traces; for
  synchronous and asynchronous functions.
- **Conformance**: the published corpus for canonical encoding, both package
  versions, the contract language, work-unit identity and evidence statements.
- **One WebAssembly module** for every platform, with no runtime dependency.

Known gaps at this horizon: no security review; no
framework adapter; a synchronous-only signer; claim registration not bound;
no platform client; only Node.js is tested; building from source needs Rust
and network access.

## Next

In rough order of leverage:

1. **Release from CI with provenance.** 0.1.0 was published to npm by hand,
   to hold the name. Later versions should be published by a workflow, with
   npm provenance, from a tagged commit.
2. **An asynchronous signer.** `Signer.sign` is synchronous, which does not
   fit a key held in a KMS. An `AsyncSigner` with `await source.record(…)`
   and `await work.issue(…)` beside the synchronous forms.
3. **Framework adapters**: the OpenAI Agents SDK for JavaScript, the Vercel
   AI SDK, LangGraph.js. Each with tests against the real framework, with a
   scripted model and no network, before it is listed.
4. **More runtimes under test**: Deno, Bun, a browser, an edge runtime. Until
   then they are not claimed.
5. **A public API for statement chains and admission**, which are bound and
   pass the corpus but are reachable only through the module.
6. **Richer evidence producers**: statement chains with a pluggable state
   store; a KMS signer example; batch signing.
7. **Claim registration v1**: bind the existing Rust library; run its 123
   vectors.
8. **A smaller, lazier module**: `wasm-opt`, and an optional build that
   loads the WebAssembly from a file instead of embedded base64.
9. **Platform service integration**, once the platform has a versioned API
   and service credentials. A separate entry point.
10. **API reference** generated from the doc comments.

## Later

- **Cross-language harmonization.** A shared conformance report format, so
  that `verified-python` and `verified-typescript` publish the same table,
  and one name for the execution-trace format.
- **One binding facade.** The Rust facade is the same in both SDKs. Moving it
  upstream, with a published WebAssembly build, would remove the copy and the
  Rust toolchain from this repository's build. See
  [ecosystem boundaries](architecture/ecosystem-boundaries.md).
- **Protocol work that SDKs should not paper over**: trusted time for key
  validity, a checked binding between a session claim and its turn claims,
  selective disclosure of evidence. These belong in `wvp`.
- **Broader adoption**: adapters maintained with or by framework authors,
  and evidence gateways for common systems of record maintained by those who
  operate them.

## Non-goals

A hosted service, a policy engine, billing or settlement logic, compliance
verdicts, a key management system, and a tracing backend.
