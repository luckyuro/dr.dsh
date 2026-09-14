//! The daemon's device registry: who is allowed to open a tunnel.
//!
//! This is the enforcement point for M1's first acceptance criterion — *an unpaired device
//! cannot establish a tunnel*. Everything else in the pairing flow is about enrolling;
//! this module is about refusing.
//!
//! ## Why the registry is the whole authorization model
//!
//! A daemon with an empty registry serves nobody. There is no "first device wins", no
//! bootstrap window, and no local-socket exception: a daemon that has never been paired is
//! reachable by nobody, which is the honest state rather than a special case. The room key
//! is still honoured as an explicit, documented fallback while pairing lands (see
//! `docs/product/mvp.md` § 六), and that fallback is off by default.
//!
//! ## Storage is a plain file, deliberately
//!
//! The registry holds **public keys and labels only** — no secrets, nothing that a backup
//! or a file sync has to be trusted with. That is the reason enrolment stores a public key
//! rather than a shared secret per device: a stolen registry is an inconvenience, not an
//! impersonation kit. A file is therefore an adequate store, and a database here would be
//! complexity without a security return.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::DEVICE_PUBLIC_KEY_LEN;
use crate::device::{DeviceId, DevicePublicKey};

/// Why the registry could not be read or written.
#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
    /// The registry file could not be read.
    #[error("cannot read the device registry at {path}: {source}")]
    Read {
        /// Where it was read from.
        path: PathBuf,
        /// The underlying failure.
        source: std::io::Error,
    },
    /// The registry file could not be written.
    #[error("cannot write the device registry at {path}: {source}")]
    Write {
        /// Where it was written to.
        path: PathBuf,
        /// The underlying failure.
        source: std::io::Error,
    },
    /// The registry file was not the shape this version writes.
    #[error("the device registry at {path} is not usable: {reason}")]
    Malformed {
        /// Where it was read from.
        path: PathBuf,
        /// What was wrong, in a form an operator can act on.
        reason: String,
    },
}

/// One enrolled device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnrolledDevice {
    /// The device's public identity key.
    pub public_key: DevicePublicKey,
    /// The label the device supplied at enrolment, for a human to recognise in a list.
    ///
    /// Free text and therefore untrusted: it is never used for a decision, only displayed.
    pub label: String,
}

/// The set of devices allowed to connect.
///
/// Ordering is by device id so that two runs writing the same set produce the same file —
/// a registry that reshuffles itself on every write makes a diff of two machines useless.
#[derive(Debug, Default)]
pub struct DeviceRegistry {
    devices: BTreeMap<DeviceId, EnrolledDevice>,
}

impl DeviceRegistry {
    /// An empty registry, which authorizes nobody.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Enrols a device, replacing any existing entry for the same key.
    ///
    /// Replacing rather than refusing is what makes re-pairing the same device idempotent:
    /// a user who pairs their phone twice should end up with one phone, not an error.
    pub fn enrol(&mut self, public_key: DevicePublicKey, label: String) {
        self.devices
            .insert(public_key.device_id(), EnrolledDevice { public_key, label });
    }

    /// Whether a device id is enrolled.
    #[must_use]
    pub fn contains(&self, device_id: &DeviceId) -> bool {
        self.devices.contains_key(device_id)
    }

    /// The enrolled device for an id, if any.
    #[must_use]
    pub fn get(&self, device_id: &DeviceId) -> Option<&EnrolledDevice> {
        self.devices.get(device_id)
    }

    /// Returns the key a device must prove possession of, or `None` when it is not enrolled.
    ///
    /// This is the single call a handshake makes, and its `None` is the refusal: a device
    /// that is not in here has no key to challenge, so there is no challenge–response to
    /// run and the connection ends. Returning `Option` rather than a bool is deliberate —
    /// a bool invites a caller to write `if !enrolled { /* fall through */ }`, and there is
    /// no safe default to fall through to.
    #[must_use]
    pub fn challenge_key(&self, device_id: &DeviceId) -> Option<DevicePublicKey> {
        self.devices.get(device_id).map(|device| device.public_key)
    }

    /// Revokes a device.
    ///
    /// # Returns
    ///
    /// `true` when a device was removed, `false` when the id was not enrolled. The
    /// distinction matters for the audit log: an operator revoking a device that is not
    /// there is usually a mistake, and silently reporting success hides it.
    pub fn revoke(&mut self, device_id: &DeviceId) -> bool {
        self.devices.remove(device_id).is_some()
    }

    /// Every enrolled device, ordered by id.
    pub fn devices(&self) -> impl Iterator<Item = (&DeviceId, &EnrolledDevice)> {
        self.devices.iter()
    }

    /// How many devices are enrolled.
    #[must_use]
    pub fn len(&self) -> usize {
        self.devices.len()
    }

