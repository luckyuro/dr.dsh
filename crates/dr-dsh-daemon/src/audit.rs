//! The audit log: who did what to this machine, kept on this machine.
//!
//! ADR-0012 decided the shape, and this module is it:
//!
//! * `$DSHD_STATE_DIR/audit.jsonl`, one JSON object per line, **0600** — beside the device registry,
//!   which is the file this log is mostly about.
//! * A **closed set** of events ([`Event`]), a closed set of outcomes ([`Outcome`]), and five fields:
//!   `at_ms`, `event`, `device`, `outcome`, `reason`. There is no field for a payload, a URL, a message
//!   body, a file path, or a key — the same minimisation rule as notifications (ADR-0006) and crash
//!   reports (`docs/security.md` § 5.10).
//! * **30 days or 10 000 lines, whichever comes first**, enforced on the write path: the daemon is a
//!   foreground process with no cron to lean on, so retention cannot be somebody else's job.
//! * **Never uploaded.** No relay, no hosted service, no tunnel to a client. The way to read it is
//!   `drdshd audit` on that machine, and the way to share it is a person copying it.
//!
//! ## Why it must not be able to break anything
//!
//! Recording is **best effort**: if the disk is full or the directory was removed underneath the
//! daemon, the event is lost, a warning is printed, and the daemon carries on serving. Turning "the
//! audit log cannot be written" into "the tunnel stops working" would hand anyone who can fill the disk
//! a denial of service, and the log exists to make attacks harder, not easier.
//!
//! `DSHD_AUDIT=0` turns recording off entirely. `drdshd audit` distinguishes "off" from "no events",
//! because those two states mean completely different things to somebody debugging access.

use std::io::Write as _;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// File name inside the daemon's state directory.
pub const FILE_NAME: &str = "audit.jsonl";

/// Environment variable that turns auditing off when it is exactly `0`.
pub const ENV_DISABLED: &str = "DSHD_AUDIT";

/// Longest a reason may be, in bytes.
pub const MAX_REASON_LEN: usize = 200;

/// How long an entry is kept.
pub const MAX_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// How many entries are kept.
pub const MAX_LINES: usize = 10_000;

/// What happened. A closed set: a new event means changing this enum, the writer, and the reader.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    /// A device redeemed a pairing code and was enrolled.
    PairingAccepted,
    /// A pairing was refused before a code was even minted (the throttle).
    PairingRefused,
    /// A pairing exchange failed.
    PairingFailed,
    /// A failure tripped the pairing throttle.
    PairingLockedOut,
    /// A device was revoked from the registry.
    DeviceRevoked,
    /// A client established a session on the carrier.
    TunnelEstablished,
    /// The session on the carrier ended (relay released it, socket broke, or client left).
    TunnelReleased,
    /// A lifecycle command reached the daemon, with its result.
    LifecycleCommand,
}

impl Event {
    /// The wire name, which is also what a person reads.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PairingAccepted => "pairing_accepted",
            Self::PairingRefused => "pairing_refused",
            Self::PairingFailed => "pairing_failed",
            Self::PairingLockedOut => "pairing_locked_out",
            Self::DeviceRevoked => "device_revoked",
            Self::TunnelEstablished => "tunnel_established",
            Self::TunnelReleased => "tunnel_released",
            Self::LifecycleCommand => "lifecycle_command",
        }
    }

    /// Parses a name back, so the reader and the writer cannot drift.
    #[must_use]
    pub fn parse(name: &str) -> Option<Self> {
        [
            Self::PairingAccepted,
            Self::PairingRefused,
            Self::PairingFailed,
            Self::PairingLockedOut,
            Self::DeviceRevoked,
            Self::TunnelEstablished,
            Self::TunnelReleased,
            Self::LifecycleCommand,
        ]
        .into_iter()
        .find(|event| event.as_str() == name)
    }
}

/// How it ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// It happened.
    Ok,
    /// It was deliberately refused; retrying cannot change that.
    Refused,
    /// It was attempted and failed.
    Failed,
}

impl Outcome {
    /// The wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Refused => "refused",
            Self::Failed => "failed",
        }
    }
}

/// The audit log inside a state directory.
#[must_use]
pub fn path_in(directory: &Path) -> std::path::PathBuf {
    directory.join(FILE_NAME)
}

