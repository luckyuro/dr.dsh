//! # drdsh-relay — the zero-knowledge relay
//!
//! The relay exists so that neither side needs a public address. A daemon dials
//! in and parks on a room; clients dial in and ask for that room; the relay
//! splices frames between them. That is the entire design, and its poverty is
//! the point.
//!
//! ## What the relay can see
//!
//! * Room ids and which connections belong to them.
//! * Frame headers: type, stream id, payload length.
//! * Payload lengths and timing.
//!
//! ## What the relay cannot see
//!
//! * Payload bytes — they are end-to-end encrypted before they reach it.
//! * Lifecycle commands, session content, device names, file paths.
//! * Anything durable: the relay holds no database and writes no payload to
//!   disk. There is nothing to subpoena and nothing to leak (§ 5, § 9.6).
//!
//! ## How that claim is kept honest
//!
//! * This crate does not depend on `dr-dsh-crypto` or `dr-dsh-proto::control`, and it
//!   never will without an ADR (ADR-0002). The absence of the capability is the
//!   guarantee.
//! * It does not depend on any DSH package, so it cannot grow a "small feature"
//!   that inspects harness traffic.
//! * `cargo tree -p dr-dsh-relay` is part of code review for any dependency change.
//!
//! ## Status: M0
//!
//! The ingress is implemented: `/healthz`, the static shell, `/ws/daemon`, and
//! `/ws/client` with the room registry behind them. A daemon and a client can
//! park on the same room and exchange frames through it; the frames are validated
//! as carrier frames and forwarded byte for byte.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use std::process::ExitCode;

/// The client's shell and modules, served to a browser.
pub mod assets;
/// Relay configuration: bind address, limits, and the optional health surface.
pub mod config;
/// The network surface: health, the static shell, and the two socket endpoints.
pub mod ingress;
/// Room registry and frame routing: the whole data path.
pub mod rooms;

/// Runs the relay until it is stopped.
///
/// The runtime is created here rather than in the binary so both the shipped
/// binary and any embedder get the same multi-threaded setup: a relay serving two
/// sockets per room has nothing to gain from a current-thread runtime.
#[must_use]
pub fn run() -> ExitCode {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("drdsh-relay: cannot start the runtime: {error}");
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(run_async()) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("drdsh-relay: {error:#}");
            ExitCode::FAILURE
        }
    }
}

async fn run_async() -> anyhow::Result<ExitCode> {
    let config = config::Config::from_env_and_args()?;
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(true)
        .init();
    println!(
        "drdsh-relay {} — wire {}.{}, listening on {}",
        env!("CARGO_PKG_VERSION"),
        dr_dsh_proto::WIRE_MAJOR,
        dr_dsh_proto::WIRE_MINOR,
        config.bind
    );
    println!(
        "The relay forwards ciphertext only: it cannot read session content, \
         and it persists nothing. See docs/security.md."
    );
    // The deployment check the relay can make on its own (M4). Printed rather than logged: it is
    // advice for the person who started the process, and `RUST_LOG` must not be able to hide it.
    if let Some(notice) = config.bind_notice() {
        println!("warning: {notice}");
    }
    ingress::serve(config).await?;
    Ok(ExitCode::SUCCESS)
}
