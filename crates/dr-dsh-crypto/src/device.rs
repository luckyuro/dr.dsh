//! Device identity: the key a paired client proves itself with.
//!
//! Pairing enrolls a **long-term** identity key, and every later connection is a
//! challenge–response against it. This is why a stolen connection transcript is worthless:
//! the transcript contains at most one signature, and a signature is bound to the nonce the
//! daemon chose for that connection.
//!
//! Ed25519 rather than a symmetric secret, for one reason that matters at this layer: the
//! daemon stores only the **public** half. A daemon whose device registry is read by someone
//! else does not thereby gain the ability to impersonate any device — which is exactly the
//! property a shared secret per device would not have.
//!
//! Status: implemented for M1; the room key is still accepted as a fallback so an existing
//! deployment keeps working while pairing lands (see `docs/product/mvp.md` § 六).

use ed25519_dalek::{Signature, Signer as _, SigningKey, Verifier as _, VerifyingKey};
use zeroize::Zeroizing;

/// Length of an Ed25519 public key in bytes.
pub const DEVICE_PUBLIC_KEY_LEN: usize = 32;

/// Length of an Ed25519 signature in bytes.
pub const DEVICE_SIGNATURE_LEN: usize = 64;

/// Length of a device identifier in bytes.
///
/// 16 bytes of `SHA-256(public key)`: long enough that two devices cannot collide, short
/// enough to be a routing handle the way a room id is. It is *derived* rather than assigned,
/// so a daemon and a client that agree on the public key agree on the id without a round
/// trip — and a registry cannot be made to hold two entries for one key.
pub const DEVICE_ID_LEN: usize = 16;

/// Length of a resume nonce in bytes.
pub const RESUME_NONCE_LEN: usize = 32;

/// Why a device key could not be used.
#[derive(Debug, thiserror::Error)]
pub enum DeviceError {
    /// A public key was not a valid Ed25519 point.
    #[error("not a valid Ed25519 public key")]
    InvalidPublicKey,
    /// A signature was not a valid Ed25519 signature.
    ///
    /// The reason is deliberately absent: distinguishing "malformed" from "wrong" tells an
    /// attacker which half of their guess was right, and helps an honest caller not at all.
    #[error("the signature is not valid for this key")]
    InvalidSignature,
    /// A stored key could not be reconstructed.
    #[error("stored device key material is not usable")]
    UnusableKey,
}

/// A device's public identity, as the daemon stores it.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct DevicePublicKey(VerifyingKey);

impl DevicePublicKey {
    /// Parses the 32-byte wire form.
    ///
    /// # Errors
    ///
    /// Returns [`DeviceError::InvalidPublicKey`] for bytes that are not a valid Ed25519
    /// point. A malformed key must be refused here rather than at verification time: a
    /// lenient parse is how a small-order or non-canonical key gets enrolled.
    pub fn from_bytes(bytes: &[u8; DEVICE_PUBLIC_KEY_LEN]) -> Result<Self, DeviceError> {
        VerifyingKey::from_bytes(bytes)
            .map(Self)
            .map_err(|_| DeviceError::InvalidPublicKey)
    }

    /// The 32-byte wire form.
    #[must_use]
    pub fn to_bytes(self) -> [u8; DEVICE_PUBLIC_KEY_LEN] {
        self.0.to_bytes()
    }

    /// The device id derived from this key.
    #[must_use]
    pub fn device_id(&self) -> DeviceId {
        DeviceId::for_key(&self.0.to_bytes())
    }

    /// Verifies a signature over `message`.
    ///
    /// # Errors
    ///
    /// Returns [`DeviceError::InvalidSignature`] when the signature does not verify.
    pub fn verify(&self, message: &[u8], signature: &[u8]) -> Result<(), DeviceError> {
        let signature: [u8; DEVICE_SIGNATURE_LEN] = signature
            .try_into()
            .map_err(|_| DeviceError::InvalidSignature)?;
        self.0
            .verify(message, &Signature::from_bytes(&signature))
            .map_err(|_| DeviceError::InvalidSignature)
    }
}

impl core::fmt::Debug for DevicePublicKey {
    /// Prints the device id, never the key: a public key is not secret, but a log line that
    /// carries one turns into a correlation handle across logs, and the id is what an
    /// operator actually needs to act on.
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "DevicePublicKey({})", self.device_id().to_base64url())
    }
}

/// A device's private identity, as the client stores it.
///
/// Zeroized on drop, and never printed.
pub struct DeviceSecretKey(Zeroizing<[u8; 32]>);

impl DeviceSecretKey {
    /// Generates a fresh identity.
    #[must_use]
    pub fn generate() -> Self {
        // The seed is drawn here rather than through the signature crate's own RNG hook:
        // this workspace pins one RNG version, and a second, differently-versioned one
        // arriving through a dependency is how "random" quietly becomes two definitions.
        use rand::RngCore as _;
        let mut seed = [0_u8; 32];
        rand::rng().fill_bytes(&mut seed);
        Self(Zeroizing::new(seed))
    }

