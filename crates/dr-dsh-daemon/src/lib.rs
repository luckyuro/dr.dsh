//! # dr-dsh-daemon — the dr.dsh local daemon
//!
//! One process per user machine. It is the *only* component that touches a DSH
//! instance, and it is the trust anchor of the whole system: it holds the room's
//! identity key, it decides which devices are paired, and it is the endpoint
//! that terminates end-to-end encryption.
//!
//! ## Responsibilities
//!
//! 1. **Supervise** the DSH process it owns: start it loopback-bound, watch it,
//!    restart it when it dies, stop it gracefully on request.
//! 2. **Proxy** DSH's HTTP and WebSocket surface into encrypted streams, so the
//!    remote client talks to the real DSH and not to a reimplementation.
//! 3. **Report** state and events outward, and never invent them.
//! 4. **Refuse** anything outside the four whitelisted lifecycle operations and
//!    any attempt to bind DSH to a non-loopback address (project definition
//!    § 9.6).
//!
//! ## Deliberate limits
//!
//! * No general command execution, no file transfer, no remote shell.
//! * No listening socket other than the loopback control port an operator opts
//!   into; the tunnel is always dialed *outward* from this process.
//! * If DSH was started by hand, the daemon attaches in proxy-only mode and
//!   refuses lifecycle commands (attach mode, project definition § 8).
//!
//! ## Status: M0 in progress
//!
//! Implemented and verified against a real DSH checkout:
//!
//! * [`dsh::Supervisor`] spawns `dsh web --no-open --port <p>`, parses the
//!   readiness line, and stops the child with SIGTERM;
//! * [`dsh::DshClient`] performs the token→cookie exchange and issues
//!   authority-preserving loopback requests, which is what makes the Web UI's own
//!   authentication work through a proxy;
//! * `drdshd run` wires those together and proves the chain at startup.
//!
//! Not implemented: the relay uplink, the encrypted tunnel, and the proxy that
//! serves DSH's requests to a remote client. Those are the rest of M0.
//!
//! See `docs/architecture.md` and `docs/decisions/0003-no-fork-integration.md`.

#![forbid(unsafe_code)]
#![warn(missing_docs)]
// Skeleton: `config` and `uplink` are the daemon's intended shape, and their
// tests already pin the invariants (loopback-only base URL, backoff curve).
// Wiring lands with M0/M2; until then the items are exercised by tests only.
#![allow(dead_code)]

use std::process::ExitCode;

/// The audit log: who did what to this machine, kept on this machine (ADR-0012).
pub mod audit;
/// Command-line surface of the daemon.
///
/// Kept in-process rather than behind a parser crate for now: the surface is
/// four verbs, and the daemon is the binary users run on machines we cannot
/// debug remotely.
pub mod cli;
/// Where the daemon keeps its own state: room identity, paired devices, config.
pub mod config;
/// The control plane: what a remote client asks the daemon, and what it gets back.
pub mod control;
/// Crash reports the client sent, kept on this machine and nowhere else.
pub mod crashlog;
pub mod deployment;
/// Pre-flight checks that turn "it does not work" into a named cause.
pub mod doctor;
/// The DSH process this daemon supervises, and the loopback client that talks to it.
pub mod dsh;
pub mod lifecycle;
pub mod pairing;
/// The proxy: DSH's HTTP surface, carried through the tunnel.
pub mod proxy;
/// Where the room key comes from (ADR-0013).
pub mod roomkey;
pub mod state;
/// The carrier connection to a relay, with the sealing layer above it.
pub mod transport;
/// Outbound carrier connection to a relay, plus reconnect/backoff policy.
pub mod uplink;

