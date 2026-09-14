//! Established sessions: key schedule and sealed frames.
//!
//! A session exists between exactly one remote device and one daemon, inside the
//! carrier connection the relay forwards. Keys are derived from the pairing root
//! (first connection) or from a challenge–response over the enrolled device key
//! (every later connection), never from anything the relay can observe twice.
//!
//! # What the relay cannot do
//!
//! * **Read a payload.** Frames are sealed with AES-256-GCM before they reach it.
//! * **Move one to another stream.** The stream id is authenticated as additional
//!   data, so a payload shifted onto a different stream fails to open.
//! * **Reflect one back.** The two directions use different keys, so a frame the
//!   client sent cannot be replayed to the client as if the daemon sent it.
//! * **Replay or reorder one.** The nonce is a per-direction counter, and the
//!   receiver refuses any counter it did not expect, so a duplicated or dropped
//!   frame is a protocol error rather than a silent duplication of work.
//!
//! # The sealed-frame layout
//!
//! ```text
//! +----------------+---------------------------------+
//! | counter (8, BE) | ciphertext + authentication tag |
//! +----------------+---------------------------------+
//! ```
//!
//! The counter travels in the clear because the receiver has to know which nonce
//! to try before it can decrypt anything — and it is authenticated through the
//! additional data, so a relay that alters it produces a frame that fails to
//! open. Keeping it explicit is what lets the receiver *diagnose* a dropped or
//! reordered frame instead of reporting a generic authentication failure.
//!
//! # The key schedule
//!
//! ```text
//! salt        = 32 random bytes, chosen by the client on every connection
//! c2d         = HKDF-SHA256(ikm = root, salt = salt, info = "…/session/c2d")
//! d2c         = HKDF-SHA256(ikm = root, salt = salt, info = "…/session/d2c")
//! ```
//!
//! A fresh salt per connection is what keeps one connection's keys from being the
//! next one's: the root is long-lived (it is the pairing result), so deriving keys
//! from it alone would make every session share a key.
//!
//! # What M1 adds
//!
//! `root` currently comes from a room key the operator shares out of band. M1
//! replaces its provisioning with SPAKE2 over a one-time pairing code and adds a
//! key-confirmation exchange, so a peer cannot be talked onto a session it did not
//! agree to. Everything below — the schedule, the nonce discipline, the AAD — is
//! already the M1 design; only the provisioning of `root` changes.

use aes_gcm::aead::{Aead as _, KeyInit as _, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::{LABEL_AAD, NONCE_LEN, SESSION_KEY_LEN, labels};

/// A symmetric session key. Zeroized on drop; never logged.
pub struct SessionKey(Zeroizing<[u8; SESSION_KEY_LEN]>);

impl SessionKey {
    /// Wraps raw key bytes.
    #[must_use]
    pub fn from_bytes(bytes: [u8; SESSION_KEY_LEN]) -> Self {
        Self(Zeroizing::new(bytes))
    }

    /// Borrows the raw bytes for an AEAD implementation.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8; SESSION_KEY_LEN] {
        &self.0
    }
}

impl core::fmt::Debug for SessionKey {
    /// Deliberately opaque: a key in a log line is a key that has leaked.
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("SessionKey(redacted)")
    }
}

/// Which end of a session a process is, which fixes the direction of its keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// The remote device: seals with `c2d`, opens with `d2c`.
    Client,
    /// The local daemon: seals with `d2c`, opens with `c2d`.
    Daemon,
}

impl Role {
    /// The role on the other end.
    #[must_use]
    pub fn peer(self) -> Self {
        match self {
            Self::Client => Self::Daemon,
            Self::Daemon => Self::Client,
        }
    }
}

/// Why a frame could not be sealed or opened.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SessionError {
    /// The AEAD refused the frame: wrong key, tampered bytes, or the payload was
    /// replayed under a nonce it was not sealed with.
    #[error("frame failed authentication")]
    Authentication,
    /// The frame's nonce counter is not the next one expected.
    ///
    /// This is a *protocol* error, not a cryptographic one: the bytes may be
    /// perfectly valid, but the relay dropped, duplicated, or reordered a frame,
    /// and continuing would mean silently losing or repeating part of a stream.
    #[error("frame {received} arrived out of order; expected {expected}")]
    Sequence {
        /// The counter the frame carried.
        received: u64,
        /// The counter this end expected next.
        expected: u64,
    },
    /// The counter would wrap, which must never be reached with one key.
    #[error("session nonce counter is exhausted; a new session is required")]
    NonceExhausted,
    /// Key derivation failed, which means the requested output length is wrong.
    #[error("key derivation failed: {0}")]
    Derivation(String),
}

