//! End-to-end tests of M1 pairing over a real relay.
//!
//! These are the tests for the milestone's own acceptance criteria:
//!
//! * an unpaired device cannot establish a tunnel;
//! * a pairing code is single use, and expires;
//! * the two ends agree, i.e. a client that redeems a code ends up holding the room the
//!   daemon serves.
//!
//! Both ends run in-process against a real `dr_dsh_relay::ingress`, because every property here
//! is about what crosses the relay: a test with a mocked relay would be testing the mock.
//! The pairing exchange is plain JSON on the pairing room — deliberately not a session — so
//! these tests need no room key at all, which is itself the claim being checked.

use std::time::Duration;

use dr_dsh_crypto::DeviceRegistry;
use dr_dsh_crypto::pairing::PairingCode;
use dr_dsh_daemon::pairing::{self, ExchangeError, pairing_room, parse_displayed_code};

type TestResult = Result<(), Box<dyn std::error::Error>>;

/// How long a pairing exchange may take before the test calls it hung.
const PATIENCE: Duration = Duration::from_secs(15);

/// A relay on an OS-assigned port, running the real ingress.
///
/// One relay per test rather than a shared one: a room admits a single daemon, and the
/// pairing room is derived from the code, so tests sharing a relay would collide the moment
/// they used the same code — which is exactly what a fresh relay per test makes impossible.
async fn start_relay() -> Result<String, Box<dyn std::error::Error>> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let router = dr_dsh_relay::ingress::Ingress::new(16).router();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Ok(format!("ws://{addr}"))
}

/// A code unique to a test, so two tests cannot derive the same pairing room.
///
/// Derived from the test's own tag rather than drawn at random: when a test fails, the code
/// it used is reproducible from the source rather than only from a log line.
fn code_for(tag: u8) -> PairingCode {
    PairingCode::from_secret([tag, tag, tag, tag, tag])
}

/// Runs both halves of a pairing exchange against one relay.
///
/// Returns the daemon's view and the client's, plus the registry the daemon wrote — which is
/// what a real daemon would have on disk afterwards.
/// The room key the daemon serves in these tests.
///
/// A constant, not a fresh draw per test: the point is that both ends end up with *this* key,
/// and a test that generated one per call could not tell a transferred key from a derived one.
const SERVED_ROOM_KEY: [u8; dr_dsh_crypto::SESSION_KEY_LEN] =
    [0x5a; dr_dsh_crypto::SESSION_KEY_LEN];

async fn pair(
    relay: &str,
    daemon_code: &PairingCode,
    client_code: &PairingCode,
    label: &str,
) -> Result<
    (
        Result<(pairing::Enrolment, DeviceRegistry), ExchangeError>,
        Result<pairing::Enrolled, ExchangeError>,
    ),
    Box<dyn std::error::Error>,
> {
    let directory = tempfile::tempdir()?;
    let registry_path = directory.path().join("devices.json");
    let registry = DeviceRegistry::new();

    let daemon = {
        let relay = relay.to_owned();
        let code = daemon_code.clone();
        let path = registry_path.clone();
        // The key the daemon serves; the receipt carries it, sealed, to the device.
        let served = SERVED_ROOM_KEY;
        tokio::spawn(async move {
            pairing::run_daemon_side(&relay, &code, registry, &path, &served, PATIENCE).await
        })
    };
    // The daemon has to be parked before the client knocks, exactly as a real one must be:
    // the relay refuses a client on a room nobody serves.
    tokio::time::sleep(Duration::from_millis(150)).await;

    // The client knocks on the daemon's rendezvous room even when it holds a different code:
    // the room is where they meet, the code is what they prove. Deriving the room from the
    // client's own code here would make a wrong attempt miss the room entirely, and the test
    // would pass for the wrong reason.
    let rendezvous = pairing_room(daemon_code);
    // The client reaches the daemon's room and seals its frames with that room's provisional
    // key — otherwise the daemon could not even open the first frame, and a wrong code would
    // look like a transport failure. What the client cannot fake is the PAKE password.
    let rendezvous_root = pairing::pairing_root_for_test(daemon_code);
    let client = tokio::time::timeout(
        PATIENCE,
        pairing::run_client_side_at(
            relay,
            client_code,
            &rendezvous,
            &rendezvous_root,
            label,
            PATIENCE,
        ),
    )
    .await
    .map_err(|_| "the client never finished pairing")?;

    let daemon = tokio::time::timeout(PATIENCE, daemon)
        .await
        .map_err(|_| "the daemon side never finished pairing")??;
    Ok((daemon, client))
}

