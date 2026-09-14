//! Rate limiting for pairing attempts.
//!
//! ## Why this exists, and what it is not
//!
//! The pairing code's defence against guessing is **single use plus 40 bits of entropy**: a
//! guess costs one code, and a code is worth one attempt, so retrying cannot grind 2⁴⁰ down.
//! That property holds whether or not anything is rate-limited.
//!
//! What a limiter adds is a bound on how *fast* an attacker can spend attempts — which matters
//! because the two costs are not symmetric. A guess costs the attacker a round trip and costs
//! the user a new code; at a thousand guesses a second the user is locked out of their own
//! machine long before the odds move. Rate limiting is therefore a **denial-of-service and
//! noise** control as much as a guessing control, and `docs/security.md` § 3 says the same
//! thing in the same words: the real risk was never the cryptography.
//!
//! ## Why the state is a file
//!
//! `drdshd pair` is a one-shot process: it mints a code, runs the exchange, and exits. An
//! in-memory limiter would reset on every invocation, which is precisely the pattern an
//! attacker generates — so the state has to outlive the process, and a file is the smallest
//! thing that does. It holds counters and a lockout deadline, no secrets.
//!
//! ## Why time is injected
//!
//! A limiter tested by sleeping is a limiter whose tests are slow enough to be disabled, and a
//! disabled limiter is worse than none because it is believed. Every method here takes the
//! current time from the caller.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// How many attempts are allowed before a lockout.
pub const ATTEMPTS_BEFORE_LOCKOUT: u32 = 5;

/// How long a lockout lasts once it has been triggered.
pub const LOCKOUT_DURATION: Duration = Duration::from_secs(300);

/// Why an attempt was refused before any pairing happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Throttled {
    /// Too many recent attempts; pairing is refused until the lockout passes.
    #[error("too many pairing attempts; wait {retry_after_secs}s before trying again")]
    LockedOut {
        /// Seconds until the lockout expires.
        retry_after_secs: u64,
    },
    /// Attempts are arriving faster than a human can type a code.
    #[error("a pairing attempt is already in progress; wait {retry_after_secs}s")]
    TooSoon {
        /// Seconds until the next attempt is allowed.
        retry_after_secs: u64,
    },
}

/// Consecutive failed attempts, with a timestamp for the most recent one.
#[derive(Debug, Clone, Default)]
pub struct PairingGuard {
    /// How many attempts have failed in a row.
    failures: u32,
    /// When the most recent attempt was recorded.
    last_attempt: Option<SystemTime>,
    /// When a lockout ends, if one is in force.
    locked_until: Option<SystemTime>,
}

/// Why the guard could not be read or written.
#[derive(Debug, thiserror::Error)]
pub enum GuardError {
    /// The state file could not be read.
    #[error("cannot read the pairing throttle state at {path}: {source}")]
    Read {
        /// Where it was read from.
        path: PathBuf,
        /// The underlying failure.
        source: std::io::Error,
    },
    /// The state file could not be written.
    #[error("cannot write the pairing throttle state at {path}: {source}")]
    Write {
        /// Where it was written to.
        path: PathBuf,
        /// The underlying failure.
        source: std::io::Error,
    },
    /// The state file was not the shape this version writes.
    #[error("the pairing throttle state at {path} is not usable: {reason}")]
    Malformed {
        /// Where it was read from.
        path: PathBuf,
        /// What was wrong.
        reason: String,
    },
}

impl PairingGuard {
    /// A guard with no history.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether an attempt may start at `now`.
    ///
    /// # Errors
    ///
    /// Returns [`Throttled`] when a lockout is in force or the previous attempt is too recent.
    pub fn check(&self, now: SystemTime) -> Result<(), Throttled> {
        if let Some(until) = self.locked_until
            && now < until
        {
            return Err(Throttled::LockedOut {
                retry_after_secs: seconds_between(now, until),
            });
        }
        if let Some(previous) = self.last_attempt {
            let elapsed = now.duration_since(previous).unwrap_or_default();
            if elapsed < MIN_SECONDS_BETWEEN_ATTEMPTS {
                return Err(Throttled::TooSoon {
                    retry_after_secs: (MIN_SECONDS_BETWEEN_ATTEMPTS - elapsed).as_secs().max(1),
                });
            }
        }
        Ok(())
    }

