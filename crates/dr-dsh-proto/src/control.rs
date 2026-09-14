//! The payload plane: control messages the relay never sees.
//!
//! These types travel inside [`crate::FrameType::Data`] payloads, already sealed
//! by `dr-dsh-crypto`. The relay links neither this module nor the crypto crate, so
//! "the relay cannot read lifecycle commands or session content" is a property
//! of what it is compiled with, not a promise about what it does with bytes.
//!
//! Everything here is JSON for M0. The shapes are small, versioned by the frame
//! header, and easy to inspect with `drdshd doctor` / browser devtools; a future
//! minor version may move hot paths (stream data) to a binary encoding without
//! changing these documents (ADR-0004).
//!
//! ## Envelope and message map
//!
//! On the wire each control message is `{ "kind": <ControlKind>, "id": <u32>,
//! "body": { … } }`, where `body` is the payload type named below. This module
//! holds the payload types; the envelope is framed by the transport
//! (`docs/protocol.md` § 7).
//!
//! **Field names are `snake_case` on the wire**, which is serde's default here and what the daemon
//! has always written (`local_url`, `last_error`, `expires_at_ms`) and what the browser client has
//! always read (`apps/pwa/src/control.ts` parses exactly those keys and renames them to camelCase
//! for its own callers). A renamed key is a wire-breaking change. This paragraph used to claim
//! `camelCase` and to point at the TypeScript mirror as evidence; the mirror had camelCase names
//! too, and neither end had ever used them, so the document described a protocol that did not
//! exist. The names are now pinned by a test at the bottom of this file, because the two ends are
//! written in different languages and each one's serde/JSON default is invisible to the other.
//!
//! | [`ControlKind`] | body |
//! | :--- | :--- |
//! | `StatusResponse` | [`Status`] |
//! | `LifecycleCommand` | [`LifecycleCommand`] |
//! | `LifecycleResult` | [`LifecycleResult`] |
//! | `SessionBootstrap` | [`SessionBootstrap`] |
//! | `DeviceList` | `Vec<`[`DeviceSummary`]`>` |
//! | `Notification` | [`Notification`] |
//! | `CrashReport` | [`CrashReport`] |
//! | `CrashReportResult` | [`CrashReportResult`] |
//! | `Problem` | free-form, user-facing text |
//!
//! ## What deliberately has no field
//!
//! There is no carrier for a command name, an executable path, a shell string, a
//! file path, or a launch flag, in any message. That is how the closed whitelist
//! in the project definition § 9.6 is enforced: not by validating input, but by
//! having nowhere to put it.

use serde::{Deserialize, Serialize};

/// Envelope kind discriminator, carried as `kind` on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlKind {
    /// Client asks for (or re-asks for) the daemon's state.
    StatusRequest,
    /// Daemon answers a [`ControlKind::StatusRequest`].
    StatusResponse,
    /// Client issues a lifecycle command.
    LifecycleCommand,
    /// Daemon reports the outcome of a lifecycle command.
    LifecycleResult,
    /// Client asks how to reach the DSH Web UI; daemon answers with a
    /// short-lived, single-use bootstrap.
    SessionBootstrapRequest,
    /// Daemon's bootstrap answer.
    SessionBootstrap,
    /// Device management: list, rename, revoke.
    DeviceRequest,
    /// Device management answer.
    DeviceList,
    /// Daemon-initiated notification.
    Notification,
    /// Client reports a failure of its own run, so the person who owns the daemon can look at it.
    CrashReport,
    /// Daemon's answer to a crash report: whether it kept it, and how many it now holds.
    CrashReportResult,
    /// Either side reports a problem the other should show to the user.
    Problem,
}

/// Lifecycle operations a remote client may request.
///
/// This enum *is* the whitelist required by the project definition § 9.6: it is
/// exhaustive by construction, and the daemon has no code path that executes a
/// command named by the peer. Arguments are never passed through — the daemon
/// starts DSH from its own locked configuration, and there is no field here for
/// an attacker to put a flag in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LifecycleOp {
    /// Start DSH if it is not running.
    Start,
    /// Stop DSH, asking it to shut down gracefully first.
    Stop,
    /// Stop then start.
    Restart,
}

