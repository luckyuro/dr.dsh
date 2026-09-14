//! The carrier connection to a relay, and the sealing layer above it.
//!
//! One WebSocket per daemon. The relay forwards frames between this connection and
//! the clients parked on the same room; everything this module sends is already
//! sealed, and everything it receives is opened here. That ordering is the whole
//! zero-knowledge property in one sentence: **sealing happens before the bytes
//! reach the relay.**
//!
//! ## Handshake
//!
//! 1. Connect, then announce: `{"role":"daemon","room":…,"proto":[0,1]}`.
//! 2. The relay answers `{"type":"ready"}` or `{"type":"reject","reason":…}`.
//! 3. **The client** picks a fresh salt and sends it as the first carrier frame on
//!    the control stream; the daemon opens it, derives the same session, and answers
//!    with a sealed acknowledgement. Only then is the session usable.
//!
//! Step 3 exists so that a connection's keys are not the previous connection's
//! keys — the root is long-lived, so deriving from it alone would make every
//! session share a key.
//!
//! **Why the client sends it, and not the daemon.** The daemon parks its room and
//! then waits, potentially for hours. A salt sent by the daemon would be forwarded
//! only to the clients parked at that instant, so every later client would wait
//! forever for a frame the relay had already dropped — a race that looks exactly
//! like a hung handshake. Whoever speaks second has a guaranteed listener, so the
//! client speaks second: it parks, then immediately offers its salt.
//!
//! The salt is not a secret. It is authenticated implicitly: a relay that
//! substituted its own would produce keys the peer does not share, and every frame
//! would fail to open.
//!
//! ## Why the acknowledgement exists
//!
//! Without it the client has no way to know when the daemon has *opened* the salt, and
//! a request sent too early is sealed under a session the daemon has not adopted yet.
//! The daemon reports that as an out-of-order frame — its counter still at zero — and
//! the failure names neither the race nor the client. One sealed byte after the salt
//! removes the race entirely: the client waits for the acknowledgement, which by
//! construction can only arrive once the daemon holds the same session.
//!
//! ## What this module refuses
//!
//! * A relay reply that is not `ready`, and a peer whose salt is the wrong size.
//! * A text frame on the data path: the carrier is binary, and a relay that starts
//!   sending text is not the relay we shook hands with.
//! * Any frame that does not open, or that arrives out of order. Both are reported
//!   rather than skipped, because skipping would silently drop part of a stream.

use dr_dsh_crypto::{Role, Session, connection_salt};
use dr_dsh_proto::device::{
    ACCEPT_TYPE, CHALLENGE_TYPE, DeviceAccepted, DeviceChallenge, DeviceRefused, DeviceResponse,
    REASON_BAD_PROOF, REASON_NOT_PAIRED, REASON_UNKNOWN_DEVICE, REFUSE_TYPE, RESPONSE_TYPE,
};
use dr_dsh_proto::{CONTROL_STREAM_ID, FRAME_HEADER_LEN, FrameHeader, FrameType, WIRE_VERSION};
use futures_util::{SinkExt as _, StreamExt as _};
use tokio_tungstenite::tungstenite::Message;

/// Length of a connection salt, in bytes.
const SALT_LEN: usize = 32;

/// The single byte a daemon sends once it holds the session the salt defines.
///
/// Its value is arbitrary; its *arrival* is the information. See the module docs for
/// why the handshake needs it.
const SESSION_ACK: &[u8] = b"k";

/// The salt both ends use for the single frame that carries the real salt.
///
/// It is a constant, and that is deliberate: this frame proves only that both ends
/// know the root key, which they must anyway. An attacker without the root key
/// cannot produce a frame that opens under it; an attacker with the root key has
/// already won, salt or no salt. The real salt takes over immediately afterwards,
/// so no content is ever sealed under this value.
const PROVISIONAL_SALT: [u8; SALT_LEN] = [0_u8; SALT_LEN];

