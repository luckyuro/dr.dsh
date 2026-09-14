//! Crash reports the client sent, kept on the user's own machine.
//!
//! ## Why the reports land here and not on a server
//!
//! The client is a browser page; when it fails in the field, the person who can act on the failure is
//! the person whose daemon it was talking to. Sending the report anywhere else would mean a service
//! that receives fragments of other people's failures, which is a privacy decision this project has
//! not made and does not need to make to have usable crash reporting (project definition § 9.5, and
//! ADR-0006's "off by default" stance on the neighbouring question of push).
//!
//! So a report travels one hop — client to its own daemon, inside the sealed tunnel — and is written
//! to `crash-reports.jsonl` beside the device registry, `0600`, where `drdshd crashes` can show it and
//! a person can delete it. Nothing is uploaded, and nothing is written without the client asking.
//!
//! ## Bounds
//!
//! A report is a summary, and a store that grows without limit is a denial-of-service the *user*
//! pays for. Three limits, all of them enforced here rather than trusted from the peer:
//!
//! * Every text field is capped ([`MAX_TEXT_LEN`]) and control characters are replaced, so a report
//!   cannot forge a second log line or smuggle terminal escapes into a terminal.
//! * A report carries at most [`MAX_SAMPLES`] samples of at most [`MAX_SAMPLE_LEN`] bytes.
//! * The file holds at most [`MAX_REPORTS`] reports; past that the daemon refuses rather than
//!   evicting, because silently dropping the *previous* crash to store this one loses exactly the
//!   evidence someone is looking for. The refusal names `drdshd crashes --clear`.

use std::io::Write as _;
use std::path::Path;

use dr_dsh_proto::control::CrashReport;

/// File name inside the daemon's state directory.
pub const FILE_NAME: &str = "crash-reports.jsonl";

/// How many reports the file may hold before the daemon starts refusing.
pub const MAX_REPORTS: usize = 20;

/// Longest any single text field may be, in bytes.
pub const MAX_TEXT_LEN: usize = 200;

/// The path of the crash log inside a state directory.
#[must_use]
pub fn path_in(directory: &Path) -> std::path::PathBuf {
    directory.join(FILE_NAME)
}

/// What the daemon did with a report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stored {
    /// How many reports the file holds after this call.
    pub count: u32,
}

/// Why a report was not stored.
///
/// A plain `String` would be easier and worse: every one of these is shown to a person, and the
/// distinction between "this daemon will not hold that" and "the disk is full" is the difference
/// between a client bug and a machine problem.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refused {
    /// A field or the report as a whole is larger than the daemon accepts.
    TooLarge(String),
    /// The file already holds [`MAX_REPORTS`] reports.
    Full,
    /// The report could not be written.
    Storage(String),
}

impl Refused {
    /// The sentence a client shows the user.
    #[must_use]
    pub fn reason(&self) -> String {
        match self {
            Self::TooLarge(what) => format!("the daemon will not store {what}"),
            Self::Full => format!(
                "the daemon already holds {MAX_REPORTS} crash reports; run `drdshd crashes --clear` \
                 on that machine to make room"
            ),
            Self::Storage(detail) => format!("the daemon could not write the report: {detail}"),
        }
    }
}

impl core::fmt::Display for Refused {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter.write_str(&self.reason())
    }
}

impl std::error::Error for Refused {}

/// Replaces control characters (and anything non-printable) and truncates to [`MAX_TEXT_LEN`].
///
/// Applied by the daemon even though the client is supposed to have done it: the client is the
/// component that crashed, so it is the one whose guarantees are least trustworthy, and the file
/// these lines go into is read by a terminal.
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
    truncate(&cleaned, MAX_TEXT_LEN)
}

/// Truncates to at most `limit` bytes, on a character boundary.
#[must_use]
fn truncate(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_owned();
    }
    let mut end = limit;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