/// Runs the daemon's supervised-DSH loop.
///
/// M0 scope: start DSH, verify the bind, authenticate against it over loopback,
/// then hold that state and report it. The relay uplink comes next, which is why
/// `relay` is accepted and reported but not yet dialed — accepting the flag now
/// keeps the command line stable while making the missing half visible in the
/// log rather than in a surprise later.
///
/// The process stays in the foreground and relies on the operator's process
/// manager (systemd, launchd, a terminal): the daemon deliberately does not
/// daemonize itself, because a background process nobody can find is exactly the
/// failure mode `drdshd doctor` exists to prevent.
pub async fn run_command(
    config_path: Option<&std::path::Path>,
    relay: Option<&str>,
    port: Option<u16>,
    room_key: Option<&str>,
    attach: Option<u16>,
    attach_token: Option<&str>,
) -> anyhow::Result<ExitCode> {
    use anyhow::Context as _;

    let supervisor_config = dsh::SupervisorConfig {
        port: port.unwrap_or_else(|| dsh::SupervisorConfig::default().port),
        ..dsh::SupervisorConfig::default()
    };
    if attach_token.is_some() && attach.is_none() {
        anyhow::bail!(
            "--attach-token only means something with --attach: without it the daemon starts \
             DSH itself and already has a token"
        );
    }
    if let Some(path) = config_path {
        // Config-file loading lands with M2 (it also carries the relay URL and
        // the attach-mode choice). Failing loudly beats ignoring the flag.
        anyhow::bail!(
            "configuration files are not read yet (got {}); pass --relay on the command line for now",
            path.display()
        );
    }
    // Resolved before anything starts, and an unparsable value stops the daemon here: a keepalive
    // interval nobody chose is the kind of configuration mistake that only shows up as a reconnect
    // loop an hour later. Read once, so one process has one answer for every reconnect.
    let keepalive = uplink::keepalive_from_env().map_err(anyhow::Error::msg)?;

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,dsh=debug")),
        )
        .with_target(true)
        .init();

    match attach {
        Some(port) => println!(
            "drdshd {} — attaching to DSH on 127.0.0.1:{port}",
            env!("CARGO_PKG_VERSION")
        ),
        None => println!(
            "drdshd {} — supervising DSH on 127.0.0.1:{}",
            env!("CARGO_PKG_VERSION"),
            supervisor_config.port
        ),
    }
    // The key comes from `--room-key`, else the state directory, else a fresh one written there
    // (ADR-0013). The state directory is resolved here rather than later because the key lives in it —
    // and because a daemon that read one directory for its key and another for its registry would be a
    // bug nobody could see from the outside.
    let state_directory =
        state::state_dir().context("cannot locate the daemon's state directory")?;
    let root = match relay {
        Some(_) => {
            let resolved = roomkey::resolve(&state_directory, room_key)?;
            for line in resolved.announcement() {
                println!("{line}");
            }
            Some(resolved.root)
        }
        None => {
            if room_key.is_some() {
                anyhow::bail!("--room-key without --relay has nothing to authenticate to");
            }
            None
        }
    };
    match relay {
        Some(relay) => println!("relay: {relay}"),
        None => println!(
            "relay: none configured — DSH is supervised locally and the tunnel is not dialed \
             (pass --relay and --room-key to enable remote access)"
        ),
    }

    // Attach mode holds no process and, by default, no token. It still needs a client, and the
    // two modes differ in exactly one input: where the authority-bound cookie comes from.
    let (attach_handle, mut client, base_url, dsh_token) = match attach {
        Some(attach_port) => {
            let base_url = format!("http://127.0.0.1:{attach_port}");
            println!("attaching to DSH already running on {base_url}");
            let mut client = dsh::DshClient::new(&base_url)
                .context("the attach port did not yield a usable loopback URL")?;
            match attach_token {
                Some(token) => {
                    // The operator pasted the `?token=` value DSH printed. It is a one-time
                    // process token, so this is the same exchange the daemon performs in
                    // managed mode — the only difference is who read the line.
                    client.authenticate(token).await.context(
                        "DSH rejected the token; it is single-use and expires, so re-copy the \
                         ?token= value from the terminal DSH is running in",
                    )?;
                    println!(
                        "authenticated against DSH on authority {}",
                        client.authority()
                    );
                }
                None => {
                    println!(
                        "no --attach-token given: status and lifecycle reporting work, but the \
                         DSH interface cannot be reached, because DSH only serves it to a browser \
                         holding a cookie signed with a secret it keeps to itself"
                    );
                }
            }
            (
                None,
                Some(client),
                base_url,
                attach_token.map(str::to_owned),
            )
        }
        None => {
            // Checked before spawning, because the failure it prevents is the most confusing one
            // this daemon has: DSH starts, cannot bind, exits, and the daemon reports only that
            // it "exited before announcing readiness" with the real reason buried in DSH's own
            // debug output. The usual cause is a DSH from an earlier run that nobody is
            // supervising any more — a process that survived a `kill` of its daemon and now
            // holds the port forever. Naming that, and naming `--attach`, turns twenty minutes
            // of reading logs into one sentence.
            ensure_port_free(supervisor_config.port)?;
            let supervisor = dsh::Supervisor::start(supervisor_config.clone())
                .await
                .context("cannot supervise DSH")?;
            let ready = supervisor.ready().clone();
            println!(
                "DSH is listening on {}:{} (pid {})",
                ready.addr,
                ready.port,
                supervisor
                    .pid()
                    .map_or_else(|| "unknown".to_owned(), |pid| pid.to_string())
            );
            let mut client = dsh::DshClient::new(&ready.base_url)
                .context("the readiness line did not yield a usable loopback URL")?;
            client.authenticate(&ready.token).await.context(
                "DSH rejected the process token; see docs/integration/dsh-surface.md § 3",
            )?;
            println!(
                "authenticated against DSH on authority {}",
                client.authority()
            );
            (
                Some(supervisor),
                Some(client),
                ready.base_url,
                Some(ready.token.clone()),
            )
        }
    };
    // One authenticated request proves the whole chain (token → cookie →
    // authority-bound access) is intact, and it is cheap enough to do at startup
    // rather than discovering it on the first remote request.
    //
    // Skipped in attach mode without a token: there is no cookie, so the index is *expected*
    // to be refused, and asserting otherwise would turn the honest configuration into a
    // startup failure. What is not skipped is saying so.
    match client.as_mut() {
        Some(client) => {
            let index = client
                .get("/")
                .await
                .context("DSH did not answer the index request")?;
            anyhow::ensure!(
                index.status.is_success(),
                "DSH answered {} for its own index after a successful token exchange; \
                 this usually means the authority changed between the two requests",
                index.status
            );
            println!(
                "index reachable: {} bytes (authentication and authority binding verified)",
                index.body.len()
            );
        }
        None => println!("index not checked: no credential was supplied for the attached DSH"),
    }

    // From here the daemon does two things at once, and neither may block the other:
    // it supervises DSH locally, and it serves the remote client over the tunnel.
    // Losing the relay must never cost a local session, so the supervisor is never
    // cancelled by an uplink failure — only by its own child exiting or by Ctrl-C.
    // The proxy performs remote requests against its own authenticated client: the
    // startup check's client is used once and finished with, and a remote connection
    // must not share mutable authentication state with it.
    let proxy = if relay.is_some() {
        let proxy_client =
            dsh::DshClient::new(&base_url).context("DSH's base URL is not usable for the proxy")?;
        let mut service = proxy::ProxyService::new(std::sync::Arc::new(proxy_client));
        // The proxy authenticates with the same credential the startup check used: the
        // readiness line's token in managed mode, the operator's token in attach mode. An
        // attached DSH with neither gets a proxy that carries no cookie — which is exactly the
        // state that makes the interface unreachable, and the daemon said so at startup rather
        // than failing here. The first version of this reached for the attach token in both
        // modes and panicked on a managed daemon that was working perfectly.
        if let Some(token) = dsh_token.as_deref() {
            service
                .authenticate(token)
                .await
                .context("the proxy could not authenticate against DSH")?;
        }
        Some(std::sync::Arc::new(service))
    } else {
        None
    };
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let relay_state = std::sync::Arc::new(std::sync::Mutex::new(uplink::RelayState::Connecting));

    // The lifecycle driver owns DSH from here on. The supervisor built above is handed to it
    // rather than driven at the top level, so there is exactly one place that starts, stops,
    // and restarts the process — two would race, and the race would show up as a process
    // nobody can account for.
    // Attach mode gets a driver whose mode refuses every mutating operation, and no process to
    // drive. That is the whole difference: the refusal is a property of the mode, so it holds
    // for every caller rather than depending on a flag someone remembers to check.
    let mode = match attach {
        Some(attach_port) => lifecycle::Mode::Attached { port: attach_port },
        None => lifecycle::Mode::Managed {
            port: supervisor_config.port,
        },
    };
    // Cloned into the channel and kept here: the facts below need to know the mode, and a
    // `Mode` is two small values rather than a resource.
    let (lifecycle_handle, lifecycle_driver) =
        lifecycle::channel(mode.clone(), lifecycle::RestartPolicy::default());
    let lifecycle_task = tokio::spawn(match attach_handle {
        Some(supervisor) => lifecycle_driver
            // The supervisor started above is handed over rather than started again: the daemon
            // needed it for its own startup checks, and two starts would mean two DSH instances
            // racing for one port.
            .adopt(Box::new(supervisor))
            .run(dsh::SupervisorSpawner::new(supervisor_config.clone())),
        // Nothing to adopt: the controller starts in `Running` for attach mode, so a driver with
        // no process simply watches for commands and refuses all of them.
        None => lifecycle_driver.run(dsh::SupervisorSpawner::new(supervisor_config.clone())),
    });

    let uplink_task = match (relay, root) {
        (Some(relay_url), Some(root)) => {
            let room = dr_dsh_crypto::room_id_for(&root);
            let policy = device_policy()?;
            match &policy {
                transport::DevicePolicy::Enrolled(registry) if registry.is_empty() => println!(
                    "devices: none enrolled, and this daemon has been paired before — so \
                     nobody may connect. Run `drdshd pair` to enrol a device"
                ),
                transport::DevicePolicy::Enrolled(registry) => println!(
                    "devices: {} enrolled — every client must prove it is one of them",
                    registry.len()
                ),
                transport::DevicePolicy::RoomKeyOnly => println!(
                    "devices: none enrolled — any client holding the room key may connect \
                     (run `drdshd pair` to require a device)"
                ),
            }
            println!("room: {room} (the client derives the same id from the room key)");
            println!(
                "carrier keepalive: {} ({} = 0 turns it off)",
                match keepalive {
                    Some(every) => format!("a WebSocket ping every {}s", every.as_secs()),
                    None => "off".to_owned(),
                },
                uplink::ENV_KEEPALIVE_SECS,
            );
            let relay_url = relay_url.to_owned();
            let state = std::sync::Arc::clone(&relay_state);
            let mut stop = shutdown_rx.clone();
            let facts = control::DaemonFacts {
                // Tied to the mode rather than asserted: `owned` is the field a client reads to
                // decide whether the lifecycle buttons mean anything, so a daemon that said
                // `true` while refusing every operation would be contradicting itself in the
                // one place it must not. It said exactly that in attach mode until this was
                // found by running the control smoke against an attached DSH.
                owned: matches!(mode, lifecycle::Mode::Managed { .. }),
                // Shared with the uplink's own state callback, so a status answer reports where
                // the relay connection is *now* rather than where it was at startup.
                relay: std::sync::Arc::clone(&relay_state),
                lifecycle: lifecycle_handle.clone(),
                // Resolved here, at startup, and not per report: a daemon whose state directory
                // changed while it ran would be writing reports somewhere a person would not look.
                state_dir: state::state_dir()
                    .context("cannot locate the state directory for crash reports")?,
            };
            Some(tokio::spawn(async move {
                uplink::run(
                    uplink::CarrierConfig::new(
                        relay_url,
                        room,
                        root,
                        policy,
                        keepalive,
                        // The same directory the key and registry came from, resolved once at startup.
                        state_directory.clone(),
                    ),
                    move |next| {
                        println!("relay: {next:?}");
                        if let Ok(mut slot) = state.lock() {
                            *slot = next;
                        }
                    },
                    Box::pin(async move {
                        let _ = stop.changed().await;
                    }),
                    move |stream_id, payload, out: uplink::Outbox| {
                        // The proxy's own magic decides which plane a frame belongs to,
                        // not the stream id. A client may put a proxied request on any
                        // stream — the browser client uses one stream per request — and
                        // deciding by stream id meant such a request was parsed as a
                        // control message, failed to parse, and was dropped with no answer.
                        // A dropped request looks exactly like a hung daemon to the person
                        // waiting for it.
                        if !payload.starts_with(proxy::MAGIC) {
                            if stream_id == dr_dsh_proto::CONTROL_STREAM_ID {
                                // Cloned per request: the facts now carry a handle, and a
                                // handle is cheap to clone precisely so each request reads the
                                // state at the moment it is answered.
                                // The outbox is handed to the handler because a lifecycle
                                // command is answered from the driver, asynchronously — the
                                // handler cannot await it without delaying every frame behind
                                // it.
                                if let Some(reply) =
                                    control::handle(&payload, facts.clone(), out.clone())
                                {
                                    tokio::spawn(async move {
                                        let _ = out
                                            .send(uplink::Outbound {
                                                stream_id: dr_dsh_proto::CONTROL_STREAM_ID,
                                                payload: reply,
                                            })
                                            .await;
                                    });
                                }
                            } else {
                                tracing::debug!(stream = stream_id, "unrecognised stream content");
                            }
                            return;
                        }

                        let Some(proxy) = proxy.clone() else {
                            // A proxied request with no proxy configured is a deployment
                            // mistake, not a protocol one, so it is logged rather than
                            // silently dropped.
                            tracing::warn!(
                                stream = stream_id,
                                "a proxied request arrived but no proxy is configured"
                            );
                            return;
                        };
                        tokio::spawn(async move {
                            if let Err(error) = proxy.handle(stream_id, &payload, &out).await {
                                tracing::info!(stream = stream_id, %error, "proxied request failed");
                            }
                        });
                    },
                )
                .await
            }))
        }
        _ => None,
    };

    let mut lifecycle_watch_for_loop = lifecycle_task;
    // Ctrl-C is the operator's stop signal for the daemon. The exit watch that used to live
    // here belongs to the lifecycle driver now: it is what turns an unexpected exit into a
    // restart, and two watchers would race to decide whether DSH comes back.
    tokio::select! {
        signal = tokio::signal::ctrl_c() => {
            signal.context("cannot listen for Ctrl-C")?;
            println!("\nstopping DSH");
        }
        // The driver task ending means it has given up — its policy ran out, or it was
        // aborted. Either way there is nothing left to supervise, so the daemon stops
        // instead of staying up and reporting a DSH that will never come back.
        () = async {
            let _ = (&mut lifecycle_watch_for_loop).await;
        } => {
            println!("DSH could not be kept running; stopping the daemon");
        }
    }
    let _ = shutdown_tx.send(true);
    if let Some(task) = uplink_task {
        // A refusal is the uplink's way of saying "an operator must act"; report it
        // instead of swallowing it, and do not let it stop the local teardown.
        match task.await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => eprintln!("drdshd: uplink stopped: {error}"),
            Err(error) => eprintln!("drdshd: uplink task failed: {error}"),
        }
    }
    // The driver owns the process now, so the shutdown goes through it. Stopping the
    // supervisor directly here would leave the driver believing DSH was still running.
    let stopped = lifecycle_handle
        .command(dr_dsh_proto::control::LifecycleOp::Stop)
        .await;
    if !stopped.ok {
        eprintln!(
            "drdshd: DSH may not have stopped cleanly: {}",
            stopped
                .error
                .unwrap_or_else(|| "no reason given".to_owned())
        );
    }
    // The driver is done with: DSH is stopped and nothing should restart it.
    lifecycle_watch_for_loop.abort();
    println!("drdshd stopped");
    Ok(ExitCode::SUCCESS)
}

