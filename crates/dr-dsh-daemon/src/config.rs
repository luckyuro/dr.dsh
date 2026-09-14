//! Daemon configuration and on-disk state.
//!
//! Two separate files, because they have different owners and different
//! sensitivities:
//!
//! * **config** is written by the user (or the DSH plugin on their behalf). It is
//!   plain text, safe to paste into a bug report, and never contains secrets.
//! * **state** is written by the daemon. It holds the room identity key and the
//!   paired-device registry. It must be created `0600` and must never be logged.
//!
//! Splitting them is what makes "paste your config" a safe support request.
//!
//! Status: skeleton.

use std::path::PathBuf;

/// How the daemon should reach DSH.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DshMode {
    /// The daemon starts and supervises DSH itself.
    Managed {
        /// Port DSH is started on. Always loopback.
        port: u16,
        /// Executable to run; resolved on `PATH` when relative.
        executable: PathBuf,
    },
    /// DSH was started by the user; the daemon only proxies it.
    ///
    /// Lifecycle commands are refused in this mode (project definition § 8). The
    /// daemon does not know how a hand-started process was configured, so it
    /// cannot honestly claim to be able to restart it the same way.
    Attached {
        /// Port the existing instance is listening on.
        port: u16,
    },
}

/// The loopback host DSH is allowed to bind.
///
/// There is exactly one legal value. It is a constant rather than a
/// configuration field on purpose: "refuse to bind DSH to a non-loopback
/// address" (§ 9.6) is enforced by there being nothing to configure.
pub const LOOPBACK_HOST: &str = "127.0.0.1";

/// Parsed daemon configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    /// Relay to dial. Never a listen address: the daemon is outbound-only.
    pub relay_url: String,
    /// How DSH is reached.
    pub dsh: DshMode,
    /// Whether this daemon may run lifecycle commands at all.
    pub allow_lifecycle: bool,
}

impl Config {
    /// The loopback base URL of the DSH instance this configuration describes.
    #[must_use]
    pub fn dsh_base_url(&self) -> String {
        let port = match &self.dsh {
            DshMode::Managed { port, .. } | DshMode::Attached { port } => *port,
        };
        format!("http://{LOOPBACK_HOST}:{port}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_is_always_loopback() {
        let config = Config {
            relay_url: "wss://relay.example".to_owned(),
            dsh: DshMode::Managed {
                port: 3080,
                executable: PathBuf::from("dsh"),
            },
            allow_lifecycle: true,
        };
        assert_eq!(config.dsh_base_url(), "http://127.0.0.1:3080");
    }
}
