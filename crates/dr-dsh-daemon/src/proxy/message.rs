//! The proxy's wire messages, and their codec.
//!
//! Binary rather than JSON because a response body is bytes and because the same
//! stream carries DSH's own traffic: a JSON envelope would need every chunk base64'd,
//! inflating a stream whose whole point is not to be inflated.
//!
//! Every message is `type (1 byte) | payload`, and multi-byte integers are
//! big-endian, matching the carrier. The layout is deliberately trivial to
//! re-implement: the browser client must speak it, and a format that needs a
//! generated codec to be readable is a format that will be implemented differently in
//! the second language (see ADR-0004 for how that has gone before).
//!
//! ## Layouts
//!
//! ```text
//! field          size            notes
//! ---------------------------------------------------------------------------
//! u8             1               small integer; a body chunk length is bounded by
//! u16/u32/u64    2/4/8           the carrier's payload cap anyway
//! bytes          u32 length + n  strings and bodies
//! headers        u16 count, then count × (bytes name, bytes value)
//! ```
//!
//! ## Why a request id
//!
//! Streams are already a demultiplexer, so the id looks redundant — and for a strict
//! one-request-per-stream client it is. It exists because the client is a browser with
//! a service worker that may reuse a connection, and because a response that arrives
//! on the wrong stream must be *detectable* rather than merely unlikely.

use std::collections::BTreeMap;

/// Largest header block this codec will decode.
///
/// Bounded so a peer cannot make the daemon allocate without limit before any
/// request is performed. Real DSH requests carry a handful of small headers.
const MAX_HEADER_BYTES: usize = 64 * 1024;

/// Largest single body chunk this codec will decode.
///
/// Matches the carrier's payload cap, minus the codec's own overhead: a chunk that
/// cannot be framed is a chunk the sender must split anyway.
const MAX_CHUNK_BYTES: usize = dr_dsh_proto::MAX_PAYLOAD_LEN as usize - 64;

/// Magic prefix identifying a proxy message stream.
pub const MAGIC: &[u8; 2] = b"PX";

/// Version of the proxy message format.
pub const VERSION: u8 = 1;

/// One message on a proxied stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProxyMessage {
    /// A request begins: the daemon can start performing it.
    RequestStart(RequestHead),
    /// A chunk of the request body.
    RequestBody(Vec<u8>),
    /// The request body is complete.
    RequestEnd,
    /// A response begins.
    ResponseStart(ResponseHead),
    /// A chunk of the response body.
    ResponseBody(Vec<u8>),
    /// The response is complete.
    ResponseEnd,
    /// The daemon could not perform the request.
    Failure(Failure),
    /// A WebSocket upgrade begins.
    WsOpen(WsOpen),
    /// The upgrade succeeded; the connection is now framed bytes.
    WsOpened(WsOpened),
    /// One WebSocket frame, in whichever direction it is travelling.
    WsData(WsData),
    /// The WebSocket ended.
    WsClose,
}

/// A request to upgrade a route to a WebSocket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WsOpen {
    /// Client-chosen correlation id, echoed on [`WsOpened`].
    pub id: u64,
    /// Origin-form target to upgrade.
    pub target: String,
    /// Handshake headers to forward.
    pub headers: Vec<(String, String)>,
}

/// The outcome of an upgrade.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WsOpened {
    /// The id of the upgrade this answers.
    pub id: u64,
    /// `101` when the connection was upgraded.
    pub status: u16,
    /// The negotiated headers.
    pub headers: Vec<(String, String)>,
}

/// One WebSocket frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WsData {
    /// Which connection this frame belongs to.
    pub id: u64,
    /// The frame itself.
    pub frame: WsFrame,
}

/// A frame's kind and payload, without WebSocket's framing details.
///
/// Ping, pong, and continuation frames do not appear: each end's WebSocket implementation
/// owns those, and forwarding them would mean two layers both trying to manage one
/// connection's liveness.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WsFrame {
    /// A text frame.
    Text(String),
    /// A binary frame.
    Binary(Vec<u8>),
    /// The connection is ending.
    Close,
}

