//! Errors raised while parsing, encoding, or validating protocol traffic.

use thiserror::Error;

/// Result alias for this crate.
pub type Result<T> = core::result::Result<T, ProtoError>;

/// A protocol violation or an unsupported peer.
///
/// Variants are deliberately coarse: a peer that misbehaves gets a
/// [`crate::FrameType::GoAway`] with the matching reason code, and the detail
/// belongs in the local log rather than on the wire.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ProtoError {
    /// The peer's major version differs from [`crate::WIRE_MAJOR`].
    #[error("incompatible wire major version: peer speaks {peer}, this build speaks {ours}")]
    VersionMismatch {
        /// Major version the peer announced.
        peer: u16,
        /// Major version this build implements.
        ours: u16,
    },
    /// Frame magic bytes were not `DR`.
    #[error("bad frame magic")]
    BadMagic,
    /// A declared payload length exceeds [`crate::MAX_PAYLOAD_LEN`].
    #[error("declared payload length {declared} exceeds the maximum {max}")]
    PayloadTooLarge {
        /// Length the peer declared.
        declared: u32,
        /// Largest length this build accepts.
        max: u32,
    },
    /// A frame referenced a stream that is not open.
    #[error("frame for unknown stream {stream_id}")]
    UnknownStream {
        /// The offending stream id.
        stream_id: u32,
    },
    /// The peer exceeded [`crate::MAX_CONCURRENT_STREAMS`].
    #[error("peer exceeded the concurrent stream limit of {max}")]
    TooManyStreams {
        /// The limit that was exceeded.
        max: u32,
    },
    /// The peer sent more bytes than its window allowed.
    #[error("peer overran the flow-control window by {overrun} bytes")]
    WindowOverrun {
        /// How far past the window the peer went.
        overrun: u32,
    },
    /// A control-plane message could not be decoded, or was of an unknown kind.
    #[error("malformed control message: {0}")]
    Control(String),
}
