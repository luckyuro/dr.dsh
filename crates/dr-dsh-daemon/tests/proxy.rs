//! End-to-end test of the proxy layer, through a real relay.
//!
//! What this file proves, and why each part needs a real socket:
//!
//! 1. **A remote request reaches DSH with the authority the daemon authenticated
//!    under.** The fake harness records the `Host` header it received, so a proxy that
//!    forwarded the client's authority — the mistake that makes DSH answer 401 — fails
//!    here rather than in a user's browser.
//! 2. **The client's credential headers are replaced, not relayed.** A remote client
//!    that sends its own `Host`, `Cookie`, and `Origin` must not be able to choose any
//!    of them: they are what DSH's fences read.
//! 3. **The response arrives intact**, status, headers, and body, including a body
//!    larger than one carrier frame.
//!
//! The fake harness is the same one the supervisor tests use, extended with recording.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Carrier keepalive is off here: this file measures proxied HTTP, and a ping would only add
/// traffic no assertion in it inspects. See `crates/dr-dsh-daemon/tests/carrier.rs`.
const NO_KEEPALIVE: Option<Duration> = None;

/// Where the uplink records session events. A directory nothing reads: these tests are about the
/// carrier, and an audit log written into the repository tree would be a side effect nobody asked for.
/// The audit log's own contract is tested in `crates/dr-dsh-daemon/src/audit.rs`.
fn no_audit_dir() -> std::path::PathBuf {
    std::path::PathBuf::from("target/audit-unused")
}

use dr_dsh_crypto::SESSION_KEY_LEN;
use dr_dsh_daemon::dsh::DshClient;
use dr_dsh_daemon::proxy::{ProxyMessage, message, service};
use dr_dsh_daemon::transport::Transport;
use dr_dsh_daemon::uplink;
use dr_dsh_daemon::uplink::RelayState;

/// How long a handshake or a proxied exchange may take before the test calls it hung.
const PATIENCE: Duration = Duration::from_secs(10);

/// One request as the fake harness saw it.
///
/// At module scope because the log outlives the server task: the test reads it after the
/// exchange, and that log is the only place the headers the proxy actually sent can be
/// observed.
#[derive(Debug, Clone)]
struct Recorded {
    method: String,
    uri: String,
    host: Option<String>,
    cookie: Option<String>,
    origin: Option<String>,
    body_len: usize,
    /// How many `Content-Length` headers the request carried.
    ///
    /// Counted rather than read, because "the body arrived" is satisfied by a request that also
    /// carries a second, conflicting `Content-Length` — and Node's HTTP parser answers that with an
    /// empty `400`, which is how every remote-procedure call failed for several rounds while this
    /// harness was happy.
    content_lengths: usize,
}

/// The fake harness's request log.
type Log = Arc<Mutex<Vec<Recorded>>>;

fn room_key(tag: u8) -> [u8; SESSION_KEY_LEN] {
    [tag; SESSION_KEY_LEN]
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Starts a relay and returns its address.
async fn start_relay() -> Result<SocketAddr, Box<dyn std::error::Error>> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let router = dr_dsh_relay::ingress::Ingress::new(8).router();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Ok(addr)
}