/// What the daemon is doing with the DSH process it owns.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LifecycleState {
    /// No DSH process is running and none is starting.
    Stopped,
    /// A start is in flight.
    Starting,
    /// DSH is serving.
    Running,
    /// A stop is in flight (graceful shutdown window).
    Stopping,
    /// The last start or the supervision loop failed; see `last_error`.
    Failed,
    /// DSH was started by the user by hand: this daemon only proxies it and
    /// refuses lifecycle commands (project definition § 8, attach mode).
    Attached,
}

/// The daemon's answer to a status request.
///
/// This is the single source of truth for every "is it up?" surface: the PWA's
/// header, the offline banner, and the notification payloads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Status {
    /// What the supervisor is doing.
    pub state: LifecycleState,
    /// Loopback URL DSH is listening on, when it is listening.
    pub local_url: Option<String>,
    /// PID of the DSH process, when this daemon owns one.
    pub pid: Option<u32>,
    /// Seconds the current run has been up, when running.
    pub uptime_secs: Option<u64>,
    /// Whether this daemon owns the process (false in attach mode).
    pub owned: bool,
    /// Human-readable reason for the last failure, if any.
    pub last_error: Option<String>,
    /// Relay reachability as the daemon currently sees it.
    pub relay: RelayHealth,
    /// Protocol version the daemon speaks, for client display and diagnostics.
    pub protocol: (u16, u16),
}

/// The daemon's view of its own uplink.
///
/// Failure transparency is a product requirement (§ 9.7), so "we cannot reach
/// the relay" is a first-class state rather than a log line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelayHealth {
    /// Connected and authenticated.
    Connected,
    /// Not connected right now; reconnecting with backoff.
    Reconnecting,
    /// The relay refused the connection (bad room, revoked device).
    Rejected,
    /// The relay is unreachable (network, DNS, proxy).
    Unreachable,
}

/// A single notification the daemon decided is worth interrupting someone for.
///
/// Content minimization is enforced by the shape: there is no field for message
/// text, code, or file paths. `session_ref` is an opaque local identifier the
/// client uses to focus the right session after it connects — it is useless
/// without the tunnel key (project definition § 9.5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Notification {
    /// What happened.
    pub event: NotificationEvent,
    /// Severity, which drives whether this is a banner or an interruption.
    pub severity: Severity,
    /// When the daemon observed the event, in Unix milliseconds.
    pub at_ms: u64,
    /// Opaque reference to the local session, when the event belongs to one.
    pub session_ref: Option<String>,
}

/// Notification-worthy events.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotificationEvent {
    /// A DSH session finished its turn.
    TurnComplete,
    /// DSH is waiting for the user to approve something.
    ApprovalRequested,
    /// A goal or long-running objective completed.
    GoalComplete,
    /// A subagent finished.
    SubagentComplete,
    /// DSH lifecycle changed (started, stopped, failed).
    LifecycleChanged,
    /// This device's tunnel went down.
    ConnectionLost,
}

/// How loudly an event should surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    /// Record it; shows up in the activity list only.
    Info,
    /// Worth a badge; no sound.
    Notice,
    /// Interrupt: approval requests and failures.
    Alert,
}

/// A lifecycle command from a paired device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LifecycleCommand {
    /// Which operation, from the fixed whitelist.
    pub op: LifecycleOp,
    /// Milliseconds after which the daemon should abandon the attempt.
    pub timeout_ms: Option<u64>,
}

/// Outcome of a lifecycle command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LifecycleResult {
    /// Whether the daemon accepted the operation at all.
    ///
    /// Distinct from [`Self::ok`], and the distinction is the client's whole reason for reading it:
    /// `accepted: false` is a refusal (attach mode, an unsupported operation) and retrying can never
    /// change it, while `accepted: true, ok: false` is an operation that ran and failed — the only
    /// case where "try again" means anything. The daemon has always written this field; it was
    /// missing from this type until the wire names were pinned, which is how the omission survived.
    pub accepted: bool,
    /// Whether the operation achieved its goal.
    pub ok: bool,
    /// State after the attempt, so the client never has to guess.
    pub state: LifecycleState,
    /// Failure detail, when `ok` is false.
    pub error: Option<String>,
}

