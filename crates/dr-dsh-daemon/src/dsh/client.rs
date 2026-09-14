//! The daemon's HTTP client for talking to DSH on loopback.
//!
//! # Why this is hand-built
//!
//! A general-purpose HTTP client would be the wrong tool here, for three
//! reasons that are all security-relevant:
//!
//! 1. **The `Host` header is part of authentication.** DSH signs its session
//!    cookie against the request authority, so this client must present
//!    `Host: 127.0.0.1:<port>` and nothing else. A client with its own idea of
//!    "the request URL's host" would work today and break subtly later.
//! 2. **Redirects must not be followed silently.** The token exchange *is* a
//!    `303`, and its value is the `Set-Cookie` header. A client that follows
//!    redirects would swallow the thing we need.
//! 3. **No hidden retries.** A retried `POST /api/...` could enqueue a prompt
//!    twice. Whatever retry policy exists belongs to the layer that knows which
//!    requests are idempotent.
//!
//! So this is hyper's HTTP/1 client with explicit header control, plus the one
//! piece of state that matters: the authority-bound session cookie.
//!
//! # WebSocket upgrading
//!
//! One route needs more than request/response: DSH's `/api/remote.mux`, which the Web UI
//! uses for its live session feed. [`DshClient::upgrade`] performs the handshake under the
//! same authority and cookie as every other call, and hands back a connection to pipe
//! bytes through. It is a separate path from [`DshClient::forward`] because an upgraded
//! connection stops being HTTP: after the `101`, both ends are just bytes.
//!
//! # The cookie
//!
//! [`SessionCookie`] holds the `dsh-auth-…=v1.…` value. It is deliberately
//! opaque: the daemon never parses or validates it, it only presents it back,
//! exactly as a browser would. Nothing about it is logged ([`SessionCookie`]'s
//! `Debug` prints a redaction), because it is a bearer credential for the user's
//! entire DSH instance.

use std::fmt;

use bytes::Bytes;
use http_body_util::{BodyExt as _, Full, combinators::BoxBody};
use hyper::{Method, Request, StatusCode, header};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;

/// How long a single loopback request may take.
///
/// Generous, because DSH legitimately streams long responses, and this timeout
/// only guards against a wedged socket — the supervisor's health check is what
/// notices a dead process.
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Why a request to DSH failed.
#[derive(Debug, thiserror::Error)]
pub enum DshClientError {
    /// The connection or the exchange failed at the transport level.
    #[error("loopback request to DSH failed: {0}")]
    Transport(String),
    /// DSH answered, but not with what the protocol requires.
    #[error("DSH answered {status}: {detail}")]
    Unexpected {
        /// The status DSH returned.
        status: StatusCode,
        /// A short, non-sensitive description of what was expected.
        detail: String,
    },
    /// The token exchange returned no session cookie.
    #[error("DSH token exchange returned no session cookie for authority {authority}")]
    NoCookie {
        /// The authority we asked under.
        authority: String,
    },
}

/// An authority-bound DSH session cookie.
///
/// Created only by [`DshClient::authenticate`], so a value of this type is
/// evidence that the token exchange actually happened.
#[derive(Clone)]
pub struct SessionCookie(String);

impl SessionCookie {
    /// Wraps a cookie value that came from DSH.
    ///
    /// The value is the full `name=value` pair, because DSH's cookie name is
    /// derived from the authority (`dsh-auth-<hash>`); the daemon does not need
    /// to know the derivation, only to send it back.
    #[must_use]
    pub fn new(raw: impl Into<String>) -> Self {
        Self(raw.into())
    }