/// Decodes a room key from unpadded base64url.
///
/// The key is 32 bytes and is the *only* secret the two ends share, so a wrong
/// length is refused with the length stated rather than padded or truncated: a
/// silently truncated key would produce a session that fails to authenticate with
/// no hint why.
///
/// # Errors
///
/// Returns an error when the input is not base64url or is not 32 bytes.
pub fn decode_room_key(encoded: &str) -> anyhow::Result<[u8; dr_dsh_crypto::SESSION_KEY_LEN]> {
    use anyhow::Context as _;
    use base64::Engine as _;

    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded.trim())
        .context("the room key is not valid unpadded base64url")?;
    let length = bytes.len();
    bytes.try_into().map_err(|_| {
        anyhow::anyhow!(
            "the room key must be {} bytes ({} base64url characters), got {length} bytes",
            dr_dsh_crypto::SESSION_KEY_LEN,
            43
        )
    })
}

/// Writes one audit event.
///
/// Records an audit event: one line on stderr (where the daemon's other output goes) and one in the
/// audit log (ADR-0012).
///
/// Two destinations on purpose. The stderr line is for the person watching `drdshd pair` right now; the
/// file is the record that survives the terminal, and it is the one with a retention policy, a closed
/// event set, and no way to leave the machine.
///
/// `reason` is free text from an error, so it is sanitized and truncated before it reaches either
/// destination: an event that can be split across two lines stops being one event, and a log-injection
/// attempt turns a diagnostic into a fabricated record.
fn audit(
    directory: &std::path::Path,
    event: audit::Event,
    device_id: Option<&str>,
    outcome: audit::Outcome,
    reason: &str,
) {
    audit::record(directory, event, device_id, outcome, Some(reason));
    // stderr keeps the raw-ish text (sanitized the same way) because that is what the operator is
    // reading in the moment; the file is the record.
    let sanitised = audit::sanitize(reason);
    let name = event.as_str();
    match device_id {
        Some(id) => eprintln!("audit event={name} device={id} reason={sanitised}"),
        None => eprintln!("audit event={name} reason={sanitised}"),
    }
}