/// How a client should reach the DSH Web UI through an established session.
///
/// The daemon, not the client, mints DSH's own browser token: the token stays
/// inside the tunnel and the client never has to be trusted with credentials it
/// cannot protect. See `docs/architecture.md` § Session bootstrap for why the
/// authority has to be preserved end to end.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionBootstrap {
    /// Path (relative to the tunnel endpoint) that redeems the token.
    pub path: String,
    /// Authority the daemon used when it redeemed the token, which the client
    /// must keep presenting so DSH's authority-bound cookie stays valid.
    pub authority: String,
    /// Unix milliseconds after which the bootstrap is useless.
    pub expires_at_ms: u64,
}

/// One paired device, as shown in the management UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceSummary {
    /// Stable device id, derived from its public key.
    pub id: String,
    /// User-facing name, editable locally.
    pub name: String,
    /// When pairing completed, in Unix milliseconds.
    pub paired_at_ms: u64,
    /// Last time this device was seen by the daemon.
    pub last_seen_ms: Option<u64>,
    /// Whether this device may issue lifecycle commands.
    pub may_control: bool,
}

/// One failure the client's own run recorded, sent to the daemon the client is paired with.
///
/// Crash reporting is **local by default and has no server**: the report goes to the user's own
/// daemon, which writes it to a `0600` file next to the rest of its state, and nowhere else. There
/// is no field for a room key, a device key, a pairing code, or a message body, and the sender
/// builds every field from counters and error strings rather than from anything a session carries.
///
/// The bounds are part of the type's contract rather than a suggestion: a report is a *summary*,
/// and a client that sent whole logs would be shipping content the daemon never agreed to hold.
/// The daemon re-checks every bound, because a peer that ignores them is exactly the case they
/// exist for (see [`CrashReport::MAX_SAMPLES`] and friends).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrashReport {
    /// Which client and version produced this, e.g. `pwa 0.0.0`.
    pub client: String,
    /// Where the client was when the failure happened (`connecting`, `ready`, `offline`, …).
    pub phase: String,
    /// Whether this run ever reached the point where the interface works.
    ///
    /// The single most useful field: a run that failed before reaching it never rendered anything,
    /// and one that failed after it did.
    pub reached_ready: bool,
    /// Uncaught errors this run recorded.
    pub errors: u32,
    /// Unhandled promise rejections this run recorded.
    pub rejections: u32,
    /// Short, already-truncated descriptions of the failures, newest last.
    pub samples: Vec<String>,
    /// The browser's own user-agent string, truncated by the sender.
    pub user_agent: String,
    /// When the client built the report, in Unix milliseconds.
    pub at_ms: u64,
}

impl CrashReport {
    /// Most failure samples a report may carry.
    pub const MAX_SAMPLES: usize = 20;
    /// Longest one sample may be, in bytes.
    pub const MAX_SAMPLE_LEN: usize = 200;
    /// Longest the client, phase, and user-agent strings may be, in bytes.
    pub const MAX_TEXT_LEN: usize = 200;
    /// Largest whole report the daemon accepts, in bytes.
    ///
    /// Generous next to the sums of the field caps, because the point is to bound what an
    /// unfriendly peer can make the daemon store, not to be tight about a legitimate report.
    pub const MAX_REPORT_LEN: usize = 8 * 1024;
}

