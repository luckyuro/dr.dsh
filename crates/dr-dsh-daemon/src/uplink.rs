//! The outbound carrier connection to a relay.
//!
//! The daemon never listens for the internet. It dials the relay, authenticates
//! the room, and then behaves as the server side of every stream the client
//! opens — which is why "no public IP, no router configuration, no inbound
//! port" holds without a NAT-traversal story (project definition § 4).
//!
//! ## Reconnect policy
//!
//! Jittered exponential backoff, and the daemon keeps supervising DSH while the
//! uplink is down: losing the relay must never cost the user their local
//! session. The uplink reports its own state out-of-band so the PWA can show
//! "your computer is reachable / not reachable" instead of a spinner
//! (§ 9.7 failure transparency).
//!
//! Status: skeleton.

use std::time::Duration;

use tokio::sync::mpsc;

/// How long to wait before re-registering a carrier whose session has ended.
///
/// This is a turn-around, not a retry: the relay closed the carrier because its client
/// left, and a client that arrives while the room is unregistered is refused outright. A
/// small delay keeps a reconnect loop from starving a busy relay of the chance to answer.
const RE_REGISTER_DELAY_MS: u64 = 20;

/// How many times in a row a session ending may trigger an immediate re-registration.
///
/// Without a bound this is a spin: a relay that accepts the connection and immediately
/// closes it would be re-dialed as fast as the network allows. Once the run is exhausted
/// the ordinary backoff takes over, so a genuinely broken relay is still treated as one.
const MAX_FAST_RE_REGISTRATIONS: u32 = 8;

/// Environment variable holding the carrier keepalive interval, in seconds. `0` disables it.
///
/// `DSHD_` because it configures this daemon, next to `DSHD_STATE_DIR`; the relay's matching
/// knob is `DSH_RELAY_KEEPALIVE_SECS`.
pub const ENV_KEEPALIVE_SECS: &str = "DSHD_KEEPALIVE_SECS";

/// How often an idle carrier is pinged unless the environment says otherwise.
///
/// Thirty seconds because it has to be below a reverse proxy's idle timeout, and the common
/// default to beat is nginx's 60 seconds. Half of it leaves room for a missed tick without
/// the proxy ever seeing a silent minute.
pub const DEFAULT_KEEPALIVE_SECS: u64 = 30;

// Below the common 60-second proxy timeout, so one missed tick is still not a silent minute. A
// compile-time assertion rather than a test: this is a property of the constant, and raising the
// default into the danger zone should fail the build rather than one test.
const _: () = assert!(DEFAULT_KEEPALIVE_SECS < 60);

/// Parses the keepalive setting from an environment value.
///
/// Pure, so the rule can be tested without touching the process environment — and the rule is
/// worth testing because "0" has to mean *off* rather than "every zero seconds".
///
/// # Errors
///
/// Returns an error naming the variable when the value is not a number. A daemon that silently
/// ignored a typo here would reconnect on a schedule nobody chose.
pub fn keepalive_setting(raw: Option<&str>) -> Result<Option<Duration>, String> {
    let Some(raw) = raw else {
        return Ok(Some(Duration::from_secs(DEFAULT_KEEPALIVE_SECS)));
    };
    let seconds: u64 = raw
        .parse()
        .map_err(|_| format!("{ENV_KEEPALIVE_SECS} is not a number: {raw:?}"))?;
    Ok((seconds > 0).then(|| Duration::from_secs(seconds)))
}

/// Reads the keepalive setting from the environment.
///
/// # Errors
///
/// See [`keepalive_setting`].
pub fn keepalive_from_env() -> Result<Option<Duration>, String> {
    keepalive_setting(std::env::var(ENV_KEEPALIVE_SECS).ok().as_deref())
}

/// Reconnect schedule. Pure so it can be tested without a clock or a network.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Backoff {
    /// Delay before the first retry.
    pub base: Duration,
    /// Ceiling for the delay.
    pub max: Duration,
}

impl Default for Backoff {
    fn default() -> Self {
        Self {
            base: Duration::from_millis(500),
            max: Duration::from_secs(30),
        }
    }
}

