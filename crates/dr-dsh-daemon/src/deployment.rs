//! Deployment detection: recognising the network shape in front of the relay.
//!
//! ## The failure this exists for
//!
//! The carrier between the daemon and the relay is a **long-lived, mostly idle** WebSocket. That is
//! unusual traffic for a reverse proxy, whose defaults are written for request/response: nginx closes
//! a proxied connection after `proxy_read_timeout` (60 seconds by default) with nothing to read. A
//! user who puts dr.dsh behind nginx therefore gets a daemon that reconnects every minute forever,
//! while every log line on both sides says the connection simply ended — nothing names the proxy,
//! because from the daemon's side a proxy timeout and a relay restart are the same event.
//!
//! What *is* distinguishable is the **shape**: a proxy closes a quiet connection after a
//! suspiciously regular interval, again and again, and never while a client session is running. A
//! relay restart is irregular, and a legitimate client leaving is a release the relay names.
//!
//! So the daemon watches carrier lifetimes and says something once, with the observed numbers in the
//! message. M4's completion standard asks for exactly this: "a reverse-proxy timeout is detected and
//! warned about at startup".
//!
//! ## Why the heuristic, and not a configuration flag
//!
//! An operator could be asked to declare "there is a proxy with a 60s read timeout", and the
//! declaration would be wrong the moment they change the proxy. The observation costs three
//! reconnections and needs no configuration, and when it fires it can quote the intervals that
//! produced it — which is what makes the warning actionable rather than generic.

use std::collections::VecDeque;
use std::time::Duration;

/// Lifetimes shorter than this are not evidence of a proxy timeout.
///
/// A relay that restarts, a network that flaps, or a daemon whose dial fails all produce short-lived
/// connections, and warning about a proxy on the basis of those would train the user to ignore the
/// warning. Real `proxy_read_timeout` values are 30s and up.
pub const MIN_SUSPICIOUS_LIFETIME: Duration = Duration::from_secs(20);

/// How many consecutive suspicious lifetimes are needed before saying anything.
pub const OBSERVATIONS_BEFORE_WARNING: usize = 3;

/// How close together the lifetimes have to be, as a fraction of their mean.
///
/// A proxy closes on a schedule; anything else that ends a connection does not. 20% is loose enough
/// for scheduler jitter (a 60s timeout observed as 58–62s) and tight enough that "the relay was
/// restarted twice" does not look like a schedule.
pub const REGULARITY_TOLERANCE: f64 = 0.2;

/// What one ended carrier connection looked like.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CarrierEnding {
    /// How long the connection lived.
    pub lifetime: Duration,
    /// Whether a client ever established a session on it.
    ///
    /// A connection that carried a session and then ended is normal traffic: the client left, or its
    /// phone slept. Only connections that were quiet for their whole life are evidence.
    pub carried_session: bool,
}

/// Watches carrier lifetimes and produces one warning when they look like a proxy's doing.
#[derive(Debug, Default)]
pub struct IdleDropWatch {
    /// The most recent suspicious lifetimes, oldest first.
    recent: VecDeque<Duration>,
    /// Whether the warning has been printed; printed once, because a warning repeated every minute is
    /// a log nobody reads.
    warned: bool,
}

impl IdleDropWatch {
    /// A watch that has seen nothing.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether the warning has already been produced.
    #[must_use]
    pub fn has_warned(&self) -> bool {
        self.warned
    }

