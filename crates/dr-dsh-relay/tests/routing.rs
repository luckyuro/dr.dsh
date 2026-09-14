//! End-to-end routing over real WebSockets.
//!
//! The relay's unit tests drive the hub directly. This file drives the *sockets*,
//! which is where the interesting failures live: a handshake that is accepted but
//! never answered, a frame that arrives with its bytes rearranged, a room that is
//! advertised after its daemon left. None of those are visible from the hub.
//!
//! Every test also asserts the property the relay exists to preserve: **a payload
//! arrives byte for byte, and the relay never needs to understand it.** The test
//! payloads are deliberately not valid protocol messages, so a relay that tried to
//! interpret them would fail here.

use std::net::SocketAddr;
use std::time::Duration;

use dr_dsh_proto::{FrameHeader, FrameType, WIRE_VERSION};
use futures_util::{SinkExt as _, StreamExt as _};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;

use dr_dsh_relay::ingress::Ingress;

/// Starts the relay on an OS-assigned port and returns its address.
async fn start_relay(max_rooms: usize) -> Result<SocketAddr, Box<dyn std::error::Error>> {
    start_relay_with_keepalive(max_rooms, Some(Duration::from_secs(30))).await
}

/// Starts the relay with an explicit keepalive interval, so a test can watch one arrive.
async fn start_relay_with_keepalive(
    max_rooms: usize,
    keepalive: Option<Duration>,
) -> Result<SocketAddr, Box<dyn std::error::Error>> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let router = Ingress::with_keepalive(
        max_rooms,
        dr_dsh_relay::assets::Assets::new(None),
        keepalive,
    )
    .router();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Ok(addr)
}

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;

/// Opens one endpoint and completes the handshake.
async fn park(
    addr: SocketAddr,
    path: &str,
    role: &str,
    room: &str,
) -> Result<(Socket, String), Box<dyn std::error::Error>> {
    let url = format!("ws://{addr}{path}");
    let (mut socket, _) = tokio_tungstenite::connect_async(url).await?;
    socket
        .send(Message::Text(
            serde_json::json!({ "role": role, "room": room, "proto": [0, 1] })
                .to_string()
                .into(),
        ))
        .await?;
    let reply = next_text(&mut socket).await?;
    Ok((socket, reply))
}

/// Reads the next text message, skipping binary ones.
async fn next_text(socket: &mut Socket) -> Result<String, Box<dyn std::error::Error>> {
    while let Some(message) = tokio::time::timeout(Duration::from_secs(5), socket.next()).await? {
        match message? {
            Message::Text(text) => return Ok(text.to_string()),
            Message::Close(frame) => return Err(format!("closed: {frame:?}").into()),
            _ => continue,
        }
    }
    Err("socket ended before a text reply".into())
}

/// Reads the next binary frame, skipping text ones.
async fn next_binary(socket: &mut Socket) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    while let Some(message) = tokio::time::timeout(Duration::from_secs(5), socket.next()).await? {
        match message? {
            Message::Binary(bytes) => return Ok(bytes.to_vec()),
            Message::Close(frame) => return Err(format!("closed: {frame:?}").into()),
            _ => continue,
        }
    }
    Err("socket ended before a binary frame".into())
}

/// Encodes an opaque payload as a legal carrier frame.
///
/// The payload is arbitrary bytes: the relay must forward them without knowing or
/// caring what they are.
fn carrier(payload: &[u8], stream_id: u32) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let frame = dr_dsh_proto::frame::Frame {
        header: FrameHeader {
            version: WIRE_VERSION,
            frame_type: FrameType::Data,
            flags: 0,
            stream_id,
            payload_len: u32::try_from(payload.len())?,
        },
        payload: bytes::Bytes::copy_from_slice(payload),
    };
    let mut out = Vec::new();
    dr_dsh_proto::frame::encode(&frame, &mut out)?;
    Ok(out)
}

const ROOM: &str = "room-abc123";

#[tokio::test]
async fn a_frame_travels_from_client_to_daemon_unchanged() -> Result<(), Box<dyn std::error::Error>>
{
    let addr = start_relay(8).await?;
    let (mut daemon, daemon_reply) = park(addr, "/ws/daemon", "daemon", ROOM).await?;
    let (mut client, client_reply) = park(addr, "/ws/client", "client", ROOM).await?;
    assert!(daemon_reply.contains("ready"), "{daemon_reply}");
    assert!(client_reply.contains("ready"), "{client_reply}");

    let payload = b"\x00\x01not-a-real-message\xff\xfe";
    let frame = carrier(payload, 7)?;
    client.send(Message::Binary(frame.clone().into())).await?;

    let received = next_binary(&mut daemon).await?;
    assert_eq!(received, frame, "the relay must forward bytes unchanged");
    Ok(())
}