impl Backoff {
    /// Delay before attempt `attempt` (1-based), before jitter is applied.
    ///
    /// Doubling with a ceiling: a laptop that slept for eight hours must not
    /// wake up and hammer the relay, and a relay that just restarted must not
    /// wait thirty seconds for its first reconnection.
    #[must_use]
    pub fn delay(&self, attempt: u32) -> Duration {
        let exponent = attempt.saturating_sub(1).min(16);
        let scaled = self.base.saturating_mul(1_u32 << exponent);
        scaled.min(self.max)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keepalive_defaults_on_and_zero_means_off() {
        // Absent is the common case — almost nobody sets this — and it has to mean "on": a
        // keepalive that only happens when someone configures it is not a defence against a
        // proxy's default timeout, which is the failure it exists for.
        assert_eq!(
            keepalive_setting(None),
            Ok(Some(Duration::from_secs(DEFAULT_KEEPALIVE_SECS)))
        );
        assert_eq!(
            keepalive_setting(Some("5")),
            Ok(Some(Duration::from_secs(5)))
        );
        // Zero is how an operator turns it off; there is no "keepalive every 0 seconds".
        assert_eq!(keepalive_setting(Some("0")), Ok(None));
        // A typo is an error naming the variable, not silence. The exact message is asserted
        // because "which variable was wrong" is the whole value of failing here: an operator with
        // two keepalive settings on one host needs to know which one to fix.
        assert_eq!(
            keepalive_setting(Some("30s")),
            Err(format!("{ENV_KEEPALIVE_SECS} is not a number: \"30s\""))
        );
        assert_eq!(
            keepalive_setting(Some("-1")),
            Err(format!("{ENV_KEEPALIVE_SECS} is not a number: \"-1\""))
        );
    }

    #[test]
    fn only_the_relay_s_own_reason_counts_as_a_release() {
        use crate::transport::TransportError;

        let named = |reason: &str| TransportError::SessionEnded {
            reason: reason.to_owned(),
        };

        // The positive case is the relay's constant, not a copy of it, and it arrives in the
        // envelope the relay actually writes. Feeding the bare string here is what let a
        // real mismatch pass this test while every release still took the backoff path, so
        // the envelope is part of the case rather than incidental to it.
        assert!(released_by_relay(&named(&format!(
            "{{\"type\":\"close\",\"reason\":\"{}\"}}",
            dr_dsh_proto::SESSION_OVER
        ))));

        // Any other reason is not this contract, however it is framed.
        assert!(!released_by_relay(&named(
            "{\"type\":\"close\",\"reason\":\"something else\"}"
        )));
        // A reason that merely contains the phrase is not the relay's own reason.
        assert!(!released_by_relay(&named(&format!(
            "{{\"type\":\"close\",\"reason\":\"not {} at all\"}}",
            dr_dsh_proto::SESSION_OVER
        ))));
        // The bare string is what the relay does *not* send; accepting it would hide the
        // framing mismatch above.
        assert!(!released_by_relay(&named(dr_dsh_proto::SESSION_OVER)));
        // And a carrier that simply broke takes the backoff path.
        assert!(!released_by_relay(&TransportError::Transport(
            "the relay closed the connection".to_owned()
        )));
        assert!(!released_by_relay(&TransportError::ProtocolViolation(
            "a text frame"
        )));
    }

    #[test]
    fn delay_grows_then_plateaus() {
        let backoff = Backoff::default();
        assert_eq!(backoff.delay(1), Duration::from_millis(500));
        assert_eq!(backoff.delay(2), Duration::from_secs(1));
        assert_eq!(backoff.delay(3), Duration::from_secs(2));
        assert_eq!(backoff.delay(100), backoff.max);
        assert_eq!(backoff.delay(0), backoff.base);
    }
}

/// Where a handler puts the messages it wants written back.
///
/// A channel rather than a return value: the uplink must not know what a request is,
/// and a handler that performs I/O (the proxy does) cannot produce its answer
/// synchronously. The channel is created per connection, so a message queued for a
/// carrier that has since died cannot be written onto the next one.
pub type Outbox = mpsc::Sender<Outbound>;

/// One message to put on the carrier.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outbound {
    /// Stream to send on.
    pub stream_id: u32,
    /// Plaintext payload; the transport seals it before it leaves the process.
    pub payload: Vec<u8>,
}

