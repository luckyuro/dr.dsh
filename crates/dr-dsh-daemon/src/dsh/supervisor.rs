//! Spawning and watching the DSH child process.
//!
//! # What this module is responsible for
//!
//! Starting `dsh web` on a port the daemon chooses, waiting for the readiness
//! line, keeping the child's output in the daemon's log, and stopping it the way
//! DSH expects (SIGTERM, then DSH's own bounded grace period — see
//! `docs/integration/dsh-surface.md` § 5).
//!
//! # What it deliberately does not do
//!
//! It does not retry, restart, or back off. Those are policy, they interact with
//! state reporting and with the remote client's UI, and they belong to the layer
//! above (`docs/architecture.md` § 4). This module answers one question — "is
//! there a DSH process, and where" — and reports failures rather than hiding them.
//!
//! # The loopback guarantee
//!
//! [`SupervisorConfig`] has no `host` field and no arbitrary-argument field. The
//! command line is assembled here from a port the daemon picked, and the child is
//! additionally verified to have announced a loopback address before the
//! supervisor reports success. Both halves matter: the first makes a
//! non-loopback bind unrepresentable, the second catches a DSH that ignored us.

use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt as _, BufReader};
use tokio::process::{Child, Command};

use super::ready::{ReadyLine, ReadyParseError};

/// How long to wait for the readiness line before declaring the start failed.
///
/// DSH boots a plugin tree; on a cold cache that is seconds, on a slow laptop
/// longer. This is a failure threshold for a wedged start, not a performance
/// target, so it is deliberately generous.
const READY_TIMEOUT: Duration = Duration::from_secs(90);

/// How long to wait after SIGTERM before killing the child.
///
/// DSH disposes its whole plugin tree on SIGTERM and has its own bounded grace
/// period; this is the outer bound so a wedged process cannot hold the daemon's
/// shutdown open forever.
const STOP_GRACE: Duration = Duration::from_secs(15);

/// How the daemon starts DSH.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SupervisorConfig {
    /// The `dsh` executable, or a path to one.
    pub executable: std::path::PathBuf,
    /// Port DSH is asked to listen on. Chosen by the daemon, never by a peer.
    pub port: u16,
}

impl Default for SupervisorConfig {
    fn default() -> Self {
        Self {
            executable: std::path::PathBuf::from("dsh"),
            // DSH's own default. The daemon passes it explicitly rather than
            // relying on it, so the readiness line's port is never a surprise.
            port: 3080,
        }
    }
}

/// Why a DSH start failed.
#[derive(Debug, thiserror::Error)]
pub enum SuperviseError {
    /// The child could not be spawned at all.
    #[error("cannot start {executable}: {source}")]
    Spawn {
        /// The executable we tried to run.
        executable: String,
        /// The underlying OS error.
        source: std::io::Error,
    },
    /// The child exited before it announced readiness.
    #[error(
        "DSH exited before announcing readiness (status {status}); its output is in the daemon log"
    )]
    ExitedEarly {
        /// The exit status, when the OS reported one.
        status: String,
    },
    /// The child is running but never printed a usable readiness line.
    #[error(
        "DSH did not announce readiness within {seconds}s; it may be an incompatible version, or `printUrl` may be disabled in its web-app row (see docs/integration/dsh-surface.md)"
    )]
    ReadyTimeout {
        /// The timeout that elapsed, in seconds.
        seconds: u64,
    },
    /// The readiness line was there but unusable.
    #[error("DSH announced readiness in a form this daemon cannot use: {0}")]
    Ready(#[from] ReadyParseError),
    /// The child's stdout could not be read.
    #[error("cannot read DSH output: {0}")]
    Output(std::io::Error),
}

/// A running DSH, with the facts the daemon needs about it.
#[derive(Debug)]
pub struct Supervisor {
    config: SupervisorConfig,
    child: Child,
    ready: ReadyLine,
    /// PID captured at start, because `Child::id` becomes `None` after a wait.
    pid: Option<u32>,
}

