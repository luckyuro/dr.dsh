//! Opt-in loopback reports from the supervised DSH plugin.
//!
//! Only the currently authenticated device's connection owns an outbox. Reports
//! have no offline store and cannot survive into a replacement tunnel session.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::to_bytes;
use axum::extract::{Request, State};
use axum::http::{StatusCode, header};
use axum::routing::post;
use base64::Engine as _;
use dr_dsh_proto::control::{ControlKind, Notification, NotificationEvent, Severity};
use serde::Deserialize;

use crate::uplink::{Outbound, Outbox};

/// Child-only environment variable carrying the report origin.
pub const ENV_URL: &str = "DRDSH_REPORT_URL";
/// Child-only environment variable carrying a fresh local capability.
pub const ENV_TOKEN: &str = "DRDSH_REPORT_TOKEN";
/// Opt-in flag saved in an installed daemon service's environment.
pub const ENV_ENABLE: &str = "DSHD_PLUGIN_REPORTS";
const MAX_BODY: usize = 2048;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Resolves the explicit enable switch before the installed service setting.
///
/// # Errors
/// Rejects any environment value other than `0` or `1`.
pub fn enabled_setting(cli_enabled: bool, environment: Option<&str>) -> Result<bool, &'static str> {
    if cli_enabled {
        return Ok(true);
    }
    match environment {
        Some("1") => Ok(true),
        Some("0") | None => Ok(false),
        _ => Err(
            "DSHD_PLUGIN_REPORTS must be 1 (enable) or 0 (disable); correct the daemon service environment.",
        ),
    }
}

/// Credentials passed directly to the managed child, never persisted or logged.
#[derive(Clone)]
pub struct Credentials {
    url: String,
    token: String,
}

impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ReportCredentials([redacted])")
    }
}

impl Credentials {
    pub(crate) fn pipe_value(&self) -> serde_json::Value {
        serde_json::json!({ "reportUrl": self.url, "reportToken": self.token })
    }

    pub(crate) fn apply(&self, command: &mut tokio::process::Command) {
        command.env(ENV_URL, &self.url).env(ENV_TOKEN, &self.token);
    }
}

/// The live notification destination; an empty slot means reports are dropped.
#[derive(Clone, Default)]
pub struct ReportSink(Arc<Mutex<Option<Outbox>>>);

impl ReportSink {
    pub(crate) fn connect(&self, outbox: Outbox) -> Connection {
        if let Ok(mut slot) = self.0.lock() {
            *slot = Some(outbox);
        }
        Connection(self.clone())
    }

    fn submit(&self, notification: Notification) -> StatusCode {
        let Ok(slot) = self.0.lock() else {
            return StatusCode::SERVICE_UNAVAILABLE;
        };
        let Some(outbox) = slot.as_ref() else {
            return StatusCode::SERVICE_UNAVAILABLE;
        };
        let Ok(payload) = serde_json::to_vec(&serde_json::json!({
            "kind": ControlKind::Notification,
            "id": 0,
            "body": notification,
        })) else {
            return StatusCode::INTERNAL_SERVER_ERROR;
        };
        match outbox.try_send(Outbound {
            stream_id: dr_dsh_proto::CONTROL_STREAM_ID,
            payload,
        }) {
            Ok(()) => StatusCode::ACCEPTED,
            Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => StatusCode::TOO_MANY_REQUESTS,
            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                StatusCode::SERVICE_UNAVAILABLE
            }
        }
    }
}

/// Scope-bound so cancellation and every carrier exit revoke the destination.
pub(crate) struct Connection(ReportSink);

impl Drop for Connection {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.0.0.lock() {
            *slot = None;
        }
    }
}

#[derive(Clone)]
struct ServerState {
    authorization: String,
    sink: ReportSink,
    active: Arc<std::sync::atomic::AtomicBool>,
}

/// The optional listener. Dropping it closes the local report endpoint.
pub struct ReportServer {
    credentials: Credentials,
    sink: ReportSink,
    active: Arc<std::sync::atomic::AtomicBool>,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
}

