//! The `drdshd` binary.
//!
//! A thin wrapper: everything the daemon does lives in the `dr-dsh-daemon` library,
//! so the integration tests can drive the same code the shipped binary runs.

use std::process::ExitCode;

fn main() -> ExitCode {
    match dr_dsh_daemon::cli::run() {
        Ok(code) => code,
        Err(error) => {
            // Startup failures are the most common support burden for a daemon
            // users cannot see; print the whole chain, not just the leaf.
            eprintln!("drdshd: {error:#}");
            ExitCode::FAILURE
        }
    }
}