/// Size of the cleartext counter header on a sealed frame.
pub const COUNTER_LEN: usize = 8;

/// Bytes a sealed frame adds to its plaintext: the counter header and the AEAD tag.
pub const SEALED_OVERHEAD: usize = COUNTER_LEN + crate::TAG_LEN;

/// One direction of a session: an AEAD key plus the nonce sequence.
///
/// The nonce is a counter, not a random value. Both endpoints know the expected
/// value, so a gap or a repeat is a protocol error the receiver can detect
/// instead of silently accepting a replayed frame — which matters because the
/// relay is not trusted to preserve ordering.
pub struct SessionCipher {
    /// AEAD key for this direction.
    pub key: SessionKey,
    /// Next nonce counter to use or expect.
    pub nonce: u64,
}

impl SessionCipher {
    /// Creates a cipher for one direction starting at nonce zero.
    #[must_use]
    pub fn new(key: SessionKey) -> Self {
        Self { key, nonce: 0 }
    }

    /// Builds the 12-byte nonce for a counter value: 4 zero bytes then the
    /// big-endian counter, so both languages agree without negotiation.
    #[must_use]
    pub fn nonce_bytes(counter: u64) -> [u8; NONCE_LEN] {
        let mut nonce = [0_u8; NONCE_LEN];
        nonce[4..].copy_from_slice(&counter.to_be_bytes());
        nonce
    }

    /// Seals one payload for `stream_id` and advances the counter.
    ///
    /// # Errors
    ///
    /// Returns [`SessionError::NonceExhausted`] at counter wrap (unreachable in
    /// practice, but a wrapped counter would reuse a nonce and destroy the AEAD's
    /// guarantee, so it is an error rather than a wrap) and
    /// [`SessionError::Derivation`] if the key cannot be loaded.
    pub fn seal(&mut self, stream_id: u32, plaintext: &[u8]) -> Result<Vec<u8>, SessionError> {
        let counter = self.nonce;
        let next = counter.checked_add(1).ok_or(SessionError::NonceExhausted)?;
        let cipher = self.cipher()?;
        let aad = additional_data(stream_id, counter);
        let body = cipher
            .encrypt(
                &Nonce::from(Self::nonce_bytes(counter)),
                Payload {
                    msg: plaintext,
                    aad: &aad,
                },
            )
            .map_err(|_| SessionError::Authentication)?;
        let mut sealed = Vec::with_capacity(COUNTER_LEN + body.len());
        sealed.extend_from_slice(&counter.to_be_bytes());
        sealed.extend_from_slice(&body);
        self.nonce = next;
        Ok(sealed)
    }

    /// Opens one sealed payload for `stream_id`.
    ///
    /// # Errors
    ///
    /// Returns [`SessionError::Sequence`] when the counter is not the expected
    /// one, and [`SessionError::Authentication`] when the AEAD refuses the frame
    /// (wrong key, tampered bytes, or a different stream).
    pub fn open(&mut self, stream_id: u32, sealed: &[u8]) -> Result<Vec<u8>, SessionError> {
        let expected = self.nonce;
        if sealed.len() < COUNTER_LEN {
            // A sealed frame always carries its counter; a shorter one cannot be
            // authentic, and reading a counter out of it would panic.
            return Err(SessionError::Authentication);
        }
        let counter = u64::from_be_bytes(
            sealed[..COUNTER_LEN]
                .try_into()
                .map_err(|_| SessionError::Authentication)?,
        );
        if counter != expected {
            return Err(SessionError::Sequence {
                received: counter,
                expected,
            });
        }
        let next = counter.checked_add(1).ok_or(SessionError::NonceExhausted)?;
        let cipher = self.cipher()?;
        let aad = additional_data(stream_id, counter);
        let plaintext = cipher
            .decrypt(
                &Nonce::from(Self::nonce_bytes(counter)),
                Payload {
                    // The counter is a cleartext prefix, not part of the ciphertext.
                    msg: &sealed[COUNTER_LEN..],
                    aad: &aad,
                },
            )
            .map_err(|_| SessionError::Authentication)?;
        self.nonce = next;
        Ok(plaintext)
    }