/// Why a carrier connection failed or ended.
#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    /// The WebSocket could not be opened.
    #[error("cannot reach the relay at {url}: {source}")]
    Connect {
        /// The relay URL we tried.
        url: String,
        /// The underlying failure.
        source: Box<tokio_tungstenite::tungstenite::Error>,
    },
    /// The relay refused this daemon.
    #[error("the relay refused this daemon: {reason}")]
    Refused {
        /// The relay's fixed reason phrase.
        reason: String,
    },
    /// The relay answered the handshake with something unexpected.
    #[error("unexpected handshake reply from the relay: {0}")]
    Handshake(String),
    /// The connection failed at the transport level.
    #[error("carrier connection failed: {0}")]
    Transport(String),
    /// The session layer refused a frame.
    #[error("session error: {0}")]
    Session(#[from] dr_dsh_crypto::SessionError),
    /// A frame could not be encoded or decoded.
    #[error("protocol error: {0}")]
    Protocol(#[from] dr_dsh_proto::ProtoError),
    /// The relay sent something the carrier does not allow.
    #[error("the relay sent {0}, which the carrier does not allow")]
    ProtocolViolation(&'static str),
    /// The daemon refused this client because it is not an enrolled device, or its proof did
    /// not verify.
    #[error("the daemon refused this device: {reason}")]
    DeviceRefused {
        /// The daemon's machine-readable reason.
        reason: String,
    },
    /// The relay ended the session on purpose, naming its reason.
    #[error("the relay ended the session: {reason}")]
    SessionEnded {
        /// The relay's reason, forwarded rather than swallowed.
        reason: String,
    },
}

/// How a daemon decides which clients may open a session.
///
/// The two arms are not mixed: once a device is enrolled the room-key fallback is refused,
/// because "the room key still works" would make enrolment decorative. A daemon that has
/// never been paired has no device to challenge, so it falls back — which is the documented
/// path for a deployment that has not paired yet, not a convenience.
#[derive(Debug, Clone)]
pub enum DevicePolicy {
    /// Enrolment has not happened: the room key is the only credential.
    RoomKeyOnly,
    /// At least one device is enrolled: every client must prove it is one of them.
    ///
    /// The registry travels *inside* the policy rather than beside it, because a policy that
    /// says "require a device" while carrying no keys would have to either accept everyone or
    /// refuse everyone, and both are wrong in a way that only shows up under load. It is
    /// Shared rather than borrowed so a transport can outlive the value it was built from —
    /// a session that borrows its policy cannot be moved onto a task — and shared rather than
    /// owned so a reconnecting uplink can hand the same registry to the next connection
    /// without copying it or advancing a revision the old connection is still reading.
    Enrolled(std::sync::Arc<dr_dsh_crypto::DeviceRegistry>),
}

impl DevicePolicy {
    /// The policy that requires a proof, built from a registry.
    #[must_use]
    pub fn enrolled(registry: dr_dsh_crypto::DeviceRegistry) -> Self {
        Self::Enrolled(std::sync::Arc::new(registry))
    }

    /// Whether a client must prove it is an enrolled device.
    #[must_use]
    fn requires_proof(&self) -> bool {
        matches!(self, Self::Enrolled(_))
    }
}

/// How a client proves which device it is.
pub struct DeviceIdentity {
    /// The enrolled device's id, base64url.
    pub device_id: String,
    /// The room this connection is for; bound into the signature so a response captured on
    /// one room cannot be replayed against another.
    pub room: String,
    /// The device's long-lived identity key.
    pub key: dr_dsh_crypto::DeviceSecretKey,
}

/// A frame received from a client, already opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Inbound {
    /// Which stream the frame belongs to.
    pub stream_id: u32,
    /// The plaintext payload.
    pub payload: Vec<u8>,
}

/// A live carrier connection with an established session.
pub struct Transport {
    socket: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    session: Session,
    /// Kept so [`Transport::establish`] can re-derive once the salt is known.
    root: [u8; dr_dsh_crypto::SESSION_KEY_LEN],
    /// Which end of the session this transport is.
    role: Role,
    /// Whether the salt exchange has happened.
    established: bool,
    /// Whether a client has been authenticated as an enrolled device.
    device_bound: bool,
    /// Which device proved itself, when one did.
    ///
    /// Kept for the audit log (ADR-0012): "a tunnel was established" is much less useful than "this
    /// device established a tunnel", and the id is the registry's own identifier rather than anything
    /// the peer chose.
    bound_device: Option<String>,
    /// Which clients this end will accept. Always `RoomKeyOnly` on a client: the policy is
    /// the daemon's to enforce, and a client that could set it would be enforcing its own.
    policy: DevicePolicy,
    /// The device this end claims to be, when it is a client holding an identity.
    identity: Option<DeviceIdentity>,
    /// The room this connection is for, bound into a device signature so a response captured
    /// on one room cannot be replayed against another.
    room: String,
}

impl Transport {
    /// Dials the relay, parks the room, and establishes the session.
    ///
    /// # Errors
    ///
    /// Returns [`TransportError`] naming the stage that failed. A refusal comes
    /// back as [`TransportError::Refused`] with the relay's own reason phrase, so
    /// an operator sees "another daemon is serving this room" rather than a
    /// timeout.
    pub async fn dial(
        relay_url: &str,
        room: &str,
        root: &[u8; dr_dsh_crypto::SESSION_KEY_LEN],
    ) -> Result<Self, TransportError> {
        Self::park(relay_url, room, root, Role::Daemon).await
    }

    /// Dials as a daemon that requires every client to be an enrolled device.
    ///
    /// # Errors
    ///
    /// As [`Transport::dial`].
    pub async fn dial_with_policy(
        relay_url: &str,
        room: &str,
        root: &[u8; dr_dsh_crypto::SESSION_KEY_LEN],
        policy: DevicePolicy,
    ) -> Result<Self, TransportError> {
        let mut transport = Self::park(relay_url, room, root, Role::Daemon).await?;
        transport.policy = policy;
        Ok(transport)
    }

    /// Joins a room as a client, deriving the session from the daemon's salt.
    ///
    /// This exists so the sealing layer has exactly one implementation: the daemon
    /// and any client use the same code, so a divergence between the two ends would
    /// be a bug in one place rather than two.
    ///
    /// # Errors
    ///
    /// See [`Transport::dial`].
    pub async fn join(
        relay_url: &str,
        room: &str,
        root: &[u8; dr_dsh_crypto::SESSION_KEY_LEN],
    ) -> Result<Self, TransportError> {
        Self::join_as(relay_url, room, root, None).await
    }

    /// Joins as a client that will answer the daemon's device challenge.
    ///
    /// # Errors
    ///
    /// As [`Transport::join`].
    pub async fn join_as(
        relay_url: &str,
        room: &str,
        root: &[u8; dr_dsh_crypto::SESSION_KEY_LEN],
        identity: Option<DeviceIdentity>,
    ) -> Result<Self, TransportError> {
        let mut transport = Self::park_as_client(relay_url, room, root, identity).await?;
        transport.establish().await?;
        Ok(transport)
    }

    /// Parks as a client without establishing, so a caller can retry the parking race alone.
    ///
    /// Establishing is deliberately not part of this: it needs a live peer, and a caller that
    /// retried it would be retrying a handshake that may already have consumed frames. Parking
    /// is the only step that races the daemon's registration, and the only one worth retrying.
    ///
    /// # Errors
    ///
    /// As [`Transport::park`].
    pub async fn park_as_client(
        relay_url: &str,
        room: &str,
        root: &[u8; dr_dsh_crypto::SESSION_KEY_LEN],
        identity: Option<DeviceIdentity>,
    ) -> Result<Self, TransportError> {
        let mut transport = Self::park(relay_url, room, root, Role::Client).await?;
        transport.identity = identity;
        Ok(transport)
    }

    /// Parks a room and establishes the session in the given role.
    async fn park(
        relay_url: &str,
        room: &str,
        root: &[u8; dr_dsh_crypto::SESSION_KEY_LEN],
        role: Role,
    ) -> Result<Self, TransportError> {
        let url = parking_url(relay_url, role)?;
        let (mut socket, _response) =
            tokio_tungstenite::connect_async(&url)
                .await
                .map_err(|source| TransportError::Connect {
                    url: url.clone(),
                    source: Box::new(source),
                })?;

        let hello = serde_json::json!({
            "role": match role {
                Role::Daemon => "daemon",
                Role::Client => "client",
            },
            "room": room,
            "proto": [WIRE_VERSION.0, WIRE_VERSION.1],
        });
        socket
            .send(Message::Text(hello.to_string().into()))
            .await
            .map_err(|error| TransportError::Transport(error.to_string()))?;

        match socket.next().await {
            Some(Ok(Message::Text(reply))) => {
                let reply: serde_json::Value = serde_json::from_str(&reply)
                    .map_err(|_| TransportError::Handshake(reply.to_string()))?;
                match reply.get("type").and_then(serde_json::Value::as_str) {
                    Some("ready") => {}
                    Some("reject") => {
                        let reason = reply
                            .get("reason")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("no reason given")
                            .to_owned();
                        return Err(TransportError::Refused { reason });
                    }
                    _ => return Err(TransportError::Handshake(reply.to_string())),
                }
            }
            Some(Ok(other)) => return Err(TransportError::Handshake(format!("{other:?}"))),
            Some(Err(error)) => return Err(TransportError::Transport(error.to_string())),
            None => {
                return Err(TransportError::Transport(
                    "the relay closed during the handshake".to_owned(),
                ));
            }
        }

        // The connection's keys must not be the previous connection's keys, and the
        // root is long-lived (it is the pairing result), so every connection starts
        // with a fresh salt on the control stream. The salt is not a secret: a relay
        // that substituted its own would derive keys the peer does not share, and
        // every frame would fail to open.
        let provisional = Session::derive(root, &PROVISIONAL_SALT, role)?;
        Ok(Self {
            socket,
            session: provisional,
            root: *root,
            role,
            established: false,
            device_bound: false,
            bound_device: None,
            policy: DevicePolicy::RoomKeyOnly,
            identity: None,
            room: room.to_owned(),
        })
    }

    /// Completes the session by exchanging the connection salt.
    ///
    /// A daemon parks its room and then *waits*; it can therefore not send the salt
    /// itself, because a frame sent before a client has parked has nowhere to go and
    /// the relay rightly drops it. The client speaks second — it has a guaranteed
    /// listener — and offers the salt this method consumes.
    ///
    /// Separated from [`Transport::dial`] so that parking and establishing are two
    /// distinct facts: the room is advertised (and can accept a client) as soon as
    /// dialing returns, while the session begins when the client arrives. Collapsing
    /// them would make a daemon wait for a client before it could be reached, which
    /// is a deadlock for the first client that tries.
    ///
    /// # Errors
    ///
    /// Returns [`TransportError::Handshake`] when the peer does not offer a usable
    /// salt, and the session errors that [`Transport::next_inbound`] can raise.
    pub async fn establish(&mut self) -> Result<(), TransportError> {
        self.establish_with(None).await
    }

    /// [`Transport::establish`], pinging the relay while it waits for the client's salt.
    ///
    /// The wait for a client is the *longest* quiet period in the whole carrier's life: the room is
    /// parked and nothing at all crosses the socket until somebody opens the client. That is also
    /// exactly the period a deployment-detection warning names ("never carried a session"), so the
    /// daemon has to be able to keep that carrier warm on its own rather than only after a session
    /// exists.
    ///
    /// # Errors
    ///
    /// See [`Transport::establish`], plus the ping's own transport error.
    pub async fn establish_with(
        &mut self,
        ticker: Option<&mut tokio::time::Interval>,
    ) -> Result<(), TransportError> {
        if self.established {
            return Ok(());
        }
        match self.role {
            Role::Daemon => {
                // The salt frame is sealed under the provisional session on both
                // sides, so it can be read and opened before any real session
                // exists. Its payload is the salt *plus* the sealing overhead:
                // checking for exactly that keeps a well-formed request frame from
                // being mistaken for the salt, which would surface as a confusing
                // authentication error instead of a handshake failure.
                let (stream_id, sealed) = self.read_sealed_or_keepalive(ticker).await?;
                if stream_id != CONTROL_STREAM_ID
                    || sealed.len() != SALT_LEN + dr_dsh_crypto::SEALED_OVERHEAD
                {
                    return Err(TransportError::Handshake(
                        "the client did not open with a connection salt".to_owned(),
                    ));
                }
                let offered = Inbound {
                    stream_id,
                    payload: self.session.open(stream_id, &sealed)?,
                };
                if offered.stream_id != CONTROL_STREAM_ID || offered.payload.len() != SALT_LEN {
                    return Err(TransportError::Handshake(
                        "the client did not open with a connection salt".to_owned(),
                    ));
                }
                // The salt was opened with the provisional session, which advanced this
                // direction's receive counter. The session the salt defines starts at zero,
                // so that consumption has to be carried over: without it the daemon expects
                // the client's *next* frame at counter zero while the client is already at
                // one, and every request after the handshake dies as "out of order" — which
                // names neither the cause nor the client.
                let consumed = self.session.opened_count();
                self.session = Session::derive(&self.root, &offered.payload, self.role)?;
                self.session.set_opened_count(consumed);
                // Tell the client the session exists. Without this the client cannot
                // know when it is safe to speak, and its first request races the very
                // step that gives it a key to speak with.
                self.write_sealed(CONTROL_STREAM_ID, SESSION_ACK).await?;
            }
            Role::Client => {
                let salt = connection_salt();
                // Sealed under the *provisional* session, not the one the salt
                // defines: the daemon cannot hold keys derived from a salt it has not
                // received yet. Sealing with the new keys fails at the daemon as a
                // bare authentication error, with nothing to say which side derived
                // what — which is exactly how this was found.
                self.write_sealed(CONTROL_STREAM_ID, &salt).await?;
                // Carry the write across the derivation: the salt consumed counter zero of
                // the provisional session, so the client's next frame is counter one. A
                // fresh derivation would send it at zero and the daemon — which carries the
                // matching read — would refuse it as out of order.
                let written = self.session.sealed_count();
                self.session = Session::derive(&self.root, &salt, self.role)?;
                self.session.set_sealed_count(written);
                let acknowledgement = self.read_frame().await?;
                if acknowledgement.stream_id != CONTROL_STREAM_ID
                    || acknowledgement.payload != SESSION_ACK
                {
                    return Err(TransportError::Handshake(
                        "the daemon did not acknowledge the session".to_owned(),
                    ));
                }
            }
        }
        // Device authentication happens here, and not earlier: a proof is only meaningful
        // once the session that carries it is keyed, because the challenge must not be
        // readable — or replaceable — by the relay. It also happens before `established` is
        // set, so no caller can observe a usable-looking connection that never authenticated.
        self.bind_device().await?;
        self.established = true;
        Ok(())
    }

    /// Seals a payload and writes it as one carrier frame.
    ///
    /// # Errors
    ///
    /// Returns a [`TransportError`] when sealing fails or the connection is gone.
    pub async fn send(&mut self, stream_id: u32, plaintext: &[u8]) -> Result<(), TransportError> {
        self.require_established()?;
        self.write_sealed(stream_id, plaintext).await
    }

    /// Seals with the current session and writes the frame.
    ///
    /// The salt exchange uses this directly: its frame is sealed under the
    /// provisional session, so it necessarily precedes establishment.
    async fn write_sealed(
        &mut self,
        stream_id: u32,
        plaintext: &[u8],
    ) -> Result<(), TransportError> {
        let sealed = self.session.seal(stream_id, plaintext)?;
        let frame = encode_frame(stream_id, FrameType::Data, &sealed)?;
        self.socket
            .send(Message::Binary(frame.into()))
            .await
            .map_err(|error| TransportError::Transport(error.to_string()))
    }

    /// Reads the next content frame, opening it.
    ///
    /// Control frames (pings, the relay's own bookkeeping) are skipped; a text
    /// frame, a malformed carrier frame, or a frame that does not open ends the
    /// connection with an error, because none of those can be ignored without
    /// silently losing stream content.
    ///
    /// # Errors
    ///
    /// See [`TransportError`].
    pub async fn next_inbound(&mut self) -> Result<Inbound, TransportError> {
        self.require_established()?;
        self.read_frame().await
    }

    /// Reads the next content frame, pinging the relay whenever the carrier has been quiet
    /// for one keepalive interval.
    ///
    /// This exists because the carrier is a long-lived socket that is quiet for minutes at a
    /// time, and a reverse proxy in front of the relay is written for request/response: it
    /// closes a connection whose idle timer expires and reports nothing about why. A ping is
    /// bytes, so it resets that timer, and it is a *WebSocket* ping, so the relay's own
    /// WebSocket implementation answers it without any of our code running on the far side.
    ///
    /// The ticker is passed in rather than created here. A fresh interval per call would fire
    /// its first tick immediately and ping on every frame; and the interval has to outlive the
    /// connection so that a keepalive is not restarted — and therefore delayed — by every read.
    ///
    /// # Errors
    ///
    /// [`TransportError`] from the read, or from the ping when the socket is already gone.
    pub async fn next_inbound_or_keepalive(
        &mut self,
        ticker: Option<&mut tokio::time::Interval>,
    ) -> Result<Inbound, TransportError> {
        self.require_established()?;
        let Some(ticker) = ticker else {
            return self.read_frame().await;
        };
        loop {
            // The tick branch only records that it fired: the read future borrows `self`
            // mutably for as long as the `select!` lives, so a ping issued inside the branch
            // would be a second mutable borrow at the same moment.
            let ticked = tokio::select! {
                frame = self.read_frame() => return frame,
                _ = ticker.tick() => true,
            };
            if ticked {
                self.ping().await?;
            }
        }
    }

    /// Sends one WebSocket ping, with an empty payload.
    ///
    /// Empty on purpose: a ping's payload is echoed back by the peer and has to be a byte
    /// string, and the daemon has nothing to say with it — the *arrival* of bytes is the whole
    /// message.
    ///
    /// # Errors
    ///
    /// [`TransportError::Transport`] when the socket is gone, which is the first place a broken
    /// carrier shows itself.
    pub async fn ping(&mut self) -> Result<(), TransportError> {
        self.socket
            .send(Message::Ping(Vec::new().into()))
            .await
            .map_err(|error| TransportError::Transport(error.to_string()))
    }

    /// Reads the next still-sealed frame, pinging the relay while it waits.
    ///
    /// Cancelling the read is what makes the ping possible, and it is safe here for a reason worth
    /// stating: `socket.next()` buffers partial frames *inside* the WebSocket, so dropping the
    /// future loses nothing, and the only non-await step — handing a complete frame to
    /// `decode_frame` — cannot be interrupted by a tick.
    async fn read_sealed_or_keepalive(
        &mut self,
        ticker: Option<&mut tokio::time::Interval>,
    ) -> Result<(u32, Vec<u8>), TransportError> {
        let Some(ticker) = ticker else {
            return self.read_sealed().await;
        };
        loop {
            // The tick branch only records that it fired; see
            // [`Transport::next_inbound_or_keepalive`] for why the ping cannot be sent from inside it.
            let ticked = tokio::select! {
                frame = self.read_sealed() => return frame,
                _ = ticker.tick() => true,
            };
            if ticked {
                self.ping().await?;
            }
        }
    }

    /// Reads the next frame and returns its stream id and still-sealed payload.
    ///
    /// Used by the salt exchange, which must inspect a frame before deciding it is
    /// the salt — and therefore before opening it.
    async fn read_sealed(&mut self) -> Result<(u32, Vec<u8>), TransportError> {
        loop {
            let Some(message) = self.socket.next().await else {
                return Err(TransportError::Transport(
                    "the relay closed the connection".to_owned(),
                ));
            };
            match message.map_err(|error| TransportError::Transport(error.to_string()))? {
                Message::Binary(bytes) => return decode_frame(&bytes),
                Message::Ping(_) | Message::Pong(_) => continue,
                Message::Close(_) => {
                    return Err(TransportError::Transport(
                        "the relay closed the connection".to_owned(),
                    ));
                }
                // The relay is the only peer on this socket, and it writes text for
                // exactly one reason: to say why it is ending the session. Treating it as
                // a protocol violation would hide that reason inside a generic failure and
                // make a deliberate release indistinguishable from a carrier that broke.
                Message::Text(text) => {
                    return Err(TransportError::SessionEnded {
                        reason: text.to_string(),
                    });
                }
                Message::Frame(_) => return Err(TransportError::ProtocolViolation("a raw frame")),
            }
        }
    }

    /// Reads and opens the next content frame without the establishment guard.
    async fn read_frame(&mut self) -> Result<Inbound, TransportError> {
        loop {
            let Some(message) = self.socket.next().await else {
                return Err(TransportError::Transport(
                    "the relay closed the connection".to_owned(),
                ));
            };
            let message = message.map_err(|error| TransportError::Transport(error.to_string()))?;
            match message {
                Message::Binary(bytes) => {
                    let (stream_id, sealed) = decode_frame(&bytes)?;
                    let payload = self.session.open(stream_id, &sealed)?;
                    return Ok(Inbound { stream_id, payload });
                }
                Message::Ping(_) | Message::Pong(_) => continue,
                Message::Close(_) => {
                    return Err(TransportError::Transport(
                        "the relay closed the connection".to_owned(),
                    ));
                }
                // The relay is the only peer on this socket, and it writes text for
                // exactly one reason: to say why it is ending the session. Treating it as
                // a protocol violation would hide that reason inside a generic failure and
                // make a deliberate release indistinguishable from a carrier that broke.
                Message::Text(text) => {
                    return Err(TransportError::SessionEnded {
                        reason: text.to_string(),
                    });
                }
                Message::Frame(_) => return Err(TransportError::ProtocolViolation("a raw frame")),
            }
        }
    }

    /// Which device this session is bound to, when one proved itself.
    ///
    /// `None` on a daemon whose policy is `RoomKeyOnly` (nobody proved anything) and `None` on a client
    /// — a client knows its own identity, and the daemon's view is the one the audit log wants.
    #[must_use]
    pub fn bound_device(&self) -> Option<&str> {
        self.bound_device.as_deref()
    }

    /// Whether the salt exchange has completed.
    #[must_use]
    pub fn is_established(&self) -> bool {
        self.established
    }

    /// Whether a client has proven it is an enrolled device.
    ///
    /// A daemon negotiating with [`DevicePolicy::RoomKeyOnly`] is bound by definition: there
    /// is no device to prove, so refusing every client would make the fallback unusable.
    #[must_use]
    pub fn is_device_bound(&self) -> bool {
        !self.policy.requires_proof() || self.device_bound
    }

    /// Sets the identity this client will answer a challenge with.
    ///
    /// Separate from parking so a caller can retry the parking race and still supply the
    /// identity exactly once: an identity is moved, never cloned, because cloning a private
    /// key is how copies of it end up somewhere nobody is looking.
    pub fn set_identity(&mut self, identity: Option<DeviceIdentity>) {
        self.identity = identity;
    }

    /// Whether this end is a client that must answer a challenge.
    fn must_answer_challenge(&self) -> bool {
        self.role == Role::Client && self.identity.is_some()
    }

    /// Sends a sealed control message during the handshake.
    ///
    /// `write_sealed`, not `send`: this runs while `established` is still false, and `send`
    /// refuses to write before the session is declared usable. The guard is right for callers;
    /// the handshake is the one place that legitimately writes before it is set.
    async fn write_control(&mut self, message: &[u8]) -> Result<(), TransportError> {
        self.write_sealed(CONTROL_STREAM_ID, message).await
    }

    /// Reads one sealed control frame, refusing anything else.
    ///
    /// A payload on another stream during the handshake is not a message this end has agreed
    /// to accept yet, and answering it would let a peer reach the proxy plane before it has
    /// authenticated.
    async fn read_control(&mut self) -> Result<Vec<u8>, TransportError> {
        // `read_frame`, not `next_inbound`: this runs while `established` is still false, and
        // `next_inbound` refuses to read before the session exists. The guard is right for
        // callers; the handshake is the one place that legitimately reads before it is set.
        let inbound = self.read_frame().await?;
        if inbound.stream_id != CONTROL_STREAM_ID {
            return Err(TransportError::Handshake(format!(
                "a frame arrived on stream {} during the handshake",
                inbound.stream_id
            )));
        }
        Ok(inbound.payload)
    }

    /// Runs the device-authentication step, after the session exists.
    ///
    /// # Errors
    ///
    /// Returns [`TransportError::DeviceRefused`] when the client cannot prove it is an
    /// enrolled device.
    async fn bind_device(&mut self) -> Result<(), TransportError> {
        match self.role {
            Role::Daemon => self.challenge_client().await,
            Role::Client => self.answer_challenge().await,
        }
    }

    /// Asks the client to prove it is enrolled, and verifies the answer.
    async fn challenge_client(&mut self) -> Result<(), TransportError> {
        if !self.policy.requires_proof() {
            // Nothing is enrolled, so there is no key to check a proof against. Recording the
            // session as bound keeps `is_device_bound` total without pretending a proof
            // happened.
            self.device_bound = true;
            return Ok(());
        }
        let nonce = dr_dsh_crypto::ResumeNonce::generate();
        use base64::Engine as _;
        let challenge = DeviceChallenge {
            kind: CHALLENGE_TYPE.to_owned(),
            nonce: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(nonce.as_bytes()),
        };
        let encoded = serde_json::to_vec(&challenge)
            .map_err(|error| TransportError::Handshake(error.to_string()))?;
        self.write_control(&encoded).await?;

        let answer = self.read_control().await?;
        let Ok(response) = serde_json::from_slice::<DeviceResponse>(&answer) else {
            return Err(self
                .refuse_after(REASON_BAD_PROOF, "the client did not answer the challenge")
                .await);
        };
        if response.kind != RESPONSE_TYPE {
            return Err(self
                .refuse_after(REASON_BAD_PROOF, "the answer was not a response")
                .await);
        }

        let Ok(device_id) = dr_dsh_crypto::DeviceId::from_base64url(&response.device_id) else {
            return Err(self
                .refuse_after(REASON_UNKNOWN_DEVICE, "the device id is not usable")
                .await);
        };
        // Copied out of the registry rather than borrowed from it: a borrow held across the
        // reads below makes this future non-`Send`, and the uplink drives it from a task.
        let challenge_key = match &self.policy {
            DevicePolicy::Enrolled(registry) => registry.challenge_key(&device_id),
            DevicePolicy::RoomKeyOnly => None,
        };
        let Some(key) = challenge_key else {
            return Err(self
                .refuse_after(
                    REASON_NOT_PAIRED,
                    "the device is not enrolled on this daemon",
                )
                .await);
        };
        let Ok(signature) =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(&response.signature)
        else {
            return Err(self
                .refuse_after(REASON_BAD_PROOF, "the signature is not base64url")
                .await);
        };
        let message = dr_dsh_crypto::resume_message(&nonce, &self.room);
        if key.verify(&message, &signature).is_err() {
            return Err(self
                .refuse_after(REASON_BAD_PROOF, "the proof did not verify")
                .await);
        }

        self.device_bound = true;
        self.bound_device = Some(response.device_id.clone());
        let accepted = DeviceAccepted {
            kind: ACCEPT_TYPE.to_owned(),
        };
        let encoded = serde_json::to_vec(&accepted)
            .map_err(|error| TransportError::Handshake(error.to_string()))?;
        self.write_control(&encoded).await
    }

    /// Answers the daemon's challenge, or reports that this client has no identity.
    async fn answer_challenge(&mut self) -> Result<(), TransportError> {
        if !self.must_answer_challenge() {
            // A client with no identity cannot answer, so it must not silently continue: the
            // daemon will refuse it, and a client that pretended otherwise would hang waiting
            // for a first response that never comes.
            self.device_bound = true;
            return Ok(());
        }
        let (device_id, room, seed) = {
            let identity = self
                .identity
                .as_ref()
                .ok_or_else(|| TransportError::Handshake("no device identity".to_owned()))?;
            (
                identity.device_id.clone(),
                identity.room.clone(),
                identity.key.to_bytes(),
            )
        };
        let answer = self.read_control().await?;
        let challenge: DeviceChallenge = serde_json::from_slice(&answer).map_err(|_| {
            TransportError::Handshake("the daemon did not send a challenge".to_owned())
        })?;
        if challenge.kind != CHALLENGE_TYPE {
            return Err(TransportError::Handshake(
                "the daemon's first message was not a challenge".to_owned(),
            ));
        }
        use base64::Engine as _;
        let nonce_bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(&challenge.nonce)
            .map_err(|_| TransportError::Handshake("the nonce is not base64url".to_owned()))?;
        let nonce_bytes: [u8; dr_dsh_crypto::RESUME_NONCE_LEN] =
            nonce_bytes.try_into().map_err(|_| {
                TransportError::Handshake("the challenge nonce is the wrong length".to_owned())
            })?;
        let nonce = dr_dsh_crypto::ResumeNonce::from_bytes(nonce_bytes);
        let message = dr_dsh_crypto::resume_message(&nonce, &room);
        // Rebuilt from its seed so nothing borrows `self` across an await.
        let key = dr_dsh_crypto::DeviceSecretKey::from_bytes(seed)
            .map_err(|error| TransportError::Handshake(error.to_string()))?;
        let response = DeviceResponse {
            kind: RESPONSE_TYPE.to_owned(),
            device_id,
            signature: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key.sign(&message)),
        };
        let encoded = serde_json::to_vec(&response)
            .map_err(|error| TransportError::Handshake(error.to_string()))?;
        self.write_control(&encoded).await?;

        let reply = self.read_control().await?;
        let accepted: DeviceAccepted =
            serde_json::from_slice(&reply).map_err(|_| TransportError::DeviceRefused {
                reason: REASON_BAD_PROOF.to_owned(),
            })?;
        if accepted.kind != ACCEPT_TYPE {
            return Err(TransportError::DeviceRefused {
                reason: REASON_BAD_PROOF.to_owned(),
            });
        }
        self.device_bound = true;
        Ok(())
    }

    /// Tells a refused client why, closes the carrier, and returns the refusal.
    ///
    /// Both halves matter, and leaving either out is a hang rather than an error. The message
    /// is what lets a client show "you are not paired" instead of a generic timeout; closing
    /// is what makes the client's next read *return* — a peer that merely stops answering
    /// leaves the other side waiting for a frame that will never come. The write is
    /// best-effort because a peer that has already gone away still has to be refused: the
    /// refusal is the outcome, the message is a courtesy.
    async fn refuse_after(&mut self, reason: &str, detail: &str) -> TransportError {
        let refusal = DeviceRefused {
            kind: REFUSE_TYPE.to_owned(),
            reason: reason.to_owned(),
        };
        if let Ok(encoded) = serde_json::to_vec(&refusal) {
            let _ = self.write_control(&encoded).await;
        }
        let _ = self.socket.close(None).await;
        TransportError::DeviceRefused {
            reason: format!("{reason}: {detail}"),
        }
    }

    /// Refuses to move content before the session exists.
    fn require_established(&self) -> Result<(), TransportError> {
        if self.established {
            Ok(())
        } else {
            Err(TransportError::Handshake(
                "the session is not established yet; call establish() after parking".to_owned(),
            ))
        }
    }

    /// Closes the connection.
    ///
    /// # Errors
    ///
    /// Returns a [`TransportError`] when the close handshake cannot be sent.
    pub async fn close(mut self) -> Result<(), TransportError> {
        self.socket
            .close(None)
            .await
            .map_err(|error| TransportError::Transport(error.to_string()))
    }
}

