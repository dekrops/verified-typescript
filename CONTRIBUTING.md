# Contributing

## Setup

You need Node.js 22.18+, Rust 1.99+ (`rustup`) with the
`wasm32-unknown-unknown` target, `wasm-bindgen-cli` at the version
`rust/Cargo.toml` pins, and git.

```sh
git clone --recurse-submodules https://github.com/dekrops/verified-typescript
cd verified-typescript
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked
npm ci
npm run build:native         # rust/ -> src/native/ (generated, not committed)
```

After changing Rust code, run `npm run build:native` again.

## The gate

Everything CI runs, locally:

```sh
npm run lint
npm run typecheck
VERIFIED_CONFORMANCE_REQUIRED=1 npm test
(cd rust && cargo fmt --check && cargo clippy --locked --target wasm32-unknown-unknown -- -D warnings)
```

After changing `rust/Cargo.lock`, regenerate the third-party notices (needs
`cargo-about` 0.9.2): in `rust/`, run
`cargo about generate --frozen --fail about.hbs -o ../THIRD-PARTY-LICENSES.md`.

`npm test` builds `dist/` first, because the example tests run the built
package the way a user would.

## Rules that are not negotiable

1. **No protocol logic in TypeScript.** If a change needs to canonicalize,
   hash for the protocol, check a signature, evaluate a contract or order a
   check, it calls upstream through the WebAssembly module. If upstream
   cannot do it, open an issue there and document the gap here.
2. **Conformance vectors are never edited.** If the SDK disagrees with a
   vector, the specification is investigated. A vector that cannot run is
   named in `docs/protocol-compatibility.md` and marked as an expected
   failure; it is never counted as passing.
3. **No silent fallback** from complete verification to anything weaker.
4. **No boolean for a verification.** New result fields are properties read
   one at a time.
5. **No number is rounded.** Values cross into the module as JSON text
   written by `encode`, which refuses fractions and unsafe integers, and come
   back through `decode`, which reads large integers as `bigint`.
6. **Synthetic data only.** No real keys, tenants, customers or documents in
   tests, examples or docs.
7. **Say what is not supported.** A framework adapter is added only with
   integration tests against the real framework, and a runtime is named as
   supported only when CI runs the suite on it. Documentation claims are
   limited to what tests exercise.
8. **The core entry point stays universal.** `src/index.ts` and what it
   imports use no Node.js module. Context tracking lives in
   `src/instrumentation/`, file access in `src/node.ts`.
9. **Boundaries.** Billing, settlement and compliance rules belong in the
   applications. See `docs/architecture/ecosystem-boundaries.md`.

## Changing the upstream pin

One pull request that changes the five `rev` values in `rust/Cargo.toml`,
`UPSTREAM_REVISION` in `rust/src/lib.rs`, `rust/Cargo.lock`, and the tables in
`docs/protocol-compatibility.md`, after reading the upstream changes in
between. Nothing else in it. Pin a tag's commit, and move with the Python SDK
so that both bind one revision.

## Versioning and stability

Semantic versioning, with the usual pre-1.0 caveat: minor versions may break.
Public API is what the three entry points export. Anything marked
`@internal`, other modules under `src/`, and the exact contents of
`VerificationResult.raw` are not. Protocol compatibility is stated separately
from the SDK version, in `docs/protocol-compatibility.md`.

## License

By contributing you agree that your contribution is licensed under
Apache-2.0.