    /// A SHA-256 fingerprint of this direction's key.
    #[must_use]
    pub fn key_fingerprint(&self) -> [u8; 32] {
        use sha2::{Digest as _, Sha256};
        Sha256::digest(self.key.as_bytes()).into()
    }

    fn cipher(&self) -> Result<Aes256Gcm, SessionError> {
        Aes256Gcm::new_from_slice(self.key.as_bytes())
            .map_err(|error| SessionError::Derivation(error.to_string()))
    }
}

impl core::fmt::Debug for SessionCipher {
    /// Redacts the key; keeps the counter, which is useful in diagnostics.
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("SessionCipher")
            .field("nonce", &self.nonce)
            .finish_non_exhaustive()
    }
}

/// Additional authenticated data for a frame: the label, the stream id, and the
/// counter.
///
/// Binding the stream id stops a relay from moving a payload onto another stream —
/// a redirection that would otherwise be a silent feature of a byte-forwarding
/// middlebox. Binding the counter stops it from rewriting the cleartext counter to
/// make a replayed frame look like the next expected one.
#[must_use]
pub fn additional_data(stream_id: u32, counter: u64) -> Vec<u8> {
    let mut aad = Vec::with_capacity(LABEL_AAD.len() + 4 + COUNTER_LEN);
    aad.extend_from_slice(LABEL_AAD);
    aad.extend_from_slice(&stream_id.to_be_bytes());
    aad.extend_from_slice(&counter.to_be_bytes());
    aad
}

/// A live session: one cipher per direction, with the role fixing which is which.
pub struct Session {
    role: Role,
    sealing: SessionCipher,
    opening: SessionCipher,
}

impl Session {
    /// Derives a session's keys from a long-lived root key and a connection salt.
    ///
    /// # Errors
    ///
    /// Returns [`SessionError::Derivation`] when HKDF cannot produce the requested
    /// output, which would mean the labels or lengths were changed wrongly.
    pub fn derive(
        root: &[u8; SESSION_KEY_LEN],
        salt: &[u8],
        role: Role,
    ) -> Result<Self, SessionError> {
        let client_to_daemon = derive_key(root, salt, labels::SESSION_CLIENT_TO_DAEMON)?;
        let daemon_to_client = derive_key(root, salt, labels::SESSION_DAEMON_TO_CLIENT)?;
        // One cipher per direction: the role decides which key seals and which
        // opens, which is what makes a reflected frame fail at the other end.
        let (sealing_key, opening_key) = match role {
            Role::Client => (client_to_daemon, daemon_to_client),
            Role::Daemon => (daemon_to_client, client_to_daemon),
        };
        let sealing = SessionCipher::new(sealing_key);
        let opening = SessionCipher::new(opening_key);
        Ok(Self {
            role,
            sealing,
            opening,
        })
    }

    /// Which end of the session this is.
    #[must_use]
    pub fn role(&self) -> Role {
        self.role
    }

    /// A fingerprint of the key this session *seals* with.
    ///
    /// A SHA-256 of the key, not the key: two ends can compare fingerprints in a log or a
    /// test without either printing key material. It exists because a handshake that fails
    /// with "authentication" names neither the cause nor the end that is wrong, and the only
    /// way to tell a key mismatch from a stale counter is to compare the keys.
    #[must_use]
    pub fn sealing_key_fingerprint(&self) -> [u8; 32] {
        self.sealing.key_fingerprint()
    }

    /// A fingerprint of the key this session *opens* with.
    #[must_use]
    pub fn opening_key_fingerprint(&self) -> [u8; 32] {
        self.opening.key_fingerprint()
    }

    /// How many frames this session has opened: the next expected counter.
    ///
    /// Diagnostics only. Reading it is how a handover desync is told apart from a
    /// cryptographic failure, which otherwise look identical from the outside.
    #[must_use]
    pub fn opened_count(&self) -> u64 {
        self.opening.nonce
    }