impl ReportServer {
    /// Binds an ephemeral IPv4 loopback port and generates a process-local token.
    ///
    /// # Errors
    /// Returns a bind error if this machine cannot host the requested endpoint.
    pub async fn start() -> std::io::Result<Self> {
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
        let credentials = Credentials {
            url: format!("http://{}", listener.local_addr()?),
            token: base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(rand::random::<[u8; 32]>()),
        };
        let sink = ReportSink::default();
        let active = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let state = ServerState {
            authorization: format!("Bearer {}", credentials.token),
            sink: sink.clone(),
            active: Arc::clone(&active),
        };
        let router = axum::Router::new()
            .route("/report", post(receive))
            .with_state(state);
        let (shutdown, stopped) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            if axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
                .is_err()
            {
                tracing::warn!(
                    "local plugin report listener stopped; restart the daemon to restore reports"
                );
            }
        });
        Ok(Self {
            credentials,
            sink,
            active,
            shutdown: Some(shutdown),
        })
    }

    /// Credentials for this listener, shared across managed DSH restarts.
    #[must_use]
    pub fn credentials(&self) -> Credentials {
        self.credentials.clone()
    }

    /// The destination registered only after device authentication.
    #[must_use]
    pub fn sink(&self) -> ReportSink {
        self.sink.clone()
    }
}

impl Drop for ReportServer {
    fn drop(&mut self) {
        self.active
            .store(false, std::sync::atomic::Ordering::Release);
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Report {
    event: NotificationEvent,
    severity: Severity,
    at_ms: u64,
    session_ref: Option<String>,
}

impl Report {
    fn notification(self) -> Option<Notification> {
        let severity = match self.event {
            NotificationEvent::TurnComplete => Severity::Notice,
            NotificationEvent::ApprovalRequested | NotificationEvent::GoalComplete => {
                Severity::Alert
            }
            NotificationEvent::SubagentComplete => Severity::Info,
            NotificationEvent::LifecycleChanged | NotificationEvent::ConnectionLost => return None,
        };
        if self.severity != severity || self.at_ms > MAX_SAFE_INTEGER {
            return None;
        }
        if let Some(id) = &self.session_ref
            && (id.is_empty()
                || id.len() > 128
                || !id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte)))
        {
            return None;
        }
        Some(Notification {
            event: self.event,
            severity,
            at_ms: self.at_ms,
            session_ref: self.session_ref,
        })
    }
}

async fn receive(State(state): State<ServerState>, request: Request) -> (StatusCode, &'static str) {
    if !state.active.load(std::sync::atomic::Ordering::Acquire) {
        return response(StatusCode::SERVICE_UNAVAILABLE);
    }
    // Browsers must never be a second producer, even when a local capability
    // is accidentally supplied by a caller. No CORS route is exposed.
    if request.headers().contains_key(header::ORIGIN) {
        return response(StatusCode::FORBIDDEN);
    }
    let mut authorization = request.headers().get_all(header::AUTHORIZATION).iter();
    let Some(value) = authorization.next() else {
        return response(StatusCode::UNAUTHORIZED);
    };
    if authorization.next().is_some()
        || !same_capability(value.as_bytes(), state.authorization.as_bytes())
    {
        return response(StatusCode::UNAUTHORIZED);
    }
    let is_json = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(';')
                .next()
                .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
        });
    if !is_json {
        return response(StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }
    let bytes = match tokio::time::timeout(
        Duration::from_secs(3),
        to_bytes(request.into_body(), MAX_BODY),
    )
    .await
    {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(_)) => return response(StatusCode::PAYLOAD_TOO_LARGE),
        Err(_) => return response(StatusCode::REQUEST_TIMEOUT),
    };
    let notification = serde_json::from_slice::<Report>(&bytes)
        .ok()
        .and_then(Report::notification);
    if !state.active.load(std::sync::atomic::Ordering::Acquire) {
        return response(StatusCode::SERVICE_UNAVAILABLE);
    }
    response(match notification {
        Some(notification) => state.sink.submit(notification),
        None => StatusCode::BAD_REQUEST,
    })
}

