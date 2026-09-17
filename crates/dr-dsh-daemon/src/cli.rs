//! Command-line surface of the daemon.
//!
//! Four verbs, small enough to parse in-process without pulling a parser crate
//! into a binary that runs on machines we cannot debug remotely:
//!
//! ```text
//! drdshd run      [--config <path>] [--relay <url>]   run the daemon (default)
//! drdshd pair     [--config <path>] [--relay <url>] [--room-key <key>]
//!                                                   mint a one-time pairing code
//! drdshd devices  [--revoke <id>]                     list or revoke paired devices
//! drdshd crashes  [--clear]                           show or delete client crash reports
//! drdshd audit    [--clear]                           show or delete the local audit log
//! drdshd doctor   [--dsh <path>] [--port <port>]      check this machine's setup
//! drdshd version                                      print version and protocol
//! ```

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{Context as _, Result, bail};

/// What the operator asked for.
#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    /// Run the daemon in the foreground.
    Run {
        /// Configuration file to load; the default location is used when absent.
        config: Option<PathBuf>,
        /// Relay URL overriding the configuration file.
        relay: Option<String>,
        /// Port DSH is started on. Chosen by the operator, never by a peer.
        port: Option<u16>,
        /// The room key both ends share; the tunnel's only secret until M1.
        room_key: Option<String>,
        /// Attach to a DSH that is already running on this port.
        attach: Option<u16>,
        /// The process token the attached DSH printed, for reaching its interface.
        attach_token: Option<String>,
    },
    /// Mint a single-use pairing code and enrol the device that redeems it.
    Pair {
        /// Configuration file to load.
        config: Option<PathBuf>,
        /// Relay URL overriding the configuration file.
        relay: Option<String>,
        /// The room key the daemon serves, which the receipt hands to the device.
        room_key: Option<String>,
        /// How long to wait for the device to redeem the code.
        wait: Option<std::time::Duration>,
    },
    /// Redeem a pairing code as the *device* being enrolled.
    ///
    /// The other half of `drdshd pair`: that command runs the daemon, this one runs the device, and
    /// between them a real pairing happens end to end. It exists because the browser cannot run
    /// SPAKE2 (see `dr_dsh_crypto::pairing`), so the pairing flow had no client at all — only two
    /// halves of one process talking to itself.
    PairAsDevice {
        /// Relay URL, as the daemon printed it.
        relay: Option<String>,
        /// The code the daemon displayed.
        code: Option<String>,
        /// Label for this device, so a person can recognise it in `drdshd devices`.
        name: Option<String>,
        /// Where to write the enrolled identity.
        out: Option<PathBuf>,
        /// The rendezvous room `drdshd pair` printed, so a mistyped code fails as a wrong code.
        rendezvous: Option<String>,
    },
    /// List enrolled devices, or revoke one.
    Devices {
        /// Device id to revoke instead of listing.
        revoke: Option<String>,
    },
    /// Show the crash reports clients sent, or delete them.
    Crashes {
        /// Delete every stored report instead of printing them.
        clear: bool,
    },
    /// Show the audit log, or delete it.
    Audit {
        /// Delete the log instead of printing it.
        clear: bool,
    },
    /// Diagnose this machine before the user files a bug.
    Doctor {
        /// DSH executable to check instead of the one found on `PATH`.
        dsh: Option<PathBuf>,
        /// Port to probe instead of the configured default.
        port: Option<u16>,
    },
    /// Print version and protocol numbers.
    Version,
    /// Generate a fresh room key for a daemon and its devices.
    RoomKey,
}

