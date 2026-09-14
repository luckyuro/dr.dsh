//! The pairing exchange: two round trips over a relay, keyed by a typed code.
//!
//! ## Why pairing needs the relay at all
//!
//! The client is typically not on the same network as the daemon — that is the entire
//! product. So the SPAKE2 exchange has to travel through the relay, which means the relay
//! sees it. That is exactly why the code is a PAKE secret rather than a key: the relay sees
//! two opaque messages and derives nothing, and a relay that records them cannot mount an
//! offline attack against 40 bits.
//!
//! ## Why the code derives the room
//!
//! The two ends have to find each other without the daemon telling the relay "the client
//! with this code will arrive". A room derived from the code gives them a meeting point that
//! the relay cannot correlate with the room they will use afterwards, and one that expires
//! with the code: derive the room from the same secret, and a stale code simply parks in a
//! room nobody is listening on.
//!
//! The derivation is one-way (HKDF), so a relay that logs room ids — or an attacker who
//! enumerates them — learns nothing that helps guess the code. It is nonetheless only
//! 40 bits of input: the room id is not a secret to be relied on, and it is not what
//! authenticates the exchange. SPAKE2 is.
//!
//! ## Message shapes
//!
//! ```json
//! // client → daemon
//! { "type": "pair_begin", "spake2": "<b64u>" }
//! // daemon → client
//! { "type": "pair_begin_ack", "spake2": "<b64u>" }
//! // client → daemon
//! { "type": "pair_finish", "device_name": "...", "device_public_key": "<b64u>", "confirm": "<b64u>" }
//! // daemon → client
//! { "type": "pair_accept", "device_id": "<b64u>", "root_key": "<b64u>", "room": "<b64u>" }
//! // daemon → client, at any point
//! { "type": "pair_reject", "reason": "<机器可读原因>" }
//! ```
//!
//! These are carrier-level control messages on the pairing room, before any session exists:
//! the room carries four messages and then closes, and none of them is a session frame. The
//! session protocol's own control plane (stream 0, sealed) is not involved, because there is
//! no shared key yet — that is the whole point of pairing.

use std::time::Duration;

use dr_dsh_crypto::device::{DEVICE_PUBLIC_KEY_LEN, DevicePublicKey, DeviceSecretKey};
use dr_dsh_crypto::pairing::{
    ClientPairing, DaemonPairing, PairingCode, PairingError, spake2_message_len,
};
use dr_dsh_crypto::registry::{DeviceRegistry, RegistryError};
use dr_dsh_crypto::room_id_for;

use crate::transport::Transport;

/// How long either side waits for the peer's next message, by default.
///
/// A pairing that stalls must end, because a live code plus a parked daemon is an invitation
/// to keep guessing. This is a per-message bound, not the code's lifetime.
pub const DEFAULT_EXCHANGE_TIMEOUT: Duration = Duration::from_secs(30);