fn response(status: StatusCode) -> (StatusCode, &'static str) {
    let reason = match status {
        StatusCode::ACCEPTED => "daemon queued this report for the connected device",
        StatusCode::FORBIDDEN => {
            "daemon refuses browser-origin reports; use the supervised DSH plugin"
        }
        StatusCode::UNAUTHORIZED => {
            "daemon rejected local report credentials; restart the managed DSH with this daemon"
        }
        StatusCode::UNSUPPORTED_MEDIA_TYPE => {
            "daemon requires application/json reports; check the plugin version"
        }
        StatusCode::PAYLOAD_TOO_LARGE => {
            "daemon report body exceeds 2048 bytes; send only event metadata"
        }
        StatusCode::REQUEST_TIMEOUT => {
            "daemon report body was not received within 3 seconds; check the local plugin"
        }
        StatusCode::BAD_REQUEST => {
            "daemon rejected the report schema; use a supported event, matching severity, safe timestamp and opaque session handle"
        }
        StatusCode::TOO_MANY_REQUESTS => {
            "daemon's live report queue is full; this report was dropped"
        }
        StatusCode::SERVICE_UNAVAILABLE => {
            "daemon has no available authenticated device connection; this report was dropped"
        }
        _ => "daemon could not encode this report; restart the daemon and check its version",
    };
    (status, reason)
}