/// The head of a proxied request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestHead {
    /// Client-chosen correlation id, echoed on the response.
    pub id: u64,
    /// HTTP method, upper-case as the client sent it.
    pub method: String,
    /// Origin-form target: path plus optional query, never a full URL.
    ///
    /// The daemon refuses an absolute URL because it would let a client name the host
    /// it wants reached. The host is the daemon's to choose, and it chooses loopback.
    pub target: String,
    /// Request headers, in the order received.
    pub headers: Vec<(String, String)>,
    /// The request body.
    ///
    /// Carried in the head rather than streamed, because M0 performs a request as soon
    /// as it arrives and a request body is a prompt or a small JSON document. The
    /// `RequestBody`/`RequestEnd` messages exist for the WebSocket work, where a
    /// long-lived exchange genuinely streams in both directions.
    pub body: Vec<u8>,
}

/// The head of a proxied response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResponseHead {
    /// The id of the request this answers.
    pub id: u64,
    /// HTTP status code.
    pub status: u16,
    /// Response headers.
    pub headers: Vec<(String, String)>,
}

/// Why a request could not be performed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    /// The id of the request that failed.
    pub id: u64,
    /// A short, non-sensitive reason.
    ///
    /// Fixed phrases, never a formatted error from the DSH client: those can carry a
    /// URL or a header value, and this string is shown to a remote user.
    pub reason: String,
}

/// Why a message could not be decoded.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ProxyCodecError {
    /// The bytes do not start with the proxy magic.
    #[error("not a proxy message stream")]
    BadMagic,
    /// The message format version is not this build's.
    #[error("unsupported proxy message version {found}; this build speaks {expected}")]
    Version {
        /// Version the peer sent.
        found: u8,
        /// Version this build implements.
        expected: u8,
    },
    /// The message type byte is not assigned.
    #[error("unknown proxy message type {0}")]
    UnknownType(u8),
    /// The buffer ended before the message did.
    #[error("truncated proxy message: needed {needed} bytes, had {had}")]
    Truncated {
        /// Bytes the message required.
        needed: usize,
        /// Bytes available.
        had: usize,
    },
    /// A length field exceeds what this codec accepts.
    #[error("proxy message declares {declared} bytes, above the {max} limit")]
    TooLarge {
        /// Declared length.
        declared: usize,
        /// Accepted maximum.
        max: usize,
    },
    /// A string was not valid UTF-8.
    #[error("proxy message carries invalid UTF-8")]
    NotUtf8,
    /// A header block exceeded its bound.
    #[error("header block exceeds {0} bytes")]
    HeadersTooLarge(usize),
    /// A WebSocket frame kind byte is not assigned.
    #[error("unknown websocket frame kind {0}")]
    UnknownFrameKind(u8),
    /// The message type does not belong on this side of the exchange.
    #[error("a {0} is not sent in this direction")]
    WrongDirection(&'static str),
}

impl ProxyCodecError {
    /// Whether the receiver should give up on the connection.
    ///
    /// Every codec error is fatal for the stream: the framing is length-prefixed, so
    /// after a bad length there is no way to find the next message boundary. Resyncing
    /// would mean guessing, and a proxy that guesses about framing is a proxy that
    /// corrupts streams.
    #[must_use]
    pub fn is_fatal(&self) -> bool {
        true
    }
}

/// Message type tags on the wire.
mod tag {
    /// A request head.
    pub const REQUEST_START: u8 = 1;
    /// A request body chunk.
    pub const REQUEST_BODY: u8 = 2;
    /// The end of a request body.
    pub const REQUEST_END: u8 = 3;
    /// A response head.
    pub const RESPONSE_START: u8 = 4;
    /// A response body chunk.
    pub const RESPONSE_BODY: u8 = 5;
    /// The end of a response body.
    pub const RESPONSE_END: u8 = 6;
    /// A failed request.
    pub const FAILURE: u8 = 7;
    /// A WebSocket upgrade request.
    pub const WS_OPEN: u8 = 8;
    /// An upgrade's outcome.
    pub const WS_OPENED: u8 = 9;
    /// One WebSocket frame.
    pub const WS_DATA: u8 = 10;
    /// The end of a WebSocket.
    pub const WS_CLOSE: u8 = 11;
}