/// Whether auditing is on, from the environment value.
///
/// `None` means "not set", which is on: an audit log that only exists when somebody opts in is not an
/// audit log. Only the exact string `0` disables it, so a typo cannot silently turn it off.
#[must_use]
pub fn enabled_from(value: Option<&str>) -> bool {
    value != Some("0")
}

/// Whether auditing is on in this process.
#[must_use]
pub fn enabled() -> bool {
    enabled_from(std::env::var(ENV_DISABLED).ok().as_deref())
}

/// Replaces control characters (and anything non-printable) and truncates to [`MAX_REASON_LEN`].
///
/// Applied to free text from errors, which is where a newline would let one event become two — and a
/// fabricated audit record is worse than a missing one.
#[must_use]
pub fn sanitize(text: &str) -> String {
    let cleaned: String = text
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect();
    if cleaned.len() <= MAX_REASON_LEN {
        return cleaned;
    }
    let mut end = MAX_REASON_LEN;
    while end > 0 && !cleaned.is_char_boundary(end) {
        end -= 1;
    }
    cleaned[..end].to_owned()
}

/// Now, in Unix milliseconds.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| u64::try_from(since.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// Records one event.
///
/// Best effort by design: it returns nothing, and a failure is reported once per process on stderr
/// rather than propagated. See the module docs for why that is not laziness.
pub fn record(
    directory: &Path,
    event: Event,
    device: Option<&str>,
    outcome: Outcome,
    reason: Option<&str>,
) {
    if !enabled() {
        return;
    }
    if let Err(error) = append_and_prune(directory, event, device, outcome, reason) {
        // Warned once: a daemon with a full disk would otherwise print this on every event, and the
        // useful signal ("the audit log is not being written") is in the first line.
        warn_once(&format!(
            "audit: cannot write {}: {error}. Events are still served; fix the disk or the directory",
            path_in(directory).display()
        ));
    }
}

/// Warns once per process, so a recurring failure does not become a log flood of its own.
fn warn_once(message: &str) {
    static WARNED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    if WARNED.set(()).is_ok() {
        eprintln!("{message}");
    }
}

/// Appends one line, then drops what the retention policy no longer keeps.
fn append_and_prune(
    directory: &Path,
    event: Event,
    device: Option<&str>,
    outcome: Outcome,
    reason: Option<&str>,
) -> std::io::Result<()> {
    let path = path_in(directory);
    let line = encode(event, device, outcome, reason, now_ms());

    #[cfg(unix)]
    let mut file = {
        use std::os::unix::fs::OpenOptionsExt as _;
        std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .mode(0o600)
            .open(&path)?
    };
    #[cfg(not(unix))]
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(&path)?;
    file.write_all(line.as_bytes())?;
    file.write_all(b"\n")?;
    drop(file);

    prune(&path)
}

/// Builds one JSON line by hand.
///
/// Hand-written rather than `serde` because the field set *is* the privacy promise, and a `#[derive]`
/// on a struct that later gains a field would weaken it silently. Escaping goes through
/// `serde_json::to_string` for the strings only.
fn encode(
    event: Event,
    device: Option<&str>,
    outcome: Outcome,
    reason: Option<&str>,
    at_ms: u64,
) -> String {
    let quote = |text: &str| {
        serde_json::to_string(&sanitize(text)).unwrap_or_else(|_| "\"<unencodable>\"".to_owned())
    };
    let device = device.map_or_else(|| "null".to_owned(), quote);
    let reason = reason.map_or_else(|| "null".to_owned(), quote);
    format!(
        "{{\"at_ms\":{at_ms},\"event\":\"{}\",\"device\":{device},\"outcome\":\"{}\",\"reason\":{reason}}}",
        event.as_str(),
        outcome.as_str()
    )
}

/// One parsed entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// When it happened, in Unix milliseconds.
    pub at_ms: u64,
    /// What happened.
    pub event: Event,
    /// Which device, when the event belongs to one.
    pub device: Option<String>,
    /// How it ended.
    pub outcome: Outcome,
    /// Free text, already sanitized.
    pub reason: Option<String>,
}

/// What a read found.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Read {
    /// Entries within the retention window, oldest first.
    pub entries: Vec<String>,
    /// Entries the reader hid because they are older than [`MAX_AGE`].
    pub too_old: usize,
    /// Lines that are not entries, kept because unreadable evidence is still evidence.
    pub unreadable: Vec<String>,
}

