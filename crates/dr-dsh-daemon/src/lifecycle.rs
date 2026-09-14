//! DSH lifecycle: starting, stopping, restarting, and recovering from a crash.
//!
//! ## What this module owns, and what it deliberately does not
//!
//! It owns **the state machine and the policy around it**: when DSH may be started, how long
//! to wait after a crash before trying again, and what a remote operator is told while that
//! is happening. It does not own the process: spawning and stopping live in
//! [`crate::dsh::supervisor`], and this module reaches them through the [`Spawner`] trait.
//!
//! That split is what makes self-healing testable. The property that matters — "kill DSH and
//! it comes back, and the client is told it is recovering rather than left guessing" — is
//! about *decisions over time*, and a test that had to spawn real processes to check the
//! fifth retry's delay would be slow enough that nobody would run it.
//!
//! ## Why attach mode is a first-class state
//!
//! A DSH the daemon did not start is a DSH the daemon must not stop. Every lifecycle decision
//! here goes through [`Mode`], and `Mode::Attached` refuses the mutating operations rather
//! than relying on a caller to check a flag first. The refusal carries a reason because the
//! remote UI has to *explain* the disabled buttons: a greyed-out button with no explanation is
//! indistinguishable from a bug (project definition § 8).

use std::time::Duration;

use dr_dsh_proto::control::{LifecycleOp, LifecycleResult, LifecycleState};

/// How DSH is running, from the daemon's point of view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mode {
    /// The daemon started DSH and is responsible for it.
    Managed {
        /// The port the supervisor was told to use.
        port: u16,
    },
    /// DSH was started by hand and the daemon only speaks to it.
    Attached {
        /// The port it is listening on.
        port: u16,
    },
}

impl Mode {
    /// Whether this mode permits starting, stopping, or restarting DSH.
    #[must_use]
    pub fn permits_lifecycle(&self) -> bool {
        matches!(self, Self::Managed { .. })
    }

    /// The port DSH is (or will be) on.
    #[must_use]
    pub fn port(&self) -> u16 {
        match self {
            Self::Managed { port } | Self::Attached { port } => *port,
        }
    }

    /// Why lifecycle commands are refused, when they are.
    ///
    /// Returned as a sentence meant for a person: the remote UI shows it verbatim next to the
    /// disabled controls, which is the whole difference between "this is intentional" and
    /// "this is broken".
    #[must_use]
    pub fn refusal_reason(&self) -> Option<String> {
        match self {
            Self::Managed { .. } => None,
            Self::Attached { port } => Some(format!(
                "DSH on port {port} was started outside this daemon, so the daemon will not \
                 stop or restart it. Interface access works normally; stop it yourself if you \
                 want it stopped."
            )),
        }
    }
}

/// What the daemon knows about DSH right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Lifecycle {
    /// Not running, and not being started: either it was stopped or it never started.
    Stopped {
        /// Why it is not running, when that is worth saying.
        reason: Option<String>,
    },
    /// A start is in flight.
    Starting,
    /// Running.
    Running {
        /// Process id, when the daemon owns the process.
        pid: Option<u32>,
    },
    /// It exited unexpectedly and will be restarted after this delay.
    ///
    /// The delay is part of the state rather than an implementation detail, because it is what
    /// a remote operator needs in order to see "recovering in 4s" instead of a spinner.
    Recovering {
        /// How long until the next attempt.
        retry_in: Duration,
        /// Which attempt this will be, counting from one.
        attempt: u32,
        /// How it exited.
        reason: String,
    },
    /// Repeated attempts have failed; the daemon has stopped trying.
    Failed {
        /// Why it gave up.
        reason: String,
    },
}

impl Lifecycle {
    /// The wire form the remote client sees.
    #[must_use]
    pub fn state(&self) -> LifecycleState {
        match self {
            Self::Stopped { .. } => LifecycleState::Stopped,
            Self::Starting | Self::Recovering { .. } => LifecycleState::Starting,
            Self::Running { .. } => LifecycleState::Running,
            Self::Failed { .. } => LifecycleState::Failed,
        }
    }
}