    /// Whether no device is enrolled, which means the daemon serves nobody.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.devices.is_empty()
    }

    /// Reads a registry from a JSON file.
    ///
    /// A **missing** file is an empty registry rather than an error: a daemon that has never
    /// been paired is a normal state, and making it an error would tempt callers to treat a
    /// failed load as "no restriction". A malformed file *is* an error, because the safe
    /// response to a registry that cannot be understood is to serve nobody and say so.
    ///
    /// # Errors
    ///
    /// Returns [`RegistryError`] when the file exists but cannot be read or understood.
    pub fn load(path: &Path) -> Result<Self, RegistryError> {
        let contents = match std::fs::read_to_string(path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Self::new()),
            Err(source) => {
                return Err(RegistryError::Read {
                    path: path.to_path_buf(),
                    source,
                });
            }
        };
        let parsed: StoredRegistry =
            serde_json::from_str(&contents).map_err(|error| RegistryError::Malformed {
                path: path.to_path_buf(),
                reason: error.to_string(),
            })?;

        let mut registry = Self::new();
        for device in parsed.devices {
            // A key that does not parse fails the whole load rather than being skipped: a
            // silently dropped device is a device that stops working with no explanation,
            // and a silently dropped *entry* could hide a corrupted revoke.
            let key = DevicePublicKey::from_bytes(&device.public_key).map_err(|error| {
                RegistryError::Malformed {
                    path: path.to_path_buf(),
                    reason: format!("device {}: {error}", device.id),
                }
            })?;
            registry.enrol(key, device.label);
        }
        Ok(registry)
    }

    /// Writes the registry to a JSON file.
    ///
    /// Written through a temporary file and renamed, so a crash mid-write leaves the previous
    /// registry intact. Truncating in place would turn a failed save into a daemon that
    /// serves nobody — recoverable, but for no reason.
    ///
    /// # Errors
    ///
    /// Returns [`RegistryError::Write`] when the file cannot be written.
    pub fn save(&self, path: &Path) -> Result<(), RegistryError> {
        let stored = StoredRegistry {
            version: REGISTRY_VERSION,
            devices: self
                .devices
                .values()
                .map(|device| StoredDevice {
                    id: device.public_key.device_id().to_base64url(),
                    public_key: device.public_key.to_bytes(),
                    label: device.label.clone(),
                })
                .collect(),
        };
        let encoded =
            serde_json::to_string_pretty(&stored).map_err(|error| RegistryError::Malformed {
                path: path.to_path_buf(),
                reason: error.to_string(),
            })?;

        let temporary = path.with_extension("json.tmp");
        std::fs::write(&temporary, encoded).map_err(|source| RegistryError::Write {
            path: temporary.clone(),
            source,
        })?;
        std::fs::rename(&temporary, path).map_err(|source| RegistryError::Write {
            path: path.to_path_buf(),
            source,
        })
    }
}

/// The on-disk format version.
const REGISTRY_VERSION: u32 = 1;

