//! Frame encoding and decoding.
//!
//! The relay links this module and nothing else that matters: it reads fixed
//! headers, forwards payloads it cannot interpret, and never learns what a
//! stream is carrying. Everything here is therefore format-only — no crypto, no
//! DSH knowledge (ADR-0002).

use bytes::{Buf, BufMut, Bytes};

use crate::{
    FRAME_HEADER_LEN, FRAME_MAGIC, FrameHeader, FrameType, MAX_PAYLOAD_LEN, ProtoError, Result,
};

/// A decoded frame: the cleartext header plus the payload exactly as it arrived.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    /// Cleartext routing header.
    pub header: FrameHeader,
    /// Payload bytes. Opaque to the relay; ciphertext plus AEAD tag for
    /// endpoints (see `dr-dsh-crypto`).
    pub payload: Bytes,
}

/// Writes `frame` into `dst` and returns the number of bytes appended.
///
/// Implementations must reject a payload larger than [`MAX_PAYLOAD_LEN`]; the
/// error is a programming fault at that point, not a peer fault, so callers are
/// expected to have chunked already.
///
/// # Errors
///
/// Returns [`ProtoError::PayloadTooLarge`] when the payload exceeds the cap.
pub fn encode(frame: &Frame, dst: &mut impl BufMut) -> Result<usize> {
    let len = u32::try_from(frame.payload.len()).map_err(|_| ProtoError::PayloadTooLarge {
        declared: u32::MAX,
        max: MAX_PAYLOAD_LEN,
    })?;
    if len > MAX_PAYLOAD_LEN {
        return Err(ProtoError::PayloadTooLarge {
            declared: len,
            max: MAX_PAYLOAD_LEN,
        });
    }
    dst.put_slice(&FRAME_MAGIC);
    dst.put_u16(frame.header.version.0);
    dst.put_u16(frame.header.version.1);
    dst.put_u16(frame.header.frame_type as u16);
    dst.put_u16(frame.header.flags);
    dst.put_u32(frame.header.stream_id);
    dst.put_u32(len);
    dst.put_slice(&frame.payload);
    Ok(FRAME_HEADER_LEN + len as usize)
}

/// Decodes one frame, consuming exactly its bytes from `src`.
///
/// Returns `Ok(None)` when `src` holds less than a complete frame: the caller
/// reads more and retries. This is the only place the header layout is parsed.
///
/// # Errors
///
/// Fails on bad magic, a major-version mismatch, or an oversized declared
/// length.
pub fn decode(src: &mut impl Buf) -> Result<Option<Frame>> {
    if src.remaining() < FRAME_HEADER_LEN {
        return Ok(None);
    }
    // Peek without consuming so a short buffer leaves `src` untouched.
    let bytes = src.chunk();
    if bytes[0..2] != FRAME_MAGIC {
        return Err(ProtoError::BadMagic);
    }
    let major = u16::from_be_bytes([bytes[2], bytes[3]]);
    if major != crate::WIRE_MAJOR {
        return Err(ProtoError::VersionMismatch {
            peer: major,
            ours: crate::WIRE_MAJOR,
        });
    }
    let minor = u16::from_be_bytes([bytes[4], bytes[5]]);
    let frame_type = u16::from_be_bytes([bytes[6], bytes[7]]);
    let flags = u16::from_be_bytes([bytes[8], bytes[9]]);
    let stream_id = u32::from_be_bytes([bytes[10], bytes[11], bytes[12], bytes[13]]);
    let payload_len = u32::from_be_bytes([bytes[14], bytes[15], bytes[16], bytes[17]]);
    if payload_len > MAX_PAYLOAD_LEN {
        return Err(ProtoError::PayloadTooLarge {
            declared: payload_len,
            max: MAX_PAYLOAD_LEN,
        });
    }
    let total = FRAME_HEADER_LEN + payload_len as usize;
    if src.remaining() < total {
        return Ok(None);
    }
    src.advance(FRAME_HEADER_LEN);
    let payload = src.copy_to_bytes(payload_len as usize);
    Ok(Some(Frame {
        header: FrameHeader {
            version: (major, minor),
            frame_type: FrameType::from_u16(frame_type)?,
            flags,
            stream_id,
            payload_len,
        },
        payload,
    }))
}

impl FrameType {
    /// Converts a wire value into a [`FrameType`].
    ///
    /// # Errors
    ///
    /// Returns [`ProtoError::Control`] for an unknown type, which the carrier
    /// turns into a `GoAway`.
    pub fn from_u16(value: u16) -> Result<Self> {
        Ok(match value {
            0x0001 => Self::Open,
            0x0002 => Self::OpenAck,
            0x0003 => Self::OpenReject,
            0x0010 => Self::Data,
            0x0011 => Self::Fin,
            0x0012 => Self::Reset,
            0x0020 => Self::WindowUpdate,
            0x0030 => Self::Ping,
            0x0031 => Self::Pong,
            0x007f => Self::GoAway,
            other => {
                return Err(ProtoError::Control(format!(
                    "unknown frame type 0x{other:04x}"
                )));
            }
        })
    }
}