/// Encodes one message, appending it to `out`.
///
/// # Errors
///
/// Returns [`ProxyCodecError::TooLarge`] when a body chunk or header block exceeds the
/// limit; the caller is expected to have split the body already.
pub fn encode(message: &ProxyMessage, out: &mut Vec<u8>) -> Result<(), ProxyCodecError> {
    out.extend_from_slice(MAGIC);
    out.push(VERSION);
    match message {
        ProxyMessage::RequestStart(head) => {
            out.push(tag::REQUEST_START);
            put_u64(out, head.id);
            put_bytes(out, head.method.as_bytes())?;
            put_bytes(out, head.target.as_bytes())?;
            put_headers(out, &head.headers)?;
            put_bytes(out, &head.body)?;
        }
        ProxyMessage::RequestBody(chunk) => {
            out.push(tag::REQUEST_BODY);
            put_bytes(out, chunk)?;
        }
        ProxyMessage::RequestEnd => out.push(tag::REQUEST_END),
        ProxyMessage::ResponseStart(head) => {
            out.push(tag::RESPONSE_START);
            put_u64(out, head.id);
            out.extend_from_slice(&head.status.to_be_bytes());
            put_headers(out, &head.headers)?;
        }
        ProxyMessage::ResponseBody(chunk) => {
            out.push(tag::RESPONSE_BODY);
            put_bytes(out, chunk)?;
        }
        ProxyMessage::ResponseEnd => out.push(tag::RESPONSE_END),
        ProxyMessage::Failure(failure) => {
            out.push(tag::FAILURE);
            put_u64(out, failure.id);
            put_bytes(out, failure.reason.as_bytes())?;
        }
        ProxyMessage::WsOpen(open) => {
            out.push(tag::WS_OPEN);
            put_u64(out, open.id);
            put_bytes(out, open.target.as_bytes())?;
            put_headers(out, &open.headers)?;
        }
        ProxyMessage::WsOpened(opened) => {
            out.push(tag::WS_OPENED);
            put_u64(out, opened.id);
            out.extend_from_slice(&opened.status.to_be_bytes());
            put_headers(out, &opened.headers)?;
        }
        ProxyMessage::WsData(data) => {
            out.push(tag::WS_DATA);
            put_u64(out, data.id);
            match &data.frame {
                WsFrame::Text(text) => {
                    out.push(1);
                    put_bytes(out, text.as_bytes())?;
                }
                WsFrame::Binary(bytes) => {
                    out.push(2);
                    put_bytes(out, bytes)?;
                }
                WsFrame::Close => out.push(3),
            }
        }
        ProxyMessage::WsClose => out.push(tag::WS_CLOSE),
    }
    Ok(())
}

/// Decodes one message from the front of `bytes`.
///
/// # Errors
///
/// Returns a [`ProxyCodecError`]; see [`ProxyCodecError::is_fatal`] for why the caller
/// must treat all of them as fatal to the stream.
pub fn decode(bytes: &[u8]) -> Result<ProxyMessage, ProxyCodecError> {
    let mut cursor = Cursor::new(bytes);
    if cursor.take(2)? != MAGIC {
        return Err(ProxyCodecError::BadMagic);
    }
    let version = cursor.u8()?;
    if version != VERSION {
        return Err(ProxyCodecError::Version {
            found: version,
            expected: VERSION,
        });
    }
    let tag = cursor.u8()?;
    let message = match tag {
        tag::REQUEST_START => ProxyMessage::RequestStart(RequestHead {
            id: cursor.u64()?,
            method: cursor.string()?,
            target: cursor.string()?,
            headers: cursor.headers()?,
            body: cursor.bytes()?,
        }),
        tag::REQUEST_BODY => ProxyMessage::RequestBody(cursor.bytes()?),
        tag::REQUEST_END => ProxyMessage::RequestEnd,
        tag::RESPONSE_START => ProxyMessage::ResponseStart(ResponseHead {
            id: cursor.u64()?,
            status: u16::from_be_bytes(
                cursor
                    .take(2)?
                    .try_into()
                    .map_err(|_| ProxyCodecError::Truncated { needed: 2, had: 0 })?,
            ),
            headers: cursor.headers()?,
        }),
        tag::RESPONSE_BODY => ProxyMessage::ResponseBody(cursor.bytes()?),
        tag::RESPONSE_END => ProxyMessage::ResponseEnd,
        tag::FAILURE => ProxyMessage::Failure(Failure {
            id: cursor.u64()?,
            reason: cursor.string()?,
        }),
        tag::WS_OPEN => ProxyMessage::WsOpen(WsOpen {
            id: cursor.u64()?,
            target: cursor.string()?,
            headers: cursor.headers()?,
        }),
        tag::WS_OPENED => ProxyMessage::WsOpened(WsOpened {
            id: cursor.u64()?,
            status: cursor.u16()?,
            headers: cursor.headers()?,
        }),
        tag::WS_DATA => {
            let id = cursor.u64()?;
            let kind = cursor.u8()?;
            let frame = match kind {
                1 => WsFrame::Text(cursor.string()?),
                2 => WsFrame::Binary(cursor.bytes()?),
                3 => WsFrame::Close,
                other => return Err(ProxyCodecError::UnknownFrameKind(other)),
            };
            ProxyMessage::WsData(WsData { id, frame })
        }
        tag::WS_CLOSE => ProxyMessage::WsClose,
        other => return Err(ProxyCodecError::UnknownType(other)),
    };
    Ok(message)
}