#[tokio::test]
async fn a_daemon_frame_reaches_every_client() -> Result<(), Box<dyn std::error::Error>> {
    let addr = start_relay(8).await?;
    let (mut daemon, _) = park(addr, "/ws/daemon", "daemon", ROOM).await?;
    let (mut first, _) = park(addr, "/ws/client", "client", ROOM).await?;
    let (mut second, _) = park(addr, "/ws/client", "client", ROOM).await?;

    let frame = carrier(b"broadcast", 1)?;
    daemon.send(Message::Binary(frame.clone().into())).await?;

    assert_eq!(next_binary(&mut first).await?, frame);
    assert_eq!(next_binary(&mut second).await?, frame);
    Ok(())
}

#[tokio::test]
async fn a_client_is_refused_when_no_daemon_serves_the_room()
-> Result<(), Box<dyn std::error::Error>> {
    let addr = start_relay(8).await?;
    let (_client, reply) = park(addr, "/ws/client", "client", "empty-room").await?;
    assert!(reply.contains("reject"), "{reply}");
    assert!(reply.contains("no daemon"), "{reply}");
    Ok(())
}

#[tokio::test]
async fn the_endpoint_decides_the_role_not_the_peer() -> Result<(), Box<dyn std::error::Error>> {
    // A peer that connects to the daemon endpoint while claiming to be a client
    // must be refused: otherwise it could displace a room's real daemon.
    let addr = start_relay(8).await?;
    let (mut impostor, reply) = park(addr, "/ws/daemon", "client", ROOM).await?;
    assert!(reply.contains("reject"), "{reply}");

    // And the room is still free for the real daemon.
    let (_daemon, daemon_reply) = park(addr, "/ws/daemon", "daemon", ROOM).await?;
    assert!(daemon_reply.contains("ready"), "{daemon_reply}");
    let _ = impostor.close(None).await;
    Ok(())
}

#[tokio::test]
async fn a_daemon_that_re_registers_takes_over_the_room() -> Result<(), Box<dyn std::error::Error>>
{
    // A daemon that reconnects after its socket dropped is the same daemon, and it must
    // end up serving the room. Refusing it leaves the previous connection parked, and the
    // next client is handed a session whose owner has already left.
    let addr = start_relay(8).await?;
    let (mut first, first_reply) = park(addr, "/ws/daemon", "daemon", ROOM).await?;
    assert!(first_reply.contains("ready"), "{first_reply}");

    let (mut second, second_reply) = park(addr, "/ws/daemon", "daemon", ROOM).await?;
    assert!(second_reply.contains("ready"), "{second_reply}");

    // A client arriving now reaches the daemon that registered last.
    let (mut client, client_reply) = park(addr, "/ws/client", "client", ROOM).await?;
    assert!(client_reply.contains("ready"), "{client_reply}");
    let frame = carrier(b"request", 1)?;
    client.send(Message::Binary(frame.clone().into())).await?;
    assert_eq!(next_binary(&mut second).await?, frame);

    // And the superseded connection is closed rather than left silently parked.
    let closed = tokio::time::timeout(Duration::from_secs(5), first.next())
        .await
        .map_err(|_| "the superseded daemon was never disconnected")?;
    match closed {
        None | Some(Ok(Message::Close(_))) => {}
        Some(Ok(other)) => return Err(format!("expected a close, got {other:?}").into()),
        Some(Err(error)) => return Err(error.into()),
    }
    Ok(())
}