/// Parses arguments (without the program name) into a [`Command`].
///
/// # Errors
///
/// Returns an error for an unknown verb, an unknown flag, or a flag without its
/// value. `--help` is handled by the caller, not here.
pub fn parse(args: impl IntoIterator<Item = OsString>) -> Result<Command> {
    let mut args = args.into_iter();
    let Some(verb) = args.next() else {
        // Bare `drdshd` runs the daemon: that is what a systemd unit or a login
        // item invokes, and it must not require arguments.
        return Ok(Command::Run {
            config: None,
            relay: None,
            port: None,
            room_key: None,
            attach: None,
            attach_token: None,
        });
    };
    let verb = verb.to_string_lossy().into_owned();
    let mut config = None;
    let mut relay = None;
    let mut dsh = None;
    let mut port = None;
    let mut room_key = None;
    let mut revoke = None;
    let mut clear = false;
    let mut wait = None;
    let mut attach = None;
    let mut attach_token = None;
    let mut code = None;
    let mut name = None;
    let mut out = None;
    let mut rendezvous = None;
    while let Some(flag) = args.next() {
        let flag = flag.to_string_lossy().into_owned();
        match flag.as_str() {
            "--config" => config = Some(PathBuf::from(next_value(&mut args, "--config")?)),
            "--relay" => relay = Some(next_value(&mut args, "--relay")?),
            "--room-key" => room_key = Some(next_value(&mut args, "--room-key")?),
            "--revoke" => revoke = Some(next_value(&mut args, "--revoke")?),
            "--clear" => clear = true,
            "--wait" => {
                let value = next_value(&mut args, "--wait")?;
                let seconds = value.parse::<u64>().map_err(|error| {
                    anyhow::anyhow!("--wait expects a number of seconds, got {value:?}: {error}")
                })?;
                wait = Some(std::time::Duration::from_secs(seconds));
            }
            "--dsh" => dsh = Some(PathBuf::from(next_value(&mut args, "--dsh")?)),
            "--attach" => {
                let value = next_value(&mut args, "--attach")?;
                attach = Some(value.parse::<u16>().map_err(|error| {
                    anyhow::anyhow!("--attach expects a port number, got {value:?}: {error}")
                })?);
            }
            "--attach-token" => attach_token = Some(next_value(&mut args, "--attach-token")?),
            "--code" => code = Some(next_value(&mut args, "--code")?),
            "--name" => name = Some(next_value(&mut args, "--name")?),
            "--out" => out = Some(PathBuf::from(next_value(&mut args, "--out")?)),
            "--rendezvous" => rendezvous = Some(next_value(&mut args, "--rendezvous")?),
            "--port" => {
                let value = next_value(&mut args, "--port")?;
                port = Some(value.parse::<u16>().map_err(|error| {
                    anyhow::anyhow!("--port expects a number, got {value:?}: {error}")
                })?);
            }
            other => bail!("unknown flag {other:?}; run `drdshd --help`"),
        }
    }
    Ok(match verb.as_str() {
        "run" => Command::Run {
            config,
            relay,
            port,
            room_key,
            attach,
            attach_token,
        },
        "pair" => Command::Pair {
            config,
            relay,
            room_key,
            wait,
        },
        "pair-as-device" => Command::PairAsDevice {
            relay,
            code,
            name,
            out,
            rendezvous,
        },
        "devices" => Command::Devices { revoke },
        "crashes" => Command::Crashes { clear },
        "audit" => Command::Audit { clear },
        "doctor" => Command::Doctor { dsh, port },
        "version" => Command::Version,
        "room-key" => Command::RoomKey,
        other => {
            bail!(
                "unknown command {other:?}; expected run, pair, pair-as-device, devices, crashes, \
                 audit, room-key, doctor, or version"
            )
        }
    })
}

fn next_value(args: &mut impl Iterator<Item = OsString>, flag: &str) -> Result<String> {
    match args.next() {
        Some(value) => Ok(value.to_string_lossy().into_owned()),
        None => bail!("{flag} needs a value"),
    }
}

/// Entry point used by `main`.
pub fn run() -> Result<ExitCode> {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    run_with_args(args)
}

/// Runs daemon commands supplied by the multicall CLI, without changing process arguments.
pub fn run_with_args(args: Vec<OsString>) -> Result<ExitCode> {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print!("{}", help_text());
        return Ok(ExitCode::SUCCESS);
    }
    match parse(args)? {
        Command::Version => {
            println!(
                "drdshd {} (wire protocol {}.{})",
                env!("CARGO_PKG_VERSION"),
                dr_dsh_proto::WIRE_MAJOR,
                dr_dsh_proto::WIRE_MINOR
            );
            Ok(ExitCode::SUCCESS)
        }
        Command::Doctor { dsh, port } => crate::doctor::run(dsh.as_deref(), port),
        Command::Pair {
            relay,
            room_key,
            wait,
            ..
        } => {
            // Pairing talks to the relay, so it needs a runtime just as `run` does.
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .context("cannot start a runtime for pairing")?;
            runtime.block_on(crate::pair_command(
                relay.as_deref(),
                room_key.as_deref(),
                wait,
            ))
        }
        Command::PairAsDevice {
            relay,
            code,
            name,
            out,
            rendezvous,
        } => {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .context("cannot start a runtime for pairing")?;
            runtime.block_on(crate::pair_as_device_command(
                relay.as_deref(),
                code.as_deref(),
                name.as_deref(),
                out.as_deref(),
                rendezvous.as_deref(),
            ))
        }
        Command::Devices { revoke } => crate::devices_command(revoke.as_deref()),
        Command::Crashes { clear } => crate::crashes_command(clear),
        Command::Audit { clear } => crate::audit_command(clear),
        Command::RoomKey => Ok(crate::print_room_key()),
        Command::Run {
            config,
            relay,
            port,
            room_key,
            attach,
            attach_token,
        } => {
            // The daemon is a long-running supervisor, so it needs a runtime
            // rather than a bare `main`. Current-thread would be enough today and
            // is not enough the moment two clients are proxied at once.
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .context("cannot start the async runtime")?;
            runtime.block_on(crate::run_command(
                config.as_deref(),
                relay.as_deref(),
                port,
                room_key.as_deref(),
                attach,
                attach_token.as_deref(),
            ))
        }
    }
}

