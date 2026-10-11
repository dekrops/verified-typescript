# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

First developer preview. Not published to npm.

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