/// Restart schedule after an unexpected exit. Pure, so it is testable without a clock.
#[derive(Debug, Clone, Copy)]
pub struct RestartPolicy {
    /// Delay before the first restart.
    pub base: Duration,
    /// Ceiling for the delay.
    pub max: Duration,
    /// How many attempts in a row before giving up.
    ///
    /// Giving up is deliberate. A daemon that restarts DSH forever turns a configuration
    /// mistake — a port that is taken, a profile that will not load — into an endless spawn
    /// loop that fills the machine's process table and the user's logs, and never says so.
    pub max_attempts: u32,
}

impl Default for RestartPolicy {
    fn default() -> Self {
        Self {
            base: Duration::from_millis(500),
            max: Duration::from_secs(30),
            max_attempts: 5,
        }
    }
}

impl RestartPolicy {
    /// Delay before attempt `attempt` (1-based).
    #[must_use]
    pub fn delay(&self, attempt: u32) -> Duration {
        let exponent = attempt.saturating_sub(1).min(16);
        self.base.saturating_mul(1_u32 << exponent).min(self.max)
    }
}

/// How the controller obtains a running DSH.
///
/// A trait rather than a direct call so the state machine can be driven without processes. The
/// real implementation wraps [`crate::dsh::Supervisor`]; a test implementation returns a
/// handle it can kill.
#[async_trait::async_trait]
pub trait Spawner: Send + Sync {
    /// A running DSH.
    ///
    /// `'static` because the driver keeps the handle across await points and stores it: a
    /// borrowed handle would tie the daemon's lifetime to the spawner's, and the spawner is a
    /// configuration value that does not outlive startup.
    type Handle: Running + Send + 'static;

    /// Starts DSH and waits for it to announce readiness.
    ///
    /// # Errors
    ///
    /// Returns a message suitable for a person when the start fails.
    async fn spawn(&self) -> Result<Self::Handle, String>;
}

/// A running DSH the controller can watch and stop.
#[async_trait::async_trait]
pub trait Running: Send {
    /// The process id, when this handle owns a process.
    fn pid(&self) -> Option<u32>;

    /// Waits for DSH to exit, returning a description of how.
    async fn wait(&mut self) -> String;

    /// Stops DSH the way it expects to be stopped.
    ///
    /// # Errors
    ///
    /// Returns a message suitable for a person when the stop fails.
    async fn stop(&mut self) -> Result<(), String>;
}

/// Live state plus the policy for restarting it.
pub struct Controller {
    mode: Mode,
    policy: RestartPolicy,
    lifecycle: Lifecycle,
    /// Consecutive failed attempts, reset by a successful run.
    attempts: u32,
    /// Whether the operator asked for DSH to be down. A stop is intentional, and an
    /// intentional stop must not trigger the self-healing path — that would make `stop`
    /// impossible to use.
    wanted_running: bool,
}

impl Controller {
    /// Builds a controller for a mode.
    #[must_use]
    pub fn new(mode: Mode) -> Self {
        let lifecycle = match &mode {
            // Attached mode starts "running": the daemon did not start it, but it is there.
            Mode::Attached { .. } => Lifecycle::Running { pid: None },
            Mode::Managed { .. } => Lifecycle::Stopped { reason: None },
        };
        Self {
            mode,
            policy: RestartPolicy::default(),
            lifecycle,
            attempts: 0,
            wanted_running: false,
        }
    }

    /// Uses a specific restart policy.
    #[must_use]
    pub fn with_policy(mut self, policy: RestartPolicy) -> Self {
        self.policy = policy;
        self
    }

    /// The mode this controller was built for.
    #[must_use]
    pub fn mode(&self) -> &Mode {
        &self.mode
    }