impl Supervisor {
    /// Starts DSH and waits for its readiness announcement.
    ///
    /// `--no-open` is passed deliberately: the daemon runs on a machine nobody
    /// may be sitting at, and popping a browser window is a side effect the user
    /// did not ask for. It does not suppress the readiness line — that is
    /// `printUrl`, which is a separate setting (see the module docs of
    /// [`super::ready`]).
    ///
    /// # Errors
    ///
    /// Returns a [`SuperviseError`] naming which stage failed: spawn, early exit,
    /// timeout, or an unusable readiness line.
    pub async fn start(config: SupervisorConfig) -> Result<Self, SuperviseError> {
        let mut child = Command::new(&config.executable)
            .arg("web")
            .arg("--no-open")
            .arg("--port")
            .arg(config.port.to_string())
            .stdin(Stdio::null())
            // Both streams are piped so the daemon owns DSH's diagnostics. DSH
            // writes no log file of its own (`docs/integration/dsh-surface.md`
            // § 6), so if the daemon drops this output, the user has nothing to
            // debug with.
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|source| SuperviseError::Spawn {
                executable: config.executable.display().to_string(),
                source,
            })?;

        let pid = child.id();
        let stdout = child.stdout.take().ok_or_else(|| {
            SuperviseError::Output(std::io::Error::other("DSH stdout was not captured"))
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            SuperviseError::Output(std::io::Error::other("DSH stderr was not captured"))
        })?;

        // DSH's stderr is forwarded to the daemon's log line by line. It is never
        // parsed: only stdout carries the readiness contract, and mixing the two
        // would mean a diagnostic message could be mistaken for an announcement.
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!(target: "dsh", "{line}");
            }
        });

        let ready = wait_for_ready(&mut child, stdout).await?;
        tracing::info!(
            target: "dsh",
            port = ready.port,
            lan = ready.lan_url.as_deref().unwrap_or("none"),
            "DSH announced readiness"
        );

        Ok(Self {
            config,
            child,
            ready,
            pid,
        })
    }

    /// The parsed readiness facts.
    #[must_use]
    pub fn ready(&self) -> &ReadyLine {
        &self.ready
    }

    /// The child's process id, when the OS assigned one.
    #[must_use]
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// The configuration this instance was started with.
    #[must_use]
    pub fn config(&self) -> &SupervisorConfig {
        &self.config
    }

    /// Whether the child is still running.
    ///
    /// Non-blocking: a `try_wait` that reports a status also reaps the child, so
    /// this doubles as the "did it die?" check the health loop needs.
    ///
    /// # Errors
    ///
    /// Returns the OS error when the status cannot be queried.
    pub fn is_running(&mut self) -> Result<bool, std::io::Error> {
        Ok(self.child.try_wait()?.is_none())
    }

    /// Waits for the child to exit on its own.
    ///
    /// Used by the daemon's main loop so an unexpected DSH exit is reported
    /// immediately instead of being noticed by a health check later.
    pub async fn wait_for_exit(&mut self) -> std::io::Result<std::process::ExitStatus> {
        self.child.wait().await
    }

    /// Stops DSH: SIGTERM, then a bounded wait, then kill.
    ///
    /// SIGTERM is what DSH expects and handles by disposing its plugin tree; the
    /// hard kill is only for a process that ignored it.
    ///
    /// # Errors
    ///
    /// Returns the OS error when the signal cannot be delivered.
    pub async fn stop(&mut self) -> Result<(), std::io::Error> {
        if self.child.try_wait()?.is_some() {
            return Ok(());
        }
        // `start_kill` sends SIGKILL, so the graceful signal is sent through the
        // OS directly: tokio has no portable SIGTERM, and this project targets
        // macOS and Linux first (Windows uses a different mechanism, tracked as
        // M2 work in docs/product/mvp.md).
        #[cfg(unix)]
        {
            if let Some(pid) = self.pid {
                // Safety-free: `kill` is called via libc through tokio's process
                // handle only to deliver a signal; the daemon forbids unsafe code,
                // so the syscall is issued by the `nix`-free path below instead.
                signal_term(pid);
            }
            if tokio::time::timeout(STOP_GRACE, self.child.wait())
                .await
                .is_err()
            {
                tracing::warn!(target: "dsh", "DSH ignored SIGTERM; killing it");
                self.child.kill().await?;
            }
        }
        #[cfg(not(unix))]
        {
            self.child.kill().await?;
        }
        Ok(())
    }
}

