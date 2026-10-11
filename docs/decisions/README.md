# Decisions

Short records of choices that shape the SDK. Each says what was decided, why,
and what would change it.

| | Decision |
| --- | --- |
| [0001](0001-rust-backed-via-webassembly.md) | Rust-backed through WebAssembly, not napi and not pure TypeScript |
| [0002](0002-json-text-boundary.md) | Bytes and JSON text across the native boundary |
| [0003](0003-three-entry-points.md) | Three entry points: a universal core, instrumentation, file helpers |
| [0004](0004-numbers.md) | Numbers are safe integers or `bigint`, never fractions |
| [0005](0005-results-not-booleans.md) | Verification returns a structured result, never a boolean |
| [0006](0006-lifecycle-follows-the-protocol.md) | The work lifecycle follows the protocol; no `finalize()` from a claim |
| [0007](0007-explicit-signing-authority.md) | Signing authority is explicit and scoped; the SDK takes a signer |
| [0008](0008-instrumentation-is-not-evidence.md) | Instrumentation records execution and never creates evidence |
| [0009](0009-no-platform-client-yet.md) | No platform client in the first release |
| [0010](0010-no-runtime-dependencies.md) | No schema library and no runtime dependencies |
| [0011](0011-pin-upstream-by-revision.md) | Pin upstream crates and the corpus by commit |

Several of these are the decisions of
[`verified-python`](https://github.com/dekrops/verified-python), restated for
TypeScript. 0001, 0003, 0004 and 0010 are this SDK's own.
