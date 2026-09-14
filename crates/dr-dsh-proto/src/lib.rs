//! # dr-dsh-proto — the dr.dsh wire protocol
//!
//! Every byte exchanged between a remote client, the relay, and a local daemon
//! is described here. The crate is deliberately dependency-light: it is the
//! schema of record that the Rust daemon/relay and the TypeScript client both
//! implement, and the place conformance fixtures are generated from.
//!
//! ## Two planes
//!
//! * **The carrier plane** ([`frame`], [`mux`]) is what the relay understands:
//!   a versioned binary framing with stream multiplexing and flow control. The
//!   relay parses exactly this much and nothing more — frame headers are
//!   cleartext routing metadata, frame payloads are opaque ciphertext.
//! * **The payload plane** ([`control`], [`json`]) is what only endpoints
//!   understand: lifecycle commands, device management, DSH session bootstrap,
//!   and notifications. It rides inside carrier stream payloads and is
//!   therefore never visible to the relay.
//!
//! Keeping those two planes in one crate is intentional — they are versioned
//! together — but the module boundary is what makes the zero-knowledge claim
//! checkable: [`frame`] and [`mux`] must never depend on [`control`].
//!
//! ## Status
//!
//! Skeleton. The module layout, the constants, and the carrier frame header are
//! nailed down; message bodies and the codec land with M0.
//!
//! See `docs/protocol.md` for the normative description and
//! `docs/decisions/0004-wire-protocol.md` for why it looks like this.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod control;
pub mod device;
pub mod error;
pub mod frame;
pub mod json;
pub mod mux;

pub use error::{ProtoError, Result};

/// Wire protocol major version.
///
/// A peer that does not share this major version must refuse the connection
/// instead of degrading: the frame header layout is part of the major version.
/// (`docs/protocol.md` § Compatibility)
pub const WIRE_MAJOR: u16 = 0;

/// Wire protocol minor version.
///
/// Minor versions are additive. A peer accepts a lower minor version from its
/// counterpart and must not send any frame type it has not negotiated.
pub const WIRE_MINOR: u16 = 1;

/// The exact protocol version this build implements.
pub const WIRE_VERSION: (u16, u16) = (WIRE_MAJOR, WIRE_MINOR);

/// A single frame, as it appears on the wire (unencrypted framing header).
///
/// The fixed header is 18 bytes so the relay can parse it without knowing any
/// payload format:
///
/// ```text
///  0               1               2               3
/// +---------------+---------------+---------------+---------------+
/// |  magic 'D'    |  magic 'R'    |  ver_major    |  ver_minor    |
/// +---------------+---------------+---------------+---------------+
/// |         frame_type            |           flags               |
/// +---------------+---------------+---------------+---------------+
/// |                        stream_id                              |
/// +---------------+---------------+---------------+---------------+
/// |                        payload_len                            |
/// +---------------+---------------+---------------+---------------+
/// ```
///
/// `payload_len` counts payload bytes only and is bounded by
/// [`MAX_PAYLOAD_LEN`]; a peer that reads a larger value closes the connection
/// with a protocol error rather than allocating.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameHeader {
    /// Protocol version this frame was written with.
    pub version: (u16, u16),
    /// What the frame is; see [`FrameType`].
    pub frame_type: FrameType,
    /// Frame-type-specific flags; zero unless the type defines them.
    pub flags: u16,
    /// Stream this frame belongs to; `0` is the connection control stream.
    pub stream_id: u32,
    /// Number of payload bytes following the header.
    pub payload_len: u32,
}

/// Size of the fixed frame header in bytes: 2 magic + 2+2 version + 2 type
/// + 2 flags + 4 stream id + 4 payload length.
pub const FRAME_HEADER_LEN: usize = 18;

/// Largest payload a single frame may carry.
///
/// Deliberately modest: a smaller cap forces the multiplexer to interleave
/// large transfers instead of starving interactive traffic, and it bounds the
/// memory a hostile peer can make the relay buffer (spec § 9.6 frame limits).
pub const MAX_PAYLOAD_LEN: u32 = 64 * 1024;

/// Bytes of the frame magic, `DR`.
pub const FRAME_MAGIC: [u8; 2] = *b"DR";

/// What a frame means to the carrier.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u16)]
pub enum FrameType {
    /// Opens a stream and carries the client's binding to a room or device.
    Open = 0x0001,
    /// Accepts a previously opened stream.
    OpenAck = 0x0002,
    /// Refuses a stream open; payload carries a reason code.
    OpenReject = 0x0003,
    /// Application bytes for a stream; payload is endpoint-encrypted.
    Data = 0x0010,
    /// Half-close: no more data from this sender on this stream.
    Fin = 0x0011,
    /// Abort a stream; payload carries a reason code.
    Reset = 0x0012,
    /// Grants the peer permission to send more bytes on a stream.
    WindowUpdate = 0x0020,
    /// Liveness probe, answered by [`FrameType::Pong`].
    Ping = 0x0030,
    /// Answer to [`FrameType::Ping`].
    Pong = 0x0031,
    /// Connection-level error; the connection must close afterwards.
    GoAway = 0x007f,
}

/// The reason a relay gives when it ends a carrier because its session is over.
///
/// A carrier serves exactly one client session, so when that session's client leaves, the
/// relay closes the carrier and the daemon re-registers. The daemon has to be able to tell
/// that apart from a carrier that broke: the two look identical on the wire, and answering
/// a deliberate release with the backoff meant for a broken relay is what refuses the next
/// client for the whole reconnection window.
///
/// It lives here because it is a wire contract, not an implementation detail: the relay
/// writes this exact string and the daemon matches on it.
pub const SESSION_OVER: &str = "session over";

/// Reserved stream id for the connection control stream (handshake, ping).
pub const CONTROL_STREAM_ID: u32 = 0;

/// First stream id a client may allocate.
pub const FIRST_CLIENT_STREAM_ID: u32 = 1;

/// First stream id a daemon may allocate (server-initiated streams).
pub const FIRST_DAEMON_STREAM_ID: u32 = 2;

/// Initial per-stream flow-control window, in bytes.
pub const INITIAL_WINDOW: u32 = 256 * 1024;

/// Largest flow-control window a peer may advertise.
pub const MAX_WINDOW: u32 = 16 * 1024 * 1024;

/// Largest number of streams a peer may have open at once on one connection.
pub const MAX_CONCURRENT_STREAMS: u32 = 64;

/// Largest number of devices (clients) a single room may register.
pub const MAX_DEVICES_PER_ROOM: u32 = 16;

/// Lifetime of a pairing code, in seconds.
///
/// Short by design: the code is the only low-entropy secret in the system, and
/// it is single-use (`docs/security.md` § Pairing).
pub const PAIRING_CODE_TTL_SECS: u64 = 300;

/// Entropy of a pairing code, in bits, once its grouping is removed.
pub const PAIRING_CODE_ENTROPY_BITS: u32 = 40;