    /// What DSH is doing right now.
    #[must_use]
    pub fn lifecycle(&self) -> &Lifecycle {
        &self.lifecycle
    }

    /// Whether the operator wants DSH running.
    #[must_use]
    pub fn wanted_running(&self) -> bool {
        self.wanted_running
    }

    /// Records that a start is in flight.
    pub fn begin_start(&mut self) {
        self.wanted_running = true;
        self.lifecycle = Lifecycle::Starting;
    }

    /// Records a successful start.
    pub fn started(&mut self, pid: Option<u32>) {
        // The attempt counter resets on success, so a DSH that runs for an hour and then dies
        // gets the full patience again rather than inheriting an old run of failures.
        self.attempts = 0;
        self.lifecycle = Lifecycle::Running { pid };
    }

    /// Records that a start attempt failed.
    ///
    /// Returns `true` when another attempt should be made, and the caller should schedule it
    /// after [`Controller::current_delay`].
    pub fn start_failed(&mut self, reason: String) -> bool {
        if !self.wanted_running {
            self.lifecycle = Lifecycle::Stopped {
                reason: Some(reason),
            };
            return false;
        }
        self.attempts = self.attempts.saturating_add(1);
        if self.attempts >= self.policy.max_attempts {
            self.lifecycle = Lifecycle::Failed {
                reason: format!(
                    "{reason} (gave up after {} attempts)",
                    self.policy.max_attempts
                ),
            };
            return false;
        }
        self.lifecycle = Lifecycle::Recovering {
            retry_in: self.policy.delay(self.attempts),
            attempt: self.attempts,
            reason,
        };
        true
    }

    /// Records that DSH exited.
    ///
    /// Returns `true` when it should be restarted, which is the self-healing decision: an exit
    /// the operator did not ask for is a crash, and a crash is restarted until the policy says
    /// otherwise.
    pub fn exited(&mut self, reason: String) -> bool {
        if !self.wanted_running {
            self.lifecycle = Lifecycle::Stopped {
                reason: Some(reason),
            };
            return false;
        }
        self.attempts = self.attempts.saturating_add(1);
        if self.attempts >= self.policy.max_attempts {
            self.lifecycle = Lifecycle::Failed {
                reason: format!(
                    "{reason} (gave up after {} attempts)",
                    self.policy.max_attempts
                ),
            };
            return false;
        }
        self.lifecycle = Lifecycle::Recovering {
            retry_in: self.policy.delay(self.attempts),
            attempt: self.attempts,
            reason,
        };
        true
    }

    /// How long to wait before the next attempt.
    #[must_use]
    pub fn current_delay(&self) -> Duration {
        match &self.lifecycle {
            Lifecycle::Recovering { retry_in, .. } => *retry_in,
            _ => self.policy.delay(self.attempts.max(1)),
        }
    }

    /// Records that the operator asked for DSH to stop.
    pub fn begin_stop(&mut self) {
        self.wanted_running = false;
    }

    /// Records that DSH is stopped.
    pub fn stopped(&mut self, reason: Option<String>) {
        self.wanted_running = false;
        self.attempts = 0;
        self.lifecycle = Lifecycle::Stopped { reason };
    }

    /// Whether this controller may act on lifecycle commands at all.
    ///
    /// # Errors
    ///
    /// Returns the explanation to show the user when the mode forbids it.
    pub fn check_permitted(&self, op: LifecycleOp) -> Result<(), String> {
        match self.mode.refusal_reason() {
            None => Ok(()),
            Some(reason) => Err(format!("{} is not available: {reason}", describe_op(op))),
        }
    }

    /// The result to report for the current state, after an operation.
    ///
    /// Always `accepted: true`: every caller of this is the driver *performing* an operation it was
    /// handed, and a driver is only handed operations the control plane already accepted. The refusal
    /// case is a separate value, built where the refusal is decided.
    #[must_use]
    pub fn result(&self, ok: bool, error: Option<String>) -> LifecycleResult {
        LifecycleResult {
            accepted: true,
            ok,
            state: self.lifecycle.state(),
            error,
        }
    }
}