/// Checks the bounds the daemon enforces, independently of the sender.
///
/// Returns the report with its text sanitized, or the reason it is refused. Refusal rather than
/// silent truncation for the sample *count*: a report that says twenty failures when the client
/// recorded two hundred is a report that lies about its own completeness.
///
/// # Errors
///
/// [`Refused::TooLarge`] naming the field that is over its cap.
pub fn validate(mut report: CrashReport) -> Result<CrashReport, Refused> {
    if report.samples.len() > CrashReport::MAX_SAMPLES {
        return Err(Refused::TooLarge(format!(
            "a report with {} failure samples (the limit is {})",
            report.samples.len(),
            CrashReport::MAX_SAMPLES
        )));
    }
    report.client = sanitize(&report.client);
    report.phase = sanitize(&report.phase);
    report.user_agent = sanitize(&report.user_agent);
    for sample in &mut report.samples {
        if sample.len() > CrashReport::MAX_SAMPLE_LEN {
            return Err(Refused::TooLarge(format!(
                "a failure sample of {} bytes (the limit is {})",
                sample.len(),
                CrashReport::MAX_SAMPLE_LEN
            )));
        }
        *sample = sanitize(sample);
    }
    // The serialized form is what is actually written, so the cap is checked against it rather than
    // against the sum of the fields: a peer that found a way to make `serde` emit more than the
    // fields suggest would otherwise get past a field-by-field check.
    let encoded =
        serde_json::to_string(&report).map_err(|error| Refused::Storage(error.to_string()))?;
    if encoded.len() > CrashReport::MAX_REPORT_LEN {
        return Err(Refused::TooLarge(format!(
            "a report of {} bytes (the limit is {})",
            encoded.len(),
            CrashReport::MAX_REPORT_LEN
        )));
    }
    Ok(report)
}

/// Appends one report, enforcing the bounds and the file's own limits.
///
/// # Errors
///
/// See [`Refused`].
pub fn store(directory: &Path, report: CrashReport) -> Result<Stored, Refused> {
    let report = validate(report)?;
    let path = path_in(directory);
    let existing = count(&path).map_err(|error| Refused::Storage(error.to_string()))?;
    if existing >= MAX_REPORTS as u32 {
        return Err(Refused::Full);
    }
    let line =
        serde_json::to_string(&report).map_err(|error| Refused::Storage(error.to_string()))?;
    // One line per report, appended: a report is evidence, and rewriting the file to add one would
    // make a crash during the rewrite lose every earlier report.
    #[cfg(unix)]
    let opened = {
        use std::os::unix::fs::OpenOptionsExt as _;
        std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .mode(0o600)
            .open(&path)
    };
    #[cfg(not(unix))]
    let opened = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(&path);
    let mut file = opened.map_err(|error| Refused::Storage(error.to_string()))?;
    writeln!(file, "{line}").map_err(|error| Refused::Storage(error.to_string()))?;
    Ok(Stored {
        count: existing + 1,
    })
}

/// How many reports the file holds.
///
/// Counts complete lines — non-empty and newline-terminated — so a file whose last write was torn
/// reports the number of reports it can actually hand back. A torn line is still *shown* by
/// [`list`]: incomplete evidence is evidence.
///
/// # Errors
///
/// Returns the I/O error, except for "the file does not exist yet", which is zero.
pub fn count(path: &Path) -> std::io::Result<u32> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(text
            .split_inclusive('\n')
            .filter(|line| line.ends_with('\n') && !line.trim().is_empty())
            .count() as u32),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(error),
    }
}

/// Reads the stored reports, oldest first.
///
/// A line that does not parse is kept as a raw string rather than dropped: a report that cannot be
/// decoded is still evidence, and hiding it would make the file's contents differ from what
/// `drdshd crashes` shows.
///
/// # Errors
///
/// Returns the I/O error when the file cannot be read.
pub fn list(path: &Path) -> std::io::Result<Vec<String>> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(text
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(str::to_owned)
            .collect()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error),
    }
}

