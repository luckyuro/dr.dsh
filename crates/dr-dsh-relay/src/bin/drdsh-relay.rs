//! The `drdsh-relay` binary.
//!
//! A thin wrapper: the relay's behaviour lives in the `dr-dsh-relay` library so the
//! integration tests drive exactly what the shipped binary runs.

use std::process::ExitCode;

fn main() -> ExitCode {
    dr_dsh_relay::run()
}
