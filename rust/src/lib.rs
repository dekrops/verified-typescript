// SPDX-License-Identifier: Apache-2.0

//! The WebAssembly module of `verified-typescript`: bindings to the public
//! Work Verification Protocol crates of `dekrops/verified-cli`.
//!
//! The surface is deliberately narrow. Every function takes bytes or text and
//! returns bytes or JSON text; no JavaScript object is interpreted here and
//! no protocol rule is decided on the JavaScript side. Canonical encoding,
//! digests, signature verification, contract evaluation, work-unit identity
//! and the thirteen package checks are the upstream crates', called directly.
//!
//! Errors that prevented an examination are thrown, as an `Error` whose
//! message is a code, a line feed, and the detail. Protocol outcomes,
//! refusals included, are returned as data.

mod evidence;
mod issue;
mod json;
mod report;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use ed25519_dalek::{Signer as _, SigningKey};
use verified_canonical::Value;
use verified_contract::Contract;
use verified_work_unit::{Identity, Scope, SecretKey};
use wasm_bindgen::prelude::*;

use crate::json::{digest, list, object, optional, read, text, texts};

/// The revision of `dekrops/verified-cli` the verification crates are built
/// from. Kept beside the pin in `Cargo.toml`; a test compares the two.
const UPSTREAM_REVISION: &str = "0d18dfb11b1849e89ecfb05aa33cddf2fd2d172a";

/// The DER encoding of an Ed25519 `SubjectPublicKeyInfo` up to the key.
const SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

/// An operation that could not be carried out. It crosses the boundary as
/// an `Error` whose message is the code, a line feed, and the detail.
#[derive(Debug)]
pub struct Failure {
    code: String,
    message: String,
}

impl From<Failure> for JsError {
    fn from(failure: Failure) -> Self {
        Self::new(&format!("{}\n{}", failure.code, failure.message))
    }
}

pub(crate) type Result<T> = std::result::Result<T, Failure>;
type Thrown<T> = std::result::Result<T, JsError>;

pub(crate) fn fail(code: &str, message: impl Into<String>) -> Failure {
    Failure {
        code: code.to_owned(),
        message: message.into(),
    }
}

/// Verifies a package. Returns the outcome as JSON text.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn verify(
    package: &[u8],
    trust: Option<Vec<u8>>,
    protocol: Option<String>,
    expect_tenant: Option<String>,
    expect_contract: Option<String>,
    expect_claim: Option<String>,
    record: Option<Vec<u8>>,
    max_bytes: Option<u32>,
) -> Thrown<String> {
    let trust = trust.as_deref().map(report::trust).transpose()?;
    let record = record
        .as_deref()
        .map(|record| read(record, "work record", "WORK_RECORD"))
        .transpose()?;
    let request = report::Request {
        trust: trust.as_ref(),
        protocol: protocol.as_deref(),
        expect_tenant: expect_tenant.as_deref(),
        expect_contract: expect_contract.as_deref(),
        expect_claim: expect_claim.as_deref(),
        record: record.as_ref(),
        max_bytes: max_bytes.map(|bytes| bytes as usize),
    };
    Ok(report::verify(package, &request)?.to_canonical_string())
}

/// The `verified-json-v1` canonical text of a JSON text.
#[wasm_bindgen]
pub fn canonicalize(input: &[u8]) -> Thrown<String> {
    let value = read(input, "input", "MALFORMED_JSON")?;
    Ok(value.to_canonical_string())
}

/// The SHA-256, in hexadecimal, of a JSON text's canonical form.
#[wasm_bindgen]
pub fn canonical_digest(input: &[u8]) -> Thrown<String> {
    Ok(read(input, "input", "MALFORMED_JSON")?.digest().to_hex())
}

/// The SHA-256, in hexadecimal, of exact bytes. No canonicalization.
#[wasm_bindgen]
#[must_use]
pub fn digest_bytes(input: &[u8]) -> String {
    verified_canonical::Sha256Digest::of(input).to_hex()
}

/// Checks a trust registry and returns its keys, as the verifier reads them.
#[wasm_bindgen]
pub fn trust_registry(registry: &[u8]) -> Thrown<String> {
    let trust = report::trust(registry)?;
    let keys = trust.registry().keys().iter().map(|key| {
        object([
            ("keyId", text(&key.key_id)),
            ("algorithm", text(&key.algorithm)),
            ("publicKey", text(&key.public_key)),
            ("issuer", text(&key.issuer)),
            ("tenant", text(&key.tenant)),
            ("sources", texts(&key.sources)),
            ("validFrom", text(&key.valid_from.to_string())),
            (
                "validUntil",
                optional(key.valid_until.map(|at| at.to_string()).as_deref()),
            ),
            (
                "revokedAt",
                optional(key.revoked_at.map(|at| at.to_string()).as_deref()),
            ),
        ])
    });
    Ok(object([("keys", list(keys))]).to_canonical_string())
}

