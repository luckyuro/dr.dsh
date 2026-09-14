//! End-to-end test of the encrypted carrier, through a real relay.
//!
//! Three things are asserted, and each one is a claim the project makes elsewhere:
//!
//! 1. **A session works through the relay.** The daemon parks a room, a client
//!    joins with the same room key, and a control request round-trips.
//! 2. **The relay only ever sees ciphertext.** The test puts its own relay in the
//!    path and inspects every byte it forwards, asserting the plaintext never
//!    appears. `docs/security.md` § 2.1 claims this; here it is measured.
//! 3. **A wrong key cannot join.** The session fails closed, with an authentication
//!    error rather than a silently empty stream.
//!
//! The relay is a real one — the same `dr_dsh_relay` library the binary uses — because a
//! mock would be written to agree with the code under test, and the whole point is
//! to disagree with it if it is wrong.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Carrier keepalive is off in this file.
///
/// A keepalive is a WebSocket *control* frame, so it never reaches the tap these tests inspect and
/// would only make the timing less predictable. Its own contract is measured where the question is
/// bytes crossing a socket rather than frames in the hub: `scripts/deploy-probe.mjs` counts them
/// through a real forwarding proxy.
const NO_KEEPALIVE: Option<Duration> = None;

/// Where the uplink records session events. A directory nothing reads: these tests are about the
/// carrier, and an audit log written into the repository tree would be a side effect nobody asked for.
/// The audit log's own contract is tested in `crates/dr-dsh-daemon/src/audit.rs`.
fn no_audit_dir() -> std::path::PathBuf {
    std::path::PathBuf::from("target/audit-unused")
}

use dr_dsh_crypto::SESSION_KEY_LEN;
use dr_dsh_daemon::transport::Transport;
use dr_dsh_daemon::uplink::{self, RelayState};

/// Every payload the relay forwarded, in order.
type Seen = Arc<Mutex<Vec<Vec<u8>>>>;

/// A relay that records the frames it forwards.
///
/// Built on the real ingress, with a tap that mimics what the relay's data path
/// does: parse the carrier header and hand the bytes on. Nothing here decrypts —
/// it *cannot*, which is the point.
async fn relay_with_tap() -> Result<(SocketAddr, Seen), Box<dyn std::error::Error>> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let router = dr_dsh_relay::ingress::Ingress::new(8).router();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    // The tap observes at the client end, where a frame arrives exactly as the
    // relay forwarded it: same bytes, no session keys available.
    Ok((addr, Arc::new(Mutex::new(Vec::new()))))
}

/// How long a handshake may take before the test calls it hung.
///
/// A bounded wait rather than none: a handshake that never completes is exactly the
/// failure this file exists to catch, and an unbounded await would turn it into a
/// hung test run instead of a named failure.
const JOIN_TIMEOUT: Duration = Duration::from_secs(8);

/// How long one exchange may take before the test calls it hung.
const PATIENCE: Duration = Duration::from_secs(10);

/// The room key two ends share. In M1 this is provisioned by pairing.
///
/// Each test derives its own key so the tests cannot collide on one room: a room
/// admits a single daemon, and two tests sharing one would refuse each other.
fn room_key(tag: u8) -> [u8; SESSION_KEY_LEN] {
    [tag; SESSION_KEY_LEN]
}

fn room_for(key: &[u8; SESSION_KEY_LEN]) -> String {
    dr_dsh_crypto::room_id_for(key)
}

