//! Room registry and frame routing.
//!
//! A **room** is the relay's unit of routing: at most one daemon and one active
//! client. A carrier has one encrypted session; enrolled devices can take turns
//! connecting without sharing that session. Everything the relay knows about a
//! room, it learns from the ids the two sides present — it never learns a user
//! name, a device name, or what the session is about.
//!
//! # Room ids are routing handles, not credentials
//!
//! A caller that knows a room id can knock, but it cannot enter: entering requires
//! completing the end-to-end handshake, which needs a pairing code or an enrolled
//! device key. Room ids are still generated with 128 bits of entropy so that
//! knowing one is not a way to enumerate other users, and a daemon rotates its id
//! when it re-registers.
//!
//! # Why routing is a table of channels
//!
//! The relay has exactly one job per frame: hand it to the other side of the room.
//! That is a lookup and a `send`, so the whole data path is one `Mutex`-guarded
//! table rather than an actor per connection. Frames are forwarded as raw bytes —
//! the relay never decodes a payload, and this module deliberately has no way to
//! ask what is inside one (ADR-0002).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use dr_dsh_proto::FrameType;
use tokio::sync::{mpsc, watch};

/// Why the relay releases a daemon it is no longer routing to.
///
/// Defined in the protocol crate because it is a wire contract: the relay writes this
/// exact string and the daemon matches on it. Re-exported so the relay's own code reads
/// naturally.
pub use dr_dsh_proto::SESSION_OVER;

/// Which side of a room a connection is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// The local daemon: one per room, and the side that owns the session.
    Daemon,
    /// The room's active remote client, independently authenticated by its daemon.
    Client,
}

/// One outbound frame queued for a connection.
///
/// Binary for carrier frames; text is used only by the handshake replies, so a
/// browser debugging the relay can read them.
#[derive(Debug, Clone)]
pub enum Outbound {
    /// A carrier frame, byte for byte as the sender wrote it.
    Frame(Vec<u8>),
}

/// A validated routing snapshot, delivered after releasing the hub lock.
pub struct Route {
    targets: Vec<(u64, mpsc::Sender<Outbound>)>,
    frame: Vec<u8>,
}

impl Route {
    /// Waits for bounded queue capacity without dropping or reordering a frame.
    ///
    /// # Errors
    /// Returns a fixed reason when a peer disappeared before accepting the frame.
    pub async fn deliver(&self) -> Result<usize, &'static str> {
        if self.targets.is_empty() {
            return Err("no peer is parked to receive this frame");
        }
        let count = self.targets.len();
        for (_, target) in &self.targets {
            target
                .send(Outbound::Frame(self.frame.clone()))
                .await
                .map_err(|_| "the destination disconnected while forwarding")?;
        }
        Ok(count)
    }
}

/// Queued frames and an independent cancellation signal for a parked socket.
pub struct Parked {
    /// Identity checked whenever this socket routes a frame.
    pub id: u64,
    /// Fixed-size forwarding queue.
    pub outbound: mpsc::Receiver<Outbound>,
    /// A named close, or channel closure when this registration is replaced.
    pub closing: watch::Receiver<Option<&'static str>>,
}

/// A connection parked in a room.
#[derive(Debug)]
struct Connection {
    id: u64,
    outbound: mpsc::Sender<Outbound>,
    closing: watch::Sender<Option<&'static str>>,
}

/// One parked room.
#[derive(Debug, Default)]
struct Room {
    daemon: Option<Connection>,
    clients: Vec<Connection>,
}

impl Room {
    /// The peer a frame from `role` should go to.
    ///
    /// A frame goes only to the room's one opposite peer. Accepting two clients
    /// would mix their independent salt exchanges into one encrypted session.
    fn targets(&self, from: Role) -> Vec<&Connection> {
        match from {
            Role::Daemon => self.clients.iter().collect(),
            Role::Client => self.daemon.iter().collect(),
        }
    }