/// Reads a Work Contract Language 1 contract and returns what identifies it.
#[wasm_bindgen]
pub fn contract_summary(contract: &[u8]) -> Thrown<String> {
    let value = read(contract, "contract", "MALFORMED_JSON")?;
    let contract = Contract::read(&value)
        .map_err(|refusal| fail(refusal.as_str(), "the contract was refused"))?;
    Ok(object([
        ("id", text(contract.id())),
        ("version", text(contract.version())),
        ("language", text(contract.language())),
        ("semantics", text(contract.semantics())),
        ("digest", digest(&value.digest())),
        ("canonical", text(&value.to_canonical_string())),
    ])
    .to_canonical_string())
}

/// Evaluates a contract against an environment: the language's result
/// object, or `{ "refused": code }`. An evaluation is not a verification.
#[wasm_bindgen]
pub fn evaluate_contract(contract: &[u8], environment: &[u8]) -> Thrown<String> {
    let contract = read(contract, "contract", "MALFORMED_JSON")?;
    let environment = read(environment, "environment", "MALFORMED_JSON")?;
    let refused = |code: &str| object([("refused", text(code))]).to_canonical_string();
    let contract = match Contract::read(&contract) {
        Ok(contract) => contract,
        Err(refusal) => return Ok(refused(refusal.as_str())),
    };
    Ok(match contract.evaluate(&environment) {
        Ok(outcome) => outcome.to_value().to_canonical_string(),
        Err(refusal) => refused(refusal.as_str()),
    })
}

/// A work unit's identity and, given the tenant's key, its nullifier and the
/// key's commitment. Give `values` (in the scope's order) or claim `inputs`.
#[wasm_bindgen]
pub fn work_unit(
    tenant: &str,
    scope: &[u8],
    values: Option<Vec<u8>>,
    inputs: Option<Vec<u8>>,
    key: Option<Vec<u8>>,
) -> Thrown<String> {
    let unit = |error: verified_work_unit::Error| fail("WORK_UNIT", error.to_string());
    let scope = Scope::from_value(&read(scope, "scope", "WORK_UNIT")?).map_err(unit)?;
    let identity = match (values.as_deref(), inputs.as_deref()) {
        (Some(values), None) => {
            let values = read(values, "values", "WORK_UNIT")?;
            let values = values
                .as_array()
                .ok_or_else(|| fail("WORK_UNIT", "values is not a list"))?;
            Identity::new(tenant, &scope, values).map_err(unit)?
        }
        (None, Some(inputs)) => {
            Identity::of_claim(tenant, &scope, &read(inputs, "inputs", "WORK_UNIT")?)
                .map_err(unit)?
        }
        _ => return Err(fail("USAGE", "give exactly one of values and inputs").into()),
    };
    let mut result = verified_canonical::Object::new();
    result.insert("version", text(verified_work_unit::VERSION));
    result.insert("identity", text(&identity.canonical()));
    if let Some(key) = key.as_deref() {
        let key = secret_key(key)?;
        result.insert("nullifier", key.nullifier(&identity).to_value());
        result.insert("keyCommitment", digest(&key.commitment()));
    }
    Ok(Value::Object(result).to_canonical_string())
}

fn secret_key(key: &[u8]) -> Result<SecretKey> {
    let bytes: [u8; 32] = key
        .try_into()
        .map_err(|_| fail("USAGE", "a work-unit key is exactly 32 bytes"))?;
    Ok(SecretKey::from_bytes(bytes))
}

fn signing_key(seed: &[u8]) -> Result<SigningKey> {
    let bytes: [u8; 32] = seed
        .try_into()
        .map_err(|_| fail("USAGE", "an Ed25519 seed is exactly 32 bytes"))?;
    Ok(SigningKey::from_bytes(&bytes))
}

/// The public key of an Ed25519 seed, as a trust registry spells it: base64
/// of the DER `SubjectPublicKeyInfo`.
#[wasm_bindgen]
pub fn ed25519_public_key(seed: &[u8]) -> Thrown<String> {
    let mut der = SPKI_PREFIX.to_vec();
    der.extend_from_slice(signing_key(seed)?.verifying_key().as_bytes());
    Ok(STANDARD.encode(der))
}

/// An Ed25519 signature over `message`, in standard base64.
#[wasm_bindgen]
pub fn ed25519_sign(seed: &[u8], message: &[u8]) -> Thrown<String> {
    Ok(STANDARD.encode(signing_key(seed)?.sign(message).to_bytes()))
}

