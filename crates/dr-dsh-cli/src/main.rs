//! Multicall CLI. Package metadata and invocation names select supported components.

mod files;
mod install;
mod management;
mod service;

use anyhow::{Context, Result, bail, ensure};
use management::{Args, Config, Paths, absolute};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

const BANNER: &str = include_str!("../../../assets/brand/banner.txt");
const HELP: &str = "drdsh — remote access to your own DeepSeek Harness

  drdsh relay  run|install|update|uninstall|start|stop|restart|status|logs|enable|disable
  drdsh daemon run|install|update|uninstall|start|stop|restart|status|logs|enable|disable
  drdsh daemon pair|doctor|devices|audit|crashes|room-key
  drdsh install [options]         install every component in this bundle
  drdsh --version

drdsh-relay <args> and drdsh-daemon <args> select the corresponding component.
Single-component packages reject unavailable components; aliases select a fixed role.
Use drdsh <component> --help for installation and foreground options.
";

fn supports(scope: &str) -> bool {
    compiled_components().contains(&scope)
}

fn compiled_components() -> Vec<&'static str> {
    [
        (cfg!(feature = "relay"), "relay"),
        (cfg!(feature = "daemon"), "daemon"),
    ]
    .into_iter()
    .filter_map(|(enabled, name)| enabled.then_some(name))
    .collect()
}

fn components() -> Result<Vec<&'static str>> {
    let exe = std::fs::canonicalize(std::env::current_exe()?)?;
    let manifest = exe
        .parent()
        .and_then(Path::parent)
        .map(|p| p.join("bundle.json"));
    if let Some(path) = manifest.filter(|p| p.is_file()) {
        let bundle: install::Bundle = serde_json::from_slice(&std::fs::read(path)?)
            .context("Invalid package manifest; extract or reinstall a complete package.")?;
        ensure!(
            bundle.format == 1
                && !bundle.components.is_empty()
                && bundle
                    .components
                    .iter()
                    .all(|s| s == "relay" || s == "daemon"),
            "Invalid package components; reinstall the matching package."
        );
        return Ok(compiled_components()
            .into_iter()
            .filter(|s| bundle.components.iter().any(|c| c == s))
            .collect());
    }
    Ok(compiled_components())
}

fn unavailable(scope: &str) -> Result<()> {
    let included = components()?;
    ensure!(
        supports(scope) && included.contains(&scope),
        "This package contains only {}; {scope} is unavailable. Install the {scope} or mixed package for this platform.",
        included.join(" + ")
    );
    Ok(())
}

fn alias(name: &str) -> Option<&'static str> {
    match name {
        "drdsh-relay" | "drdsh-relayctl" | "drdsh—relay" => Some("relay"),
        "drdsh-daemon" | "drdsh-daemonctl" | "drdsh—daemon" => Some("daemon"),
        _ => None,
    }
}

fn exec(mut command: Command) -> Result<ExitCode> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        Err(command.exec()).context("Cannot launch the selected component; reinstall its package.")
    }
    #[cfg(not(unix))]
    Ok(ExitCode::from(command.status()?.code().unwrap_or(1) as u8))
}

fn runtime(scope: &str, args: Vec<String>) -> Result<ExitCode> {
    unavailable(scope)?;
    match scope {
        #[cfg(feature = "daemon")]
        "daemon" => dr_dsh_daemon::cli::run_with_args(args.into_iter().map(Into::into).collect()),
        #[cfg(feature = "relay")]
        "relay" => {
            let mut config = dr_dsh_relay::config::Config::from_env_and_args()?;
            let mut args = args.into_iter();
            ensure!(
                args.next().as_deref() == Some("run"),
                "Relay foreground command must be run; use drdsh relay --help."
            );
            while let Some(key) = args.next() {
                let value = args.next().context(
                    "Relay foreground option needs a value; use --bind or --client-dir.",
                )?;
                match key.as_str() {
                    "--bind" => {
                        config.bind = value
                            .parse()
                            .context("Relay --bind must be an IP address and port.")?
                    }
                    "--client-dir" => config.client_dir = Some(PathBuf::from(value)),
                    _ => {
                        bail!("Unknown relay foreground option {key}; use --bind or --client-dir.")
                    }
                }
            }
            Ok(dr_dsh_relay::run_with_config(config))
        }
        _ => bail!("Unknown component {scope}; choose relay or daemon."),
    }
}