#[derive(serde::Serialize, serde::Deserialize)]
struct StoredRegistry {
    version: u32,
    devices: Vec<StoredDevice>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct StoredDevice {
    /// The derived id, stored as well as the key so a human reading the file can match it
    /// against a log line without computing a hash.
    id: String,
    public_key: [u8; DEVICE_PUBLIC_KEY_LEN],
    label: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device::DeviceSecretKey;

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    #[test]
    fn an_empty_registry_authorizes_nobody() {
        // The property M1 turns on: a daemon that has never been paired has no challenge to
        // issue, so there is no handshake to complete.
        let registry = DeviceRegistry::new();
        assert!(registry.is_empty());
        assert!(
            registry
                .challenge_key(&DeviceId::for_key(&[1_u8; 32]))
                .is_none()
        );
    }

    #[test]
    fn an_enrolled_device_is_authorized_and_others_are_not() {
        let mut registry = DeviceRegistry::new();
        let enrolled = DeviceSecretKey::generate();
        let stranger = DeviceSecretKey::generate();
        registry.enrol(enrolled.public(), "the enrolled phone".to_owned());

        assert!(registry.contains(&enrolled.public().device_id()));
        assert_eq!(
            registry.challenge_key(&enrolled.public().device_id()),
            Some(enrolled.public())
        );
        assert!(
            registry
                .challenge_key(&stranger.public().device_id())
                .is_none()
        );
    }

    #[test]
    fn re_enrolling_replaces_rather_than_duplicates() {
        let mut registry = DeviceRegistry::new();
        let device = DeviceSecretKey::generate();
        registry.enrol(device.public(), "first name".to_owned());
        registry.enrol(device.public(), "renamed".to_owned());

        assert_eq!(registry.len(), 1, "one key is one device");
        assert_eq!(
            registry
                .get(&device.public().device_id())
                .map(|d| d.label.as_str()),
            Some("renamed")
        );
    }

    #[test]
    fn revoking_reports_whether_there_was_something_to_revoke() {
        let mut registry = DeviceRegistry::new();
        let device = DeviceSecretKey::generate();
        let stranger = DeviceSecretKey::generate();
        registry.enrol(device.public(), "phone".to_owned());

        assert!(registry.revoke(&device.public().device_id()));
        assert!(!registry.contains(&device.public().device_id()));
        assert!(
            !registry.revoke(&stranger.public().device_id()),
            "revoking an unknown device must not report success"
        );
    }

    #[test]
    fn a_registry_round_trips_through_a_file() -> TestResult {
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("devices.json");
        let first = DeviceSecretKey::generate();
        let second = DeviceSecretKey::generate();

        let mut registry = DeviceRegistry::new();
        registry.enrol(first.public(), "laptop".to_owned());
        registry.enrol(second.public(), "phone".to_owned());
        registry.save(&path)?;

        let loaded = DeviceRegistry::load(&path)?;
        assert_eq!(loaded.len(), 2);
        assert!(loaded.contains(&first.public().device_id()));
        assert!(loaded.contains(&second.public().device_id()));
        assert_eq!(
            loaded
                .get(&first.public().device_id())
                .map(|d| d.label.as_str()),
            Some("laptop")
        );
        Ok(())
    }

    #[test]
    fn an_empty_registry_refuses_everyone_which_is_what_revoking_the_last_device_means()
    -> TestResult {
        // The daemon decides between "room key only" and "every client must prove itself" from
        // whether the registry *file* exists, not from how many devices it holds. Counting
        // devices turned revoking the last one into a grant: the daemon fell back to the room
        // key, and `drdshd devices --revoke <last>` re-opened the door the user was closing while
        // telling them the device could no longer connect. This pins the property the daemon
        // relies on, so a future "optimisation" that folds the two states together fails here.
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("devices.json");
        let device = DeviceSecretKey::generate();

        let mut registry = DeviceRegistry::new();
        registry.enrol(device.public(), "phone".to_owned());
        registry.save(&path)?;
        assert!(
            path.exists(),
            "saving creates the file, which is the state marker"
        );

        let mut loaded = DeviceRegistry::load(&path)?;
        assert!(loaded.revoke(&device.public().device_id()));
        loaded.save(&path)?;

        assert!(
            path.exists(),
            "revoking the last device must leave the marker behind"
        );
        let after = DeviceRegistry::load(&path)?;
        assert!(after.is_empty());
        assert!(
            after.challenge_key(&device.public().device_id()).is_none(),
            "a revoked device must not be challengeable"
        );
        assert!(
            after
                .challenge_key(&DeviceSecretKey::generate().public().device_id())
                .is_none(),
            "and neither must anybody else: an empty registry authorizes nobody"
        );
        Ok(())
    }

    #[test]
    fn a_missing_file_is_an_empty_registry() -> TestResult {
        // A daemon that has never been paired is normal, not an error: making it an error
        // is what tempts a caller into treating "could not load" as "no restriction".
        let directory = tempfile::tempdir()?;
        let registry = DeviceRegistry::load(&directory.path().join("absent.json"))?;
        assert!(registry.is_empty());
        Ok(())
    }

    #[test]
    fn a_malformed_file_is_an_error_rather_than_an_empty_registry() -> TestResult {
        // The dangerous alternative: a registry that cannot be understood degrades to
        // "serve everyone". Failing closed is the only acceptable reading.
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("devices.json");
        std::fs::write(&path, "{ not json")?;
        assert!(matches!(
            DeviceRegistry::load(&path),
            Err(RegistryError::Malformed { .. })
        ));
        Ok(())
    }

    #[test]
    fn a_registry_naming_an_invalid_key_fails_closed() -> TestResult {
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("devices.json");
        // A well-formed document whose key is not a usable point.
        std::fs::write(
            &path,
            r#"{"version":1,"devices":[{"id":"x","public_key":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32],"label":"bad"}]}"#,
        )?;
        assert!(
            matches!(
                DeviceRegistry::load(&path),
                Err(RegistryError::Malformed { .. })
            ),
            "an unparseable key must not be skipped silently"
        );
        Ok(())
    }

    #[test]
    fn the_saved_file_never_contains_a_secret() -> TestResult {
        // The registry is the file a user backs up or syncs. It holds public keys and
        // labels, and the test exists so that adding a "convenience" field later fails here
        // rather than in a security review nobody runs.
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("devices.json");
        let device = DeviceSecretKey::generate();
        let mut registry = DeviceRegistry::new();
        registry.enrol(device.public(), "phone".to_owned());
        registry.save(&path)?;

        let written = std::fs::read_to_string(&path)?;
        assert!(!written.contains("secret"), "got {written}");
        assert!(!written.contains("private"), "got {written}");
        // The device's private seed must not appear anywhere in it.
        let seed = device.to_bytes();
        assert!(
            !written.contains(&hex(&seed)),
            "the registry must never carry private key material"
        );
        assert!(!written.contains(&String::from_utf8_lossy(&seed).to_string()));
        Ok(())
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
}