/// The bytes a signer signs for an evidence statement: the statement domain
/// followed by the statement's canonical text.
#[wasm_bindgen]
pub fn statement_signing_input(statement: &[u8]) -> Thrown<Vec<u8>> {
    let statement = read(statement, "statement", "MALFORMED_JSON")?;
    let input = verified_protocol::STATEMENT_DOMAIN.signing_input(&statement);
    Ok(input)
}

/// The digest of an evidence body: what a statement's `payload` states.
#[wasm_bindgen]
pub fn payload_digest(body: &[u8]) -> Thrown<String> {
    Ok(issue::payload(&read(body, "body", "MALFORMED_JSON")?).to_hex())
}

/// Reads one signed statement and, given a registry, authenticates it.
#[wasm_bindgen]
pub fn check_statement(signed: &[u8], trust: Option<Vec<u8>>) -> Thrown<String> {
    let trust = trust.as_deref().map(report::trust).transpose()?;
    Ok(evidence::statement(signed, trust.as_ref()).to_canonical_string())
}

/// Verifies that statements are consecutive steps of one issuer's stream.
#[wasm_bindgen]
pub fn verify_chain(statements: &[u8], trust: &[u8], anchor: Option<Vec<u8>>) -> Thrown<String> {
    let trust = report::trust(trust)?;
    let statements = read(statements, "statements", "MALFORMED_JSON")?;
    let anchor = anchor
        .as_deref()
        .map(|anchor| read(anchor, "anchor", "MALFORMED_JSON"))
        .transpose()?;
    Ok(evidence::chain(&statements, &trust, anchor.as_ref())?.to_canonical_string())
}

/// Admits statements, each with its body, as the evidence of one claim.
#[wasm_bindgen]
pub fn admit(
    tenant: &str,
    claimed: &[u8],
    evidence: &[u8],
    trust: &[u8],
    manifest: Option<Vec<u8>>,
) -> Thrown<String> {
    let trust = report::trust(trust)?;
    let claimed = read(claimed, "claimed", "MALFORMED_JSON")?;
    let evidence_value = read(evidence, "evidence", "MALFORMED_JSON")?;
    let manifest = manifest
        .as_deref()
        .map(|manifest| read(manifest, "manifest", "MALFORMED_JSON"))
        .transpose()?;
    Ok(
        evidence::admission(tenant, &claimed, &evidence_value, &trust, manifest.as_ref())?
            .to_canonical_string(),
    )
}

/// The package text with its report: `{ "package": text, "report": … }`.
fn issued((package, report): (String, Value)) -> String {
    object([("package", text(&package)), ("report", report)]).to_canonical_string()
}

/// Assembles a `wvp-0.2` package and verifies it under `trust`. Returns the
/// package text and the report, or throws if the verifier would not
/// reproduce the package's decision completely.
#[wasm_bindgen]
pub fn assemble_package(parts: &[u8], trust: &[u8]) -> Thrown<String> {
    let trust = report::trust(trust)?;
    Ok(issued(issue::assemble(parts, &trust)?))
}

/// The bytes an issuer signs to stand behind a package's decision.
#[wasm_bindgen]
pub fn decision_signing_input(package: &[u8]) -> Thrown<Vec<u8>> {
    Ok(issue::decision_signing_input(package)?)
}

/// Adds an issuer signature that must count under `trust`.
#[wasm_bindgen]
pub fn attach_issuer_signature(
    package: &[u8],
    key_id: &str,
    encoded: &str,
    trust: &[u8],
) -> Thrown<String> {
    let trust = report::trust(trust)?;
    Ok(issued(issue::attach_issuer_signature(
        package, key_id, encoded, &trust,
    )?))
}

/// What this build is made of.
#[wasm_bindgen]
#[must_use]
pub fn build_info() -> String {
    object([
        ("upstream", text("https://github.com/dekrops/verified-cli")),
        ("upstreamRevision", text(UPSTREAM_REVISION)),
        (
            "verifier",
            text(&format!("verified-verifier-{UPSTREAM_REVISION}")),
        ),
        ("protocols", texts(&["wvp-0.1", "wvp-0.2"])),
        (
            "canonicalVersion",
            text(verified_canonical::CANONICAL_VERSION),
        ),
        ("contractLanguage", text(verified_contract::LANGUAGE)),
        ("contractSemantics", text(verified_contract::SEMANTICS)),
        ("workUnitVersion", text(verified_work_unit::VERSION)),
        (
            "statementProtocol",
            text(verified_protocol::STATEMENT_PROTOCOL),
        ),
        ("version", text(env!("CARGO_PKG_VERSION"))),
    ])
    .to_canonical_string()
}