impl core::fmt::Debug for Controller {
    /// Prints the state, never a handle: the handles are not the interesting part of a log line
    /// about lifecycle, and this type sits next to a device registry whose whole point is that
    /// a stolen log is not a stolen credential.
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Controller")
            .field("mode", &self.mode)
            .field("lifecycle", &self.lifecycle)
            .field("attempts", &self.attempts)
            .finish()
    }
}

/// A name for an operation, for a refusal message.
fn describe_op(op: LifecycleOp) -> &'static str {
    match op {
        LifecycleOp::Start => "starting DSH",
        LifecycleOp::Stop => "stopping DSH",
        LifecycleOp::Restart => "restarting DSH",
    }
}

/// A command from the control plane to the lifecycle driver.
#[derive(Debug)]
pub struct Command {
    /// Which operation.
    pub op: LifecycleOp,
    /// How to answer. A oneshot rather than a shared slot so two concurrent commands cannot
    /// read each other's results.
    pub reply: tokio::sync::oneshot::Sender<LifecycleResult>,
}

/// The daemon's handle on DSH's lifecycle.
///
/// Two halves, because the control plane needs both and they have different shapes: a
/// **synchronous snapshot** it can read while answering a status request (the control handler
/// is not async), and an **async command path** that asks the driver to act.
#[derive(Clone)]
pub struct Handle {
    state: std::sync::Arc<std::sync::Mutex<Lifecycle>>,
    mode: Mode,
    commands: tokio::sync::mpsc::Sender<Command>,
}

impl Handle {
    /// Publishes a state, for tests and for the one caller that knows better than the driver.
    ///
    /// The driver is the only writer in production; this exists so a test can put a handle in
    /// the state it means to exercise without standing up a process.
    pub fn publish(&self, state: Lifecycle) {
        if let Ok(mut slot) = self.state.lock() {
            *slot = state;
        }
    }

    /// The current lifecycle, for a status answer.
    ///
    /// # Panics
    ///
    /// Never in practice: the lock is only ever held for a read or a single assignment, and a
    /// poisoned lock is recovered rather than propagated. A daemon that stops answering status
    /// because some unrelated task panicked while holding this lock would be a worse failure
    /// than the panic.
    #[must_use]
    pub fn snapshot(&self) -> Lifecycle {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// How DSH is running.
    #[must_use]
    pub fn mode(&self) -> &Mode {
        &self.mode
    }

    /// Whether lifecycle commands are permitted.
    ///
    /// # Errors
    ///
    /// Returns the reason to show the user, when attach mode forbids it.
    pub fn check_permitted(&self, op: LifecycleOp) -> Result<(), String> {
        match self.mode.refusal_reason() {
            None => Ok(()),
            Some(reason) => Err(format!("{} is not available: {reason}", describe_op(op))),
        }
    }

    /// Asks the driver to perform an operation.
    ///
    /// # Errors
    ///
    /// Returns a `LifecycleResult` describing the failure when the command is refused or the
    /// driver has stopped. Never returns an error type: a lifecycle command's failure *is* a
    /// result the client displays, and a caller that had to handle both an `Err` and an
    /// `ok: false` would eventually handle one of them.
    pub async fn command(&self, op: LifecycleOp) -> LifecycleResult {
        if let Err(reason) = self.check_permitted(op) {
            // The one result that is a refusal rather than a failure: retrying cannot change it, and
            // the client's button logic depends on telling the two apart.
            return LifecycleResult {
                accepted: false,
                ok: false,
                state: self.snapshot().state(),
                error: Some(reason),
            };
        }
        let (reply, answer) = tokio::sync::oneshot::channel();
        if self.commands.send(Command { op, reply }).await.is_err() {
            // Accepted and dispatched, then lost with the driver: a failure, not a refusal.
            return LifecycleResult {
                accepted: true,
                ok: false,
                state: self.snapshot().state(),
                error: Some("the daemon's lifecycle driver has stopped".to_owned()),
            };
        }
        answer.await.unwrap_or(LifecycleResult {
            accepted: true,
            ok: false,
            state: self.snapshot().state(),
            error: Some("the lifecycle driver did not answer".to_owned()),
        })
    }
}

impl core::fmt::Debug for Handle {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Handle")
            .field("state", &self.snapshot())
            .field("mode", &self.mode)
            .finish()
    }
}

