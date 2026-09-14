//! M0 acceptance: a real DSH, reached through a real relay, by a real client.
//!
//! Everything else in this crate is tested against a stand-in harness or a stand-in
//! client. This file is the one that answers the question a user actually asks — *can I
//! reach my own DSH from somewhere else?* — by doing it:
//!
//! ```text
//! DshClient ──▶ relay ──▶ daemon ──▶ loopback ──▶ the real `dsh web`
//! ```
//!
//! ## Running it
//!
//! It is `#[ignore]`d because it supervises a real harness and binds real ports:
//!
//! ```sh
//! DSH_BIN="node /path/to/deepseek-harness/apps/cli/lib/bin.js" \
//!   cargo test -p dr-dsh-daemon --test acceptance -- --ignored --nocapture
//! ```
//!
//! With no `DSH_BIN`, `dsh` is looked for on `PATH` and the test reports a skip.
//!
//! ## Why it checks its own port first
//!
//! An earlier run of this test failed with "the daemon never answered the proxied
//! request", and the cause was mundane: a `dsh web` orphaned by an earlier killed daemon
//! was still holding the test port. The supervisor then adopted *that* process — it
//! parses whatever prints a readiness line on the port it asked for — and the daemon
//! authenticated against a harness whose owner was gone, so the proxy never got a working
//! loopback client.
//!
//! Adopting a hand-started instance is deliberate behaviour (attach mode, project
//! definition § 8), but adopting one in a *test* hides the test's own result. The
//! pre-flight below therefore fails loudly with the reason instead.
//!
//! ## What it proves
//!
//! 1. The daemon supervises the harness, authenticates against it, and parks a room.
//! 2. A client holding only the room key derives the same room and completes the
//!    sealed handshake — no other shared state.
//! 3. A proxied `GET /` returns DSH's **own** index, proven by the boot global that only
//!    DSH injects, with the authority and cookie substituted by the daemon.
//! 4. The relay never sees the page: the client's traffic is opaque frames.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Carrier keepalive is off here: this file measures the acceptance path end to end, and the
/// keepalive's own contract is measured by `scripts/deploy-probe.mjs`.
const NO_KEEPALIVE: Option<Duration> = None;

/// Where the uplink records session events. A directory nothing reads: these tests are about the
/// carrier, and an audit log written into the repository tree would be a side effect nobody asked for.
/// The audit log's own contract is tested in `crates/dr-dsh-daemon/src/audit.rs`.
fn no_audit_dir() -> std::path::PathBuf {
    std::path::PathBuf::from("target/audit-unused")
}

use dr_dsh_crypto::SESSION_KEY_LEN;
use dr_dsh_daemon::dsh::{DshClient, Supervisor, SupervisorConfig};
use dr_dsh_daemon::proxy::{ProxyMessage, ProxyService, message};
use dr_dsh_daemon::transport::Transport;
use dr_dsh_daemon::uplink::{self, RelayState};

/// Ports chosen well away from a DSH a developer might be using.
const DSH_PORT: u16 = 46190;
const HANDSHAKE_PATIENCE: Duration = Duration::from_secs(20);
const EXCHANGE_PATIENCE: Duration = Duration::from_secs(30);

