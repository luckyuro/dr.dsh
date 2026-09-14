//! The client's WebSocket encoder, decoded by the daemon's own decoder.
//!
//! `packages/protocol` and `crates/dr-dsh-proto` share a conformance corpus for the carrier frame, and
//! this is the same idea for the proxy plane's WebSocket messages. The point is the direction that
//! is easy to get wrong and hard to notice: the TypeScript client *writes* these bytes and the Rust
//! daemon *reads* them, so a mismatch is a socket that never opens, with nothing on either side
//! saying which byte was wrong.
//!
//! The vectors are produced by `scripts/ws-conformance.mjs`, which runs the client's real encoder.
//! That script is the other half of this test: it writes the file, this reads it, and
//! `pnpm run verify` fails if the two disagree.

use dr_dsh_daemon::proxy::message::{ProxyMessage, WsFrame};

/// The bytes the client's encoder produced, as hex.
const VECTORS: &str = include_str!("../../../target/ws-vectors.json");

/// Why a vector could not be read.
type TestResult = Result<(), Box<dyn std::error::Error>>;

/// Reads one hex string out of the vector file.
fn vector(name: &str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let parsed: serde_json::Value = serde_json::from_str(VECTORS)?;
    let hex = parsed
        .get(name)
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            format!("the vector file has no {name:?} entry; run scripts/ws-conformance.mjs")
        })?;
    let mut bytes = Vec::with_capacity(hex.len() / 2);
    for index in (0..hex.len()).step_by(2) {
        bytes.push(u8::from_str_radix(&hex[index..index + 2], 16)?);
    }
    Ok(bytes)
}

#[test]
fn the_client_s_upgrade_decodes_as_the_daemon_expects() -> TestResult {
    let bytes = vector("open")?;
    match dr_dsh_daemon::proxy::message::decode(&bytes)? {
        ProxyMessage::WsOpen(open) => {
            assert_eq!(open.id, 1);
            assert_eq!(open.target, "/api/remote.mux");
            assert!(open.headers.is_empty());
        }
        other => return Err(format!("expected a WsOpen, got {other:?}").into()),
    }
    Ok(())
}

#[test]
fn the_client_s_text_frame_decodes_as_the_daemon_expects() -> TestResult {
    let bytes = vector("text")?;
    match dr_dsh_daemon::proxy::message::decode(&bytes)? {
        ProxyMessage::WsData(data) => {
            assert_eq!(data.id, 1);
            assert_eq!(data.frame, WsFrame::Text("hello".to_owned()));
        }
        other => return Err(format!("expected a WsData, got {other:?}").into()),
    }
    Ok(())
}

#[test]
fn the_client_s_close_decodes_as_the_daemon_expects() -> TestResult {
    // A close carries no payload at all rather than an empty one. The daemon reads the kind byte
    // and stops, so a client that wrote a zero-length string here would leave the daemon reading
    // four bytes that are not there — a failure at the far end of a tunnel, which is the worst
    // place to debug one.
    let bytes = vector("close")?;
    match dr_dsh_daemon::proxy::message::decode(&bytes)? {
        ProxyMessage::WsData(data) => {
            assert_eq!(data.id, 1);
            assert_eq!(data.frame, WsFrame::Close);
        }
        other => return Err(format!("expected a WsData close, got {other:?}").into()),
    }
    Ok(())
}