/// The daemon's answer to a [`CrashReport`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrashReportResult {
    /// Whether the daemon kept the report.
    pub accepted: bool,
    /// How many reports the daemon holds now, so a client can say "saved (3 of 20)".
    pub stored: u32,
    /// Why the report was not kept, when `accepted` is false.
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `snake_case` keys of a serialized body, sorted so the assertion is about the set.
    fn keys(value: &serde_json::Value) -> Vec<String> {
        let mut names: Vec<String> = value
            .as_object()
            .map(|object| object.keys().cloned().collect())
            .unwrap_or_default();
        names.sort();
        names
    }

    /// Pins the field names and their casing for every body type, in one place.
    ///
    /// The two ends are written in different languages, so each one's serialization default is
    /// invisible to the other: the daemon writes these bodies by hand (`serde_json::json!`) and the
    /// browser parses them by name. Nothing pinned the names before, and the module doc claimed
    /// `camelCase` while both ends had always used `snake_case` — a divergence no test could see
    /// because no test named a multi-word field. This is that test. A rename here is a
    /// wire-breaking change, and it should fail loudly rather than reach a browser as `undefined`.
    #[test]
    fn every_body_keeps_its_wire_field_names() -> Result<(), Box<dyn std::error::Error>> {
        let status = Status {
            state: LifecycleState::Running,
            local_url: Some("http://127.0.0.1:3080".to_owned()),
            pid: Some(1),
            uptime_secs: Some(2),
            owned: true,
            last_error: None,
            relay: RelayHealth::Connected,
            protocol: (0, 1),
        };
        assert_eq!(
            keys(&serde_json::to_value(&status)?),
            [
                "last_error",
                "local_url",
                "owned",
                "pid",
                "protocol",
                "relay",
                "state",
                "uptime_secs"
            ]
        );

        let result = LifecycleResult {
            accepted: true,
            ok: false,
            state: LifecycleState::Failed,
            error: Some("the port is in use".to_owned()),
        };
        assert_eq!(
            keys(&serde_json::to_value(&result)?),
            ["accepted", "error", "ok", "state"]
        );

        let command = LifecycleCommand {
            op: LifecycleOp::Restart,
            timeout_ms: Some(30_000),
        };
        assert_eq!(keys(&serde_json::to_value(&command)?), ["op", "timeout_ms"]);

        let notification = Notification {
            event: NotificationEvent::ApprovalRequested,
            severity: Severity::Alert,
            at_ms: 1,
            session_ref: Some("s".to_owned()),
        };
        assert_eq!(
            keys(&serde_json::to_value(&notification)?),
            ["at_ms", "event", "session_ref", "severity"]
        );

        let bootstrap = SessionBootstrap {
            path: "/bootstrap".to_owned(),
            authority: "127.0.0.1:3080".to_owned(),
            expires_at_ms: 1,
        };
        assert_eq!(
            keys(&serde_json::to_value(&bootstrap)?),
            ["authority", "expires_at_ms", "path"]
        );

        let device = DeviceSummary {
            id: "d".to_owned(),
            name: "laptop".to_owned(),
            paired_at_ms: 1,
            last_seen_ms: None,
            may_control: true,
        };
        assert_eq!(
            keys(&serde_json::to_value(&device)?),
            ["id", "last_seen_ms", "may_control", "name", "paired_at_ms"]
        );

        let report = CrashReport {
            client: "pwa 0.0.0".to_owned(),
            phase: "connecting".to_owned(),
            reached_ready: false,
            errors: 1,
            rejections: 0,
            samples: vec!["TypeError: x is not a function".to_owned()],
            user_agent: "Mozilla/5.0".to_owned(),
            at_ms: 1,
        };
        assert_eq!(
            keys(&serde_json::to_value(&report)?),
            [
                "at_ms",
                "client",
                "errors",
                "phase",
                "reached_ready",
                "rejections",
                "samples",
                "user_agent"
            ]
        );

        let stored = CrashReportResult {
            accepted: true,
            stored: 1,
            error: None,
        };
        assert_eq!(
            keys(&serde_json::to_value(&stored)?),
            ["accepted", "error", "stored"]
        );
        Ok(())
    }

    /// The kind discriminators are what the daemon matches on and the browser switches over.
    #[test]
    fn every_kind_keeps_its_wire_name() -> Result<(), Box<dyn std::error::Error>> {
        use ControlKind::{
            CrashReport as CrashReportKind, CrashReportResult as CrashReportResultKind, DeviceList,
            DeviceRequest, LifecycleCommand as Command, LifecycleResult as Result_,
            Notification as Notice, Problem, SessionBootstrap as Bootstrap,
            SessionBootstrapRequest as BootstrapRequest, StatusRequest, StatusResponse,
        };
        let pairs = [
            (StatusRequest, "status_request"),
            (StatusResponse, "status_response"),
            (Command, "lifecycle_command"),
            (Result_, "lifecycle_result"),
            (BootstrapRequest, "session_bootstrap_request"),
            (Bootstrap, "session_bootstrap"),
            (DeviceRequest, "device_request"),
            (DeviceList, "device_list"),
            (Notice, "notification"),
            (CrashReportKind, "crash_report"),
            (CrashReportResultKind, "crash_report_result"),
            (Problem, "problem"),
        ];
        for (kind, name) in pairs {
            assert_eq!(serde_json::to_value(kind)?, serde_json::Value::from(name));
        }
        Ok(())
    }
}
