//! The pairing PAKE's cross-language vectors: generated here, asserted by both ends.
//!
//! ## Why a golden file rather than a round trip
//!
//! Pairing is the one place where the client is written in a different language from the
//! daemon, and a PAKE has no error message for "we derived different keys": a wrong
//! derivation shows up as `pairing_failed`, which is exactly what a wrong code shows up as.
//! So the two implementations are pinned to the same bytes instead: this test *generates*
//! `packages/crypto/conformance/pairing-vectors.json` from the normative Rust construction,
//! and `packages/crypto/src/pairing.test.ts` asserts that the TypeScript implementation
//! reproduces every value in it.
//!
//! The file is normative, like `packages/protocol/conformance/vectors.json`: changing an
//! implementation without regenerating it fails here, and regenerating it without changing
//! the other end fails there. That is the property rule 3 of `AGENTS.md` asks for.
//!
//! ## What is pinned, and what is not
//!
//! Every case records the *scalars* the exchange used, not just its messages, so a mismatch
//! names the step that diverged (password hash, blinding, transcript, derivation) instead of
//! only reporting that two 32-byte strings differ. The ephemeral scalar comes from a fixed
//! RNG stream: `spake2` draws it through an injected RNG, and recording it is the difference
//! between a vector and an anecdote.
//!
//! `ClientPairing`/`DaemonPairing` wrap `spake2` and are covered by the round-trip tests in
//! `dr-dsh-crypto`'s unit tests and by the real-stack pairing smoke test
//! (`scripts/pwa-pairing-smoke.mjs`), which runs this same construction against a real
//! daemon; what this file pins is the bytes both languages must agree on.
//!
//! ## Regenerating
//!
//! ```sh
//! DR_WRITE_VECTORS=1 cargo test -p dr-dsh-crypto --test pairing_vectors
//! ```
//!
//! Read the diff before committing it: a regenerated vector is a claim that both ends still
//! agree, and the TypeScript side has not run yet at that point.

use std::path::PathBuf;

use dr_dsh_crypto::pairing::{
    PairingCode, derive_pairing_root, enrolment_confirmation, open_room_key, rendezvous_room,
    spake2_message_len, transport_root,
};
use dr_dsh_crypto::{DEVICE_PUBLIC_KEY_LEN, device::DevicePublicKey};

/// Where the normative corpus lives, relative to this crate.
const VECTORS_PATH: &str = "../../packages/crypto/conformance/pairing-vectors.json";

/// The environment variable that turns this test into the generator.
const WRITE_ENV: &str = "DR_WRITE_VECTORS";

/// The room key a device ends up serving from in every case.
///
/// A fixed value, so the corpus pins the receipt's *content* and not only its derivation: a
/// client that opens the receipt must recover exactly these bytes.
const SERVED_ROOM_KEY: [u8; 32] = [0x5a; 32];

/// The nonce the receipt is sealed with, so the sealed bytes are reproducible.
///
/// A real daemon draws a fresh one per receipt; a corpus with a random nonce in it would
/// change every time it was regenerated, and a vector that changes is not a vector.
const SEAL_NONCE: [u8; 12] = [
    0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c,
];

/// The device key every case enrols.
///
/// A published Ed25519 test key (RFC 8032 § 7.1, first vector), so the file contains a key
/// that is obviously not anyone's: a corpus that looks like it holds real key material is a
/// corpus somebody will treat as secret.
const DEVICE_PUBLIC_KEY: &str = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

type TestResult = Result<(), Box<dyn std::error::Error>>;

/// An RNG that returns a fixed stream.
///
/// `spake2` takes `impl RngCore + CryptoRng` precisely so a test can do this; the `CryptoRng`
/// marker is a promise about the *production* caller, and here the caller is a constant on
/// purpose.
struct FixedRng {
    stream: Vec<u8>,
    position: usize,
}

impl FixedRng {
    fn new(stream: &[u8]) -> Self {
        Self {
            stream: stream.to_vec(),
            position: 0,
        }
    }
}

impl rand_core::RngCore for FixedRng {
    fn next_u32(&mut self) -> u32 {
        let mut bytes = [0_u8; 4];
        self.fill_bytes(&mut bytes);
        u32::from_le_bytes(bytes)
    }

    fn next_u64(&mut self) -> u64 {
        let mut bytes = [0_u8; 8];
        self.fill_bytes(&mut bytes);
        u64::from_le_bytes(bytes)
    }

    fn fill_bytes(&mut self, destination: &mut [u8]) {
        for byte in destination.iter_mut() {
            // Wrapping rather than failing: a scalar is 64 bytes and the streams are 64
            // bytes, so this is reached only if an implementation starts consuming more,
            // and a repeating pattern makes that visible in the vector instead of a panic.
            *byte = self.stream[self.position % self.stream.len()];
            self.position += 1;
        }
    }

