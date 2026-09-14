//! The daemon's control plane: what a remote client can ask for, and what it gets.
//!
//! The message *types* are normative and live in `dr-dsh-proto::control`; this module
//! is the daemon's implementation of them over the encrypted tunnel. M0 answers one
//! question — "what is this daemon doing?" — because that is the minimum a remote
//! client needs to distinguish "your computer is off" from "your computer is on and
//! DSH is broken", and failure transparency is a product requirement
//! (`docs/security.md` § 1, project definition § 9.7).
//!
//! Lifecycle commands (`start`, `stop`, `restart`) land with M2. They are *not*
//! stubbed here: a stub that silently accepted a command would be worse than an
//! unanswered one, and the closed whitelist is a security property, not a TODO.
//!
//! ## Wire shape
//!
//! ```json
//! { "kind": "status_request", "id": 1 }
//! { "kind": "status_response", "id": 1, "body": { …Status… } }
//! { "kind": "problem", "id": 1, "body": { "message": "…" } }
//! ```
//!
//! The envelope matches `docs/protocol.md` § 7. Everything travels inside the
//! sealed tunnel, so the relay sees none of it.

use crate::uplink::RelayState;
use dr_dsh_proto::control::{ControlKind, LifecycleState, RelayHealth, Status};

/// A request from a client, as far as M0 understands one.
#[derive(Debug, serde::Deserialize)]
pub struct Request {
    /// Envelope kind.
    pub kind: String,
    /// Correlation id, echoed on the reply.
    #[serde(default)]
    pub id: u64,
    /// Operation-specific arguments.
    ///
    /// Defaulted rather than required so a kind that carries none — a status request — stays a
    /// two-field message, and an unknown kind with no arguments is still a parseable request
    /// that gets an honest "not answered" rather than a parse error.
    #[serde(default)]
    pub body: serde_json::Value,
}

/// What the daemon knows about itself.
///
/// The state lives **behind shared handles** rather than in copied fields, and that is not a
/// style choice: the first version captured the pid and the lifecycle state once, when the
/// uplink was built, so every status answer repeated that first snapshot forever. A remote
/// client asking "what is happening" during a recovery was told `running` with the pid of the
/// process that had just died — the one moment the field exists to be accurate about. Found by
/// killing DSH and reading the status a remote would see.
#[derive(Debug, Clone)]
pub struct DaemonFacts {
    /// Whether this daemon owns the DSH process (false in attach mode).
    pub owned: bool,
    /// The relay's state, shared with the uplink that updates it.
    pub relay: std::sync::Arc<std::sync::Mutex<RelayState>>,
    /// The lifecycle driver: the live state, and whether an operation is permitted.
    pub lifecycle: crate::lifecycle::Handle,
    /// Where a crash report goes when a client sends one.
    ///
    /// A path rather than a resolved directory: this is read at the moment a report arrives, so a
    /// daemon whose state directory was removed underneath it says so in its answer instead of
    /// writing somewhere unexpected.
    pub state_dir: std::path::PathBuf,
}

impl DaemonFacts {
    /// DSH's state right now.
    #[must_use]
    pub fn dsh_state(&self) -> LifecycleState {
        self.lifecycle.snapshot().state()
    }

    /// The pid of the running DSH, when there is one.
    #[must_use]
    pub fn pid(&self) -> Option<u32> {
        match self.lifecycle.snapshot() {
            crate::lifecycle::Lifecycle::Running { pid } => pid,
            _ => None,
        }
    }

    /// The relay's state right now.
    #[must_use]
    pub fn relay(&self) -> RelayState {
        self.relay
            .lock()
            .map(|state| *state)
            .unwrap_or(RelayState::Connecting)
    }
}

/// Builds the answer to a `status_request`.
#[must_use]
pub fn status(facts: &DaemonFacts) -> Status {
    Status {
        state: facts.dsh_state(),
        local_url: None,
        pid: facts.pid(),
        uptime_secs: None,
        owned: facts.owned,
        last_error: None,
        relay: relay_health(facts.relay()),
        protocol: dr_dsh_proto::WIRE_VERSION,
    }
}

