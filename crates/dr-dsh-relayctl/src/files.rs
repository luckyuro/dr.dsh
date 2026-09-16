//! Bounded filesystem operations owned by the relay installation.

use anyhow::{Context, Result, ensure};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

pub(crate) fn mkdir(path: &Path) -> Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path).with_context(|| {
        format!(
            "Cannot create relay directory {}; check its ownership and permissions.",
            path.display()
        )
    })
}

pub(crate) fn atomic_write(path: &Path, contents: &[u8], mode: u32) -> Result<()> {
    mkdir(
        path.parent()
            .context("Relay destination has no parent; choose an absolute prefix.")?,
    )?;
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    let mut file = options.open(&temporary).with_context(|| {
        format!(
            "Cannot stage relay file {}; check permissions and stale temporary files.",
            path.display()
        )
    })?;
    let result = (|| {
        file.write_all(contents)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    let _ = fs::remove_file(temporary);
    result
}

pub(crate) fn copy(source: &Path, destination: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(source).with_context(|| {
        format!(
            "Missing relay artifact {}; build or unpack a complete bundle first.",
            source.display()
        )
    })?;
    ensure!(
        !metadata.is_symlink(),
        "Relay artifact {} is a symlink; provide regular files in the bundle.",
        source.display()
    );
    if metadata.is_dir() {
        mkdir(destination)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy(&entry.path(), &destination.join(entry.file_name()))?;
        }
    } else {
        ensure!(
            metadata.is_file(),
            "Relay artifact {} is not a regular file; rebuild the bundle.",
            source.display()
        );
        mkdir(
            destination
                .parent()
                .context("Relay artifact destination has no parent.")?,
        )?;
        fs::copy(source, destination).with_context(|| {
            format!(
                "Cannot copy relay artifact {}; check disk space and permissions.",
                source.display()
            )
        })?;
    }
    Ok(())
}

pub(crate) fn remove(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => fs::remove_dir_all(path)?,
        Ok(_) => fs::remove_file(path)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(e).with_context(|| {
                format!(
                    "Cannot remove relay-owned path {}; check its permissions.",
                    path.display()
                )
            });
        }
    }
    Ok(())
}

pub(crate) fn promote(source: &Path, destination: &Path) -> Result<()> {
    mkdir(
        destination
            .parent()
            .context("Relay installation destination has no parent.")?,
    )?;
    let backup = destination.with_extension(format!("{}.backup", std::process::id()));
    ensure!(
        !backup.exists(),
        "Stale relay backup {}; inspect it before retrying installation.",
        backup.display()
    );
    let existed = fs::symlink_metadata(destination).is_ok();
    if existed {
        fs::rename(destination, &backup)?;
    }
    if let Err(error) = fs::rename(source, destination) {
        if existed {
            fs::rename(&backup, destination).context("Cannot restore a relay file after failed replacement; inspect the .backup file and reinstall.")?;
        }
        return Err(error)
            .context("Cannot replace relay files; check disk permissions and retry installation.");
    }
    if existed {
        remove(&backup)?;
    }
    Ok(())
}

pub(crate) struct DirectoryGuard(pub(crate) PathBuf);

impl DirectoryGuard {
    pub(crate) fn lock(root: &Path) -> Result<Self> {
        mkdir(root)?;
        let lock = root.join(".operation-lock");
        fs::create_dir(&lock).with_context(|| format!("Cannot acquire relay operation lock {}. Wait for the other relay command; after a crash, verify it has exited and remove this empty directory.", lock.display()))?;
        Ok(Self(lock))
    }

    pub(crate) fn stage(root: &Path) -> Result<Self> {
        let path = root.join(format!(".stage-{}", std::process::id()));
        fs::create_dir(&path).context("Cannot create relay staging directory; check disk permissions and stale .stage directories.")?;
        Ok(Self(path))
    }
}

impl Drop for DirectoryGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(crate) fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
