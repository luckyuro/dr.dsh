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

use http_body_util::BodyExt as _;
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
    sockets: Arc<std::sync::Mutex<std::collections::HashMap<u64, SocketEntry>>>,
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
                let sender = lock_sockets(&self.sockets)
                    .get(&data.id)
                    .filter(|entry| entry.owner.same_channel(outbox))
                    .map(|entry| entry.frames.clone());
                match sender {
                    Some(sender) => {
                        if sender.send(data.frame).await.is_err() {
                            self.registry_handle().remove(data.id, outbox);
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
                sockets.retain(|_, entry| {
                    if entry.owner.same_channel(outbox) {
                        let _ = entry.frames.try_send(WsFrame::Close);
                        false
                    } else {
                        true
                    }
                });
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

        let response = self
            .client
            .forward_stream(&head.method, &destination, &head.headers, body)
            .await
            .map_err(|error| ProxyError::Upstream(upstream_reason(&error)))?;
        let (parts, mut body) = response.into_parts();

        let response_headers: Vec<(String, String)> = parts
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
                status: parts.status.as_u16(),
                headers: response_headers,
            }),
            outbox,
        )
        .await?;

        while let Some(frame) = body.frame().await {
            let frame = frame.map_err(|_| {
                ProxyError::Upstream(
                    "DSH closed its response unexpectedly; reload the interface or reconnect"
                        .into(),
                )
            })?;
            if let Ok(data) = frame.into_data() {
                for chunk in chunk_body(&data) {
                    self.send(
                        stream_id,
                        &ProxyMessage::ResponseBody(chunk.to_vec()),
                        outbox,
                    )
                    .await?;
                }
            }
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
        if outbox.is_closed() {
            return Err(ProxyError::Carrier("the carrier is gone".to_owned()));
        }
        lock_sockets(&self.sockets).insert(
            open.id,
            SocketEntry {
                frames: frames_tx,
                owner: outbox.clone(),
            },
        );
        let (mut reader, mut writer) = connection.split();

        // DSH → client.
        let to_client = {
            let outbox = outbox.clone();
            let registry = self.registry_handle();
            let id = open.id;
            tokio::spawn(async move {
                // `while let` rather than `loop`: the only reason to stop is DSH ending
                // the connection, which `next` reports as `None`.
                loop {
                    let frame = tokio::select! {
                        frame = reader.next() => frame,
                        () = outbox.closed() => break,
                    };
                    let frame = match frame {
                        Ok(Some(frame)) => frame,
                        Ok(None) => break,
                        Err(_) => {
                            let mut payload = Vec::new();
                            let failure = ProxyMessage::Failure(Failure {
                                id,
                                reason: "DSH WebSocket response failed or exceeded the 8 MiB receive limit; open a smaller session or check the DSH process".into(),
                            });
                            if encode(&failure, &mut payload).is_ok() {
                                let _ = outbox.send(Outbound { stream_id, payload }).await;
                            }
                            break;
                        }
                    };
                    if let Err(error) = send_socket_frame(stream_id, id, frame, &outbox).await {
                        let mut payload = Vec::new();
                        if encode(
                            &ProxyMessage::Failure(Failure {
                                id,
                                reason: error.to_string(),
                            }),
                            &mut payload,
                        )
                        .is_ok()
                        {
                            let _ = outbox.send(Outbound { stream_id, payload }).await;
                        }
                        break;
                    }
                }
                registry.remove(id, &outbox);
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
        let carrier = outbox.clone();
        let to_dsh = tokio::spawn(async move {
            loop {
                let frame = tokio::select! {
                    frame = frames_rx.recv() => frame,
                    () = carrier.closed() => break,
                };
                let Some(frame) = frame else {
                    break;
                };
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

async fn send_socket_frame(
    stream_id: u32,
    id: u64,
    frame: DshWsFrame,
    outbox: &mpsc::Sender<Outbound>,
) -> Result<(), ProxyError> {
    use dr_dsh_proto::proxy_ws::{MAX_CHUNK_BYTES, MAX_TEXT_BYTES, TextChunk};

    if let DshWsFrame::Text(text) = &frame
        && text.len() > MAX_CHUNK_BYTES
    {
        if text.len() > MAX_TEXT_BYTES {
            return Err(ProxyError::Refused(format!(
                "DSH WebSocket text exceeds the {MAX_TEXT_BYTES}-byte receive limit; open a smaller session or reduce its output"
            )));
        }
        let total = text.len() as u32;
        for (index, bytes) in text.as_bytes().chunks(MAX_CHUNK_BYTES).enumerate() {
            let payload = TextChunk {
                id,
                total,
                offset: (index * MAX_CHUNK_BYTES) as u32,
                bytes,
            }
            .encode()
            .map_err(|error| ProxyError::Refused(error.to_string()))?;
            outbox
                .send(Outbound { stream_id, payload })
                .await
                .map_err(|_| ProxyError::Carrier("the carrier is gone".into()))?;
        }
        return Ok(());
    }
    let mut payload = Vec::new();
    encode(
        &ProxyMessage::WsData(WsData {
            id,
            frame: from_dsh(frame),
        }),
        &mut payload,
    )
    .map_err(|error| {
        ProxyError::Refused(format!(
            "DSH WebSocket message could not be forwarded: {error}; reload the interface"
        ))
    })?;
    outbox
        .send(Outbound { stream_id, payload })
        .await
        .map_err(|_| ProxyError::Carrier("the carrier is gone".into()))
}

/// A second handle on the WebSocket registry, for tasks that must clean up their own entry.
///
/// The alternative — moving the whole service into the task — would put a service that
/// performs requests inside a task that outlives a request, which is exactly the kind of
/// lifetime tangle that turns a leak into a hang.
#[derive(Debug, Clone)]
struct SocketRegistry {
    sockets: Arc<std::sync::Mutex<std::collections::HashMap<u64, SocketEntry>>>,
}

#[derive(Debug)]
struct SocketEntry {
    frames: mpsc::Sender<WsFrame>,
    owner: mpsc::Sender<Outbound>,
}

impl SocketRegistry {
    fn remove(&self, id: u64, owner: &mpsc::Sender<Outbound>) {
        if let Ok(mut sockets) = self.sockets.lock()
            && sockets
                .get(&id)
                .is_some_and(|entry| entry.owner.same_channel(owner))
        {
            sockets.remove(&id);
        }
    }
}

/// Locks the socket registry, recovering from poisoning.
///
/// Poisoning means another request panicked while holding the lock; recovering keeps that
/// failure as the reported one instead of turning every later request into a panic.
fn lock_sockets(
    sockets: &std::sync::Mutex<std::collections::HashMap<u64, SocketEntry>>,
) -> std::sync::MutexGuard<'_, std::collections::HashMap<u64, SocketEntry>> {
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
/// Local plugin management remains inaccessible through the daemon's authenticated
/// DSH connection, including path spellings an upstream router could normalize.
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
    if target
        .bytes()
        .any(|byte| byte.is_ascii_control() || byte == b' ')
    {
        return Err(ProxyError::Refused(
            "the target must not contain whitespace or control characters; encode ordinary spaces in DSH paths".to_owned(),
        ));
    }
    if target.contains('#') {
        return Err(ProxyError::Refused(
            "the target must not contain a URL fragment; send only the DSH path and query"
                .to_owned(),
        ));
    }

    // Query data does not select a route. Inspect decoded paths only, and forward
    // the original target so ordinary encoded asset names retain their meaning.
    let path = target.split_once('?').map_or(target, |(path, _)| path);
    let mut path = path.as_bytes().to_vec();
    const MAX_PATH_DECODINGS: usize = 8;
    let mut remaining = MAX_PATH_DECODINGS;
    loop {
        validate_path_layer(&path)?;
        let Some(decoded) = decode_path_layer(&path, remaining == MAX_PATH_DECODINGS)? else {
            return Ok(target.to_owned());
        };
        if remaining == 0 {
            return Err(ProxyError::Refused(
                "the DSH path has too many nested URL escapes; use a directly encoded path"
                    .to_owned(),
            ));
        }
        path = decoded;
        remaining -= 1;
    }
}

fn validate_path_layer(path: &[u8]) -> Result<(), ProxyError> {
    if path.starts_with(b"//")
        || path
            .iter()
            .any(|byte| byte.is_ascii_control() || *byte == b'\\')
    {
        return Err(ProxyError::Refused(
            "the DSH path must not contain encoded authority prefixes, backslashes or control characters; use a plain origin-form path".to_owned(),
        ));
    }

    // WHATWG URL removes dot segments before DSH selects a route. Decoding also
    // covers reserved-name spellings a future router might otherwise reinterpret.
    let mut segments = Vec::new();
    for segment in path.split(|byte| *byte == b'/') {
        match segment {
            b"" | b"." => {}
            b".." => {
                segments.pop();
            }
            _ => segments.push(segment),
        }
    }
    if segments
        .first()
        .is_some_and(|segment| *segment == b"_drdsh")
    {
        return Err(ProxyError::Refused(
            "remote access to local daemon management is disabled; open the management page in the local DSH browser".to_owned(),
        ));
    }
    if path
        .split(|byte| *byte == b'/')
        .any(|segment| segment == b"..")
    {
        return Err(ProxyError::Refused(
            "the DSH path must not contain parent-directory segments; use its canonical path"
                .to_owned(),
        ));
    }
    Ok(())
}

fn decode_path_layer(path: &[u8], original: bool) -> Result<Option<Vec<u8>>, ProxyError> {
    let mut decoded = Vec::with_capacity(path.len());
    let mut escaped = false;
    let mut cursor = 0;
    while cursor < path.len() {
        if path[cursor] == b'%' {
            let value = path
                .get(cursor + 1..cursor + 3)
                .and_then(|pair| Some(hex_digit(pair[0])? * 16 + hex_digit(pair[1])?));
            if let Some(value) = value {
                decoded.push(value);
                cursor += 3;
                escaped = true;
                continue;
            }
            if original {
                return Err(ProxyError::Refused(
                    "the DSH path contains an invalid URL escape; encode each percent sign as %25"
                        .to_owned(),
                ));
            }
            // A decoded %25 can be a literal filename character, not another
            // escape. Preserve it while still inspecting any valid nested escapes.
        }
        decoded.push(path[cursor]);
        cursor += 1;
    }
    Ok(escaped.then_some(decoded))
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    #[test]
    fn origin_form_targets_are_accepted() -> TestResult {
        for target in [
            "/",
            "/index.html",
            "/api/session/list?limit=5",
            "/a/b/c",
            "/assets/asset..js",
            "/assets/my%20file.js",
            "/assets/100%25.svg",
            "/assets/%E4%B8%AD%E6%96%87.js",
            "/assets/a%3Fb%23c.js",
            "/assets/%2525.svg",
            "/_drdsh-other",
            "/nested/_drdsh/manage",
            "/ordinary?next=/_drdsh/manage",
            "/ordinary?next=/%255fdrdsh/manage&name=../a%2fb\\c",
        ] {
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
            "/\t_drdsh/manage",
            "/a\0b",
            "/a\u{7f}b",
            "/ordinary?control=\t",
            "/a#fragment",
            "/ordinary?query#fragment",
            "/%2fexample.com",
            "/%5c_drdsh/manage",
            "/a/%00b",
            "/a/%7fb",
            "/a/%250ab",
            "/a/%2e%2e/b",
            "/a/.%2e/b",
            "/a/%252e%252e/b",
            "/a/%",
            "/a/%2",
            "/a/%xy",
        ] {
            assert!(validate_target(target).is_err(), "{target}");
        }
    }

    #[test]
    fn local_management_paths_are_refused_after_each_normalization() -> TestResult {
        for target in [
            "/_drdsh",
            "/_drdsh/",
            "/_drdsh/manage",
            "/_drdsh/manage?token=private",
            "/./_drdsh/manage",
            "/%2e/_drdsh/manage",
            "/a/%2e%2e/_drdsh/manage",
            "/a/.%2e/_drdsh/manage",
            "/a/%2e./_drdsh/manage",
            "/.%2f_drdsh/manage",
            "/.%2f%2f_drdsh/manage",
            "/%5fdrdsh/manage",
            "/%5Fdrdsh/manage",
            "/_drdsh%2fmanage",
            "/%255fdrdsh/manage",
            "/a/%252e%252e/%255fdrdsh/manage",
        ] {
            let error = validate_target(target)
                .err()
                .ok_or("management path was accepted")?;
            assert!(
                error.to_string().contains("local daemon management"),
                "{target}: {error}"
            );
            assert!(!error.to_string().contains("private"));
        }
        Ok(())
    }

    #[test]
    fn excessive_nested_escapes_are_refused_even_for_an_ordinary_path() -> TestResult {
        let mut path = "/assets/%61.js".to_owned();
        for _ in 1..8 {
            path = path.replace('%', "%25");
        }
        assert_eq!(validate_target(&path)?, path);
        path = path.replace('%', "%25");
        let error = validate_target(&path)
            .err()
            .ok_or("a ninth decoding was skipped")?;
        assert!(error.to_string().contains("too many nested URL escapes"));
        Ok(())
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

    #[tokio::test]
    async fn event_stream_delivers_headers_and_data_before_the_host_closes() -> TestResult {
        use futures_util::StreamExt as _;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let app = axum::Router::new().route(
            "/events",
            axum::routing::get(|| async {
                let chunks = futures_util::stream::once(async {
                    Ok::<_, std::convert::Infallible>(bytes::Bytes::from_static(b"data: first\n\n"))
                })
                .chain(futures_util::stream::pending());
                (
                    [("content-type", "text/event-stream")],
                    axum::body::Body::from_stream(chunks),
                )
            }),
        );
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let service = ProxyService::new(Arc::new(DshClient::new(&format!("http://{address}"))?));
        let mut payload = Vec::new();
        encode(
            &ProxyMessage::RequestStart(RequestHead {
                id: 1,
                method: "GET".into(),
                target: "/events".into(),
                headers: vec![],
                body: vec![],
            }),
            &mut payload,
        )?;
        let (outbox, mut inbox) = mpsc::channel(4);
        let forwarding = tokio::spawn(async move { service.handle(1, &payload, &outbox).await });
        let received = tokio::time::timeout(std::time::Duration::from_secs(1), async {
            let head = inbox.recv().await.ok_or("missing response headers")?;
            let body = inbox.recv().await.ok_or("missing initial event")?;
            Ok::<_, Box<dyn std::error::Error>>((
                super::super::message::decode(&head.payload)?,
                super::super::message::decode(&body.payload)?,
            ))
        })
        .await;
        forwarding.abort();
        server.abort();
        let (head, body) = received??;
        assert!(matches!(head, ProxyMessage::ResponseStart(head) if head.status == 200));
        assert!(matches!(body, ProxyMessage::ResponseBody(bytes) if bytes == b"data: first\n\n"));
        Ok(())
    }
}