    /// Records an attempt that failed, at `now`.
    ///
    /// Only failures count. A successful pairing clears the history, because the thing being
    /// limited is guessing, and a user who paired successfully is not guessing.
    ///
    /// # Errors
    ///
    /// Returns [`Throttled`] when this attempt itself triggers a lockout, so a caller can tell
    /// the user how long they are out for rather than only that they failed.
    pub fn record_failure(&mut self, now: SystemTime) -> Result<(), Throttled> {
        self.failures = self.failures.saturating_add(1);
        self.last_attempt = Some(now);
        if self.failures >= ATTEMPTS_BEFORE_LOCKOUT {
            let until = now + LOCKOUT_DURATION;
            self.locked_until = Some(until);
            // The history is cleared with the lockout applied: the next window starts from
            // zero, so an attacker cannot hold a permanent lockout on the user by failing
            // once every window.
            self.failures = 0;
            return Err(Throttled::LockedOut {
                retry_after_secs: LOCKOUT_DURATION.as_secs(),
            });
        }
        Ok(())
    }

    /// Records that a code was redeemed, clearing the failure history.
    ///
    /// The spacing clock is cleared too, not just the counter: the spacing exists to slow a
    /// grind, and a user who just paired successfully is by definition not grinding. Leaving it
    /// would make the next legitimate pairing wait for a timer set by a failed attempt.
    pub fn record_success(&mut self) {
        self.failures = 0;
        self.last_attempt = None;
        self.locked_until = None;
    }

    /// How many failures are recorded in the current window.
    #[must_use]
    pub fn failures(&self) -> u32 {
        self.failures
    }

    /// Reads the guard from a file, treating a missing file as no history.
    ///
    /// A **malformed** file is an error rather than an empty guard: the safe reading of "I
    /// cannot tell how many attempts there have been" is not "assume none".
    ///
    /// # Errors
    ///
    /// Returns [`GuardError`] when the file exists but cannot be read or understood.
    pub fn load(path: &Path) -> Result<Self, GuardError> {
        let contents = match std::fs::read_to_string(path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Self::new()),
            Err(source) => {
                return Err(GuardError::Read {
                    path: path.to_path_buf(),
                    source,
                });
            }
        };
        let stored: StoredGuard =
            serde_json::from_str(&contents).map_err(|error| GuardError::Malformed {
                path: path.to_path_buf(),
                reason: error.to_string(),
            })?;
        Ok(Self {
            failures: stored.failures,
            last_attempt: stored.last_attempt.and_then(epoch_to_time),
            locked_until: stored.locked_until.and_then(epoch_to_time),
        })
    }

    /// Writes the guard, through a temporary file so a crash cannot truncate it.
    ///
    /// # Errors
    ///
    /// Returns [`GuardError::Write`] when the file cannot be written.
    pub fn save(&self, path: &Path) -> Result<(), GuardError> {
        let stored = StoredGuard {
            failures: self.failures,
            last_attempt: self.last_attempt.and_then(time_to_epoch),
            locked_until: self.locked_until.and_then(time_to_epoch),
        };
        let encoded =
            serde_json::to_string_pretty(&stored).map_err(|error| GuardError::Malformed {
                path: path.to_path_buf(),
                reason: error.to_string(),
            })?;
        let temporary = path.with_extension("json.tmp");
        std::fs::write(&temporary, encoded).map_err(|source| GuardError::Write {
            path: temporary.clone(),
            source,
        })?;
        std::fs::rename(&temporary, path).map_err(|source| GuardError::Write {
            path: path.to_path_buf(),
            source,
        })
    }
}

/// How long a caller must wait between two attempts.
///
/// Not a security boundary on its own — the lockout is — but it is what makes an automated
/// grind visible rather than instant, and what stops a retry loop from consuming the whole
/// failure budget in a millisecond.
pub const MIN_SECONDS_BETWEEN_ATTEMPTS: Duration = Duration::from_secs(2);

/// The on-disk shape. Seconds since the Unix epoch, so the file is readable by a human and
/// survives a reboot — which a monotonic clock would not.
#[derive(serde::Serialize, serde::Deserialize)]
struct StoredGuard {
    failures: u32,
    last_attempt: Option<u64>,
    locked_until: Option<u64>,
}

fn seconds_between(from: SystemTime, to: SystemTime) -> u64 {
    to.duration_since(from).unwrap_or_default().as_secs().max(1)
}

fn time_to_epoch(time: SystemTime) -> Option<u64> {
    time.duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .map(|since| since.as_secs())
}

fn epoch_to_time(seconds: u64) -> Option<SystemTime> {
    SystemTime::UNIX_EPOCH.checked_add(Duration::from_secs(seconds))
}