/// Refuses to start when something is already listening on DSH's port.
///
/// A best-effort check, and deliberately one that does not try to identify or kill the process:
/// the daemon must not terminate a process it does not own, and "something is listening" is
/// enough to explain the failure. A race remains — something could bind between this check and
/// DSH's own bind — and that race is harmless, because DSH's error is still the backstop.
///
/// # Errors
///
/// Returns an error naming the port and the two ways out.
fn ensure_port_free(port: u16) -> anyhow::Result<()> {
    match std::net::TcpListener::bind(("127.0.0.1", port)) {
        Ok(listener) => {
            drop(listener);
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => anyhow::bail!(
            "port {port} is already in use, so DSH cannot be started on it. Something is \
             listening there — most often a DSH from an earlier run whose daemon was killed \
             and which now holds the port on its own. Stop that process, or start this daemon \
             with `--attach {port}` to use the DSH that is already there"
        ),
        Err(error) => Err(anyhow::anyhow!(
            "cannot check whether port {port} is free: {error}"
        )),
    }
}

/// Decides which clients this daemon will accept.
///
/// Enrolment wins as soon as there is any: a daemon with one paired device requires proofs,
/// and does **not** also accept the room key, because "the room key still works" would make
/// pairing decorative. A daemon with no registry entry keeps serving the room key, which is
/// the documented path for a deployment that has never paired.
///
/// # Errors
///
/// Returns an error when the registry exists but cannot be read. Failing is the only safe
/// reading: treating an unreadable registry as "no devices" would turn a corrupted file into
/// an open door.
fn device_policy() -> anyhow::Result<transport::DevicePolicy> {
    use anyhow::Context as _;

    let state = state::state_dir().context("cannot locate the daemon's state directory")?;
    let registry_path = state::registry_path_in(&state);
    // The *file's existence* decides, not the number of devices in it.
    //
    // An empty registry means "nobody may connect", and that is the state reached by revoking the
    // last device. Treating it as "never paired" — which is what counting devices does — turns a
    // revocation into a grant: `drdshd devices --revoke <last>` would re-open the room-key door the
    // user was trying to close, and the command would have said "the device can no longer
    // connect". Only a daemon whose registry file was never created has never been paired.
    let paired = registry_path.exists();
    let registry = dr_dsh_crypto::DeviceRegistry::load(&registry_path).with_context(|| {
        format!(
            "cannot read the device registry at {}; fix or move it rather than deleting it, \
             because it is the only record of which devices may connect",
            registry_path.display()
        )
    })?;
    if paired {
        // Including the empty registry: it admits nobody, which is the correct reading of
        // "every device has been revoked".
        Ok(transport::DevicePolicy::enrolled(registry))
    } else {
        Ok(transport::DevicePolicy::RoomKeyOnly)
    }
}

/// Mints a pairing code, runs the exchange, and enrols the device that redeems it.
///
/// The code is printed before the relay is dialed, because the user has to read it off this
/// screen and type it into the other device while it is live. Waiting for a client before
/// showing the code would mean the user cannot start typing until a client has already
/// arrived — which is the wrong order for the only flow this command exists for.
///
/// # Errors
///
/// Returns an error when the relay cannot be reached, the exchange fails, or the registry
/// cannot be written. All three are operator-visible and none of them contains key material.
pub async fn pair_command(
    relay: Option<&str>,
    room_key: Option<&str>,
    wait: Option<std::time::Duration>,
) -> anyhow::Result<ExitCode> {
    use anyhow::Context as _;

    let Some(relay) = relay else {
        anyhow::bail!(
            "pairing needs --relay: the device that pairs is not on this machine, so the \
             exchange has to travel through the relay you will use afterwards"
        );
    };
    let state = state::state_dir().context("cannot locate the daemon's state directory")?;
    // The device is about to be handed the room key this daemon serves, so pairing needs to know it.
    // Resolved exactly the way `run` resolves it — same file, same generation rule (ADR-0013) — which
    // is what makes "give both commands the same key" stop being something an operator can get wrong.
    let resolved = roomkey::resolve(&state, room_key)?;
    let served_root = resolved.root;
    let registry_path = state::registry_path_in(&state);
    let throttle_path = state::throttle_path_in(&state);
    let registry = dr_dsh_crypto::DeviceRegistry::load(&registry_path).with_context(|| {
        format!(
            "cannot read the device registry at {}; fix or move it rather than deleting it, \
             because it is the only record of which devices may connect",
            registry_path.display()
        )
    })?;

    // The throttle is checked *before* a code is minted. Handing out a code and then refusing
    // the attempt would burn a code per refusal, which is the opposite of what a limiter is
    // for: the user would be locked out of their own machine by an attacker's traffic.
    let mut guard = dr_dsh_crypto::PairingGuard::load(&throttle_path).with_context(|| {
        format!(
            "cannot read the pairing throttle state at {}",
            throttle_path.display()
        )
    })?;
    let now = std::time::SystemTime::now();
    if let Err(throttled) = guard.check(now) {
        audit(
            &state,
            audit::Event::PairingRefused,
            None,
            audit::Outcome::Refused,
            &throttled.to_string(),
        );
        anyhow::bail!(
            "refusing to start a pairing: {throttled}. The throttle exists because a guess \
             costs a code, so an unbounded attacker would lock you out of your own machine \
             long before the odds moved. State: {}",
            throttle_path.display()
        );
    }

    let code = dr_dsh_crypto::pairing::PairingCode::generate();
    let pending = dr_dsh_crypto::pairing::PendingCode::new(code);
    println!("drdshd {} — pairing", env!("CARGO_PKG_VERSION"));
    for line in resolved.announcement() {
        println!("  {line}");
    }
    println!();
    println!("  code:  {}", pending.code().display_form());
    println!(
        "  valid: {} seconds, single use",
        pending.remaining().as_secs()
    );
    println!("  relay: {relay}");
    // The rendezvous room, so a client that mistyped the code can be told *that* rather than
    // "nobody is there". It is not a secret — it is derived one-way from the code, and the relay
    // sees it anyway — so printing it costs nothing and turns the most likely user error into a
    // sentence that names the actual mistake.
    println!("  room:  {}", pairing::pairing_room(pending.code()));
    println!();
    println!("Type that code on the device you are pairing. It is not sent anywhere: it is");
    println!("the secret both ends run the key exchange with, and it is burned by the first");
    println!("attempt, successful or not.");
    println!();

    let started = std::time::Instant::now();
    let timeout = wait.unwrap_or(pairing::DEFAULT_EXCHANGE_TIMEOUT);
    let outcome = pairing::run_daemon_side(
        relay,
        pending.code(),
        registry,
        &registry_path,
        &served_root,
        timeout,
    )
    .await;
    match outcome {
        Ok((enrolment, _registry)) => {
            guard.record_success();
            let _ = guard.save(&throttle_path);
            audit(
                &state,
                audit::Event::PairingAccepted,
                Some(&enrolment.device_id),
                audit::Outcome::Ok,
                &enrolment.label,
            );
            println!(
                "paired {} as {:?} in {:.1}s",
                enrolment.device_id,
                enrolment.label,
                started.elapsed().as_secs_f32()
            );
            println!(
                "the registry now holds {} device(s): {}",
                count_devices(&registry_path)?,
                registry_path.display()
            );
            Ok(ExitCode::SUCCESS)
        }
        Err(error) => {
            // The failure is recorded before anything else, so a crash between here and the
            // save cannot leave an attacker's attempts uncounted.
            let throttled = guard.record_failure(std::time::SystemTime::now()).err();
            let _ = guard.save(&throttle_path);
            audit(
                &state,
                audit::Event::PairingFailed,
                None,
                audit::Outcome::Failed,
                &error.to_string(),
            );
            if let Some(throttled) = throttled {
                audit(
                    &state,
                    audit::Event::PairingLockedOut,
                    None,
                    audit::Outcome::Refused,
                    &throttled.to_string(),
                );
                eprintln!("{throttled}");
            }
            // The code is gone either way, and saying so is the difference between a user
            // retrying the same code and a user asking for a new one.
            eprintln!("pairing failed: {error}");
            eprintln!("the code has been burned; run `drdshd pair` again for a new one");
            Ok(ExitCode::FAILURE)
        }
    }
}

/// How many devices a registry file holds, for the line pairing prints.
fn count_devices(path: &std::path::Path) -> anyhow::Result<usize> {
    Ok(dr_dsh_crypto::DeviceRegistry::load(path)?.len())
}

/// Redeems a pairing code as the device being enrolled.
///
/// The device half of pairing, and the reason it exists as a command: the browser cannot run
/// SPAKE2, so before this the flow had no counterpart — `drdshd pair` ran both sides and proved
/// only that the implementation agreed with itself.
///
/// What it writes is the whole result of enrolment: the device's private key (seed only), the
/// device id, and the room root key. Everything a later connection needs is in that file, which
/// is why the file is created `0600` and why nothing else is written beside it.
///
/// # Errors
///
/// Returns an error when the code is unusable, the relay cannot be reached, or the daemon refuses
/// the attempt.
pub async fn pair_as_device_command(
    relay: Option<&str>,
    code: Option<&str>,
    name: Option<&str>,
    out: Option<&std::path::Path>,
    rendezvous: Option<&str>,
) -> anyhow::Result<ExitCode> {
    use anyhow::Context as _;

    let Some(relay) = relay else {
        anyhow::bail!(
            "pairing needs --relay: it is the same relay the daemon was told about, and the \
             exchange travels through it"
        );
    };
    let Some(code) = code else {
        anyhow::bail!(
            "pairing needs --code: the value `drdshd pair` displayed, read off the daemon's screen"
        );
    };
    let name = name.unwrap_or("this device");

    let parsed = pairing::parse_displayed_code(code).map_err(|error| anyhow::anyhow!("{error}"))?;
    // The default location is under the state directory rather than the working directory: a
    // private key written to wherever the shell happened to be is a key that ends up in a
    // backup, a git repository, or a shared folder.
    let out = match out {
        Some(path) => path.to_path_buf(),
        None => {
            let state = state::state_dir().context("cannot locate the state directory")?;
            state.join("device.json")
        }
    };

    println!("pairing as {name:?} through {relay}");
    // `--rendezvous` is the room `drdshd pair` printed. Supplying it means a mistyped code fails
    // as "the code is wrong" instead of "nobody is serving that room", which are very different
    // things to tell someone who is standing at two machines.
    let enrolled = match rendezvous {
        Some(room) => {
            let root = pairing::pairing_root_for_test(&parsed);
            pairing::run_client_side_at(relay, &parsed, room, &root, name, PAIRING_WAIT).await
        }
        None => pairing::run_client_side(relay, &parsed, name, PAIRING_WAIT).await,
    }
    .map_err(|error| anyhow::anyhow!("pairing failed: {error}"))?;
    println!("paired as {}", enrolled.device_id);
    println!("room: {}", enrolled.room);

    let stored = serde_json::json!({
        "version": 1,
        "device_id": enrolled.device_id,
        // The seed, not the expanded key: it is the 32 bytes an Ed25519 key is made from, and
        // storing anything else would mean storing a second representation of the same secret.
        "private_key": effective_seed(&enrolled.identity),
        "root_key": enrolled.root_key.to_vec(),
        "room": enrolled.room,
        "name": name,
    });
    write_private(&out, &stored.to_string())?;
    println!("identity written to {}", out.display());
    println!();
    println!("That file is a credential: it is what this device proves itself with. It was");
    println!("written with 0600 permissions, and it should not be copied anywhere you would not");
    println!("copy a private key.");
    Ok(ExitCode::SUCCESS)
}

/// How long the device waits for the daemon during pairing.
const PAIRING_WAIT: std::time::Duration = std::time::Duration::from_secs(30);

/// The raw seed of a device key, as an array of bytes for storage.
fn effective_seed(identity: &dr_dsh_crypto::DeviceSecretKey) -> Vec<u8> {
    identity.to_bytes().to_vec()
}

/// Writes a file that only its owner may read.
///
/// Created with the mode rather than chmod-ed afterwards: a key that exists for a moment with
/// wider permissions has been readable for a moment, and on a shared machine that is enough.
fn write_private(path: &std::path::Path, contents: &str) -> anyhow::Result<()> {
    use anyhow::Context as _;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("cannot create {}", parent.display()))?;
    }
    #[cfg(unix)]
    {
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt as _;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .with_context(|| format!("cannot create {}", path.display()))?;
        file.write_all(contents.as_bytes())
            .with_context(|| format!("cannot write {}", path.display()))?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, contents)
            .with_context(|| format!("cannot write {}", path.display()))?;
    }
    Ok(())
}