impl core::fmt::Debug for Transport {
    /// Prints the session counters, never the keys.
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Transport")
            .field("session", &self.session)
            .finish_non_exhaustive()
    }
}

/// Builds the parking URL for a relay.
///
/// The room id is deliberately *not* part of this URL: it travels in the handshake
/// so it never lands in an access log. Accepts `ws://`, `wss://`, and an
/// `http(s)://` URL an operator pasted by habit, because the resulting error
/// otherwise reads as "cannot reach the relay" when the relay is plainly reachable.
///
/// # Errors
///
/// Returns [`TransportError::Handshake`] for a URL that is not a WebSocket origin.
pub fn parking_url(relay_url: &str, role: Role) -> Result<String, TransportError> {
    let trimmed = relay_url.trim_end_matches('/');
    let ws = if let Some(rest) = trimmed.strip_prefix("http://") {
        format!("ws://{rest}")
    } else if let Some(rest) = trimmed.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if trimmed.starts_with("ws://") || trimmed.starts_with("wss://") {
        trimmed.to_owned()
    } else {
        return Err(TransportError::Handshake(format!(
            "relay URL must start with ws:// or wss://, got {relay_url:?}"
        )));
    };
    if ws.contains('?') {
        return Err(TransportError::Handshake(
            "relay URL must not carry a query string; the room id travels in the handshake"
                .to_owned(),
        ));
    }
    Ok(match role {
        Role::Daemon => format!("{ws}/ws/daemon"),
        Role::Client => format!("{ws}/ws/client"),
    })
}