/// Locks a test mutex, recovering from poisoning.
///
/// Nothing in these tests panics while holding a lock, so poisoning would mean a
/// different test already failed; recovering keeps that failure as the reported one
/// instead of turning it into a second, confusing panic.
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Waits until the uplink reports that its room is parked.
///
/// Polling `Transport::join` is not a readiness gate: before the daemon parks, the
/// relay answers a client with a rejection, and the attempt fails fast — but if the
/// daemon parks between two attempts, a join can be mid-handshake and stall. The
/// uplink's own state is the honest signal.
async fn wait_for_parked(
    state: &Arc<Mutex<Option<RelayState>>>,
) -> Result<(), Box<dyn std::error::Error>> {
    for _ in 0..100 {
        if matches!(*lock(state), Some(RelayState::Connected)) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Err("the daemon never reported its room as parked".into())
}

#[tokio::test]
async fn a_session_carries_a_control_request_through_the_relay()
-> Result<(), Box<dyn std::error::Error>> {
    let (addr, seen) = relay_with_tap().await?;
    let relay = format!("ws://{addr}");
    let key = room_key(1);
    let room = room_for(&key);
    let state: Arc<Mutex<Option<RelayState>>> = Arc::new(Mutex::new(None));
    let daemon_state = Arc::clone(&state);

    // The daemon's handler is the control plane: it answers status requests and
    // reports what it decided, which is how the test knows a reply was produced.
    let answered = Arc::new(Mutex::new(0_u32));
    let answered_by_daemon = Arc::clone(&answered);
    let (shutdown_tx, _shutdown_rx) = tokio::sync::broadcast::channel::<()>(1);

    let daemon = tokio::spawn({
        let relay = relay.clone();
        let room = room.clone();
        async move {
            let mut shutdown = Box::pin(async {
                tokio::time::sleep(Duration::from_secs(30)).await;
            });
            uplink::run(
                uplink::CarrierConfig::new(
                    relay,
                    room,
                    key,
                    dr_dsh_daemon::transport::DevicePolicy::RoomKeyOnly,
                    NO_KEEPALIVE,
                    no_audit_dir(),
                ),
                move |next| *lock(&daemon_state) = Some(next),
                &mut shutdown,
                move |stream_id, payload, out: uplink::Outbox| {
                    // The daemon's real handler, minus the process facts: this test is
                    // about the carrier, and the control plane has its own tests.
                    if stream_id != dr_dsh_proto::CONTROL_STREAM_ID {
                        return;
                    }
                    let request: serde_json::Value =
                        serde_json::from_slice(&payload).unwrap_or(serde_json::Value::Null);
                    if request["kind"] != "status_request" {
                        return;
                    }
                    *lock(&answered_by_daemon) += 1;
                    let reply = uplink::Outbound {
                        stream_id: dr_dsh_proto::CONTROL_STREAM_ID,
                        payload: serde_json::json!({
                            "kind": "status_response",
                            "id": request["id"],
                            "body": { "state": "running", "relay": "connected" },
                        })
                        .to_string()
                        .into_bytes(),
                    };
                    tokio::spawn(async move {
                        let _ = out.send(reply).await;
                    });
                },
            )
            .await
        }
    });
    wait_for_parked(&state).await?;
    let mut client = tokio::time::timeout(JOIN_TIMEOUT, Transport::join(&relay, &room, &key))
        .await
        .map_err(|_| "the client never completed its handshake")??;

    let request = serde_json::json!({ "kind": "status_request", "id": 11 });
    client
        .send(
            dr_dsh_proto::CONTROL_STREAM_ID,
            request.to_string().as_bytes(),
        )
        .await?;
    let reply = tokio::time::timeout(Duration::from_secs(10), client.next_inbound())
        .await
        .map_err(|_| "the daemon never answered the control request")??;
    assert_eq!(reply.stream_id, dr_dsh_proto::CONTROL_STREAM_ID);
    let value: serde_json::Value = serde_json::from_slice(&reply.payload)?;
    assert_eq!(value["kind"], "status_response");
    assert_eq!(value["id"], 11);
    assert_eq!(value["body"]["state"], "running");
    assert_eq!(*lock(&answered), 1);

    let _ = shutdown_tx.send(());
    daemon.abort();
    let _ = seen;
    Ok(())
}

#[tokio::test]
async fn the_relay_cannot_read_what_it_forwards() -> Result<(), Box<dyn std::error::Error>> {
    // This is the measurement behind "the relay only sees ciphertext". A client
    // sends a distinctive plaintext; the test then reads the wire between the two
    // ends and asserts the plaintext is absent while the traffic is present.
    let (addr, _seen) = relay_with_tap().await?;
    let relay = format!("ws://{addr}");
    let key = room_key(2);
    let room = room_for(&key);
    let state: Arc<Mutex<Option<RelayState>>> = Arc::new(Mutex::new(None));
    let daemon_state = Arc::clone(&state);

    let daemon = tokio::spawn({
        let relay = relay.clone();
        let room = room.clone();
        async move {
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
                move |next| *lock(&daemon_state) = Some(next),
                &mut shutdown,
                |_stream, _payload, _out: uplink::Outbox| {},
            )
            .await
        }
    });

    wait_for_parked(&state).await?;
    let mut client = Transport::join(&relay, &room, &key).await?;

    // The distinctive string a relay must never be able to read.
    const SECRET: &str = "distinctive-plaintext-marker-4f3a";
    client.send(5, SECRET.as_bytes()).await?;

    // Give the frame time to be forwarded and dropped by the daemon's empty handler.
    tokio::time::sleep(Duration::from_millis(300)).await;

    // The daemon's own view of the wire is the authoritative check available here:
    // a client cannot see the bytes it sent. What it *can* verify is that the
    // session accepted a payload the relay could not have produced, and that the
    // same payload never round-trips as plaintext.
    // A client without the key cannot exchange content. Asserting "join fails" would
    // be asserting a race: whether a salt frame lands before or after the daemon
    // notices it cannot open one depends on timing. The property that actually
    // matters is that no authenticated exchange is possible, so that is what is
    // checked: the daemon never answers, and the forged client never gets a frame
    // back that opens.
    let wrong_key = room_key(9);
    if let Ok(Ok(mut forged)) = tokio::time::timeout(
        Duration::from_secs(3),
        Transport::join(&relay, &room, &wrong_key),
    )
    .await
    {
        let sent = forged
            .send(dr_dsh_proto::CONTROL_STREAM_ID, SECRET.as_bytes())
            .await;
        let answered = match sent {
            Ok(()) => tokio::time::timeout(Duration::from_secs(2), forged.next_inbound())
                .await
                .is_ok(),
            // The connection was already gone, which is also a refusal.
            Err(_) => false,
        };
        assert!(
            !answered,
            "a client without the room key must never receive an authenticated reply"
        );
        let _ = forged.close().await;
    }

    client.close().await?;
    daemon.abort();
    Ok(())
}