/// Lists enrolled devices, or revokes one.
///
/// # Errors
///
/// Returns an error when the registry cannot be read or written.
pub fn devices_command(revoke: Option<&str>) -> anyhow::Result<ExitCode> {
    use anyhow::Context as _;

    let state = state::state_dir().context("cannot locate the daemon's state directory")?;
    let registry_path = state::registry_path_in(&state);
    let mut registry = dr_dsh_crypto::DeviceRegistry::load(&registry_path).with_context(|| {
        format!(
            "cannot read the device registry at {}",
            registry_path.display()
        )
    })?;

    if let Some(id) = revoke {
        let target = dr_dsh_crypto::device::DeviceId::from_base64url(id)
            .with_context(|| format!("{id:?} is not a device id"))?;
        if registry.revoke(&target) {
            registry.save(&registry_path)?;
            audit(
                &state,
                audit::Event::DeviceRevoked,
                Some(id),
                audit::Outcome::Ok,
                "revoked by an operator on this machine",
            );
            println!("revoked {id}");
            println!("the device keeps its key but can no longer connect: the challenge is gone");
        } else {
            audit(
                &state,
                audit::Event::DeviceRevoked,
                Some(id),
                audit::Outcome::Refused,
                "no device with that id is enrolled",
            );
            println!("no device with id {id} is enrolled; nothing changed");
        }
        return Ok(ExitCode::SUCCESS);
    }

    if registry.is_empty() {
        println!("no devices are enrolled, so this daemon serves nobody.");
        println!("run `drdshd pair` to enrol one.");
        return Ok(ExitCode::SUCCESS);
    }
    println!("{} device(s):", registry.len());
    for (id, device) in registry.devices() {
        println!("  {}  {}", id.to_base64url(), device.label);
    }
    Ok(ExitCode::SUCCESS)
}