    /// How many frames this session has sealed: the next counter it will write.
    ///
    /// Diagnostics only, for telling a handover desync apart from a cryptographic failure.
    #[must_use]
    pub fn sealed_count(&self) -> u64 {
        self.sealing.nonce
    }

    /// Sets the next expected counter.
    ///
    /// Only for carrying consumption across a derivation, and deliberately narrow: a
    /// general-purpose setter would let a caller rewind a counter, which is exactly the
    /// nonce reuse the counter exists to prevent. It is `pub(crate)` in spirit but the
    /// handshake lives in another crate, so it is documented rather than hidden.
    /// Sets the next counter this session will write.
    ///
    /// The mirror of [`Session::set_opened_count`], for the sender's half of a
    /// handover: the salt frame is written under the provisional session, and the
    /// session the salt defines starts counting from zero, so the write is carried
    /// over explicitly.
    pub fn set_sealed_count(&mut self, counter: u64) {
        self.sealing.nonce = counter;
    }

    /// Sets the next expected counter, the receiver's half of the same handover.
    ///
    /// Deliberately narrow, and it is the only way to rewind a counter in this crate: a
    /// general-purpose setter would let a caller reuse a nonce, which is exactly what the
    /// counter exists to prevent. Callers use it once, immediately after deriving the
    /// session the salt defines.
    pub fn set_opened_count(&mut self, counter: u64) {
        self.opening.nonce = counter;
    }

    /// Seals a payload for a stream, advancing this direction's counter.
    ///
    /// # Errors
    ///
    /// See [`SessionCipher::seal`].
    pub fn seal(&mut self, stream_id: u32, plaintext: &[u8]) -> Result<Vec<u8>, SessionError> {
        self.sealing.seal(stream_id, plaintext)
    }

    /// Opens a sealed payload for a stream.
    ///
    /// # Errors
    ///
    /// See [`SessionCipher::open`].
    pub fn open(&mut self, stream_id: u32, sealed: &[u8]) -> Result<Vec<u8>, SessionError> {
        self.opening.open(stream_id, sealed)
    }
}

impl core::fmt::Debug for Session {
    /// Redacts both keys; a session in a log line is a session that has leaked.
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Session")
            .field("role", &self.role)
            .field("sealed", &self.sealing.nonce)
            .field("opened", &self.opening.nonce)
            .finish_non_exhaustive()
    }
}

/// Derives one direction's key with HKDF-SHA256.
fn derive_key(
    root: &[u8; SESSION_KEY_LEN],
    salt: &[u8],
    info: &[u8],
) -> Result<SessionKey, SessionError> {
    let hkdf = Hkdf::<Sha256>::new(Some(salt), root);
    let mut out = Zeroizing::new([0_u8; SESSION_KEY_LEN]);
    hkdf.expand(info, out.as_mut())
        .map_err(|error| SessionError::Derivation(error.to_string()))?;
    Ok(SessionKey::from_bytes(*out))
}

/// Generates a fresh connection salt.
#[must_use]
pub fn connection_salt() -> [u8; 32] {
    use rand::RngCore as _;
    let mut salt = [0_u8; 32];
    rand::rng().fill_bytes(&mut salt);
    salt
}

#[cfg(test)]
mod tests {
    use super::*;

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    const STREAM: u32 = 3;

    fn pair() -> Result<(Session, Session), SessionError> {
        let root = [7_u8; SESSION_KEY_LEN];
        let salt = [9_u8; 32];
        Ok((
            Session::derive(&root, &salt, Role::Client)?,
            Session::derive(&root, &salt, Role::Daemon)?,
        ))
    }

    #[test]
    fn a_frame_travels_between_the_two_roles() -> TestResult {
        let (mut client, mut daemon) = pair()?;
        let sealed = client.seal(STREAM, b"the session content")?;
        assert_ne!(
            sealed, b"the session content",
            "the payload must not be readable"
        );
        assert_eq!(daemon.open(STREAM, &sealed)?, b"the session content");

        let reply = daemon.seal(STREAM, b"and back")?;
        assert_eq!(client.open(STREAM, &reply)?, b"and back");
        Ok(())
    }

