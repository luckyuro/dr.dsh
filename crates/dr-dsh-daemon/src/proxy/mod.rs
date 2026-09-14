//! The proxy layer: DSH's HTTP surface, carried through the tunnel.
//!
//! # What this layer is for
//!
//! The remote client must reach the *real* DSH Web UI, not a reimplementation
//! ([ADR-0003](../../../docs/decisions/0003-no-fork-integration.md)). This module is
//! the daemon's half of that: it takes a request the client made, performs it against
//! `127.0.0.1:<port>` under the authority DSH authenticated, and returns the response
//! — status, headers, and body — unchanged.
//!
//! # Two things it deliberately does not do
//!
//! * **It does not relay the client's `Host`, `Cookie`, or `Origin`.** Those are the
//!   headers DSH's fences read, and letting a remote client choose them would defeat
//!   the fence the proxy exists to satisfy. See the header filters in `dsh::client`.
//! * **It does not interpret the body.** The request body is bytes on the way in and
//!   bytes on the way out. Nothing here parses JSON, walks a session, or knows what a
//!   prompt is.
//!
//! # Wire format
//!
//! Each proxied request uses one carrier stream. On that stream the two ends exchange
//! length-prefixed messages ([`message`]):
//!
//! ```text
//! client ─ RequestStart  ─▶ daemon   request id, method, target, headers
//! client ─ RequestBody*  ─▶ daemon   the request body, streamed
//! client ─ RequestEnd    ─▶ daemon
//! daemon ─ ResponseStart ◀─ client   status, headers
//! daemon ─ ResponseBody* ◀─ client   the response body, streamed
//! daemon ─ ResponseEnd   ◀─ client
//! daemon ─ Failure       ◀─ client   the request never reached DSH
//! ```
//!
//! Streaming rather than one blob because DSH streams: server-sent events, long agent
//! turns, and the client-side session feed all deliver over time, and a proxy that
//! buffered a response would turn "live progress" into "nothing, then everything".
//!
//! # Status: M0
//!
//! Request/response and WebSocket upgrades are both implemented. A real DSH accepts our
//! upgrade to `/api/remote.mux` under the authority and cookie the daemon authenticated
//! with (`crates/dr-dsh-daemon/tests/acceptance.rs`), and frames travel both ways
//! (`crates/dr-dsh-daemon/tests/proxy.rs`).
//!
//! What is *not* here: DSH's own protocol on that socket. The proxy forwards frames; it
//! does not know what a subscription or a session event is, and it should not.

pub mod message;
pub mod service;

pub use message::{
    MAGIC, ProxyCodecError, ProxyMessage, WsData, WsFrame, WsOpen, WsOpened, decode, encode,
};
pub use service::ProxyService;