fn same_capability(candidate: &[u8], expected: &[u8]) -> bool {
    candidate.len() == expected.len()
        && candidate
            .iter()
            .zip(expected)
            .fold(0_u8, |diff, (a, b)| diff | (a ^ b))
            == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use http_body_util::{BodyExt as _, Full};
    use hyper_util::client::legacy::Client;
    use hyper_util::rt::TokioExecutor;

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    #[test]
    fn reports_are_opt_in_and_the_service_setting_is_strict() -> TestResult {
        assert!(!enabled_setting(false, None)?);
        assert!(!enabled_setting(false, Some("0"))?);
        assert!(enabled_setting(false, Some("1"))?);
        assert!(enabled_setting(true, Some("0"))?);
        for invalid in ["", "true", "false", "2", " 1"] {
            assert!(enabled_setting(false, Some(invalid)).is_err());
        }
        Ok(())
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn managed_dsh_restarts_keep_the_process_local_report_credentials() -> TestResult {
        use crate::dsh::{Supervisor, SupervisorConfig, SupervisorSpawner};
        use crate::lifecycle::Spawner as _;
        use std::os::unix::fs::PermissionsExt as _;
        let server = ReportServer::start().await?;
        let (out, mut reports) = tokio::sync::mpsc::channel(4);
        let _connection = server.sink.connect(out);
        let directory = tempfile::tempdir()?;
        let script = directory.path().join("reporting-dsh.mjs");
        std::fs::write(
            &script,
            r##"#!/usr/bin/env node
if (process.argv.includes('--dump-config')) {
  if (process.env.DRDSH_REPORT_URL || process.env.DRDSH_REPORT_TOKEN) process.exit(1);
  console.log('[]');
  process.exit(0);
}
const response = await fetch(new URL('/report', process.env.DRDSH_REPORT_URL), {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.DRDSH_REPORT_TOKEN}` },
  body: JSON.stringify({ event: 'turn_complete', severity: 'notice', atMs: 123, sessionRef: String(process.pid) }),
});
if (response.status !== 202) process.exit(1);
console.log('dsh web: http://127.0.0.1:3080/?token=test-dsh-token');
setInterval(() => {}, 10000);
"##,
        )?;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))?;
        let config = SupervisorConfig {
            executable: script,
            port: 3080,
        };
        let credentials = server.credentials();
        let mut first = Supervisor::start_with_reports(config.clone(), Some(&credentials)).await?;
        assert!(
            tokio::time::timeout(Duration::from_secs(5), reports.recv())
                .await?
                .is_some()
        );
        first.stop().await?;
        let spawner = SupervisorSpawner::new(config).with_reports(Some(credentials));
        let mut restarted = spawner.spawn().await?;
        assert!(
            tokio::time::timeout(Duration::from_secs(5), reports.recv())
                .await?
                .is_some()
        );
        restarted.stop().await?;
        Ok(())
    }

    fn valid() -> serde_json::Value {
        serde_json::json!({"event":"turn_complete","severity":"notice","atMs":123,"sessionRef":"session_abc-123"})
    }

    async fn send(
        server: &ReportServer,
        body: String,
        headers: &[(&str, &str)],
    ) -> Result<StatusCode, Box<dyn std::error::Error>> {
        let client = Client::builder(TokioExecutor::new()).build_http::<Full<Bytes>>();
        let mut request = axum::http::Request::post(format!("{}/report", server.credentials.url));
        for (key, value) in headers {
            request = request.header(*key, *value);
        }
        let response = client
            .request(request.body(Full::new(Bytes::from(body.clone())))?)
            .await?;
        let status = response.status();
        let response_body = response.into_body().collect().await?.to_bytes();
        let text = String::from_utf8_lossy(&response_body);
        assert!(
            !text.contains(&server.credentials.token),
            "credentials appeared in the HTTP response"
        );
        assert!(
            !text.contains(&body),
            "request payload appeared in the HTTP response"
        );
        Ok(status)
    }

    async fn post_json(
        server: &ReportServer,
        body: serde_json::Value,
    ) -> Result<StatusCode, Box<dyn std::error::Error>> {
        let auth = format!("Bearer {}", server.credentials.token);
        send(
            server,
            body.to_string(),
            &[
                ("authorization", &auth),
                ("content-type", "application/json"),
            ],
        )
        .await
    }

    #[tokio::test]
    async fn report_http_requires_the_local_capability_and_refuses_browser_origins() -> TestResult {
        let server = ReportServer::start().await?;
        assert!(server.credentials.url.starts_with("http://127.0.0.1:"));
        let other = ReportServer::start().await?;
        assert_ne!(server.credentials.token, other.credentials.token);
        assert!(!format!("{:?}", server.credentials).contains(&server.credentials.token));
        let good = format!("Bearer {}", server.credentials.token);
        let wrong = format!("Bearer {}", other.credentials.token);
        let json = valid().to_string();
        assert_eq!(
            send(
                &server,
                json.clone(),
                &[("content-type", "application/json")]
            )
            .await?,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            send(
                &server,
                json.clone(),
                &[
                    ("content-type", "application/json"),
                    ("authorization", &wrong)
                ]
            )
            .await?,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            send(
                &server,
                json.clone(),
                &[
                    ("content-type", "application/json"),
                    ("authorization", &good),
                    ("authorization", &good)
                ]
            )
            .await?,
            StatusCode::UNAUTHORIZED
        );
        for origin in ["https://example.com", "null", "http://127.0.0.1"] {
            assert_eq!(
                send(
                    &server,
                    json.clone(),
                    &[
                        ("content-type", "application/json"),
                        ("authorization", &good),
                        ("origin", origin)
                    ]
                )
                .await?,
                StatusCode::FORBIDDEN
            );
        }
        assert_eq!(
            send(
                &server,
                json,
                &[("content-type", "text/plain"), ("authorization", &good)]
            )
            .await?,
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
        assert_eq!(
            post_json(&server, valid()).await?,
            StatusCode::SERVICE_UNAVAILABLE
        );
        Ok(())
    }

    #[tokio::test]
    async fn report_schema_rejects_content_and_unbounded_or_incompatible_metadata() -> TestResult {
        let server = ReportServer::start().await?;
        let (out, mut incoming) = tokio::sync::mpsc::channel(8);
        let _connection = server.sink.connect(out);
        for (field, value) in [
            ("event", serde_json::json!("lifecycle_changed")),
            ("event", serde_json::json!("connection_lost")),
            ("event", serde_json::json!("unknown")),
            ("severity", serde_json::json!("alert")),
            ("atMs", serde_json::json!(-1)),
            ("atMs", serde_json::json!(1.5)),
            ("atMs", serde_json::json!(9_007_199_254_740_992_u64)),
            ("sessionRef", serde_json::json!("/Users/private/file")),
            ("sessionRef", serde_json::json!("secret words")),
            ("sessionRef", serde_json::json!("")),
            ("sessionRef", serde_json::json!("x".repeat(129))),
            ("sessionRef", serde_json::json!("会话")),
            ("sessionRef", serde_json::json!(42)),
            ("payload", serde_json::json!("private model output")),
            ("at_ms", serde_json::json!(123)),
            ("session_ref", serde_json::json!("session")),
        ] {
            let mut body = valid();
            body[field] = value;
            assert_eq!(
                post_json(&server, body).await?,
                StatusCode::BAD_REQUEST,
                "invalid {field} accepted"
            );
        }
        let auth = format!("Bearer {}", server.credentials.token);
        assert_eq!(
            send(
                &server,
                "x".repeat(MAX_BODY + 1),
                &[
                    ("authorization", &auth),
                    ("content-type", "application/json")
                ]
            )
            .await?,
            StatusCode::PAYLOAD_TOO_LARGE
        );
        assert_eq!(send(&server, "{\"event\":\"turn_complete\",\"event\":\"turn_complete\",\"severity\":\"notice\",\"atMs\":1}".to_owned(), &[("authorization", &auth), ("content-type", "application/json")]).await?, StatusCode::BAD_REQUEST);
        assert!(incoming.try_recv().is_err());
        for (event, severity) in [
            ("turn_complete", "notice"),
            ("approval_requested", "alert"),
            ("goal_complete", "alert"),
            ("subagent_complete", "info"),
        ] {
            let body =
                serde_json::json!({"event":event,"severity":severity,"atMs":123,"sessionRef":null});
            assert_eq!(post_json(&server, body).await?, StatusCode::ACCEPTED);
            let message = incoming
                .recv()
                .await
                .ok_or("accepted report was not queued")?;
            assert_eq!(message.stream_id, dr_dsh_proto::CONTROL_STREAM_ID);
            let envelope: serde_json::Value = serde_json::from_slice(&message.payload)?;
            assert_eq!(
                envelope,
                serde_json::json!({"kind":"notification","id":0,"body":{"event":event,"severity":severity,"at_ms":123,"session_ref":null}})
            );
        }
        Ok(())
    }

    #[tokio::test]
    async fn reports_have_a_bounded_connection_queue_and_no_offline_replay() -> TestResult {
        let server = ReportServer::start().await?;
        assert_eq!(
            post_json(&server, valid()).await?,
            StatusCode::SERVICE_UNAVAILABLE
        );
        let (out, mut first) = tokio::sync::mpsc::channel(1);
        let connection = server.sink.connect(out);
        assert!(first.try_recv().is_err(), "offline report was replayed");
        assert_eq!(post_json(&server, valid()).await?, StatusCode::ACCEPTED);
        assert_eq!(
            post_json(&server, valid()).await?,
            StatusCode::TOO_MANY_REQUESTS
        );
        drop(connection);
        drop(first);
        assert_eq!(
            post_json(&server, valid()).await?,
            StatusCode::SERVICE_UNAVAILABLE
        );
        let (out, mut second) = tokio::sync::mpsc::channel(1);
        let _connection = server.sink.connect(out);
        assert!(
            second.try_recv().is_err(),
            "previous connection's report was replayed"
        );
        assert_eq!(post_json(&server, valid()).await?, StatusCode::ACCEPTED);
        assert!(second.recv().await.is_some());
        drop(second);
        assert_eq!(
            post_json(&server, valid()).await?,
            StatusCode::SERVICE_UNAVAILABLE
        );
        Ok(())
    }

    async fn tunnel_test(device_bound: bool) -> TestResult {
        use crate::transport::{DeviceIdentity, DevicePolicy, Transport};
        use crate::uplink::{self, CarrierConfig, RelayState};
        let server = ReportServer::start().await?;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let relay = format!("ws://{}", listener.local_addr()?);
        let relay_task = tokio::spawn(async move {
            axum::serve(listener, dr_dsh_relay::ingress::Ingress::new(8).router()).await
        });
        let root = [37; dr_dsh_crypto::SESSION_KEY_LEN];
        let room = dr_dsh_crypto::room_id_for(&root);
        let key = dr_dsh_crypto::DeviceSecretKey::generate();
        let device_id = key.public().device_id().to_base64url();
        let mut registry = dr_dsh_crypto::DeviceRegistry::new();
        registry.enrol(key.public(), "test phone".to_owned());
        let policy = if device_bound {
            DevicePolicy::enrolled(registry)
        } else {
            DevicePolicy::RoomKeyOnly
        };
        let audit = tempfile::tempdir()?;
        let config = CarrierConfig::new(
            relay.clone(),
            room.clone(),
            root,
            policy,
            None,
            audit.path().to_owned(),
        )
        .with_reports(Some(server.sink()));
        let (state_tx, mut state_rx) = tokio::sync::watch::channel(RelayState::Connecting);
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
        let daemon = tokio::spawn(uplink::run(
            config,
            move |state| {
                let _ = state_tx.send(state);
            },
            Box::pin(async {
                let _ = stop_rx.await;
            }),
            |_stream, _payload, _out| {},
        ));
        tokio::time::timeout(Duration::from_secs(5), async {
            while *state_rx.borrow_and_update() != RelayState::Connected {
                state_rx.changed().await?;
            }
            Ok::<(), tokio::sync::watch::error::RecvError>(())
        })
        .await??;
        // A parked carrier has no authenticated device and is never a report destination.
        assert_eq!(
            post_json(&server, valid()).await?,
            StatusCode::SERVICE_UNAVAILABLE
        );
        let identity = device_bound.then_some(DeviceIdentity {
            device_id,
            room: room.clone(),
            key,
        });
        let mut client = tokio::time::timeout(
            Duration::from_secs(5),
            Transport::join_as(&relay, &room, &root, identity),
        )
        .await??;
        if device_bound {
            for _ in 0..100 {
                if server
                    .sink
                    .0
                    .lock()
                    .map_err(|_| "report sink lock poisoned")?
                    .is_some()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert_eq!(post_json(&server, valid()).await?, StatusCode::ACCEPTED);
            let frame =
                tokio::time::timeout(Duration::from_secs(5), client.next_inbound()).await??;
            let envelope: serde_json::Value = serde_json::from_slice(&frame.payload)?;
            assert_eq!(frame.stream_id, dr_dsh_proto::CONTROL_STREAM_ID);
            assert_eq!(envelope["kind"], "notification");
            assert_eq!(envelope["body"]["event"], "turn_complete");
            assert_eq!(envelope["body"]["session_ref"], "session_abc-123");
        } else {
            assert_eq!(
                post_json(&server, valid()).await?,
                StatusCode::SERVICE_UNAVAILABLE
            );
        }
        client.close().await?;
        let _ = stop_tx.send(());
        tokio::time::timeout(Duration::from_secs(5), daemon).await???;
        assert_eq!(
            post_json(&server, valid()).await?,
            StatusCode::SERVICE_UNAVAILABLE
        );
        relay_task.abort();
        Ok(())
    }

    #[tokio::test]
    async fn a_report_crosses_the_real_relay_only_after_device_authentication() -> TestResult {
        tunnel_test(true).await
    }

    #[tokio::test]
    async fn a_room_key_only_tunnel_cannot_receive_plugin_reports() -> TestResult {
        tunnel_test(false).await
    }
}
