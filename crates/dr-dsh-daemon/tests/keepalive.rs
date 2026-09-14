//! The daemon's carrier keepalive, observed on the wire.
//!
//! A carrier is a long-lived socket that is quiet for minutes at a time — first while the room is
//! parked waiting for a client, then between a client's requests — and a reverse proxy in front of
//! the relay closes a connection whose idle timer expires, saying nothing about why. The keepalive
//! is the bytes that reset that timer.
//!
//! The relay is impersonated here, at the WebSocket layer only: it accepts the upgrade, answers the
//! daemon's hello, and then reports what the daemon sends. That is not a shortcut around the real
//! relay — it is the only way to see this. The real ingress drops a peer's pings rather than routing
//! them (asserted in `crates/dr-dsh-relay/tests/routing.rs`), so through a real relay a ping is
//! invisible by design, and a test that wanted to observe one would have to inspect a socket the
//! relay owns. Nothing above the WebSocket layer happens in this file: the daemon stays parked,
//! which is both the longest quiet period and the state a proxy timeout actually kills.

use std::net::SocketAddr;
use std::time::Duration;

use dr_dsh_crypto::SESSION_KEY_LEN;
use dr_dsh_daemon::transport::DevicePolicy;
use dr_dsh_daemon::uplink::{self, RelayState};
use futures_util::{SinkExt as _, StreamExt as _};
use tokio_tungstenite::tungstenite::Message;

/// The keepalive interval used here.
///
/// Short because the test has to watch several ticks, long enough that "nothing arrived before the
/// first one" is a statement about the daemon rather than about scheduler latency.
const EVERY: Duration = Duration::from_millis(400);

/// Where the uplink records session events. Nothing reads it here: this file is about the keepalive,
/// and the audit log's own contract is tested in `crates/dr-dsh-daemon/src/audit.rs`.
fn no_audit_dir() -> std::path::PathBuf {
    std::path::PathBuf::from("target/audit-unused")
}

/// What the impersonated relay saw.
#[derive(Debug)]
enum Event {
    /// The daemon's hello has been answered, so the room is parked from here on.
    Parked,
    /// One frame the daemon sent after parking.
    Frame(Message),
}

/// Accepts one daemon, parks it, and reports what it sends afterwards.
async fn parked_daemon_relay()
-> Result<(SocketAddr, tokio::sync::mpsc::UnboundedReceiver<Event>), Box<dyn std::error::Error>> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        let Ok((stream, _)) = listener.accept().await else {
            return;
        };
        let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
            return;
        };
        // The hello `Transport::park` sends, and the `ready` it waits for. The relay's real answer
        // carries more (a capacity count); none of it is read by the daemon.
        let _ = socket.next().await;
        if socket
            .send(Message::Text(r#"{"type":"ready"}"#.into()))
            .await
            .is_err()
        {
            return;
        }
        let _ = tx.send(Event::Parked);
        while let Some(Ok(message)) = socket.next().await {
            if tx.send(Event::Frame(message)).is_err() {
                return;
            }
        }
    });
    Ok((addr, rx))
}

/// Runs the uplink against that relay until the test ends.
fn spawn_uplink(
    addr: SocketAddr,
    keepalive: Option<Duration>,
) -> tokio::task::JoinHandle<Result<(), dr_dsh_daemon::transport::TransportError>> {
    let key = [7_u8; SESSION_KEY_LEN];
    let room = dr_dsh_crypto::room_id_for(&key);
    tokio::spawn(async move {
        // A shutdown that never fires: the test ends by dropping the task, and a future that
        // completes would end the uplink for a reason this test is not about.
        let mut shutdown = Box::pin(std::future::pending::<()>());
        uplink::run(
            uplink::CarrierConfig::new(
                format!("ws://{addr}"),
                room,
                key,
                DevicePolicy::RoomKeyOnly,
                keepalive,
                no_audit_dir(),
            ),
            |_: RelayState| {},
            &mut shutdown,
            |_, _, _| {},
        )
        .await
    })
}

/// Waits for the parked signal, so the clock starts when the carrier is quiet rather than when the
/// test happened to spawn a task.
async fn wait_until_parked(
    seen: &mut tokio::sync::mpsc::UnboundedReceiver<Event>,
) -> Result<(), Box<dyn std::error::Error>> {
    match tokio::time::timeout(Duration::from_secs(5), seen.recv()).await? {
        Some(Event::Parked) => Ok(()),
        other => Err(format!("the daemon never parked: {other:?}").into()),
    }
}

#[tokio::test]
async fn a_carrier_waiting_for_its_first_client_is_pinged() -> Result<(), Box<dyn std::error::Error>>
{
    let (addr, mut seen) = parked_daemon_relay().await?;
    let daemon = spawn_uplink(addr, Some(EVERY));
    wait_until_parked(&mut seen).await?;

    // Not the moment it parks: a ping at the instant a connection is provably alive is noise, and
    // the timer it is meant to reset has only just started. This is the assertion that caught
    // `tokio::time::interval` firing its first tick immediately.
    match tokio::time::timeout(EVERY / 2, seen.recv()).await {
        Err(_) => {}
        Ok(other) => {
            return Err(format!("traffic on a carrier that just parked: {other:?}").into());
        }
    }

    // Then it keeps coming, because a timer needs resetting for as long as the carrier is up.
    for _ in 0..3 {
        match tokio::time::timeout(EVERY * 4, seen.recv()).await? {
            // Empty on purpose: the arrival of bytes is the whole message.
            Some(Event::Frame(Message::Ping(payload))) => {
                assert!(payload.is_empty(), "a keepalive ping carried {payload:?}");
            }
            other => return Err(format!("expected a keepalive ping, got {other:?}").into()),
        }
    }
    daemon.abort();
    Ok(())
}

#[tokio::test]
async fn a_carrier_with_keepalive_off_stays_silent() -> Result<(), Box<dyn std::error::Error>> {
    let (addr, mut seen) = parked_daemon_relay().await?;
    let daemon = spawn_uplink(addr, None);
    wait_until_parked(&mut seen).await?;

    // `DSHD_KEEPALIVE_SECS=0` has to mean silence rather than a very short interval: an operator
    // who turns it off may be doing so because something in the path answers pings and they do not
    // want the traffic, and "we only sent a few" is not that.
    match tokio::time::timeout(EVERY * 3, seen.recv()).await {
        Err(_) => {}
        Ok(other) => return Err(format!("a ping was sent with keepalive off: {other:?}").into()),
    }
    daemon.abort();
    Ok(())
}