    fn find(&mut self, role: Role, id: u64) -> Option<&mut Connection> {
        match role {
            Role::Daemon => self.daemon.as_mut().filter(|conn| conn.id == id),
            Role::Client => self.clients.iter_mut().find(|conn| conn.id == id),
        }
    }
}

/// Why a connection could not be parked.
#[derive(Debug, thiserror::Error)]
pub enum ParkError {
    /// The relay is holding as many rooms as it is configured to.
    #[error("relay is at capacity ({max} rooms)")]
    AtCapacity {
        /// The configured limit.
        max: usize,
    },
    /// Another client owns the active carrier session.
    #[error(
        "room is already in use; close the other dr.dsh tab or device connection, then reconnect"
    )]
    RoomInUse,
    /// No daemon is parked on this room, so there is nothing to route to.
    #[error("no daemon is parked on this room")]
    NoDaemon,
    /// A frame was sent from a connection that is no longer parked.
    #[error("connection is no longer parked")]
    Gone,
}

/// The routing table: rooms, their connections, and opaque frame forwarding.
#[derive(Debug)]
pub struct Hub {
    rooms: HashMap<String, Room>,
    next_id: u64,
    max_rooms: usize,
}

impl Hub {
    /// Creates an empty hub that will hold at most `max_rooms` rooms.
    #[must_use]
    pub fn new(max_rooms: usize) -> Self {
        Self {
            rooms: HashMap::new(),
            next_id: 1,
            max_rooms,
        }
    }

    /// Parks a connection and returns the id and the channel it will receive on.
    ///
    /// A client may only park on a room that already has a daemon. That rule is
    /// what makes "the client's first frame has somewhere to go" true, and it also
    /// spares a client from waiting on a room nobody is serving.
    ///
    /// # Errors
    ///
    /// Returns a [`ParkError`] naming the limit that was hit.
    pub fn park(&mut self, room_id: &str, role: Role) -> Result<Parked, ParkError> {
        if !self.rooms.contains_key(room_id) {
            if self.rooms.len() >= self.max_rooms {
                return Err(ParkError::AtCapacity {
                    max: self.max_rooms,
                });
            }
            // A client may only park where a daemon already is. Checking before
            // inserting is what keeps a refused client from creating an empty room
            // — and from consuming a capacity slot on the way to being refused.
            if role == Role::Client {
                return Err(ParkError::NoDaemon);
            }
            self.rooms.insert(room_id.to_owned(), Room::default());
        }
        let id = self.next_id;
        let (outbound, inbound) = mpsc::channel(FRAME_QUEUE);
        let (closing, closed) = watch::channel(None);
        let room = self.rooms.get_mut(room_id).ok_or(ParkError::Gone)?;
        match role {
            Role::Daemon => {
                // A daemon that re-registers replaces the connection it is replacing.
                // Refusing it instead leaves the superseded connection parked and still
                // first in line, so the next client's frames are routed into a session
                // whose owner has already moved on — and the client sees its own
                // handshake fail for reasons that belong to a connection it never had.
                // The old entry is dropped here, so nothing routes to it again; its
                // task stops when the channel that feeds it closes.
                if let Some(previous) = room.daemon.take() {
                    tracing::info!(
                        previous = previous.id,
                        replacement = id,
                        "a daemon re-registered; the superseded connection is no longer routed to"
                    );
                    drop(previous);
                }
                // A replacement daemon starts with fresh session keys and counters.
                // Existing clients cannot resume their old session on it. Removing
                // them here also preserves a departing pairing daemon's queued
                // receipt until a replacement actually arrives.
                for previous in room.clients.drain(..) {
                    previous.closing.send_replace(Some(SESSION_OVER));
                }
                room.daemon = Some(Connection {
                    id,
                    outbound,
                    closing,
                });
            }
            Role::Client => {
                if room.daemon.is_none() {
                    return Err(ParkError::NoDaemon);
                }
                if !room.clients.is_empty() {
                    return Err(ParkError::RoomInUse);
                }
                room.clients.push(Connection {
                    id,
                    outbound,
                    closing,
                });
            }
        }
        self.next_id += 1;
        Ok(Parked {
            id,
            outbound: inbound,
            closing: closed,
        })
    }

