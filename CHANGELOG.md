# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-18

### Added

- `readHistory`: reads work relations (work relation v1, a draft) against
  the records given with them, under your trust registry. A relation is a
  signed statement by which a ledger or an application says how the records
  of one unit of work are related. Each relation is reported as `CHECKED`,
  `STATED`, `CONTRADICTED` or `REFUSED`, and reading verifies no record. The
  rules are upstream's `verified-history` crate; the 41 cases of the
  published corpus are reproduced.
- `EvidenceSource.group`: signs a source's statement that packages or work
  records belong to one group (the `groups` relation), optionally chained in
  a stream so that a reader can see none is missing. `packageReference` and
  `workRecordReference` name the members. The statement is laid out by
  upstream's producer, which refuses a relation a reader would refuse.

- `replayDerivation`: computes a presented *recomputed authorization* again
  from its evidence, under your trust registry, and compares (a draft,
  proposed in RFC 0005 and not part of the protocol). A replay package
  carries a contract, signed statements and the result a first verifier
  arrived at; nothing presented is believed. A `DerivationReplay` reports
  whether the result was reproduced, each authorization's outcome with
  Cedar's own answer kept apart from it, the contract's decision, and which
  requirements depend on which derivations. The rules are upstream's
  `verified-derivation` crate, which links the Cedar policy engine: the
  WebAssembly module grows from about 0.5 MB to 3.7 MB, and the engine's
  time and memory are not bounded.

### Changed

- The version is 0.2.0. The 0.1.0 package on npm embeds `verified-cli`
  `v0.1.1`; the version string now changes when the embedded verifier does, and
  `buildInfo().upstreamRevision` names it.
- The WebAssembly module is built on `dekrops/verified-cli` `v0.1.5`
  (`d9e99f5`), and the conformance corpus is `dekrops/wvp` at `46ccd1d`.
  Both upstream releases since `v0.1.1` only added to the library API;
  nothing bound before changes.

### Fixed

- The package now carries `THIRD-PARTY-LICENSES.md`: the licenses and notices
  of the Rust crates the WebAssembly module links, generated from
  `rust/Cargo.lock` and checked in CI. The 0.1.0 package lacked them.
- `NOTICE` and the package metadata name the copyright holder as Krops GmbH,
  as `dekrops/verified-cli` and `dekrops/wvp` do.

## [0.1.0] - 2026-10-11

First developer preview.

### Added

- Offline verification of `wvp-0.1` and `wvp-0.2` packages: `Verifier`,
  `VerificationResult`, `Expectations`, `WorkPackage`, `WorkRecord`.
- Trust registries and contracts: `TrustRegistry`, `WorkContract`.
- Canonical encoding and digests: `canonicalize`, `Digest`.
- Evidence with explicit, scoped signing authority: `EvidenceSource`,
  `SigningAuthority`, `Signer`, `Ed25519Signer`, `SignedEvidence`.
- Work lifecycle and `wvp-0.2` issuing: `Work`, `Claim`, `IssuedWork`,
  `DecisionIssuer`.
- Work-unit identity and nullifiers: `workUnit`.
- Instrumentation, in `verified-typescript/instrumentation`: `WorkSession`,
  `verifiedTool`, `ExecutionTrace`.
- File helpers, in `verified-typescript/node`.
- WebAssembly module over `dekrops/verified-cli` `v0.1.1` (`0d18dfb`), the
  tag the Python SDK binds; packages are issued by its
  `verified_verifier::issue`.
- Conformance suite against `dekrops/wvp` at `c7c9de2`.
