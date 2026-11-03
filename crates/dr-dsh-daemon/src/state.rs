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
    std::fs::canonicalize(directory)
}

/// Canonicalizes a state directory without changing an existing parent's permissions.
///
/// # Errors
/// Returns an error when the directory cannot be created or resolved.
pub fn canonical_directory(directory: &Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(directory)?;
    std::fs::canonicalize(directory)
}

/// Creates or validates a daemon-owned private runtime directory.
///
/// Existing broad directories are never chmodded: a mistaken state setting must
/// not change permissions on a workspace, home directory, or `/tmp`.
#[cfg(unix)]
pub(crate) fn private_directory(directory: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt as _, MetadataExt as _};
    match std::fs::DirBuilder::new().mode(0o700).create(directory) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let metadata = std::fs::symlink_metadata(directory)?;
    if !metadata.is_dir()
        || metadata.uid() != rustix::process::geteuid().as_raw()
        || metadata.mode() & 0o777 != 0o700
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "daemon runtime directory must be a real directory owned by this user with mode 0700; inspect its ownership and permissions",
        ));
    }
    Ok(())
}

/// An OS lock, released even if the process crashes. Its inode is never unlinked.
#[cfg(unix)]
pub(crate) struct FileLock {
    _file: std::os::fd::OwnedFd,
}

#[cfg(unix)]
impl FileLock {
    pub(crate) fn try_acquire(directory: &Path, name: &str) -> std::io::Result<Option<Self>> {
        use rustix::fs::{FlockOperation, Mode, OFlags, flock, openat};
        let directory = canonical_directory(directory)?;
        let private = directory.join(".runtime");
        private_directory(&private)?;
        let parent = rustix::fs::open(
            &private,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )?;
        let file = openat(
            &parent,
            name,
            OFlags::RDWR | OFlags::CREATE | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::RUSR | Mode::WUSR,
        )?;
        let stat = rustix::fs::fstat(&file)?;
        if stat.st_uid != rustix::process::geteuid().as_raw()
            || stat.st_mode & 0o777 != 0o600
            || rustix::fs::FileType::from_raw_mode(stat.st_mode)
                != rustix::fs::FileType::RegularFile
            || stat.st_nlink != 1
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "daemon lock must be an owned, private regular file with one link; inspect the runtime directory",
            ));
        }
        match flock(&file, FlockOperation::NonBlockingLockExclusive) {
            Ok(()) => Ok(Some(Self { _file: file })),
            Err(rustix::io::Errno::WOULDBLOCK) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub(crate) fn acquire(directory: &Path, name: &str) -> std::io::Result<Self> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            if let Some(lock) = Self::try_acquire(directory, name)? {
                return Ok(lock);
            }
            if std::time::Instant::now() >= deadline {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WouldBlock,
                    "another local registry operation is still running; retry shortly",
                ));
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
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

    #[cfg(unix)]
    #[test]
    fn the_runtime_lock_is_exclusive_and_releases_on_drop() -> Result<(), Box<dyn std::error::Error>>
    {
        let directory = tempfile::tempdir()?;
        let first = FileLock::try_acquire(directory.path(), "runtime.lock")?;
        assert!(first.is_some());
        assert!(FileLock::try_acquire(directory.path(), "runtime.lock")?.is_none());
        drop(first);
        assert!(FileLock::try_acquire(directory.path(), "runtime.lock")?.is_some());
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn runtime_symlinks_are_rejected_without_changing_their_target()
    -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempfile::tempdir()?;
        let target = tempfile::tempdir()?;
        std::os::unix::fs::symlink(target.path(), directory.path().join(".runtime"))?;
        assert!(FileLock::try_acquire(directory.path(), "runtime.lock").is_err());
        assert!(!target.path().join("runtime.lock").exists());
        Ok(())
    }

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
