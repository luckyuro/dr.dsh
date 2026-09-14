//! Stream multiplexing and flow control.
//!
//! One carrier connection per daemon carries every client, every DSH HTTP
//! request/response, and the event stream. This module owns the state machine
//! that makes that safe: stream lifecycle, per-stream windows, and the
//! backpressure policy that keeps one large transfer from starving interactive
//! traffic.
//!
//! The relay does **not** link this module's state machine — it only needs
//! enough of the header to route a frame to the peer that owns the stream
//! (`docs/architecture.md` § Relay).
//!
//! Status: skeleton.

use crate::{INITIAL_WINDOW, MAX_CONCURRENT_STREAMS, ProtoError, Result};

/// Who opened a stream, which fixes the id parity and therefore the allocator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamOrigin {
    /// Opened by the remote client (odd ids).
    Client,
    /// Opened by the daemon (even ids), for server-pushed events.
    Daemon,
}

/// Lifecycle of one stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamState {
    /// `Open` sent, awaiting `OpenAck`.
    Opening,
    /// Both sides may send.
    Open,
    /// Local half closed; remote may still send.
    HalfClosedLocal,
    /// Remote half closed; local may still send.
    HalfClosedRemote,
    /// Fully closed; the id may be reused only by the allocator's wrap policy.
    Closed,
}

/// A multiplexer over one carrier connection.
///
/// Status: skeleton. The state machine lands with M0; this type exists so the
/// invariants below have a home and the daemon/relay agree on them.
#[derive(Debug)]
pub struct Multiplexer {
    /// Which side of the connection this endpoint is.
    pub origin: StreamOrigin,
    /// Streams currently tracked, keyed by id.
    pub streams: std::collections::BTreeMap<u32, StreamState>,
    /// Bytes this endpoint may still send, per stream.
    pub send_windows: std::collections::BTreeMap<u32, u32>,
}

impl Multiplexer {
    /// Creates an idle multiplexer for one side of a connection.
    #[must_use]
    pub fn new(origin: StreamOrigin) -> Self {
        Self {
            origin,
            streams: std::collections::BTreeMap::new(),
            send_windows: std::collections::BTreeMap::new(),
        }
    }

    /// Registers a locally opened stream.
    ///
    /// # Errors
    ///
    /// Returns [`ProtoError::TooManyStreams`] at [`MAX_CONCURRENT_STREAMS`], and
    /// [`ProtoError::UnknownStream`] if the id is already tracked.
    pub fn open(&mut self, stream_id: u32) -> Result<()> {
        if self.streams.len() as u32 >= MAX_CONCURRENT_STREAMS {
            return Err(ProtoError::TooManyStreams {
                max: MAX_CONCURRENT_STREAMS,
            });
        }
        if self.streams.contains_key(&stream_id) {
            return Err(ProtoError::UnknownStream { stream_id });
        }
        self.streams.insert(stream_id, StreamState::Opening);
        self.send_windows.insert(stream_id, INITIAL_WINDOW);
        Ok(())
    }
}