/// Deletes the file, so the next report starts a fresh one.
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

    fn report(samples: Vec<String>) -> CrashReport {
        CrashReport {
            client: "pwa 0.0.0".to_owned(),
            phase: "connecting".to_owned(),
            reached_ready: false,
            errors: samples.len() as u32,
            rejections: 0,
            samples,
            user_agent: "Mozilla/5.0".to_owned(),
            at_ms: 1_700_000_000_000,
        }
    }

    #[test]
    fn a_report_is_appended_as_one_line_and_readable_by_a_person() -> TestResult {
        let directory = tempfile::tempdir()?;
        let stored = store(
            directory.path(),
            report(vec!["TypeError: x is not a function".into()]),
        )?;
        assert_eq!(stored.count, 1);
        let listed = list(&path_in(directory.path()))?;
        assert_eq!(listed.len(), 1);
        assert!(
            listed[0].contains("TypeError: x is not a function"),
            "{}",
            listed[0]
        );
        assert!(
            listed[0].contains("\"reached_ready\":false"),
            "{}",
            listed[0]
        );
        Ok(())
    }

    #[test]
    fn a_report_cannot_forge_a_second_line_or_a_terminal_escape() -> TestResult {
        let directory = tempfile::tempdir()?;
        store(
            directory.path(),
            report(vec!["boom\n{\"client\":\"forged\"}\u{1b}[31m".to_owned()]),
        )?;
        let listed = list(&path_in(directory.path()))?;
        // One line in, one line out: a newline in a sample that survived would let a client write
        // arbitrary content into a file a person reads with `drdshd crashes`.
        assert_eq!(listed.len(), 1);
        assert!(!listed[0].contains('\u{1b}'), "{}", listed[0]);
        Ok(())
    }

    #[test]
    fn the_file_is_private_to_its_owner() -> TestResult {
        let directory = tempfile::tempdir()?;
        store(directory.path(), report(Vec::new()))?;
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
    fn the_count_is_the_number_of_complete_lines() -> TestResult {
        let directory = tempfile::tempdir()?;
        let path = path_in(directory.path());
        std::fs::write(&path, "{\"a\":1}\n{\"b\":2}\n{\"half\"")?;
        assert_eq!(count(&path)?, 2);
        assert_eq!(list(&path)?.len(), 3, "a torn line is still evidence");
        Ok(())
    }

    #[test]
    fn the_store_refuses_rather_than_evicting_when_it_is_full() -> TestResult {
        let directory = tempfile::tempdir()?;
        for _ in 0..MAX_REPORTS {
            store(directory.path(), report(Vec::new()))?;
        }
        // Refusing beats evicting: the report being replaced is the one somebody is looking for, and
        // a full log is a state an operator can see and clear.
        assert_eq!(
            store(directory.path(), report(Vec::new())),
            Err(Refused::Full)
        );
        assert_eq!(count(&path_in(directory.path()))?, MAX_REPORTS as u32);
        assert!(clear(&path_in(directory.path()))?);
        assert_eq!(store(directory.path(), report(Vec::new()))?.count, 1);
        Ok(())
    }

    #[test]
    fn an_oversized_report_is_refused_and_nothing_is_written() -> TestResult {
        let directory = tempfile::tempdir()?;
        let too_many = report(vec!["x".to_owned(); CrashReport::MAX_SAMPLES + 1]);
        assert!(matches!(
            store(directory.path(), too_many),
            Err(Refused::TooLarge(_))
        ));
        let too_long = report(vec!["x".repeat(CrashReport::MAX_SAMPLE_LEN + 1)]);
        assert!(matches!(
            store(directory.path(), too_long),
            Err(Refused::TooLarge(_))
        ));
        assert_eq!(count(&path_in(directory.path()))?, 0);
        Ok(())
    }

    #[test]
    fn sanitizing_keeps_a_long_message_readable_rather_than_dropping_it() {
        let long = "a".repeat(MAX_TEXT_LEN + 50);
        assert_eq!(sanitize(&long).len(), MAX_TEXT_LEN);
        assert_eq!(sanitize("two\nlines"), "two lines");
        // A multi-byte character on the boundary is not split: a report full of replacement
        // characters is a report nobody can read.
        let unicode = "é".repeat(MAX_TEXT_LEN);
        assert!(sanitize(&unicode).len() <= MAX_TEXT_LEN);
        assert!(sanitize(&unicode).chars().all(|c| c == 'é'));
    }
}