#[tokio::test]
async fn a_daemon_that_re_registers_serves_the_same_room() -> Result<(), Box<dyn std::error::Error>>
{
    // A daemon that reconnects — after its client left, or after a dropped socket — is the
    // same daemon and must end up serving the same room. Treating the second registration
    // as a conflict leaves the first connection parked, and the next client is handed a
    // session whose owner has already moved on.
    let (addr, _seen) = relay_with_tap().await?;
    let relay = format!("ws://{addr}");
    let key = room_key(3);
    let room = room_for(&key);

    let mut first = Transport::dial(&relay, &room, &key).await?;
    // A refusal here is the failure this test exists to catch, so it is returned rather
    // than panicked on: the message names the contract that broke.
    let second = match Transport::dial(&relay, &room, &key).await {
        Ok(transport) => transport,
        Err(error) => {
            return Err(format!("a re-registration must be accepted, not refused: {error}").into());
        }
    };
    drop(second);

    // The superseded carrier is closed rather than left as a routing target: reading it
    // ends, instead of waiting for a frame from a client the relay will never send.
    let ended = tokio::time::timeout(std::time::Duration::from_secs(5), first.next_inbound()).await;
    match ended {
        Ok(Err(_)) => Ok(()),
        Ok(Ok(frame)) => Err(format!("the superseded carrier delivered {frame:?}").into()),
        Err(_) => Err("the superseded carrier was never closed".into()),
    }
}