/// Starts a fake DSH that records the requests it receives.
///
/// It answers the token exchange and then returns a large page, which is how the test
/// inspects the headers the proxy actually sent.
async fn start_fake_dsh() -> Result<(SocketAddr, Log), Box<dyn std::error::Error>> {
    use axum::body::Bytes;
    use axum::extract::State;
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::IntoResponse;
    use axum::routing::any;

    async fn handler(
        State(log): State<Log>,
        method: axum::http::Method,
        uri: axum::http::Uri,
        headers: HeaderMap,
        body: Bytes,
    ) -> impl IntoResponse {
        let header = |name: &str| {
            headers
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned)
        };
        let content_lengths = headers.get_all("content-length").iter().count();
        let recorded = Recorded {
            method: method.to_string(),
            uri: uri.to_string(),
            host: header("host"),
            cookie: header("cookie"),
            origin: header("origin"),
            body_len: body.len(),
            content_lengths,
        };
        let is_exchange = uri.query().is_some_and(|query| query.contains("token="));
        lock(&log).push(recorded);

        // Node's HTTP parser refuses a message with two `Content-Length` headers before any
        // application code runs, and answers `400` with an empty body. Reproducing that here is
        // what makes this harness a stand-in for DSH rather than for "a server that accepts
        // anything": without it, a proxy that sends both lengths passes every test in this file.
        if content_lengths > 1 {
            return (StatusCode::BAD_REQUEST, String::new()).into_response();
        }

        if is_exchange {
            // The token exchange: a redirect with an authority-bound cookie.
            return (
                StatusCode::SEE_OTHER,
                [(
                    "set-cookie",
                    "dsh-auth-test=v1.payload.signature; Path=/; HttpOnly",
                )],
                String::new(),
            )
                .into_response();
        }
        // A body deliberately larger than one carrier payload, so chunking is exercised.
        let filler = "x".repeat(70 * 1024);
        (
            StatusCode::OK,
            [("content-type", "text/html")],
            format!("<html>{filler}</html>"),
        )
            .into_response()
    }

    /// A WebSocket route that records a frame and answers it.
    ///
    /// Named `remote.mux` because that is DSH's live session feed: the one route that
    /// cannot be served by request/response, and therefore the reason this layer has a
    /// WebSocket path at all.
    async fn mux(ws: axum::extract::WebSocketUpgrade) -> impl IntoResponse {
        ws.on_upgrade(|mut socket| async move {
            use futures_util::StreamExt as _;

            while let Some(Ok(message)) = socket.next().await {
                match message {
                    axum::extract::ws::Message::Binary(bytes) => {
                        // Echo with a marker, so the client can tell DSH's answer from its
                        // own frame rather than merely seeing its bytes back.
                        let mut reply = b"dsh-saw:".to_vec();
                        reply.extend_from_slice(&bytes);
                        let _ = socket
                            .send(axum::extract::ws::Message::Binary(reply.into()))
                            .await;
                    }
                    axum::extract::ws::Message::Text(text) => {
                        let _ = socket
                            .send(axum::extract::ws::Message::Text(
                                format!("dsh-saw:{text}").into(),
                            ))
                            .await;
                    }
                    axum::extract::ws::Message::Close(_) => break,
                    _ => {}
                }
            }
        })
    }

    let log: Log = Arc::new(Mutex::new(Vec::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let router = axum::Router::new()
        .route("/api/remote.mux", any(mux))
        .route("/", any(handler))
        .fallback(any(handler))
        .with_state(log.clone());
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Ok((addr, log))
}

/// Drives a daemon-side uplink whose handler is the real proxy service.
async fn start_daemon(
    relay: &str,
    room: String,
    key: [u8; SESSION_KEY_LEN],
    dsh: SocketAddr,
    state: Arc<Mutex<Option<RelayState>>>,
) -> Result<
    tokio::task::JoinHandle<Result<(), dr_dsh_daemon::transport::TransportError>>,
    Box<dyn std::error::Error>,
> {
    let mut client = DshClient::new(&format!("http://{dsh}"))?;
    // The daemon authenticates with the launch token; here it is a fixed value the fake
    // harness accepts for any token.
    client.authenticate("test-token").await?;
    let service = Arc::new(dr_dsh_daemon::proxy::ProxyService::new(Arc::new(client)));

    let relay = relay.to_owned();
    Ok(tokio::spawn(async move {
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
            move |next| *lock(&state) = Some(next),
            &mut shutdown,
            move |stream_id, payload, out: uplink::Outbox| {
                let service = Arc::clone(&service);
                // The proxy performs the request on its own task and writes through the
                // carrier's outbox: its response can take seconds, and the read loop must
                // stay free to accept the next request while it does.
                tokio::spawn(async move {
                    let _ = service.handle(stream_id, &payload, &out).await;
                });
            },
        )
        .await
    }))
}

