//! Local relay installation and service management, without a JavaScript runtime.

mod files;
mod install;
mod service;

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::net::SocketAddr;
use std::path::{Component, Path, PathBuf};

const HELP: &str = "drdsh-relayctl — install and manage relay/PWA without Node.js

  drdsh-relayctl install [client] [options]
  drdsh-relayctl start|stop|restart|status|enable|disable
  drdsh-relayctl logs [--follow]
  drdsh-relayctl uninstall

  --prefix <path>       installation prefix (default ~/.local; valid for every command)
  --source <directory>  extracted relay bundle or source checkout; saved for updates
  --client-dir <path>   prebuilt PWA directory (source installs only)
  --bind <ip:port>      default 127.0.0.1:8787
  --start              start after installation
  --enable             enable login autostart
  --skip-build         use existing binaries from a source checkout
  --build-profile <release|debug>  source build profile (default release)

Bundles contain both native programs and PWA files; no build tools are needed on the server.
Source installs require Cargo and an already built PWA; they never run Node.js or pnpm.
Use relay/package.sh on a build machine to prepare a bundle.
Updates only restart relay. Uninstall preserves relay configuration and logs.
Services require macOS launchd or a Linux systemd user session (including WSL2).
";

#[derive(Debug)]
struct Args {
    action: String,
    client_only: bool,
    values: BTreeMap<String, String>,
    flags: BTreeSet<String>,
}

impl Args {
    fn parse(argv: Vec<String>) -> Result<Option<Self>> {
        if argv.is_empty() || argv.iter().any(|s| s == "--help" || s == "-h") {
            return Ok(None);
        }
        let mut iter = argv.into_iter();
        let action = iter
            .next()
            .context("Choose a relay command; run drdsh-relayctl --help.")?;
        ensure!(
            [
                "install",
                "uninstall",
                "start",
                "stop",
                "restart",
                "status",
                "logs",
                "enable",
                "disable"
            ]
            .contains(&action.as_str()),
            "Unknown relay command {action}; use drdsh-daemonctl for daemon operations, or run drdsh-relayctl --help."
        );
        let mut result = Self {
            action,
            client_only: false,
            values: BTreeMap::new(),
            flags: BTreeSet::new(),
        };
        for_next(&mut iter, &mut result)?;
        if let Some(profile) = result.value("build-profile") {
            ensure!(
                ["release", "debug"].contains(&profile),
                "Relay build profile must be release or debug; check --build-profile."
            );
        }
        Ok(Some(result))
    }

    fn value(&self, name: &str) -> Option<&str> {
        self.values.get(name).map(String::as_str)
    }
    fn flag(&self, name: &str) -> bool {
        self.flags.contains(name)
    }
}

fn for_next(iter: &mut impl Iterator<Item = String>, result: &mut Args) -> Result<()> {
    while let Some(arg) = iter.next() {
        if arg == "client" && result.action == "install" && !result.client_only {
            result.client_only = true;
            continue;
        }
        let Some(key) = arg.strip_prefix("--") else {
            bail!(
                "Unexpected relay argument {arg}; only install accepts the client component. Run drdsh-relayctl --help."
            );
        };
        let value_option = key == "prefix"
            || (result.action == "install"
                && ["source", "client-dir", "bind", "build-profile"].contains(&key));
        let flag_option = (result.action == "install"
            && ["start", "enable", "skip-build"].contains(&key))
            || (result.action == "logs" && key == "follow");
        ensure!(
            value_option || flag_option,
            "{arg} does not configure relay {}. Use drdsh-relayctl --help or the daemon command.",
            result.action
        );
        ensure!(
            !result.values.contains_key(key) && !result.flags.contains(key),
            "Repeated relay option {arg}; specify it once."
        );
        if flag_option {
            result.flags.insert(key.to_owned());
        } else {
            let value = iter
                .next()
                .with_context(|| format!("Relay option {arg} needs a value; see --help."))?;
            ensure!(
                !value.is_empty()
                    && !value.starts_with("--")
                    && !value.contains(['\0', '\r', '\n']),
                "Relay option {arg} needs a value without line breaks."
            );
            result.values.insert(key.to_owned(), value);
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    version: u8,
    prefix: PathBuf,
    scope: String,
    source: PathBuf,
    bind: String,
    components: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    client_dir: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    build_profile: Option<String>,
}

impl Config {
    fn validate(&self, p: &Paths) -> Result<()> {
        ensure!(
            self.version == 1 && self.scope == "relay",
            "Unsupported relay configuration version or scope; use the matching installer."
        );
        for path in [&self.prefix, &self.source]
            .into_iter()
            .chain(self.client_dir.iter())
        {
            ensure!(
                path.is_absolute() && !path.to_string_lossy().contains(['\0', '\r', '\n']),
                "Relay configuration paths must be absolute and contain no line breaks; repair relay.json."
            );
        }
        ensure!(
            absolute(&self.prefix)? == p.prefix,
            "Relay configuration belongs to another prefix; use its original --prefix."
        );
        let addr: SocketAddr = self.bind.parse().context("Relay bind must be an IP address and port, such as 127.0.0.1:8787 or [::1]:8787; check --bind.")?;
        ensure!(
            addr.port() != 0,
            "Relay port must be between 1 and 65535; check --bind."
        );
        ensure!(
            self.components
                .iter()
                .all(|c| c == "relay" || c == "client"),
            "Relay configuration contains another component; repair relay.json before continuing."
        );
        ensure!(
            self.build_profile
                .as_deref()
                .is_none_or(|p| p == "release" || p == "debug"),
            "Invalid saved relay build profile; repair relay.json."
        );
        Ok(())
    }

    fn read(p: &Paths) -> Result<Self> {
        let raw = std::fs::read(&p.config).with_context(|| {
            format!(
                "Cannot read {}; install relay first or choose its --prefix.",
                p.config.display()
            )
        })?;
        let config: Self = serde_json::from_slice(&raw).context(
            "Cannot parse relay.json; repair its JSON and relay-only fields before continuing.",
        )?;
        config.validate(p)?;
        Ok(config)
    }

    fn save(&self, p: &Paths) -> Result<()> {
        let mut bytes = serde_json::to_vec_pretty(self)?;
        bytes.push(b'\n');
        files::atomic_write(&p.config, &bytes, 0o600)
    }

    fn installed(&self) -> bool {
        self.components.iter().any(|c| c == "relay")
    }
}

struct Paths {
    prefix: PathBuf,
    root: PathBuf,
    bin: PathBuf,
    command: PathBuf,
    config: PathBuf,
}

impl Paths {
    fn new(prefix: &Path) -> Result<Self> {
        let prefix = absolute(prefix)?;
        let root = prefix.join("lib/dr.dsh/relay");
        Ok(Self {
            bin: root.join("bin"),
            command: prefix.join("bin/drdsh-relayctl"),
            config: prefix.join("etc/dr.dsh/relay.json"),
            prefix,
            root,
        })
    }
}

fn absolute(path: &Path) -> Result<PathBuf> {
    let input = if path.is_absolute() {
        path.to_owned()
    } else {
        env::current_dir()?.join(path)
    };
    let mut result = PathBuf::new();
    // Match the former Node path.resolve without resolving symlinks: service identity uses this path.
    for component in input.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            other => result.push(other.as_os_str()),
        }
    }
    Ok(result)
}