#[cfg(test)]
mod tests {
    use super::*;

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    fn at(seconds: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000 + seconds)
    }

    #[test]
    fn a_fresh_guard_allows_an_attempt() {
        assert!(PairingGuard::new().check(at(0)).is_ok());
    }

    #[test]
    fn attempts_are_spaced_so_a_retry_loop_cannot_spend_the_budget_instantly() -> TestResult {
        // Without spacing, a client that retried in a tight loop would burn all five attempts
        // before a human could read the error — turning a five-guess budget into a five-guess
        // budget spent in a millisecond.
        let mut guard = PairingGuard::new();
        if let Err(throttled) = guard.record_failure(at(0)) {
            return Err(
                format!("the first failure must be recorded, not throttled: {throttled}").into(),
            );
        }
        assert!(matches!(guard.check(at(0)), Err(Throttled::TooSoon { .. })));
        assert!(guard.check(at(1)).is_err(), "one second is still too soon");
        assert!(guard.check(at(2)).is_ok(), "two seconds is enough");
        Ok(())
    }

    #[test]
    fn repeated_failures_lock_out() -> TestResult {
        // The DoS half of the argument: the point is to stop a grind, not to make guessing
        // mathematically impossible — single use already does that.
        let mut guard = PairingGuard::new();
        for attempt in 0..ATTEMPTS_BEFORE_LOCKOUT - 1 {
            if let Err(throttled) = guard.record_failure(at(u64::from(attempt) * 10)) {
                return Err(format!("attempt {attempt} must not lock out yet: {throttled}").into());
            }
        }
        match guard.record_failure(at(100)) {
            Err(Throttled::LockedOut { .. }) => {}
            other => {
                return Err(format!("the threshold attempt must lock out, got {other:?}").into());
            }
        }

        // And the lockout refuses everything until it expires.
        assert!(matches!(
            guard.check(at(100)),
            Err(Throttled::LockedOut { .. })
        ));
        assert!(
            guard
                .check(at(100 + LOCKOUT_DURATION.as_secs() - 1))
                .is_err()
        );
        assert!(guard.check(at(100 + LOCKOUT_DURATION.as_secs())).is_ok());
        Ok(())
    }

    #[test]
    fn a_successful_pairing_clears_the_history() {
        // A user who paired successfully is not guessing, so their earlier typos must not
        // count against them — and must not leave them one failure from a lockout.
        let mut guard = PairingGuard::new();
        let _ = guard.record_failure(at(0));
        let _ = guard.record_failure(at(10));
        guard.record_success();
        assert_eq!(guard.failures(), 0);
        assert!(guard.check(at(10)).is_ok());
    }

    #[test]
    fn a_lockout_does_not_let_the_attacker_lock_the_user_out_forever() {
        // The failure count resets when the lockout is applied, so failing once per window
        // cannot hold a permanent lockout on the user. The tradeoff is explicit: an attacker
        // who paces themselves gets five guesses per five minutes rather than none.
        let mut guard = PairingGuard::new();
        for attempt in 0..ATTEMPTS_BEFORE_LOCKOUT {
            let _ = guard.record_failure(at(u64::from(attempt) * 10));
        }
        assert_eq!(guard.failures(), 0, "the window restarts with the lockout");
    }

    #[test]
    fn the_guard_round_trips_through_a_file() -> TestResult {
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("pairing-throttle.json");
        let mut guard = PairingGuard::new();
        guard.record_failure(at(500))?;
        guard.save(&path)?;

        let loaded = PairingGuard::load(&path)?;
        assert_eq!(loaded.failures(), 1);
        // The timestamps survive, so the spacing rule still applies after a restart. An
        // in-memory limiter would reset here, which is exactly the pattern an attacker wants.
        assert!(matches!(
            loaded.check(at(500)),
            Err(Throttled::TooSoon { .. })
        ));
        Ok(())
    }

    #[test]
    fn a_missing_file_is_no_history_and_a_broken_one_is_an_error() -> TestResult {
        let directory = tempfile::tempdir()?;
        let missing = directory.path().join("absent.json");
        assert_eq!(PairingGuard::load(&missing)?.failures(), 0);

        let broken = directory.path().join("broken.json");
        std::fs::write(&broken, "{ not json")?;
        assert!(
            matches!(
                PairingGuard::load(&broken),
                Err(GuardError::Malformed { .. })
            ),
            "an unreadable throttle state must not be read as 'no attempts yet'"
        );
        Ok(())
    }
}
