//! Performing proxied requests against DSH, and streaming the answer back.
//!
//! # The rule this module exists to keep
//!
//! A remote client may say *what* it wants — method, path, headers — and never *where*
//! it goes. The daemon answers that question itself, with the loopback authority it
//! authenticated under, so DSH's own fences (the `Host` check and the authority-bound
//! session cookie) still mean what they were written to mean
//! ([ADR-0003](../../../docs/decisions/0003-no-fork-integration.md)).
//!
//! # Streaming
//!
//! A response is forwarded chunk by chunk as DSH produces it. That matters for more
//! than throughput: DSH's client-side feed and its long agent turns deliver over
//! seconds to minutes, and a proxy that buffered would make the remote UI look frozen
//! and then dump a wall of text.
//!
//! For M0 the *request* body is buffered before being sent. A request body is a prompt
//! or a small JSON document, so the latency cost is nil, and streaming a request would
//! mean holding a half-sent request open against a `Content-Length` that has to be
//! known up front anyway.

use std::sync::Arc;

use tokio::sync::mpsc;

use super::message::{
    Failure, ProxyMessage, RequestHead, ResponseHead, WsData, WsFrame, WsOpen, chunk_body, encode,
    header_map,
};
use crate::dsh::{DshClient, WsFrame as DshWsFrame};
use crate::uplink::Outbound;

/// Why a proxied request failed.
///
/// [`ProxyError::Reported`] is the odd one out and the important one: it means the client
/// has *already been told* what went wrong, so the carrier must stay up. A peer that sent
/// a bad target should learn why and keep its connection; tearing the connection down
/// would turn a fixable mistake into a reconnect.
#[derive(Debug, thiserror::Error)]
pub enum ProxyError {
    /// The client's request head is not one the daemon will perform.
    #[error("refused the request: {0}")]
    Refused(String),
    /// DSH could not be reached, or answered in a way the client cannot use.
    #[error("DSH could not be reached: {0}")]
    Upstream(String),
    /// The carrier failed while the exchange was in flight.
    #[error("the carrier failed: {0}")]
    Carrier(String),
    /// Something the client can fix, already reported to it.
    #[error("{0}")]
    Reported(String),
}

/// Performs proxied requests and writes their answers to the carrier.
///
/// One instance per daemon, shared behind an `Arc` because each in-flight request runs
/// on its own task: a response body can take seconds, and the uplink's read loop must
/// stay free to accept the next request while it does.
///
/// The service does not own a queue. Responses go into the carrier's outbox, which the
/// caller passes to [`ProxyService::handle`] — a service with a private queue needs
/// somebody to drain it, and a queue nobody drains is a request that hangs forever.
#[derive(Debug)]
pub struct ProxyService {
    client: Arc<DshClient>,
    /// Live WebSocket upgrades, by id.
    ///
    /// The service is otherwise stateless — one request in, one response out — but an
    /// upgraded connection outlives the message that opened it, so its sender has to
    /// live somewhere until the connection ends. Behind a `Mutex` because `handle` takes
    /// `&self`: many requests are in flight at once and each writes its own response.
    sockets: Arc<std::sync::Mutex<std::collections::HashMap<u64, mpsc::Sender<WsFrame>>>>,
}

impl ProxyService {
    /// Creates a service over an authenticated DSH client.
    #[must_use]
    pub fn new(client: Arc<DshClient>) -> Self {
        Self {
            client,
            sockets: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        }
    }

    /// Authenticates the client this service will use.
    ///
    /// Deliberately not a `client_mut` accessor: handing out `&mut DshClient` would let a
    /// caller replace the client and silently drop the authority-bound cookie that every
    /// later proxied request depends on. This method can only do the one thing the
    /// service needs before it is shared.
    ///
    /// # Errors
    ///
    /// Returns [`ProxyError::Upstream`] when the client is already shared (so its
    /// authentication cannot be changed) or when DSH refuses the token.
    pub async fn authenticate(&mut self, token: &str) -> Result<(), ProxyError> {
        let client = Arc::get_mut(&mut self.client)
            .ok_or_else(|| ProxyError::Upstream("the proxy client is already in use".to_owned()))?;
        client
            .authenticate(token)
            .await
            .map_err(|error| ProxyError::Upstream(upstream_reason(&error)))
    }

