# 0007. Signing authority is explicit and scoped

Status: accepted.

## Decision

- The SDK takes a `Signer` (a `keyId` and a `sign(bytes)` method), never a
  private key file. `Ed25519Signer` is an in-memory implementation for tests
  and development.
- Every signature is made under a `SigningAuthority`: one key, one issuer, one
  tenant, named sources. `EvidenceSource` refuses a system the authority does
  not name; `DecisionIssuer` requires the `wvp-decision` source.
- There is no ambient key, no environment variable and no default identity.

## Why

An agent process must not be able to produce, by accident or by default, a
statement that reads as the system of record's. The local check makes the
mistake loud. It is not the security boundary: a process can declare any
authority it likes. The boundary is the relying party's registry, and
`work.issue` checks against the issuer's registry before sealing anything.

## A limitation: the signer is synchronous

`Signer.sign` returns a `Uint8Array`, not a promise. Every KMS client in
JavaScript is asynchronous, so a production signer cannot be written against
this interface without blocking or signing ahead of the call.

It is synchronous in this release because the whole producing path
(`source.record`, `work.issue`) is, matching `verified-python`, and making it
asynchronous changes those signatures. An asynchronous signer with
asynchronous `record` and `issue` beside the synchronous ones is the first
API item on the [roadmap](../roadmap.md).

## Consequence

Setting up an evidence source takes four explicit values. That friction is
intended.