/// Builds a handle and the driver that serves it.
///
/// The channel is bounded and small: a lifecycle command takes seconds, so a queue of them is
/// either a stuck operator or a client in a loop, and neither is served by buffering more.
#[must_use]
pub fn channel(mode: Mode, policy: RestartPolicy) -> (Handle, Driver) {
    let controller = Controller::new(mode.clone()).with_policy(policy);
    let state = std::sync::Arc::new(std::sync::Mutex::new(controller.lifecycle().clone()));
    let (commands, inbox) = tokio::sync::mpsc::channel(4);
    let handle = Handle {
        state: std::sync::Arc::clone(&state),
        mode,
        commands,
    };
    let driver = Driver {
        controller,
        state,
        inbox,
        running: None,
    };
    (handle, driver)
}

/// Owns the controller and the running process, and drives both.
///
/// One task owns the process. Two tasks that could start or stop DSH would race, and the race
/// would show up as a process nobody can account for rather than as an error.
pub struct Driver {
    controller: Controller,
    state: std::sync::Arc<std::sync::Mutex<Lifecycle>>,
    inbox: tokio::sync::mpsc::Receiver<Command>,
    running: Option<Box<dyn Running>>,
}

impl Driver {
    /// Adopts a process that is already running.
    ///
    /// The daemon starts DSH before it has a driver, because it needs the readiness line and
    /// the authenticated client to do its own startup checks — and those checks are the reason
    /// the daemon refuses to run at all when DSH cannot start. Handing that process to the
    /// driver rather than starting a second one is what keeps "one owner" true: two starts
    /// would mean two DSH instances fighting for one port, and the second would fail in a way
    /// that looks like flakiness.
    pub fn adopt(mut self, process: Box<dyn Running>) -> Self {
        // Adopting asserts that DSH is *meant* to be running. Without that, the first crash is
        // classified as an exit the operator asked for, and the driver quietly leaves DSH down
        // — self-healing that never heals, with no error to point at. This was found by
        // killing a real DSH and watching a daemon that did nothing.
        self.controller.begin_start();
        self.controller.started(process.pid());
        self.running = Some(process);
        self.publish();
        self
    }