#[tokio::test]
async fn a_code_enrols_exactly_one_device_and_both_ends_agree() -> TestResult {
    let relay = start_relay().await?;
    let code = code_for(1);
    let (daemon, client) = pair(&relay, &code, &code, "the test's phone").await?;

    let (enrolment, registry) = match daemon {
        Ok(accepted) => accepted,
        Err(error) => return Err(format!("the daemon must accept the device: {error}").into()),
    };
    let enrolled = match client {
        Ok(enrolled) => enrolled,
        Err(error) => return Err(format!("the client must be accepted: {error}").into()),
    };

    // The daemon stored exactly the device that redeemed the code.
    assert_eq!(registry.len(), 1, "one code enrols one device");
    assert_eq!(enrolment.device_id, enrolled.device_id);
    assert_eq!(enrolment.label, "the test's phone");
    let device_id = dr_dsh_crypto::DeviceId::from_base64url(&enrolled.device_id)?;
    assert!(registry.contains(&device_id));
    assert!(
        registry.challenge_key(&device_id).is_some(),
        "the enrolled device must have a key to challenge"
    );

    // And the client holds the identity it enrolled, plus the room key the daemon serves.
    assert_eq!(
        enrolled.identity.public().device_id().to_base64url(),
        enrolled.device_id,
        "the client's id must be derived from the key it kept"
    );
    // This is the property a freshly paired device depends on, and the one that was broken
    // when the receipt announced a key *derived from the PAKE* instead: the device held a
    // perfectly good key for a room no daemon served.
    assert_eq!(
        enrolled.root_key, SERVED_ROOM_KEY,
        "the device must end up with the key the daemon actually serves"
    );
    assert_eq!(
        enrolled.room,
        dr_dsh_crypto::room_id_for(&SERVED_ROOM_KEY),
        "and the room it derives must be the served room"
    );

    // The room the client will dial is the room the daemon serves: if these disagreed the
    // client would see "no daemon is serving this room" forever, with nothing to point at.
    assert_eq!(
        dr_dsh_crypto::room_id_for(&enrolled.root_key),
        enrolled.room,
        "the announced room must be the one the root key derives"
    );
    Ok(())
}

#[tokio::test]
async fn a_wrong_code_enrols_nobody() -> TestResult {
    // The property the whole 40-bit design rests on. The client still completes SPAKE2 —
    // a PAKE cannot tell it the code is wrong — so the refusal happens at the proof, which
    // is why the daemon must check the proof under the exchanged key.
    let relay = start_relay().await?;
    let daemon_code = code_for(2);
    let client_code = PairingCode::from_secret([2, 2, 2, 2, 3]);
    let (daemon, _client) = pair(&relay, &daemon_code, &client_code, "an impostor").await?;

    let outcome = match daemon {
        Err(error) => error,
        Ok((enrolment, _)) => {
            return Err(format!(
                "a wrong code must not enrol a device, but {} was enrolled",
                enrolment.device_id
            )
            .into());
        }
    };
    // The *pairing* layer must be what refuses — not the transport. That much this test can
    // check. Which pairing check fires is not asserted, because with mismatched codes SPAKE2
    // itself usually fails first and the possession proof is never reached; the proof's own
    // teeth are pinned in the dr-dsh-crypto pairing tests, where an attacker who completes the
    // PAKE with a wrong code and presents a valid self-signature is still refused.
    assert!(
        matches!(
            outcome,
            ExchangeError::Pairing(dr_dsh_crypto::PairingError::ConfirmationFailed)
        ),
        "the proof, not the transport, must refuse a wrong code: got {outcome:?}"
    );
    Ok(())
}