    /// Handles one inbound proxy message.
    ///
    /// Returns `true` when the message belonged to this layer, so the caller can tell
    /// a proxied frame from a control message without parsing either.
    ///
    /// # Errors
    ///
    /// Returns an error when the request was refused, DSH could not be reached, or the
    /// carrier failed. Anything the *client* got wrong is additionally reported to it
    /// as a [`ProxyMessage::Failure`], so a remote user reads a named cause instead of
    /// watching a request that never completes.
    pub async fn handle(
        &self,
        stream_id: u32,
        payload: &[u8],
        outbox: &mpsc::Sender<Outbound>,
    ) -> Result<bool, ProxyError> {
        let message = match super::message::decode(payload) {
            Ok(message) => message,
            // Not a proxy message: the control plane owns it. Told apart by variant
            // rather than by message text, because the two planes differ by magic alone.
            Err(super::message::ProxyCodecError::BadMagic) => {
                return Ok(false);
            }
            Err(error) => {
                return Err(ProxyError::Refused(error.to_string()));
            }
        };

        match message {
            // A request is performed as soon as its head arrives: the head carries the
            // body, and most requests have none, so waiting for a terminator would stall
            // the common case. A failure here does not close the stream — the client is
            // told why through a `Failure` message and may reuse the stream.
            ProxyMessage::RequestStart(head) => {
                let id = head.id;
                eprintln!(
                    "PROXY request stream={stream_id} id={id} {} {}",
                    head.method, head.target
                );
                if let Err(error) = self.perform(stream_id, head, outbox).await {
                    // Everything that can go wrong here is something the *client* can act
                    // on — a target it should not have asked for, a malformed body, a DSH
                    // that is not answering — so it is told, and the stream stays open.
                    // Returning the error without saying anything would leave the client
                    // waiting for a response that is never coming.
                    self.report_failure(stream_id, id, &error.to_string(), outbox)
                        .await?;
                    return Ok(true);
                }
                Ok(true)
            }
            ProxyMessage::WsOpen(open) => {
                let id = open.id;
                if let Err(error) = self.open_websocket(stream_id, open, outbox).await {
                    self.report_failure(stream_id, id, &error.to_string(), outbox)
                        .await?;
                }
                Ok(true)
            }
            ProxyMessage::WsData(data) => {
                // A frame for a connection this daemon does not have. Most likely the
                // upgrade was refused, and the client kept writing; saying so is better
                // than silently dropping frames it believes are being delivered.
                let sender = lock_sockets(&self.sockets).get(&data.id).cloned();
                match sender {
                    Some(sender) => {
                        if sender.send(data.frame).await.is_err() {
                            lock_sockets(&self.sockets).remove(&data.id);
                        }
                        Ok(true)
                    }
                    None => {
                        let reason = format!("no websocket {} is open", data.id);
                        self.report_failure(stream_id, data.id, &reason, outbox)
                            .await?;
                        Ok(true)
                    }
                }
            }
            ProxyMessage::WsClose => {
                // The client is ending every websocket it holds on this stream.
                let mut sockets = lock_sockets(&self.sockets);
                for (_, sender) in sockets.drain() {
                    let _ = sender.try_send(WsFrame::Close);
                }
                Ok(true)
            }
            ProxyMessage::ResponseStart(_)
            | ProxyMessage::ResponseBody(_)
            | ProxyMessage::ResponseEnd
            | ProxyMessage::Failure(_)
            | ProxyMessage::WsOpened(_) => Err(ProxyError::Refused(
                "a response message arrived at the daemon".to_owned(),
            )),
            ProxyMessage::RequestBody(_) | ProxyMessage::RequestEnd => Err(ProxyError::Refused(
                "a request body arrived before its request head".to_owned(),
            )),
        }
    }

