# 0005. Verification returns a structured result, never a boolean

Status: accepted.

## Decision

`verifier.verify` returns a `VerificationResult` for every package it could
examine, including refused ones. The result has no `valid` or `ok` member,
and `decision` is `null` unless a decision was reproduced. Enforcement is
opt-in and names its outcome: `requireComplete()`,
`requireSupported({ issuerSigned })`, `requireDecision(…)`. Errors are
reserved for operational failures.

`new Verifier({ trust })` has no default. Integrity-only verification is
written as `trust: null`. Leaving `trust` out is a `TypeError`, for callers
the type checker does not reach.

## Why

A reproduced `CONTRADICTED` is a successful verification. Any single boolean
has to pick whether that is `true` or `false`, and either choice misleads
someone.

What a package *states* (its recorded decision, its claimant) is kept under
`result.stated`, apart from what was verified.

## What TypeScript cannot do

In `verified-python`, `bool(result)` raises, so `if verifier.verify(pkg):` is
an immediate error. JavaScript has no equivalent: every object is truthy, and
no method or proxy changes that. `if (verifier.verify(pkg))` runs its body
for a refused package.

The SDK does not pretend otherwise. It removes the members that would make
the mistake look right, documents the limit in the README and the
[trust model](../trust-model.md), and makes the correct call the shortest
one: `verifier.verify(pkg).requireSupported()`.

A lint rule that flags a `VerificationResult` used as a condition would close
most of the gap, and is a candidate for later.

## Cost

Slightly more to type than `if (valid)`. That is the point.