/// Delivers SIGTERM to `pid`.
///
/// Implemented by shelling out to `kill(1)` rather than pulling in `libc` or
/// `nix`: the workspace forbids `unsafe`, and a one-shot external `kill` on a
/// process we started ourselves is a smaller addition than a syscall crate. This
/// is called exactly once per shutdown, so the cost is irrelevant.
#[cfg(unix)]
fn signal_term(pid: u32) {
    if let Err(error) = std::process::Command::new("kill")
        .arg("-TERM")
        .arg(pid.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
    {
        tracing::warn!(target: "dsh", pid, "could not send SIGTERM: {error}");
    }
}

/// Reads stdout until the readiness line arrives, the child exits, or time runs out.
async fn wait_for_ready(
    child: &mut Child,
    stdout: tokio::process::ChildStdout,
) -> Result<ReadyLine, SuperviseError> {
    let mut lines = BufReader::new(stdout).lines();
    let deadline = tokio::time::Instant::now() + READY_TIMEOUT;

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(SuperviseError::ReadyTimeout {
                seconds: READY_TIMEOUT.as_secs(),
            });
        }
        tokio::select! {
            line = tokio::time::timeout(remaining, lines.next_line()) => {
                match line {
                    Err(_) => return Err(SuperviseError::ReadyTimeout { seconds: READY_TIMEOUT.as_secs() }),
                    Ok(Err(error)) => return Err(SuperviseError::Output(error)),
                    Ok(Ok(None)) => {
                        // stdout closed: the child is finishing. Report its status so
                        // the reason is visible rather than "no readiness line".
                        let status = child
                            .try_wait()
                            .ok()
                            .flatten()
                            .map_or_else(|| "unknown".to_owned(), |status| status.to_string());
                        return Err(SuperviseError::ExitedEarly { status });
                    }
                    Ok(Ok(Some(line))) => {
                        // Ordinary output is forwarded at debug level so a support
                        // session can see what DSH said before it was ready.
                        match ReadyLine::parse(&line)? {
                            Some(ready) => return Ok(ready),
                            None => tracing::debug!(target: "dsh", "{line}"),
                        }
                    }
                }
            }
            status = child.wait() => {
                let status = status.map_or_else(|error| error.to_string(), |status| status.to_string());
                return Err(SuperviseError::ExitedEarly { status });
            }
        }
    }
}

/// Adapts the supervisor to the lifecycle controller's `Spawner`.
///
/// The adapter lives here rather than in `lifecycle` so that module stays free of process
/// concerns, and here rather than in a test so the shipped daemon uses the same path the tests
/// do — an adapter written only for tests is an adapter that can disagree with production.
pub struct SupervisorSpawner {
    config: SupervisorConfig,
}

impl SupervisorSpawner {
    /// Spawns DSH with a fixed configuration.
    #[must_use]
    pub fn new(config: SupervisorConfig) -> Self {
        Self { config }
    }
}

#[async_trait::async_trait]
impl crate::lifecycle::Spawner for SupervisorSpawner {
    type Handle = Supervisor;

    async fn spawn(&self) -> Result<Self::Handle, String> {
        Supervisor::start(self.config.clone())
            .await
            .map_err(|error| error.to_string())
    }
}

#[async_trait::async_trait]
impl crate::lifecycle::Running for Supervisor {
    fn pid(&self) -> Option<u32> {
        self.pid
    }

    async fn wait(&mut self) -> String {
        match self.wait_for_exit().await {
            Ok(status) => format!("DSH exited: {status}"),
            Err(error) => format!("cannot determine how DSH exited: {error}"),
        }
    }

    async fn stop(&mut self) -> Result<(), String> {
        Supervisor::stop(self)
            .await
            .map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_command_line_is_loopback_and_explicit() {
        let config = SupervisorConfig::default();
        assert_eq!(config.executable, std::path::PathBuf::from("dsh"));
        assert_eq!(config.port, 3080);
        // The config has no host field at all: that is the mechanism behind
        // "refuse to bind DSH to a non-loopback address" (docs/security.md § 2.4).
    }

    #[tokio::test]
    async fn starting_a_missing_executable_names_the_executable() {
        let config = SupervisorConfig {
            executable: std::path::PathBuf::from("dsh-does-not-exist-9f3a"),
            port: 3080,
        };
        let Err(error) = Supervisor::start(config).await else {
            unreachable!("starting a missing executable must fail");
        };
        let message = error.to_string();
        assert!(message.contains("dsh-does-not-exist-9f3a"), "{message}");
        assert!(matches!(error, SuperviseError::Spawn { .. }), "{error:?}");
    }
}