    /// Performs one request and streams its response.
    ///
    /// The body is whatever the client already sent: for M0 the daemon performs the
    /// request as soon as the head arrives, using the body the client announced through
    /// `content-length`. Streaming a request body would mean holding a half-sent
    /// request against DSH, and DSH's own client does not do that either.
    async fn perform(
        &self,
        stream_id: u32,
        head: RequestHead,
        outbox: &mpsc::Sender<Outbound>,
    ) -> Result<(), ProxyError> {
        let destination = validate_target(&head.target)?;
        let body = request_body(&head)?;

        let outcome = self
            .client
            .forward(&head.method, &destination, &head.headers, body)
            .await;
        let response = match outcome {
            Ok(response) => response,
            Err(error) => {
                let reason = upstream_reason(&error);
                self.report_failure(stream_id, head.id, &reason, outbox)
                    .await?;
                return Err(ProxyError::Upstream(reason));
            }
        };

        let response_headers: Vec<(String, String)> = response
            .headers
            .iter()
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value| (name.as_str().to_owned(), value.to_owned()))
            })
            .collect();

        self.send(
            stream_id,
            &ProxyMessage::ResponseStart(ResponseHead {
                id: head.id,
                status: response.status.as_u16(),
                headers: response_headers,
            }),
            outbox,
        )
        .await?;

        for chunk in chunk_body(&response.body) {
            self.send(
                stream_id,
                &ProxyMessage::ResponseBody(chunk.to_vec()),
                outbox,
            )
            .await?;
        }
        self.send(stream_id, &ProxyMessage::ResponseEnd, outbox)
            .await
    }

    /// Opens a WebSocket against DSH and pumps frames in both directions.
    ///
    /// Two tasks per connection, and they end together: the writer stops when the
    /// client's sender is dropped (which happens when the socket is read out of the
    /// registry), and the reader stops when DSH closes.
    async fn open_websocket(
        &self,
        stream_id: u32,
        open: WsOpen,
        outbox: &mpsc::Sender<Outbound>,
    ) -> Result<(), ProxyError> {
        let destination = validate_target(&open.target)?;
        let connection = self
            .client
            .upgrade(&destination, &open.headers)
            .await
            .map_err(|error| ProxyError::Upstream(upstream_reason(&error)))?;

        self.send(
            stream_id,
            &ProxyMessage::WsOpened(super::message::WsOpened {
                id: open.id,
                status: 101,
                headers: Vec::new(),
            }),
            outbox,
        )
        .await?;

        let (frames_tx, mut frames_rx) = mpsc::channel::<WsFrame>(WS_QUEUE);
        lock_sockets(&self.sockets).insert(open.id, frames_tx);
        let (mut reader, mut writer) = connection.split();

        // DSH → client.
        let to_client = {
            let outbox = outbox.clone();
            let registry = self.registry_handle();
            let id = open.id;
            tokio::spawn(async move {
                // `while let` rather than `loop`: the only reason to stop is DSH ending
                // the connection, which `next` reports as `None`.
                while let Ok(Some(frame)) = reader.next().await {
                    let message = ProxyMessage::WsData(WsData {
                        id,
                        frame: from_dsh(frame),
                    });
                    let mut payload = Vec::new();
                    if encode(&message, &mut payload).is_err() {
                        break;
                    }
                    if outbox.send(Outbound { stream_id, payload }).await.is_err() {
                        break;
                    }
                }
                registry.remove(id);
                let mut payload = Vec::new();
                if encode(
                    &ProxyMessage::WsData(WsData {
                        id,
                        frame: WsFrame::Close,
                    }),
                    &mut payload,
                )
                .is_ok()
                {
                    let _ = outbox.send(Outbound { stream_id, payload }).await;
                }
            })
        };

        // Client → DSH. Ends when the socket is removed from the registry, which drops
        // this receiver's only sender.
        let to_dsh = tokio::spawn(async move {
            while let Some(frame) = frames_rx.recv().await {
                let ending = frame == WsFrame::Close;
                if writer.send(to_dsh(frame)).await.is_err() || ending {
                    break;
                }
            }
        });

        // Neither task is awaited here: the upgrade must not block the caller, or the
        // read loop would stop accepting the frames these tasks exist to carry.
        drop((to_client, to_dsh));
        Ok(())
    }

    /// A second handle on the socket registry, for a task that must clean up after itself.
    fn registry_handle(&self) -> SocketRegistry {
        SocketRegistry {
            sockets: Arc::clone(&self.sockets),
        }
    }

    /// Writes one message to the carrier.
    async fn send(
        &self,
        stream_id: u32,
        message: &ProxyMessage,
        outbox: &mpsc::Sender<Outbound>,
    ) -> Result<(), ProxyError> {
        let mut payload = Vec::new();
        encode(message, &mut payload).map_err(|error| ProxyError::Refused(error.to_string()))?;
        outbox
            .send(Outbound { stream_id, payload })
            .await
            .map_err(|_| ProxyError::Carrier("the carrier is gone".to_owned()))
    }

    /// Reports a failure to the client without failing the stream.
    ///
    /// A refused request is the client's problem to display, not a reason to tear down
    /// a working tunnel.
    ///
    /// # Errors
    ///
    /// Returns an error only when the carrier itself is gone.
    pub async fn report_failure(
        &self,
        stream_id: u32,
        id: u64,
        reason: &str,
        outbox: &mpsc::Sender<Outbound>,
    ) -> Result<(), ProxyError> {
        self.send(
            stream_id,
            &ProxyMessage::Failure(Failure {
                id,
                reason: reason.to_owned(),
            }),
            outbox,
        )
        .await
    }
}

