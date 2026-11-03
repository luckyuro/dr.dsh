//! Live authorization state, shared by the local manager and the carrier.
//!
//! A process lock protects the daemon identity, while short registry transaction
//! locks allow the original local CLI to keep working when admin IPC is disabled.
//! No transaction lock spans a network pairing exchange.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{Context as _, Result, ensure};
use dr_dsh_crypto::{DeviceId, DevicePublicKey, DeviceRegistry};
use tokio::sync::watch;

use crate::transport::DevicePolicy;

/// One observed registry revision. A failed load always has an empty enrolled policy.
#[derive(Clone)]
pub struct Snapshot {
    /// Authorization policy for new sessions.
    pub policy: DevicePolicy,
    /// Monotonic within this daemon instance.
    pub revision: u64,
    /// A safe diagnostic code, never the malformed file's contents.
    pub problem: Option<&'static str>,
}

impl Snapshot {
    /// Whether an established identity is still authorized.
    #[must_use]
    pub fn permits(&self, device_id: Option<&str>) -> bool {
        match (&self.policy, device_id) {
            (DevicePolicy::RoomKeyOnly, None) => true,
            (DevicePolicy::Enrolled(registry), Some(id)) => {
                DeviceId::from_base64url(id).is_ok_and(|id| registry.contains(&id))
            }
            _ => false,
        }
    }

    /// Public device metadata for the local UI; no root keys or private identities.
    #[must_use]
    pub fn devices(&self) -> serde_json::Value {
        let devices: Vec<serde_json::Value> = match &self.policy {
            DevicePolicy::RoomKeyOnly => Vec::new(),
            DevicePolicy::Enrolled(registry) => registry
                .devices()
                .map(|(id, device)| serde_json::json!({"id": id.to_base64url(), "label": device.label}))
                .collect(),
        };
        serde_json::json!({
            "paired": matches!(self.policy, DevicePolicy::Enrolled(_)),
            "revision": self.revision,
            "devices": devices,
            "problem": self.problem,
        })
    }
}

/// Shared live registry. Local mutations publish immediately; legacy writers are polled.
#[derive(Clone)]
pub struct LiveRegistry {
    directory: PathBuf,
    snapshot: Arc<Mutex<Snapshot>>,
    updates: watch::Sender<Snapshot>,
}

impl LiveRegistry {
    /// Loads the initial policy, refusing a damaged registry at startup.
    ///
    /// # Errors
    /// Returns a state-directory or registry error.
    pub fn open(directory: &Path) -> Result<Self> {
        let directory = crate::state::canonical_directory(directory)?;
        let path = crate::state::registry_path_in(&directory);
        #[cfg(unix)]
        let _lock = crate::state::FileLock::acquire(&directory, "registry.lock")?;
        // Migrate existing installations before inspecting their contents. A later
        // missing file must not reopen the room-key fallback, even after a restart.
        if path.exists() {
            mark_required(&directory)?;
        }
        ensure!(
            path.exists() || !required(&directory)?,
            "the paired-device registry is missing; restore devices.json or explicitly reset the daemon's pairing state before starting"
        );
        let registry = DeviceRegistry::load(&path)
            .context("cannot load daemon device registry; repair the file before starting")?;
        let policy = if path.exists() {
            DevicePolicy::enrolled(registry)
        } else {
            DevicePolicy::RoomKeyOnly
        };
        let snapshot = Snapshot {
            policy,
            revision: 0,
            problem: None,
        };
        let (updates, _) = watch::channel(snapshot.clone());
        Ok(Self {
            directory,
            snapshot: Arc::new(Mutex::new(snapshot)),
            updates,
        })
    }