/// Applies the retention policy: drops entries past [`MAX_AGE`] or beyond the newest [`MAX_LINES`].
///
/// Rewrites only when something has to go, so the steady state is one read per event and no writes.
fn prune(path: &Path) -> std::io::Result<()> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let lines: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    let cutoff = now_ms().saturating_sub(u64::try_from(MAX_AGE.as_millis()).unwrap_or(u64::MAX));

    let mut keep: Vec<&str> = Vec::with_capacity(lines.len());
    let mut dropped_old = false;
    for line in lines {
        match parse_entry(line) {
            // An entry we can date: kept only if it is inside the window.
            Some(entry) if entry.at_ms < cutoff => dropped_old = true,
            // A line we cannot read is kept: dropping it would make the file disagree with itself,
            // and a corrupt audit line is exactly the kind of thing somebody needs to see.
            _ => keep.push(line),
        }
    }
    let mut dropped_over_cap = false;
    if keep.len() > MAX_LINES {
        let excess = keep.len() - MAX_LINES;
        keep.drain(..excess);
        dropped_over_cap = true;
    }
    if !dropped_old && !dropped_over_cap {
        return Ok(());
    }

    // Written through a temporary file and renamed, so a crash mid-prune cannot leave a half-written
    // audit log — the one file where "some lines went missing" and "someone deleted lines" must be
    // distinguishable.
    let temporary = path.with_extension("jsonl.tmp");
    {
        #[cfg(unix)]
        let mut file = {
            use std::os::unix::fs::OpenOptionsExt as _;
            std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&temporary)?
        };
        #[cfg(not(unix))]
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&temporary)?;
        for line in &keep {
            file.write_all(line.as_bytes())?;
            file.write_all(b"\n")?;
        }
        file.flush()?;
    }
    std::fs::rename(&temporary, path)
}

/// Parses one line, or `None` when it is not an entry this version understands.
#[must_use]
pub fn parse_entry(line: &str) -> Option<Entry> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    let event = Event::parse(value.get("event")?.as_str()?)?;
    let outcome = match value.get("outcome")?.as_str()? {
        "ok" => Outcome::Ok,
        "refused" => Outcome::Refused,
        "failed" => Outcome::Failed,
        _ => return None,
    };
    Some(Entry {
        at_ms: value.get("at_ms")?.as_u64()?,
        event,
        device: value
            .get("device")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        outcome,
        reason: value
            .get("reason")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
    })
}

/// Reads the log, applying the retention window as a *filter* as well.
///
/// The daemon prunes on write, but a machine whose daemon has not run for months still has the file —
/// and a reader that showed year-old entries would quietly disagree with the retention policy.
///
/// # Errors
///
/// Returns the I/O error, except for "the file does not exist yet", which reads as empty.
pub fn read(path: &Path) -> std::io::Result<Read> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Read::default()),
        Err(error) => return Err(error),
    };
    let cutoff = now_ms().saturating_sub(u64::try_from(MAX_AGE.as_millis()).unwrap_or(u64::MAX));
    let mut read = Read::default();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        match parse_entry(line) {
            Some(entry) if entry.at_ms < cutoff => read.too_old += 1,
            Some(_) => read.entries.push(line.to_owned()),
            None => read.unreadable.push(line.to_owned()),
        }
    }
    Ok(read)
}