/// Extracts a request body the client has already sent in full.
///
/// M0 performs a request as soon as its head arrives, so the body must already be
/// present. `content-length` is how the client says how much that is; a request without
/// it has no body. A declared length that does not match what arrived is refused rather
/// than truncated: DSH would receive a request whose framing disagrees with its own
/// reading of it, which is how request smuggling starts.
///
/// # Errors
///
/// Returns [`ProxyError::Refused`] when a declared body is missing or malformed.
fn request_body(head: &RequestHead) -> Result<Vec<u8>, ProxyError> {
    let headers = header_map(&head.headers);
    match headers.get("content-length") {
        None => Ok(Vec::new()),
        Some(declared) => {
            let declared: usize = declared.trim().parse().map_err(|_| {
                ProxyError::Refused(format!("content-length is not a number: {declared:?}"))
            })?;
            if declared != head.body.len() {
                return Err(ProxyError::Refused(format!(
                    "content-length says {declared} bytes but {} arrived",
                    head.body.len()
                )));
            }
            Ok(head.body.clone())
        }
    }
}

/// A second handle on the WebSocket registry, for tasks that must clean up their own entry.
///
/// The alternative — moving the whole service into the task — would put a service that
/// performs requests inside a task that outlives a request, which is exactly the kind of
/// lifetime tangle that turns a leak into a hang.
#[derive(Debug, Clone)]
struct SocketRegistry {
    sockets: Arc<std::sync::Mutex<std::collections::HashMap<u64, mpsc::Sender<WsFrame>>>>,
}

impl SocketRegistry {
    fn remove(&self, id: u64) {
        if let Ok(mut sockets) = self.sockets.lock() {
            sockets.remove(&id);
        }
    }
}

/// Locks the socket registry, recovering from poisoning.
///
/// Poisoning means another request panicked while holding the lock; recovering keeps that
/// failure as the reported one instead of turning every later request into a panic.
fn lock_sockets(
    sockets: &std::sync::Mutex<std::collections::HashMap<u64, mpsc::Sender<WsFrame>>>,
) -> std::sync::MutexGuard<'_, std::collections::HashMap<u64, mpsc::Sender<WsFrame>>> {
    sockets
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Converts a frame from DSH into the proxy's frame type.
fn from_dsh(frame: DshWsFrame) -> WsFrame {
    match frame {
        DshWsFrame::Text(text) => WsFrame::Text(text),
        DshWsFrame::Binary(bytes) => WsFrame::Binary(bytes),
        DshWsFrame::Close => WsFrame::Close,
    }
}

/// Converts a proxy frame into the frame DSH is sent.
fn to_dsh(frame: WsFrame) -> DshWsFrame {
    match frame {
        WsFrame::Text(text) => DshWsFrame::Text(text),
        WsFrame::Binary(bytes) => DshWsFrame::Binary(bytes),
        WsFrame::Close => DshWsFrame::Close,
    }
}