fn run(name: &str, mut args: Vec<String>) -> Result<ExitCode> {
    if let Some(scope) = alias(name) {
        unavailable(scope)?;
    }
    // An exec into our own runtime preserves signals and applies saved environment safely,
    // before any Tokio threads exist. It must still enforce compiled capabilities.
    if args.first().is_some_and(|a| a == "__runtime") {
        ensure!(
            args.len() >= 3,
            "Incomplete runtime invocation; use drdsh --help."
        );
        return runtime(&args[1], args[2..].to_vec());
    }
    if args
        .first()
        .is_some_and(|a| a == "--version" || a == "version")
    {
        println!(
            "drdsh {} ({})",
            env!("CARGO_PKG_VERSION"),
            components()?.join(" + ")
        );
        return Ok(ExitCode::SUCCESS);
    }
    if let Some(scope) = alias(name) {
        // Accept an explicit matching component too; reject an explicit opposite component
        // before examining help or options so aliases cannot switch roles accidentally.
        if args.first().is_some_and(|a| a == "relay" || a == "daemon") {
            ensure!(
                args[0] == scope,
                "{name} selects {scope}; use drdsh {} or the matching package instead.",
                args[0]
            );
            args.remove(0);
        }
        args.insert(0, scope.into());
    }
    if args.is_empty() || matches!(args[0].as_str(), "--help" | "-h") {
        print!("{HELP}\nIncluded: {}\n", components()?.join(" + "));
        return Ok(ExitCode::SUCCESS);
    }
    if args[0] == "install" {
        let common = Args::parse(args)?;
        if common.help {
            print!(
                "{HELP}\nUse drdsh relay --help or drdsh daemon --help for installation options.\n"
            );
            return Ok(ExitCode::SUCCESS);
        }
        ensure!(
            common.asset.is_none(),
            "Use drdsh relay install client or drdsh daemon install plugin for asset-only updates."
        );
        let included = components()?;
        if included.len() == 1 {
            return management::run(included[0], common).map(|c| ExitCode::from(c as u8));
        }
        // Check DSH before installing either component of a mixed bundle.
        if supports("daemon") {
            management::make_config("daemon", &common)?;
        }
        for scope in included {
            let scoped = common.for_scope(scope);
            management::run(scope, scoped)?;
        }
        return Ok(ExitCode::SUCCESS);
    }
    let scope = args.remove(0);
    ensure!(
        scope == "relay" || scope == "daemon",
        "Unknown component {scope}; choose relay or daemon. Run drdsh --help."
    );
    // Installed canonical drdsh dispatches to each component's own immutable-in-use copy.
    // Bare extracted/renamed single-component binaries have no installation marker.
    if alias(name).is_none()
        && let Some(prefix) = management::installed_prefix()?
    {
        let other = prefix.join(format!("lib/dr.dsh/{scope}/bin/drdsh"));
        if other.is_file()
            && std::fs::canonicalize(&other)? != std::fs::canonicalize(std::env::current_exe()?)?
        {
            let mut command = Command::new(other);
            command
                .arg(&scope)
                .args(args)
                .env("DRDSH_BANNER_SHOWN", "1");
            return exec(command);
        }
    }
    unavailable(&scope)?;
    if args.is_empty() || matches!(args[0].as_str(), "--help" | "-h") {
        print!("{}", management::help(&scope));
        return Ok(ExitCode::SUCCESS);
    }
    let action = &args[0];
    if [
        "install",
        "update",
        "uninstall",
        "start",
        "stop",
        "restart",
        "status",
        "logs",
        "enable",
        "disable",
    ]
    .contains(&action.as_str())
    {
        if args.iter().any(|a| a == "--help" || a == "-h") {
            print!("{}", management::help(&scope));
            return Ok(ExitCode::SUCCESS);
        }
        return management::run(&scope, Args::parse(args)?).map(|c| ExitCode::from(c as u8));
    }
    ensure!(
        action == "run"
            || (scope == "daemon"
                && [
                    "pair",
                    "pair-as-device",
                    "doctor",
                    "devices",
                    "audit",
                    "crashes",
                    "room-key",
                    "version"
                ]
                .contains(&action.as_str())),
        "Unknown {scope} command {action}; run drdsh {scope} --help."
    );
    if args.iter().any(|a| a == "--help" || a == "-h") {
        print!("{}", management::help(&scope));
        return Ok(ExitCode::SUCCESS);
    }
    let mut prefix = None;
    if let Some(index) = args.iter().position(|a| a == "--prefix") {
        ensure!(
            index + 1 < args.len(),
            "--prefix needs an installation directory."
        );
        prefix = Some(PathBuf::from(args.remove(index + 1)));
        args.remove(index);
    }
    let p = Paths::new(&management::prefix(prefix.as_deref())?, &scope)?;
    let mut command = Command::new(std::env::current_exe()?);
    if p.config.is_file() {
        let config = Config::read(&p)?;
        ensure!(
            config.installed(),
            "{scope} has been uninstalled; install it again before using saved settings."
        );
        config.configure(&mut command, &p);
        if scope == "daemon" {
            for (key, value) in config.daemon_args(&args[0]) {
                if !args.iter().any(|a| a == &key) {
                    args.extend([key, value]);
                }
            }
        }
    } else {
        ensure!(
            prefix.is_none(),
            "No {scope} installation at {}; install it first or omit --prefix for foreground defaults.",
            p.prefix.display()
        );
        if scope == "relay"
            && let Some(root) = std::env::current_exe()?.parent().and_then(Path::parent)
            && root.join("client").is_dir()
        {
            command.env("DSH_RELAY_CLIENT_DIR", root.join("client"));
        }
    }
    command.args(["__runtime", &scope]).args(args);
    exec(command)
}

fn main() -> ExitCode {
    let mut argv = std::env::args();
    let program = argv.next().unwrap_or_default();
    let name = Path::new(&program)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("drdsh");
    let args: Vec<String> = argv.collect();
    if !args.first().is_some_and(|a| a == "__runtime")
        && std::env::var_os("DRDSH_BANNER_SHOWN").is_none()
    {
        eprint!("{BANNER}");
    }
    match run(name, args) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("drdsh: {error:#}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn aliases_reject_opposite_commands_before_help() {
        for (name, other) in [("drdsh-relay", "daemon"), ("drdsh-daemon", "relay")] {
            assert!(run(name, vec![other.into(), "--help".into()]).is_err());
        }
    }
    #[test]
    fn unavailable_components_cannot_reach_runtime() {
        for scope in ["relay", "daemon"] {
            if !supports(scope) {
                assert!(run("drdsh", vec![scope.into(), "--help".into()]).is_err());
                assert!(runtime(scope, vec!["run".into()]).is_err());
            }
        }
    }
}