/// The `--help` text, kept next to the parser so the two cannot drift.
#[must_use]
pub fn help_text() -> String {
    let mut text = String::from(
        "drdshd — dr.dsh local daemon\n\
         \n\
         USAGE:\n    drdshd [run] [--config <path>] [--relay <url>] [--port <port>]\n\
         \x20   drdshd run --relay <url> --room-key <key>\n\
         \x20   drdshd run --attach <port> [--attach-token <token>]\n\
         \x20   drdshd room-key\n\
         \x20   drdshd pair [--config <path>] [--relay <url>] [--room-key <key>]\n\
         \x20             [--wait <seconds>]\n\
         \x20   drdshd devices [--revoke <device-id>]\n\
         \x20   drdshd crashes [--clear]\n\
         \x20   drdshd audit [--clear]\n\
         \x20   drdshd doctor [--dsh <path>] [--port <port>]\n\
         \x20   drdshd version\n\
         \n\
         The daemon supervises the local DSH instance, keeps it bound to loopback,\n\
         and dials out to a relay. It never listens on a public interface.\n\
         \n\
         OPTIONS:\n\
         \x20   --config <path>   configuration file (default: the platform config dir)\n\
         \x20   --relay <url>     ws:// or wss:// relay to dial, overriding the configuration file\n\
         \x20   --room-key <key>  the shared key that encrypts the tunnel; by default it is read\n\
         \x20                     from, or generated into, the state directory (ADR-0013)\n\
         \x20   --port <port>     port DSH is started on (default 3080)\n\
         \x20   --dsh <path>      DSH executable to check (doctor only)\n\
         \x20   --port <port>     DSH port to probe (doctor only)\n\
         \x20   -h, --help        print this help\n",
    );
    text.push_str(&format!(
        "\nPROTOCOL:\n    wire {}.{}, pairing code TTL {}s\n",
        dr_dsh_proto::WIRE_MAJOR,
        dr_dsh_proto::WIRE_MINOR,
        dr_dsh_proto::PAIRING_CODE_TTL_SECS
    ));
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_str(args: &[&str]) -> Result<Command> {
        parse(args.iter().map(OsString::from))
    }

    /// Tests return `Result` so a failed precondition fails with a message
    /// instead of a panic (clippy denies `unwrap`/`expect` workspace-wide).
    type TestResult = Result<(), Box<dyn std::error::Error>>;

    #[test]
    fn bare_invocation_runs_the_daemon() -> TestResult {
        assert_eq!(
            parse_str(&[])?,
            Command::Run {
                config: None,
                relay: None,
                port: None,
                room_key: None,
                attach: None,
                attach_token: None,
            }
        );
        Ok(())
    }

    #[test]
    fn run_accepts_a_port() -> TestResult {
        assert_eq!(
            parse_str(&["run", "--port", "46120"])?,
            Command::Run {
                config: None,
                relay: None,
                port: Some(46_120),
                attach: None,
                attach_token: None,
                room_key: None,
            }
        );
        Ok(())
    }

    #[test]
    fn run_accepts_a_relay_and_a_room_key() -> TestResult {
        assert_eq!(
            parse_str(&["run", "--relay", "wss://r.example", "--room-key", "abc"])?,
            Command::Run {
                config: None,
                relay: Some("wss://r.example".to_owned()),
                port: None,
                attach: None,
                attach_token: None,
                room_key: Some("abc".to_owned()),
            }
        );
        Ok(())
    }

    #[test]
    fn the_room_key_verb_needs_no_arguments() -> TestResult {
        assert_eq!(parse_str(&["room-key"])?, Command::RoomKey);
        Ok(())
    }

    #[test]
    fn run_accepts_config_and_relay() -> TestResult {
        assert_eq!(
            parse_str(&[
                "run",
                "--config",
                "/etc/drdshd.toml",
                "--relay",
                "wss://r.example"
            ])?,
            Command::Run {
                config: Some(PathBuf::from("/etc/drdshd.toml")),
                relay: Some("wss://r.example".to_owned()),
                port: None,
                room_key: None,
                attach: None,
                attach_token: None,
            }
        );
        Ok(())
    }

    #[test]
    fn unknown_verb_is_rejected() {
        assert!(parse_str(&["frobnicate"]).is_err());
    }

    #[test]
    fn flag_without_value_is_rejected() {
        assert!(parse_str(&["run", "--config"]).is_err());
    }

    #[test]
    fn doctor_rejects_a_non_numeric_port() {
        assert!(parse_str(&["doctor", "--port", "http"]).is_err());
    }
}
