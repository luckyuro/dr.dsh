//! Versioned local DSH installation; never changes the user's global npm prefix.

use crate::{Config, Paths, files, management};
use anyhow::{Context, Result, bail, ensure};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub(crate) const DSH_VERSION: &str = "0.2.2-rc.1";
const RUNTIME_PINS: [(&str, &str); 7] = [
    ("@deepseek-ai/cordis", "4.1.0"),
    ("@deepseek-ai/cordis-plugin-group", "1.1.0"),
    ("@deepseek-ai/cordis-plugin-include", "1.1.0"),
    ("@deepseek-ai/cordis-plugin-loader", "1.1.0"),
    ("@deepseek-ai/cordis-plugin-timer", "1.2.0"),
    ("@deepseek-ai/cosmokit", "1.9.0"),
    ("@deepseek-ai/schemastery", "3.19.0"),
];
// DSH's prerelease ranges also admit Cordis alpha.2, whose changed event contracts
// break settings writes and session creation in this DSH release. Keep the tested family together.
const LEGACY_RUNTIME_PINS: [(&str, &str); 7] = [
    ("@deepseek-ai/cordis", "4.0.6-alpha.1"),
    ("@deepseek-ai/cordis-plugin-group", "1.0.6-alpha.1"),
    ("@deepseek-ai/cordis-plugin-include", "1.0.11-alpha.1"),
    ("@deepseek-ai/cordis-plugin-loader", "1.0.7-alpha.1"),
    ("@deepseek-ai/cordis-plugin-timer", "1.1.8-alpha.1"),
    ("@deepseek-ai/cosmokit", "1.8.7-alpha.1"),
    ("@deepseek-ai/schemastery", "3.18.6-alpha.1"),
];

fn runtime_pins(version: &str) -> Option<&'static [(&'static str, &'static str)]> {
    match version {
        DSH_VERSION => Some(&RUNTIME_PINS),
        "0.2.2-alpha.2" => Some(&LEGACY_RUNTIME_PINS),
        _ => None,
    }
}

pub(crate) fn launcher(p: &Paths) -> PathBuf {
    p.root.join("dsh").join(DSH_VERSION).join("bin/dsh")
}

pub(crate) fn validate(config: &Config, p: &Paths) -> Result<()> {
    if config.dsh_managed == Some(true) {
        ensure!(
            config.scope == "daemon"
                && config.dsh_version.as_deref().is_some_and(|version| {
                    runtime_pins(version).is_some()
                        && config.dsh.as_ref()
                            == Some(&p.root.join("dsh").join(version).join("bin/dsh"))
                }),
            "Managed DSH version/path does not match this release; use its matching drdsh installer or select an external executable with --dsh."
        );
    } else {
        ensure!(
            config.dsh_version.is_none(),
            "An external DSH executable cannot carry a managed version; reinstall with --dsh to repair its configuration."
        );
    }
    Ok(())
}

fn drain(mut pipe: impl Read + Send + 'static) -> std::sync::mpsc::Receiver<Vec<u8>> {
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut buffer = [0; 4096];
        while let Ok(length) = pipe.read(&mut buffer) {
            if length == 0 {
                break;
            }
            let keep = length.min((64 * 1024usize).saturating_sub(bytes.len()));
            bytes.extend_from_slice(&buffer[..keep]);
        }
        let _ = send.send(bytes);
    });
    receive
}

/// The package manager's raw output may contain private registry configuration.
fn run(command: &mut Command, timeout: Duration, action: &str) -> Result<String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().with_context(|| format!("Cannot run {action}; check Node/npm and executable permissions. Existing services were not stopped."))?;
    let output = drain(
        child
            .stdout
            .take()
            .context("DSH installer output pipe is unavailable.")?,
    );
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                #[cfg(unix)]
                let _ = Command::new("/bin/kill")
                    .args(["-KILL", "--", &format!("-{}", child.id())])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
                let _ = child.kill();
                let _ = child.wait();
                bail!(
                    "{action} did not finish in time; check network access and Node/npm, then retry. Existing services were not stopped."
                );
            }
        }
    };
    ensure!(
        status.success(),
        "{action} failed; check network access to registry.npmjs.org, Node >=24.9, npm and local build prerequisites, then retry. Existing services were not stopped."
    );
    let bytes = output.recv_timeout(Duration::from_secs(2)).context(
        "DSH installer output did not close; inspect the package manager before retrying.",
    )?;
    Ok(String::from_utf8_lossy(&bytes).trim().to_owned())
}