    #[test]
    fn the_two_directions_use_different_keys() -> TestResult {
        // Reflection: a frame sealed by one end must not open at that same end,
        // even though both ends hold the same root and salt.
        let (mut client, _daemon) = pair()?;
        let sealed = client.seal(STREAM, b"ping")?;
        assert_eq!(
            client.open(STREAM, &sealed),
            Err(SessionError::Authentication)
        );
        Ok(())
    }

    #[test]
    fn a_frame_cannot_be_moved_to_another_stream() -> TestResult {
        let (mut client, mut daemon) = pair()?;
        let sealed = client.seal(STREAM, b"stream-bound")?;
        // The relay is the component that would attempt this, and the AAD is what
        // makes the attempt fail closed.
        assert_eq!(
            daemon.open(STREAM + 1, &sealed),
            Err(SessionError::Authentication)
        );
        assert_eq!(daemon.open(STREAM, &sealed)?, b"stream-bound");
        Ok(())
    }

    #[test]
    fn a_replayed_frame_is_refused() -> TestResult {
        let (mut client, mut daemon) = pair()?;
        let first = client.seal(STREAM, b"one")?;
        let second = client.seal(STREAM, b"two")?;
        assert_eq!(daemon.open(STREAM, &first)?, b"one");
        // Replaying the accepted frame must fail on the counter, not merely on the
        // AEAD: the receiver has already advanced past it.
        assert!(matches!(
            daemon.open(STREAM, &first),
            Err(SessionError::Sequence { .. })
        ));
        assert_eq!(daemon.open(STREAM, &second)?, b"two");
        Ok(())
    }

    #[test]
    fn a_dropped_frame_is_detected_rather_than_skipped() -> TestResult {
        let (mut client, mut daemon) = pair()?;
        let _lost = client.seal(STREAM, b"lost")?;
        let third = client.seal(STREAM, b"third")?;
        match daemon.open(STREAM, &third) {
            Err(SessionError::Sequence { received, expected }) => {
                assert_eq!(expected, 0);
                assert_eq!(received, 1);
            }
            other => return Err(format!("expected a sequence error, got {other:?}").into()),
        }
        Ok(())
    }

    #[test]
    fn tampering_with_a_sealed_frame_is_detected() -> TestResult {
        let (mut client, mut daemon) = pair()?;
        let mut sealed = client.seal(STREAM, b"integrity")?;
        let last = sealed.len() - 1;
        sealed[last] ^= 0x01;
        assert_eq!(
            daemon.open(STREAM, &sealed),
            Err(SessionError::Authentication)
        );
        Ok(())
    }

    #[test]
    fn a_truncated_frame_is_refused_without_panicking() -> TestResult {
        let (_client, mut daemon) = pair()?;
        for length in 0..COUNTER_LEN {
            assert_eq!(
                daemon.open(STREAM, &vec![0_u8; length]),
                Err(SessionError::Authentication),
                "a {length}-byte frame"
            );
        }
        Ok(())
    }

    #[test]
    fn a_different_salt_or_root_yields_a_different_session() -> TestResult {
        let root = [7_u8; SESSION_KEY_LEN];
        let mut client = Session::derive(&root, b"salt-one", Role::Client)?;
        let mut daemon = Session::derive(&root, b"salt-two", Role::Daemon)?;
        let sealed = client.seal(STREAM, b"x")?;
        assert_eq!(
            daemon.open(STREAM, &sealed),
            Err(SessionError::Authentication)
        );

        let mut daemon = Session::derive(&[8_u8; SESSION_KEY_LEN], b"salt-one", Role::Daemon)?;
        assert_eq!(
            daemon.open(STREAM, &sealed),
            Err(SessionError::Authentication)
        );
        Ok(())
    }