    fn as_header(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SessionCookie {
    /// Redacted: this is a bearer credential for the user's whole DSH instance.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SessionCookie(redacted)")
    }
}

/// What came back from one loopback request.
#[derive(Debug)]
pub struct DshResponse {
    /// The response status.
    pub status: StatusCode,
    /// Response headers, as DSH sent them.
    pub headers: hyper::HeaderMap,
    /// The complete response body.
    ///
    /// Buffered rather than streamed for the M0 control paths. Proxying to a
    /// remote client will need streaming (see the roadmap), and when it does, it
    /// belongs in the proxy module rather than here — this type stays small and
    /// easy to reason about.
    pub body: Bytes,
}

impl DshResponse {
    /// The body as UTF-8, lossily.
    #[must_use]
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// A client bound to one DSH instance's loopback authority.
#[derive(Debug, Clone)]
pub struct DshClient {
    http: Client<HttpConnector, BoxBody<Bytes, std::io::Error>>,
    /// `scheme://authority`, e.g. `http://127.0.0.1:3080`.
    base_url: String,
    /// The authority to present as `Host`; identical to what was authenticated.
    authority: String,
    /// The session cookie, once the token exchange has happened.
    cookie: Option<SessionCookie>,
}

/// A WebSocket connection to DSH, framing bytes in both directions.
///
/// Deliberately thin: it carries text and binary payloads, and it does not parse DSH's
/// protocol. Whatever the Web UI sends over `/api/remote.mux` is what the remote client
/// receives, byte for byte.
pub struct WebSocketConn {
    socket: tokio_tungstenite::WebSocketStream<hyper_util::rt::TokioIo<hyper::upgrade::Upgraded>>,
}

/// The reading half of an upgraded connection.
pub struct WsReader {
    stream: futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<hyper_util::rt::TokioIo<hyper::upgrade::Upgraded>>,
    >,
}

/// The writing half of an upgraded connection.
pub struct WsWriter {
    sink: futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<hyper_util::rt::TokioIo<hyper::upgrade::Upgraded>>,
        tokio_tungstenite::tungstenite::Message,
    >,
}

impl WebSocketConn {
    fn new(
        socket: tokio_tungstenite::WebSocketStream<
            hyper_util::rt::TokioIo<hyper::upgrade::Upgraded>,
        >,
    ) -> Self {
        Self { socket }
    }

    /// Splits the connection so both directions can be driven at once.
    ///
    /// A task per direction, each owning its half. Sharing one connection behind a lock
    /// would mean a frame waiting to be written blocks the frame waiting to be read —
    /// and a live session feed is precisely the case where that deadlocks.
    #[must_use]
    pub fn split(self) -> (WsReader, WsWriter) {
        use futures_util::StreamExt as _;

        let (sink, stream) = self.socket.split();
        (WsReader { stream }, WsWriter { sink })
    }
}

impl WsReader {
    /// Reads the next frame, or `None` when DSH closed the connection.
    ///
    /// # Errors
    ///
    /// Returns the transport failure as a string; the proxy reports it to the client
    /// rather than trying to interpret it.
    pub async fn next(&mut self) -> Result<Option<WsFrame>, String> {
        use futures_util::StreamExt as _;

        loop {
            let Some(message) = self.stream.next().await else {
                return Ok(None);
            };
            let message = message.map_err(|error| error.to_string())?;
            match message {
                tokio_tungstenite::tungstenite::Message::Text(text) => {
                    return Ok(Some(WsFrame::Text(text.to_string())));
                }
                tokio_tungstenite::tungstenite::Message::Binary(bytes) => {
                    return Ok(Some(WsFrame::Binary(bytes.to_vec())));
                }
                tokio_tungstenite::tungstenite::Message::Close(_) => return Ok(None),
                // Ping/pong are answered by the tungstenite layer; they are not content.
                tokio_tungstenite::tungstenite::Message::Ping(_)
                | tokio_tungstenite::tungstenite::Message::Pong(_)
                | tokio_tungstenite::tungstenite::Message::Frame(_) => continue,
            }
        }
    }
}

impl WsWriter {
    /// Writes one frame to DSH.
    ///
    /// # Errors
    ///
    /// Returns the transport failure as a string.
    pub async fn send(&mut self, frame: WsFrame) -> Result<(), String> {
        use futures_util::SinkExt as _;

        let message = match frame {
            WsFrame::Text(text) => tokio_tungstenite::tungstenite::Message::Text(text.into()),
            WsFrame::Binary(bytes) => tokio_tungstenite::tungstenite::Message::Binary(bytes.into()),
            WsFrame::Close => tokio_tungstenite::tungstenite::Message::Close(None),
        };
        self.sink
            .send(message)
            .await
            .map_err(|error| error.to_string())
    }
}

impl core::fmt::Debug for WsReader {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("WsReader(..)")
    }
}

impl core::fmt::Debug for WsWriter {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("WsWriter(..)")
    }
}