/// Shows the crash reports clients sent, or deletes them.
///
/// The reporting *channel* is one hop — client to its own daemon — and this is the other end of it:
/// what the person who owns the machine can read. Reports are never uploaded, so without this
/// command the file would be a place data goes to be forgotten (`docs/security.md` § 5.10).
///
/// # Errors
///
/// Returns an error when the crash log cannot be read or deleted.
pub fn crashes_command(clear: bool) -> anyhow::Result<ExitCode> {
    use anyhow::Context as _;

    let state = state::state_dir().context("cannot locate the daemon's state directory")?;
    let path = crashlog::path_in(&state);

    if clear {
        let removed =
            crashlog::clear(&path).with_context(|| format!("cannot delete {}", path.display()))?;
        println!(
            "{}",
            if removed {
                format!("deleted {}", path.display())
            } else {
                format!("no crash reports at {}", path.display())
            }
        );
        return Ok(ExitCode::SUCCESS);
    }

    let reports =
        crashlog::list(&path).with_context(|| format!("cannot read {}", path.display()))?;
    if reports.is_empty() {
        println!("no crash reports (a client sends one when its own run failed).");
        println!("they are stored at {}", path.display());
        return Ok(ExitCode::SUCCESS);
    }
    println!("{} crash report(s) at {}:", reports.len(), path.display());
    for (index, line) in reports.iter().enumerate() {
        // Printed as stored, one per line: the point of the file is that a person can read it and
        // paste it into a bug report without a decoder.
        println!("  [{}] {line}", index + 1);
    }
    println!();
    println!("delete them with `drdshd crashes --clear`.");
    Ok(ExitCode::SUCCESS)
}