    /// Runs until the command channel closes or a command asks for a state the driver cannot
    /// reach.
    ///
    /// Takes the spawner rather than holding one, so the same driver serves the real supervisor
    /// and a stand-in without a generic parameter leaking into every signature above it.
    pub async fn run<S: Spawner + 'static>(mut self, spawner: S) {
        // A driver that was handed a process is already running one; one that was not has to
        // start it, or the daemon would come up with DSH reported as stopped and nothing
        // scheduled to change that.
        if self.running.is_none() && self.controller.mode().permits_lifecycle() {
            self.start(&spawner).await;
        }
        loop {
            tokio::select! {
                Some(command) = self.inbox.recv() => {
                    let result = self.serve(&spawner, command.op).await;
                    let _ = command.reply.send(result);
                }
                // The running process is watched only when there is one. `pending` rather than
                // a dummy branch keeps the select honest: with no process, only commands can
                // move the state.
                exit = Self::watch(&mut self.running), if self.running.is_some() => {
                    let how = exit.unwrap_or_else(|| "the process vanished".to_owned());
                    self.running = None;
                    if self.controller.exited(how) {
                        let delay = self.controller.current_delay();
                        self.publish();
                        // The backoff is inside the branch that chose to recover, so a stop or a
                        // restart command arriving during it is still served — the select below
                        // is what makes that true.
                        if self.backoff(delay).await {
                            self.start(&spawner).await;
                        }
                    } else {
                        self.publish();
                    }
                }
                else => {
                    break;
                }
            }
        }
    }

    /// Waits for the running process to exit, if there is one.
    async fn watch(running: &mut Option<Box<dyn Running>>) -> Option<String> {
        match running {
            Some(process) => Some(process.wait().await),
            None => std::future::pending().await,
        }
    }

    /// Waits out a backoff, returning `true` if a start should still happen.
    ///
    /// A command arriving during the backoff interrupts it: the operator asking for a restart
    /// should not have to wait out a timer set by a crash they are trying to fix.
    async fn backoff(&mut self, delay: Duration) -> bool {
        let sleep = tokio::time::sleep(delay);
        tokio::pin!(sleep);
        loop {
            tokio::select! {
                () = &mut sleep => return self.controller.wanted_running(),
                Some(command) = self.inbox.recv() => {
                    let result = self.serve_command_only(command.op).await;
                    let _ = command.reply.send(result);
                    if !self.controller.wanted_running() {
                        return false;
                    }
                }
                else => return false,
            }
        }
    }

    /// Starts DSH, retrying per the controller's policy.
    async fn start<S: Spawner + 'static>(&mut self, spawner: &S) {
        loop {
            self.controller.begin_start();
            self.publish();
            match spawner.spawn().await {
                Ok(process) => {
                    self.controller.started(process.pid());
                    self.running = Some(Box::new(process));
                    self.publish();
                    return;
                }
                Err(reason) => {
                    if !self.controller.start_failed(reason) {
                        self.publish();
                        return;
                    }
                    let delay = self.controller.current_delay();
                    self.publish();
                    if !self.backoff(delay).await {
                        return;
                    }
                }
            }
        }
    }

    /// Serves one command, starting or stopping the process as needed.
    async fn serve<S: Spawner + 'static>(
        &mut self,
        spawner: &S,
        op: LifecycleOp,
    ) -> LifecycleResult {
        match op {
            LifecycleOp::Start => {
                if self.running.is_some() {
                    // Idempotent rather than an error: a client that reconnects and retries a
                    // start must not be told it failed when the goal is already met.
                    return self.controller.result(true, None);
                }
                self.start(spawner).await;
                let ok = matches!(self.controller.lifecycle(), Lifecycle::Running { .. });
                let error = match self.controller.lifecycle() {
                    Lifecycle::Failed { reason } => Some(reason.clone()),
                    Lifecycle::Stopped { reason } => reason.clone(),
                    _ => None,
                };
                self.controller.result(ok, error)
            }
            LifecycleOp::Stop => self.stop().await,
            LifecycleOp::Restart => {
                let stopped = self.stop().await;
                if !stopped.ok {
                    return stopped;
                }
                self.start(spawner).await;
                let ok = matches!(self.controller.lifecycle(), Lifecycle::Running { .. });
                let error = match self.controller.lifecycle() {
                    Lifecycle::Failed { reason } => Some(reason.clone()),
                    _ => None,
                };
                self.controller.result(ok, error)
            }
        }
    }

    /// Serves a command that only changes the desired state, for use during a backoff.
    async fn serve_command_only(&mut self, op: LifecycleOp) -> LifecycleResult {
        match op {
            LifecycleOp::Stop => {
                self.controller.begin_stop();
                self.publish();
                self.controller.result(true, None)
            }
            // A start or restart during a backoff is already going to happen once the sleep
            // ends and `wanted_running` is true, which is what makes them succeed here.
            LifecycleOp::Start | LifecycleOp::Restart => self.controller.result(true, None),
        }
    }

    /// Stops the running process, if there is one.
    async fn stop(&mut self) -> LifecycleResult {
        let Some(mut process) = self.running.take() else {
            // Stopping something that is not running is success, not a failure: the goal state
            // is "not running" and it already holds.
            self.controller.begin_stop();
            self.controller.stopped(None);
            self.publish();
            return self.controller.result(true, None);
        };
        self.controller.begin_stop();
        match process.stop().await {
            Ok(()) => {
                self.controller.stopped(None);
                self.publish();
                self.controller.result(true, None)
            }
            Err(reason) => {
                // The process is put back: a stop that failed means DSH is still there, and a
                // driver that forgot it would leave a process nobody is watching.
                self.running = Some(process);
                self.publish();
                self.controller.result(false, Some(reason))
            }
        }
    }

    /// Mirrors the controller's state into the shared slot the control plane reads.
    fn publish(&self) {
        if let Ok(mut slot) = self.state.lock() {
            *slot = self.controller.lifecycle().clone();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    fn managed() -> Controller {
        Controller::new(Mode::Managed { port: 3080 })
    }

    #[test]
    fn attach_mode_refuses_the_mutating_operations_and_says_why() -> TestResult {
        // Criterion 5: the remote buttons are disabled *and the reason is shown*. A refusal
        // without an explanation is indistinguishable from a bug, which is why the reason is
        // part of the return value rather than only of the log.
        let controller = Controller::new(Mode::Attached { port: 3080 });
        assert!(!controller.mode().permits_lifecycle());
        for op in [LifecycleOp::Stop, LifecycleOp::Restart, LifecycleOp::Start] {
            let reason = match controller.check_permitted(op) {
                Err(reason) => reason,
                Ok(()) => {
                    return Err(format!("attach mode must refuse {op:?}").into());
                }
            };
            assert!(reason.contains("started outside this daemon"), "{reason}");
            assert!(reason.contains("Interface access works"), "{reason}");
        }
        // Reading status is not an operation and is permitted in every mode, which is the
        // other half of the criterion: attach mode disables control, not access.
        assert!(!controller.mode().permits_lifecycle());
        Ok(())
    }

    #[test]
    fn managed_mode_permits_everything() {
        let controller = managed();
        for op in [LifecycleOp::Start, LifecycleOp::Stop, LifecycleOp::Restart] {
            assert!(controller.check_permitted(op).is_ok());
        }
    }

    #[test]
    fn attach_mode_reports_running_without_a_pid() {
        // The daemon did not start it, so it does not know a pid — and must not pretend to.
        let controller = Controller::new(Mode::Attached { port: 3080 });
        assert_eq!(controller.lifecycle(), &Lifecycle::Running { pid: None });
        assert_eq!(controller.lifecycle().state(), LifecycleState::Running);
    }

    #[test]
    fn a_crash_is_restarted_with_growing_delays() -> TestResult {
        // Criterion 4's core: kill DSH and it comes back. The delay grows so a DSH that dies
        // immediately on every start does not become a spawn loop.
        let mut controller = managed();
        controller.begin_start();
        controller.started(Some(42));
        assert_eq!(controller.lifecycle().state(), LifecycleState::Running);

        // First crash.
        assert!(controller.exited("killed by signal 9".to_owned()));
        match controller.lifecycle() {
            Lifecycle::Recovering {
                attempt, retry_in, ..
            } => {
                assert_eq!(*attempt, 1);
                assert_eq!(*retry_in, Duration::from_millis(500));
            }
            other => {
                return Err(format!("expected recovery, got {other:?}").into());
            }
        }
        // The client sees "starting", not "stopped": during recovery the remote must show
        // that something is happening rather than an unresponsive UI.
        assert_eq!(controller.lifecycle().state(), LifecycleState::Starting);

        // A second crash waits longer.
        assert!(controller.exited("killed again".to_owned()));
        assert_eq!(controller.current_delay(), Duration::from_millis(1000));
        Ok(())
    }

    #[test]
    fn a_successful_run_restores_the_full_patience() {
        // A DSH that runs for an hour and then dies must not inherit an old run of failures:
        // the counter measures consecutive failure, not lifetime failure.
        let mut controller = managed();
        controller.begin_start();
        controller.started(None);
        let _ = controller.exited("crash".to_owned());
        let _ = controller.exited("crash".to_owned());
        controller.begin_start();
        controller.started(None);
        assert!(controller.exited("crash".to_owned()));
        assert_eq!(
            controller.current_delay(),
            Duration::from_millis(500),
            "the counter must reset after a successful run"
        );
    }

    #[test]
    fn repeated_failures_stop_rather_than_spawn_forever() -> TestResult {
        // Giving up is a feature. A daemon that restarts a DSH which cannot start — a taken
        // port, a broken profile — forever would fill the process table and never say why.
        let mut controller = managed().with_policy(RestartPolicy {
            max_attempts: 3,
            ..RestartPolicy::default()
        });
        controller.begin_start();
        controller.started(None);
        assert!(controller.exited("crash".to_owned()));
        assert!(controller.exited("crash".to_owned()));
        assert!(
            !controller.exited("crash".to_owned()),
            "the third failure is the last attempt"
        );
        match controller.lifecycle() {
            Lifecycle::Failed { reason } => {
                assert!(reason.contains("gave up after 3 attempts"), "{reason}");
            }
            other => {
                return Err(format!("expected a failure, got {other:?}").into());
            }
        }
        assert_eq!(controller.lifecycle().state(), LifecycleState::Failed);
        Ok(())
    }

    #[test]
    fn an_intentional_stop_does_not_trigger_self_healing() {
        // Without this, `stop` would be impossible to use: the daemon would treat the exit it
        // just caused as a crash and start DSH again.
        let mut controller = managed();
        controller.begin_start();
        controller.started(Some(7));
        controller.begin_stop();
        assert!(
            !controller.exited("stopped by the operator".to_owned()),
            "an exit the operator asked for must not be restarted"
        );
        assert_eq!(
            controller.lifecycle().state(),
            LifecycleState::Stopped,
            "and it must report stopped, not recovering"
        );
    }

    #[test]
    fn a_failed_start_before_any_run_is_retried_then_given_up_on() -> TestResult {
        let mut controller = managed().with_policy(RestartPolicy {
            max_attempts: 2,
            ..RestartPolicy::default()
        });
        controller.begin_start();
        assert!(
            controller.start_failed("the port is in use".to_owned()),
            "the first failure still has an attempt left"
        );
        assert!(!controller.start_failed("the port is in use".to_owned()));
        match controller.lifecycle() {
            Lifecycle::Failed { reason } => {
                assert!(reason.contains("the port is in use"), "{reason}");
            }
            other => {
                return Err(format!("expected a failure, got {other:?}").into());
            }
        }
        Ok(())
    }

    #[test]
    fn the_reported_result_always_carries_the_state() {
        // The client must never have to guess the state after a command: a result without it
        // is how a UI ends up showing a stale button.
        let controller = managed();
        let result = controller.result(false, Some("nothing to restart yet".to_owned()));
        assert!(!result.ok);
        assert_eq!(result.state, LifecycleState::Stopped);
        assert_eq!(result.error.as_deref(), Some("nothing to restart yet"));
    }

    #[test]
    fn the_restart_delay_is_bounded() {
        let policy = RestartPolicy::default();
        assert_eq!(policy.delay(1), Duration::from_millis(500));
        assert_eq!(policy.delay(2), Duration::from_secs(1));
        assert_eq!(policy.delay(3), Duration::from_secs(2));
        // The ceiling is reached quickly and never exceeded, however long the run of failures.
        assert_eq!(policy.delay(20), Duration::from_secs(30));
        assert_eq!(policy.delay(1_000), Duration::from_secs(30));
    }
}