/// Why pairing failed.
#[derive(Debug, thiserror::Error)]
pub enum ExchangeError {
    /// The carrier could not be reached or failed mid-exchange.
    #[error("the pairing carrier failed: {0}")]
    Transport(String),
    /// The peer's message was not usable.
    #[error("the peer's {step} message was not usable: {reason}")]
    Malformed {
        /// Which step of the exchange.
        step: &'static str,
        /// What was wrong.
        reason: String,
    },
    /// The peer never answered in time.
    #[error("the peer did not answer the {step} step in time")]
    Timeout {
        /// Which step was being awaited.
        step: &'static str,
    },
    /// Pairing itself refused the attempt.
    #[error(transparent)]
    Pairing(#[from] PairingError),
    /// The registry could not be updated.
    #[error(transparent)]
    Registry(#[from] RegistryError),
    /// A device key was not usable.
    #[error("the device key is not usable: {0}")]
    Device(#[from] dr_dsh_crypto::DeviceError),
    /// The code handed to the client does not match the displayed form.
    #[error("the pairing code is not usable: {0}")]
    BadCode(String),
    /// The daemon refused the attempt, and said why in its own words.
    #[error("the daemon refused the pairing: {0}")]
    Refused(String),
}

/// Turns a displayed code back into its bytes.
///
/// Parsing the *display* form rather than accepting raw bytes is deliberate: the only thing a
/// human can transport is the displayed form, so accepting anything else would mean the
/// daemon and the client could silently disagree about what was typed.
///
/// # Errors
///
/// Returns [`ExchangeError::BadCode`] when the text is not a code this daemon could have
/// displayed.
pub fn parse_displayed_code(text: &str) -> Result<PairingCode, ExchangeError> {
    const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let cleaned: Vec<char> = text
        .chars()
        .filter(|c| *c != '-' && !c.is_whitespace())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if !cleaned.len().is_multiple_of(2) {
        return Err(ExchangeError::BadCode(
            "a code has an even number of symbols".to_owned(),
        ));
    }
    let mut secret = Vec::with_capacity(cleaned.len() / 2);
    for pair in cleaned.chunks(2) {
        let low = index_in(ALPHABET, pair[0])?;
        let high = index_in(ALPHABET, pair[1])?;
        secret.push(low | (high << 5));
    }
    let secret: [u8; dr_dsh_crypto::PAIRING_SECRET_LEN] = secret.try_into().map_err(|_| {
        ExchangeError::BadCode(format!(
            "a code carries {} bytes, got {}",
            dr_dsh_crypto::PAIRING_SECRET_LEN,
            cleaned.len() / 2
        ))
    })?;
    Ok(PairingCode::from_secret(secret))
}

fn index_in(alphabet: &[u8; 32], character: char) -> Result<u8, ExchangeError> {
    // Crockford-style decoding folds the characters the alphabet omits onto the digits they
    // look like, so a user who typed `O` for `0` is not punished for the alphabet's choice.
    let folded = match character {
        'I' | 'L' => '1',
        'O' => '0',
        'U' => 'V',
        other => other,
    };
    alphabet
        .iter()
        .position(|candidate| char::from(*candidate) == folded)
        .map(|index| index as u8)
        .ok_or_else(|| ExchangeError::BadCode(format!("{character:?} is not in the alphabet")))
}

/// The room a pairing exchange happens in, derived from the code.
///
/// Separate from the room the daemon will serve: the pairing room is a rendezvous that a
/// relay can log without learning anything it can reuse, and it stops being interesting the
/// moment the code expires.
#[must_use]
pub fn pairing_room(code: &PairingCode) -> String {
    dr_dsh_crypto::pairing::rendezvous_room(code)
}

/// The provisional root every pairing room's frames are sealed under.
///
/// The derivation itself lives in `dr-dsh-crypto` (with the other key derivation), because the
/// browser client has to reach the same value and the cross-language vectors have to pin it.
/// This wrapper stays because it is the daemon's seam: everything below reads one name.
fn pairing_root() -> [u8; dr_dsh_crypto::SESSION_KEY_LEN] {
    dr_dsh_crypto::pairing::transport_root()
}

/// The sealing key a pairing room's frames use, which is the same for every pairing.
#[must_use]
pub fn pairing_root_for_test(_code: &PairingCode) -> [u8; dr_dsh_crypto::SESSION_KEY_LEN] {
    pairing_root()
}

/// What the daemon learned from a successful enrolment.
#[derive(Debug)]
pub struct Enrolment {
    /// The device's id, for the audit line and for the operator to act on.
    pub device_id: String,
    /// The label the device supplied.
    pub label: String,
}

/// What the client learned from a successful enrolment.
#[derive(Debug)]
pub struct Enrolled {
    /// The identity the client must keep.
    pub identity: DeviceSecretKey,
    /// The device id the daemon knows it by.
    pub device_id: String,
    /// The room root key, which is the client's only copy of it.
    pub root_key: [u8; dr_dsh_crypto::SESSION_KEY_LEN],
    /// The room the daemon serves.
    pub room: String,
}

/// The message the client sends last: its identity and its proof.
#[derive(serde::Serialize, serde::Deserialize)]
struct PairFinish {
    device_name: String,
    device_public_key: Vec<u8>,
    confirm: Vec<u8>,
}

/// The daemon's acceptance.
#[derive(serde::Serialize, serde::Deserialize)]
struct PairAccept {
    #[serde(rename = "type")]
    kind: String,
    device_id: String,
    root_key: String,
    room: String,
}

/// The daemon's refusal.
#[derive(serde::Serialize, serde::Deserialize)]
struct PairRefusal {
    #[serde(rename = "type")]
    kind: String,
    reason: String,
}

async fn send(transport: &mut Transport, payload: &[u8]) -> Result<(), ExchangeError> {
    transport
        .send(dr_dsh_proto::CONTROL_STREAM_ID, payload)
        .await
        .map_err(|error| ExchangeError::Transport(error.to_string()))
}

async fn send_json<T: serde::Serialize>(
    transport: &mut Transport,
    value: &T,
) -> Result<(), ExchangeError> {
    let encoded = serde_json::to_vec(value).map_err(|error| ExchangeError::Malformed {
        step: "send",
        reason: error.to_string(),
    })?;
    send(transport, &encoded).await
}

async fn receive(
    transport: &mut Transport,
    step: &'static str,
    deadline: tokio::time::Instant,
) -> Result<Vec<u8>, ExchangeError> {
    let inbound = tokio::time::timeout_at(deadline, transport.next_inbound())
        .await
        .map_err(|_| ExchangeError::Timeout { step })?
        .map_err(|error| ExchangeError::Transport(error.to_string()))?;
    Ok(inbound.payload)
}

fn expect_spake2_len(payload: &[u8], step: &'static str) -> Result<(), ExchangeError> {
    if payload.len() == spake2_message_len() {
        return Ok(());
    }
    Err(ExchangeError::Malformed {
        step,
        reason: format!(
            "a SPAKE2 message is {} bytes, got {}",
            spake2_message_len(),
            payload.len()
        ),
    })
}

/// Runs the daemon's half of a pairing exchange against a client on the same relay.
///
/// The four pairing messages travel as **carrier frames**, sealed under the provisional
/// session (all-zero salt) — the same construction the real handshake uses for its salt. That
/// is not decoration: the relay validates every binary frame against the carrier header and
/// closes a peer that sends text on the data path, so an exchange spoken as raw JSON never
/// reaches the other side at all. Speaking the carrier also means the pairing room carries the
/// same shape of traffic as a served room, which is one less thing a relay can distinguish.
///
/// The provisional session proves only that both ends know the code-derived rendezvous, which
/// is not a secret. SPAKE2 is what authenticates the exchange.
///
/// # Errors
///
/// Returns [`ExchangeError`] for a transport failure, a malformed or timed-out exchange, or a
/// pairing refusal. Every variant is safe to show an operator; none contains key material.
pub async fn run_daemon_side(
    relay_url: &str,
    code: &PairingCode,
    mut registry: DeviceRegistry,
    registry_path: &std::path::Path,
    served_root: &[u8; dr_dsh_crypto::SESSION_KEY_LEN],
    timeout: Duration,
) -> Result<(Enrolment, DeviceRegistry), ExchangeError> {
    let room = pairing_room(code);
    let mut transport = Transport::dial(relay_url, &room, &pairing_root())
        .await
        .map_err(|error| ExchangeError::Transport(error.to_string()))?;

    // The whole wait for a client is bounded, not just each message. `establish` is what
    // blocks until somebody arrives, so a deadline applied only to the reads after it would
    // leave the common case — nobody redeems the code — waiting forever. A pairing command
    // that never returns is worse than one that fails: the user cannot tell it apart from a
    // hang, and the daemon sits in a rendezvous nobody is coming to.
    let deadline = tokio::time::Instant::now() + timeout;
    // The client offers a connection salt as its first frame, exactly as it does on a served
    // room. A pairing exchange has no use for the salt's session, but consuming it keeps one
    // handshake shape for both and keeps `establish` the only reader of that frame.
    tokio::time::timeout_at(deadline, transport.establish())
        .await
        .map_err(|_| ExchangeError::Timeout { step: "establish" })?
        .map_err(|error| ExchangeError::Transport(error.to_string()))?;

    let (pairing, daemon_message) = DaemonPairing::begin(code);
    send(&mut transport, &daemon_message).await?;

    let peer_message = receive(&mut transport, "pair_begin", deadline).await?;
    expect_spake2_len(&peer_message, "pair_begin")?;

    let finish = receive(&mut transport, "pair_finish", deadline).await?;
    let finish: PairFinish =
        serde_json::from_slice(&finish).map_err(|error| ExchangeError::Malformed {
            step: "pair_finish",
            reason: error.to_string(),
        })?;
    let public_key: [u8; DEVICE_PUBLIC_KEY_LEN] = finish
        .device_public_key
        .as_slice()
        .try_into()
        .map_err(|_| ExchangeError::Malformed {
            step: "pair_finish",
            reason: format!("a device key is {DEVICE_PUBLIC_KEY_LEN} bytes"),
        })?;

    let paired = match pairing.finish(&peer_message, &public_key, &finish.confirm) {
        Ok(paired) => paired,
        Err(error) => {
            // The refusal is sent and the exchange ends. The reason is deliberately coarse:
            // telling a guesser which half of their attempt was right is free information.
            let reason = match error {
                PairingError::ConfirmationFailed | PairingError::CodeMismatch => "pairing_failed",
                _ => "malformed",
            };
            let _ = send_json(
                &mut transport,
                &PairRefusal {
                    kind: "pair_reject".to_owned(),
                    reason: reason.to_owned(),
                },
            )
            .await;
            let _ = transport.close().await;
            return Err(ExchangeError::Pairing(error));
        }
    };

    let label = finish.device_name;
    registry.enrol(DevicePublicKey::from_bytes(&public_key)?, label.clone());
    registry.save(registry_path)?;
    // The receipt carries the room key **the daemon serves**, sealed under the key the PAKE
    // produced. Announcing the PAKE-derived key instead — which is what this did — left every
    // freshly paired device dialling a room nobody serves, and announcing the served key in the
    // clear would hand it to the relay, whose view of this room is not confidential (its
    // transport root is a published constant). See `dr_dsh_crypto::pairing::seal_room_key`.
    let sealed_room_key = paired.seal_room_key(served_root);
    let device_id = paired.device_id().to_base64url();

    send_json(
        &mut transport,
        &PairAccept {
            kind: "pair_accept".to_owned(),
            device_id: device_id.clone(),
            root_key: encode_base64(&sealed_room_key),
            room: room_id_for(served_root),
        },
    )
    .await?;
    let _ = transport.close().await;

    Ok((Enrolment { device_id, label }, registry))
}

/// Runs the client's half of a pairing exchange.
///
/// A reference client, not a UI: the PWA cannot run SPAKE2 (see `dr_dsh_crypto::pairing`), so
/// this exists so the daemon's half is tested against something that is not itself, and so a
/// native client has an implementation to copy.
///
/// # Errors
///
/// Returns [`ExchangeError`] for a transport failure, a malformed or timed-out exchange, or a
/// refusal by the daemon.
pub async fn run_client_side(
    relay_url: &str,
    code: &PairingCode,
    device_name: &str,
    timeout: Duration,
) -> Result<Enrolled, ExchangeError> {
    run_client_side_at(
        relay_url,
        code,
        &pairing_room(code),
        &pairing_root(),
        device_name,
        timeout,
    )
    .await
}

/// Runs the client's half against an explicitly named rendezvous room.
///
/// The room, the room's sealing key, and the PAKE secret are separate inputs on purpose. The
/// room is a *rendezvous* — two ends have to agree on where to meet — while the code is the
/// *password* they prove knowledge of. Deriving the room from the code makes the common case a
/// single input, but a client holding the wrong code must still be able to reach the room and
/// speak to the daemon, or a wrong attempt would fail as "nobody is there" instead of "that
/// code is wrong" — and the property this whole design rests on would be untestable.
///
/// # Errors
///
/// Returns [`ExchangeError`] for a transport failure, a malformed or timed-out exchange, or a
/// refusal by the daemon.
pub async fn run_client_side_at(
    relay_url: &str,
    code: &PairingCode,
    room: &str,
    room_root: &[u8; dr_dsh_crypto::SESSION_KEY_LEN],
    device_name: &str,
    timeout: Duration,
) -> Result<Enrolled, ExchangeError> {
    let room = room.to_owned();
    let deadline = tokio::time::Instant::now() + timeout;
    let mut transport = Transport::join(relay_url, &room, room_root)
        .await
        .map_err(|error| ExchangeError::Transport(error.to_string()))?;
    // The client speaks first with the salt, as on a served room; `join` already offered it.
    let daemon_message = receive(&mut transport, "pair_begin_ack", deadline).await?;
    expect_spake2_len(&daemon_message, "pair_begin_ack")?;

    let (client, client_message) = ClientPairing::begin(code);
    send(&mut transport, &client_message).await?;

    let identity = DeviceSecretKey::generate();
    let enrolment = client.finish(&daemon_message, &identity)?;
    send_json(
        &mut transport,
        &PairFinish {
            device_name: device_name.to_owned(),
            device_public_key: enrolment.public_key.to_vec(),
            confirm: enrolment.confirm.clone(),
        },
    )
    .await?;

    let accept = receive(&mut transport, "pair_accept", deadline).await?;
    let accept: PairAccept = match serde_json::from_slice(&accept) {
        Ok(accept) => accept,
        Err(_) => {
            // A refusal is not a transport failure: it is the daemon saying no, and the
            // caller needs to see that rather than a parse error.
            if let Ok(refusal) = serde_json::from_slice::<PairRefusal>(&accept) {
                return Err(ExchangeError::Refused(refusal.reason));
            }
            return Err(ExchangeError::Malformed {
                step: "pair_accept",
                reason: "not a pairing acceptance".to_owned(),
            });
        }
    };
    let _ = transport.close().await;

    // The receipt is sealed under the enrolment key, so a relay — which can read this room,
    // because its transport root is a published constant — cannot learn the room key from it.
    let root_key = {
        let sealed = decode_base64(&accept.root_key, "pair_accept")?;
        let opened = dr_dsh_crypto::open_room_key(
            enrolment.enrolment_key(),
            &enrolment.public_key,
            &sealed,
        )?;
        *opened
    };

    // The room the key derives must equal the one the daemon announced. If they disagree the
    // client would dial a room nobody serves and see "no daemon is serving this room" forever,
    // with nothing to point at; catching it here keeps the cause visible.
    if room_id_for(&root_key) != accept.room {
        return Err(ExchangeError::Malformed {
            step: "pair_accept",
            reason: "the announced room is not the one the room key derives".to_owned(),
        });
    }

    Ok(Enrolled {
        identity,
        device_id: accept.device_id,
        root_key,
        room: accept.room,
    })
}

fn encode_base64(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn decode_base64(text: &str, step: &'static str) -> Result<Vec<u8>, ExchangeError> {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(text)
        .map_err(|error| ExchangeError::Malformed {
            step,
            reason: format!("not base64url: {error}"),
        })
}