fn supported_node(version: &str) -> bool {
    let mut parts = version.trim().trim_start_matches('v').split('.');
    match (
        parts.next().and_then(|v| v.parse::<u32>().ok()),
        parts.next().and_then(|v| v.parse::<u32>().ok()),
    ) {
        (Some(major), Some(minor)) => major > 24 || (major == 24 && minor >= 9),
        _ => false,
    }
}

fn check_version(binary: &Path, expected: &str) -> Result<()> {
    let version = run(
        Command::new(binary).arg("--version"),
        Duration::from_secs(20),
        "DSH version verification",
    )?;
    ensure!(
        version == expected,
        "The private DSH executable does not report the pinned version {expected}; remove that private version directory and retry installation."
    );
    Ok(())
}

fn check_runtime_dependencies(directory: &Path, version: &str) -> Result<()> {
    let pins = runtime_pins(version).context("This managed DSH version is not supported; use its matching drdsh installer or select an external executable with --dsh.")?;
    for &(package, expected) in pins {
        let path = directory
            .join("node_modules")
            .join(package)
            .join("package.json");
        let metadata = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
        ensure!(
            metadata
                .as_ref()
                .is_some_and(|value| value["version"] == expected),
            "Private DSH dependency {package} must be {expected} for DSH {version}. Stop the daemon, move {} aside, then reinstall to download the compatible runtime. Keep your separate DSH home and daemon state directories; they contain sessions and pairings. Existing services were not stopped.",
            directory.display()
        );
    }
    Ok(())
}

