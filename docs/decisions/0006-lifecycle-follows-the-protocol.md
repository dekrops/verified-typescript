# 0006. The work lifecycle follows the protocol

Status: accepted.

## Context

The natural sketch for an SDK like this is `work.claim({ outcome })` followed
by `record = work.finalize()`. Measured against WVP v0.2 it does not hold:

- A claim does not carry an outcome. It names a contract by digest, supplies
  the contract's declared inputs, and lists the evidence it relies on.
- A decision comes from evaluating the contract against authenticated
  evidence. A claim alone yields `UNDETERMINED`.
- "Finalized", "accepted" and "disputed" are states of other systems, not of
  a package.
- "Work record" is the record of a verification, not the artifact produced.

## Decision

`Work` has three states: `open` (collecting evidence), `claimed` (the claim
and its evidence list are fixed), `issued` (evaluated and sealed, with a
decision of `SUPPORTED`, `CONTRADICTED` or `UNDETERMINED`). `issue()` requires
a trust registry. There is no `finalize()`.

"Evidence pending" is `open`. "Verification incomplete" is a property of a
relying party's `VerificationResult`, not of the work. `CONTRADICTED` and
`UNDETERMINED` are decisions of issued work, and are not errors.

## Not modelled, with the missing dependency

Acceptance, dispute, resolution, finalization (no public API defines them),
claim registration before evidence (protocol exists, not bound yet),
supersession of a claim (not in the `wvp-0.2` claim).