    /// Rebuilds an identity from its 32-byte seed.
    ///
    /// # Errors
    ///
    /// Returns [`DeviceError::UnusableKey`] when the bytes are not a usable seed. This is
    /// the path a corrupted client store takes, and it has to be a refusal rather than a
    /// silently different key — an identity that changes silently locks the device out with
    /// no explanation.
    pub fn from_bytes(bytes: [u8; 32]) -> Result<Self, DeviceError> {
        let candidate = SigningKey::from_bytes(&bytes);
        // Ed25519 accepts every 32-byte string as a seed, so "usable" is checked by
        // round-tripping rather than by validating the input.
        if candidate.to_bytes() != bytes {
            return Err(DeviceError::UnusableKey);
        }
        Ok(Self(Zeroizing::new(bytes)))
    }

    /// The seed bytes, for storage on the client.
    #[must_use]
    pub fn to_bytes(&self) -> [u8; 32] {
        *self.0
    }

    /// The public half, which is what the daemon enrolls.
    #[must_use]
    pub fn public(&self) -> DevicePublicKey {
        DevicePublicKey(SigningKey::from_bytes(&self.0).verifying_key())
    }

    /// Signs a message.
    #[must_use]
    pub fn sign(&self, message: &[u8]) -> [u8; DEVICE_SIGNATURE_LEN] {
        SigningKey::from_bytes(&self.0).sign(message).to_bytes()
    }
}

impl core::fmt::Debug for DeviceSecretKey {
    /// Never prints the secret.
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("DeviceSecretKey(redacted)")
    }
}

/// A device identifier, derived from the device's public key.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct DeviceId([u8; DEVICE_ID_LEN]);

impl DeviceId {
    /// Derives the id for a public key.
    #[must_use]
    pub fn for_key(public_key: &[u8; DEVICE_PUBLIC_KEY_LEN]) -> Self {
        use sha2::{Digest as _, Sha256};
        let digest = Sha256::digest(public_key);
        let mut id = [0_u8; DEVICE_ID_LEN];
        id.copy_from_slice(&digest[..DEVICE_ID_LEN]);
        Self(id)
    }

    /// The raw bytes.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8; DEVICE_ID_LEN] {
        &self.0
    }

    /// Parses the display form.
    ///
    /// # Errors
    ///
    /// Returns [`DeviceError::UnusableKey`] when the text is not a 16-byte unpadded
    /// base64url value. A wrong-length id is refused rather than truncated: `drdshd devices
    /// --revoke` acting on a typo would revoke the wrong device, and there is no undo.
    pub fn from_base64url(text: &str) -> Result<Self, DeviceError> {
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(text)
            .map_err(|_| DeviceError::UnusableKey)?;
        let id: [u8; DEVICE_ID_LEN] = bytes.try_into().map_err(|_| DeviceError::UnusableKey)?;
        Ok(Self(id))
    }

    /// The display form: unpadded base64url, the same shape the wire uses.
    #[must_use]
    pub fn to_base64url(self) -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(self.0)
    }
}

impl core::fmt::Debug for DeviceId {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "DeviceId({})", self.to_base64url())
    }
}

/// A nonce the daemon challenges a reconnecting device with.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct ResumeNonce([u8; RESUME_NONCE_LEN]);

impl ResumeNonce {
    /// Draws a fresh nonce.
    ///
    /// Freshness is the whole security property: a nonce reused across connections turns
    /// the challenge into a replayable value, and a device's recorded response into a
    /// credential anyone can present.
    #[must_use]
    pub fn generate() -> Self {
        use rand::RngCore as _;
        let mut bytes = [0_u8; RESUME_NONCE_LEN];
        rand::rng().fill_bytes(&mut bytes);
        Self(bytes)
    }

    /// The raw bytes.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8; RESUME_NONCE_LEN] {
        &self.0
    }

    /// Rebuilds a nonce received from the wire.
    #[must_use]
    pub fn from_bytes(bytes: [u8; RESUME_NONCE_LEN]) -> Self {
        Self(bytes)
    }
}

impl core::fmt::Debug for ResumeNonce {
    /// The nonce is not a secret, and printing it is what makes a failed challenge
    /// diagnosable: "which nonce was signed" is the first question an operator asks.
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        use base64::Engine as _;
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(self.0);
        write!(f, "ResumeNonce({encoded})")
    }
}

/// Builds the message a device signs to resume a session.
///
/// The room is bound in as well as the nonce, so a response captured on one room cannot be
/// replayed against another — which matters when one client is paired to more than one
/// daemon, and is the reason the protocol document specifies `nonce || room` rather than
/// the nonce alone.
#[must_use]
pub fn resume_message(nonce: &ResumeNonce, room: &str) -> Vec<u8> {
    let mut message = Vec::with_capacity(RESUME_NONCE_LEN + room.len());
    message.extend_from_slice(nonce.as_bytes());
    message.extend_from_slice(room.as_bytes());
    message
}
