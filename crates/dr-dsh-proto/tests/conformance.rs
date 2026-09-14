//! Asserts the Rust codec against the shared conformance corpus.
//!
//! The corpus lives at `packages/protocol/conformance/vectors.json` and is read
//! here with `include_str!`, so the bytes are compiled into the test binary and
//! a contributor cannot "fix" a failure by editing a copy. The TypeScript side
//! reads the same file (`packages/protocol/src/conformance.ts`); when this test
//! and that one disagree, the two implementations have diverged, which is a
//! release blocker (ADR-0004).
//!
//! Style note: clippy's `unwrap_used`/`expect_used` are denied workspace-wide, so
//! the helpers below return `Result` and the tests use `?`. That is not ceremony
//! — a corpus that silently failed to load would turn this file into a test that
//! always passes, which is the one outcome it must never have.

use std::fmt::Write as _;

use dr_dsh_proto::frame::{self, Frame};
use dr_dsh_proto::{FrameHeader, FrameType, ProtoError};
use serde::Deserialize;

const CORPUS: &str = include_str!("../../../packages/protocol/conformance/vectors.json");

/// A corpus or codec failure, carrying enough context to fix it.
type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

#[derive(Debug, Deserialize)]
struct Corpus {
    frames: Vec<FrameVector>,
    rejections: Vec<RejectionVector>,
}

#[derive(Debug, Deserialize)]
struct FrameVector {
    name: String,
    hex: String,
    version: (u16, u16),
    #[serde(rename = "frameType")]
    frame_type: u16,
    flags: u16,
    #[serde(rename = "streamId")]
    stream_id: u32,
    #[serde(rename = "payloadHex")]
    payload_hex: String,
}

#[derive(Debug, Deserialize)]
struct RejectionVector {
    name: String,
    hex: String,
    reason: String,
}

fn corpus() -> TestResult<Corpus> {
    Ok(serde_json::from_str(CORPUS)?)
}

fn unhex(text: &str) -> TestResult<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return Err(format!("hex string has an odd length: {}", text.len()).into());
    }
    let mut out = Vec::with_capacity(text.len() / 2);
    for index in 0..text.len() / 2 {
        let pair = text
            .get(index * 2..index * 2 + 2)
            .ok_or_else(|| format!("hex string is truncated at byte {index}"))?;
        out.push(u8::from_str_radix(pair, 16)?);
    }
    Ok(out)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::new(), |mut out, byte| {
        // Writing into a String cannot fail; the alternative bans `expect` at the
        // cost of one allocation per byte.
        let _ = write!(out, "{byte:02x}");
        out
    })
}

fn frame_type_of(value: u16) -> TestResult<FrameType> {
    Ok(FrameType::from_u16(value)?)
}

#[test]
fn decodes_every_vector() -> TestResult {
    for vector in corpus()?.frames {
        let bytes = unhex(&vector.hex)?;
        let mut cursor = bytes.as_slice();
        let decoded = frame::decode(&mut cursor)
            .map_err(|error| format!("{}: decode failed: {error}", vector.name))?
            .ok_or_else(|| format!("{}: expected a complete frame", vector.name))?;
        assert_eq!(
            decoded.header.version, vector.version,
            "{}: version",
            vector.name
        );
        assert_eq!(
            decoded.header.frame_type,
            frame_type_of(vector.frame_type)?,
            "{}: frame type",
            vector.name
        );
        assert_eq!(decoded.header.flags, vector.flags, "{}: flags", vector.name);
        assert_eq!(
            decoded.header.stream_id, vector.stream_id,
            "{}: stream id",
            vector.name
        );
        assert_eq!(
            hex(&decoded.payload),
            vector.payload_hex,
            "{}: payload",
            vector.name
        );
        assert!(
            cursor.is_empty(),
            "{}: decode left bytes unconsumed",
            vector.name
        );
    }
    Ok(())
}