    /// Records one ended connection, and returns the warning to print when the pattern is clear.
    ///
    /// Returns `None` for a connection that carried a session, for one that was too short to be a
    /// timeout, and for every observation after the first warning.
    pub fn observe(&mut self, ending: CarrierEnding) -> Option<String> {
        if self.warned || ending.carried_session || ending.lifetime < MIN_SUSPICIOUS_LIFETIME {
            return None;
        }
        self.recent.push_back(ending.lifetime);
        while self.recent.len() > OBSERVATIONS_BEFORE_WARNING {
            self.recent.pop_front();
        }
        if self.recent.len() < OBSERVATIONS_BEFORE_WARNING {
            return None;
        }
        let mean =
            self.recent.iter().map(Duration::as_secs_f64).sum::<f64>() / self.recent.len() as f64;
        let regular = self
            .recent
            .iter()
            .all(|lifetime| (lifetime.as_secs_f64() - mean).abs() <= mean * REGULARITY_TOLERANCE);
        if !regular {
            return None;
        }
        self.warned = true;
        let observed = self
            .recent
            .iter()
            .map(|lifetime| format!("{:.0}s", lifetime.as_secs_f64()))
            .collect::<Vec<_>>()
            .join(", ");
        Some(format!(
            "the carrier connection has been closed after about {mean:.0}s of silence, {count} times \
             in a row, and no client session ever ran on those connections (observed lifetimes: \
             {observed}). This is what a reverse proxy in front of the relay looks like when its read \
             timeout is shorter than the tunnel needs — nginx's `proxy_read_timeout` defaults to 60s \
             and applies to a WebSocket that is idle between sessions. Raise it above the longest \
             quiet period you expect (nginx: `proxy_read_timeout 3600s;`), make sure the upgrade is \
             not buffered (`proxy_buffering off;`), and restart this daemon.",
            count = self.recent.len()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    /// A connection that was quiet for its whole life.
    fn idle(seconds: u64) -> CarrierEnding {
        CarrierEnding {
            lifetime: Duration::from_secs(seconds),
            carried_session: false,
        }
    }

    #[test]
    fn three_regular_quiet_lifetimes_produce_one_warning() -> TestResult {
        let mut watch = IdleDropWatch::new();
        assert!(watch.observe(idle(60)).is_none(), "one is not a pattern");
        assert!(watch.observe(idle(61)).is_none(), "two is not a pattern");
        let warning = watch
            .observe(idle(59))
            .ok_or("three regular quiet lifetimes must warn")?;
        assert!(warning.contains("60s"), "{warning}");
        assert!(warning.contains("proxy_read_timeout"), "{warning}");
        // Once. A warning repeated every minute is a log nobody reads.
        assert!(watch.observe(idle(60)).is_none());
        assert!(watch.has_warned());
        Ok(())
    }

    #[test]
    fn irregular_lifetimes_are_not_a_pattern() -> TestResult {
        let mut watch = IdleDropWatch::new();
        assert!(watch.observe(idle(60)).is_none());
        assert!(watch.observe(idle(20)).is_none());
        assert!(
            watch.observe(idle(300)).is_none(),
            "60s, 20s and 300s is a flapping network, not a schedule"
        );
        assert!(!watch.has_warned());
        Ok(())
    }

    #[test]
    fn a_connection_that_carried_a_session_is_not_evidence() -> TestResult {
        let mut watch = IdleDropWatch::new();
        // A client that connects, works and leaves produces exactly this, three times a minute on a
        // busy daemon, and none of it is a proxy problem.
        for _ in 0..4 {
            let ending = CarrierEnding {
                lifetime: Duration::from_secs(60),
                carried_session: true,
            };
            assert!(watch.observe(ending).is_none());
        }
        assert!(!watch.has_warned());
        Ok(())
    }

    #[test]
    fn short_lifetimes_are_not_evidence_either() -> TestResult {
        let mut watch = IdleDropWatch::new();
        // A relay that is down, or a daemon whose dial fails: regular, short, and nothing to do with
        // a proxy read timeout. Warning here would teach the user to ignore the warning.
        for _ in 0..5 {
            assert!(watch.observe(idle(2)).is_none());
        }
        assert!(!watch.has_warned());
        Ok(())
    }

    #[test]
    fn the_window_slides_so_an_old_observation_does_not_count_forever() -> TestResult {
        let mut watch = IdleDropWatch::new();
        assert!(watch.observe(idle(60)).is_none());
        assert!(watch.observe(idle(60)).is_none());
        // A long, healthy connection in between resets what "three in a row" means.
        assert!(watch.observe(idle(20)).is_none());
        assert!(watch.observe(idle(300)).is_none());
        assert!(
            watch.observe(idle(60)).is_none(),
            "not three in a row any more"
        );
        assert!(!watch.has_warned());
        Ok(())
    }
}