async fn wait_for_parked(
    state: &Arc<Mutex<Option<RelayState>>>,
) -> Result<(), Box<dyn std::error::Error>> {
    for _ in 0..200 {
        if matches!(*lock(state), Some(RelayState::Connected)) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    Err("the daemon never reported its room as parked".into())
}

/// One proxied request: sends it and collects the response.
async fn proxy_request(
    client: &mut Transport,
    stream: u32,
    head: message::RequestHead,
) -> Result<(message::ResponseHead, Vec<u8>), Box<dyn std::error::Error>> {
    let mut payload = Vec::new();
    message::encode(&ProxyMessage::RequestStart(head), &mut payload)?;
    client.send(stream, &payload).await?;

    let first = tokio::time::timeout(PATIENCE, client.next_inbound()).await??;
    let mut response_head = None;
    let mut body = Vec::new();
    let mut pending = Some(first);
    loop {
        let frame = match pending.take() {
            Some(frame) => frame,
            None => tokio::time::timeout(PATIENCE, client.next_inbound()).await??,
        };
        assert_eq!(
            frame.stream_id, stream,
            "a response arrived on the wrong stream"
        );
        match message::decode(&frame.payload)? {
            ProxyMessage::ResponseStart(head) => response_head = Some(head),
            ProxyMessage::ResponseBody(chunk) => body.extend_from_slice(&chunk),
            ProxyMessage::ResponseEnd => break,
            ProxyMessage::Failure(failure) => {
                return Err(format!("the daemon refused the request: {}", failure.reason).into());
            }
            other => return Err(format!("unexpected proxy message: {other:?}").into()),
        }
    }
    let head = response_head.ok_or("the response never started")?;
    Ok((head, body))
}

#[tokio::test]
async fn a_proxied_request_reaches_dsh_under_the_daemons_authority()
-> Result<(), Box<dyn std::error::Error>> {
    let relay = start_relay().await?;
    let (dsh, log) = start_fake_dsh().await?;
    let relay_url = format!("ws://{relay}");
    let key = room_key(11);
    let room = dr_dsh_crypto::room_id_for(&key);
    let state: Arc<Mutex<Option<RelayState>>> = Arc::new(Mutex::new(None));

    let daemon = start_daemon(&relay_url, room.clone(), key, dsh, Arc::clone(&state)).await?;
    wait_for_parked(&state).await?;
    let mut client =
        tokio::time::timeout(PATIENCE, Transport::join(&relay_url, &room, &key)).await??;

    // A client that tries to choose its own trust-bearing headers. None of them may
    // reach DSH: `Host` and `Cookie` are the daemon's, and `Origin` must agree with the
    // authority or DSH refuses the request.
    let (head, body) = proxy_request(
        &mut client,
        1,
        message::RequestHead {
            id: 1,
            method: "GET".to_owned(),
            target: "/index.html?x=1".to_owned(),
            headers: vec![
                ("host".to_owned(), "evil.example".to_owned()),
                ("cookie".to_owned(), "forged=1".to_owned()),
                ("origin".to_owned(), "https://evil.example".to_owned()),
                ("accept".to_owned(), "text/html".to_owned()),
            ],
            body: Vec::new(),
        },
    )
    .await?;

    assert_eq!(head.status, 200);
    assert!(
        body.ends_with(b"</html>"),
        "the response body must arrive intact"
    );
    assert!(
        body.len() > 70 * 1024,
        "a body larger than one frame must arrive whole: {}",
        body.len()
    );

    {
        // Scoped so the guard drops before the awaits below: a std::sync guard held
        // across an await is a deadlock waiting for a second task.
        let seen = lock(&log);
        let proxied = seen
            .iter()
            .find(|entry| entry.uri.starts_with("/index.html"))
            .ok_or("the fake harness never saw the proxied request")?;
        assert_eq!(proxied.method, "GET");
        assert_eq!(
            proxied.host.as_deref(),
            Some(format!("127.0.0.1:{}", dsh.port()).as_str()),
            "DSH must be reached under the loopback authority, not the client's"
        );
        assert_eq!(
            proxied.cookie.as_deref(),
            Some("dsh-auth-test=v1.payload.signature"),
            "the daemon's own session cookie must replace the client's"
        );
        assert_eq!(
            proxied.origin, None,
            "the client's Origin must not be relayed"
        );
        assert!(proxied.body_len == 0);
    }

    client.close().await?;
    daemon.abort();
    Ok(())
}

#[tokio::test]
async fn a_request_body_reaches_dsh() -> Result<(), Box<dyn std::error::Error>> {
    // DSH's `/api` calls are POSTs with a JSON body, so a proxy that dropped bodies
    // would break every remote action while leaving GETs looking healthy.
    let relay = start_relay().await?;
    let (dsh, log) = start_fake_dsh().await?;
    let relay_url = format!("ws://{relay}");
    let key = room_key(12);
    let room = dr_dsh_crypto::room_id_for(&key);
    let state: Arc<Mutex<Option<RelayState>>> = Arc::new(Mutex::new(None));

    let daemon = start_daemon(&relay_url, room.clone(), key, dsh, Arc::clone(&state)).await?;
    wait_for_parked(&state).await?;
    let mut client =
        tokio::time::timeout(PATIENCE, Transport::join(&relay_url, &room, &key)).await??;

    let body = br#"{"query":"a prompt the model would see"}"#.to_vec();
    let (head, _response) = proxy_request(
        &mut client,
        1,
        message::RequestHead {
            id: 2,
            method: "POST".to_owned(),
            target: "/api/session/search".to_owned(),
            headers: vec![
                ("content-type".to_owned(), "application/json".to_owned()),
                ("content-length".to_owned(), body.len().to_string()),
            ],
            body: body.clone(),
        },
    )
    .await?;
    assert_eq!(head.status, 200);

    {
        let seen = lock(&log);
        let proxied = seen
            .iter()
            .find(|entry| entry.uri == "/api/session/search")
            .ok_or("the fake harness never saw the POST")?;
        assert_eq!(proxied.method, "POST");
        assert_eq!(proxied.body_len, body.len(), "the request body must arrive");
        assert_eq!(
            proxied.content_lengths, 1,
            "exactly one content-length: DSH's HTTP parser answers two with an empty 400, which \
             is what every RPC the browser made came back as"
        );
    }

    client.close().await?;
    daemon.abort();
    Ok(())
}

#[tokio::test]
async fn a_target_naming_another_host_is_refused() -> Result<(), Box<dyn std::error::Error>> {
    // The client may say what it wants, never where it goes. An absolute URL is refused
    // rather than rewritten, so a mistake surfaces as a clear failure.
    let relay = start_relay().await?;
    let (dsh, log) = start_fake_dsh().await?;
    let relay_url = format!("ws://{relay}");
    let key = room_key(13);
    let room = dr_dsh_crypto::room_id_for(&key);
    let state: Arc<Mutex<Option<RelayState>>> = Arc::new(Mutex::new(None));

    let daemon = start_daemon(&relay_url, room.clone(), key, dsh, Arc::clone(&state)).await?;
    wait_for_parked(&state).await?;
    let mut client =
        tokio::time::timeout(PATIENCE, Transport::join(&relay_url, &room, &key)).await??;

    let mut payload = Vec::new();
    message::encode(
        &ProxyMessage::RequestStart(message::RequestHead {
            id: 3,
            method: "GET".to_owned(),
            target: "http://example.com/".to_owned(),
            headers: Vec::new(),
            body: Vec::new(),
        }),
        &mut payload,
    )?;
    client.send(1, &payload).await?;

    let frame = tokio::time::timeout(PATIENCE, client.next_inbound()).await??;
    match message::decode(&frame.payload)? {
        ProxyMessage::Failure(failure) => {
            assert!(failure.reason.contains("origin-form"), "{}", failure.reason);
        }
        other => return Err(format!("expected a failure, got {other:?}").into()),
    }

    {
        // And nothing reached DSH.
        let seen = lock(&log);
        assert!(
            !seen.iter().any(|entry| entry.uri.contains("example.com")),
            "a refused target must not be dialed"
        );
    }

    client.close().await?;
    daemon.abort();
    Ok(())
}

#[test]
fn the_service_is_reachable_through_the_module_paths_the_daemon_uses() {
    // A compile-time check that the names in this test are the ones the daemon uses;
    // renaming either side should break here rather than in a user's browser.
    let _ = service::validate_target("/");
    let _ = std::mem::size_of::<ProxyMessage>();
}

/// A WebSocket upgrade survives the tunnel in both directions.
///
/// This is the route that makes the remote interface *live*: DSH's session feed is a
/// WebSocket, and a proxy that only did request/response would show a snapshot that never
/// updates. Frames must travel both ways, and each direction must be independent — a feed
/// that is silent for a minute must not stop the client's own frames from being written.
#[tokio::test]
async fn a_websocket_upgrade_carries_frames_in_both_directions()
-> Result<(), Box<dyn std::error::Error>> {
    let relay = start_relay().await?;
    let (dsh, _log) = start_fake_dsh().await?;
    let relay_url = format!("ws://{relay}");
    let key = room_key(31);
    let room = dr_dsh_crypto::room_id_for(&key);
    let state: Arc<Mutex<Option<RelayState>>> = Arc::new(Mutex::new(None));

    let daemon = start_daemon(&relay_url, room.clone(), key, dsh, Arc::clone(&state)).await?;
    wait_for_parked(&state).await?;
    let mut client =
        tokio::time::timeout(PATIENCE, Transport::join(&relay_url, &room, &key)).await??;

    // Ask for the upgrade.
    let mut payload = Vec::new();
    message::encode(
        &ProxyMessage::WsOpen(message::WsOpen {
            id: 9,
            target: "/api/remote.mux".to_owned(),
            headers: vec![("sec-websocket-protocol".to_owned(), "dsh".to_owned())],
        }),
        &mut payload,
    )?;
    client.send(1, &payload).await?;

    let opened = tokio::time::timeout(PATIENCE, client.next_inbound()).await??;
    match message::decode(&opened.payload)? {
        ProxyMessage::WsOpened(head) => {
            assert_eq!(head.id, 9);
            assert_eq!(head.status, 101, "the upgrade must be accepted");
        }
        other => return Err(format!("expected an upgrade, got {other:?}").into()),
    }

    // Client → DSH, and DSH's answer back. The marker proves the frame reached the
    // harness rather than being echoed by the tunnel.
    let mut payload = Vec::new();
    message::encode(
        &ProxyMessage::WsData(message::WsData {
            id: 9,
            frame: message::WsFrame::Binary(b"session-subscribe".to_vec()),
        }),
        &mut payload,
    )?;
    client.send(1, &payload).await?;

    let answer = tokio::time::timeout(PATIENCE, client.next_inbound()).await??;
    match message::decode(&answer.payload)? {
        ProxyMessage::WsData(data) => {
            assert_eq!(data.id, 9);
            assert_eq!(
                data.frame,
                message::WsFrame::Binary(b"dsh-saw:session-subscribe".to_vec()),
                "the frame must have reached DSH and come back"
            );
        }
        other => return Err(format!("expected a frame, got {other:?}").into()),
    }

    // A second frame in the same direction, to prove the connection stays usable rather
    // than being a one-shot exchange.
    let mut payload = Vec::new();
    message::encode(
        &ProxyMessage::WsData(message::WsData {
            id: 9,
            frame: message::WsFrame::Text("second".to_owned()),
        }),
        &mut payload,
    )?;
    client.send(1, &payload).await?;
    let answer = tokio::time::timeout(PATIENCE, client.next_inbound()).await??;
    match message::decode(&answer.payload)? {
        ProxyMessage::WsData(data) => {
            assert_eq!(
                data.frame,
                message::WsFrame::Text("dsh-saw:second".to_owned())
            );
        }
        other => return Err(format!("expected a frame, got {other:?}").into()),
    }

    // Ending it reaches DSH rather than only the tunnel.
    let mut payload = Vec::new();
    message::encode(
        &ProxyMessage::WsData(message::WsData {
            id: 9,
            frame: message::WsFrame::Close,
        }),
        &mut payload,
    )?;
    client.send(1, &payload).await?;
    tokio::time::sleep(Duration::from_millis(200)).await;

    client.close().await?;
    daemon.abort();
    Ok(())
}

/// A frame for a connection that was never opened is reported, not dropped.
///
/// Silently discarding it would leave a client believing its subscription is live while
/// nothing is being forwarded — the worst possible failure for a session feed.
#[tokio::test]
async fn a_frame_for_an_unknown_websocket_is_reported() -> Result<(), Box<dyn std::error::Error>> {
    let relay = start_relay().await?;
    let (dsh, _log) = start_fake_dsh().await?;
    let relay_url = format!("ws://{relay}");
    let key = room_key(32);
    let room = dr_dsh_crypto::room_id_for(&key);
    let state: Arc<Mutex<Option<RelayState>>> = Arc::new(Mutex::new(None));

    let daemon = start_daemon(&relay_url, room.clone(), key, dsh, Arc::clone(&state)).await?;
    wait_for_parked(&state).await?;
    let mut client =
        tokio::time::timeout(PATIENCE, Transport::join(&relay_url, &room, &key)).await??;

    let mut payload = Vec::new();
    message::encode(
        &ProxyMessage::WsData(message::WsData {
            id: 404,
            frame: message::WsFrame::Binary(b"nobody".to_vec()),
        }),
        &mut payload,
    )?;
    client.send(1, &payload).await?;

    let answer = tokio::time::timeout(PATIENCE, client.next_inbound()).await??;
    match message::decode(&answer.payload)? {
        ProxyMessage::Failure(failure) => {
            assert_eq!(failure.id, 404);
            assert!(
                failure.reason.contains("no websocket"),
                "{}",
                failure.reason
            );
        }
        other => return Err(format!("expected a failure, got {other:?}").into()),
    }

    client.close().await?;
    daemon.abort();
    Ok(())
}
