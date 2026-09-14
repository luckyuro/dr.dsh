//! Device authentication on the control stream.
//!
//! After the session exists, the daemon asks the client to prove it is an enrolled device,
//! and refuses the connection when it cannot. This is the step that turns the device registry
//! from a record into an authorization boundary: an unpaired client can complete the room-key
//! handshake — the relay cannot tell one client from another — but it cannot answer a
//! challenge it has no key for.
//!
//! ## Why the challenge is fresh and travels inside the session
//!
//! The nonce is drawn per connection and sent **sealed**, so the relay can neither read it
//! nor substitute one it knows a signature for. Freshness is what makes the signature a
//! proof of *this* connection: a recorded response is worthless against a new nonce, which is
//! why the protocol does not need to treat a transcript as a secret.
//!
//! ## Why the message shapes live in this crate
//!
//! They are a wire contract shared by the daemon and the client, and `dr-dsh-proto` is the crate
//! both ends already depend on for exactly that reason. Nothing here is cryptography: these
//! are the bytes, and `dr-dsh-crypto` is what decides whether the signature is any good.
//!
//! ## The room key is still accepted
//!
//! A daemon with no enrolled devices serves anyone holding the room key. That is the
//! documented fallback for a deployment that has not paired yet, and it is why the field is
//! an enum rather than an assumption. Once a device is enrolled the policy refuses the
//! fallback: the two are not mixed, because "the room key still works" would make enrolment
//! decorative.

/// The challenge a daemon sends to a client it wants to authenticate.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DeviceChallenge {
    /// Always `resume_challenge`.
    #[serde(rename = "type")]
    pub kind: String,
    /// A fresh nonce, base64url. Never reused across connections.
    pub nonce: String,
}

/// The client's answer: possession of the device's private key.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DeviceResponse {
    /// Always `resume_response`.
    #[serde(rename = "type")]
    pub kind: String,
    /// The device id, base64url, so the daemon knows which key to check against.
    pub device_id: String,
    /// Ed25519 signature over `nonce || room`, base64url.
    pub signature: String,
}

/// The daemon's acceptance.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DeviceAccepted {
    /// Always `resume_accept`.
    #[serde(rename = "type")]
    pub kind: String,
}

/// The daemon's refusal, with a reason a client can act on.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DeviceRefused {
    /// Always `resume_reject`.
    #[serde(rename = "type")]
    pub kind: String,
    /// Machine-readable reason: a client shows a different message for "you are not paired"
    /// than for "your proof was wrong", and an operator debugging a rollout needs to tell
    /// them apart in a log.
    pub reason: String,
}

/// The reason a client is not enrolled.
pub const REASON_NOT_PAIRED: &str = "not_paired";

/// The reason a proof did not verify.
pub const REASON_BAD_PROOF: &str = "bad_proof";

/// The reason a client answered a challenge with a device id the daemon does not know.
pub const REASON_UNKNOWN_DEVICE: &str = "unknown_device";

/// The fixed message type names, so neither side spells them twice.
pub const CHALLENGE_TYPE: &str = "resume_challenge";
/// See [`CHALLENGE_TYPE`].
pub const RESPONSE_TYPE: &str = "resume_response";
/// See [`CHALLENGE_TYPE`].
pub const ACCEPT_TYPE: &str = "resume_accept";
/// See [`CHALLENGE_TYPE`].
pub const REFUSE_TYPE: &str = "resume_reject";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_challenge_round_trips_with_its_field_names() -> Result<(), String> {
        // The field names are the contract: a client written against the protocol document
        // has to be able to parse what this crate emits, so they are asserted rather than
        // left to `serde`'s defaults.
        let challenge = DeviceChallenge {
            kind: CHALLENGE_TYPE.to_owned(),
            nonce: "AAAA".to_owned(),
        };
        let encoded = serde_json::to_string(&challenge).map_err(|error| error.to_string())?;
        assert!(
            encoded.contains("\"type\":\"resume_challenge\""),
            "{encoded}"
        );
        assert!(encoded.contains("\"nonce\":\"AAAA\""), "{encoded}");
        let decoded: DeviceChallenge =
            serde_json::from_str(&encoded).map_err(|error| error.to_string())?;
        assert_eq!(decoded.nonce, "AAAA");

        let response = DeviceResponse {
            kind: RESPONSE_TYPE.to_owned(),
            device_id: "id".to_owned(),
            signature: "sig".to_owned(),
        };
        let encoded = serde_json::to_string(&response).map_err(|error| error.to_string())?;
        assert!(encoded.contains("\"device_id\":\"id\""), "{encoded}");
        assert!(encoded.contains("\"signature\":\"sig\""), "{encoded}");
        Ok(())
    }

    #[test]
    fn a_refusal_carries_a_reason_a_client_can_branch_on() -> Result<(), String> {
        let refused = DeviceRefused {
            kind: REFUSE_TYPE.to_owned(),
            reason: REASON_NOT_PAIRED.to_owned(),
        };
        let encoded = serde_json::to_string(&refused).map_err(|error| error.to_string())?;
        assert!(encoded.contains("\"reason\":\"not_paired\""), "{encoded}");
        assert!(encoded.contains("\"type\":\"resume_reject\""), "{encoded}");
        Ok(())
    }
}
