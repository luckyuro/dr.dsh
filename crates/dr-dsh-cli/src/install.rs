//! Stage complete component artifacts before stopping an existing service.

use crate::{Args, Config, Paths, files, management, service};
use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use std::fs;
use std::path::Path;
use std::process::Command;

#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Bundle {
    pub(crate) format: u8,
    pub(crate) version: String,
    pub(crate) target: String,
    pub(crate) components: Vec<String>,
}

fn regular(path: &Path) -> Result<()> {
    ensure!(
        fs::symlink_metadata(path).is_ok_and(|m| m.is_file() && m.len() > 0),
        "Missing or invalid artifact {}; build or extract a complete package before retrying. Existing services were not stopped.",
        path.display()
    );
    Ok(())
}

fn link(target: &Path, dest: &Path) -> Result<()> {
    files::mkdir(dest.parent().context("Command path has no parent.")?)?;
    let temporary = dest.with_extension(format!("{}.link", std::process::id()));
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, &temporary)
        .context("Cannot stage command link; inspect its directory and stale .link files.")?;
    let result = fs::rename(&temporary, dest);
    let _ = fs::remove_file(temporary);
    result.context("Cannot install command link; check prefix permissions.")
}

fn managed_command(p: &Paths) -> Result<()> {
    let command = p.prefix.join("bin/drdsh");
    if fs::symlink_metadata(&command).is_ok() {
        let target = fs::read_link(&command).context("The existing drdsh command is not a managed component link. Keep the legacy installation with another --prefix, or move that command explicitly before migrating.")?;
        ensure!(
            ["relay", "daemon"]
                .iter()
                .any(|s| target == p.prefix.join(format!("lib/dr.dsh/{s}/bin/drdsh"))),
            "Refusing to overwrite an unrelated drdsh link; choose another --prefix."
        );
    }
    Ok(())
}

fn plugin(config: &Config, p: &Paths, verb: &str) -> Result<()> {
    ensure!(
        config.owns_plugin(),
        "The DSH bundle is externally owned; manage it through DSH instead of daemon installation."
    );
    let mut command = Command::new(
        config
            .dsh
            .as_ref()
            .context("DSH executable is missing; reinstall daemon with --dsh.")?,
    );
    command.args(["plugin", "--profile", "web", verb]);
    if verb == "add" {
        command.arg(p.root.join("plugin"));
    } else {
        command.arg("@dr.dsh/dsh-plugin");
    }
    config.configure(&mut command, p);
    ensure!(
        command
            .status()
            .context("Cannot run DSH plugin management; check DSH and Node.")?
            .success(),
        "DSH plugin {verb} failed; inspect the output and retry. Daemon configuration and keys are retained."
    );
    Ok(())
}

