//! Pre-flight diagnosis: the checks that catch the failures users hit first.
//!
//! Every check here exists because it is a real support question for a daemon
//! that runs on someone else's machine: "is DSH even installed", "is that port
//! mine or someone else's", "will the daemon be able to bind loopback". The
//! output is deliberately boring and grep-able, and each failure names the fix.
//!
//! Scope note: `doctor` never starts DSH and never writes configuration. It is
//! safe to run at any time, including while a DSH instance is serving.

use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};
use std::path::Path;
use std::process::{Command, ExitCode, Stdio};

use anyhow::Result;

/// The port DSH's web profile listens on unless configured otherwise.
const DEFAULT_DSH_PORT: u16 = 3080;

/// Result of one check, in increasing severity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Level {
    Pass,
    Warn,
    Fail,
}

impl Level {
    fn marker(self) -> &'static str {
        match self {
            Self::Pass => "ok  ",
            Self::Warn => "warn",
            Self::Fail => "FAIL",
        }
    }
}

/// Runs every check, prints a report, and returns the process exit code.
///
/// # Errors
///
/// Only for I/O the operator cannot act on; failed checks are reported in the
/// output, not as errors, so a `doctor` run always produces a readable report.
pub fn run(dsh: Option<&Path>, port: Option<u16>) -> Result<ExitCode> {
    let port = port.unwrap_or(DEFAULT_DSH_PORT);
    let mut worst = Level::Pass;

    print_check(check_platform(), &mut worst);
    print_check(check_cpu(), &mut worst);
    print_check(check_audit(), &mut worst);
    print_check(check_loopback_available(port), &mut worst);
    print_check(check_dsh_binary(dsh), &mut worst);

    println!();
    match worst {
        Level::Pass => {
            println!("All checks passed. `drdshd run` should be able to start DSH.");
            Ok(ExitCode::SUCCESS)
        }
        Level::Warn => {
            println!("Checks passed with warnings. Review them before pairing a device.");
            Ok(ExitCode::SUCCESS)
        }
        Level::Fail => {
            println!("At least one check failed; fix it before running the daemon.");
            Ok(ExitCode::FAILURE)
        }
    }
}

fn print_check(check: (Level, String), worst: &mut Level) {
    let (level, message) = check;
    if level == Level::Fail || (*worst == Level::Pass && level == Level::Warn) {
        *worst = level;
    }
    println!("[{}] {}", level.marker(), message);
}

/// Reports the platform so bug reports carry it without being asked.
fn check_platform() -> (Level, String) {
    (
        Level::Pass,
        format!(
            "platform {} {} ({})",
            std::env::consts::OS,
            std::env::consts::ARCH,
            std::env::consts::FAMILY
        ),
    )
}

/// Reports what this machine's CPU is, and whether the instructions in this build are safe on it.
///
/// M5 asks for an install path on old hardware, and the first question of that path is "which
/// instructions does this build need?" — a question no installer can answer by looking at the binary,
/// and one that a person on a 2008 laptop needs answered *before* they spend an evening on it.
///
/// The honest answer has two halves:
///
/// * This build is compiled for the **baseline** of its architecture (x86-64 baseline on x86-64,
///   armv8-a on aarch64) — no `target-cpu=native`, no `+avx2`. A binary that merely *contains*
///   AVX instructions in a runtime-detected path is still baseline-safe, so the presence of vector
///   code would not be a failure by itself; the check that matters is that a build never *requires*
///   a feature the CPU lacks, and that is measured by running the shipped binaries under an emulated
///   2006/2008-class CPU (`scripts/cpu-baseline-smoke.mjs`).
/// * The features reported here are what the running process can see, which is what a bug report
///   needs in order to be about the right machine.
///
/// This check never fails: an old CPU is not a misconfiguration, and a doctor that refused to pass on
/// a machine the daemon demonstrably runs on would be wrong.
fn check_cpu() -> (Level, String) {
    (
        Level::Pass,
        format!(
            "cpu: {}, built for its baseline (no AVX2 or AES-NI required){}",
            std::env::consts::ARCH,
            cpu_extension_detail()
        ),
    )
}

/// The extensions this process can see, for the machines where their absence would matter.
#[cfg(target_arch = "x86_64")]
fn cpu_extension_detail() -> String {
    // Named rather than listed wholesale: these are the extensions whose absence breaks a build that
    // was compiled with them turned on, and reporting forty feature names would bury them.
    let features = [
        ("sse4.2", is_x86_feature_detected!("sse4.2")),
        ("avx", is_x86_feature_detected!("avx")),
        ("avx2", is_x86_feature_detected!("avx2")),
        ("aes", is_x86_feature_detected!("aes")),
        ("sha", is_x86_feature_detected!("sha")),
    ];
    let names = |wanted: bool| -> String {
        let found: Vec<&str> = features
            .iter()
            .filter(|(_, present)| *present == wanted)
            .map(|(name, _)| *name)
            .collect();
        if found.is_empty() {
            "none".to_owned()
        } else {
            found.join(", ")
        }
    };
    format!(
        "; extensions present: {}; absent: {}",
        names(true),
        names(false)
    )
}

