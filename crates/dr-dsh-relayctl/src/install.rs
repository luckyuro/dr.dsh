//! Install prepared artifacts; JavaScript is built only on the build machine.

use crate::{Args, Config, Paths, absolute, files, service};
use anyhow::{Context, Result, ensure};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn executable(path: &Path) -> Result<()> {
    let meta = fs::metadata(path).with_context(|| {
        format!(
            "Missing relay binary {}; build or unpack a complete relay bundle before retrying.",
            path.display()
        )
    })?;
    ensure!(
        meta.is_file() && meta.len() != 0,
        "Relay binary {} is empty or not a regular file; rebuild the bundle.",
        path.display()
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            meta.permissions().mode() & 0o111 != 0,
            "Relay binary {} is not executable; preserve executable permissions when unpacking the bundle.",
            path.display()
        );
    }
    Ok(())
}

pub(crate) fn install(args: &Args, p: &Paths) -> Result<()> {
    let previous = if p.config.exists() {
        Some(Config::read(p)?)
    } else {
        None
    };
    let source = absolute(&match args.value("source") {
        Some(source) => PathBuf::from(source),
        None => previous
            .as_ref()
            .map(|c| c.source.clone())
            .unwrap_or(std::env::current_dir()?),
    })?;
    let bundle = source.join("bin/drdsh-relayctl").is_file();
    let profile = args
        .value("build-profile")
        .or_else(|| previous.as_ref().and_then(|c| c.build_profile.as_deref()))
        .unwrap_or("release");
    let override_client = args.value("client-dir").map(PathBuf::from).or_else(|| {
        if args.value("source").is_none() && !bundle {
            previous.as_ref().and_then(|c| c.client_dir.clone())
        } else {
            None
        }
    });
    ensure!(
        !bundle || args.value("client-dir").is_none(),
        "A relay bundle already includes its PWA; use --client-dir only with a source checkout."
    );
    let client = absolute(
        &override_client
            .clone()
            .unwrap_or_else(|| source.join(if bundle { "client" } else { "apps/pwa/dist" })),
    )?;
    let mut config = Config {
        version: 1,
        prefix: p.prefix.clone(),
        scope: "relay".into(),
        source: source.clone(),
        bind: args
            .value("bind")
            .map(str::to_owned)
            .or_else(|| previous.as_ref().map(|c| c.bind.clone()))
            .unwrap_or_else(|| "127.0.0.1:8787".into()),
        components: vec!["relay".into(), "client".into()],
        client_dir: override_client.map(|_| client.clone()),
        build_profile: Some(profile.into()),
    };
    config.validate(p)?;
    ensure!(
        !args.client_only || previous.as_ref().is_some_and(Config::installed),
        "PWA-only update requires an installed relay; run relay/install.sh first."
    );
    if previous.is_none() {
        for path in [
            &p.command,
            &p.bin.join("drdsh-relay"),
            &p.bin.join("drdsh-relayctl"),
        ] {
            ensure!(
                fs::symlink_metadata(path).is_err(),
                "Refusing to overwrite unmanaged relay command {}; choose another --prefix or move it manually.",
                path.display()
            );
        }
    }
    for name in [
        "index.html",
        "shell.js",
        "session.js",
        "service-worker.js",
        "manifest.webmanifest",
        "icon-192.png",
        "icon-512.png",
    ] {
        let path = client.join(name);
        ensure!(
            fs::metadata(&path).is_ok_and(|m| m.is_file() && m.len() > 0),
            "Missing prebuilt PWA file {}. Build it on a development machine with pnpm --filter @dr.dsh/pwa build, then copy it using --client-dir; or install a complete relay bundle. The relay installer never runs Node.js.",
            path.display()
        );
    }
    let binaries = if bundle {
        source.join("bin")
    } else {
        source.join("target").join(profile)
    };
    if !bundle && !args.client_only && !args.flag("skip-build") {
        ensure!(
            source.join("Cargo.toml").is_file(),
            "Relay source checkout is missing Cargo.toml; choose a checkout or an extracted bundle with --source."
        );
        let mut cargo = Command::new("cargo");
        cargo
            .current_dir(&source)
            .args(["build", "--locked", "--target-dir"])
            .arg(source.join("target"))
            .args(["-p", "dr-dsh-relay", "-p", "dr-dsh-relayctl"]);
        if profile == "release" {
            cargo.arg("--release");
        }
        ensure!(cargo.status().context("Cannot run Cargo for relay source installation; install Rust or use a prebuilt relay bundle.")?.success(),
            "Relay source build failed; fix the build error above or use a prebuilt bundle. Existing services were not stopped.");
    }
    if !args.client_only {
        for name in ["drdsh-relay", "drdsh-relayctl"] {
            executable(&binaries.join(name))?;
        }
    }
    if args.flag("start") || args.flag("enable") || previous.as_ref().is_some_and(Config::installed)
    {
        service::available()?;
    }
    let stage = files::DirectoryGuard::stage(&p.root)?;
    files::copy(&client, &stage.0.join("client"))?;
    if !args.client_only {
        for name in ["drdsh-relay", "drdsh-relayctl"] {
            files::copy(&binaries.join(name), &stage.0.join(name))?;
        }
    }
    let was_running =
        previous.as_ref().is_some_and(Config::installed) && service::state(p)?.running;
    if was_running {
        service::stop(
            previous
                .as_ref()
                .context("Relay update lost its previous configuration.")?,
            p,
        )?;
    }
    let update = (|| -> Result<()> {
        if !args.client_only {
            for name in ["drdsh-relay", "drdsh-relayctl"] {
                files::promote(&stage.0.join(name), &p.bin.join(name))?;
            }
            let launcher = format!(
                "#!/bin/sh\nexec {} \"$@\"\n",
                files::shell_quote(&p.bin.join("drdsh-relayctl").to_string_lossy())
            );
            files::atomic_write(&p.command, launcher.as_bytes(), 0o755)?;
            files::atomic_write(
                &p.root.join("prefix.json"),
                &serde_json::to_vec(&serde_json::json!({ "prefix": p.prefix, "scope": "relay" }))?,
                0o600,
            )?;
            // Old scoped installations retain their service identity but no longer need the JS CLI.
            for name in ["drdsh.mjs", "service-manager.mjs", "component-cli.mjs"] {
                files::remove(&p.root.join(name))?;
            }
            files::remove(&p.bin.join("drdsh"))?;
        }
        files::promote(&stage.0.join("client"), &p.root.join("client"))?;
        if args.client_only {
            config.components = previous
                .as_ref()
                .context("PWA update has no relay configuration.")?
                .components
                .clone();
        }
        config.save(p)?;
        service::prepare(&config, p)?;
        Ok(())
    })();
    // Restore the service after any attempted update, including a filesystem failure.
    if was_running {
        let saved = Config::read(p)?;
        if let Err(restart) = service::start(&saved, p) {
            return Err(match update { Ok(()) => restart, Err(update) => update.context(format!("Relay could not restart after the failed update: {restart:#}; inspect logs and reinstall.")) });
        }
    }
    update?;
    if args.flag("enable") {
        service::autostart(&config, p, true)?;
    }
    if args.flag("start") && !was_running {
        service::start(&config, p)?;
    }
    println!(
        "Installed relay/PWA. Command: {}\nConfig: {}\nNo Node.js or pnpm is used by relay installation or management.",
        p.command.display(),
        p.config.display()
    );
    Ok(())
}

pub(crate) fn uninstall(config: &Config, p: &Paths) -> Result<()> {
    if config.installed() {
        service::stop(config, p)?;
        service::autostart(config, p, false)?;
    }
    let s = service::prepare(config, p)?;
    files::remove(&s.file)?;
    for path in [
        &p.command,
        &p.root.join("client"),
        &p.bin.join("drdsh-relay"),
        &p.bin.join("drdsh-relayctl"),
        &p.bin.join("drdsh"),
    ] {
        files::remove(path)?;
    }
    for name in [
        "drdsh.mjs",
        "service-manager.mjs",
        "component-cli.mjs",
        "prefix.json",
    ] {
        files::remove(&p.root.join(name))?;
    }
    let mut saved = config.clone();
    saved.components.clear();
    saved.save(p)?;
    println!(
        "Uninstalled relay/PWA. Relay configuration and logs are retained; run a relay bundle's install.sh to reinstall."
    );
    Ok(())
}
