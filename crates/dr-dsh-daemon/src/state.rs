//! Where the daemon keeps state that outlives a run.
//!
//! One file today — the device registry — and the rules for locating it are here rather than
//! spelled out at each call site, because "which file did the daemon actually read" is the
//! first question in every support conversation about access.
//!
//! ## Why an environment override exists
//!
//! Tests need to point a daemon at a scratch registry without touching the operator's real
//! one, and a test that writes to the user's actual device registry is a test that can lock
//! them out of their own machine. `DSHD_STATE_DIR` is that override. It is read **once**, at
//! startup, and never consulted again: a daemon whose state directory can change while it
//! runs is a daemon whose enforcement can change while it runs.

use std::path::{Path, PathBuf};

/// Environment variable naming the state directory.
pub const STATE_DIR_ENV: &str = "DSHD_STATE_DIR";

/// The directory holding the daemon's persistent state.
///
/// Resolution order: `$DSHD_STATE_DIR`, then `$XDG_DATA_HOME/dr.dsh`, then
/// `$HOME/.local/share/dr.dsh`, and finally the current directory — the last only so a
/// daemon with no home still starts rather than refusing to run. It prints the path it chose
/// at startup, so which one it picked is observable rather than inferred.
///
/// # Errors
///
/// Returns an error only when the directory cannot be created.
pub fn state_dir() -> std::io::Result<PathBuf> {
    let directory = resolve(
        std::env::var_os(STATE_DIR_ENV),
        std::env::var_os("XDG_DATA_HOME"),
        std::env::var_os("HOME"),
    );
    std::fs::create_dir_all(&directory)?;
    Ok(directory)
}

/// The pure part of [`state_dir`]: environment values in, a path out.
///
/// Separated so the precedence is testable. The alternative is a test that mutates the
/// process environment, which is both a data race in a threaded test runner and — since this
/// crate forbids `unsafe` — not expressible at all in edition 2024.
#[must_use]
fn resolve(
    explicit: Option<std::ffi::OsString>,
    xdg_data_home: Option<std::ffi::OsString>,
    home: Option<std::ffi::OsString>,
) -> PathBuf {
    if let Some(explicit) = explicit {
        return PathBuf::from(explicit);
    }
    if let Some(data_home) = xdg_data_home {
        return PathBuf::from(data_home).join("dr.dsh");
    }
    if let Some(home) = home {
        return PathBuf::from(home).join(".local/share/dr.dsh");
    }
    PathBuf::from(".")
}

/// The pairing throttle state inside a state directory.
///
/// Beside the registry because the two are read by the same command at the same moment, and a
/// deployment that relocates one means to relocate the other.
#[must_use]
pub fn throttle_path_in(directory: &Path) -> PathBuf {
    directory.join("pairing-throttle.json")
}

/// The device registry path inside a state directory.
#[must_use]
pub fn registry_path_in(directory: &Path) -> PathBuf {
    directory.join("devices.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_registry_lives_in_the_state_directory() {
        let path = registry_path_in(Path::new("/var/lib/dr.dsh"));
        assert_eq!(path, PathBuf::from("/var/lib/dr.dsh/devices.json"));
    }

    #[test]
    fn the_override_wins_over_every_fallback() {
        // A test that wrote to the operator's real registry could lock them out of their own
        // daemon, so the override is not a convenience: it is what makes the tests safe.
        let resolved = resolve(
            Some("/tmp/scratch".into()),
            Some("/xdg".into()),
            Some("/home/someone".into()),
        );
        assert_eq!(resolved, PathBuf::from("/tmp/scratch"));
    }

    #[test]
    fn the_fallbacks_are_used_in_order() {
        assert_eq!(
            resolve(None, Some("/xdg".into()), Some("/home/someone".into())),
            PathBuf::from("/xdg/dr.dsh")
        );
        assert_eq!(
            resolve(None, None, Some("/home/someone".into())),
            PathBuf::from("/home/someone/.local/share/dr.dsh")
        );
        // No home at all still starts, rather than refusing to run.
        assert_eq!(resolve(None, None, None), PathBuf::from("."));
    }
}
