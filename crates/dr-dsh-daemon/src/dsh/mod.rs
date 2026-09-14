//! The DSH process this daemon supervises.
//!
//! Everything the daemon needs to know about the harness on the user's machine
//! lives under this module. It is the *only* place that depends on DSH's
//! externally observable behaviour, and the contracts it relies on are recorded
//! in `docs/integration/dsh-surface.md`.
//!
//! Layout:
//!
//! * [`ready`] — parsing the readiness line, which is how DSH announces both its
//!   port and its one-time process token.
//! * [`client`] — the loopback HTTP client, including the token→cookie exchange.
//! * [`supervisor`] — spawning, watching, and stopping the child process.
//!
//! Two invariants hold across all of it, and both exist because DSH's
//! authentication is authority-bound (`docs/security.md` § 2.5):
//!
//! 1. Every request this module makes carries `Host: 127.0.0.1:<port>`, the same
//!    authority the token exchange was performed under. A different authority
//!    invalidates the session cookie, by design.
//! 2. DSH is started on loopback and the port is chosen by the daemon. There is
//!    no configuration path to a non-loopback bind.

pub mod client;
pub mod ready;
pub mod supervisor;

pub use client::{DshClient, DshClientError, WebSocketConn, WsFrame, WsReader, WsWriter};
pub use supervisor::{Supervisor, SupervisorConfig, SupervisorSpawner};