    /// The current authorization snapshot.
    #[must_use]
    pub fn snapshot(&self) -> Snapshot {
        self.snapshot
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    /// Subscribes to policy changes without changing the remote wire protocol.
    #[must_use]
    pub fn subscribe(&self) -> watch::Receiver<Snapshot> {
        self.updates.subscribe()
    }

    /// Reloads after a transaction or a legacy CLI edit.
    pub fn reload(&self) {
        let path = crate::state::registry_path_in(&self.directory);
        // Enrollment persists its fail-closed marker before the registry. Observe
        // both under the writer's short transaction lock, never its intermediate state.
        #[cfg(unix)]
        let transaction = crate::state::FileLock::acquire(&self.directory, "registry.lock");
        let mut current = self
            .snapshot
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        #[cfg(unix)]
        if transaction.is_err() {
            if current.problem == Some("registry_lock_unavailable") {
                return;
            }
            *current = Snapshot {
                policy: DevicePolicy::enrolled(DeviceRegistry::new()),
                revision: current.revision.saturating_add(1),
                problem: Some("registry_lock_unavailable"),
            };
            self.updates.send_replace(current.clone());
            return;
        }
        let marker = if path.exists() {
            mark_required(&self.directory).map(|()| true)
        } else {
            required(&self.directory)
        };
        let (policy, problem) = match DeviceRegistry::load(&path) {
            _ if marker.is_err() => (
                DevicePolicy::enrolled(DeviceRegistry::new()),
                Some("registry_marker_unreadable"),
            ),
            Ok(registry) if path.exists() => (DevicePolicy::enrolled(registry), None),
            Ok(_)
                if matches!(current.policy, DevicePolicy::RoomKeyOnly)
                    && matches!(marker, Ok(false)) =>
            {
                (DevicePolicy::RoomKeyOnly, None)
            }
            Ok(_) => (
                DevicePolicy::enrolled(DeviceRegistry::new()),
                Some("registry_missing"),
            ),
            Err(_) => (
                DevicePolicy::enrolled(DeviceRegistry::new()),
                Some("registry_unreadable"),
            ),
        };
        if policy == current.policy && problem == current.problem {
            return;
        }
        *current = Snapshot {
            policy,
            revision: current.revision.saturating_add(1),
            problem,
        };
        self.updates.send_replace(current.clone());
    }

    /// Starts bounded-latency observation of legacy CLI writes.
    #[must_use]
    pub fn monitor(&self) -> Monitor {
        let registry = self.clone();
        Monitor(tokio::spawn(async move {
            let mut timer = tokio::time::interval(std::time::Duration::from_millis(200));
            loop {
                timer.tick().await;
                registry.reload();
            }
        }))
    }

    /// Revokes a device in the latest on-disk registry and publishes the result.
    ///
    /// # Errors
    /// Returns a lock, registry or persistence error.
    pub fn revoke(&self, id: &DeviceId) -> Result<bool> {
        let revoked = revoke(&self.directory, id)?;
        self.reload();
        Ok(revoked)
    }
}

/// Lifetime guard for legacy registry observation.
pub struct Monitor(tokio::task::JoinHandle<()>);

impl Drop for Monitor {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Commits a pairing into the latest registry, never the pre-PAKE snapshot.
pub(crate) fn enrol(path: &Path, key: DevicePublicKey, label: String) -> Result<DeviceRegistry> {
    let directory = path
        .parent()
        .context("device registry has no parent directory")?;
    #[cfg(unix)]
    let _lock = crate::state::FileLock::acquire(directory, "registry.lock")?;
    ensure!(
        path.exists() || !required(directory)?,
        "the paired-device registry is missing; restore it before pairing another device"
    );
    let mut registry = DeviceRegistry::load(path)?;
    registry.enrol(key, label);
    mark_required(directory)?;
    registry.save(path)?;
    Ok(registry)
}

/// Commits a legacy CLI revocation under the same short transaction lock.
pub(crate) fn revoke(directory: &Path, id: &DeviceId) -> Result<bool> {
    #[cfg(unix)]
    let _lock = crate::state::FileLock::acquire(directory, "registry.lock")?;
    let path = crate::state::registry_path_in(directory);
    ensure!(
        path.exists() || !required(directory)?,
        "the paired-device registry is missing; restore it before revoking devices"
    );
    let mut registry = DeviceRegistry::load(&path)?;
    let revoked = registry.revoke(id);
    if revoked {
        mark_required(directory)?;
        registry.save(&path)?;
    }
    Ok(revoked)
}

fn required(directory: &Path) -> Result<bool> {
    use std::io::Read as _;
    let path = directory.join("devices-required");
    #[cfg(unix)]
    let opened = rustix::fs::open(
        &path,
        rustix::fs::OFlags::RDONLY
            | rustix::fs::OFlags::NOFOLLOW
            | rustix::fs::OFlags::CLOEXEC
            | rustix::fs::OFlags::NONBLOCK,
        rustix::fs::Mode::empty(),
    )
    .map(std::fs::File::from)
    .map_err(std::io::Error::from);
    #[cfg(not(unix))]
    let opened = std::fs::File::open(&path);
    let file = match opened {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file(),
        "device-authentication marker is not a regular file; repair the daemon state"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        ensure!(
            metadata.uid() == rustix::process::geteuid().as_raw()
                && metadata.mode() & 0o777 == 0o600
                && metadata.nlink() == 1,
            "device-authentication marker must be owned by this user with mode 0600"
        );
    }
    let mut bytes = Vec::new();
    file.take(3).read_to_end(&mut bytes)?;
    ensure!(
        bytes == b"1\n",
        "device-authentication marker is damaged; repair the daemon state without deleting its device registry"
    );
    Ok(true)
}

fn mark_required(directory: &Path) -> Result<()> {
    if required(directory)? {
        return Ok(());
    }
    use std::io::Write as _;
    let path = directory.join("devices-required");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    match options.open(&path) {
        Ok(mut file) => {
            file.write_all(b"1\n")?;
            file.sync_all()?;
            // Persist the directory entry before the registry can become authoritative.
            std::fs::File::open(directory)?.sync_all()?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            required(directory)?;
        }
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    type TestResult = Result<(), Box<dyn std::error::Error>>;

    #[test]
    fn a_missing_registry_stays_closed_after_restart() -> TestResult {
        let directory = tempfile::tempdir()?;
        let path = crate::state::registry_path_in(directory.path());
        let registry = LiveRegistry::open(directory.path())?;
        assert!(registry.snapshot().permits(None));
        let key = dr_dsh_crypto::DeviceSecretKey::generate().public();
        enrol(&path, key, "one".into())?;
        registry.reload();
        assert!(!registry.snapshot().permits(None));
        std::fs::remove_file(&path)?;
        registry.reload();
        assert_eq!(registry.snapshot().problem, Some("registry_missing"));
        assert!(LiveRegistry::open(directory.path()).is_err());
        assert!(enrol(&path, key, "replacement".into()).is_err());
        assert!(revoke(directory.path(), &key.device_id()).is_err());
        assert!(!path.exists());
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn a_reload_waits_for_the_first_enrollment_transaction() -> TestResult {
        let directory = tempfile::tempdir()?;
        let registry = LiveRegistry::open(directory.path())?;
        let transaction = crate::state::FileLock::acquire(directory.path(), "registry.lock")?;
        mark_required(directory.path())?;
        let observer = registry.clone();
        let (finished, observed) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            observer.reload();
            let _ = finished.send(observer.snapshot());
        });
        assert!(
            observed
                .recv_timeout(std::time::Duration::from_millis(50))
                .is_err()
        );
        let key = dr_dsh_crypto::DeviceSecretKey::generate().public();
        let mut committed = DeviceRegistry::new();
        committed.enrol(key, "first".into());
        committed.save(&crate::state::registry_path_in(directory.path()))?;
        drop(transaction);
        let snapshot = observed.recv_timeout(std::time::Duration::from_secs(2))?;
        assert!(snapshot.permits(Some(&key.device_id().to_base64url())));
        assert_eq!(snapshot.problem, None);
        worker
            .join()
            .map_err(|_| "registry reload worker panicked")?;
        Ok(())
    }

    #[test]
    fn existing_installations_remain_closed_when_the_registry_disappears() -> TestResult {
        let directory = tempfile::tempdir()?;
        let path = crate::state::registry_path_in(directory.path());
        DeviceRegistry::new().save(&path)?;
        let registry = LiveRegistry::open(directory.path())?;
        assert!(!registry.snapshot().permits(None));
        drop(registry);
        std::fs::remove_file(path)?;
        assert!(LiveRegistry::open(directory.path()).is_err());
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn a_device_requirement_marker_cannot_be_a_symlink() -> TestResult {
        let directory = tempfile::tempdir()?;
        let target = directory.path().join("target");
        std::fs::write(&target, "1\n")?;
        std::os::unix::fs::symlink(&target, directory.path().join("devices-required"))?;
        assert!(LiveRegistry::open(directory.path()).is_err());
        assert_eq!(std::fs::read_to_string(target)?, "1\n");
        Ok(())
    }

    #[test]
    fn a_pairing_commit_does_not_restore_a_concurrent_revocation() -> TestResult {
        let directory = tempfile::tempdir()?;
        let path = crate::state::registry_path_in(directory.path());
        let first = dr_dsh_crypto::DeviceSecretKey::generate().public();
        let second = dr_dsh_crypto::DeviceSecretKey::generate().public();
        enrol(&path, first, "first".into())?;
        let before_pairing = DeviceRegistry::load(&path)?;
        assert!(revoke(directory.path(), &first.device_id())?);
        let after = enrol(&path, second, "second".into())?;
        assert!(before_pairing.contains(&first.device_id()));
        assert!(!after.contains(&first.device_id()));
        assert!(after.contains(&second.device_id()));
        Ok(())
    }

    #[test]
    fn another_device_is_added_without_revoking_the_connected_device() -> TestResult {
        let directory = tempfile::tempdir()?;
        let path = crate::state::registry_path_in(directory.path());
        let first = dr_dsh_crypto::DeviceSecretKey::generate().public();
        let second = dr_dsh_crypto::DeviceSecretKey::generate().public();
        enrol(&path, first, "first".into())?;
        let registry = LiveRegistry::open(directory.path())?;
        let id = first.device_id().to_base64url();
        enrol(&path, second, "second".into())?;
        registry.reload();
        assert!(registry.snapshot().permits(Some(&id)));
        registry.revoke(&first.device_id())?;
        assert!(!registry.snapshot().permits(Some(&id)));
        std::fs::write(path, "invalid JSON")?;
        registry.reload();
        assert!(
            !registry
                .snapshot()
                .permits(Some(&second.device_id().to_base64url()))
        );
        Ok(())
    }
}
