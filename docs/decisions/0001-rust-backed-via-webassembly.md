# 0001. Rust-backed through WebAssembly

Status: accepted.

## Context

Four ways to give TypeScript developers WVP verification were considered.

| Option | For | Against |
| --- | --- | --- |
| A. The upstream crates compiled to WebAssembly | One implementation of the rules. One artifact for Node.js, Deno, Bun, browsers and edge runtimes. No per-platform binary, no install script | A module of about 425 KB. It must be compiled before first use |
| B. The upstream crates as a native addon (napi) | One implementation of the rules. Fastest | A binary per platform and architecture, optional dependencies or an install script to pick one, and no browser |
| C. Subprocess to the `verified` command | No build | A binary to distribute and find; process cost per call; no browser; errors as exit codes |
| D. An independent TypeScript implementation | Simplest install, smallest size | One more implementation of canonical encoding, signature checks and a three-valued evaluator, in security-sensitive code, to keep in step by hand |

Upstream's decision 0007 leaves TypeScript open. It notes that an independent
JavaScript verifier already exists upstream of the public crates, and counts
that as an argument for the pure route.

## Decision

A. A small Rust crate binds the upstream crates and is compiled to one
WebAssembly module; a TypeScript package on top provides the API. No protocol
rule is implemented in TypeScript.

The module's bytes are embedded in the package as base64 and compiled on
first use. `await ready()` compiles them ahead of time, and is needed on a
browser's main thread, which may refuse a synchronous compile of this size.

## Why not pure TypeScript

Independence is a real advantage: an independent implementation agreeing on
the corpus is stronger evidence about the *specification* than a binding is.
That is the job of a conformance implementation. It is not what a developer
should depend on to decide whether work was done.

With a binding there is one implementation of every rule across the command,
the Python SDK, the reference applications and this SDK. A package verified
here gets the answer it gets everywhere else, by construction and not by
agreement. That is the property this SDK is for, and it is the reason
`verified-python` made the same choice.

## Why not napi

A native addon would be faster. Speed has not been the constraint: the whole
conformance corpus, several hundred verifications and evaluations, runs in
well under a second here. Its cost is
distribution, which is where SDKs most often fail their users: a matrix of
prebuilt binaries, a fallback when none matches, and no path to a browser.
One of this SDK's uses is a third party checking a package where it is
received, which may be a web page.

## No fallback

C and D are not used, even as fallbacks. A silent fallback from one mechanism
to another is how "verification succeeded" comes to mean two things. If the
module cannot be loaded, native operations throw `NativeUnavailableError`.

## Consequences

- The SDK's conformance results show that the binding preserves upstream
  behaviour, not that a second implementation agrees.
- The package carries about 567 KB of base64. A bundler cannot tree-shake it.
- The first native call pays for decoding and compiling the module.
- WebAssembly runs on the calling thread. Large packages block it.
- Building from a checkout needs Rust and `wasm-bindgen-cli`. Installing a
  published package would not.
- Runtimes that forbid compiling WebAssembly from bytes at run time cannot
  use the package as built.

## Would change if

Upstream publishes a WebAssembly build of the facade. This SDK would then
install it instead of compiling it, with the same single implementation.