/// Splits a body into chunks the codec can frame.
///
/// One place decides the chunk size, so the browser client and the daemon split bodies
/// identically and neither has to discover the other's limit by failing.
#[must_use]
pub fn chunk_body(body: &[u8]) -> Vec<&[u8]> {
    body.chunks(MAX_CHUNK_BYTES).collect()
}

fn put_u64(out: &mut Vec<u8>, value: u64) {
    out.extend_from_slice(&value.to_be_bytes());
}

fn put_bytes(out: &mut Vec<u8>, bytes: &[u8]) -> Result<(), ProxyCodecError> {
    if bytes.len() > MAX_CHUNK_BYTES {
        return Err(ProxyCodecError::TooLarge {
            declared: bytes.len(),
            max: MAX_CHUNK_BYTES,
        });
    }
    let length = u32::try_from(bytes.len()).map_err(|_| ProxyCodecError::TooLarge {
        declared: bytes.len(),
        max: MAX_CHUNK_BYTES,
    })?;
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(bytes);
    Ok(())
}

fn put_headers(out: &mut Vec<u8>, headers: &[(String, String)]) -> Result<(), ProxyCodecError> {
    let total: usize = headers
        .iter()
        .map(|(name, value)| name.len() + value.len() + 8)
        .sum();
    if total > MAX_HEADER_BYTES {
        return Err(ProxyCodecError::HeadersTooLarge(total));
    }
    let count =
        u16::try_from(headers.len()).map_err(|_| ProxyCodecError::HeadersTooLarge(total))?;
    out.extend_from_slice(&count.to_be_bytes());
    for (name, value) in headers {
        put_bytes(out, name.as_bytes())?;
        put_bytes(out, value.as_bytes())?;
    }
    Ok(())
}