/// Encodes one carrier frame around `payload`.
fn encode_frame(
    stream_id: u32,
    frame_type: FrameType,
    payload: &[u8],
) -> Result<Vec<u8>, TransportError> {
    let header = FrameHeader {
        version: WIRE_VERSION,
        frame_type,
        flags: 0,
        stream_id,
        payload_len: u32::try_from(payload.len()).map_err(|_| {
            TransportError::ProtocolViolation("a payload that does not fit in a frame")
        })?,
    };
    let mut out = Vec::with_capacity(FRAME_HEADER_LEN + payload.len());
    dr_dsh_proto::frame::encode(
        &dr_dsh_proto::frame::Frame {
            header,
            payload: bytes::Bytes::copy_from_slice(payload),
        },
        &mut out,
    )?;
    Ok(out)
}

/// Decodes one carrier frame into its stream id and payload.
///
/// Rejects a frame the relay should never have forwarded: a non-`Data` type, or a
/// length that disagrees with the bytes received.
fn decode_frame(bytes: &[u8]) -> Result<(u32, Vec<u8>), TransportError> {
    let mut cursor = bytes;
    let frame = dr_dsh_proto::frame::decode(&mut cursor)?
        .ok_or(TransportError::ProtocolViolation("an incomplete frame"))?;
    if !cursor.is_empty() {
        return Err(TransportError::ProtocolViolation(
            "trailing bytes after a frame",
        ));
    }
    if frame.header.frame_type != FrameType::Data {
        return Err(TransportError::ProtocolViolation(
            "a non-data frame on the data path",
        ));
    }
    Ok((frame.header.stream_id, frame.payload.to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    #[test]
    fn a_relay_url_may_be_written_the_way_an_operator_would() -> TestResult {
        assert_eq!(
            parking_url("wss://relay.example", Role::Daemon)?,
            "wss://relay.example/ws/daemon"
        );
        assert_eq!(
            parking_url("ws://127.0.0.1:8787", Role::Daemon)?,
            "ws://127.0.0.1:8787/ws/daemon"
        );
        assert_eq!(
            parking_url("ws://127.0.0.1:8787/", Role::Daemon)?,
            "ws://127.0.0.1:8787/ws/daemon"
        );
        // A pasted http URL is a common mistake; translating it beats reporting
        // "cannot reach the relay" about a relay that is plainly reachable.
        assert_eq!(
            parking_url("https://relay.example", Role::Daemon)?,
            "wss://relay.example/ws/daemon"
        );
        assert_eq!(
            parking_url("http://127.0.0.1:8787", Role::Daemon)?,
            "ws://127.0.0.1:8787/ws/daemon"
        );
        Ok(())
    }

    #[test]
    fn a_relay_url_with_a_room_in_it_is_refused() {
        // The room travels in the handshake so it never lands in an access log.
        assert!(parking_url("wss://relay.example?room=abc", Role::Daemon).is_err());
        assert!(parking_url("relay.example", Role::Daemon).is_err());
        assert!(parking_url("", Role::Daemon).is_err());
    }

    #[test]
    fn a_frame_round_trips_through_the_codec() -> TestResult {
        let frame = encode_frame(9, FrameType::Data, b"sealed bytes")?;
        let (stream_id, payload) = decode_frame(&frame)?;
        assert_eq!(stream_id, 9);
        assert_eq!(payload, b"sealed bytes");
        Ok(())
    }

    #[test]
    fn a_non_data_frame_on_the_data_path_is_refused() -> TestResult {
        let frame = encode_frame(1, FrameType::Ping, b"")?;
        assert!(matches!(
            decode_frame(&frame),
            Err(TransportError::ProtocolViolation(_))
        ));
        Ok(())
    }

    #[test]
    fn a_truncated_or_padded_frame_is_refused() -> TestResult {
        let frame = encode_frame(1, FrameType::Data, b"x")?;
        assert!(matches!(
            decode_frame(&frame[..FRAME_HEADER_LEN]),
            Err(TransportError::ProtocolViolation(_))
        ));
        let mut padded = frame.clone();
        padded.push(0);
        assert!(matches!(
            decode_frame(&padded),
            Err(TransportError::ProtocolViolation(_))
        ));
        Ok(())
    }
}