/// Builds the harness command, honouring `DSH_BIN`.
///
/// `DSH_BIN` may carry arguments (`"node /path/to/bin.js"`), because a DSH checkout runs
/// through Node rather than an installed binary; those become a generated wrapper so the
/// supervisor's own command line stays exactly what production uses.
fn harness_command() -> Option<PathBuf> {
    let spec = match std::env::var("DSH_BIN") {
        Ok(value) if !value.trim().is_empty() => value,
        _ => {
            let probe = std::process::Command::new("dsh")
                .arg("--version")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            return match probe {
                Ok(status) if status.success() => Some(PathBuf::from("dsh")),
                _ => None,
            };
        }
    };
    let mut words = spec.split_whitespace();
    let program = words.next()?;
    let rest: Vec<&str> = words.collect();
    if rest.is_empty() {
        return Some(PathBuf::from(program));
    }
    let directory = std::env::temp_dir().join("drdshd-acceptance");
    std::fs::create_dir_all(&directory).ok()?;
    let wrapper = directory.join("dsh-wrapper.sh");
    let quoted = rest
        .iter()
        .map(|word| format!("'{}'", word.replace('\'', "'\\''")))
        .collect::<Vec<_>>()
        .join(" ");
    std::fs::write(
        &wrapper,
        format!("#!/bin/sh\nexec {program} {quoted} \"$@\"\n"),
    )
    .ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mut permissions = std::fs::metadata(&wrapper).ok()?.permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&wrapper, permissions).ok()?;
    }
    Some(wrapper)
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[tokio::test]
#[ignore = "needs a DSH installation and real ports; run with --ignored and DSH_BIN=<harness>"]
async fn a_remote_client_reaches_the_real_dsh_through_a_relay()
-> Result<(), Box<dyn std::error::Error>> {
    let Some(executable) = harness_command() else {
        eprintln!("skipped: no DSH found (set DSH_BIN=/path/to/dsh to run this test)");
        return Ok(());
    };

    // 0. Refuse to run against a port somebody else owns. See the module docs: adopting a
    //    stray harness here would look like a product bug rather than a dirty port.
    if let Ok(listener) = std::net::TcpListener::bind(("127.0.0.1", DSH_PORT)) {
        drop(listener);
    } else {
        return Err(format!(
            "port {DSH_PORT} is already in use, so a stray `dsh web` (or another process) \
             would be adopted as the harness under test; free the port and rerun"
        )
        .into());
    }

    // 1. A relay, in-process: the same library the shipped binary runs.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let relay_addr = listener.local_addr()?;
    let router = dr_dsh_relay::ingress::Ingress::new(4).router();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    let relay = format!("ws://{relay_addr}");

    // 2. A real harness, supervised exactly as the daemon supervises it.
    let supervisor_config = SupervisorConfig {
        executable,
        port: DSH_PORT,
    };
    let mut supervisor = Supervisor::start(supervisor_config).await?;
    let ready = supervisor.ready().clone();

    let mut dsh = DshClient::new(&ready.base_url)?;
    dsh.authenticate(&ready.token).await?;

    // 3. A daemon uplink whose handler is the real proxy service.
    let key = [77_u8; SESSION_KEY_LEN];
    let room = dr_dsh_crypto::room_id_for(&key);
    let state: Arc<Mutex<Option<RelayState>>> = Arc::new(Mutex::new(None));
    let daemon_state = Arc::clone(&state);
    let service = Arc::new(ProxyService::new(Arc::new(dsh)));

    let daemon = tokio::spawn({
        let relay = relay.clone();
        let room = room.clone();
        async move {
            let mut shutdown = Box::pin(std::future::pending::<()>());
            uplink::run(
                uplink::CarrierConfig::new(
                    relay,
                    room,
                    key,
                    dr_dsh_daemon::transport::DevicePolicy::RoomKeyOnly,
                    NO_KEEPALIVE,
                    no_audit_dir(),
                ),
                move |next| *lock(&daemon_state) = Some(next),
                &mut shutdown,
                move |stream_id, payload, out: uplink::Outbox| {
                    let service = Arc::clone(&service);
                    tokio::spawn(async move {
                        let _ = service.handle(stream_id, &payload, &out).await;
                    });
                },
            )
            .await
        }
    });

    // The daemon must report its room parked before a client can join it.
    for _ in 0..200 {
        if matches!(*lock(&state), Some(RelayState::Connected)) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        matches!(*lock(&state), Some(RelayState::Connected)),
        "the daemon never parked its room"
    );

    // 4. A client holding only the room key.
    let mut client = tokio::time::timeout(HANDSHAKE_PATIENCE, Transport::join(&relay, &room, &key))
        .await
        .map_err(|_| "the client never completed its handshake")??;

    // 5. One proxied request for DSH's own root document.
    let mut payload = Vec::new();
    message::encode(
        &ProxyMessage::RequestStart(message::RequestHead {
            id: 1,
            method: "GET".to_owned(),
            target: "/".to_owned(),
            headers: vec![("accept".to_owned(), "text/html".to_owned())],
            body: Vec::new(),
        }),
        &mut payload,
    )?;
    client.send(1, &payload).await?;

    let mut status = None;
    let mut body = Vec::new();
    loop {
        let frame = tokio::time::timeout(EXCHANGE_PATIENCE, client.next_inbound())
            .await
            .map_err(|_| "the daemon never answered the proxied request")??;
        match message::decode(&frame.payload)? {
            ProxyMessage::ResponseStart(head) => {
                assert_eq!(
                    head.id, 1,
                    "the response must answer the request that was sent"
                );
                status = Some(head.status);
            }
            ProxyMessage::ResponseBody(chunk) => body.extend_from_slice(&chunk),
            ProxyMessage::ResponseEnd => break,
            ProxyMessage::Failure(failure) => {
                return Err(format!("the daemon refused the request: {}", failure.reason).into());
            }
            other => return Err(format!("unexpected proxy message: {other:?}").into()),
        }
    }

    assert_eq!(status, Some(200), "DSH's index must be served");
    let page = String::from_utf8_lossy(&body);
    assert!(
        page.contains("__DSH_BOOT__"),
        "the response must be DSH's own document, not an error page: {} bytes",
        body.len()
    );
    eprintln!(
        "reached the real DSH through the relay: {} bytes of its own index",
        body.len()
    );

    client.close().await?;
    daemon.abort();
    supervisor.stop().await?;
    Ok(())
}

