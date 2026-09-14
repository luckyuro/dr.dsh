//! The relay's network surface.
//!
//! Four endpoints, and none of them can read what passes through:
//!
//! | Endpoint | Who uses it |
//! | :--- | :--- |
//! | `GET /healthz` | the operator's monitoring; counts, never room ids |
//! | `GET /ws/daemon?room=…` | a local daemon parking a room |
//! | `GET /ws/client?room=…` | a remote client joining a room |
//! | `GET /` | the static application shell for a browser |
//!
//! # Handshake
//!
//! A connection announces itself with one JSON text message:
//!
//! ```json
//! { "role": "daemon", "room": "<b64u>", "proto": [0, 1] }
//! ```
//!
//! and the relay answers `{"type":"ready"}` or `{"type":"reject","reason":"…"}`.
//! After that every message is a raw carrier frame.
//!
//! Text is used *only* for this handshake, so that a handshake failure is readable
//! in a browser's network panel while the data path stays binary. The room id is
//! taken from the handshake rather than the query string so that it never lands in
//! an access log by accident.
//!
//! # What the relay does with a frame
//!
//! It validates the header ([`crate::rooms::validate_frame`]) and forwards the
//! bytes. It does not look at the payload, does not decrypt, and does not keep a
//! copy: the whole data path is one table lookup and one channel send.

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use futures_util::{SinkExt as _, StreamExt as _};
use serde::Deserialize;

use crate::config::Config;
use crate::rooms::{Departure, Hub, Outbound, ParkError, Role, SharedHub};

/// Shared ingress state.
#[derive(Clone)]
pub struct Ingress {
    hub: SharedHub,
    max_rooms: usize,
    assets: Arc<crate::assets::Assets>,
    /// How often each parked connection is pinged, when keepalive is on.
    ///
    /// On the ingress rather than read from the environment at the connection: the value is decided
    /// once at startup, and a connection handler that reads the environment is a handler whose
    /// behaviour depends on when it ran.
    keepalive: Option<std::time::Duration>,
}

impl Ingress {
    /// Creates ingress state over a hub, with no client modules installed.
    #[must_use]
    pub fn new(max_rooms: usize) -> Self {
        Self::with_assets(max_rooms, crate::assets::Assets::new(None))
    }

    /// Creates ingress state that serves the client modules from a directory.
    #[must_use]
    pub fn with_assets(max_rooms: usize, assets: crate::assets::Assets) -> Self {
        Self::with_keepalive(max_rooms, assets, Some(std::time::Duration::from_secs(30)))
    }

    /// Creates ingress state with an explicit keepalive interval.
    ///
    /// A constructor rather than reading the environment here so that a test can drive the interval it
    /// needs — a keepalive that only exists at thirty seconds is a keepalive no test ever sends.
    #[must_use]
    pub fn with_keepalive(
        max_rooms: usize,
        assets: crate::assets::Assets,
        keepalive: Option<std::time::Duration>,
    ) -> Self {
        Self {
            hub: Arc::new(Mutex::new(Hub::new(max_rooms))),
            max_rooms,
            assets: Arc::new(assets),
            keepalive,
        }
    }

    /// Builds the router.
    pub fn router(self) -> Router {
        Router::new()
            .route("/healthz", get(healthz))
            .route("/", get(app_shell))
            .route("/client/{*module}", get(client_module))
            .route("/ws/daemon", get(daemon_socket))
            .route("/ws/client", get(client_socket))
            .with_state(self)
    }
}

/// Starts the relay and serves until the process is stopped.
///
/// # Errors
///
/// Returns an error when the listener cannot be bound; every later failure is
/// per-connection and does not stop the service.
pub async fn serve(config: Config) -> anyhow::Result<()> {
    let assets = crate::assets::Assets::new(config.client_dir.clone());
    let ingress = Ingress::with_keepalive(config.max_rooms, assets, config.keepalive);
    let listener = tokio::net::TcpListener::bind(config.bind)
        .await
        .map_err(|error| anyhow::anyhow!("cannot bind {}: {error}", config.bind))?;
    tracing::info!(
        bind = %config.bind,
        max_rooms = config.max_rooms,
        client = config.client_dir.as_ref().map_or("absent", |path| path.to_str().unwrap_or("?")),
        keepalive_secs = config.keepalive.map_or(0, |every| every.as_secs()),
        "relay listening"
    );
    axum::serve(listener, ingress.router())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            tracing::info!("shutting down");
        })
        .await?;
    Ok(())
}