/// Shows the audit log, or deletes it.
///
/// The other end of the recording path (ADR-0012). Two things it must get right, because they are the
/// questions somebody reading this is actually asking:
///
/// * **"off" and "empty" are different answers.** `DSHD_AUDIT=0` means nothing was recorded; an empty
///   file means nothing happened. A reader that printed "no events" for both would turn a disabled audit
///   log into an alibi.
/// * **The retention window is applied on read too.** A machine whose daemon has not run for months
///   still has the file, and showing year-old entries would quietly disagree with the policy the daemon
///   enforces when it writes.
///
/// # Errors
///
/// Returns an error when the log cannot be read or deleted.
pub fn audit_command(clear: bool) -> anyhow::Result<ExitCode> {
    use anyhow::Context as _;

    let state = state::state_dir().context("cannot locate the daemon's state directory")?;
    let path = audit::path_in(&state);

    if clear {
        let removed =
            audit::clear(&path).with_context(|| format!("cannot delete {}", path.display()))?;
        println!(
            "{}",
            if removed {
                format!("deleted {}", path.display())
            } else {
                format!("no audit log at {}", path.display())
            }
        );
        return Ok(ExitCode::SUCCESS);
    }

    if !audit::enabled() {
        println!(
            "auditing is OFF in this environment ({} = 0), so nothing has been recorded.",
            audit::ENV_DISABLED
        );
        println!(
            "an existing log at {} is not shown while it is off.",
            path.display()
        );
        return Ok(ExitCode::SUCCESS);
    }

    let read = audit::read(&path).with_context(|| format!("cannot read {}", path.display()))?;
    if read.entries.is_empty() && read.unreadable.is_empty() {
        println!("no audit events.");
        println!("they are recorded at {}", path.display());
        if read.too_old > 0 {
            println!(
                "{} event(s) older than {} days are no longer shown; `drdshd audit --clear` removes them.",
                read.too_old,
                audit::MAX_AGE.as_secs() / 86_400
            );
        }
        return Ok(ExitCode::SUCCESS);
    }

    println!(
        "{} audit event(s) at {} (keeping {} days / {} lines, newest last):",
        read.entries.len(),
        path.display(),
        audit::MAX_AGE.as_secs() / 86_400,
        audit::MAX_LINES
    );
    for line in &read.entries {
        match audit::parse_entry(line) {
            Some(entry) => println!(
                "  {} {:<20} {:<8} {}{}",
                describe_time(entry.at_ms),
                entry.event.as_str(),
                entry.outcome.as_str(),
                entry.device.as_deref().unwrap_or("-"),
                entry
                    .reason
                    .as_deref()
                    .map(|reason| format!("  {reason}"))
                    .unwrap_or_default()
            ),
            // Printed rather than hidden: a line this version cannot parse is evidence, and the audit
            // log is the last place to silently drop something.
            None => println!("  (unreadable) {line}"),
        }
    }
    if read.too_old > 0 {
        println!(
            "{} event(s) older than {} days are no longer shown; `drdshd audit --clear` removes them.",
            read.too_old,
            audit::MAX_AGE.as_secs() / 86_400
        );
    }
    println!();
    println!("delete them with `drdshd audit --clear`. Nothing here was ever sent anywhere.");
    Ok(ExitCode::SUCCESS)
}