#[test]
fn re_encodes_every_vector_byte_for_byte() -> TestResult {
    for vector in corpus()?.frames {
        let decoded = Frame {
            header: FrameHeader {
                version: vector.version,
                frame_type: frame_type_of(vector.frame_type)?,
                flags: vector.flags,
                stream_id: vector.stream_id,
                payload_len: u32::try_from(vector.payload_hex.len() / 2)?,
            },
            payload: unhex(&vector.payload_hex)?.into(),
        };
        let mut encoded = Vec::new();
        frame::encode(&decoded, &mut encoded)?;
        assert_eq!(
            hex(&encoded),
            vector.hex,
            "{}: re-encoded bytes",
            vector.name
        );
    }
    Ok(())
}

#[test]
fn rejects_every_rejection_vector() -> TestResult {
    for vector in corpus()?.rejections {
        let bytes = unhex(&vector.hex)?;
        let mut cursor = bytes.as_slice();
        let error = match frame::decode(&mut cursor) {
            Ok(Some(_)) => {
                return Err(format!("{}: expected a rejection, got a frame", vector.name).into());
            }
            Ok(None) => {
                return Err(format!(
                    "{}: expected a rejection, got an incomplete buffer",
                    vector.name
                )
                .into());
            }
            Err(error) => error,
        };
        let expected = match vector.reason.as_str() {
            "bad_magic" => ProtoError::BadMagic,
            "version_mismatch" => ProtoError::VersionMismatch {
                peer: 1,
                ours: dr_dsh_proto::WIRE_MAJOR,
            },
            "payload_too_large" => ProtoError::PayloadTooLarge {
                declared: 65537,
                max: dr_dsh_proto::MAX_PAYLOAD_LEN,
            },
            "unknown_frame_type" => {
                assert!(
                    matches!(error, ProtoError::Control(_)),
                    "{}: {error}",
                    vector.name
                );
                continue;
            }
            other => return Err(format!("unknown rejection reason in the corpus: {other}").into()),
        };
        assert_eq!(error, expected, "{}: rejection reason", vector.name);
    }
    Ok(())
}

#[test]
fn a_truncated_frame_is_incomplete_not_an_error() -> TestResult {
    let frames = corpus()?.frames;
    let vector = frames
        .get(2)
        .ok_or("the corpus must contain at least three frame vectors")?;
    let full = unhex(&vector.hex)?;
    for length in 0..full.len() {
        let mut cursor = &full[..length];
        assert!(
            matches!(frame::decode(&mut cursor), Ok(None)),
            "a {length}-byte prefix must read as incomplete"
        );
    }
    Ok(())
}

#[test]
fn a_payload_at_the_cap_is_accepted_and_one_above_is_refused() -> TestResult {
    let at_cap = Frame {
        header: FrameHeader {
            version: dr_dsh_proto::WIRE_VERSION,
            frame_type: FrameType::Data,
            flags: 0,
            stream_id: 1,
            payload_len: dr_dsh_proto::MAX_PAYLOAD_LEN,
        },
        payload: vec![0_u8; dr_dsh_proto::MAX_PAYLOAD_LEN as usize].into(),
    };
    let mut encoded = Vec::new();
    frame::encode(&at_cap, &mut encoded)?;
    assert_eq!(
        encoded.len(),
        dr_dsh_proto::FRAME_HEADER_LEN + dr_dsh_proto::MAX_PAYLOAD_LEN as usize
    );

    let above_cap = Frame {
        header: FrameHeader {
            payload_len: dr_dsh_proto::MAX_PAYLOAD_LEN + 1,
            ..at_cap.header
        },
        payload: vec![0_u8; dr_dsh_proto::MAX_PAYLOAD_LEN as usize + 1].into(),
    };
    let mut sink = Vec::new();
    assert!(matches!(
        frame::encode(&above_cap, &mut sink),
        Err(ProtoError::PayloadTooLarge { .. })
    ));
    Ok(())
}