/// A bounds-checked reader over a message buffer.
struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, at: 0 }
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], ProxyCodecError> {
        let end = self
            .at
            .checked_add(count)
            .ok_or(ProxyCodecError::Truncated {
                needed: count,
                had: self.bytes.len(),
            })?;
        if end > self.bytes.len() {
            return Err(ProxyCodecError::Truncated {
                needed: end,
                had: self.bytes.len(),
            });
        }
        let slice = &self.bytes[self.at..end];
        self.at = end;
        Ok(slice)
    }

    fn u8(&mut self) -> Result<u8, ProxyCodecError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, ProxyCodecError> {
        let bytes = self.take(2)?;
        Ok(u16::from_be_bytes([bytes[0], bytes[1]]))
    }

    fn u32(&mut self) -> Result<u32, ProxyCodecError> {
        let bytes = self.take(4)?;
        Ok(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    fn u64(&mut self) -> Result<u64, ProxyCodecError> {
        let bytes = self.take(8)?;
        let mut value = [0_u8; 8];
        value.copy_from_slice(bytes);
        Ok(u64::from_be_bytes(value))
    }

    fn bytes(&mut self) -> Result<Vec<u8>, ProxyCodecError> {
        let length = self.u32()? as usize;
        if length > MAX_CHUNK_BYTES {
            return Err(ProxyCodecError::TooLarge {
                declared: length,
                max: MAX_CHUNK_BYTES,
            });
        }
        Ok(self.take(length)?.to_vec())
    }

    fn string(&mut self) -> Result<String, ProxyCodecError> {
        String::from_utf8(self.bytes()?).map_err(|_| ProxyCodecError::NotUtf8)
    }

    fn headers(&mut self) -> Result<Vec<(String, String)>, ProxyCodecError> {
        let count = self.u16()? as usize;
        let mut headers = Vec::with_capacity(count.min(64));
        let mut total = 0;
        for _ in 0..count {
            let name = self.string()?;
            let value = self.string()?;
            total += name.len() + value.len();
            if total > MAX_HEADER_BYTES {
                return Err(ProxyCodecError::HeadersTooLarge(total));
            }
            headers.push((name, value));
        }
        Ok(headers)
    }
}

/// Collects headers into a lookup, keeping the last value for a repeated name.
///
/// Used by the daemon when it needs one header's value; the ordered vector stays the
/// representation on the wire, because order and repetition are part of HTTP.
#[must_use]
pub fn header_map(headers: &[(String, String)]) -> BTreeMap<String, String> {
    headers
        .iter()
        .map(|(name, value)| (name.to_ascii_lowercase(), value.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    fn round_trip(message: &ProxyMessage) -> Result<ProxyMessage, Box<dyn std::error::Error>> {
        let mut buffer = Vec::new();
        encode(message, &mut buffer)?;
        Ok(decode(&buffer)?)
    }

    #[test]
    fn request_heads_round_trip() -> TestResult {
        let head = ProxyMessage::RequestStart(RequestHead {
            id: 7,
            method: "POST".to_owned(),
            target: "/api/session/list?limit=5".to_owned(),
            headers: vec![
                ("content-type".to_owned(), "application/json".to_owned()),
                ("accept".to_owned(), "*/*".to_owned()),
            ],
            body: br#"{"query":"hello"}"#.to_vec(),
        });
        assert_eq!(round_trip(&head)?, head);
        Ok(())
    }

    #[test]
    fn response_heads_round_trip() -> TestResult {
        let head = ProxyMessage::ResponseStart(ResponseHead {
            id: 7,
            status: 303,
            headers: vec![("location".to_owned(), "/".to_owned())],
        });
        assert_eq!(round_trip(&head)?, head);
        Ok(())
    }

    #[test]
    fn bodies_and_terminators_round_trip() -> TestResult {
        let cases = [
            ProxyMessage::RequestBody(b"the body".to_vec()),
            ProxyMessage::RequestEnd,
            ProxyMessage::ResponseBody(vec![0_u8, 255, 1]),
            ProxyMessage::ResponseEnd,
            ProxyMessage::Failure(Failure {
                id: 3,
                reason: "the request never reached DSH".to_owned(),
            }),
        ];
        for case in cases {
            assert_eq!(round_trip(&case)?, case);
        }
        Ok(())
    }

    #[test]
    fn websocket_messages_round_trip() -> TestResult {
        let cases = [
            ProxyMessage::WsOpen(WsOpen {
                id: 4,
                target: "/api/remote.mux".to_owned(),
                headers: vec![("sec-websocket-protocol".to_owned(), "dsh".to_owned())],
            }),
            ProxyMessage::WsOpened(WsOpened {
                id: 4,
                status: 101,
                headers: vec![("upgrade".to_owned(), "websocket".to_owned())],
            }),
            ProxyMessage::WsData(WsData {
                id: 4,
                frame: WsFrame::Text("{\"type\":\"item\"}".to_owned()),
            }),
            ProxyMessage::WsData(WsData {
                id: 4,
                frame: WsFrame::Binary(vec![0, 1, 255]),
            }),
            ProxyMessage::WsData(WsData {
                id: 4,
                frame: WsFrame::Close,
            }),
            ProxyMessage::WsClose,
        ];
        for case in cases {
            assert_eq!(round_trip(&case)?, case);
        }
        Ok(())
    }

    #[test]
    fn a_websocket_frame_kind_is_validated() {
        // A peer must not be able to name a frame kind the receiver has no meaning for.
        let mut payload = Vec::new();
        payload.extend_from_slice(MAGIC);
        payload.push(VERSION);
        payload.push(tag::WS_DATA);
        payload.extend_from_slice(&1_u64.to_be_bytes());
        payload.push(9);
        assert_eq!(decode(&payload), Err(ProxyCodecError::UnknownFrameKind(9)));
    }

    #[test]
    fn an_empty_body_is_distinct_from_no_body() -> TestResult {
        // The client's `fetch` always sends a body for POST; a zero-length chunk must
        // not be confused with an absent one, or a POST becomes a GET-shaped request.
        let empty = ProxyMessage::RequestBody(Vec::new());
        assert_eq!(round_trip(&empty)?, empty);
        assert_ne!(round_trip(&empty)?, ProxyMessage::RequestEnd);
        Ok(())
    }

    #[test]
    fn a_chunk_at_the_limit_round_trips() -> TestResult {
        let chunk = vec![7_u8; MAX_CHUNK_BYTES];
        assert_eq!(
            round_trip(&ProxyMessage::RequestBody(chunk.clone()))?,
            ProxyMessage::RequestBody(chunk)
        );
        Ok(())
    }

    #[test]
    fn an_oversized_chunk_is_refused_at_both_ends() {
        let too_big = vec![0_u8; MAX_CHUNK_BYTES + 1];
        let mut out = Vec::new();
        assert!(matches!(
            encode(&ProxyMessage::RequestBody(too_big.clone()), &mut out),
            Err(ProxyCodecError::TooLarge { .. })
        ));
        // And a peer cannot make us allocate one by declaring it.
        let mut declared = Vec::new();
        declared.extend_from_slice(MAGIC);
        declared.push(VERSION);
        declared.push(tag::REQUEST_BODY);
        declared.extend_from_slice(
            &u32::try_from(too_big.len())
                .unwrap_or(u32::MAX)
                .to_be_bytes(),
        );
        assert!(matches!(
            decode(&declared),
            Err(ProxyCodecError::TooLarge { .. })
        ));
    }

    #[test]
    fn truncation_is_reported_rather_than_panicking() -> TestResult {
        let mut full = Vec::new();
        encode(
            &ProxyMessage::RequestStart(RequestHead {
                id: 1,
                method: "GET".to_owned(),
                target: "/".to_owned(),
                headers: vec![("accept".to_owned(), "text/html".to_owned())],
                body: Vec::new(),
            }),
            &mut full,
        )?;
        for length in 0..full.len() {
            assert!(
                decode(&full[..length]).is_err(),
                "a {length}-byte prefix must not decode"
            );
        }
        Ok(())
    }

    #[test]
    fn bad_magic_and_version_are_refused() {
        assert_eq!(decode(b"XX\x01\x03"), Err(ProxyCodecError::BadMagic));
        assert_eq!(
            decode(b"PX\x09\x03"),
            Err(ProxyCodecError::Version {
                found: 9,
                expected: VERSION
            })
        );
        assert_eq!(
            decode(b"PX\x01\x7f"),
            Err(ProxyCodecError::UnknownType(0x7f))
        );
    }

    #[test]
    fn an_oversized_header_block_is_refused() {
        let headers: Vec<(String, String)> = (0..2000)
            .map(|index| (format!("x-header-{index}"), "v".repeat(64)))
            .collect();
        let mut out = Vec::new();
        assert!(matches!(
            encode(
                &ProxyMessage::RequestStart(RequestHead {
                    id: 1,
                    method: "GET".to_owned(),
                    target: "/".to_owned(),
                    headers,
                    body: Vec::new(),
                }),
                &mut out
            ),
            Err(ProxyCodecError::HeadersTooLarge(_))
        ));
    }

    #[test]
    fn every_codec_error_is_fatal_to_the_stream() {
        // Length-prefixed framing has no resynchronisation point: after a bad length
        // the next message boundary is unknown, so guessing would corrupt the stream.
        for error in [
            ProxyCodecError::BadMagic,
            ProxyCodecError::UnknownType(9),
            ProxyCodecError::Truncated { needed: 10, had: 2 },
            ProxyCodecError::NotUtf8,
        ] {
            assert!(error.is_fatal(), "{error:?}");
        }
    }

    #[test]
    fn chunks_are_never_larger_than_the_codec_accepts() -> TestResult {
        let body = vec![1_u8; MAX_CHUNK_BYTES * 2 + 5];
        let chunks = chunk_body(&body);
        assert_eq!(chunks.len(), 3);
        assert_eq!(
            chunks.iter().map(|chunk| chunk.len()).sum::<usize>(),
            body.len()
        );
        for chunk in chunks {
            let mut out = Vec::new();
            encode(&ProxyMessage::RequestBody(chunk.to_vec()), &mut out)?;
        }
        Ok(())
    }

    #[test]
    fn a_header_map_lowercases_names_and_keeps_the_last_value() {
        let map = header_map(&[
            ("Content-Type".to_owned(), "text/html".to_owned()),
            ("x-forwarded-for".to_owned(), "first".to_owned()),
            ("X-Forwarded-For".to_owned(), "second".to_owned()),
        ]);
        assert_eq!(
            map.get("content-type").map(String::as_str),
            Some("text/html")
        );
        assert_eq!(
            map.get("x-forwarded-for").map(String::as_str),
            Some("second")
        );
    }
}