    fn try_fill_bytes(&mut self, destination: &mut [u8]) -> Result<(), rand_core::Error> {
        self.fill_bytes(destination);
        Ok(())
    }
}

impl rand_core::CryptoRng for FixedRng {}

/// One named case: a code and the two ephemeral scalar streams.
struct Case {
    name: &'static str,
    password: [u8; 5],
    client_stream: [u8; 64],
    daemon_stream: [u8; 64],
}

/// Turns bytes into lower-case hex.
fn hex(bytes: &[u8]) -> String {
    use core::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        // Writing into a String cannot fail; ignoring the result keeps this total.
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// The scalar the Ed25519 group derives from one 64-byte stream.
fn scalar_bytes(stream: &[u8; 64]) -> Vec<u8> {
    use spake2::Group as _;
    let scalar = spake2::Ed25519Group::random_scalar(&mut FixedRng::new(stream));
    scalar.as_bytes().to_vec()
}

/// The password-derived scalar, which both ends compute from the code alone.
fn password_scalar_bytes(password: &[u8]) -> Vec<u8> {
    use spake2::Group as _;
    spake2::Ed25519Group::hash_to_scalar(password)
        .as_bytes()
        .to_vec()
}

/// Runs one exchange and renders it as a vector.
fn vector(case: &Case) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    use spake2::{Ed25519Group, Identity, Password, Spake2};

    let code = PairingCode::from_secret(case.password);
    let password = Password::new(code.secret().as_slice());
    let id_client = Identity::new(b"dsh-remote/v1/pairing/client");
    let id_daemon = Identity::new(b"dsh-remote/v1/pairing/daemon");

    let (client, client_message) = Spake2::<Ed25519Group>::start_a_with_rng(
        &password,
        &id_client,
        &id_daemon,
        FixedRng::new(&case.client_stream),
    );
    let (daemon, daemon_message) = Spake2::<Ed25519Group>::start_b_with_rng(
        &password,
        &id_client,
        &id_daemon,
        FixedRng::new(&case.daemon_stream),
    );

    if client_message.len() != spake2_message_len() {
        return Err(format!(
            "a SPAKE2 message is {} bytes, got {}",
            spake2_message_len(),
            client_message.len()
        )
        .into());
    }

    // Both ends must land on the same key. If they do not, the vector would pin a
    // disagreement, and the TypeScript side could match one end and not the other.
    let client_key = client
        .finish(&daemon_message)
        .map_err(|error| format!("the client half failed: {error}"))?;
    let daemon_key = daemon
        .finish(&client_message)
        .map_err(|error| format!("the daemon half failed: {error}"))?;
    if client_key != daemon_key {
        return Err("the two halves derived different keys".into());
    }

    let raw_public_key = hex_to_bytes(DEVICE_PUBLIC_KEY)?;
    let public_key: [u8; DEVICE_PUBLIC_KEY_LEN] = raw_public_key
        .as_slice()
        .try_into()
        .map_err(|_| format!("the device key is not {DEVICE_PUBLIC_KEY_LEN} bytes"))?;
    // Parsed, not just carried: a corpus holding a key the daemon would refuse is a corpus
    // that documents an exchange which cannot happen.
    DevicePublicKey::from_bytes(&public_key)?;

    let confirm = enrolment_confirmation(&client_key, &public_key);
    let enrolment_key = derive_pairing_root(&client_key);

    // The receipt, made the way the daemon makes it: the served room key sealed under the
    // enrolment key and bound to the identity being enrolled. The *same* enrolment key as the
    // case's, so the corpus is one exchange rather than two that happen to agree.
    let sealed = dr_dsh_crypto::seal_room_key(
        enrolment_key.as_ref(),
        &public_key,
        &SERVED_ROOM_KEY,
        &SEAL_NONCE,
    );
    let opened = open_room_key(enrolment_key.as_ref(), &public_key, &sealed)?;
    if *opened != SERVED_ROOM_KEY {
        return Err("the receipt did not open to the room key that was sealed into it".into());
    }

    Ok(serde_json::json!({
        "name": case.name,
        "passwordHex": hex(&case.password),
        "passwordScalarHex": hex(&password_scalar_bytes(code.secret())),
        "clientRandomHex": hex(&case.client_stream),
        "clientScalarHex": hex(&scalar_bytes(&case.client_stream)),
        "clientMessageHex": hex(&client_message),
        "daemonRandomHex": hex(&case.daemon_stream),
        "daemonScalarHex": hex(&scalar_bytes(&case.daemon_stream)),
        "daemonMessageHex": hex(&daemon_message),
        "exchangedHex": hex(&client_key),
        "devicePublicKeyHex": hex(&public_key),
        "confirmHex": hex(&confirm),
        "enrolmentKeyHex": hex(enrolment_key.as_ref()),
        "roomKeyHex": hex(&SERVED_ROOM_KEY),
        "sealNonceHex": hex(&SEAL_NONCE),
        "sealedRoomKeyHex": hex(&sealed),
        "room": dr_dsh_crypto::room_id_for(&SERVED_ROOM_KEY),
        "rendezvousRoom": rendezvous_room(&code),
    }))
}