    #[test]
    fn the_nonce_layout_is_stable() {
        // Both languages build this nonce; changing it is a wire-breaking change.
        assert_eq!(
            SessionCipher::nonce_bytes(0),
            [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        );
        assert_eq!(
            SessionCipher::nonce_bytes(1),
            [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]
        );
        assert_eq!(
            SessionCipher::nonce_bytes(258),
            [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2]
        );
    }

    #[test]
    fn the_additional_data_binds_the_label_the_stream_and_the_counter() {
        let aad = additional_data(3, 5);
        assert_eq!(&aad[..LABEL_AAD.len()], LABEL_AAD);
        assert_eq!(&aad[LABEL_AAD.len()..LABEL_AAD.len() + 4], &[0, 0, 0, 3]);
        assert_eq!(&aad[LABEL_AAD.len() + 4..], &5_u64.to_be_bytes());
        assert_ne!(additional_data(3, 5), additional_data(4, 5));
        assert_ne!(additional_data(3, 5), additional_data(3, 6));
    }

    #[test]
    fn a_sealed_frame_carries_its_counter_in_the_clear() -> TestResult {
        let (mut client, _daemon) = pair()?;
        let first = client.seal(STREAM, b"one")?;
        let second = client.seal(STREAM, b"two")?;
        assert_eq!(&first[..COUNTER_LEN], &0_u64.to_be_bytes());
        assert_eq!(&second[..COUNTER_LEN], &1_u64.to_be_bytes());
        assert_eq!(first.len(), COUNTER_LEN + b"one".len() + crate::TAG_LEN);
        Ok(())
    }

    #[test]
    fn neither_keys_nor_sessions_print_their_secrets() -> TestResult {
        let (client, _daemon) = pair()?;
        let printed = format!("{client:?}");
        assert!(printed.contains("Session"), "{printed}");
        assert!(
            !printed.contains("SessionKey"),
            "keys must not appear: {printed}"
        );
        let key = SessionKey::from_bytes([1_u8; SESSION_KEY_LEN]);
        assert_eq!(format!("{key:?}"), "SessionKey(redacted)");
        Ok(())
    }

    #[test]
    fn a_fresh_connection_salt_is_random() {
        let first = connection_salt();
        let second = connection_salt();
        assert_ne!(
            first, second,
            "a repeated salt would reuse keys across connections"
        );
        assert_ne!(first, [0_u8; 32]);
    }
}

/// Derives the room id a daemon advertises for a root key.
///
/// One-way on purpose: the relay learns the room id, and a room id must not reveal
/// the key it came from. M1 gives the room its own independently generated id and
/// pairs it with the key during pairing; this derivation exists so a daemon and its
/// client can agree on a room from the shared key alone, without a second
/// out-of-band value.
///
/// The output is unpadded base64url of 16 bytes, matching what the relay expects
/// for a room id.
#[must_use]
pub fn room_id_for(root: &[u8; SESSION_KEY_LEN]) -> String {
    use base64::Engine as _;

    let hkdf = Hkdf::<Sha256>::new(None, root);
    let mut derived = [0_u8; 16];
    // `expand` fails only for an output length beyond HKDF's limit, which 16 bytes
    // is not; the fallback keeps this function total rather than panicking.
    if hkdf.expand(labels::PAIRING_ROOT, &mut derived).is_err() {
        return String::new();
    }
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(derived)
}

#[cfg(test)]
mod room_tests {
    use super::*;

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    #[test]
    fn a_room_id_is_stable_and_does_not_leak_the_key() -> TestResult {
        let root = [3_u8; SESSION_KEY_LEN];
        let room = room_id_for(&root);
        assert_eq!(
            room,
            room_id_for(&root),
            "the same key must yield the same room"
        );
        assert_eq!(room.len(), 22, "16 bytes of base64url");
        assert!(!room.contains('='), "unpadded, because it travels in JSON");
        assert_ne!(room, room_id_for(&[4_u8; SESSION_KEY_LEN]));
        Ok(())
    }
}

#[cfg(test)]
mod salt_exchange_tests {
    use super::*;

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    /// The exact sequence the transport performs: the client seals a fresh salt
    /// under keys derived from a provisional salt, and the daemon opens it with the
    /// matching provisional keys before re-deriving the real session.
    ///
    /// This test exists because the transport's version of it failed, and the point
    /// of separating the two layers is that a crypto fault and a transport fault must
    /// not be indistinguishable.
    #[test]
    fn a_client_can_offer_a_salt_the_daemon_opens() -> TestResult {
        let root = [11_u8; SESSION_KEY_LEN];
        let provisional = [0_u8; 32];

        let mut client = Session::derive(&root, &provisional, Role::Client)?;
        let mut daemon = Session::derive(&root, &provisional, Role::Daemon)?;

        // The salt frame is sealed under the *provisional* keys, because the peer
        // cannot hold keys derived from a salt it has not received yet. This is the
        // step that is easy to get wrong, and getting it wrong fails as a plain
        // authentication error with no hint about which side derived what.
        let salt = [7_u8; 32];
        let sealed = client.seal(CONTROL_STREAM, &salt)?;
        assert_eq!(sealed.len(), 32 + SEALED_OVERHEAD);

        let opened = daemon.open(CONTROL_STREAM, &sealed)?;
        assert_eq!(opened, salt);

        // Both ends now switch to the session the salt defines.
        client = Session::derive(&root, &opened, Role::Client)?;
        daemon = Session::derive(&root, &opened, Role::Daemon)?;

        // And now the two ends share a session.
        let request = client.seal(CONTROL_STREAM, b"status please")?;
        assert_eq!(daemon.open(CONTROL_STREAM, &request)?, b"status please");
        let reply = daemon.seal(CONTROL_STREAM, b"here it is")?;
        assert_eq!(client.open(CONTROL_STREAM, &reply)?, b"here it is");
        Ok(())
    }

