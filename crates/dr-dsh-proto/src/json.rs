//! Text encoding helpers for control-plane payloads.
//!
//! Unpadded base64url is the only text encoding on the wire. The TypeScript
//! side uses the same alphabet, and the conformance corpus asserts it
//! (ADR-0004).

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

use crate::{ProtoError, Result};

/// Encodes bytes as unpadded base64url.
#[must_use]
pub fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Decodes unpadded base64url.
///
/// # Errors
///
/// Returns [`ProtoError::Control`] when the input is not valid base64url.
pub fn unb64(text: &str) -> Result<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(text)
        .map_err(|error| ProtoError::Control(format!("invalid base64url: {error}")))
}