    /// Removes a connection and reports what its departure means for the room.
    ///
    /// The answer is what lets the ingress stop advertising a room the moment its
    /// daemon leaves, and release a daemon whose last client has gone.
    pub fn unpark(&mut self, room_id: &str, role: Role, id: u64) -> Departure {
        let mut daemon_left = Departure::Nothing;
        let Some(room) = self.rooms.get_mut(room_id) else {
            return daemon_left;
        };
        match role {
            Role::Daemon => {
                if room.daemon.as_ref().is_some_and(|conn| conn.id == id) {
                    room.daemon = None;
                    // The room itself stays for now: a daemon that reconnects while
                    // clients are still parked resumes serving them. In particular,
                    // short-lived pairing daemons leave after queueing a receipt;
                    // cancelling the clients here could discard that final reply.
                    daemon_left = Departure::DaemonStopped;
                }
            }
            Role::Client => {
                // A daemon replacement may already have removed this client.
                // Its late socket cleanup must not release the new carrier.
                if !room.clients.iter().any(|conn| conn.id == id) {
                    return Departure::Nothing;
                }
                room.clients.retain(|conn| conn.id != id);
                // A carrier carries one client session: both ends derive their keys from
                // a salt that the client offers when it joins. Leaving the daemon parked
                // with no client means the *next* client's salt arrives inside the
                // previous session, and the daemon — which is one frame further along —
                // rejects it as out of order. The relay therefore tells the daemon to
                // re-register, which gives the next client a connection with no history.
                if room.clients.is_empty() && room.daemon.is_some() {
                    daemon_left = Departure::LastClient;
                }
            }
        }
        // A room with no daemon and no clients is not worth remembering: freeing
        // the slot is what keeps the capacity limit meaningful over a long uptime.
        // The departure answer is captured above so this cleanup cannot hide it.
        if room.daemon.is_none() && room.clients.is_empty() {
            self.rooms.remove(room_id);
        }
        daemon_left
    }

    /// Stops routing to a room's daemon and closes its carrier.
    ///
    /// Called when the daemon's last client has left: the carrier has no session left to
    /// continue, so the daemon must re-register before another client can join. Dropping
    /// the connection closes the channel that feeds it, which is how the daemon's task
    /// learns to stop — a re-registered daemon arrives with no history, so the next
    /// client's salt is the first frame of a session rather than a stray frame inside
    /// the previous one.
    ///
    /// # Errors
    ///
    /// Returns [`ParkError::Gone`] when the room no longer exists.
    pub fn release_daemon(&mut self, room_id: &str) -> Result<(), ParkError> {
        let Some(room) = self.rooms.get_mut(room_id) else {
            return Err(ParkError::Gone);
        };
        // Cancellation has its own channel: a full data queue must not swallow
        // the release or delay it behind a peer that has stopped reading.
        if let Some(daemon) = room.daemon.as_ref() {
            daemon.closing.send_replace(Some(SESSION_OVER));
        }
        // Unregistered as well as told, so no frame can be routed to a session whose
        // client has gone. The independent close signal also interrupts an in-flight write.
        drop(room.daemon.take());
        if room.clients.is_empty() {
            self.rooms.remove(room_id);
        }
        Ok(())
    }

    /// Whether a daemon is currently parked on this room.
    #[must_use]
    pub fn is_served(&self, room_id: &str) -> bool {
        self.rooms
            .get(room_id)
            .is_some_and(|room| room.daemon.is_some())
    }