    const CONTROL_STREAM: u32 = 0;
}

#[cfg(test)]
mod handover_tests {
    use super::*;

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    /// The exact sequence both ends perform during the salt exchange, asserting the
    /// counters both sides hold afterwards.
    ///
    /// This is the question that a live failure took hours to answer: after the salt
    /// exchange, does the sender's next frame carry the counter the receiver expects? The
    /// answer is only *yes* if the sender carries `sent` across the derivation and the
    /// receiver carries `opened`, and the two are independent counters.
    #[test]
    fn both_ends_agree_on_the_next_counter_after_the_salt_exchange() -> TestResult {
        let root = [5_u8; SESSION_KEY_LEN];
        let provisional = [0_u8; 32];
        let salt = [9_u8; 32];
        let control = 0_u32;

        // The client seals the salt under the provisional session, then adopts the session
        // the salt defines — carrying how many frames it has already sent.
        let mut client = Session::derive(&root, &provisional, Role::Client)?;
        let salt_frame = client.seal(control, &salt)?;
        let client_sent = 1_u64;
        client = Session::derive(&root, &salt, Role::Client)?;
        client.set_sealed_count(client_sent);

        // The daemon opens it under the provisional session, then adopts the same session —
        // carrying how many frames it has already opened.
        let mut daemon = Session::derive(&root, &provisional, Role::Daemon)?;
        let opened = daemon.open(control, &salt_frame)?;
        assert_eq!(opened, salt);
        let daemon_opened = 1_u64;
        daemon = Session::derive(&root, &opened, Role::Daemon)?;
        daemon.set_opened_count(daemon_opened);

        // The client's next frame must be the one the daemon expects. Without the two
        // carries this is exactly where a live session dies: "frame 0 arrived out of order;
        // expected 1".
        assert_eq!(client.sealed_count(), 1, "the client sent the salt");
        assert_eq!(daemon.opened_count(), 1, "the daemon opened the salt");
        let request = client.seal(control, b"a request")?;
        assert_eq!(daemon.open(control, &request)?, b"a request");

        // And the daemon's answer at counter zero is what the client expects next.
        assert_eq!(
            daemon.sealed_count(),
            0,
            "the daemon has not written on the new session"
        );
        assert_eq!(client.opened_count(), 0);
        let answer = daemon.seal(control, b"an answer")?;
        assert_eq!(client.open(control, &answer)?, b"an answer");
        Ok(())
    }

    #[test]
    fn a_session_starts_its_counters_at_zero() -> TestResult {
        // The carries above are only necessary because a fresh derivation resets both
        // counters; if that ever stops being true, the carries become wrong.
        let session = Session::derive(&[1_u8; SESSION_KEY_LEN], &[2_u8; 32], Role::Client)?;
        assert_eq!(session.sealed_count(), 0);
        assert_eq!(session.opened_count(), 0);
        Ok(())
    }
}