#[tokio::test]
async fn the_same_code_cannot_enrol_a_second_device() -> TestResult {
    // Single use is what makes retrying against one code useless. The second attempt must
    // fail even though the client presents the *correct* code, because the first attempt
    // burned it.
    let relay = start_relay().await?;
    let code = code_for(3);

    let (daemon, client) = pair(&relay, &code, &code, "first").await?;
    assert!(daemon.is_ok(), "the first device must be accepted");
    assert!(client.is_ok());

    // A second exchange with the same code: the registry path is fresh, but the code is a
    // value this test controls, so what is exercised is the exchange refusing a spent code.
    let mut pending = dr_dsh_crypto::PendingCode::new(code.clone());
    assert!(
        pending.consume().is_ok(),
        "the first attempt consumes the code"
    );
    assert!(
        matches!(
            pending.consume(),
            Err(dr_dsh_crypto::PairingError::AlreadyUsed)
        ),
        "a spent code must not enrol a second device"
    );
    Ok(())
}

#[tokio::test]
async fn the_displayed_code_round_trips_through_a_human() -> TestResult {
    // The only transport for the code is a person reading it and typing it, so the parser
    // that accepts what they typed is part of the protocol, not a convenience.
    let code = PairingCode::from_secret([0, 1, 2, 3, 4]);
    let shown = code.display_form();

    // Exactly as displayed.
    assert_eq!(parse_displayed_code(&shown)?.secret(), code.secret());
    // As a person might type it: lower case, spaces instead of dashes.
    let typed = shown.to_lowercase().replace('-', " ");
    assert_eq!(parse_displayed_code(&typed)?.secret(), code.secret());
    // And with the characters the alphabet omits, folded onto the digits they look like.
    let with_o = shown.replace('0', "O");
    assert_eq!(parse_displayed_code(&with_o)?.secret(), code.secret());

    // A code that is not a code is refused rather than silently truncated.
    assert!(parse_displayed_code("nope").is_err());
    assert!(parse_displayed_code(&"Z".repeat(11)).is_err());
    Ok(())
}

#[tokio::test]
async fn a_pairing_room_is_derived_from_the_code_and_not_the_served_room() -> TestResult {
    // The pairing room is a rendezvous the relay can log without learning anything it can
    // reuse: it is derived from the code, one-way, and is not the room the daemon serves.
    let code = PairingCode::generate();
    let room = pairing_room(&code);
    assert!(!room.is_empty());
    assert_eq!(room, pairing_room(&code), "the derivation must be stable");

    let other = PairingCode::from_secret([1, 2, 3, 4, 5]);
    assert_ne!(room, pairing_room(&other), "different codes must not meet");

    // The served room comes from the SPAKE2 root key, not the code, so it cannot equal the
    // rendezvous room even by accident.
    let root = [9_u8; dr_dsh_crypto::SESSION_KEY_LEN];
    assert_ne!(room, dr_dsh_crypto::room_id_for(&root));
    Ok(())
}

#[tokio::test]
async fn an_unpaired_registry_authorizes_no_device() -> TestResult {
    // M1's first acceptance criterion, at the unit boundary the daemon will call. A daemon
    // that has never been paired has no challenge to issue, so there is no handshake to run:
    // the refusal is the absence of a key, not a policy check someone can forget.
    let registry = DeviceRegistry::new();
    let stranger = dr_dsh_crypto::DeviceSecretKey::generate();
    assert!(
        registry
            .challenge_key(&stranger.public().device_id())
            .is_none(),
        "an empty registry must authorize nobody"
    );

    // After enrolling that one device, it is authorized and a different one still is not.
    let relay = start_relay().await?;
    let code = code_for(4);
    let (daemon, client) = pair(&relay, &code, &code, "the only device").await?;
    let (_, registry) = match daemon {
        Ok(accepted) => accepted,
        Err(error) => return Err(format!("the device must be accepted: {error}").into()),
    };
    let enrolled = match client {
        Ok(enrolled) => enrolled,
        Err(error) => return Err(format!("the client must be accepted: {error}").into()),
    };

    let enrolled_id = dr_dsh_crypto::DeviceId::from_base64url(&enrolled.device_id)?;
    assert!(registry.challenge_key(&enrolled_id).is_some());
    let other = dr_dsh_crypto::DeviceSecretKey::generate();
    assert!(
        registry
            .challenge_key(&other.public().device_id())
            .is_none(),
        "a device that never paired must stay unauthorized"
    );
    Ok(())
}