    /// Validates a sender and snapshots the destinations for one frame.
    ///
    /// Call [`Route::deliver`] only after releasing the hub lock. Waiting for a
    /// slow socket must backpressure its sender, never hold up unrelated rooms.
    ///
    /// # Errors
    ///
    /// Returns [`ParkError::Gone`] when the sender is no longer parked, which the
    /// ingress treats as "stop reading this connection".
    pub fn route(
        &mut self,
        room_id: &str,
        from: Role,
        id: u64,
        frame: Vec<u8>,
    ) -> Result<Route, ParkError> {
        let Some(room) = self.rooms.get_mut(room_id) else {
            return Err(ParkError::Gone);
        };
        // The sender must be the connection it says it is. One lookup, and it
        // closes the gap that would otherwise let a peer route on a connection
        // that is not its own.
        if room.find(from, id).is_none() {
            return Err(ParkError::Gone);
        }
        let targets = room
            .targets(from)
            .iter()
            .map(|conn| (conn.id, conn.outbound.clone()))
            .collect();
        Ok(Route { targets, frame })
    }

    /// Cancels this route's registrations after a forwarding failure.
    ///
    /// # Errors
    /// A stale sender cannot close a replacement session; replaced destinations
    /// and clients that joined after the snapshot are also left alone.
    pub fn close_route(
        &mut self,
        room_id: &str,
        from: Role,
        id: u64,
        route: &Route,
        reason: &'static str,
    ) -> Result<(), ParkError> {
        let room = self.rooms.get_mut(room_id).ok_or(ParkError::Gone)?;
        let source = room.find(from, id).ok_or(ParkError::Gone)?;
        source.closing.send_replace(Some(reason));
        for connection in room.targets(from) {
            if route
                .targets
                .iter()
                .any(|(target_id, _)| *target_id == connection.id)
            {
                connection.closing.send_replace(Some(reason));
            }
        }
        Ok(())
    }

    /// Number of rooms currently held.
    #[must_use]
    pub fn len(&self) -> usize {
        self.rooms.len()
    }

    /// Whether no rooms are held.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.rooms.is_empty()
    }

    /// Number of clients parked in a room.
    #[must_use]
    pub fn client_count(&self, room_id: &str) -> usize {
        self.rooms.get(room_id).map_or(0, |room| room.clients.len())
    }
}

/// What a departure means for the room it left.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Departure {
    /// The daemon connection ended; clients can no longer be served.
    DaemonStopped,
    /// The last client left, so the daemon's carrier has no session left to continue.
    /// It must re-register before another client can join.
    LastClient,
    /// The departure needs no action: another client is still being served, or the
    /// connection had already been replaced.
    Nothing,
}

/// Frames buffered per connection before its sender must wait for capacity.
///
/// The encrypted session counter cannot tolerate gaps. Waiting here carries
/// backpressure through the WebSocket/TCP connection without interpreting content.
const FRAME_QUEUE: usize = 64;

/// Validates one inbound carrier frame without interpreting its payload.
///
/// The relay checks exactly three things: the bytes start with a frame header, the
/// declared length is within the protocol cap, and the frame type is one it knows.
/// Everything else is forwarded verbatim, which is what "the relay understands
/// headers, not content" means in practice.
///
/// # Errors
///
/// Returns a static reason suitable for `GoAway`, and never echoes the payload.
pub fn validate_frame(bytes: &[u8]) -> Result<(), &'static str> {
    use dr_dsh_proto::{FRAME_HEADER_LEN, FRAME_MAGIC};

    if bytes.len() < FRAME_HEADER_LEN {
        return Err("frame is shorter than a header");
    }
    if bytes[0..2] != FRAME_MAGIC {
        return Err("bad frame magic");
    }
    let major = u16::from_be_bytes([bytes[2], bytes[3]]);
    if major != dr_dsh_proto::WIRE_MAJOR {
        return Err("incompatible wire major version");
    }
    let raw_type = u16::from_be_bytes([bytes[6], bytes[7]]);
    if FrameType::from_u16(raw_type).is_err() {
        return Err("unknown frame type");
    }
    let declared = u32::from_be_bytes([bytes[14], bytes[15], bytes[16], bytes[17]]);
    if declared > crate::config::MAX_FORWARDED_PAYLOAD {
        return Err("declared payload exceeds the protocol cap");
    }
    // The frame must actually be as long as it claims. Without this, a peer could
    // hand the relay a header that promises more than it sent, and the peer's
    // parser would be the only thing standing between that and a stuck stream.
    if bytes.len() != FRAME_HEADER_LEN + declared as usize {
        return Err("frame length does not match its header");
    }
    Ok(())
}