/// The whole corpus.
fn corpus() -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let cases = [
        Case {
            name: "a code drawn the way the daemon draws one",
            password: [0x7f, 0x3a, 0x91, 0x05, 0xc4],
            client_stream: stream(0x01),
            daemon_stream: stream(0x02),
        },
        Case {
            name: "an all-zero code, which is a legal 40-bit draw",
            password: [0x00, 0x00, 0x00, 0x00, 0x00],
            client_stream: stream(0x11),
            daemon_stream: stream(0x22),
        },
        Case {
            name: "the largest code the alphabet can display",
            password: [0xff, 0xff, 0xff, 0xff, 0xff],
            client_stream: stream(0x33),
            daemon_stream: stream(0x44),
        },
        Case {
            name: "a zero ephemeral scalar on both sides, which pins the degenerate point",
            password: [0x01, 0x02, 0x03, 0x04, 0x05],
            client_stream: [0x00; 64],
            daemon_stream: [0x00; 64],
        },
        Case {
            name: "ephemeral scalars at the top of the group order",
            password: [0xde, 0xad, 0xbe, 0xef, 0x01],
            client_stream: [0xff; 64],
            daemon_stream: [0xf0; 64],
        },
    ];

    let mut rendered = Vec::with_capacity(cases.len());
    for case in &cases {
        rendered.push(vector(case)?);
    }

    Ok(serde_json::json!({
        "$comment": "NORMATIVE cross-language vector corpus for the dr.dsh pairing PAKE \
                     (SPAKE2, Ed25519 group). Generated by \
                     crates/dr-dsh-crypto/tests/pairing_vectors.rs; asserted byte-for-byte by \
                     packages/crypto/src/pairing.test.ts. Both ends are pinned to these exact \
                     values, so regenerating this file is a protocol change: see \
                     docs/protocol.md 6.2 and AGENTS.md rule 3. Scalars are 32-byte \
                     little-endian; every other field is the byte string it names.",
        "cases": rendered,
        "transportRootHex": hex(&transport_root()),
    }))
}

/// A 64-byte stream that is not a constant, so a scalar derived from it is not degenerate.
fn stream(seed: u8) -> [u8; 64] {
    let mut out = [0_u8; 64];
    for (index, byte) in out.iter_mut().enumerate() {
        // A cheap mixing function, chosen so the two streams in a case differ everywhere and
        // no vector accidentally pins the all-zero scalar.
        *byte = seed
            .wrapping_mul(31)
            .wrapping_add((index as u8).wrapping_mul(17))
            .wrapping_add(0x5a);
    }
    out
}

/// Parses lower-case hex.
fn hex_to_bytes(text: &str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    if !text.len().is_multiple_of(2) {
        return Err("hex must have an even length".into());
    }
    let mut out = Vec::with_capacity(text.len() / 2);
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let pair = core::str::from_utf8(&bytes[index..index + 2])?;
        out.push(u8::from_str_radix(pair, 16)?);
        index += 2;
    }
    Ok(out)
}

#[test]
fn the_corpus_matches_the_typescript_side() -> TestResult {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(VECTORS_PATH);
    let generated = corpus()?;
    let rewrite = std::env::var(WRITE_ENV).is_ok_and(|value| value == "1");

    if rewrite || !path.exists() {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut rendered = serde_json::to_string_pretty(&generated)?;
        rendered.push('\n');
        std::fs::write(&path, rendered)?;
        eprintln!(
            "wrote {}{}",
            path.display(),
            if rewrite {
                ""
            } else {
                " (it did not exist; run the TypeScript tests before trusting it)"
            }
        );
        return Ok(());
    }

    let existing: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path)?)?;
    if existing != generated {
        return Err(format!(
            "{} is out of date. Regenerate it with `{WRITE_ENV}=1 cargo test -p dr-dsh-crypto \
             --test pairing_vectors`, then run the TypeScript tests: the corpus is shared, and \
             changing it means both ends changed.",
            path.display()
        )
        .into());
    }
    Ok(())
}
