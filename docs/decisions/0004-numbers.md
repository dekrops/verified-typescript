# 0004. Numbers are safe integers or `bigint`, never fractions

Status: accepted.

## Context

`verified-json-v1` has integers of any size and no fractions. JavaScript's
`number` is a 64-bit float: exact for integers up to 2^53 - 1, silently
inexact beyond, and happy to hold 12.5. `JSON.stringify` and `JSON.parse`
inherit all of that. A digest over a number that changed on the way is a
digest over something else.

## Decision

**Writing** (`encode` in `src/bridge.ts`, used for every value the SDK sends
to the module):

- A `number` is written only if it is a safe integer.
- A `bigint` is written as an integer of any size.
- A fraction, an unsafe integer, `NaN`, an infinity, `undefined`, a function,
  or an object that is not plain data throws `TypeError`, naming where.
  Nothing is rounded, and nothing is dropped the way `JSON.stringify` drops
  `undefined`.

**Reading** (`decode`): the module's JSON is parsed with `JSON.parse` and its
source text access. A whole number that is not a safe integer is returned as
a `bigint`, built from the digits as written.

**Bytes pass through.** JSON given as `Uint8Array` goes to the module as it
is. Only values given as JavaScript objects are encoded here.

Record fields and claim inputs follow the contract language, which writes
every number as text: `1250` and `1250n` both become `"1250"`.

## Why

A refusal at the call site is cheap. A rounded integer inside a signed
statement is not found until a verifier elsewhere disagrees.

## Cost

- Node.js 22 or later, for `JSON.parse` source text access.
- A caller with amounts as floats must convert them to whole units of the
  contract's scale first. 12.50 EUR at scale 2 is `1250`.
- Results may contain a `bigint` where a number is too large for `number`.
  `JSON.stringify` throws on a `bigint`; a caller who serializes results
  must handle it.