pub(crate) fn install(scope: &str, args: &Args, p: &Paths) -> Result<()> {
    let (_, previous, mut config) = management::make_config(scope, args)?;
    let source = &config.source;
    let bundle = if source.join("bundle.json").is_file() {
        let bundle: Bundle = serde_json::from_slice(&fs::read(source.join("bundle.json"))?)
            .context("Invalid bundle.json; extract a complete release package.")?;
        ensure!(
            bundle.format == 1 && bundle.components.iter().any(|s| s == scope),
            "This package does not contain {scope}; download its standalone or mixed package."
        );
        let host = format!(
            "{}-{}",
            std::env::consts::ARCH,
            if cfg!(target_os = "macos") {
                "apple-darwin"
            } else {
                "unknown-linux-musl"
            }
        );
        ensure!(
            bundle.target == host && bundle.version == env!("CARGO_PKG_VERSION"),
            "Package target/version ({}/{}) does not match this installer ({}/{}); run the installer inside the selected package.",
            bundle.target,
            bundle.version,
            host,
            env!("CARGO_PKG_VERSION")
        );
        Some(bundle)
    } else {
        None
    };
    let asset_only = args.asset.is_some();
    ensure!(
        !asset_only || previous.as_ref().is_some_and(Config::installed),
        "Asset-only installation needs an installed {scope}; install the component first."
    );
    managed_command(p)?;
    if previous.is_none() {
        for path in [
            &p.command,
            &p.bin.join("drdsh"),
            &p.prefix.join(format!("bin/drdsh-{scope}ctl")),
        ] {
            ensure!(
                fs::symlink_metadata(path).is_err(),
                "Refusing to overwrite unmanaged command {}; use another --prefix.",
                path.display()
            );
        }
    }
    let profile = config.build_profile.as_deref().unwrap_or("release");
    let binary = if bundle.is_some() {
        source.join("bin/drdsh")
    } else {
        source.join("target").join(profile).join("drdsh")
    };
    if bundle.is_none() && !asset_only && !args.flag("skip-build") {
        regular(&source.join("Cargo.toml"))?;
        let mut cargo = Command::new("cargo");
        cargo
            .current_dir(source)
            .args(["build", "--locked", "--manifest-path"])
            .arg(source.join("Cargo.toml"))
            .arg("--target-dir")
            .arg(source.join("target"))
            .args([
                "-p",
                "dr-dsh-cli",
                "--no-default-features",
                "--features",
                &crate::compiled_components().join(","),
            ]);
        if profile == "release" {
            cargo.arg("--release");
        }
        ensure!(cargo.status().context("Cannot run Cargo; install a prebuilt Release package or install Rust for source builds.")?.success(), "Source build failed; repair it before retrying. Existing services were not stopped.");
    }
    if !asset_only {
        regular(&binary)?;
        management::executable(&binary.to_string_lossy())?;
    }
    let client = if bundle.is_some() {
        source.join("client")
    } else {
        config
            .client_dir
            .clone()
            .unwrap_or(source.join("apps/pwa/dist"))
    };
    if scope == "relay" {
        for name in [
            "index.html",
            "shell.js",
            "session.js",
            "service-worker.js",
            "manifest.webmanifest",
            "icon-192.png",
            "icon-512.png",
        ] {
            regular(&client.join(name))?;
        }
    }
    let with_plugin = scope == "daemon"
        && config.owns_plugin()
        && (!previous.as_ref().is_some_and(Config::installed)
            || args.flag("with-plugin")
            || args.asset.as_deref() == Some("plugin")
            || previous
                .as_ref()
                .is_some_and(|c| c.components.iter().any(|s| s == "plugin")));
    let plugin_source = source.join(if bundle.is_some() {
        "plugin"
    } else {
        "plugins/dr.dsh"
    });
    if with_plugin {
        for name in [
            "package.json",
            "cordis.patch.yml",
            "web/manage.html",
            "web/manage.js",
        ] {
            regular(&plugin_source.join(name))?;
        }
        regular(&plugin_source.join(if bundle.is_some() {
            "src/index.js"
        } else {
            "src/index.ts"
        }))?;
    }
    if args.flag("start") || args.flag("enable") || previous.as_ref().is_some_and(Config::installed)
    {
        service::available()?;
    }
    let stage = files::DirectoryGuard::stage(&p.root)?;
    if !asset_only {
        files::copy(&binary, &stage.0.join("drdsh"))?;
    }
    if scope == "relay" {
        files::copy(&client, &stage.0.join("client"))?;
    }
    if with_plugin {
        if bundle.is_some() {
            for name in ["package.json", "cordis.patch.yml", "src", "web"] {
                files::copy(
                    &plugin_source.join(name),
                    &stage.0.join("plugin").join(name),
                )?;
            }
        } else {
            // Node intentionally refuses type stripping inside node_modules.
            // Source installs use exactly the same ESM packager as releases.
            ensure!(Command::new("node")
                .arg(source.join("scripts/package-plugin-source.mjs"))
                .arg(stage.0.join("plugin"))
                .status().context("Cannot stage the plugin; install Node and repository pnpm dependencies, or use a Release package.")?.success(),
                "Plugin ESM staging failed; run pnpm install and TypeScript checks before retrying. Existing services were not stopped.");
        }
        let target = format!(
            "{}-{}",
            std::env::consts::ARCH,
            if cfg!(target_os = "macos") {
                "apple-darwin"
            } else {
                "unknown-linux-musl"
            }
        );
        let native = stage.0.join("plugin/native").join(&target);
        // The installed plugin always carries this installer, never an older
        // Release payload that might not implement the current management API.
        files::copy(&binary, &native.join("bin/drdsh"))?;
        files::atomic_write(
            &native.join("bundle.json"),
            &serde_json::to_vec(&Bundle {
                format: 1,
                version: env!("CARGO_PKG_VERSION").into(),
                target,
                components: vec!["daemon".into()],
            })?,
            0o600,
        )?;
        let manifest = stage.0.join("plugin/package.json");
        let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&manifest)?)?;
        if let Some(object) = value.as_object_mut() {
            object.remove("devDependencies");
            object.remove("scripts");
        }
        files::atomic_write(&manifest, &serde_json::to_vec_pretty(&value)?, 0o600)?;
    }
    if scope == "daemon" {
        crate::provision::ensure_dsh(&mut config, p)?;
    }
    let was_running =
        previous.as_ref().is_some_and(Config::installed) && service::state(p)?.running;
    if was_running {
        service::stop(
            previous
                .as_ref()
                .context("Lost previous component configuration.")?,
            p,
        )?;
    }
    let update = (|| -> Result<()> {
        if !asset_only {
            files::promote(&stage.0.join("drdsh"), &p.bin.join("drdsh"))?;
        }
        if scope == "relay" {
            files::promote(&stage.0.join("client"), &p.root.join("client"))?;
        }
        if with_plugin {
            files::promote(&stage.0.join("plugin"), &p.root.join("plugin"))?;
        }
        files::atomic_write(
            &p.root.join("prefix.json"),
            &serde_json::to_vec(&serde_json::json!({"prefix": p.prefix, "scope": scope}))?,
            0o600,
        )?;
        files::atomic_write(
            &p.root.join("release-install.sh"),
            include_bytes!("../../../scripts/release-install.sh"),
            0o700,
        )?;
        let installed_bundle = Bundle {
            format: 1,
            version: env!("CARGO_PKG_VERSION").into(),
            target: format!(
                "{}-{}",
                std::env::consts::ARCH,
                if cfg!(target_os = "macos") {
                    "apple-darwin"
                } else {
                    "unknown-linux-musl"
                }
            ),
            components: vec![scope.into()],
        };
        files::atomic_write(
            &p.root.join("bundle.json"),
            &serde_json::to_vec(&installed_bundle)?,
            0o600,
        )?;
        link(&p.bin.join("drdsh"), &p.command)?;
        link(
            &p.bin.join("drdsh"),
            &p.prefix.join(format!("bin/drdsh-{scope}ctl")),
        )?;
        // Keep the shared command's current owner while it exists. A second installation
        // becomes reachable through native dispatch without replacing the first copy.
        if !p.prefix.join("bin/drdsh").is_file() {
            link(&p.bin.join("drdsh"), &p.prefix.join("bin/drdsh"))?;
        }
        config.components = vec![scope.into()];
        if scope == "relay" {
            config.components.push("client".into());
        }
        if config.owns_plugin()
            && previous
                .as_ref()
                .is_some_and(|c| c.components.iter().any(|s| s == "plugin"))
        {
            config.components.push("plugin".into());
        }
        config.save(p)?;
        if with_plugin {
            plugin(&config, p, "add")?;
            if !config.components.iter().any(|s| s == "plugin") {
                config.components.push("plugin".into());
            }
            config.save(p)?;
        }
        service::prepare(&config, p)?;
        for name in ["drdsh.mjs", "service-manager.mjs", "component-cli.mjs"] {
            files::remove(&p.root.join(name))?;
        }
        // Old raw programs and management wrappers are no longer service entrypoints.
        for name in if scope == "relay" {
            ["drdsh-relay", "drdsh-relayctl"]
        } else {
            ["drdshd", "drdsh-daemonctl"]
        } {
            files::remove(&p.bin.join(name))?;
        }
        Ok(())
    })();
    let restart = if was_running {
        service::start(
            &Config::read(p).unwrap_or_else(|_| previous.clone().unwrap_or(config.clone())),
            p,
        )
    } else {
        Ok(())
    };
    update?;
    restart?;
    if args.flag("enable") {
        service::autostart(&config, p, true)?;
    }
    if args.flag("start") && !was_running {
        service::start(&config, p)?;
    }
    println!(
        "Installed {scope}. Command: {}\nConfig: {}\nShell PATH: export PATH={}:\"$PATH\"",
        p.command.display(),
        p.config.display(),
        files::shell_quote(&p.prefix.join("bin").to_string_lossy())
    );
    Ok(())
}