/// Shared hub handle.
pub type SharedHub = Arc<Mutex<Hub>>;

#[cfg(test)]
mod tests {
    use super::*;

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    /// Encodes a legal carrier frame around an opaque payload.
    ///
    /// Returns `Result` rather than unwrapping so a malformed test fixture fails
    /// the test with a message instead of a panic.
    fn frame(payload: &[u8]) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        let mut out = Vec::new();
        let header = dr_dsh_proto::FrameHeader {
            version: dr_dsh_proto::WIRE_VERSION,
            frame_type: FrameType::Data,
            flags: 0,
            stream_id: 1,
            payload_len: u32::try_from(payload.len())?,
        };
        dr_dsh_proto::frame::encode(
            &dr_dsh_proto::frame::Frame {
                header,
                payload: bytes::Bytes::copy_from_slice(payload),
            },
            &mut out,
        )?;
        Ok(out)
    }

    #[test]
    fn a_client_cannot_park_without_a_daemon() {
        let mut hub = Hub::new(4);
        assert!(matches!(
            hub.park("r1", Role::Client),
            Err(ParkError::NoDaemon)
        ));
        assert!(hub.is_empty(), "a refused client must not create a room");
    }

    #[test]
    fn releasing_a_daemon_names_the_reason_its_daemon_classifies() -> TestResult {
        // The release is a wire contract with the daemon: a bare close looks exactly like a
        // carrier that broke, and a daemon that cannot tell them apart answers a client's
        // departure with a backoff — during which the next client is refused. The string is
        // defined once in `dr-dsh-proto`, so both ends match on the same value.
        let mut hub = Hub::new(4);
        let Parked {
            id: daemon,
            closing,
            ..
        } = hub.park("r1", Role::Daemon)?;
        let Parked {
            id: client,
            outbound: _client_inbound,
            ..
        } = hub.park("r1", Role::Client)?;
        assert_eq!(
            hub.unpark("r1", Role::Client, client),
            Departure::LastClient
        );

        hub.release_daemon("r1")?;

        assert_eq!(
            *closing.borrow(),
            Some(dr_dsh_proto::SESSION_OVER),
            "the release reason is independent of the data queue"
        );
        assert!(
            !hub.is_served("r1"),
            "a released daemon must stop being a routing target"
        );
        let _ = daemon;
        Ok(())
    }

    #[tokio::test]
    async fn a_re_registered_daemon_supersedes_the_one_it_replaces() -> TestResult {
        let mut hub = Hub::new(4);
        let Parked {
            id: first,
            outbound: mut first_outbound,
            ..
        } = hub.park("r1", Role::Daemon)?;
        let Parked {
            id: second,
            outbound: _second_outbound,
            ..
        } = hub.park("r1", Role::Daemon)?;
        assert_ne!(
            first, second,
            "each registration must be its own connection"
        );

        // A client parking after the re-registration must be reachable by the daemon that
        // is registered now — the superseded connection is gone, not merely idle.
        let Parked {
            id: _client,
            outbound: _client_inbound,
            ..
        } = hub.park("r1", Role::Client)?;
        let routed = hub
            .route("r1", Role::Daemon, second, vec![1, 2, 3])?
            .deliver()
            .await?;
        assert_eq!(routed, 1, "the registered daemon reaches the client");

        // The superseded connection's channel closes, which is how its task learns to
        // stop serving. Nothing routes to it again, so a client can no longer be paired
        // with a session its owner has abandoned.
        assert!(
            first_outbound.try_recv().is_err(),
            "the superseded connection must be closed, not left parked"
        );
        Ok(())
    }

    #[test]
    fn capacity_counts_rooms_not_connections() -> TestResult {
        let mut hub = Hub::new(1);
        hub.park("r1", Role::Daemon)?;
        hub.park("r1", Role::Client)?;
        assert!(matches!(
            hub.park("r2", Role::Daemon),
            Err(ParkError::AtCapacity { max: 1 })
        ));
        assert_eq!(hub.len(), 1);
        Ok(())
    }

    #[test]
    fn a_second_client_is_refused_before_it_can_share_the_session() -> TestResult {
        let mut hub = Hub::new(1);
        hub.park("r1", Role::Daemon)?;
        let first = hub.park("r1", Role::Client)?;
        assert!(matches!(
            hub.park("r1", Role::Client),
            Err(ParkError::RoomInUse)
        ));
        assert_eq!(hub.client_count("r1"), 1);
        assert_eq!(*first.closing.borrow(), None);
        Ok(())
    }

    #[tokio::test]
    async fn a_daemon_frame_reaches_only_the_active_client() -> TestResult {
        let mut hub = Hub::new(4);
        let Parked {
            id: daemon_id,
            outbound: _daemon_rx,
            ..
        } = hub.park("r1", Role::Daemon)?;
        let Parked {
            id: _,
            outbound: mut client_a,
            ..
        } = hub.park("r1", Role::Client)?;
        assert!(matches!(
            hub.park("r1", Role::Client),
            Err(ParkError::RoomInUse)
        ));

        let bytes = frame(b"ciphertext")?;
        assert_eq!(
            hub.route("r1", Role::Daemon, daemon_id, bytes.clone())?
                .deliver()
                .await?,
            1
        );

        match client_a.try_recv() {
            Ok(Outbound::Frame(received)) => assert_eq!(received, bytes),
            other => return Err(format!("expected a forwarded frame, got {other:?}").into()),
        }
        Ok(())
    }

    #[tokio::test]
    async fn a_client_frame_reaches_the_daemon() -> TestResult {
        let mut hub = Hub::new(4);
        let Parked {
            id: _daemon_id,
            outbound: mut daemon_rx,
            ..
        } = hub.park("r1", Role::Daemon)?;
        let Parked {
            id: client_id,
            outbound: _client_rx,
            ..
        } = hub.park("r1", Role::Client)?;

        let bytes = frame(b"request")?;
        assert_eq!(
            hub.route("r1", Role::Client, client_id, bytes.clone())?
                .deliver()
                .await?,
            1
        );
        match daemon_rx.try_recv() {
            Ok(Outbound::Frame(received)) => assert_eq!(received, bytes),
            other => return Err(format!("expected a forwarded frame, got {other:?}").into()),
        }
        Ok(())
    }

    #[tokio::test]
    async fn a_full_queue_waits_then_delivers_every_frame_in_order() -> TestResult {
        let mut hub = Hub::new(4);
        let daemon = hub.park("slow", Role::Daemon)?;
        let mut client = hub.park("slow", Role::Client)?;
        for index in 0..FRAME_QUEUE {
            hub.route("slow", Role::Daemon, daemon.id, vec![u8::try_from(index)?])?
                .deliver()
                .await?;
        }
        let route = hub.route("slow", Role::Daemon, daemon.id, vec![64])?;
        let pending = route.deliver();
        tokio::pin!(pending);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), &mut pending)
                .await
                .is_err()
        );
        // A routing snapshot does not retain a hub borrow while it waits.
        let other = hub.park("other", Role::Daemon)?;
        let mut receiver = hub.park("other", Role::Client)?;
        hub.route("other", Role::Daemon, other.id, vec![7])?
            .deliver()
            .await?;
        assert!(receiver.outbound.try_recv().is_ok());
        let Some(Outbound::Frame(first)) = client.outbound.recv().await else {
            return Err("the full queue lost its first frame".into());
        };
        assert_eq!(first, vec![0]);
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(1), pending).await??,
            1
        );
        for index in 1..=FRAME_QUEUE {
            let Some(Outbound::Frame(bytes)) = client.outbound.recv().await else {
                return Err("the queue lost a frame after resuming".into());
            };
            assert_eq!(bytes, vec![u8::try_from(index)?]);
        }
        Ok(())
    }

    #[tokio::test]
    async fn release_interrupts_a_full_queue_and_an_outstanding_routing_snapshot() -> TestResult {
        let mut hub = Hub::new(4);
        let daemon = hub.park("r1", Role::Daemon)?;
        let client = hub.park("r1", Role::Client)?;
        for _ in 0..FRAME_QUEUE {
            hub.route("r1", Role::Client, client.id, vec![1])?
                .deliver()
                .await?;
        }
        let route = hub.route("r1", Role::Client, client.id, vec![2])?;
        let pending = route.deliver();
        tokio::pin!(pending);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), &mut pending)
                .await
                .is_err()
        );
        hub.release_daemon("r1")?;
        assert_eq!(*daemon.closing.borrow(), Some(SESSION_OVER));
        // The writer cancels on this signal and drops its receiver, even though
        // the blocked route still holds a sender for the old registration.
        drop(daemon.outbound);
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), pending)
                .await?
                .is_err()
        );
        Ok(())
    }

    #[tokio::test]
    async fn a_failed_old_route_cannot_close_a_replacement_or_new_client() -> TestResult {
        let mut hub = Hub::new(4);
        let old = hub.park("r1", Role::Daemon)?;
        let client = hub.park("r1", Role::Client)?;
        for _ in 0..FRAME_QUEUE {
            hub.route("r1", Role::Client, client.id, vec![1])?
                .deliver()
                .await?;
        }
        let route = hub.route("r1", Role::Client, client.id, vec![2])?;
        let pending = route.deliver();
        tokio::pin!(pending);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), &mut pending)
                .await
                .is_err()
        );
        let replacement = hub.park("r1", Role::Daemon)?;
        let newcomer = hub.park("r1", Role::Client)?;
        assert!(
            old.closing.has_changed().is_err(),
            "replacement must cancel the old writer immediately"
        );
        drop(old.outbound);
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), pending)
                .await?
                .is_err()
        );
        assert!(matches!(
            hub.close_route(
                "r1",
                Role::Client,
                client.id,
                &route,
                "old destination disconnected",
            ),
            Err(ParkError::Gone)
        ));
        assert_eq!(*client.closing.borrow(), Some(SESSION_OVER));
        assert_eq!(*replacement.closing.borrow(), None);
        assert_eq!(*newcomer.closing.borrow(), None);
        hub.unpark("r1", Role::Daemon, old.id);
        assert_eq!(
            hub.unpark("r1", Role::Client, client.id),
            Departure::Nothing
        );
        assert!(hub.is_served("r1"));
        assert_eq!(*replacement.closing.borrow(), None);
        assert_eq!(*newcomer.closing.borrow(), None);
        Ok(())
    }

    #[test]
    fn a_late_old_client_cannot_release_the_replacement_daemon() -> TestResult {
        let mut hub = Hub::new(1);
        hub.park("r1", Role::Daemon)?;
        let old_client = hub.park("r1", Role::Client)?;
        let replacement = hub.park("r1", Role::Daemon)?;
        assert_eq!(*old_client.closing.borrow(), Some(SESSION_OVER));
        assert_eq!(hub.client_count("r1"), 0);
        assert_eq!(
            hub.unpark("r1", Role::Client, old_client.id),
            Departure::Nothing
        );
        assert!(hub.is_served("r1"));
        assert_eq!(*replacement.closing.borrow(), None);
        hub.park("r1", Role::Client)?;
        Ok(())
    }

    #[test]
    fn a_departing_daemon_is_reported_once() -> TestResult {
        let mut hub = Hub::new(4);
        let Parked {
            id: daemon_id,
            outbound: _rx,
            ..
        } = hub.park("r1", Role::Daemon)?;
        hub.park("r1", Role::Client)?;
        assert_eq!(
            hub.unpark("r1", Role::Daemon, daemon_id),
            Departure::DaemonStopped
        );
        assert!(!hub.is_served("r1"), "the room must stop being advertised");
        // Pending replies remain deliverable after the daemon leaves. A new
        // daemon registration will close this client's obsolete session.
        assert_eq!(hub.client_count("r1"), 1);
        assert_eq!(
            hub.unpark("r1", Role::Daemon, daemon_id),
            Departure::Nothing
        );
        Ok(())
    }

    #[tokio::test]
    async fn a_departing_daemon_keeps_its_queued_pairing_receipt_deliverable() -> TestResult {
        let mut hub = Hub::new(1);
        let daemon = hub.park("pairing", Role::Daemon)?;
        let mut client = hub.park("pairing", Role::Client)?;
        let receipt = frame(b"opaque-pairing-receipt")?;
        hub.route("pairing", Role::Daemon, daemon.id, receipt.clone())?
            .deliver()
            .await?;
        assert_eq!(
            hub.unpark("pairing", Role::Daemon, daemon.id),
            Departure::DaemonStopped
        );
        assert_eq!(*client.closing.borrow(), None);
        let Some(Outbound::Frame(received)) = client.outbound.recv().await else {
            return Err("the queued pairing receipt was discarded".into());
        };
        assert_eq!(received, receipt);
        hub.unpark("pairing", Role::Client, client.id);
        assert!(hub.is_empty());
        Ok(())
    }

    #[test]
    fn an_empty_room_is_forgotten() -> TestResult {
        let mut hub = Hub::new(1);
        let Parked {
            id: daemon_id,
            outbound: _rx,
            ..
        } = hub.park("r1", Role::Daemon)?;
        hub.unpark("r1", Role::Daemon, daemon_id);
        assert!(
            hub.is_empty(),
            "an abandoned room must free its capacity slot"
        );
        Ok(())
    }

    #[test]
    fn routing_from_an_unparked_connection_is_refused() -> TestResult {
        let mut hub = Hub::new(4);
        hub.park("r1", Role::Daemon)?;
        let bytes = frame(b"x")?;
        assert!(matches!(
            hub.route("r1", Role::Client, 99, bytes),
            Err(ParkError::Gone)
        ));
        Ok(())
    }

    #[test]
    fn frame_validation_accepts_a_well_formed_frame() -> TestResult {
        let bytes = frame(b"anything at all")?;
        validate_frame(&bytes).map_err(Into::into)
    }

    #[test]
    fn frame_validation_refuses_malformed_input() -> TestResult {
        // Each of these is a way a peer could try to make the relay do something
        // other than forward bytes.
        assert!(validate_frame(b"short").is_err());
        assert!(validate_frame(&[0x58, 0x58, 0, 0, 0, 1]).is_err());

        let mut truncated = frame(b"payload")?;
        truncated.truncate(truncated.len() - 1);
        assert_eq!(
            validate_frame(&truncated),
            Err("frame length does not match its header")
        );

        let mut lying = frame(b"payload")?;
        lying[17] = 0xff;
        assert_eq!(
            validate_frame(&lying),
            Err("frame length does not match its header")
        );

        let mut oversized = frame(b"payload")?;
        oversized[14..18]
            .copy_from_slice(&(crate::config::MAX_FORWARDED_PAYLOAD + 1).to_be_bytes());
        assert_eq!(
            validate_frame(&oversized),
            Err("declared payload exceeds the protocol cap")
        );

        let mut unknown = frame(b"payload")?;
        unknown[6..8].copy_from_slice(&0x0009_u16.to_be_bytes());
        assert_eq!(validate_frame(&unknown), Err("unknown frame type"));

        let mut wrong_version = frame(b"payload")?;
        wrong_version[2..4].copy_from_slice(&1_u16.to_be_bytes());
        assert_eq!(
            validate_frame(&wrong_version),
            Err("incompatible wire major version")
        );
        Ok(())
    }
}