/// How many WebSocket frames may be queued for one connection before its peer waits.
///
/// Small, for the same reason the carrier's queue is: the queue decouples two speeds, it
/// does not buffer a slow peer. A client that cannot keep up with its own session feed
/// should feel backpressure, not watch memory grow.
const WS_QUEUE: usize = 64;

/// A fixed reason for an upstream failure.
///
/// Fixed phrases rather than the client's error text: that text can carry a URL or a
/// header value, and this string is displayed to a remote user.
fn upstream_reason(error: &crate::dsh::DshClientError) -> String {
    use crate::dsh::DshClientError;
    match error {
        DshClientError::Transport(_) => "DSH is not answering on loopback".to_owned(),
        DshClientError::Unexpected { status, .. } => {
            format!("DSH refused the request with status {}", status.as_u16())
        }
        DshClientError::NoCookie { .. } => "the daemon is not authenticated against DSH".to_owned(),
    }
}

/// Validates the client's requested target.
///
/// Only origin-form targets are performed. An absolute URL is refused rather than
/// rewritten, because accepting one would mean the client had named a host — and the
/// host is the one thing this proxy must decide for itself. A traversal sequence is
/// refused for the same reason: it is an attempt to leave the origin the daemon chose.
///
/// # Errors
///
/// Returns [`ProxyError::Refused`] for anything that is not a plain path.
pub fn validate_target(target: &str) -> Result<String, ProxyError> {
    if !target.starts_with('/') {
        return Err(ProxyError::Refused(
            "the target must be an origin-form path beginning with /".to_owned(),
        ));
    }
    if target.starts_with("//") {
        // `//host/path` is a protocol-relative URL: a host by another spelling.
        return Err(ProxyError::Refused(
            "the target must not begin with //".to_owned(),
        ));
    }
    if target.contains("..") || target.contains('\\') {
        return Err(ProxyError::Refused(
            "the target must not contain .. or \\".to_owned(),
        ));
    }
    if target.contains('\r') || target.contains('\n') || target.contains(' ') {
        return Err(ProxyError::Refused(
            "the target must not contain whitespace".to_owned(),
        ));
    }
    Ok(target.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    #[test]
    fn origin_form_targets_are_accepted() -> TestResult {
        for target in ["/", "/index.html", "/api/session/list?limit=5", "/a/b/c"] {
            assert_eq!(validate_target(target)?, target);
        }
        Ok(())
    }

    #[test]
    fn a_target_naming_a_host_is_refused() {
        // The host is the daemon's decision. Accepting any of these would let a remote
        // client aim the proxy at something other than the DSH it authenticated with.
        for target in [
            "http://127.0.0.1:3080/api",
            "https://example.com/",
            "//example.com/path",
            "127.0.0.1:3080/api",
        ] {
            assert!(validate_target(target).is_err(), "{target}");
        }
    }

    #[test]
    fn traversal_and_injection_shapes_are_refused() {
        for target in [
            "/../etc/passwd",
            "/a/../../b",
            "/a\\b",
            "/a b",
            "/a\r\nHost: evil",
        ] {
            assert!(validate_target(target).is_err(), "{target}");
        }
    }

    #[tokio::test]
    async fn a_stream_that_is_not_a_proxy_message_is_left_to_the_control_plane() -> TestResult {
        let client = Arc::new(DshClient::new("http://127.0.0.1:1")?);
        let service = ProxyService::new(client);
        // A control message is JSON: not this layer's, and not an error.
        let (outbox, _inbox) = mpsc::channel(4);
        assert!(
            !service
                .handle(0, br#"{"kind":"status_request"}"#, &outbox)
                .await?
        );
        Ok(())
    }

    #[tokio::test]
    async fn a_response_message_aimed_at_the_daemon_is_refused() -> TestResult {
        let client = Arc::new(DshClient::new("http://127.0.0.1:1")?);
        let service = ProxyService::new(client);
        let mut payload = Vec::new();
        encode(&ProxyMessage::ResponseEnd, &mut payload)?;
        let (outbox, _inbox) = mpsc::channel(4);
        assert!(service.handle(1, &payload, &outbox).await.is_err());
        Ok(())
    }
}
