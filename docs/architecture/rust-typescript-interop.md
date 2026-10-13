# Rust and TypeScript interop

## The boundary

The crate in `rust/` is compiled to WebAssembly and wrapped by wasm-bindgen.
It exports nineteen functions. Every one takes bytes or text and returns
bytes or JSON text. No JavaScript object is interpreted in Rust, and no
protocol value is constructed in TypeScript.

| Function | Calls upstream |
| --- | --- |
| `verify` | `verified_verifier::inspect` (which runs `verify`), `Report::to_value` |
| `canonicalize`, `canonical_digest`, `digest_bytes` | `verified_canonical::parse`, `Value::to_canonical_string`, `Value::digest`, `Sha256Digest::of` |
| `trust_registry` | `verified_verifier::Trust::from_value` |
| `contract_summary`, `evaluate_contract` | `verified_contract::Contract::read`, `Contract::evaluate` |
| `work_unit` | `verified_work_unit::{Scope, Identity, SecretKey}` |
| `statement_signing_input`, `payload_digest` | `verified_protocol::STATEMENT_DOMAIN`, `Value::digest` |
| `check_statement`, `verify_chain`, `admit` | `verified_verifier::evidence::{authenticate, verify_chain, admit}`, `Anchor::from_value` |
| `assemble_package`, `decision_signing_input`, `attach_issuer_signature` | `verified_verifier::issue::{issue, decision_signing_input, countersign}` |
| `ed25519_public_key`, `ed25519_sign` | `ed25519-dalek`, the library the verifier uses |
| `build_info` | constants of the crates |

This is the facade of the Python binding, with one addition (`digest_bytes`,
because JavaScript has no synchronous SHA-256 that every runtime shares).

JSON text is the interchange format on purpose:

- The protocol's own value type (`verified_canonical::Value`) is used on the
  Rust side throughout. There is no `serde_json` and no float anywhere between
  TypeScript and the verifier.
- The surface is language-neutral. The same facade sits behind PyO3 in
  `verified-python`.
- It is easy to audit: `rust/src` is under 900 lines, most of it reading
  arguments and naming errors.

`verify` returns the member names documented in upstream's
`docs/sdk/json-output.md` for `verified verify --json`, as the library itself
states them, plus `stated` (what the package says about itself, from
`inspect`) and `verifiedIssuerKeys`. The raw JSON is available as
`VerificationResult.raw`.

Errors that prevented an examination are thrown from Rust as an `Error` whose
message is a code, a line feed and the detail. `src/bridge.ts` splits it and
throws a typed error (`ResourceLimitError`, `TrustRegistryError`,
`MalformedInputError`, `ContractError`, `AssemblyError`, …). Protocol
outcomes, refusals included, are returned as data.

## Numbers across the boundary

`verified-json-v1` has integers of any size and no fractions. JavaScript has
one `number` type that is a float. The bridge closes the gap in both
directions:

- **Out.** `encode` writes a `number` only if it is a safe integer, writes a
  `bigint` as an integer of any size, and throws `TypeError` for a fraction,
  an unsafe integer, `undefined`, or anything that is not plain data. Nothing
  is rounded or dropped.
- **In.** `decode` reads the module's JSON with `JSON.parse` and its source
  text access. A whole number too large for a `number` becomes a `bigint`.

Source text access is why the package needs Node.js 22 or later. See
[decision 0004](../decisions/0004-numbers.md).

## What is reused, and what is not duplicated

Reused directly, by pinned revision, with no copy and no fork: canonical
encoding and digests; signing domains and signing input; trust registry
parsing and key decoding; all thirteen package checks; statement
authentication, chains and admission; the contract language's reader and
evaluator; work-unit identity, nullifier and key commitment; work record
computation and comparison; issuing `wvp-0.2` packages and countersigning
their decisions; the report as JSON.

Not written in TypeScript, deliberately: any of the above. TypeScript formats
instants (a string format the verifier then validates), converts whole
numbers to the text the contract language uses, and reads display fields out
of an already-validated contract.

One hash is written in TypeScript, and it is not a protocol hash: SHA-1, for
name-based UUIDs (`src/uuid.ts`). It derives a stable label for an agent from
its name and version, giving the same value as `verified-python`. Nothing a
verifier checks depends on it.

## Issuing

Packages are issued by `verified_verifier::issue`, the library that verifies
them. It evaluates the contract with the function the verifier uses, writes
the decision with the function the verifier compares against, and returns a
package only after verifying it under the issuer's registry.
`rust/src/issue.rs` maps the SDK's JSON parts onto its `Draft` and maps its
errors back; it decides nothing about a package's layout.

## Loading the module

`npm run build:native` compiles the crate for `wasm32-unknown-unknown`, runs
wasm-bindgen with `--target web`, and writes three things to `src/native/`:
the glue, its type declarations, and the module's bytes as a base64 string in
a JavaScript file. `src/native/` is generated and is not committed.

Embedding the bytes means the package loads the same way in every runtime: no
file read, no fetch, no bundler plugin. The cost is size. The module is about
425 KB, and about 567 KB as base64.

| | |
| --- | --- |
| First native call | Decodes the base64 and compiles the module synchronously |
| `await ready()` | Compiles it asynchronously ahead of time. Optional, except on a browser's main thread, which may refuse a synchronous compile of this size |
| Module cannot be loaded | `NativeUnavailableError`. No fallback |

## Pinning and upgrades

The seven crates are git dependencies pinned to the commit of an upstream tag
(`rust/Cargo.toml`, currently `v0.1.5`), locked in `rust/Cargo.lock`, built
with `--locked`. Upstream's library API follows semantic versioning from its
first tag, and asks consumers that exchange packages to pin the same tag.

To move the pin: change the seven `rev` values and `UPSTREAM_REVISION` in
`rust/src/lib.rs`, rebuild the module, run the full suite with the corpus
required, update the tables in `docs/protocol-compatibility.md`, and read the
upstream pull requests in between. One pull request, nothing else in it.
Because the verifier build is part of every result, a consumer that stores
results can see which verifier produced them.

`wasm-bindgen` is pinned to exactly `0.2.129` in `rust/Cargo.toml`. The
command-line tool that post-processes the module must be the same version,
and the build script refuses to run with any other.

## Building and packaging

- **To build from a checkout:** Rust 1.99 with the `wasm32-unknown-unknown`
  target, `wasm-bindgen-cli` 0.2.129, and network access to fetch the pinned
  crates from GitHub. Then `npm run build:native` and `npm run build`.
- **What a published package would hold:** compiled JavaScript, type
  declarations and the generated module. No Rust toolchain is needed to
  install it, there is no install script, and there is no per-platform
  artifact.
- **Module format:** ES modules only.
- **On npm** as `verified-typescript`. The bare name `verified` belongs to
  an unrelated package. 0.1.0 was published by hand, without provenance.