fn default_prefix() -> Result<PathBuf> {
    let exe = env::current_exe()?;
    if let Some(root) = exe.parent().and_then(Path::parent) {
        let saved = root.join("prefix.json");
        if saved.exists() {
            let value: serde_json::Value = serde_json::from_slice(&std::fs::read(saved)?)?;
            ensure!(
                value["scope"] == "relay",
                "Installed relay command has an invalid scope; reinstall it from a bundle."
            );
            return value["prefix"]
                .as_str()
                .map(PathBuf::from)
                .context("Installed relay prefix is missing; reinstall from a bundle.");
        }
    }
    Ok(PathBuf::from(
        env::var_os("HOME")
            .context("HOME is unavailable; specify --prefix for relay installation.")?,
    )
    .join(".local"))
}

fn run() -> Result<i32> {
    let Some(args) = Args::parse(env::args().skip(1).collect())? else {
        print!("{HELP}");
        return Ok(0);
    };
    ensure!(
        cfg!(any(target_os = "linux", target_os = "macos")),
        "Relay installation supports macOS and Linux user services; use systemd-enabled WSL2 on Windows."
    );
    let prefix = match args.value("prefix") {
        Some(p) => PathBuf::from(p),
        None => default_prefix()?,
    };
    let p = Paths::new(&prefix)?;
    let _lock = if ["status", "logs"].contains(&args.action.as_str()) {
        None
    } else {
        Some(files::DirectoryGuard::lock(&p.root)?)
    };
    if args.action == "install" {
        install::install(&args, &p)?;
        return Ok(0);
    }
    let config = Config::read(&p)?;
    service::available()?;
    if args.action == "uninstall" {
        install::uninstall(&config, &p)?;
        return Ok(0);
    }
    ensure!(
        config.installed(),
        "No relay is installed at {}; run relay/install.sh or the bundle installer.",
        p.prefix.display()
    );
    match args.action.as_str() {
        "start" => service::start(&config, &p)?,
        "stop" => service::stop(&config, &p)?,
        "restart" => {
            service::stop(&config, &p)?;
            service::start(&config, &p)?;
        }
        "enable" | "disable" => service::autostart(&config, &p, args.action == "enable")?,
        "status" => return service::status(&config, &p),
        "logs" => service::logs(&config, &p, args.flag("follow"))?,
        _ => bail!("Unknown relay action; run drdsh-relayctl --help."),
    }
    Ok(0)
}

fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("drdsh-relayctl: {error:#}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_daemon_actions_and_options_before_installation() {
        for input in [
            "pair",
            "install daemon",
            "install --dsh /bin/true",
            "install --with-plugin",
            "uninstall client",
            "status --bind 127.0.0.1:8787",
            "install --prefix /a --prefix /b",
        ] {
            assert!(
                Args::parse(input.split_whitespace().map(str::to_owned).collect()).is_err(),
                "{input}"
            );
        }
    }

    #[test]
    fn reads_existing_node_relay_config_but_rejects_daemon_fields() -> Result<()> {
        let p = Paths::new(Path::new("/tmp/relay prefix"))?;
        let old = r#"{"version":1,"prefix":"/tmp/relay prefix","scope":"relay","source":"/tmp/source","bind":"[::1]:8787","components":["relay","client"]}"#;
        let mut config: Config = serde_json::from_str(old)?;
        config.validate(&p)?;
        config.bind = "127.0.0.1:0".into();
        assert!(config.validate(&p).is_err());
        assert!(
            serde_json::from_str::<Config>(
                &old.replace("\"version\":1", "\"dsh\":\"/bin/dsh\",\"version\":1")
            )
            .is_err()
        );
        Ok(())
    }
}
