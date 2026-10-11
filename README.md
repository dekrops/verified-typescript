# verified-typescript

The TypeScript SDK for the [Work Verification Protocol](https://github.com/dekrops/wvp) (WVP).

> What did this agent do, under which authority, with what evidence, according
> to which contract, and can an independent party reproduce the result?

`verified-typescript` lets a TypeScript or JavaScript agent system produce a
portable, signed account of a unit of work, and lets anyone verify it offline.
Verification is performed by the same Rust crates as the
[`verified` CLI](https://github.com/dekrops/verified-cli) and the
[Python SDK](https://github.com/dekrops/verified-python), compiled to
WebAssembly; the TypeScript layer adds an API, not a second implementation.

**Status: developer preview (0.1.0), not yet on npm.** WVP is a draft in every
version. This SDK has not been security-audited, and its API will change. Read
[what is and is not supported](docs/protocol-compatibility.md) before relying
on it.

```text
Any agent. Any runtime. Independently verifiable work.
```

## Install

The package is not published yet. From a checkout, with Node.js 22.18 or
later, a Rust toolchain (1.99+, with the `wasm32-unknown-unknown` target) and
`wasm-bindgen-cli` 0.2.129:

```sh
git clone --recurse-submodules https://github.com/dekrops/verified-typescript
cd verified-typescript
npm ci
npm run build:native   # compiles the Rust crates to WebAssembly
npm test               # 300+ tests, including the WVP conformance corpus
```

The package has no runtime dependencies. It is ES modules only, and has three
entry points:

| Import | Holds | Runs on |
| --- | --- | --- |
| `verified-typescript` | Verification, trust, contracts, evidence, the work lifecycle | Anything with WebAssembly |
| `verified-typescript/instrumentation` | `WorkSession`, `verifiedTool`, traces | Runtimes with `node:async_hooks` |
| `verified-typescript/node` | File helpers | Runtimes with `node:fs` |

Tested on Node.js 22 and 24. Deno, Bun and browsers are expected to work and
are not tested, so they are not claimed. Runtimes that forbid compiling
WebAssembly from bytes at run time, Cloudflare Workers among them, cannot load
the module as it is packaged.

## 1. How do I independently verify a package?

You hold a package file and a trust registry **you** chose. No account, no
network, no agent framework.

```ts
import { Verifier } from "verified-typescript";
import { readContract, readPackage, readTrustRegistry } from "verified-typescript/node";

const examples = "examples/standalone-verification";
const verifier = new Verifier({
  trust: readTrustRegistry(`${examples}/trust.json`), // yours, never the package's
  expect: {
    // what you agreed to
    tenant: "acme-synthetic",
    contract: readContract("examples/contracts/invoice-posting.json"),
  },
});

const result = verifier.verify(readPackage(`${examples}/contradicted.json`));

console.log(result.verificationStatus); // complete   <- the verification succeeded
console.log(result.decision); // CONTRADICTED   <- the work did not
console.log(result.explain());
```

Those are two different facts, and the API never merges them:

| You want to know | Read |
| --- | --- |
| Is the file well formed and unaltered? | `result.integrity` |
| Is the evidence authentic under my registry? | `result.evidenceSignatures`, `result.signerAuthority` |
| Did every protocol check run and pass? | `result.verificationStatus` |
| What does the contract yield from the evidence? | `result.decision` (`null` unless reproduced) |
| Is that the outcome I need? | `result.requireSupported()` |
| Did the sources tell the truth? | Nothing can tell you. `result.sourceTruthfulness` is always `not_established`. |

There is no `valid` flag. A result is an object, so `if (result)` is always
true and tests nothing. To enforce an outcome, say which one:

```ts
import { RequirementNotMet, Verifier } from "verified-typescript";
import { readPackage, readTrustRegistry } from "verified-typescript/node";

const examples = "examples/standalone-verification";
const verifier = new Verifier({ trust: readTrustRegistry(`${examples}/trust.json`) });

verifier.verify(readPackage(`${examples}/supported.json`)).requireSupported();

try {
  verifier.verify(readPackage(`${examples}/undetermined.json`)).requireSupported();
} catch (error) {
  if (!(error instanceof RequirementNotMet)) throw error;
  console.log(error.message); // the reproduced decision is UNDETERMINED, not SUPPORTED
}
```

Without a registry (`new Verifier({ trust: null })`, which you must write
out), the result is `incomplete`: integrity only, no decision. The decision a
package carries is its issuer's claim until you reproduce it.

## 2. How do I instrument my agent?

Run the agent inside a `WorkSession` and wrap its tools. No framework or
tracing backend is imposed; synchronous and asynchronous functions both work.

```ts
import { verifiedTool, WorkSession } from "verified-typescript/instrumentation";
import { readContract } from "verified-typescript/node";

const contract = readContract("examples/contracts/invoice-posting.json");

const postInvoice = verifiedTool(
  {
    workType: "invoice.post",
    contract,
    inputs: (invoiceId: string) => ({ invoice: invoiceId }),
  },
  (invoiceId: string) => "accepted", // what the ERP's API answered
);

const session = new WorkSession({ agent: "invoice-agent", tenant: "acme-synthetic" });
session.run(() => {
  session.turn(() => postInvoice("INV-123"));
});

const [work] = session.works;
console.log(work?.state); // open
console.log(session.events.map((event) => event.kind));
```

The tool returned, and **nothing is established**. The wrapper recorded that
the call happened and opened a work item under the contract; it did not record
success. The work stays `open` until evidence from an identified source is
attached:

```text
open ──attach(evidence)──▶ open ──claim()──▶ claimed ──issue({ trust })──▶ issued
                                                                             │
                               decision: SUPPORTED | CONTRADICTED | UNDETERMINED
```

`issue()` evaluates the contract and seals a package. With only the agent's
word, the decision is `UNDETERMINED`. The full flow, with a simulated ERP as a
separate party, is [`examples/invoice-posting`](examples/invoice-posting/invoice-agent.ts).

There is no framework adapter yet. See
[agent runtime integration](docs/architecture/agent-runtime-integration.md).

## 3. How do I produce evidence without misrepresenting its authority?

Evidence is signed where the observation is made, by a key whose authority is
declared explicitly: one issuer, one tenant, named source systems.

```ts
import {
  Ed25519Signer,
  EvidenceSource,
  SigningAuthority,
  SigningAuthorityError,
} from "verified-typescript";

// Use a KMS in production.
const signer = new Ed25519Signer({ keyId: "erp-gateway-1", seed: new Uint8Array(32).fill(7) });
const authority = new SigningAuthority({
  keyId: "erp-gateway-1",
  issuer: "00000000-0000-4000-8000-0000000000e1",
  tenant: "acme-synthetic",
  sources: ["erp"], // this key speaks for the ERP, and nothing else
});

const gateway = new EvidenceSource({ system: "erp", authority, signer });
const posting = gateway.record(
  "posting",
  { document: "DOC-1", invoice: "INV-123", amount: 125_000 }, // EUR 1250.00 at scale 2
  { subject: { system: "erp", kind: "invoice", key: "INV-123" } },
);
console.log(posting.source, posting.keyId);

try {
  new EvidenceSource({ system: "payments", authority, signer });
} catch (error) {
  if (!(error instanceof SigningAuthorityError)) throw error;
  console.log(error.message); // not declared to speak for source "payments"
}
```

The local check prevents mistakes. The security boundary is elsewhere: a
relying party's registry says which key may speak for which system, and its
verifier refuses a statement signed by any other key (`SOURCE_NOT_AUTHORIZED`).
An agent's key is authorized for the agent's runtime, so an agent cannot turn
"I posted the invoice" into "the ERP says it was posted".

A signature establishes who said something and that it was not altered. It
does not establish that it is true. See the [trust model](docs/trust-model.md).

## Six things that are not the same

| Thing | What it is | Who stands behind it | In this SDK |
| --- | --- | --- | --- |
| Execution telemetry | What a runtime logged about itself | Nobody; it is unsigned | `ExecutionTrace` |
| Agent claim | An assertion that work was done, against a contract | The claimant | `Claim` |
| Signed evidence statement | What an identified source says it observed | The signer, for the systems a registry authorizes | `SignedEvidence` |
| Verified decision | What the contract yields from authenticated evidence, reproduced | Whoever re-runs it: you | `VerificationResult.decision` |
| Package ("portable Work Record") | Claim, contract, evidence and decision in one sealed file | Its issuer, if it signed the decision | `WorkPackage` |
| Work record | The record of one verification of a package | The verifier that computed it | `WorkRecord` |

An *attestation* (a party signing that a verdict holds) appears in the protocol
only as the issuer's signature over a decision. Multi-claim attestation
bundles, as in Agent Compliance Center, are application formats and are not
part of this SDK.

## Numbers

The protocol's encoding has whole numbers only. A `number` must be a safe
integer and a `bigint` is written as an integer of any size; a fraction is
refused, never rounded. Write amounts as whole units of the contract's scale
(EUR 12.50 at scale 2 is `1250`).

## Examples

All run offline with synthetic data, after `npm run build`:
`node examples/<dir>/<script>.ts`.

| Example | Shows |
| --- | --- |
| [`standalone-verification`](examples/standalone-verification/verify-packages.ts) | A third party verifying three packages; all verify, one is supported |
| [`invoice-posting`](examples/invoice-posting/invoice-agent.ts) | A custom agent loop, a tool, and an ERP gateway as a separate evidence source |
| [`chatbot-compliance`](examples/chatbot-compliance/support-chatbot.ts) | Turn and session claims under separate contracts; the session is not the sum of its turns |
| [`enterprise-evidence`](examples/enterprise-evidence/order-gateway.ts) | Scoped signing authority, a pluggable signer, and three relying parties |

The three packages in `standalone-verification` are byte for byte the ones the
Python SDK produces from the same inputs.

## What is and is not here

Working, with tests: offline verification of `wvp-0.1` and `wvp-0.2` packages;
relying-party expectations and work records; trust registries; evidence
statements, chains and admission; Work Contract Language 1; work-unit identity
and nullifiers; issuing `wvp-0.2` packages; framework-independent
instrumentation.

Not here: an npm release; framework adapters; an asynchronous signer
interface (`Signer.sign` is synchronous); a client for the hosted Verified
platform (it has no stable service API to call yet); claim registration v1;
statement chaining when *producing* evidence. Details and reasons are in the
[roadmap](docs/roadmap.md) and the
[compatibility assessment](docs/protocol-compatibility.md).

This SDK contains no billing, settlement or compliance rules, and does not
decide whether verified work is accepted, payable or compliant.

## Documentation

- [Architecture overview](docs/architecture/overview.md)
- [Ecosystem boundaries](docs/architecture/ecosystem-boundaries.md)
- [Rust and TypeScript interop](docs/architecture/rust-typescript-interop.md)
- [Agent runtime integration](docs/architecture/agent-runtime-integration.md)
- [Protocol compatibility](docs/protocol-compatibility.md)
- [Trust model](docs/trust-model.md)
- [Roadmap](docs/roadmap.md)
- [Decisions](docs/decisions/README.md)

## Related repositories

- [`dekrops/wvp`](https://github.com/dekrops/wvp): the specifications and conformance vectors. Normative.
- [`dekrops/verified-cli`](https://github.com/dekrops/verified-cli): the Rust implementation this SDK binds, and the `verified` command.
- [`dekrops/verified-python`](https://github.com/dekrops/verified-python): the Python SDK, with the same result model and names.
- `dekrops/agent-billing-center`, `dekrops/agent-compliance-center`: reference applications built on verified work.
- `dekrops/verified`: the commercial Work Verification Platform. Not required by anything here.

## License

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). The conformance
corpus under `conformance/wvp` is a submodule with its own licenses.