/// Empty elsewhere: on aarch64 there is no comparable list worth naming, and inventing one would be
/// a claim this check cannot support.
#[cfg(not(target_arch = "x86_64"))]
fn cpu_extension_detail() -> String {
    String::new()
}

/// Reports whether the audit log is being written, and how much is in it.
///
/// ADR-0012 says a failed write warns once and shows up in `doctor`. It matters because the failure is
/// invisible by design: recording is best effort so that a full disk cannot stop the tunnel, which means
/// "there is no audit log" is a state only this command can reveal.
///
/// Never fails: a machine that has never paired anything has nothing to audit, and reporting that as a
/// problem would train people to ignore the check.
fn check_audit() -> (Level, String) {
    if !crate::audit::enabled() {
        return (
            Level::Warn,
            format!(
                "audit log: off ({} = 0); nothing about who connected is being recorded",
                crate::audit::ENV_DISABLED
            ),
        );
    }
    let Ok(state) = crate::state::state_dir() else {
        return (
            Level::Warn,
            "audit log: cannot locate the state directory".to_owned(),
        );
    };
    let path = crate::audit::path_in(&state);
    match crate::audit::read(&path) {
        Ok(read) => {
            let total = read.entries.len() + read.unreadable.len();
            if total == 0 {
                return (
                    Level::Pass,
                    format!("audit log: empty ({})", path.display()),
                );
            }
            let last = read
                .entries
                .last()
                .and_then(|line| crate::audit::parse_entry(line))
                .map_or_else(
                    || "unknown".to_owned(),
                    |entry| format!("{} ({})", entry.event.as_str(), entry.outcome.as_str()),
                );
            let note = if read.unreadable.is_empty() {
                String::new()
            } else {
                format!(", {} unreadable line(s)", read.unreadable.len())
            };
            (
                Level::Pass,
                format!(
                    "audit log: {total} event(s) at {}, last {last}{note}",
                    path.display()
                ),
            )
        }
        Err(error) => (
            Level::Warn,
            format!(
                "audit log: cannot read {} ({error}); events may not be recorded",
                path.display()
            ),
        ),
    }
}

/// Verifies the daemon can bind the loopback port DSH would use.
///
/// A port already in use is not automatically a failure: it usually means a DSH
/// instance is running, which is exactly attach mode. It is reported as a
/// warning with the two legitimate interpretations rather than as an error.
fn check_loopback_available(port: u16) -> (Level, String) {
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    match TcpListener::bind(addr) {
        Ok(listener) => {
            drop(listener);
            (
                Level::Pass,
                format!("loopback {addr} is free; the daemon can own DSH's port"),
            )
        }
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => (
            Level::Warn,
            format!(
                "loopback {addr} is already in use: a DSH instance may already be running \
                 (the daemon will attach to it in proxy-only mode), or another program holds the port"
            ),
        ),
        Err(error) => (Level::Fail, format!("cannot bind loopback {addr}: {error}")),
    }
}

/// Confirms a DSH executable exists and answers `--version`.
fn check_dsh_binary(explicit: Option<&Path>) -> (Level, String) {
    let executable = explicit.map_or_else(|| std::ffi::OsString::from("dsh"), |path| path.into());
    match Command::new(&executable)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
    {
        Ok(output) if output.status.success() => {
            let version = String::from_utf8_lossy(&output.stdout);
            let version = version.trim();
            (
                Level::Pass,
                format!("found {} ({version})", executable.to_string_lossy()),
            )
        }
        Ok(output) => (
            Level::Warn,
            format!(
                "{} answered --version with exit code {}; check the installation",
                executable.to_string_lossy(),
                output.status
            ),
        ),
        Err(error) => (
            Level::Fail,
            format!(
                "cannot run {}: {error}; install DSH (npx @deepseek-ai/dsh) or pass --dsh <path>",
                executable.to_string_lossy()
            ),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The CPU line must keep reporting the baseline claim, not merely "a cpu".
    ///
    /// It is the first thing that answers "will this build run on my machine" (M5's old-CPU item), and
    /// a line that quietly degraded to the architecture name would still look like a passing check.
    #[test]
    fn the_cpu_check_names_the_baseline() {
        let (level, message) = check_cpu();
        assert_eq!(level, Level::Pass, "an old CPU is not a misconfiguration");
        assert!(message.contains("cpu: "), "{message}");
        assert!(message.contains("baseline"), "{message}");
        #[cfg(target_arch = "x86_64")]
        assert!(
            message.contains("absent:"),
            "the report has to say what is missing as well as what is present: {message}"
        );
    }

    /// The emulated-CPU smoke asserts on this line, so the shape it greps for is pinned here.
    #[test]
    fn the_cpu_check_is_machine_readable_enough_for_the_smoke() {
        let (_, message) = check_cpu();
        assert!(message.starts_with("cpu: "), "{message}");
        assert_eq!(message.matches("cpu: ").count(), 1, "{message}");
    }
}