/// Everything one carrier connection needs before it can be dialed.
///
/// One argument rather than five. Three of these are connection identity of the same shape, so a call
/// site that swapped two of them would still compile; and [`run`] already takes a state callback, a
/// shutdown future, and a handler, which is more arguments than a reader can hold positionally.
pub struct CarrierConfig {
    /// Relay to dial. Never a listen address: the daemon is outbound-only.
    pub relay_url: String,
    /// Room to park. Derivable from the room key, and passed in so both ends use the same string.
    pub room: String,
    /// The room key both ends derive their session from.
    pub root: [u8; dr_dsh_crypto::SESSION_KEY_LEN],
    /// Which clients this daemon will accept.
    pub policy: crate::transport::DevicePolicy,
    /// How often to ping an idle carrier. `None` disables keepalive.
    pub keepalive: Option<Duration>,
    /// Where the audit log lives (ADR-0012).
    ///
    /// The uplink is the only place that knows a session *started* and *ended*, and the device that
    /// proved itself on it, so it is the only place that can record those two events.
    pub audit_dir: std::path::PathBuf,
}

impl CarrierConfig {
    /// Builds a carrier configuration from its parts.
    #[must_use]
    pub fn new(
        relay_url: String,
        room: String,
        root: [u8; dr_dsh_crypto::SESSION_KEY_LEN],
        policy: crate::transport::DevicePolicy,
        keepalive: Option<Duration>,
        audit_dir: std::path::PathBuf,
    ) -> Self {
        Self {
            relay_url,
            room,
            root,
            policy,
            keepalive,
            audit_dir,
        }
    }
}