/// Maps the uplink's richer state onto the wire's four health values.
///
/// The uplink keeps the retry count and delay because a UI wants to say "retrying
/// in 8s"; the protocol carries only the coarse state, and the extra detail stays
/// local until a client actually needs it.
#[must_use]
pub fn relay_health(state: RelayState) -> RelayHealth {
    match state {
        RelayState::Connected => RelayHealth::Connected,
        RelayState::Connecting | RelayState::Reconnecting { .. } | RelayState::Stopped => {
            RelayHealth::Reconnecting
        }
        RelayState::Rejected => RelayHealth::Rejected,
    }
}

/// Handles one inbound control message and returns the reply to send back.
///
/// Returns `None` when the message is not a control request the daemon answers,
/// which is how stream data and unknown kinds are ignored rather than answered
/// with something misleading.
/// Handles one inbound control message.
///
/// A status request is answered inline, because reading the current state is synchronous and a
/// status answer that waited behind a lifecycle command would be useless exactly when it is
/// wanted — during a restart.
///
/// A lifecycle command **is** the driver's work and takes seconds, so it is answered from a
/// spawned task that awaits the driver. The first version of this returned an acknowledgement
/// that said `accepted: true` and then did nothing: the remote was told the stop had been
/// accepted while DSH kept running, which is worse than a refusal. Found by running the PWA's
/// control client against a real daemon and noticing the state never changed.
#[must_use]
pub fn handle(payload: &[u8], facts: DaemonFacts, out: crate::uplink::Outbox) -> Option<Vec<u8>> {
    let request: Request = serde_json::from_slice(payload).ok()?;
    let reply = match request.kind.as_str() {
        "status_request" => serde_json::json!({
            "kind": ControlKind::StatusResponse,
            "id": request.id,
            "body": status(&facts),
        }),
        "lifecycle_command" => {
            let op = serde_json::from_value::<dr_dsh_proto::control::LifecycleOp>(
                request
                    .body
                    .get("op")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            );
            match op {
                Ok(op) => {
                    // A refusal is decided here, because it needs no process and a client
                    // should not wait for one to be told no. The operation itself is the
                    // driver's to perform and to answer, on a spawned task: it takes seconds,
                    // and a status request arriving behind it must not queue up.
                    if let Err(reason) = facts.lifecycle.check_permitted(op) {
                        crate::audit::record(
                            &facts.state_dir,
                            crate::audit::Event::LifecycleCommand,
                            None,
                            crate::audit::Outcome::Refused,
                            Some(&format!("{op:?}: {reason}")),
                        );
                        // Built as the normative type and then serialized, rather than written out
                        // field by field: the hand-written body is how `accepted` came to be missing
                        // from `LifecycleResult` in `dr-dsh-proto` while every client read it.
                        let refusal = dr_dsh_proto::control::LifecycleResult {
                            accepted: false,
                            ok: false,
                            state: facts.dsh_state(),
                            error: Some(reason),
                        };
                        return Some(
                            serde_json::json!({
                                "kind": ControlKind::LifecycleResult,
                                "id": request.id,
                                "body": refusal,
                            })
                            .to_string()
                            .into_bytes(),
                        );
                    }
                    let lifecycle = facts.lifecycle.clone();
                    let id = request.id;
                    let audit_dir = facts.state_dir.clone();
                    tokio::spawn(async move {
                        let result = lifecycle.command(op).await;
                        // Recorded when the answer exists rather than when the command arrives: the
                        // audit log is about what happened to the process, not about what was asked.
                        crate::audit::record(
                            &audit_dir,
                            crate::audit::Event::LifecycleCommand,
                            None,
                            if result.ok {
                                crate::audit::Outcome::Ok
                            } else {
                                crate::audit::Outcome::Failed
                            },
                            Some(&format!(
                                "{op:?}: {} ({:?})",
                                result.error.as_deref().unwrap_or("done"),
                                result.state
                            )),
                        );
                        let body = serde_json::json!({
                            "kind": ControlKind::LifecycleResult,
                            "id": id,
                            "body": result,
                        });
                        let _ = out
                            .send(crate::uplink::Outbound {
                                stream_id: dr_dsh_proto::CONTROL_STREAM_ID,
                                payload: body.to_string().into_bytes(),
                            })
                            .await;
                    });
                    return None;
                }
                Err(_) => serde_json::json!({
                    "kind": ControlKind::Problem,
                    "id": request.id,
                    "body": { "message": "lifecycle_command needs an \"op\" of start, stop, or restart" },
                }),
            }
        }
        "crash_report" => {
            // Parsed into the normative type rather than picked apart by hand: the bounds live on
            // that type, and a body assembled field by field is how a bound gets forgotten.
            let parsed =
                serde_json::from_value::<dr_dsh_proto::control::CrashReport>(request.body.clone());
            let result = match parsed {
                Ok(report) => match crate::crashlog::store(&facts.state_dir, report) {
                    Ok(stored) => dr_dsh_proto::control::CrashReportResult {
                        accepted: true,
                        stored: stored.count,
                        error: None,
                    },
                    Err(refused) => dr_dsh_proto::control::CrashReportResult {
                        accepted: false,
                        stored: crate::crashlog::count(&crate::crashlog::path_in(&facts.state_dir))
                            .unwrap_or(0),
                        error: Some(refused.reason()),
                    },
                },
                Err(error) => dr_dsh_proto::control::CrashReportResult {
                    accepted: false,
                    stored: crate::crashlog::count(&crate::crashlog::path_in(&facts.state_dir))
                        .unwrap_or(0),
                    error: Some(format!("this is not a crash report: {error}")),
                },
            };
            serde_json::json!({
                "kind": ControlKind::CrashReportResult,
                "id": request.id,
                "body": result,
            })
        }
        _ => serde_json::json!({
            "kind": ControlKind::Problem,
            "id": request.id,
            "body": {
                "message": format!("this daemon does not answer {:?}", request.kind)
            },
        }),
    };
    Some(reply.to_string().into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    /// Facts for a managed daemon, with a driver that is never driven.
    ///
    /// The channel is built but the driver is dropped: a control handler only reads state and
    /// asks whether an operation is *permitted*, so a test of that does not need a task. A test
    /// that needs the driver to act builds one explicitly.
    fn facts_in(mode: crate::lifecycle::Mode) -> DaemonFacts {
        facts_in_directory(mode, &std::env::temp_dir())
    }

    /// The same, with the crash log pointed at a directory the test owns.
    fn facts_in_directory(
        mode: crate::lifecycle::Mode,
        directory: &std::path::Path,
    ) -> DaemonFacts {
        let (lifecycle, _driver) = crate::lifecycle::channel(mode, Default::default());
        // The driver is the only writer in production; here it is dropped, so the state a test
        // exercises is published explicitly. It starts `stopped`, which is honest — a daemon
        // whose driver never ran has no DSH.
        lifecycle.publish(crate::lifecycle::Lifecycle::Running { pid: Some(4242) });
        DaemonFacts {
            owned: true,
            relay: std::sync::Arc::new(std::sync::Mutex::new(RelayState::Connected)),
            lifecycle,
            state_dir: directory.to_path_buf(),
        }
    }

    fn facts() -> DaemonFacts {
        facts_in(crate::lifecycle::Mode::Managed { port: 3080 })
    }

    /// An outbox that collects what the handler would have sent later.
    ///
    /// A lifecycle command is answered by the driver on a spawned task, so a test that only
    /// read the return value would miss the answer entirely — which is what the first version
    /// of this handler got wrong in the other direction.
    fn outbox() -> (
        crate::uplink::Outbox,
        tokio::sync::mpsc::Receiver<crate::uplink::Outbound>,
    ) {
        let (sender, receiver) = tokio::sync::mpsc::channel(4);
        (sender, receiver)
    }

    #[test]
    fn a_status_request_is_answered_with_the_daemon_state() -> TestResult {
        let (out, _receiver) = outbox();
        let reply = handle(br#"{"kind":"status_request","id":7}"#, facts().clone(), out)
            .ok_or("a status request must be answered")?;
        let value: serde_json::Value = serde_json::from_slice(&reply)?;
        assert_eq!(value["kind"], "status_response");
        assert_eq!(value["id"], 7);
        assert_eq!(value["body"]["state"], "running");
        assert_eq!(value["body"]["pid"], 4242);
        assert_eq!(value["body"]["relay"], "connected");
        Ok(())
    }

    #[test]
    fn the_health_mapping_covers_every_uplink_state() {
        assert_eq!(relay_health(RelayState::Connected), RelayHealth::Connected);
        assert_eq!(relay_health(RelayState::Rejected), RelayHealth::Rejected);
        for state in [
            RelayState::Connecting,
            RelayState::Reconnecting {
                attempt: 3,
                retry_in: std::time::Duration::from_secs(4),
            },
            RelayState::Stopped,
        ] {
            assert_eq!(relay_health(state), RelayHealth::Reconnecting, "{state:?}");
        }
    }

    #[test]
    fn an_unknown_kind_is_refused_with_a_reason_rather_than_ignored() -> TestResult {
        // Ignoring it would look like a network problem to the client. Saying what
        // is missing is the difference between a bug report and a support ticket.
        let (out, _receiver) = outbox();
        let reply = handle(br#"{"kind":"no_such_kind","id":2}"#, facts(), out)
            .ok_or("an unknown kind still gets a reply")?;
        let value: serde_json::Value = serde_json::from_slice(&reply)?;
        assert_eq!(value["kind"], "problem");
        let message = value["body"]["message"].as_str().unwrap_or_default();
        assert!(message.contains("no_such_kind"), "{message}");
        Ok(())
    }

    #[test]
    fn a_lifecycle_command_without_an_operation_says_what_is_missing() -> TestResult {
        // A malformed command is a client bug, and the difference between "the daemon ignored
        // me" and "you forgot `op`" is the difference between a support ticket and a fix.
        let (out, _receiver) = outbox();
        let reply = handle(br#"{"kind":"lifecycle_command","id":3}"#, facts(), out)
            .ok_or("a lifecycle command still gets a reply")?;
        let value: serde_json::Value = serde_json::from_slice(&reply)?;
        assert_eq!(value["kind"], "problem");
        let message = value["body"]["message"].as_str().unwrap_or_default();
        assert!(message.contains("op"), "{message}");
        Ok(())
    }

    #[test]
    fn a_permitted_lifecycle_command_is_handed_to_the_driver_and_answered() -> TestResult {
        // A current-thread runtime rather than `#[tokio::test]`: the lib's own tokio dependency
        // does not enable the test macro, and pulling it in for one test is not worth a feature
        // that every build then carries.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        runtime.block_on(async {
            // A real driver, because the whole point is that the *driver* performs the operation and
            // answers. A handler that acknowledged the command inline would satisfy a test with no
            // driver, which is exactly the bug this test exists to catch.
            let (lifecycle, driver) = crate::lifecycle::channel(
                crate::lifecycle::Mode::Managed { port: 3080 },
                Default::default(),
            );
            let task = tokio::spawn(driver.run(NoSpawner));
            let exec_facts = DaemonFacts {
                state_dir: std::env::temp_dir(),
                owned: true,
                relay: std::sync::Arc::new(std::sync::Mutex::new(RelayState::Connected)),
                lifecycle,
            };
            let (out, mut receiver) = outbox();
            let inline = handle(
                br#"{"kind":"lifecycle_command","id":4,"body":{"op":"stop"}}"#,
                exec_facts,
                out,
            );
            assert!(
                inline.is_none(),
                "an accepted command must not be answered inline: the driver answers it"
            );

            let sent = tokio::time::timeout(std::time::Duration::from_secs(2), receiver.recv())
                .await
                .map_err(|_| "the driver never answered the command")?
                .ok_or("the outbox closed before the answer arrived")?;
            let value: serde_json::Value = serde_json::from_slice(&sent.payload)?;
            assert_eq!(value["kind"], "lifecycle_result");
            assert_eq!(value["id"], 4);
            assert_eq!(value["body"]["accepted"], true);
            // The state is the driver's, after the operation — not the state at the moment the
            // request arrived. What the lie looked like: `state: "running"` reported straight back,
            // because the inline version echoed the state it could read rather than the state after
            // doing anything. Any state other than `running` proves the driver ran and its answer
            // came back; which state it is depends on the policy, and pinning it exactly would make
            // this test about the policy rather than about the wiring.
            assert_ne!(
                value["body"]["state"], "running",
                "the answer must be the driver's state after the operation, not an echo"
            );
            task.abort();
            Ok(())
        })
    }

    /// A spawner that is never asked to spawn: the daemon in this test has no DSH.
    struct NoSpawner;

    #[async_trait::async_trait]
    impl crate::lifecycle::Spawner for NoSpawner {
        type Handle = NoHandle;

        async fn spawn(&self) -> Result<Self::Handle, String> {
            Err("this daemon has no DSH in a unit test".to_owned())
        }
    }

    /// A handle for a process that does not exist.
    struct NoHandle;

    #[async_trait::async_trait]
    impl crate::lifecycle::Running for NoHandle {
        fn pid(&self) -> Option<u32> {
            None
        }

        async fn wait(&mut self) -> String {
            std::future::pending().await
        }

        async fn stop(&mut self) -> Result<(), String> {
            Ok(())
        }
    }

    #[test]
    fn a_lifecycle_command_is_refused_with_its_reason_in_attach_mode() -> TestResult {
        // Criterion 5: the disabled buttons carry an explanation, and that explanation comes
        // from here — not from the client guessing why the daemon said no. A refusal is decided
        // without the driver, so it comes back inline and at once.
        let (out, _receiver) = outbox();
        let reply = handle(
            br#"{"kind":"lifecycle_command","id":5,"body":{"op":"stop"}}"#,
            facts_in(crate::lifecycle::Mode::Attached { port: 3080 }),
            out,
        )
        .ok_or("a refusal must be answered inline")?;
        let value: serde_json::Value = serde_json::from_slice(&reply)?;
        assert_eq!(value["kind"], "lifecycle_result");
        assert_eq!(value["body"]["accepted"], false);
        assert_eq!(value["body"]["ok"], false);
        let reason = value["body"]["error"].as_str().unwrap_or_default();
        assert!(reason.contains("started outside this daemon"), "{reason}");
        Ok(())
    }

    #[test]
    fn no_operation_can_carry_an_argument_into_the_driver() -> TestResult {
        // The M2 review's first question was "can a remote influence the child's command line?".
        // The answer has two halves: the spawn takes a `SupervisorConfig` that no wire value reaches
        // (checked in `dsh::supervisor`), and the only remote input that could carry anything is the
        // operation name. This is that half: every shape that could smuggle a string through is
        // refused with a `problem`, and — the part that matters — **the driver is never asked**.
        //
        // A real driver with a spawner that would fail loudly if it were ever called, so "nothing
        // happened" is asserted rather than assumed.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        runtime.block_on(async {
            let (lifecycle, driver) = crate::lifecycle::channel(
                crate::lifecycle::Mode::Managed { port: 3080 },
                Default::default(),
            );
            let task = tokio::spawn(driver.run(NoSpawner));
            let facts = DaemonFacts {
                state_dir: std::env::temp_dir(),
                owned: true,
                relay: std::sync::Arc::new(std::sync::Mutex::new(RelayState::Connected)),
                lifecycle,
            };
            let (out, mut receiver) = outbox();

            for payload in [
                // A command line where an operation name belongs.
                br#"{"kind":"lifecycle_command","id":6,"body":{"op":"start --port 1"}}"#.as_slice(),
                br#"{"kind":"lifecycle_command","id":7,"body":{"op":{"command":"rm -rf /"}}}"#
                    .as_slice(),
                br#"{"kind":"lifecycle_command","id":8,"body":{"op":["start"]}}"#.as_slice(),
                br#"{"kind":"lifecycle_command","id":9,"body":{"op":1}}"#.as_slice(),
                br#"{"kind":"lifecycle_command","id":10,"body":{"op":null}}"#.as_slice(),
                br#"{"kind":"lifecycle_command","id":11,"body":{"op":""}}"#.as_slice(),
            ] {
                let reply = handle(payload, facts.clone(), out.clone())
                    .ok_or("a malformed command is refused inline, not sent to the driver")?;
                let value: serde_json::Value = serde_json::from_slice(&reply)?;
                let id = value["id"].as_u64().unwrap_or_default();
                assert_eq!(value["kind"], "problem", "id {id}: {value}");
                assert!(
                    value["body"]["message"]
                        .as_str()
                        .unwrap_or_default()
                        .contains("start, stop, or restart"),
                    "id {id}: the refusal must say what the shape is"
                );
            }

            // The right name with an argument smuggled beside it: the operation is still performed
            // from the daemon's own configuration, and the extra field is ignored rather than
            // forwarded — which *is* the property, so this one is accepted and answered by the
            // driver. It is last on purpose: the assertion below is that the driver's **first**
            // message is this one, which fails if any malformed command above was forwarded.
            let accepted = handle(
                br#"{"kind":"lifecycle_command","id":12,"body":{"op":"stop","port":1}}"#,
                facts,
                out,
            );
            assert!(
                accepted.is_none(),
                "an accepted command is answered by the driver, not inline"
            );

            // Nothing above reached the driver: the only command it ever received is the `stop`
            // from id 12, and if any of the others had been forwarded this would see them first.
            let first = tokio::time::timeout(std::time::Duration::from_secs(2), receiver.recv())
                .await
                .map_err(|_| "the accepted command was never answered")?
                .ok_or("the outbox closed")?;
            let value: serde_json::Value = serde_json::from_slice(&first.payload)?;
            assert_eq!(
                value["id"], 12,
                "only the well-formed command reached the driver"
            );
            // Everything else the driver says for this command is still about id 12. The assertion is
            // on the *id*, not on the message count: the driver may report more than one thing for one
            // operation, and a test that pinned the count would break the day it did — while a
            // forwarded malformed command would carry its own id and fail here.
            while let Ok(Some(next)) =
                tokio::time::timeout(std::time::Duration::from_millis(300), receiver.recv()).await
            {
                let value: serde_json::Value = serde_json::from_slice(&next.payload)?;
                assert_eq!(
                    value["id"], 12,
                    "a command that was not well-formed reached the driver: {value}"
                );
            }
            task.abort();
            Ok(())
        })
    }

    #[test]
    fn stream_data_is_not_mistaken_for_a_request() {
        // The status stream carries DSH's own traffic; a JSON parse failure must
        // mean "not a control message", not "answer with an error".
        let (out, _receiver) = outbox();
        assert!(handle(b"\x00\x01not json at all", facts(), out).is_none());
        let (out, _receiver) = outbox();
        assert!(
            handle(b"{}", facts(), out).is_none(),
            "a reply needs a kind to reply to"
        );
    }
    /// A crash report is stored, counted, and answered — and the daemon re-checks its bounds.
    #[test]
    fn a_crash_report_is_stored_and_counted() -> TestResult {
        let directory = tempfile::tempdir()?;
        let facts = facts_in_directory(
            crate::lifecycle::Mode::Managed { port: 3080 },
            directory.path(),
        );
        let body = serde_json::json!({
            "client": "pwa 0.0.0",
            "phase": "connecting",
            "reached_ready": false,
            "errors": 2,
            "rejections": 1,
            "samples": ["TypeError: x is not a function", "boom\nsecond line"],
            "user_agent": "Mozilla/5.0",
            "at_ms": 1_700_000_000_000_u64,
        });
        let request = serde_json::json!({"kind": "crash_report", "id": 21, "body": body});

        let (out, _receiver) = outbox();
        let reply = handle(request.to_string().as_bytes(), facts.clone(), out)
            .ok_or("a crash report must be answered")?;
        let value: serde_json::Value = serde_json::from_slice(&reply)?;
        assert_eq!(value["kind"], "crash_report_result");
        assert_eq!(value["id"], 21);
        assert_eq!(value["body"]["accepted"], true);
        assert_eq!(value["body"]["stored"], 1);

        // Stored as one line, with the embedded newline flattened: the file is read by a terminal,
        // and a sample that could write its own line could write a forged report.
        let path = crate::crashlog::path_in(directory.path());
        let stored = std::fs::read_to_string(&path)?;
        assert_eq!(stored.lines().count(), 1);
        assert!(stored.contains("boom second line"), "{stored}");
        // The sample's newline was replaced, not escaped into the file: a report is one line.
        assert!(!stored.contains("boom\\nsecond"), "{stored}");
        Ok(())
    }

    /// The client is the component that crashed, so its word is not the bound.
    #[test]
    fn an_oversized_crash_report_is_refused_with_a_reason() -> TestResult {
        let directory = tempfile::tempdir()?;
        let facts = facts_in_directory(
            crate::lifecycle::Mode::Managed { port: 3080 },
            directory.path(),
        );
        let too_many: Vec<String> = (0..dr_dsh_proto::control::CrashReport::MAX_SAMPLES + 1)
            .map(|_| "x".to_owned())
            .collect();
        let request = serde_json::json!({
            "kind": "crash_report",
            "id": 22,
            "body": {
                "client": "pwa 0.0.0",
                "phase": "ready",
                "reached_ready": true,
                "errors": 99,
                "rejections": 0,
                "samples": too_many,
                "user_agent": "Mozilla/5.0",
                "at_ms": 1_u64,
            },
        });
        let (out, _receiver) = outbox();
        let reply = handle(request.to_string().as_bytes(), facts, out)
            .ok_or("a refusal is still an answer")?;
        let value: serde_json::Value = serde_json::from_slice(&reply)?;
        assert_eq!(value["kind"], "crash_report_result");
        assert_eq!(value["body"]["accepted"], false);
        assert_eq!(value["body"]["stored"], 0);
        let reason = value["body"]["error"].as_str().unwrap_or_default();
        assert!(reason.contains("failure samples"), "{reason}");
        assert!(
            !crate::crashlog::path_in(directory.path()).exists(),
            "a refused report must not create the file"
        );
        Ok(())
    }

    /// A body that is not a report is refused as one, rather than stored as something else.
    #[test]
    fn a_broken_crash_report_is_refused() -> TestResult {
        let (out, _receiver) = outbox();
        let reply = handle(
            br#"{"kind":"crash_report","id":23,"body":{"client":"pwa"}}"#,
            facts().clone(),
            out,
        )
        .ok_or("a broken report is still answered")?;
        let value: serde_json::Value = serde_json::from_slice(&reply)?;
        assert_eq!(value["kind"], "crash_report_result");
        assert_eq!(value["body"]["accepted"], false);
        assert!(
            value["body"]["error"]
                .as_str()
                .unwrap_or_default()
                .contains("not a crash report"),
            "{value}"
        );
        Ok(())
    }
}
