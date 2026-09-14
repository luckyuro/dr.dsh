//! # dr-dsh-crypto — end-to-end encryption for dr.dsh
//!
//! Everything in this crate exists to make one sentence true: **only a paired
//! client and the local daemon can read session content, and the relay cannot.**
//! The relay does not link this crate (ADR-0002), so that claim is enforced by
//! the dependency graph rather than by review.
//!
//! ## Shapes of key material
//!
//! | Secret | Lifetime | Where it lives |
//! | :--- | :--- | :--- |
//! | Pairing code | [`PAIRING_CODE_TTL`] | Printed by the daemon, typed by the user, never stored |
//! | Device identity key (Ed25519) | Until revoked | Client storage; public half on the daemon |
//! | Session key (AES-256-GCM) | One connection | Derived per connection, zeroized on close |
//!
//! ## Why SPAKE2 for pairing
//!
//! The pairing code is the only low-entropy secret in the system, and it is
//! typed into a device that reaches the daemon *through the relay*. A plain
//! "hash the code and use it as a key" design would let the relay (or anyone
//! who recorded the exchange) mount an offline dictionary attack against a
//! 40-bit code. [`spake2`] is a balanced PAKE: it authenticates the code without
//! ever sending anything that enables an offline guess, and it yields a session
//! key that is forward-secret.
//!
//! The pairing exchange is where a device's long-term identity is enrolled. After
//! that, reconnection is a plain challenge–response against the enrolled key: no
//! code is involved, and a stolen connection transcript is worthless.
//!
//! ## Status
//!
//! Skeleton. The types, the KDF labels, and the invariants below are fixed;
//! implementations land with M0 and are validated against the conformance
//! corpus shared with the TypeScript client (`packages/crypto`).
//!
//! See `docs/security.md` for the threat model and `docs/protocol.md` § Handshake
//! for the byte-level exchange.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod device;
pub mod pairing;
pub mod registry;
pub mod session;
pub mod throttle;

pub use device::{
    DEVICE_ID_LEN, DEVICE_PUBLIC_KEY_LEN, DEVICE_SIGNATURE_LEN, DeviceError, DeviceId,
    DevicePublicKey, DeviceSecretKey, RESUME_NONCE_LEN, ResumeNonce, resume_message,
};
pub use pairing::{
    ClientPairing, DaemonPairing, PairingCode, PairingError, PendingCode, derive_pairing_root,
    enrolment_confirmation, open_room_key, receipt_nonce, rendezvous_room, rendezvous_root,
    seal_room_key, spake2_message_len, transport_root,
};
pub use registry::{DeviceRegistry, EnrolledDevice, RegistryError};
pub use session::{
    COUNTER_LEN, Role, SEALED_OVERHEAD, Session, SessionCipher, SessionError, SessionKey,
    connection_salt, room_id_for,
};
pub use throttle::{GuardError, PairingGuard, Throttled};

/// Renders raw pairing bytes in the grouped display form (`7Q4M-2XKP-9T`).
///
/// The alphabet is Crockford-style base32 without `I`, `L`, `O` and `U`: the
/// code gets read off a screen and typed on a phone, so the characters that
/// survive that trip badly are simply not in it. Grouping is presentation only —
/// key derivation uses the raw bytes.
#[must_use]
pub fn pairing_display(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let mut rendered = String::with_capacity(bytes.len() * 2 + bytes.len() / 2);
    for (index, byte) in bytes.iter().enumerate() {
        if index > 0 && index % 2 == 0 {
            rendered.push('-');
        }
        rendered.push(char::from(ALPHABET[usize::from(*byte) & 0x1f]));
        rendered.push(char::from(ALPHABET[usize::from(*byte) >> 5]));
    }
    rendered
}

/// Lifetime of a pairing code.
pub const PAIRING_CODE_TTL: core::time::Duration = core::time::Duration::from_secs(300);

/// Length of the raw pairing secret in bytes (40 bits of entropy, grouped for
/// humans as `XXXX-XXXX` base32; see `docs/security.md`).
pub const PAIRING_SECRET_LEN: usize = 5;

/// Length of a session key in bytes.
pub const SESSION_KEY_LEN: usize = 32;

/// Length of the AEAD nonce in bytes.
pub const NONCE_LEN: usize = 12;

/// Length of the AEAD authentication tag in bytes.
pub const TAG_LEN: usize = 16;

/// The additional-authenticated-data label, as bytes.
///
/// The same string appears in [`labels::FRAME_AAD`]; this constant exists because
/// the AEAD needs bytes rather than a `&str`, and having one source keeps the two
/// from drifting.
pub const LABEL_AAD: &[u8] = labels::FRAME_AAD;

/// HKDF labels. Changing one of these is a wire-breaking change: both
/// implementations derive keys from these strings, and the conformance corpus
/// pins the derived values.
pub mod labels {
    /// Extraction of the SPAKE2 output into the pairing root key.
    pub const PAIRING_ROOT: &[u8] = b"dsh-remote/v1/pairing-root";
    /// Derivation of a device's enrolment confirmation.
    pub const ENROLMENT_CONFIRM: &[u8] = b"dsh-remote/v1/enrolment-confirm";
    /// Additional authenticated data binding an enrolment receipt to its device.
    pub const ENROLMENT_SEAL: &[u8] = b"dsh-remote/v1/enrolment-seal";
    /// Derivation of a reconnecting device's challenge response.
    pub const RESUME_CHALLENGE: &[u8] = b"dsh-remote/v1/resume-challenge";
    /// Derivation of the client-to-daemon session key.
    pub const SESSION_CLIENT_TO_DAEMON: &[u8] = b"dsh-remote/v1/session/c2d";
    /// Derivation of the daemon-to-client session key.
    pub const SESSION_DAEMON_TO_CLIENT: &[u8] = b"dsh-remote/v1/session/d2c";
    /// Additional authenticated data binding a frame to its stream.
    pub const FRAME_AAD: &[u8] = b"dsh-remote/v1/frame";
}