/// Deletes the file, so the next event starts a fresh one.
///
/// # Errors
///
/// Returns the I/O error when the file exists and cannot be removed.
pub fn clear(path: &Path) -> std::io::Result<bool> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    fn stored(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap_or_default()
    }

    #[test]
    fn one_event_is_one_line_with_the_five_fields() -> TestResult {
        let directory = tempfile::tempdir()?;
        let path = path_in(directory.path());
        record(
            directory.path(),
            Event::TunnelEstablished,
            Some("device-1"),
            Outcome::Ok,
            None,
        );
        let line = stored(&path);
        assert_eq!(line.lines().count(), 1);
        let entry = parse_entry(line.trim()).ok_or("the line is not an entry")?;
        assert_eq!(entry.event, Event::TunnelEstablished);
        assert_eq!(entry.outcome, Outcome::Ok);
        assert_eq!(entry.device.as_deref(), Some("device-1"));
        assert_eq!(entry.reason, None);
        assert!(entry.at_ms > 1_600_000_000_000, "{}", entry.at_ms);
        // The field set is the privacy promise; a new field has to be a deliberate change here.
        let value: serde_json::Value = serde_json::from_str(line.trim())?;
        let mut keys: Vec<&str> = value
            .as_object()
            .ok_or("not an object")?
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, ["at_ms", "device", "event", "outcome", "reason"]);
        Ok(())
    }

    #[test]
    fn every_event_and_outcome_round_trips() -> TestResult {
        let directory = tempfile::tempdir()?;
        let path = path_in(directory.path());
        for (event, outcome) in [
            (Event::PairingAccepted, Outcome::Ok),
            (Event::PairingRefused, Outcome::Refused),
            (Event::PairingFailed, Outcome::Failed),
            (Event::PairingLockedOut, Outcome::Refused),
            (Event::DeviceRevoked, Outcome::Ok),
            (Event::TunnelEstablished, Outcome::Ok),
            (Event::TunnelReleased, Outcome::Ok),
            (Event::LifecycleCommand, Outcome::Failed),
        ] {
            record(directory.path(), event, None, outcome, Some("because"));
        }
        let read = read(&path)?;
        assert_eq!(read.entries.len(), 8);
        for (index, line) in read.entries.iter().enumerate() {
            let entry = parse_entry(line).ok_or("unparseable")?;
            assert_eq!(
                entry.outcome,
                match index {
                    0 | 4 | 5 | 6 => Outcome::Ok,
                    1 | 3 => Outcome::Refused,
                    _ => Outcome::Failed,
                }
            );
        }
        // The writer's names and the reader's parser are the same list, so an event added to one and
        // not the other fails here rather than silently becoming an unreadable line.
        for event in [
            Event::PairingAccepted,
            Event::PairingRefused,
            Event::PairingFailed,
            Event::PairingLockedOut,
            Event::DeviceRevoked,
            Event::TunnelEstablished,
            Event::TunnelReleased,
            Event::LifecycleCommand,
        ] {
            assert_eq!(Event::parse(event.as_str()), Some(event));
        }
        assert_eq!(Event::parse("something_else"), None);
        Ok(())
    }

    #[test]
    fn the_file_is_private_to_its_owner() -> TestResult {
        let directory = tempfile::tempdir()?;
        record(
            directory.path(),
            Event::DeviceRevoked,
            Some("d"),
            Outcome::Ok,
            None,
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(path_in(directory.path()))?
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "mode {mode:o}");
        }
        Ok(())
    }

    #[test]
    fn a_reason_cannot_forge_a_second_line_or_a_terminal_escape() -> TestResult {
        let directory = tempfile::tempdir()?;
        let path = path_in(directory.path());
        record(
            directory.path(),
            Event::PairingFailed,
            None,
            Outcome::Failed,
            Some("boom\n{\"event\":\"pairing_accepted\"}\u{1b}[31m"),
        );
        let read = read(&path)?;
        assert_eq!(
            read.entries.len(),
            1,
            "one event is one line: {:?}",
            read.entries
        );
        assert_eq!(read.unreadable.len(), 0);
        let entry = parse_entry(&read.entries[0]).ok_or("unparseable")?;
        let reason = entry.reason.unwrap_or_default();
        assert!(!reason.contains('\u{1b}'), "{reason}");
        assert!(!reason.contains('\n'), "{reason}");
        assert_eq!(
            entry.event,
            Event::PairingFailed,
            "the forged event did not take"
        );
        Ok(())
    }

    #[test]
    fn a_long_reason_is_truncated_on_a_character_boundary() {
        let long = "é".repeat(MAX_REASON_LEN * 2);
        let cut = sanitize(&long);
        assert!(cut.len() <= MAX_REASON_LEN);
        assert!(cut.chars().all(|character| character == 'é'));
    }

    #[test]
    fn entries_past_the_age_window_are_dropped_on_the_next_write() -> TestResult {
        let directory = tempfile::tempdir()?;
        let path = path_in(directory.path());
        let old = encode(Event::TunnelEstablished, None, Outcome::Ok, None, 1_000);
        std::fs::write(&path, format!("{old}\n"))?;
        record(
            directory.path(),
            Event::TunnelReleased,
            None,
            Outcome::Ok,
            None,
        );
        let lines = stored(&path);
        assert!(!lines.contains("\"at_ms\":1000"), "{lines}");
        assert_eq!(lines.lines().count(), 1);
        Ok(())
    }

    #[test]
    fn the_oldest_entries_go_when_the_line_cap_is_passed() -> TestResult {
        let directory = tempfile::tempdir()?;
        let path = path_in(directory.path());
        let mut text = String::new();
        for index in 0..MAX_LINES + 5 {
            // All inside the age window: this test is about the cap, not about time.
            let line = encode(
                Event::LifecycleCommand,
                None,
                Outcome::Ok,
                Some(&format!("event {index}")),
                now_ms(),
            );
            text.push_str(&line);
            text.push('\n');
        }
        std::fs::write(&path, text)?;
        record(
            directory.path(),
            Event::TunnelReleased,
            None,
            Outcome::Ok,
            None,
        );
        let lines = stored(&path);
        assert_eq!(lines.lines().count(), MAX_LINES);
        assert!(
            !lines.contains("event 0\""),
            "the oldest entry should be gone"
        );
        assert!(
            lines.contains("event 10004"),
            "the newest entry should be there"
        );
        Ok(())
    }

    #[test]
    fn a_line_that_is_not_an_entry_is_kept_and_reported() -> TestResult {
        let directory = tempfile::tempdir()?;
        let path = path_in(directory.path());
        std::fs::write(&path, "this is not json\n")?;
        record(
            directory.path(),
            Event::TunnelEstablished,
            None,
            Outcome::Ok,
            None,
        );
        let read = read(&path)?;
        assert_eq!(read.unreadable, vec!["this is not json".to_owned()]);
        assert_eq!(read.entries.len(), 1);
        // Kept on disk too: an unreadable line is evidence, and deleting it would destroy the only
        // record that something wrote a line this version cannot explain.
        assert!(stored(&path).contains("this is not json"));
        Ok(())
    }

    #[test]
    fn nothing_is_rewritten_when_nothing_has_to_go() -> TestResult {
        let directory = tempfile::tempdir()?;
        let path = path_in(directory.path());
        record(
            directory.path(),
            Event::TunnelEstablished,
            None,
            Outcome::Ok,
            None,
        );
        let before = stored(&path);
        // A second write inside the window and under the cap appends without rewriting the file: the
        // first line is byte-identical and still in place.
        record(
            directory.path(),
            Event::TunnelReleased,
            None,
            Outcome::Ok,
            None,
        );
        let after = stored(&path);
        assert!(after.starts_with(&before), "{after}");
        assert!(
            !path.with_extension("jsonl.tmp").exists(),
            "no stray temporary file"
        );
        Ok(())
    }

    #[test]
    fn an_entry_older_than_the_window_is_hidden_even_before_a_write() -> TestResult {
        let directory = tempfile::tempdir()?;
        let path = path_in(directory.path());
        let ancient = encode(Event::PairingAccepted, None, Outcome::Ok, None, 1_000);
        std::fs::write(&path, format!("{ancient}\n"))?;
        let read = read(&path)?;
        assert_eq!(read.entries.len(), 0);
        assert_eq!(read.too_old, 1);
        Ok(())
    }

    #[test]
    fn disabling_takes_exactly_zero() {
        // Not set: on. Any other value: on. A typo must not silently remove the audit log.
        assert!(enabled_from(None));
        assert!(enabled_from(Some("1")));
        assert!(enabled_from(Some("no")));
        assert!(!enabled_from(Some("0")));
    }

    #[test]
    fn clearing_removes_the_file_and_is_idempotent() -> TestResult {
        let directory = tempfile::tempdir()?;
        let path = path_in(directory.path());
        record(
            directory.path(),
            Event::DeviceRevoked,
            None,
            Outcome::Ok,
            None,
        );
        assert!(clear(&path)?);
        assert!(!path.exists());
        assert!(!clear(&path)?, "clearing an absent log is not a failure");
        assert_eq!(read(&path)?.entries.len(), 0);
        Ok(())
    }

    #[test]
    fn a_write_failure_is_not_fatal() {
        // A directory that cannot exist: recording must not panic and must not return an error — the
        // daemon carries on. The warning path is what a person sees; here the point is that nothing
        // else happens.
        let missing = Path::new("/proc/self/mem/audit-cannot-exist");
        record(missing, Event::TunnelEstablished, None, Outcome::Ok, None);
    }
}