/// Keeps a carrier connection to the relay alive, and serves it.
///
/// # One session per carrier, and why
///
/// The relay fans a daemon's frames out to every client in the room, so one carrier
/// connection shared by two clients would offer both the same key stream: the second
/// client's salt would be opened under the first client's session, its counter would
/// not match, and the connection would fail with an out-of-order error that names
/// neither the client nor the cause.
///
/// Until per-client streams exist (M2, where the proxy layer owns stream lifecycle),
/// the daemon therefore serves one client per carrier connection. A peer that cannot
/// open the salt frame is rejected by dropping the carrier, which also returns every
/// other client to the relay to be re-parked on the fresh connection.
///
/// # Establishment is once per connection
///
/// A live run once reported `frame 1 arrived out of order; expected 0` when a second
/// client joined while the daemon was recovering from one it could not authenticate.
/// The cause was establishment being retried on the same connection: a failed attempt
/// had already read a frame and derived a session, so the next attempt read the *next*
/// frame with reset counters, under a client that was mid-handshake.
///
/// Establishment is therefore a single step that either completes or drops the carrier
/// ([`crate::transport::Transport::establish`]), and `a_good_client_joins_while_the_daemon_is_recovering_from_a_bad_one`
/// covers the scenario.
///
/// # The salt exchange carries both counters
///
/// The other half of the same problem, and the one a live browser client found: the salt is
/// written under the provisional session, so it consumes counter zero — but the session the
/// salt defines starts counting from zero again. Both ends must therefore carry one number
/// across the derivation, and they are different numbers: the sender carries what it
/// *wrote*, the receiver what it *opened*. A single omitted carry produces
/// `frame 0 arrived out of order; expected 1` on every request after the handshake, a
/// message that names neither the cause nor the end that is wrong.
///
/// `crates/dr-dsh-crypto`'s `handover_tests` pins the arithmetic directly, and
/// `repeated_connections_each_get_a_working_session` exercises the shape a browser
/// produces: connect, speak, hang up, repeat.
///
/// # Reconnect policy
///
/// The loop dials, parks the room, and then serves whatever the relay sends. Two failure kinds
/// are treated differently, and the distinction is the point:
///
/// * **Refused** — the relay decided this daemon may not park (another daemon owns
///   the room, the relay is at capacity, the protocol version is wrong). Retrying
///   would hammer the relay to repeat an answer that will not change, so the loop
///   stops and reports it. Fixing it is an operator action.
/// * **Anything else** — a dropped socket, a sleeping laptop, a relay restart.
///   These are expected, so the daemon reconnects with backoff while continuing to
///   supervise DSH: losing the relay must never cost a local session.
///
/// The handler owns the policy — what to answer, when to push — and the uplink owns
/// only the connection. That split is why the control plane is a small, testable
/// function rather than a callback tangled into a reconnect loop.
///
/// # Errors
///
/// Returns the refusal that ended the loop. Transient failures are retried, not
/// returned; a shutdown is a clean `Ok`.
pub async fn run<H>(
    config: CarrierConfig,
    mut on_state: impl FnMut(RelayState) + Send,
    mut shutdown: impl std::future::Future<Output = ()> + Send + Unpin,
    mut handler: H,
) -> Result<(), crate::transport::TransportError>
where
    H: FnMut(u32, Vec<u8>, Outbox) + Send,
{
    let CarrierConfig {
        relay_url,
        room,
        root,
        policy,
        keepalive,
        audit_dir,
    } = config;
    let backoff = Backoff::default();
    let mut attempt: u32 = 0;
    let mut fast_re_registrations: u32 = 0;
    // Deployment detection (M4): a reverse proxy in front of the relay closes a quiet carrier on a
    // schedule, and nothing else in this loop can tell that apart from a relay restart. The watch is
    // fed every carrier ending and says something once, with the numbers it saw.
    let mut idle_drops = crate::deployment::IdleDropWatch::new();

    loop {
        // Whether the connection ended because its session ended, rather than because
        // the carrier failed. A released carrier is not a failure to back off from.
        let mut session_ended = false;
        // Whether any client ever ran on this connection: one of the two facts the proxy heuristic
        // needs. The other is when the connection was parked, which is set below when a dial succeeds
        // — initialising it here as well would be a value nothing reads.
        let mut carried_session = false;
        // Which device the session on this connection belongs to, captured when it is established.
        // Read again at the end rather than asked of the transport then: the release paths run inside a
        // `select!` whose other branch still holds the transport borrowed.
        let mut bound_device: Option<String> = None;
        on_state(RelayState::Connecting);
        // The policy is rebuilt per attempt: the registry is owned by the transport, and a
        // reconnect must enforce the same rule as the connection it replaces.
        match crate::transport::Transport::dial_with_policy(
            &relay_url,
            &room,
            &root,
            policy.clone(),
        )
        .await
        {
            Ok(mut transport) => {
                let parked_at = std::time::Instant::now();
                // Keepalive starts with the connection, not with the session: the wait for the first
                // client is the longest quiet stretch this carrier will ever have, and it is the one a
                // reverse proxy's idle timeout cuts. The first tick is deliberately one interval out —
                // `interval` would fire immediately, which is a ping at the moment the socket is
                // provably alive and nothing else.
                let mut ticker = keepalive.map(|every| {
                    let mut ticker =
                        tokio::time::interval_at(tokio::time::Instant::now() + every, every);
                    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                    ticker
                });
                // The room is parked, so a client can reach it. Establishing the
                // session happens when the first client arrives, inside the loop below.
                //
                // Neither counter is reset here, and that is deliberate: dialing succeeding is
                // not the same as this connection being useful.
                //
                // Two daemons configured with the same room key park successfully on every
                // attempt, and each one supersedes the other: both see a *release* rather than
                // a failure, and both are told to re-register at once. Resetting the counters on
                // a successful dial therefore kept the turn-around path — and only the
                // turn-around path — running for as long as both were up. Measured with two
                // daemons on one room: 284 re-registrations a minute with the reset, 175 without.
                // The improvement is real but modest, and it is worth being exact about why: the
                // backoff ceiling of 30s is still reached either way, so this bounds the *rate*
                // rather than ending the exchange. Two daemons sharing a room key remain a
                // misconfiguration that costs the relay roughly three requests a second; telling
                // one of them to stop needs a signal that distinguishes it from a legitimate
                // reconnect, and from the daemon's side those two look identical.
                on_state(RelayState::Connected);

                // Responses travel through a channel rather than being returned, so the
                // loop that reads the next request never waits for the previous answer: a
                // proxied response can take seconds, and it is produced on its own task.
                // One channel per connection, because a message queued for a carrier that
                // has since died must not be written onto the next one.
                let (outbox, mut outbound) = mpsc::channel::<Outbound>(64);
                loop {
                    if !transport.is_established() {
                        // Establishment happens exactly once per connection, and a
                        // failure drops the carrier rather than retrying on it.
                        //
                        // Retrying is the tempting alternative and it is wrong: a failed
                        // attempt may already have read a frame and derived a session, so
                        // a second attempt reads the *next* frame with a reset counter
                        // and reports an out-of-order error that names neither the race
                        // nor the client. Dropping the carrier is also the only way to
                        // reject a peer that does not hold the room key, because the relay
                        // cannot tell a wrong key from a slow daemon.
                        let established = tokio::select! {
                            result = transport.establish_with(ticker.as_mut()) => result,
                            () = &mut shutdown => {
                                let _ = transport.close().await;
                                on_state(RelayState::Stopped);
                                return Ok(());
                            }
                        };
                        if let Err(error) = established {
                            tracing::warn!(
                                %error,
                                "a peer could not establish a session; re-registering"
                            );
                            // This is the path a proxy timeout takes: the daemon has parked its room
                            // and is waiting for a client, nothing is crossing the socket, and the
                            // proxy closes it. The first version of the watch only observed the two
                            // *other* ways a carrier ends, so a daemon behind a proxy reconnected
                            // forever without ever producing the warning that names the cause — found
                            // by running the probe and reading its log.
                            if let Some(warning) =
                                idle_drops.observe(crate::deployment::CarrierEnding {
                                    lifetime: parked_at.elapsed(),
                                    carried_session,
                                })
                            {
                                tracing::warn!("{warning}");
                            }
                            session_ended = true;
                            break;
                        }
                        // A client really reached this daemon, so the room is being served and
                        // the next release starts a fresh budget. This is the only place either
                        // counter resets, and that is the point: they measure "connections that
                        // carried a session", not "connections that parked".
                        attempt = 0;
                        fast_re_registrations = 0;
                        carried_session = true;
                        // Recorded after the guard above, so this is a session that really exists —
                        // not an attempt, and not a peer the daemon refused.
                        bound_device = transport.bound_device().map(str::to_owned);
                        crate::audit::record(
                            &audit_dir,
                            crate::audit::Event::TunnelEstablished,
                            bound_device.as_deref(),
                            crate::audit::Outcome::Ok,
                            None,
                        );
                    }

                    tokio::select! {
                        inbound = transport.next_inbound_or_keepalive(ticker.as_mut()) => {
                            match inbound {
                                Ok(frame) => {
                                    handler(frame.stream_id, frame.payload, outbox.clone())
                                }
                                Err(error) => {
                                    session_ended = released_by_relay(&error);
                                    tracing::info!(%error, "carrier connection ended");
                                    if carried_session {
                                        let reason = if session_ended {
                                            "the relay released the session"
                                        } else {
                                            "the carrier broke"
                                        };
                                        crate::audit::record(
                                            &audit_dir,
                                            crate::audit::Event::TunnelReleased,
                                            bound_device.as_deref(),
                                            if session_ended {
                                                crate::audit::Outcome::Ok
                                            } else {
                                                crate::audit::Outcome::Failed
                                            },
                                            Some(reason),
                                        );
                                    }
                                    if let Some(warning) = idle_drops.observe(
                                        crate::deployment::CarrierEnding {
                                            lifetime: parked_at.elapsed(),
                                            carried_session,
                                        },
                                    ) {
                                        tracing::warn!("{warning}");
                                    }
                                    break;
                                }
                            }
                        }
                        Some(message) = outbound.recv() => {
                            if let Err(error) = transport.send(message.stream_id, &message.payload).await {
                                tracing::info!(%error, "cannot answer on the carrier");
                                if let Some(warning) = idle_drops.observe(
                                    crate::deployment::CarrierEnding {
                                        lifetime: parked_at.elapsed(),
                                        carried_session,
                                    },
                                ) {
                                    tracing::warn!("{warning}");
                                }
                                if carried_session {
                                    // The other way a session ends: the socket died under a write.
                                    crate::audit::record(
                                        &audit_dir,
                                        crate::audit::Event::TunnelReleased,
                                        bound_device.as_deref(),
                                        crate::audit::Outcome::Failed,
                                        Some("the carrier broke while answering"),
                                    );
                                }
                                break;
                            }
                        }
                        () = &mut shutdown => {
                            let _ = transport.close().await;
                            on_state(RelayState::Stopped);
                            return Ok(());
                        }
                    }
                }
            }
            Err(error @ crate::transport::TransportError::Refused { .. }) => {
                // Retrying cannot change this answer: it is a policy decision, not a
                // connectivity problem. Reporting it is the whole value.
                on_state(RelayState::Rejected);
                return Err(error);
            }
            Err(error) => {
                tracing::warn!(%error, "cannot reach the relay; will retry");
            }
        }

        if session_ended && fast_re_registrations < MAX_FAST_RE_REGISTRATIONS {
            // The session this carrier held is over. Re-registering is immediately useful —
            // a client may already be knocking — so it happens now rather than after a
            // backoff meant for a relay that is not answering.
            //
            // The run counter is what keeps a relay that closes every carrier it accepts
            // from being re-dialed as fast as the network allows: past the bound, the
            // ordinary backoff takes over.
            fast_re_registrations = fast_re_registrations.saturating_add(1);
            let delay = Duration::from_millis(RE_REGISTER_DELAY_MS);
            on_state(RelayState::Reconnecting {
                attempt: 0,
                retry_in: delay,
            });
            tokio::select! {
                () = tokio::time::sleep(delay) => {}
                () = &mut shutdown => {
                    on_state(RelayState::Stopped);
                    return Ok(());
                }
            }
            continue;
        }

        attempt = attempt.saturating_add(1);
        let delay = backoff.delay(attempt);
        on_state(RelayState::Reconnecting {
            attempt,
            retry_in: delay,
        });
        tokio::select! {
            () = tokio::time::sleep(delay) => {}
            () = &mut shutdown => {
                on_state(RelayState::Stopped);
                return Ok(());
            }
        }
    }
}