/// Renders a millisecond timestamp as UTC, `YYYY-MM-DDTHH:MM:SSZ`.
///
/// Hand-rolled rather than pulled from a date crate: this is twenty lines of well-known arithmetic
/// (`days_from_civil`'s inverse), and a date library in the daemon is a dependency the audit log — the
/// component that exists to be trustworthy about *when* something happened — would then depend on for
/// its only use of dates. The format is UTC with an explicit `Z` so there is no ambiguity about the
/// zone, which is the one thing a reader of an audit log must not have to guess.
#[must_use]
fn describe_time(at_ms: u64) -> String {
    let seconds = (at_ms / 1000) as i64;
    let days = seconds.div_euclid(86_400);
    let of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        of_day / 3600,
        (of_day % 3600) / 60,
        of_day % 60
    )
}

/// Days since 1970-01-01 to a civil date.
///
/// Howard Hinnant's algorithm, shifted to an era starting in March so leap days land at the end of the
/// year — which is what makes the month arithmetic below a division instead of a table.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_prime + 2) / 5 + 1) as u32;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    } as u32;
    (year + i64::from(month <= 2), month, day)
}

/// Generates a fresh room key and prints it.
///
/// The **fallback** path now that pairing exists (`drdshd pair`): a room key is one shared
/// secret with no per-device revocation and no forward secrecy, which is what device keys
/// replace. It is kept because a deployment that has not paired yet must still be able to
/// run, and because it is the simplest thing to reason about while debugging a tunnel.
pub fn print_room_key() -> ExitCode {
    use base64::Engine as _;

    let key = dr_dsh_crypto::connection_salt();
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key);
    println!("{encoded}");
    eprintln!();
    ExitCode::SUCCESS
}

#[cfg(test)]
mod time_tests {
    /// The audit log's timestamps are read by people, so the arithmetic gets a test rather than trust.
    #[test]
    fn audit_timestamps_are_utc_and_correct() {
        // The epoch, a known recent instant, and a leap day: the three cases a hand-rolled calendar
        // gets wrong (off-by-one at the epoch, the era shift, and February 29).
        assert_eq!(super::describe_time(0), "1970-01-01T00:00:00Z");
        assert_eq!(
            super::describe_time(1_700_000_000_000),
            "2023-11-14T22:13:20Z"
        );
        assert_eq!(
            super::describe_time(951_782_400_000),
            "2000-02-29T00:00:00Z"
        );
        // A date before the epoch is representable in a corrupted file; it must not panic.
        assert_eq!(super::describe_time(1), "1970-01-01T00:00:00Z");
        // Checked against the inverse formula rather than by hand: the extreme only has to prove the
        // arithmetic does not wrap or panic, not that anybody will ever read it.
        assert_eq!(super::describe_time(u64::MAX), "584556019-04-03T14:25:51Z");
    }
}