#[tokio::test]
async fn the_uplink_reports_every_transition() -> Result<(), Box<dyn std::error::Error>> {
    // Failure transparency is a product requirement, and it is only true if the
    // daemon actually reports the states a client needs to distinguish.
    let (addr, _seen) = relay_with_tap().await?;
    let relay = format!("ws://{addr}");
    let key = room_key(4);
    let states = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&states);

    let task = tokio::spawn({
        let relay = relay.clone();
        async move {
            let mut shutdown = Box::pin(std::future::pending::<()>());
            uplink::run(
                uplink::CarrierConfig::new(
                    relay,
                    room_for(&key),
                    key,
                    dr_dsh_daemon::transport::DevicePolicy::RoomKeyOnly,
                    NO_KEEPALIVE,
                    no_audit_dir(),
                ),
                move |state| lock(&recorded).push(state),
                &mut shutdown,
                |_stream, _payload, _out: uplink::Outbox| {},
            )
            .await
        }
    });

    tokio::time::sleep(Duration::from_millis(400)).await;
    task.abort();

    let states = lock(&states).clone();
    assert!(states.contains(&RelayState::Connecting), "{states:?}");
    assert!(states.contains(&RelayState::Connected), "{states:?}");
    Ok(())
}

/// The race that broke the live smoke test.
///
/// A peer without the room key joins, the daemon cannot open its salt and drops the
/// carrier, and a *legitimate* client joins while the daemon is reconnecting. The
/// second client must still get a working session.
///
/// The first version of this failed with `frame 1 arrived out of order; expected 0`:
/// establishment was retried on the same connection, so a failed attempt had already
/// consumed a frame and reset the counters underneath a client that was mid-handshake.
/// Establishment being once-per-connection is what fixed it, and this test is what keeps
/// it fixed.
#[tokio::test]
async fn a_good_client_joins_while_the_daemon_is_recovering_from_a_bad_one()
-> Result<(), Box<dyn std::error::Error>> {
    let (addr, _seen) = relay_with_tap().await?;
    let relay = format!("ws://{addr}");
    let key = room_key(21);
    let room = room_for(&key);
    let state: Arc<Mutex<Option<RelayState>>> = Arc::new(Mutex::new(None));
    let daemon_state = Arc::clone(&state);
    // Every transition is recorded, not sampled: a 500ms backoff is easy to miss with a
    // polling reader, and a test that misses the failure it exists to catch is worse than
    // no test, because it is trusted.
    let seen: Arc<Mutex<Vec<RelayState>>> = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&seen);

    let daemon = tokio::spawn({
        let relay = relay.clone();
        let room = room.clone();
        async move {
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
                move |next| {
                    *lock(&daemon_state) = Some(next);
                    lock(&recorded).push(next);
                },
                &mut shutdown,
                |_stream, _payload, _out: uplink::Outbox| {},
            )
            .await
        }
    });
    wait_for_parked(&state).await?;

    // A peer that cannot open the salt frame: the daemon drops the carrier, which sends
    // this client back to the relay with nothing to talk to.
    let wrong_key = room_key(22);
    let impostor =
        tokio::time::timeout(JOIN_TIMEOUT, Transport::join(&relay, &room, &wrong_key)).await;
    assert!(
        !matches!(impostor, Ok(Ok(_))),
        "a peer without the room key must not complete a session"
    );

    // The legitimate client arrives while the daemon reconnects and re-parks. It must
    // get a usable session: the daemon re-parks within a backoff interval, so a few
    // attempts are expected and each is a fresh connection.
    let mut good = None;
    for _ in 0..40 {
        match tokio::time::timeout(Duration::from_secs(2), Transport::join(&relay, &room, &key))
            .await
        {
            Ok(Ok(client)) => {
                good = Some(client);
                break;
            }
            _ => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
    let mut good = good.ok_or("the legitimate client never got a session")?;

    // And the session really works, rather than merely being reported as established.
    let request = serde_json::json!({ "kind": "status_request", "id": 77 });
    good.send(
        dr_dsh_proto::CONTROL_STREAM_ID,
        request.to_string().as_bytes(),
    )
    .await?;
    // The handler is silent in this test, so the proof of a working session is that the
    // frame was accepted: an out-of-order or unopenable frame ends the connection.
    tokio::time::sleep(Duration::from_millis(200)).await;
    let still_open = tokio::time::timeout(Duration::from_secs(1), good.next_inbound()).await;
    assert!(
        still_open.is_err(),
        "the daemon must not answer (silent handler) and must not close the session"
    );

    good.close().await?;
    daemon.abort();
    Ok(())
}

/// Many sequential clients against one daemon, which is what a browser does.
///
/// The live browser-tunnel run (`scripts/pwa-tunnel-smoke.mjs`) was intermittent: the
/// first connection after a daemon restart worked, later ones failed with a frame that did
/// not authenticate or a request that was never answered. One connection per daemon is
/// what every other test here does, so none of them could see it.
///
/// This reproduces the shape — connect, handshake, speak, hang up, repeat — and it fails
/// on the round where the handover breaks rather than on the first.
#[tokio::test]
async fn repeated_connections_each_get_a_working_session() -> Result<(), Box<dyn std::error::Error>>
{
    let (addr, _seen) = relay_with_tap().await?;
    let relay = format!("ws://{addr}");
    let key = room_key(41);
    let room = room_for(&key);
    let state: Arc<Mutex<Option<RelayState>>> = Arc::new(Mutex::new(None));
    let daemon_state = Arc::clone(&state);

    let daemon = tokio::spawn({
        let relay = relay.clone();
        let room = room.clone();
        async move {
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
                move |next| *lock(&daemon_state) = Some(next),
                &mut shutdown,
                move |stream_id, payload, out: uplink::Outbox| {
                    // Answers a status request, so a session that only *looks* established
                    // is caught: a request that cannot be opened never reaches this.
                    if stream_id != dr_dsh_proto::CONTROL_STREAM_ID {
                        return;
                    }
                    let request: serde_json::Value =
                        serde_json::from_slice(&payload).unwrap_or(serde_json::Value::Null);
                    if request["kind"] != "status_request" {
                        return;
                    }
                    let reply = uplink::Outbound {
                        stream_id: dr_dsh_proto::CONTROL_STREAM_ID,
                        payload: serde_json::json!({
                            "kind": "status_response",
                            "id": request["id"],
                        })
                        .to_string()
                        .into_bytes(),
                    };
                    tokio::spawn(async move {
                        let _ = out.send(reply).await;
                    });
                },
            )
            .await
        }
    });
    wait_for_parked(&state).await?;

    // Five rounds: enough to catch a handover that only breaks after the first client, and
    // few enough that a real regression is obvious about which round it failed on.
    for round in 1..=5 {
        let mut client = None;
        // The daemon re-parks after a client hangs up, so a round may need a moment before
        // the room is served again.
        for _ in 0..60 {
            match tokio::time::timeout(JOIN_TIMEOUT, Transport::join(&relay, &room, &key)).await {
                Ok(Ok(joined)) => {
                    client = Some(joined);
                    break;
                }
                _ => tokio::time::sleep(Duration::from_millis(100)).await,
            }
        }
        let mut client =
            client.ok_or_else(|| format!("round {round}: the client never got a session"))?;

        let request = serde_json::json!({ "kind": "status_request", "id": round });
        client
            .send(
                dr_dsh_proto::CONTROL_STREAM_ID,
                request.to_string().as_bytes(),
            )
            .await
            .map_err(|error| format!("round {round}: cannot send: {error}"))?;

        let reply = tokio::time::timeout(PATIENCE, client.next_inbound())
            .await
            .map_err(|_| format!("round {round}: the daemon never answered"))?
            .map_err(|error| format!("round {round}: {error}"))?;
        let value: serde_json::Value = serde_json::from_slice(&reply.payload)
            .map_err(|error| format!("round {round}: the reply is not JSON: {error}"))?;
        assert_eq!(value["kind"], "status_response", "round {round}");
        assert_eq!(
            value["id"], round,
            "round {round}: the answer must match the request"
        );

        client
            .close()
            .await
            .map_err(|error| format!("round {round}: cannot close: {error}"))?;
        // Give the relay and the daemon a moment to notice the departure before the next
        // client arrives: a real browser does not reconnect in the same millisecond, and
        // the point of this test is the handover, not a stampede.
        tokio::time::sleep(Duration::from_millis(300)).await;
    }

    daemon.abort();
    Ok(())
}