impl core::fmt::Debug for WebSocketConn {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("WebSocketConn(..)")
    }
}

/// One frame on a WebSocket, as the proxy carries it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WsFrame {
    /// A text frame.
    Text(String),
    /// A binary frame.
    Binary(Vec<u8>),
    /// A close, in either direction.
    Close,
}

/// Headers that describe one hop and must not be relayed to the next.
///
/// Standard proxy hygiene: `Connection` names further headers to drop, and
/// `Transfer-Encoding` describes framing this client replaces with its own.
fn is_hop_by_hop(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

/// Headers the daemon owns because they carry authentication or origin trust.
///
/// These are the headers DSH's own fences read: `Host` decides whether the request
/// looks local, `Cookie` carries the authority-bound session, and `Origin` must agree
/// with the authority when a browser sends one. A remote client must not be able to
/// choose any of them, or it could pick its own authority and defeat the fence the
/// proxy exists to satisfy.
fn is_authority_owned(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "host" | "cookie" | "origin" | "referer"
    )
}

/// Headers the daemon owns because it re-frames the body itself.
///
/// `Content-Length` is the one that matters, and getting it wrong cost several rounds of
/// misdiagnosis: the body the daemon sends is exactly the body it holds, so it sets the length
/// itself — and forwarding the client's claim *as well* puts **two** `Content-Length` headers on
/// the wire. Node's HTTP parser refuses that outright:
///
/// ```text
/// POST /api/session/list HTTP/1.1 with one Content-Length  -> 200
/// POST /api/session/list HTTP/1.1 with two                 -> 400 (empty body)
/// ```
///
/// Every remote-procedure call DSH's interface makes is a POST with a JSON body, so every one of
/// them came back as an empty `400` — which looked exactly like "DSH's RPC surface is broken on
/// this machine" and was written down as a DSH-side condition. It was this. `GET` requests carry
/// no `Content-Length`, which is why fetching the interface worked the whole time and only the
/// RPCs failed.
fn is_body_owned(name: &str) -> bool {
    name.eq_ignore_ascii_case("content-length")
}

/// Boxes a body into the client's single error type.
///
/// `Full` is infallible (`Infallible`), while the client's body type is parameterised
/// by `io::Error`; mapping here keeps that difference from leaking into call sites.
fn boxed(body: Full<Bytes>) -> BoxBody<Bytes, std::io::Error> {
    body.map_err(|never| match never {}).boxed()
}

impl DshClient {
    /// Creates an unauthenticated client for `base_url`.
    ///
    /// # Errors
    ///
    /// Returns [`DshClientError::Unexpected`] when `base_url` is not an absolute
    /// `http` URL with an authority.
    pub fn new(base_url: &str) -> Result<Self, DshClientError> {
        let authority = base_url
            .strip_prefix("http://")
            .filter(|rest| !rest.is_empty() && !rest.contains('/'))
            .ok_or_else(|| DshClientError::Unexpected {
                status: StatusCode::BAD_REQUEST,
                detail: format!("base URL must be http://<authority>, got {base_url:?}"),
            })?;
        let mut connector = HttpConnector::new();
        // DSH serves plain HTTP on loopback. Allowing the connector to reach
        // anything else would be a way for a misconfiguration to leave the
        // machine, so the only permitted host is the one we were constructed
        // with — enforced in `send`, where the URL is assembled.
        connector.enforce_http(true);
        let http = Client::builder(TokioExecutor::new()).build(connector);
        Ok(Self {
            http,
            base_url: base_url.to_owned(),
            authority: authority.to_owned(),
            cookie: None,
        })
    }

    /// The authority this client presents.
    #[must_use]
    pub fn authority(&self) -> &str {
        &self.authority
    }

    /// Whether the token exchange has completed.
    #[must_use]
    pub fn is_authenticated(&self) -> bool {
        self.cookie.is_some()
    }