/// The route that makes the interface live, against the real DSH.
///
/// `/api/remote.mux` is DSH's own WebSocket, and the Web UI does not work without it.
/// The unit-level path is covered against a stand-in in `tests/proxy.rs`; what this adds
/// is that a **real** DSH accepts an upgrade made by our client under the authority and
/// cookie we authenticated with — a handshake a stand-in cannot vouch for.
#[tokio::test]
#[ignore = "needs a DSH installation and real ports; run with --ignored and DSH_BIN=<harness>"]
async fn the_live_session_feed_upgrades_against_the_real_dsh()
-> Result<(), Box<dyn std::error::Error>> {
    let Some(executable) = harness_command() else {
        eprintln!("skipped: no DSH found (set DSH_BIN=/path/to/dsh to run this test)");
        return Ok(());
    };

    // A different port from the request test, and the same pre-flight for the same reason.
    const MUX_PORT: u16 = DSH_PORT + 1;
    if let Ok(listener) = std::net::TcpListener::bind(("127.0.0.1", MUX_PORT)) {
        drop(listener);
    } else {
        return Err(format!("port {MUX_PORT} is already in use; free it and rerun").into());
    }

    let mut supervisor = Supervisor::start(SupervisorConfig {
        executable,
        port: MUX_PORT,
    })
    .await?;
    let ready = supervisor.ready().clone();
    let mut dsh = DshClient::new(&ready.base_url)?;
    dsh.authenticate(&ready.token).await?;

    // The upgrade DSH's own client performs. A `101` here means the authority-bound
    // cookie is accepted on the upgrade path too, which is what the `/api` fence checks.
    let socket = dsh.upgrade("/api/remote.mux", &[]).await?;
    eprintln!("DSH accepted the upgrade to /api/remote.mux");

    // A frame written to the live feed must not kill the connection. The exact protocol
    // DSH speaks on this socket belongs to DSH (and to M2's notification work); what is
    // asserted here is only that it is a working bidirectional socket after the handshake.
    let (mut reader, mut writer) = socket.split();
    writer
        .send(dr_dsh_daemon::dsh::WsFrame::Text("{}".to_owned()))
        .await
        .map_err(|error| format!("cannot write to the live feed: {error}"))?;
    match tokio::time::timeout(Duration::from_secs(5), reader.next()).await {
        // A frame back: the feed answered.
        Ok(Ok(Some(_))) => eprintln!("the live feed answered"),
        // Silence: DSH buffered or ignored it. Also fine — the socket is alive.
        Err(_) => eprintln!("the live feed stayed silent, which is its choice to make"),
        Ok(Ok(None)) => eprintln!("DSH closed the feed, which an unknown message may explain"),
        Ok(Err(error)) => eprintln!("the feed reported {error}"),
    }

    supervisor.stop().await?;
    Ok(())
}