/// Liveness and capacity, with no room identifiers.
async fn healthz(State(ingress): State<Ingress>) -> Response {
    let (rooms, max_rooms) = {
        let hub = ingress
            .hub
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        (hub.len(), ingress.max_rooms)
    };
    let body = format!(
        "{{\"service\":\"drdsh-relay\",\"version\":\"{}\",\"wire\":[{},{}],\"rooms\":{rooms},\"max_rooms\":{max_rooms}}}\n",
        env!("CARGO_PKG_VERSION"),
        dr_dsh_proto::WIRE_MAJOR,
        dr_dsh_proto::WIRE_MINOR,
    );
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        body,
    )
        .into_response()
}

/// One client module.
///
/// Served from disk rather than embedded because the client is TypeScript that has to be
/// built, and committing build output would mean reviewing it. A request for anything that
/// is not a flat `.js` module is refused, so this cannot be turned into a file read on the
/// relay's host.
async fn client_module(
    State(ingress): State<Ingress>,
    axum::extract::Path(module): axum::extract::Path<String>,
) -> Response {
    // The manifest and the icons first: they are an allowlist of names with fixed content types, so a
    // request for one can never be served as something a browser would execute or render as a page.
    if let Some((bytes, content_type)) = ingress.assets.asset(&module) {
        return (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, content_type),
                (header::CACHE_CONTROL, "public, max-age=300"),
            ],
            bytes,
        )
            .into_response();
    }
    match ingress.assets.module(&module) {
        Some(bytes) => {
            let mut response = (
                StatusCode::OK,
                [
                    (header::CONTENT_TYPE, crate::assets::module_content_type()),
                    // The client is versioned with the relay; a short cache keeps a reload
                    // honest without refetching every module on every navigation.
                    (header::CACHE_CONTROL, "public, max-age=60"),
                ],
                bytes,
            )
                .into_response();
            if module == "service-worker.js" {
                // The worker's scope defaults to its own directory, so a worker at
                // `/client/service-worker.js` may only intercept `/client/*` — which is nothing
                // the DSH interface asks for. Without this header the registration is refused
                // outright and the interface never loads, while every server-side test passes
                // because none of them is a browser.
                //
                // Widening the scope to the whole origin is what the client is for: it exists to
                // intercept the interface's own requests, which live at the root.
                response.headers_mut().insert(
                    "service-worker-allowed",
                    axum::http::HeaderValue::from_static("/"),
                );
            }
            response
        }
        None => (StatusCode::NOT_FOUND, "no such client module").into_response(),
    }
}

/// The static shell, cacheable and identical for every visitor.
async fn app_shell(State(ingress): State<Ingress>) -> Response {
    // With no client installed the shell still answers, and says what is missing: a 404
    // would look like a broken relay when the relay is fine.
    let body = if ingress.assets.has_client() {
        crate::assets::SHELL
    } else {
        crate::assets::SHELL_WITHOUT_CLIENT
    };
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "public, max-age=60"),
            // Everything the page needs is declared, and nothing else is allowed.
            //
            // `default-src 'none'` stays, so anything not named below is refused. What is named:
            // scripts and the module imports they perform from this origin, the styles the shell
            // carries inline, and the connections the client makes — the carrier socket and the
            // service worker's registration, both to this origin. `connect-src` is the one that
            // matters most: without it the client's own WebSocket is refused, which is what the
            // first version of this page did in a real browser while every test passed, because
            // no test ran a browser.
            (
                header::CONTENT_SECURITY_POLICY,
                // `'self'` is not enough for the client's own requests. The tunnel's requests are
                // QueryPort targets — a single URL naming many plugins, such as
                // `/plugins/??@scope/a/client.js,@scope/b/client.js` — and a `??` in a path makes
                // the URL **not same-origin for CSP purposes**, so `connect-src 'self'` refuses
                // it. The carrier socket then never opens and the interface stalls with no error
                // that names the cause. The two explicit origins are this page's own, which is
                // exactly the set the client is allowed to talk to.
                // `manifest-src` and `img-src` are here for installability (M3): without them the
                // relabelled page is not installable at all, because the manifest and the icon the
                // shell links are both refused by `default-src 'none'` — the install prompt simply
                // never appears, and the browser reports it only as a console violation. Both stay
                // `'self'`: the icon is served from the client directory and nothing else is allowed
                // to be an image.
                "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; \
                 img-src 'self'; manifest-src 'self'; \
                 connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*; base-uri 'none'; \
                 form-action 'none'; frame-ancestors 'none'",
            ),
        ],
        body,
    )
        .into_response()
}

/// One handshake announcement.
#[derive(Debug, Deserialize)]
struct Hello {
    /// `"daemon"` or `"client"`.
    role: String,
    /// Room id.
    room: String,
    /// Protocol version the peer speaks, as `[major, minor]`.
    #[serde(default)]
    proto: Option<(u16, u16)>,
}