#[tokio::test]
async fn the_relay_refuses_a_malformed_frame_instead_of_forwarding_it()
-> Result<(), Box<dyn std::error::Error>> {
    let addr = start_relay(8).await?;
    let (mut daemon, _) = park(addr, "/ws/daemon", "daemon", ROOM).await?;
    let (mut client, _) = park(addr, "/ws/client", "client", ROOM).await?;

    // A well-formed frame does reach the daemon, so "nothing arrived" below means the
    // malformed frame was refused rather than the connection having been broken already.
    let good = carrier(b"good", 1)?;
    client.send(Message::Binary(good.clone().into())).await?;
    assert_eq!(next_binary(&mut daemon).await?, good);

    // A header that promises more bytes than it carries. Forwarding this would put
    // the peer's parser on the critical path; refusing it keeps the relay the only
    // component that has to be right about framing.
    let mut lying = carrier(b"short", 1)?;
    lying[14..18].copy_from_slice(&999_u32.to_be_bytes());
    client.send(Message::Binary(lying.into())).await?;

    // The client is disconnected rather than answered: the data path is binary and
    // a protocol error is not worth a round trip. The relay may close the socket
    // with a close frame or drop it outright, so both outcomes count as "ended",
    // and a transport error carrying `ResetWithoutClosingHandshake` is the drop.
    let mut ended = false;
    loop {
        match tokio::time::timeout(Duration::from_secs(5), client.next()).await {
            Err(_) => break,
            Ok(None) => {
                ended = true;
                break;
            }
            Ok(Some(Ok(Message::Close(_)))) => {
                ended = true;
                break;
            }
            Ok(Some(Err(_))) => {
                ended = true;
                break;
            }
            Ok(Some(Ok(_))) => continue,
        }
    }
    assert!(ended, "the offending connection must be closed");

    // The malformed frame reached nobody: no carrier frame arrived after the good one.
    // The daemon is released as well — with its client gone its carrier has no session
    // left — and it is told why before its channel closes, so what arrives here is the
    // relay's named close rather than a forwarded frame.
    //
    // Only *data* frames count as a leak. A `Ping` here is the relay's own keepalive on the
    // carrier socket — a WebSocket control frame the relay originates, never a payload someone
    // sent — so it is skipped. This assertion is what caught the keepalive's first tick firing
    // immediately instead of one interval out (see `Ingress::with_keepalive`).
    loop {
        match tokio::time::timeout(Duration::from_millis(500), daemon.next()).await {
            Err(_) => {
                return Err("the released daemon was neither answered nor disconnected".into());
            }
            Ok(None) | Ok(Some(Ok(Message::Close(_)))) | Ok(Some(Err(_))) => break,
            Ok(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => continue,
            Ok(Some(Ok(Message::Text(text)))) => {
                let reason = text.to_string();
                assert!(
                    reason.contains("session over"),
                    "an unexpected close reason: {reason}"
                );
                break;
            }
            Ok(Some(Ok(other))) => {
                return Err(format!("a malformed frame reached the daemon as {other:?}").into());
            }
        }
    }

    // And a fresh client can park again, so the room is served by the daemon that
    // re-registers rather than left waiting on one that has gone.
    let (daemon, reply) = park(addr, "/ws/daemon", "daemon", ROOM).await?;
    assert!(reply.contains("ready"), "{reply}");
    let (_client, reply) = park(addr, "/ws/client", "client", ROOM).await?;
    assert!(reply.contains("ready"), "{reply}");
    drop(daemon);
    Ok(())
}

/// A parked carrier is quiet for minutes at a time, and a reverse proxy closes a quiet socket on a
/// schedule. The keepalive is what resets that timer, so two things have to hold and neither is
/// visible from the hub: a ping arrives *after* one interval, and it does not arrive before it.
#[tokio::test]
async fn a_quiet_carrier_is_pinged_but_not_the_moment_it_parks()
-> Result<(), Box<dyn std::error::Error>> {
    let every = Duration::from_millis(300);
    let addr = start_relay_with_keepalive(8, Some(every)).await?;
    let (mut daemon, _) = park(addr, "/ws/daemon", "daemon", ROOM).await?;

    // Half an interval in: nothing. A peer that is pinged the instant it parks is noise at exactly
    // the moment the connection is provably alive — and that is what `interval` does by default.
    match tokio::time::timeout(every / 2, daemon.next()).await {
        Err(_) => {}
        Ok(other) => return Err(format!("traffic on a carrier that just parked: {other:?}").into()),
    }

    // Then it keeps coming, for as long as the connection is up rather than once.
    for _ in 0..3 {
        match tokio::time::timeout(every * 4, daemon.next()).await? {
            Some(Ok(Message::Ping(_))) => {}
            other => return Err(format!("expected a keepalive ping, got {other:?}").into()),
        }
    }
    Ok(())
}

#[tokio::test]
async fn an_incompatible_wire_version_is_refused() -> Result<(), Box<dyn std::error::Error>> {
    let addr = start_relay(8).await?;
    let url = format!("ws://{addr}/ws/daemon");
    let (mut socket, _) = tokio_tungstenite::connect_async(url).await?;
    socket
        .send(Message::Text(
            serde_json::json!({ "role": "daemon", "room": ROOM, "proto": [1, 0] })
                .to_string()
                .into(),
        ))
        .await?;
    let reply = next_text(&mut socket).await?;
    assert!(reply.contains("incompatible"), "{reply}");
    Ok(())
}

#[tokio::test]
async fn health_counts_rooms_and_never_names_them() -> Result<(), Box<dyn std::error::Error>> {
    let addr = start_relay(8).await?;
    let (_daemon, _) = park(addr, "/ws/daemon", "daemon", ROOM).await?;

    let body = reqwest_less_get(addr, "/healthz").await?;
    assert!(body.contains("\"rooms\":1"), "{body}");
    assert!(
        !body.contains(ROOM),
        "health output must not name a room: {body}"
    );
    Ok(())
}

/// Minimal HTTP GET, so this test needs no HTTP client dependency.
async fn reqwest_less_get(
    addr: SocketAddr,
    path: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    let mut stream = TcpStream::connect(addr).await?;
    let request = format!("GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await?;
    let mut body = Vec::new();
    stream.read_to_end(&mut body).await?;
    let text = String::from_utf8_lossy(&body).into_owned();
    Ok(text
        .split_once("\r\n\r\n")
        .map_or(text.clone(), |(_, body)| body.to_owned()))
}