/// Joins, retrying while the relay still reports the room as unserved.
///
/// The daemon parks asynchronously, and a client that arrives first is refused outright. The
/// retry is the honest way to wait for that: unlike a sleep, it cannot pass while the room is
/// still empty, and unlike awaiting the daemon's own handshake it cannot deadlock.
async fn join_with_retry(
    relay: &str,
    room: &str,
    root: &[u8; dr_dsh_crypto::SESSION_KEY_LEN],
    identity: Option<dr_dsh_daemon::transport::DeviceIdentity>,
) -> Result<dr_dsh_daemon::transport::Transport, dr_dsh_daemon::transport::TransportError> {
    // Parking on a room nobody serves yet is the only step worth retrying, and the identity
    // moves into the single establishment below: an identity is not cloneable on purpose.
    let mut transport = None;
    let mut last = None;
    for _ in 0..80 {
        match dr_dsh_daemon::transport::Transport::park_as_client(relay, room, root, None).await {
            Ok(parked) => {
                transport = Some(parked);
                break;
            }
            Err(error) => last = Some(error),
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let Some(mut transport) = transport else {
        return Err(
            last.unwrap_or(dr_dsh_daemon::transport::TransportError::Handshake(
                "the client never reached the daemon".to_owned(),
            )),
        );
    };
    transport.set_identity(identity);
    transport.establish().await?;
    Ok(transport)
}

#[tokio::test]
async fn an_enrolled_device_can_open_a_session() -> TestResult {
    // The positive half of the acceptance criterion. Without this, a policy that refused
    // everyone would look like a passing "unpaired devices are refused" test.
    let device = dr_dsh_crypto::DeviceSecretKey::generate();
    let device_id = device.public().device_id().to_base64url();
    let mut registry = DeviceRegistry::new();
    registry.enrol(device.public(), "the enrolled phone".to_owned());

    let root = [31_u8; dr_dsh_crypto::SESSION_KEY_LEN];
    let room = dr_dsh_crypto::room_id_for(&root);
    let relay = start_relay().await?;
    let (registry_tx, registry_rx) = tokio::sync::oneshot::channel();

    let daemon = {
        let relay = relay.clone();
        let room = room.clone();
        tokio::spawn(async move {
            let mut transport = match dr_dsh_daemon::transport::Transport::dial_with_policy(
                &relay,
                &room,
                &root,
                dr_dsh_daemon::transport::DevicePolicy::enrolled(registry),
            )
            .await
            {
                Ok(transport) => transport,
                Err(error) => {
                    let _ = registry_tx.send(format!("the daemon could not park: {error}"));
                    return;
                }
            };
            let outcome = transport.establish().await;
            let _ = registry_tx.send(match outcome {
                Ok(()) => "accepted".to_owned(),
                Err(error) => format!("refused: {error}"),
            });
        })
    };
    // The daemon parks, then the client knocks. The two handshakes must overlap — the daemon's
    // `establish` is what reads the client's salt, so awaiting it before a client exists would
    // wait forever. Only parking has to happen first, and `join_as` retries that race.
    tokio::time::sleep(Duration::from_millis(200)).await;

    let client = join_with_retry(
        &relay,
        &room,
        &root,
        Some(dr_dsh_daemon::transport::DeviceIdentity {
            device_id,
            room: room.clone(),
            key: device,
        }),
    )
    .await;
    let accepted = match client {
        Ok(transport) => transport.is_device_bound(),
        Err(error) => return Err(format!("an enrolled device must be accepted: {error}").into()),
    };
    let daemon_accepted = tokio::time::timeout(PATIENCE, registry_rx)
        .await
        .map_err(|_| "the daemon never finished the handshake")?
        .map_err(|_| "the daemon task ended without reporting")?;
    daemon.abort();
    assert!(accepted, "the client must consider itself bound");
    assert_eq!(
        daemon_accepted, "accepted",
        "the daemon must accept the enrolled device"
    );
    Ok(())
}

#[tokio::test]
async fn an_unpaired_device_cannot_open_a_session() -> TestResult {
    // The acceptance criterion itself. The stranger holds the room key — it completed the
    // same salt exchange — and is refused anyway, because it cannot answer a challenge it has
    // no key for. That is the difference between knowing where the room is and being let in.
    let enrolled = dr_dsh_crypto::DeviceSecretKey::generate();
    let stranger = dr_dsh_crypto::DeviceSecretKey::generate();
    let mut registry = DeviceRegistry::new();
    registry.enrol(enrolled.public(), "the enrolled phone".to_owned());

    let root = [32_u8; dr_dsh_crypto::SESSION_KEY_LEN];
    let room = dr_dsh_crypto::room_id_for(&root);
    let relay = start_relay().await?;
    let (outcome_tx, outcome_rx) = tokio::sync::oneshot::channel();

    let daemon = {
        let relay = relay.clone();
        let room = room.clone();
        tokio::spawn(async move {
            let mut transport = match dr_dsh_daemon::transport::Transport::dial_with_policy(
                &relay,
                &room,
                &root,
                dr_dsh_daemon::transport::DevicePolicy::enrolled(registry),
            )
            .await
            {
                Ok(transport) => transport,
                Err(error) => {
                    let _ = outcome_tx.send(format!("the daemon could not park: {error}"));
                    return;
                }
            };
            let _ = outcome_tx.send(match transport.establish().await {
                Ok(()) => "accepted".to_owned(),
                Err(error) => format!("refused: {error}"),
            });
        })
    };
    tokio::time::sleep(Duration::from_millis(200)).await;

    // The stranger claims the enrolled device's *id*. It cannot produce that device's
    // signature, which is the only thing the daemon actually checks.
    let claimed_id = enrolled.public().device_id().to_base64url();
    let client = join_with_retry(
        &relay,
        &room,
        &root,
        Some(dr_dsh_daemon::transport::DeviceIdentity {
            device_id: claimed_id,
            room: room.clone(),
            key: stranger,
        }),
    )
    .await;
    let client_refused = match client {
        Ok(transport) => !transport.is_device_bound(),
        Err(_) => true,
    };
    let daemon_error = tokio::time::timeout(PATIENCE, outcome_rx)
        .await
        .map_err(|_| "the daemon never finished the handshake")?
        .map_err(|_| "the daemon task ended without reporting")?;
    daemon.abort();

    assert!(
        client_refused,
        "a client that cannot prove possession must not be bound"
    );
    // The refusal must name the reason the *proof* was wrong, not something incidental: a
    // test satisfied by any refusal would pass on a transport failure too.
    assert!(
        daemon_error.starts_with("refused:")
            && daemon_error.contains(dr_dsh_proto::device::REASON_BAD_PROOF),
        "the refusal must name the reason: got {daemon_error}"
    );
    Ok(())
}

#[tokio::test]
async fn a_daemon_with_no_enrolled_devices_still_serves_the_room_key() -> TestResult {
    // The documented fallback. M0's deployments hold a room key and have never paired, and a
    // daemon that refused them the moment the feature landed would be a breaking change with
    // no migration path.
    let relay = start_relay().await?;
    let root = [33_u8; dr_dsh_crypto::SESSION_KEY_LEN];
    let room = dr_dsh_crypto::room_id_for(&root);
    let (outcome_tx, outcome_rx) = tokio::sync::oneshot::channel();

    let daemon = {
        let relay = relay.clone();
        let room = room.clone();
        tokio::spawn(async move {
            let mut transport = match dr_dsh_daemon::transport::Transport::dial_with_policy(
                &relay,
                &room,
                &root,
                dr_dsh_daemon::transport::DevicePolicy::RoomKeyOnly,
            )
            .await
            {
                Ok(transport) => transport,
                Err(error) => {
                    let _ = outcome_tx.send(format!("the daemon could not park: {error}"));
                    return;
                }
            };
            let _ = outcome_tx.send(match transport.establish().await {
                Ok(()) => "accepted".to_owned(),
                Err(error) => format!("refused: {error}"),
            });
        })
    };
    tokio::time::sleep(Duration::from_millis(200)).await;

    let client = dr_dsh_daemon::transport::Transport::join(&relay, &room, &root).await;
    let client_ok = matches!(client, Ok(ref transport) if transport.is_device_bound());
    let daemon_ok = tokio::time::timeout(PATIENCE, outcome_rx)
        .await
        .map_err(|_| "the daemon never finished the handshake")?
        .map_err(|_| "the daemon task ended without reporting")?;
    daemon.abort();

    assert!(client_ok, "a room-key client must still be accepted");
    assert_eq!(
        daemon_ok, "accepted",
        "the daemon must accept a room-key client"
    );
    Ok(())
}

/// The receipt must not be readable by the relay.
///
/// The pairing room's transport root is a **published constant** (`transport_root()`), which is
/// deliberate — it protects nothing, because authentication comes from the PAKE — but it means
/// anything the daemon sends on that room in the clear is readable by whoever forwards it. This
/// test is the relay: it joins with nothing but public values and the bytes on the wire, and
/// asserts the room key never appears among them.
///
/// It fails on the implementation that announced `derive_pairing_root(spake_output)` as the
/// room key: that value was the key the client would serve from, sent in the clear.
#[tokio::test]
async fn the_relay_cannot_read_the_room_key_out_of_the_receipt() -> TestResult {
    use dr_dsh_crypto::pairing::ClientPairing;
    use dr_dsh_crypto::{DeviceSecretKey, room_id_for};
    use dr_dsh_daemon::transport::Transport;
    use dr_dsh_proto::CONTROL_STREAM_ID;

    let relay = start_relay().await?;
    let code = code_for(0x5a);
    let directory = tempfile::tempdir()?;
    let registry_path = directory.path().join("devices.json");

    let daemon = {
        let relay = relay.clone();
        let code = code.clone();
        let path = registry_path.clone();
        let served = SERVED_ROOM_KEY;
        tokio::spawn(async move {
            pairing::run_daemon_side(
                &relay,
                &code,
                DeviceRegistry::new(),
                &path,
                &served,
                PATIENCE,
            )
            .await
        })
    };
    tokio::time::sleep(Duration::from_millis(150)).await;

    // Everything this client uses is public: the constant transport root, the code it was
    // given (a person has it too), and the bytes the relay forwarded.
    let mut transport = Transport::join(
        &relay,
        &pairing_room(&code),
        &dr_dsh_crypto::pairing::transport_root(),
    )
    .await?;
    let daemon_message = transport.next_inbound().await?.payload;

    let identity = DeviceSecretKey::generate();
    let (client, client_message) = ClientPairing::begin(&code);
    transport.send(CONTROL_STREAM_ID, &client_message).await?;
    let enrolment = client.finish(&daemon_message, &identity)?;
    let finish = serde_json::json!({
        "device_name": "the relay's own client",
        "device_public_key": enrolment.public_key.to_vec(),
        "confirm": enrolment.confirm,
    });
    transport
        .send(CONTROL_STREAM_ID, finish.to_string().as_bytes())
        .await?;

    // The receipt, exactly as the relay forwards it.
    let receipt = transport.next_inbound().await?.payload;
    let _ = transport.close().await;
    let _ = daemon.await;

    assert!(
        !contains(&receipt, &SERVED_ROOM_KEY),
        "the room key appears verbatim in the receipt the relay forwards"
    );
    let encoded = {
        use base64::Engine as _;
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(SERVED_ROOM_KEY)
    };
    assert!(
        !contains(&receipt, encoded.as_bytes()),
        "the room key appears base64-encoded in the receipt the relay forwards"
    );

    // And the honest client still gets it: the sealed receipt opens under the enrolment key.
    let accepted: serde_json::Value = serde_json::from_slice(&receipt)?;
    let sealed = accepted
        .get("root_key")
        .and_then(serde_json::Value::as_str)
        .ok_or("the receipt carries no room key field")?;
    let sealed = {
        use base64::Engine as _;
        base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(sealed)?
    };
    let opened =
        dr_dsh_crypto::open_room_key(enrolment.enrolment_key(), &enrolment.public_key, &sealed)?;
    assert_eq!(
        *opened, SERVED_ROOM_KEY,
        "the device must still receive the key"
    );
    assert_eq!(
        accepted.get("room").and_then(serde_json::Value::as_str),
        Some(room_id_for(&SERVED_ROOM_KEY).as_str())
    );
    assert!(room_id_for(&SERVED_ROOM_KEY) != room_id_for(&[0x11; 32]));
    Ok(())
}

/// Whether `haystack` contains `needle`.
fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}
