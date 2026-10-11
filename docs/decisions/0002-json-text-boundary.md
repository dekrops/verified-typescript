# 0002. Bytes and JSON text across the native boundary

Status: accepted.

## Decision

The module's functions take bytes or strings and return bytes or JSON text.
Rust never walks JavaScript objects; TypeScript never builds protocol values.
The JSON returned by `verify` uses upstream's documented `verify --json`
member names, produced by the upstream library itself (`Report::to_value`).

## Why

- The protocol's encoding has no floats, arbitrary-size integers and its own
  key order. Converting JavaScript objects in Rust would need a second mapping
  of those rules. Text parsed by `verified-canonical` has exactly one.
- The facade is the one `verified-python` uses, function for function. Two
  SDKs, one surface to review.
- One documented output shape for the command and for SDKs.

## Cost

A serialization round trip per call, and a copy of the input into the
module's memory. Typed errors travel as a code and a message in one string,
split in `src/bridge.ts`.