pub(crate) fn uninstall(args: &Args, config: &Config, p: &Paths) -> Result<()> {
    let plugin_only = args.asset.as_deref() == Some("plugin");
    ensure!(
        !plugin_only || config.owns_plugin(),
        "The DSH bundle is externally owned; uninstall it through DSH. The daemon and its service have not been changed."
    );
    let running = plugin_only && config.installed() && service::state(p)?.running;
    if config.installed() {
        service::stop(config, p)?;
    }
    let result = (|| -> Result<()> {
        if config.owns_plugin() && config.components.iter().any(|s| s == "plugin") {
            plugin(config, p, "remove")?;
            files::remove(&p.root.join("plugin"))?;
        }
        let mut saved = config.clone();
        if plugin_only {
            saved.components.retain(|s| s != "plugin");
            saved.save(p)?;
            return Ok(());
        }
        service::autostart(config, p, false)?;
        files::remove(&service::prepare(config, p)?.file)?;
        let shared = p.prefix.join("bin/drdsh");
        if fs::read_link(&shared).is_ok_and(|t| t == p.bin.join("drdsh")) {
            let other = if p.scope == "relay" {
                "daemon"
            } else {
                "relay"
            };
            let alternate = p.prefix.join(format!("lib/dr.dsh/{other}/bin/drdsh"));
            if alternate.is_file() {
                link(&alternate, &shared)?;
            } else {
                files::remove(&shared)?;
            }
        }
        for path in [
            &p.command,
            &p.prefix.join(format!("bin/drdsh-{}ctl", p.scope)),
            &p.bin.join("drdsh"),
            &p.root.join("client"),
            &p.root.join("prefix.json"),
        ] {
            files::remove(path)?;
        }
        saved.components.clear();
        saved.save(p)?;
        Ok(())
    })();
    if running {
        service::start(&Config::read(p)?, p)?;
    }
    result?;
    println!(
        "Uninstalled {}. Configuration, pairing keys and logs are retained.",
        if plugin_only { "plugin" } else { &p.scope }
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn externally_owned_bundle_is_not_copied_or_registered() -> Result<()> {
        let temporary = tempfile::tempdir()?;
        let source = temporary.path().join("bundle");
        let prefix = temporary.path().join("installed");
        files::mkdir(&source.join("bin"))?;
        files::atomic_write(&source.join("bin/drdsh"), b"#!/bin/sh\nexit 0\n", 0o700)?;
        let bundle = Bundle {
            format: 1,
            version: env!("CARGO_PKG_VERSION").into(),
            target: format!(
                "{}-{}",
                std::env::consts::ARCH,
                if cfg!(target_os = "macos") {
                    "apple-darwin"
                } else {
                    "unknown-linux-musl"
                }
            ),
            components: vec!["daemon".into()],
        };
        files::atomic_write(
            &source.join("bundle.json"),
            &serde_json::to_vec(&bundle)?,
            0o600,
        )?;
        // This executable would fail any accidental plugin add/remove. The bundle
        // deliberately has no plugin asset, as a DSH-owned package need not ship it.
        let dsh = temporary.path().join("dsh");
        files::atomic_write(&dsh, b"#!/bin/sh\nexit 79\n", 0o700)?;
        let args = Args::parse(vec![
            "install".into(),
            "--prefix".into(),
            prefix.to_string_lossy().into(),
            "--source".into(),
            source.to_string_lossy().into(),
            "--dsh".into(),
            dsh.to_string_lossy().into(),
            "--workdir".into(),
            temporary.path().to_string_lossy().into(),
            "--plugin-owner".into(),
            "external".into(),
            "--plugin-reports".into(),
            "--local-admin".into(),
        ])?;
        let p = Paths::new(&prefix, "daemon")?;
        let _lock = files::DirectoryGuard::lock(&p.root)?;
        install("daemon", &args, &p)?;
        let config = Config::read(&p)?;
        assert!(!config.owns_plugin());
        assert!(config.plugin_reports_enabled());
        assert_eq!(config.components, ["daemon"]);
        assert!(!p.root.join("plugin").exists());
        let remove = Args::parse(vec!["uninstall".into(), "plugin".into()])?;
        assert!(uninstall(&remove, &config, &p).is_err());
        assert!(p.bin.join("drdsh").is_file());
        assert!(plugin(&config, &p, "add").is_err());
        Ok(())
    }
}