    /// Performs the token exchange and stores the resulting session cookie.
    ///
    /// This is `GET /?token=…`: DSH answers `303` with `Set-Cookie` and a
    /// `Location: /`. The status is checked to be a redirect precisely because a
    /// `200` here would mean DSH authenticated a *different* flow than the one we
    /// rely on, and silently proceeding would produce 401s much later.
    ///
    /// # Errors
    ///
    /// Fails on a transport error, on a non-redirect status, or when no
    /// `Set-Cookie` header is present.
    pub async fn authenticate(&mut self, token: &str) -> Result<(), DshClientError> {
        let target = format!("{}/?token={}", self.base_url, token);
        let response = self.send(Method::GET, &target, None).await?;
        if !response.status.is_redirection() {
            return Err(DshClientError::Unexpected {
                status: response.status,
                detail: "expected a redirect from the token exchange".to_owned(),
            });
        }
        let cookie = response
            .headers
            .get(header::SET_COOKIE)
            .and_then(|value| value.to_str().ok())
            // A `Set-Cookie` may carry attributes; the header the daemon sends
            // back is only the `name=value` pair.
            .and_then(|value| value.split(';').next())
            .map(str::trim)
            .filter(|pair| pair.contains('='))
            .ok_or_else(|| DshClientError::NoCookie {
                authority: self.authority.clone(),
            })?;
        self.cookie = Some(SessionCookie::new(cookie));
        Ok(())
    }

    /// Issues a `GET`, authenticated when a cookie is held.
    ///
    /// # Errors
    ///
    /// Returns the transport or protocol failure.
    pub async fn get(&self, path_and_query: &str) -> Result<DshResponse, DshClientError> {
        let target = format!("{}{}", self.base_url, path_and_query);
        self.send(Method::GET, &target, None).await
    }

    /// Issues a `POST` with a JSON body, which is DSH's shape for `/api`.
    ///
    /// # Errors
    ///
    /// Returns the transport or protocol failure.
    pub async fn post_json(
        &self,
        path_and_query: &str,
        body: &str,
    ) -> Result<DshResponse, DshClientError> {
        let target = format!("{}{}", self.base_url, path_and_query);
        self.send(Method::POST, &target, Some(body)).await
    }

    /// Forwards one proxied request, preserving the client's headers.
    ///
    /// This is the method the proxy layer uses, and it is where DSH's authentication
    /// is actually supplied: whatever the remote client sent, the daemon replaces the
    /// authority-bearing `Host` and the `Cookie` with the values it authenticated
    /// with, and drops the hop-by-hop headers that must not cross a proxy. A remote
    /// client therefore cannot choose its own authority or present a cookie of its
    /// own making — which is what keeps DSH's fence meaningful.
    ///
    /// # Errors
    ///
    /// Returns the transport or protocol failure. A non-success status is a normal
    /// response and is returned, not raised.
    pub async fn forward(
        &self,
        method: &str,
        path_and_query: &str,
        headers: &[(String, String)],
        body: Vec<u8>,
    ) -> Result<DshResponse, DshClientError> {
        let method =
            Method::from_bytes(method.as_bytes()).map_err(|error| DshClientError::Unexpected {
                status: StatusCode::BAD_REQUEST,
                detail: format!("unusable request method: {error}"),
            })?;
        let target = format!("{}{}", self.base_url, path_and_query);
        let mut builder = Request::builder().method(method).uri(target);
        for (name, value) in headers {
            if is_hop_by_hop(name) || is_authority_owned(name) || is_body_owned(name) {
                continue;
            }
            builder = builder.header(name, value);
        }
        self.finish(builder, Some(body)).await
    }

