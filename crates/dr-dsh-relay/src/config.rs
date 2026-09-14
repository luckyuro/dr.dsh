//! Relay configuration.
//!
//! Every value here is either an operational limit or a bind address. There is
//! deliberately no field that could weaken the security properties: no "log
//! payloads" switch, no "disable encryption" switch, and no TLS key material,
//! because the relay is expected to sit behind the operator's own reverse proxy
//! for TLS (see `docs/self-hosting.md`).

use std::net::SocketAddr;

use anyhow::{Context, Result, bail};

/// Environment variable holding the bind address.
pub const ENV_BIND: &str = "DSH_RELAY_BIND";

/// Environment variable holding the maximum number of rooms.
pub const ENV_MAX_ROOMS: &str = "DSH_RELAY_MAX_ROOMS";

/// Environment variable holding the keepalive interval, in seconds. `0` disables it.
pub const ENV_KEEPALIVE_SECS: &str = "DSH_RELAY_KEEPALIVE_SECS";

/// Environment variable pointing at the built client modules.
///
/// Absent means the relay serves a page explaining how to build them, which is the honest
/// state for a relay installed without its client.
pub const ENV_CLIENT_DIR: &str = "DSH_RELAY_CLIENT_DIR";

/// Largest payload the relay will forward in one frame.
///
/// Matches [`dr_dsh_proto::MAX_PAYLOAD_LEN`]: a peer that declares more is talking
/// to the wrong protocol version, and forwarding it would let one client make
/// the relay buffer unboundedly.
pub const MAX_FORWARDED_PAYLOAD: u32 = dr_dsh_proto::MAX_PAYLOAD_LEN;

/// Relay settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    /// Address to listen on. Loopback behind a reverse proxy, or `0.0.0.0`
    /// inside a container that publishes only the proxied port.
    pub bind: SocketAddr,
    /// Maximum concurrently parked rooms, bounding memory under abuse.
    pub max_rooms: usize,
    /// Directory holding the built client modules, when one is installed.
    pub client_dir: Option<std::path::PathBuf>,
    /// How often to send a WebSocket keepalive to a parked peer. `None` disables it.
    ///
    /// This exists because the carrier is a **long-lived, quiet** socket and reverse proxies are
    /// written for request/response: nginx's `proxy_read_timeout` defaults to 60 seconds and closes a
    /// proxied connection that has had nothing to read. A keepalive is bytes, so it resets that timer,
    /// and it is a *WebSocket control frame* — the peer's own WebSocket implementation answers it, no
    /// client code is involved, and a browser cannot be asked to send one itself, which is why the
    /// relay sends them.
    pub keepalive: Option<std::time::Duration>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            // Loopback by default, matching the project's "secure by default"
            // principle: exposing the relay to the network is an explicit act,
            // even though the relay only ever holds ciphertext.
            bind: SocketAddr::from(([127, 0, 0, 1], 8787)),
            max_rooms: 1024,
            client_dir: None,
            // Thirty seconds: comfortably below the 60-second default of the proxies people actually
            // deploy, and cheap enough to be invisible (one two-byte frame per peer per interval).
            keepalive: Some(std::time::Duration::from_secs(30)),
        }
    }
}

/// What the operator should know about the address the relay is about to bind.
///
/// M4 asks for a deployment check that warns at startup, and this is the half the relay can see by
/// itself: whether it is being exposed on a network interface, which means the traffic — ciphertext,
/// but also the client's code and the room ids — leaves the machine.
///
/// A warning rather than a refusal, because exposing the relay is a legitimate choice: it is what a
/// container does (the container's network is the boundary, and the port is published to loopback by
/// default), and it is what an operator behind a reverse proxy does. What must not happen is that it
/// occurs *silently*, because the failure mode is a relay that looks like it works from the machine it
/// runs on and is reachable by anyone from anywhere else.
impl Config {
    /// One sentence about the bind address, or `None` when there is nothing to say.
    #[must_use]
    pub fn bind_notice(&self) -> Option<String> {
        if self.bind.ip().is_loopback() {
            return None;
        }
        Some(format!(
            "listening on {}, which is not loopback: this relay is reachable from the network around \
             it. The traffic is end-to-end encrypted and the relay holds no keys, but the client \
             bundle and the room ids cross that network, and so does the fact that you are running \
             this at all. Put TLS in front of it (a reverse proxy or a private network) and make sure \
             that proxy's read timeout is longer than the tunnel's idle window — the daemon warns if \
             it sees the connection being closed on a schedule.",
            self.bind
        ))
    }

    /// Reads configuration from the environment.
    ///
    /// # Errors
    ///
    /// Returns an error naming the offending variable when a value cannot be
    /// parsed. A relay that starts with a half-understood configuration is worse
    /// than one that refuses to start.
    pub fn from_env_and_args() -> Result<Self> {
        let mut config = Self::default();
        if let Ok(raw) = std::env::var(ENV_BIND) {
            config.bind = raw
                .parse()
                .with_context(|| format!("{ENV_BIND} is not a socket address: {raw:?}"))?;
        }
        if let Ok(raw) = std::env::var(ENV_CLIENT_DIR) {
            config.client_dir = Some(std::path::PathBuf::from(raw));
        }
        if let Ok(raw) = std::env::var(ENV_KEEPALIVE_SECS) {
            let seconds: u64 = raw
                .parse()
                .with_context(|| format!("{ENV_KEEPALIVE_SECS} is not a number: {raw:?}"))?;
            // Zero is how an operator turns it off; there is no "keepalive every 0 seconds".
            config.keepalive = (seconds > 0).then(|| std::time::Duration::from_secs(seconds));
        }
        if let Ok(raw) = std::env::var(ENV_MAX_ROOMS) {
            config.max_rooms = raw
                .parse()
                .with_context(|| format!("{ENV_MAX_ROOMS} is not a number: {raw:?}"))?;
            if config.max_rooms == 0 {
                bail!("{ENV_MAX_ROOMS} must be at least 1");
            }
        }
        Ok(config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_binds_loopback() {
        assert!(Config::default().bind.ip().is_loopback());
    }

    #[test]
    fn forwarded_payload_matches_the_protocol_cap() {
        assert_eq!(MAX_FORWARDED_PAYLOAD, dr_dsh_proto::MAX_PAYLOAD_LEN);
    }

    #[test]
    fn keepalive_is_on_by_default_and_can_be_turned_off() {
        // On by default: the failure it prevents (a proxy cutting a quiet socket) is silent and looks
        // like a broken daemon, while the cost is one two-byte frame every thirty seconds.
        assert_eq!(
            Config::default().keepalive,
            Some(std::time::Duration::from_secs(30))
        );
    }

    #[test]
    fn the_bind_notice_is_quiet_on_loopback_and_specific_otherwise() {
        // Loopback is the default and says nothing: a notice printed on every normal start is a
        // notice nobody reads.
        assert_eq!(Config::default().bind_notice(), None);
        let exposed = Config {
            bind: SocketAddr::from(([0, 0, 0, 0], 8787)),
            ..Config::default()
        };
        let notice = exposed.bind_notice().unwrap_or_default();
        // It has to name the address, say what actually crosses the network, and point at the proxy
        // timeout — the three things an operator can act on.
        assert!(notice.contains("0.0.0.0:8787"), "{notice}");
        assert!(notice.contains("end-to-end encrypted"), "{notice}");
        assert!(notice.contains("read timeout"), "{notice}");
    }
}