pub(crate) fn ensure_dsh(config: &mut Config, p: &Paths) -> Result<()> {
    if config.dsh_managed != Some(true) {
        return Ok(());
    }
    validate(config, p)?;
    // A daemon update must not silently replace an existing managed Harness.
    let version = config
        .dsh_version
        .as_deref()
        .context("Managed DSH version is missing; reinstall with an explicit --dsh path.")?;
    let pins = runtime_pins(version)
        .context("Managed DSH dependencies are unavailable for this version.")?;
    let binary = config
        .dsh
        .clone()
        .context("Managed DSH launcher is missing; reinstall with an explicit --dsh path.")?;
    if binary.exists() {
        check_runtime_dependencies(&p.root.join("dsh").join(version), version)?;
        return check_version(&binary, version);
    }
    let node = management::executable("node").context("Automatic DSH installation needs Node >=24.9 and npm on PATH; install Node, or select an existing DSH with --dsh.")?;
    let npm = management::executable("npm").context(
        "Automatic DSH installation needs npm on PATH; install npm with Node, then retry.",
    )?;
    let node_version = run(
        Command::new(&node).arg("--version"),
        Duration::from_secs(10),
        "Node version check",
    )?;
    ensure!(
        supported_node(&node_version),
        "Automatic DSH installation needs Node >=24.9; update Node or provide a compatible DSH launcher using --dsh."
    );
    let path = format!(
        "{}:{}",
        node.parent()
            .context("Node has no parent directory.")?
            .display(),
        config.path.as_deref().unwrap_or("/usr/bin:/bin")
    );
    config.path = Some(path.clone());
    files::mkdir(&p.root.join("dsh"))?;
    let stage = files::DirectoryGuard::stage(&p.root.join("dsh"))?;
    // Pin reviewed native install hooks for npm versions that require approvals.
    let manifest = serde_json::json!({
        "name":"drdsh-private-harness", "private":true, "type":"module",
        "dependencies":{"@deepseek-ai/dsh":version},
        "overrides":pins.iter().copied().collect::<std::collections::BTreeMap<_, _>>(),
        "allowScripts":{
            (format!("@deepseek-ai/dsh-subprocess-local@{version}")):true,
            "@google/genai@2.21.0":true, "koffi@3.1.1":true,
            "node-pty@1.2.0-beta.15":true, "protobufjs@7.6.6":true
        }
    });
    files::atomic_write(
        &stage.0.join("package.json"),
        &serde_json::to_vec_pretty(&manifest)?,
        0o600,
    )?;
    // A scoped registry in ~/.npmrc overrides npm's ordinary --registry flag.
    // Keep this installation's source and TLS policy independent of that state.
    let user_config = stage.0.join("npm-user.config");
    let global_config = stage.0.join("npm-global.config");
    files::atomic_write(&user_config, b"", 0o600)?;
    files::atomic_write(&global_config, b"", 0o600)?;
    println!("Installing private DSH {version} from registry.npmjs.org…");
    let mut npm_command = Command::new(npm);
    npm_command
        .env_clear()
        .current_dir(&stage.0)
        .env("PATH", &path);
    for key in [
        "HOME",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "TZ",
        "CI",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "https_proxy",
        "http_proxy",
        "all_proxy",
        "no_proxy",
        "NODE_EXTRA_CA_CERTS",
    ] {
        if let Some(value) = std::env::var_os(key) {
            npm_command.env(key, value);
        }
    }
    npm_command
        .arg("install")
        .arg("--userconfig")
        .arg(&user_config)
        .arg("--globalconfig")
        .arg(&global_config);
    run(
        npm_command.args([
            "--registry=https://registry.npmjs.org",
            "--@deepseek-ai:registry=https://registry.npmjs.org",
            "--strict-ssl=true",
            "--ignore-scripts=false",
            "--no-audit",
            "--no-fund",
            "--package-lock=true",
            "--fetch-retries=1",
            "--fetch-timeout=60000",
        ]),
        Duration::from_secs(240),
        "Pinned DSH package installation",
    )?;
    let metadata: serde_json::Value = serde_json::from_slice(&fs::read(
        stage.0.join("node_modules/@deepseek-ai/dsh/package.json"),
    )?)?;
    ensure!(
        metadata["name"] == "@deepseek-ai/dsh" && metadata["version"] == version,
        "npm returned an unexpected DSH package; discard the staging directory and retry with the official registry."
    );
    check_runtime_dependencies(&stage.0, version)?;
    let downloaded_version = run(
        Command::new(&node)
            .arg(stage.0.join("node_modules/@deepseek-ai/dsh/lib/bin.js"))
            .arg("--version"),
        Duration::from_secs(20),
        "Downloaded DSH startup check",
    )?;
    ensure!(
        downloaded_version == version,
        "Downloaded DSH did not report the pinned version {version}; retry installation from the official registry. Existing services were not stopped."
    );
    let destination = binary
        .parent()
        .and_then(Path::parent)
        .context("Private DSH path has no version directory.")?;
    ensure!(
        !destination.exists(),
        "An incomplete private DSH directory already exists; inspect it before retrying installation."
    );
    let script = format!(
        "#!/bin/sh\nexec {} {} \"$@\"\n",
        files::shell_quote(&node.to_string_lossy()),
        files::shell_quote(
            &destination
                .join("node_modules/@deepseek-ai/dsh/lib/bin.js")
                .to_string_lossy()
        )
    );
    files::atomic_write(&stage.0.join("bin/dsh"), script.as_bytes(), 0o700)?;
    fs::rename(&stage.0, destination).context(
        "Cannot activate the private DSH version; check prefix permissions and disk space.",
    )?;
    check_version(&binary, version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn existing_managed_runtime_keeps_its_version_but_cannot_escape_its_private_path() -> Result<()>
    {
        let p = Paths::new(Path::new("/tmp/drdsh-version-test"), "daemon")?;
        for version in ["0.2.2-alpha.2", DSH_VERSION] {
            let mut config: Config = serde_json::from_value(serde_json::json!({
                "version": 1, "prefix": p.prefix, "scope": "daemon", "source": "/tmp/source",
                "components": ["daemon"], "dshManaged": true, "dshVersion": version,
                "dsh": p.root.join("dsh").join(version).join("bin/dsh"),
            }))?;
            validate(&config, &p)?;
            config.dsh = Some(p.root.join("dsh/foreign/bin/dsh"));
            assert!(validate(&config, &p).is_err());
            config.dsh_version = Some("unreviewed-version".into());
            config.dsh = Some(p.root.join("dsh/unreviewed-version/bin/dsh"));
            assert!(validate(&config, &p).is_err());
        }
        Ok(())
    }

    #[test]
    fn node_floor_matches_the_verified_dsh_engine() {
        assert!(!supported_node("v24.8.9"));
        assert!(!supported_node("v22.22.0"));
        assert!(supported_node("v24.9.0"));
        assert!(supported_node("v26.13.0"));
        assert!(!supported_node("unavailable"));
    }
}