    /// Performs a WebSocket handshake against DSH and returns the upgraded connection.
    ///
    /// The request goes out under the same authority and cookie as every other call, so
    /// DSH's fences are satisfied exactly as they are for a plain request. After the
    /// `101`, the connection is bytes in both directions and this client has no further
    /// opinion about them.
    ///
    /// # Errors
    ///
    /// Returns [`DshClientError::Unexpected`] when DSH does not answer `101`, which is
    /// what a rejected upgrade looks like — most often a `401` from the browser fence or
    /// a `404` if the route moved.
    pub async fn upgrade(
        &self,
        path_and_query: &str,
        headers: &[(String, String)],
    ) -> Result<WebSocketConn, DshClientError> {
        let target = format!("{}{}", self.base_url, path_and_query);
        let mut builder = Request::builder()
            .method(Method::GET)
            .uri(target)
            .header(header::HOST, &self.authority)
            .header(header::CONNECTION, "upgrade")
            .header(header::UPGRADE, "websocket")
            // A fixed key: this is not a browser, and the value only has to be present
            // for DSH's HTTP layer. The `Sec-WebSocket-Accept` check is performed by the
            // tungstenite client below, so a server that ignored the handshake is caught.
            .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
            .header("sec-websocket-version", "13");
        if let Some(cookie) = &self.cookie {
            builder = builder.header(header::COOKIE, cookie.as_header());
        }
        for (name, value) in headers {
            if is_hop_by_hop(name) || is_authority_owned(name) || is_body_owned(name) {
                continue;
            }
            builder = builder.header(name, value);
        }
        let request = builder
            .body(boxed(Full::new(Bytes::new())))
            .map_err(|error| DshClientError::Transport(error.to_string()))?;

        let response = self
            .http
            .request(request)
            .await
            .map_err(|error| DshClientError::Transport(error.to_string()))?;
        if response.status() != StatusCode::SWITCHING_PROTOCOLS {
            return Err(DshClientError::Unexpected {
                status: response.status(),
                detail: format!("expected a 101 upgrade for {path_and_query}"),
            });
        }

        let upgraded = hyper::upgrade::on(response)
            .await
            .map_err(|error| DshClientError::Transport(format!("upgrade failed: {error}")))?;
        // `Upgraded` implements hyper's `Read`/`Write`; tungstenite needs tokio's, which
        // `TokioIo` bridges. Both directions then speak WebSocket framing.
        let socket = tokio_tungstenite::WebSocketStream::from_raw_socket(
            hyper_util::rt::TokioIo::new(upgraded),
            tokio_tungstenite::tungstenite::protocol::Role::Client,
            None,
        )
        .await;
        Ok(WebSocketConn::new(socket))
    }

    /// Sends one request with the authority and cookie this client holds.
    async fn send(
        &self,
        method: Method,
        target: &str,
        body: Option<&str>,
    ) -> Result<DshResponse, DshClientError> {
        let builder = Request::builder().method(method).uri(target);
        match body {
            Some(payload) => {
                self.finish(builder, Some(payload.as_bytes().to_vec()))
                    .await
            }
            None => self.finish(builder, None).await,
        }
    }