/// Whether a carrier ended because the relay released it, rather than because it broke.
///
/// The distinction decides how soon the daemon comes back: a released carrier is a
/// turn-around, and the next client is refused until the room is registered again, while a
/// broken carrier gets the backoff that keeps a sleeping laptop from hammering a relay.
///
/// It is a function so it can be tested for what it is — a string comparison against the
/// relay's own reason — without standing up two processes to observe a timing difference.
/// The behaviour it drives is covered by the live runs recorded in `docs/product/mvp.md`.
#[must_use]
fn released_by_relay(error: &crate::transport::TransportError) -> bool {
    let crate::transport::TransportError::SessionEnded { reason } = error else {
        return false;
    };
    // The relay writes its reason inside the same JSON envelope the handshake uses
    // (`{"type":"close","reason":"…"}`), not as a bare string. Matching the raw payload
    // against the constant therefore never fired, and every release was answered with the
    // backoff meant for a broken carrier — the daemon looked correct and behaved as if the
    // contract did not exist. Parsed rather than substring-matched so that a reason which
    // merely contains the phrase cannot be mistaken for it.
    let parsed: serde_json::Value = match serde_json::from_str(reason) {
        Ok(parsed) => parsed,
        Err(_) => return false,
    };
    parsed.get("type").and_then(serde_json::Value::as_str) == Some("close")
        && parsed.get("reason").and_then(serde_json::Value::as_str)
            == Some(dr_dsh_proto::SESSION_OVER)
}

/// What the uplink is doing, for reporting to the remote client.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayState {
    /// Dialing right now.
    Connecting,
    /// Parked and exchanging frames.
    Connected,
    /// The connection dropped; a retry is scheduled.
    Reconnecting {
        /// Which attempt this will be.
        attempt: u32,
        /// How long until the retry.
        retry_in: Duration,
    },
    /// The relay refused this daemon; the loop has stopped.
    Rejected,
    /// The daemon is shutting down.
    Stopped,
}