impl Hello {
    /// Whether the announced role agrees with the endpoint the peer used.
    ///
    /// A mismatch is refused rather than diagnosed: the two endpoints exist so the
    /// role is unambiguous from the URL, and accepting a disagreement would let a
    /// peer choose how the relay routes it.
    fn matches(&self, role: Role) -> bool {
        matches!(
            (self.role.as_str(), role),
            ("daemon", Role::Daemon) | ("client", Role::Client)
        )
    }
}

async fn daemon_socket(upgrade: WebSocketUpgrade, State(ingress): State<Ingress>) -> Response {
    upgrade.on_upgrade(move |socket| async move { run_socket(socket, ingress, Role::Daemon).await })
}

async fn client_socket(upgrade: WebSocketUpgrade, State(ingress): State<Ingress>) -> Response {
    upgrade.on_upgrade(move |socket| async move { run_socket(socket, ingress, Role::Client).await })
}

/// Serves one socket: handshake, park, then forward until either side stops.
async fn run_socket(socket: WebSocket, ingress: Ingress, role: Role) {
    let (mut sink, mut stream) = socket.split();

    // Handshake, bounded: a peer that connects and then says nothing must not hold
    // a connection (or a rate-limit slot) indefinitely.
    let hello = match read_hello(&mut stream, role).await {
        Ok(hello) => hello,
        Err(reason) => {
            let _ = send_reject(&mut sink, reason).await;
            return;
        }
    };

    let park = {
        let mut hub = ingress
            .hub
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let known = hub.is_served(&hello.room);
        match hub.park(&hello.room, role) {
            Ok(parked) => Ok((parked, known)),
            Err(error) => Err(error),
        }
    };
    let (id, mut outbound) = match park {
        Ok((parked, _known)) => parked,
        Err(error) => {
            let reason = match error {
                ParkError::NoDaemon => "no daemon is serving this room",
                ParkError::AtCapacity { .. } => "relay is at capacity",
                ParkError::TooManyClients { .. } => "room holds too many clients",
                ParkError::Gone => "room is gone",
            };
            tracing::info!(?role, reason, "refused a connection");
            let _ = send_reject(&mut sink, reason).await;
            return;
        }
    };

    tracing::info!(?role, room = %hello.room, id, "parked");
    if sink
        .send(Message::Text("{\"type\":\"ready\"}".into()))
        .await
        .is_err()
    {
        let mut hub = ingress
            .hub
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        hub.unpark(&hello.room, role, id);
        return;
    }

    // Two loops, one connection: reads from the socket are routed onward, writes to
    // the socket come from the hub. Neither touches a payload.
    let keepalive = ingress.keepalive;
    let writer = tokio::spawn(async move {
        // The interval lives in the writer because the writer owns the sink: a keepalive sent from the
        // read loop would need the sink shared between two tasks for a two-byte frame.
        let mut ticker = keepalive.map(|every| {
            // `interval` fires its first tick immediately, which would ping every peer the moment it
            // parks — noise at exactly the moment the connection is provably alive, and it made a
            // routing test read a keepalive as a leaked frame. `interval_at` starts the clock one
            // interval out instead. Found by that test failing, not by reading the docs.
            let mut ticker = tokio::time::interval_at(tokio::time::Instant::now() + every, every);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            ticker
        });
        loop {
            let outbound = match ticker.as_mut() {
                Some(ticker) => tokio::select! {
                    outbound = outbound.recv() => outbound,
                    _ = ticker.tick() => {
                        // A WebSocket ping, not a carrier frame: the peer's own implementation answers
                        // it, no application code is involved, and it is not forwarded to anyone.
                        if sink.send(Message::Ping(Vec::new().into())).await.is_err() {
                            return;
                        }
                        continue;
                    }
                },
                None => outbound.recv().await,
            };
            let Some(outbound) = outbound else { break };
            match outbound {
                Outbound::Frame(bytes) => {
                    if sink.send(Message::Binary(bytes.into())).await.is_err() {
                        return;
                    }
                }
                Outbound::Close(reason) => {
                    let _ = sink
                        .send(Message::Text(
                            format!("{{\"type\":\"close\",\"reason\":\"{reason}\"}}").into(),
                        ))
                        .await;
                    let _ = sink.close().await;
                    return;
                }
            }
        }
        let _ = sink.close().await;
    });

    while let Some(message) = stream.next().await {
        match message {
            Ok(Message::Binary(bytes)) => {
                if let Err(reason) = crate::rooms::validate_frame(&bytes) {
                    // The writer owns the sink, so the reason goes to the log and the
                    // peer sees the connection close. Sending a text reply here would
                    // mean sharing the sink between two tasks for one diagnostic.
                    tracing::info!(room = %hello.room, reason, "closing a peer that sent an invalid frame");
                    break;
                }
                let routed = {
                    let mut hub = ingress
                        .hub
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    hub.route(&hello.room, role, id, bytes.to_vec())
                };
                match routed {
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            // The data path is binary; a text frame means the peer is confused
            // about the protocol, and ending the connection says so unambiguously.
            Ok(Message::Text(_)) => {
                tracing::info!(room = %hello.room, "closing a peer that sent text on the data path");
                break;
            }
            Ok(Message::Close(_)) | Err(_) => break,
            // Ping/Pong are answered by axum; a peer's pings are not ours to route.
            Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {}
        }
    }

    let left = {
        let mut hub = ingress
            .hub
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let left = hub.unpark(&hello.room, role, id);
        if left == Departure::LastClient {
            // Nobody is left to talk to, so the daemon's carrier has no session to
            // continue. It stops being a routing target, and the next client gets a
            // daemon whose session begins where every session begins: at the salt.
            let _ = hub.release_daemon(&hello.room);
        }
        left
    };
    match left {
        // The room stops being advertised immediately: a client that arrives now is
        // told there is nothing to talk to instead of waiting for a peer that is
        // not coming.
        Departure::DaemonStopped => {
            tracing::info!(room = %hello.room, "the room's daemon left");
        }
        Departure::LastClient => {
            tracing::info!(
                room = %hello.room,
                "the last client left; its daemon re-registers before the next one joins"
            );
        }
        Departure::Nothing => {}
    }
    writer.abort();
    tracing::info!(?role, room = %hello.room, id, "unparked");
}

/// Reads the handshake announcement.
///
/// The room id arrives here rather than in the query string so it never lands in
/// an access log by accident, and the announced role must agree with the endpoint
/// the peer used: the relay routes by the endpoint, never by a peer's claim.
async fn read_hello(
    stream: &mut futures_util::stream::SplitStream<WebSocket>,
    endpoint: Role,
) -> Result<Hello, &'static str> {
    let first = tokio::time::timeout(HANDSHAKE_TIMEOUT, stream.next())
        .await
        .map_err(|_| "handshake timed out")?
        .ok_or("connection closed before the handshake")?
        .map_err(|_| "connection failed during the handshake")?;

    let text = match first {
        Message::Text(text) => text,
        // Permit the query-string form for a peer that sends a frame first.
        Message::Binary(_) => {
            return Err("the first message must be the handshake");
        }
        _ => return Err("the first message must be the handshake"),
    };
    let hello: Hello = serde_json::from_str(&text).map_err(|_| "handshake is not valid JSON")?;
    if hello.room.is_empty() {
        return Err("handshake carries no room id");
    }
    if !hello.matches(endpoint) {
        return Err("the announced role does not match this endpoint");
    }
    if let Some((major, _minor)) = hello.proto
        && major != dr_dsh_proto::WIRE_MAJOR
    {
        return Err("incompatible wire major version");
    }
    Ok(hello)
}

async fn send_reject(
    sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    reason: &str,
) -> Result<(), axum::Error> {
    // The reason is one of a fixed set of short strings; none of them contains a
    // room id, a device id, or anything a peer supplied.
    sink.send(Message::Text(
        format!("{{\"type\":\"reject\",\"reason\":\"{reason}\"}}").into(),
    ))
    .await
}

/// How long a peer has to announce itself.
const HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt as _;

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    #[tokio::test]
    async fn healthz_reports_counts_without_room_ids() -> TestResult {
        let response = Ingress::new(16)
            .router()
            .oneshot(Request::builder().uri("/healthz").body(Body::empty())?)
            .await?;
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), 4096).await?;
        let text = String::from_utf8_lossy(&body);
        assert!(text.contains("\"rooms\":0"), "{text}");
        assert!(
            !text.contains("room\""),
            "health output must not list rooms: {text}"
        );
        Ok(())
    }

    #[tokio::test]
    async fn the_app_shell_is_static_and_says_what_this_is() -> TestResult {
        let response = Ingress::new(16)
            .router()
            .oneshot(Request::builder().uri("/").body(Body::empty())?)
            .await?;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            response
                .headers()
                .contains_key(header::CONTENT_SECURITY_POLICY),
            "the shell must declare a content security policy"
        );
        let body = axum::body::to_bytes(response.into_body(), 8192).await?;
        let text = String::from_utf8_lossy(&body);
        assert!(text.contains("dr.dsh"), "{text}");
        assert!(
            text.contains("zero-knowledge relay"),
            "with no client installed the page must explain what the relay is: {text}"
        );
        Ok(())
    }

    #[tokio::test]
    async fn an_unknown_path_is_a_plain_404() -> TestResult {
        let response = Ingress::new(16)
            .router()
            .oneshot(Request::builder().uri("/nope").body(Body::empty())?)
            .await?;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        Ok(())
    }
}