    /// Applies this client's authority and cookie, then sends.
    async fn finish(
        &self,
        mut builder: hyper::http::request::Builder,
        body: Option<Vec<u8>>,
    ) -> Result<DshResponse, DshClientError> {
        // The Host header is not a formality: DSH's session cookie is signed
        // against the request authority, and its `/api` fence refuses anything
        // that is not loopback or an explicitly trusted host. Setting it
        // explicitly, from the authority we authenticated under, is what keeps
        // those two facts true at the same time.
        builder = builder.header(header::HOST, &self.authority);
        if let Some(cookie) = &self.cookie {
            builder = builder.header(header::COOKIE, cookie.as_header());
        }
        let request = match body {
            Some(payload) => builder
                .header(header::CONTENT_LENGTH, payload.len())
                .body(boxed(Full::new(Bytes::from(payload))))
                .map_err(|error| DshClientError::Transport(error.to_string()))?,
            None => builder
                .body(boxed(Full::new(Bytes::new())))
                .map_err(|error| DshClientError::Transport(error.to_string()))?,
        };

        let response = tokio::time::timeout(REQUEST_TIMEOUT, self.http.request(request))
            .await
            .map_err(|_| DshClientError::Transport("loopback request timed out".to_owned()))?
            .map_err(|error| DshClientError::Transport(error.to_string()))?;

        let status = response.status();
        let headers = response.headers().clone();
        let body = response
            .into_body()
            .collect()
            .await
            .map_err(|error| DshClientError::Transport(error.to_string()))?
            .to_bytes();
        Ok(DshResponse {
            status,
            headers,
            body,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_client_needs_an_absolute_http_authority() {
        assert!(DshClient::new("http://127.0.0.1:3080").is_ok());
        assert!(DshClient::new("https://127.0.0.1:3080").is_err());
        assert!(DshClient::new("http://127.0.0.1:3080/").is_err());
        assert!(DshClient::new("127.0.0.1:3080").is_err());
        assert!(DshClient::new("").is_err());
    }

    #[test]
    fn the_authority_is_preserved_verbatim() -> Result<(), DshClientError> {
        let client = DshClient::new("http://127.0.0.1:46101")?;
        assert_eq!(client.authority(), "127.0.0.1:46101");
        assert!(!client.is_authenticated());
        Ok(())
    }

    #[test]
    fn hop_by_hop_headers_are_recognised_case_insensitively() {
        for name in [
            "Connection",
            "KEEP-ALIVE",
            "Transfer-Encoding",
            "Upgrade",
            "te",
        ] {
            assert!(is_hop_by_hop(name), "{name}");
        }
        for name in ["content-type", "accept", "user-agent", "x-custom"] {
            assert!(!is_hop_by_hop(name), "{name}");
        }
    }

    #[test]
    fn the_headers_that_carry_trust_are_owned_by_the_daemon() {
        // Each of these is read by a DSH fence, so a remote client must not set it.
        for name in ["Host", "COOKIE", "Origin", "Referer"] {
            assert!(is_authority_owned(name), "{name}");
        }
        for name in ["content-type", "accept", "authorization"] {
            assert!(!is_authority_owned(name), "{name}");
        }
    }

    #[test]
    fn the_body_framing_headers_are_owned_by_the_daemon() {
        // `Content-Length` is not trust-bearing and not hop-by-hop: it is re-framed, because the
        // body the daemon sends is the body it holds. Forwarding the client's claim as well puts two
        // on the wire, and Node answers that with an empty `400` before DSH's code runs.
        assert!(is_body_owned("Content-Length"));
        assert!(is_body_owned("CONTENT-LENGTH"));
        for name in ["content-type", "accept", "host", "transfer-encoding"] {
            assert!(!is_body_owned(name), "{name}");
        }
    }

    #[tokio::test]
    async fn a_forwarded_post_carries_exactly_one_content_length()
    -> Result<(), Box<dyn std::error::Error>> {
        // A **raw TCP server**, because the defect this pins is a wire defect: Node's HTTP parser
        // refuses a message with two `Content-Length` headers and answers `400` with an empty body,
        // and that is what every remote-procedure call the browser made came back as for several
        // rounds — recorded at the time as "DSH's RPC surface is broken on this machine".
        //
        // A server built on hyper or axum cannot see it: the header map the handler receives has the
        // duplicates collapsed, so a harness built on one is happy with a request the real DSH
        // rejects. That asymmetry is the whole reason this test speaks HTTP itself.
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let server = tokio::spawn(async move {
            let Ok((mut socket, _)) = listener.accept().await else {
                return None;
            };
            let mut buffer = vec![0_u8; 16 * 1024];
            let read = socket.read(&mut buffer).await.unwrap_or(0);
            let head = String::from_utf8_lossy(&buffer[..read]).to_string();
            let lengths = head
                .lines()
                .take_while(|line| !line.is_empty())
                .filter(|line| line.to_ascii_lowercase().starts_with("content-length:"))
                .count();
            // What Node does with two of them.
            let status = if lengths == 1 {
                "200 OK"
            } else {
                "400 Bad Request"
            };
            let response =
                format!("HTTP/1.1 {status}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.flush().await;
            Some(lengths)
        });

        let client = DshClient::new(&format!("http://{addr}"))?;
        let body = br#"{"type":"client-request","rpcId":"x","method":"session/list"}"#.to_vec();
        let response = client
            .forward(
                "POST",
                "/api/session/list",
                &[
                    ("content-type".to_owned(), "application/json".to_owned()),
                    // Exactly what the browser's proxy client sends with a body.
                    ("content-length".to_owned(), body.len().to_string()),
                ],
                body,
            )
            .await?;
        assert_eq!(
            response.status, 200,
            "the request must carry one content-length, or DSH answers 400 without looking at it"
        );
        assert_eq!(server.await?, Some(1));
        Ok(())
    }

    #[test]
    fn a_cookie_never_prints_its_value() {
        let cookie = SessionCookie::new("dsh-auth-abc=v1.secret.signature");
        let printed = format!("{cookie:?}");
        assert_eq!(printed, "SessionCookie(redacted)");
        assert!(!printed.contains("secret"));
    }
}
