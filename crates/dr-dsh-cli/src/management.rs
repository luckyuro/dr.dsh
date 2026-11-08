//! Native installation settings, compatible with the independent v1 service identities.

use crate::{files, install, service};
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::net::SocketAddr;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

#[derive(Clone, Debug)]
pub(crate) struct Args {
    pub action: String,
    pub asset: Option<String>,
    pub help: bool,
    values: BTreeMap<String, String>,
    flags: BTreeSet<String>,
}

const RELAY_VALUES: &[&str] = &[
    "bind",
    "client-dir",
    "tls-cert",
    "tls-key",
    "tls-server-name",
];
const DAEMON_VALUES: &[&str] = &[
    "relay",
    "dsh",
    "dsh-home",
    "workdir",
    "port",
    "state-dir",
    "plugin-owner",
];

impl Args {
    pub fn parse(argv: Vec<String>) -> Result<Self> {
        let mut argv = argv.into_iter();
        let action = argv.next().context("Choose a command; run drdsh --help.")?;
        let mut result = Self {
            action,
            asset: None,
            help: false,
            values: BTreeMap::new(),
            flags: BTreeSet::new(),
        };
        while let Some(arg) = argv.next() {
            if matches!(arg.as_str(), "-h" | "--help") {
                result.help = true;
                continue;
            }
            if (arg == "client" || arg == "plugin")
                && result.asset.is_none()
                && ["install", "uninstall"].contains(&result.action.as_str())
            {
                result.asset = Some(arg);
                continue;
            }
            let key = arg
                .strip_prefix("--")
                .context("Unexpected command argument; run drdsh <component> --help.")?;
            let value = key == "prefix"
                || (result.action == "install"
                    && (["source", "build-profile"].contains(&key)
                        || RELAY_VALUES.contains(&key)
                        || DAEMON_VALUES.contains(&key)
                        || key == "ca-cert"))
                || (result.action == "update" && key == "version");
            let flag = (result.action == "install"
                && [
                    "skip-build",
                    "start",
                    "enable",
                    "with-plugin",
                    "dsh-tls",
                    "plugin-reports",
                    "no-plugin-reports",
                    "local-admin",
                    "no-local-admin",
                ]
                .contains(&key))
                || (["install", "status"].contains(&result.action.as_str())
                    && ["insecure", "no-insecure"].contains(&key))
                || (result.action == "logs" && key == "follow");
            ensure!(
                value || flag,
                "{arg} does not configure {}; use the component help.",
                result.action
            );
            ensure!(
                !result.values.contains_key(key) && !result.flags.contains(key),
                "Repeated option {arg}; specify it once."
            );
            if flag {
                result.flags.insert(key.into());
            } else {
                let value = argv
                    .next()
                    .with_context(|| format!("{arg} needs a value."))?;
                ensure!(
                    !value.is_empty()
                        && !value.starts_with("--")
                        && !value.contains(['\0', '\r', '\n']),
                    "{arg} needs a nonempty value without line breaks."
                );
                result.values.insert(key.into(), value);
            }
        }
        ensure!(
            !(result.flag("insecure") && result.flag("no-insecure")),
            "Choose either --insecure or --no-insecure; they cannot be used together."
        );
        for (enable, disable) in [
            ("plugin-reports", "no-plugin-reports"),
            ("local-admin", "no-local-admin"),
        ] {
            ensure!(
                !(result.flag(enable) && result.flag(disable)),
                "Choose either --{enable} or --{disable}; they cannot be used together."
            );
        }
        Ok(result)
    }
    pub fn value(&self, name: &str) -> Option<&str> {
        self.values.get(name).map(String::as_str)
    }
    pub fn flag(&self, name: &str) -> bool {
        self.flags.contains(name)
    }
    pub fn tls_insecure(&self) -> Option<bool> {
        if self.flag("insecure") {
            Some(true)
        } else if self.flag("no-insecure") {
            Some(false)
        } else {
            None
        }
    }
    pub fn for_scope(&self, scope: &str) -> Self {
        let mut args = self.clone();
        for key in if scope == "relay" {
            DAEMON_VALUES
        } else {
            RELAY_VALUES
        } {
            args.values.remove(*key);
        }
        if scope == "relay" {
            for flag in [
                "with-plugin",
                "dsh-tls",
                "plugin-reports",
                "no-plugin-reports",
                "local-admin",
                "no-local-admin",
            ] {
                args.flags.remove(flag);
            }
        }
        args
    }
    fn validate_scope(&self, scope: &str) -> Result<()> {
        for key in if scope == "relay" {
            DAEMON_VALUES
        } else {
            RELAY_VALUES
        } {
            ensure!(
                self.value(key).is_none(),
                "--{key} does not configure {scope}; use the other component's install command."
            );
        }
        ensure!(
            scope == "daemon" || !self.flag("with-plugin"),
            "The plugin belongs to daemon; use drdsh daemon install --with-plugin."
        );
        ensure!(
            scope == "daemon" || !self.flag("dsh-tls"),
            "--dsh-tls configures daemon's DSH connection; use drdsh daemon install."
        );
        ensure!(
            scope == "daemon"
                || ![
                    "plugin-reports",
                    "no-plugin-reports",
                    "local-admin",
                    "no-local-admin"
                ]
                .iter()
                .any(|flag| self.flag(flag)),
            "Plugin reports and local administration configure daemon; use drdsh daemon install."
        );
        if let Some(asset) = &self.asset {
            ensure!(
                (scope == "relay" && asset == "client" && self.action == "install")
                    || (scope == "daemon" && asset == "plugin"),
                "{scope} cannot {} {asset}; PWA belongs to relay and plugin belongs to daemon.",
                self.action
            );
        }
        Ok(())
    }
}

/// Ownership of the DSH bundle is separate from the daemon's installed files.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PluginOwner {
    #[default]
    Daemon,
    External,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Config {
    pub version: u8,
    pub prefix: PathBuf,
    pub scope: String,
    pub source: PathBuf,
    pub components: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_owner: Option<PluginOwner>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_reports_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_admin_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_dir: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tls_cert: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tls_key: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tls_server_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ca_cert: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tls_insecure: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dsh_tls: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build_profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dsh: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dsh_managed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dsh_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dsh_home: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workdir: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl Config {
    pub fn validate(&self, p: &Paths) -> Result<()> {
        crate::provision::validate(self, p)?;
        ensure!(
            self.version == 1 && self.scope == p.scope && absolute(&self.prefix)? == p.prefix,
            "Configuration scope, version or prefix does not match {}; use the original installation prefix.",
            p.config.display()
        );
        for path in [&self.prefix, &self.source]
            .into_iter()
            .chain(self.client_dir.iter())
            .chain(self.tls_cert.iter())
            .chain(self.tls_key.iter())
            .chain(self.ca_cert.iter())
            .chain(self.dsh.iter())
            .chain(self.dsh_home.iter())
            .chain(self.workdir.iter())
            .chain(self.state.iter())
        {
            ensure!(
                path.is_absolute() && !path.to_string_lossy().contains(['\0', '\r', '\n']),
                "{} configuration contains an invalid path; use absolute paths without line breaks.",
                self.scope
            );
        }
        ensure!(
            self.components.iter().all(|c| c == &self.scope
                || c == if self.scope == "relay" {
                    "client"
                } else {
                    "plugin"
                }),
            "Configuration contains another component; repair {}.",
            p.config.display()
        );
        ensure!(
            self.build_profile
                .as_deref()
                .is_none_or(|s| s == "release" || s == "debug"),
            "Invalid --build-profile; choose release or debug."
        );
        if self.scope == "relay" {
            ensure!(
                self.tls_cert.is_some() == self.tls_key.is_some(),
                "Relay TLS requires both --tls-cert and --tls-key; supply the matching PEM files."
            );
            if let Some(name) = &self.tls_server_name {
                ensure!(
                    self.tls_cert.is_some(),
                    "--tls-server-name requires relay TLS certificates."
                );
                rustls::pki_types::ServerName::try_from(name.clone()).context(
                    "Relay --tls-server-name must be a certificate DNS name or IP address.",
                )?;
            }
            let addr: SocketAddr = self
                .bind
                .as_deref()
                .context("Relay bind is missing; reinstall with --bind.")?
                .parse()
                .context("Relay --bind must be an IP address and port.")?;
            ensure!(addr.port() > 0, "Relay port must be 1 through 65535.");
            ensure!(
                self.relay.is_none()
                    && self.dsh_tls.is_none()
                    && self.port.is_none()
                    && self.dsh.is_none()
                    && self.dsh_managed.is_none()
                    && self.dsh_version.is_none()
                    && self.dsh_home.is_none()
                    && self.workdir.is_none()
                    && self.state.is_none()
                    && self.plugin_owner.is_none()
                    && self.plugin_reports_enabled.is_none()
                    && self.local_admin_enabled.is_none()
                    && self.path.is_none(),
                "Relay configuration contains daemon fields; repair relay.json."
            );
        } else {
            ensure!(
                self.bind.is_none()
                    && self.client_dir.is_none()
                    && self.tls_cert.is_none()
                    && self.tls_key.is_none()
                    && self.tls_server_name.is_none(),
                "Daemon configuration contains relay fields; repair daemon.json."
            );
            let relay = self
                .relay
                .as_deref()
                .context("Daemon relay is missing; reinstall with --relay.")?;
            let authority = relay
                .strip_prefix("ws://")
                .or_else(|| relay.strip_prefix("wss://"))
                .context("Daemon --relay must be a ws:// or wss:// origin.")?
                .trim_end_matches('/');
            ensure!(
                !authority.is_empty()
                    && !authority.contains(['/', '@', '?', '#'])
                    && !authority.chars().any(char::is_whitespace),
                "Daemon --relay must be an origin without credentials, path, query or fragment."
            );
            ensure!(
                self.port.is_some_and(|p| p > 0)
                    && self.dsh.is_some()
                    && self.dsh_home.is_some()
                    && self.workdir.is_some()
                    && self.state.is_some(),
                "Daemon configuration is incomplete; reinstall with --dsh and --port."
            );
            ensure!(
                self.path
                    .as_deref()
                    .is_some_and(|s| !s.contains(['\0', '\r', '\n'])),
                "Daemon PATH is missing or has line breaks; reinstall to repair it."
            );
        }
        Ok(())
    }
    pub fn read(p: &Paths) -> Result<Self> {
        let config: Self =
            serde_json::from_slice(&std::fs::read(&p.config).with_context(|| {
                format!(
                    "No readable {} configuration; install it first or choose --prefix.",
                    p.scope
                )
            })?)
            .with_context(|| {
                format!(
                    "Cannot parse {}; repair its JSON before continuing.",
                    p.config.display()
                )
            })?;
        config.validate(p)?;
        Ok(config)
    }
    pub fn save(&self, p: &Paths) -> Result<()> {
        let mut bytes = serde_json::to_vec_pretty(self)?;
        bytes.push(b'\n');
        files::atomic_write(&p.config, &bytes, 0o600)
    }
    pub fn installed(&self) -> bool {
        self.components.contains(&self.scope)
    }
    pub fn owns_plugin(&self) -> bool {
        self.plugin_owner.unwrap_or_default() == PluginOwner::Daemon
    }
    pub fn plugin_reports_enabled(&self) -> bool {
        // Older installations coupled report listening to the optional asset.
        // A saved explicit setting always wins, including for DSH-owned bundles.
        self.plugin_reports_enabled
            .unwrap_or_else(|| self.components.iter().any(|c| c == "plugin"))
    }
    pub fn environment(&self, p: &Paths) -> BTreeMap<String, String> {
        let mut env = BTreeMap::from([("RUST_LOG".into(), "info".into())]);
        if let Some(ca) = &self.ca_cert {
            env.insert(dr_dsh_tls::ENV_CA_CERT.into(), ca.to_string_lossy().into());
        }
        if let Some(insecure) = self.tls_insecure {
            env.insert(
                dr_dsh_tls::ENV_TLS_INSECURE.into(),
                if insecure { "1" } else { "0" }.into(),
            );
        }
        if self.scope == "relay" {
            for (key, value) in [
                ("DSH_RELAY_TLS_CERT", &self.tls_cert),
                ("DSH_RELAY_TLS_KEY", &self.tls_key),
            ] {
                if let Some(value) = value {
                    env.insert(key.into(), value.to_string_lossy().into());
                }
            }
            env.insert(
                "DSH_RELAY_BIND".into(),
                self.bind.clone().unwrap_or_default(),
            );
            env.insert(
                "DSH_RELAY_CLIENT_DIR".into(),
                p.root.join("client").to_string_lossy().into(),
            );
        } else {
            // A managed plugin must address this installation even when the
            // service manager starts it without the installer's environment.
            env.insert(
                "DRDSH_MANAGER_PREFIX".into(),
                p.prefix.to_string_lossy().into(),
            );
            env.insert(
                "DSHD_PLUGIN_REPORTS".into(),
                if self.plugin_reports_enabled() {
                    "1"
                } else {
                    "0"
                }
                .into(),
            );
            env.insert(
                "DSHD_ADMIN".into(),
                if self.local_admin_enabled == Some(true) {
                    "1"
                } else {
                    "0"
                }
                .into(),
            );
            if self.dsh_tls == Some(true) {
                env.insert("DSHD_DSH_TLS".into(), "1".into());
            }
            for (key, value) in [
                ("DSHD_STATE_DIR", &self.state),
                ("DSHD_DSH", &self.dsh),
                ("DSH_HOME", &self.dsh_home),
            ] {
                if let Some(value) = value {
                    env.insert(key.into(), value.to_string_lossy().into());
                }
            }
            if let Some(path) = &self.path {
                env.insert("PATH".into(), path.clone());
            }
        }
        env
    }
    pub fn cwd<'a>(&'a self, p: &'a Paths) -> &'a Path {
        self.workdir.as_deref().unwrap_or(&p.root)
    }
    pub fn configure(&self, command: &mut Command, p: &Paths) {
        command.envs(self.environment(p)).current_dir(self.cwd(p));
    }
    pub fn daemon_args(&self, action: &str) -> Vec<(String, String)> {
        let mut args = Vec::new();
        if ["run", "pair"].contains(&action)
            && let Some(relay) = &self.relay
        {
            args.push(("--relay".into(), relay.clone()));
        }
        if ["run", "doctor"].contains(&action)
            && let Some(port) = self.port
        {
            args.push(("--port".into(), port.to_string()));
        }
        if action == "doctor"
            && let Some(dsh) = &self.dsh
        {
            args.push(("--dsh".into(), dsh.to_string_lossy().into()));
        }
        args
    }
}

pub(crate) struct Paths {
    pub prefix: PathBuf,
    pub scope: String,
    pub root: PathBuf,
    pub bin: PathBuf,
    pub command: PathBuf,
    pub config: PathBuf,
}
impl Paths {
    pub fn new(prefix: &Path, scope: &str) -> Result<Self> {
        let prefix = absolute(prefix)?;
        let root = prefix.join("lib/dr.dsh").join(scope);
        Ok(Self {
            bin: root.join("bin"),
            command: prefix.join(format!("bin/drdsh-{scope}")),
            config: prefix.join(format!("etc/dr.dsh/{scope}.json")),
            prefix,
            root,
            scope: scope.into(),
        })
    }
}
pub(crate) fn absolute(path: &Path) -> Result<PathBuf> {
    let input = if path.is_absolute() {
        path.to_owned()
    } else {
        env::current_dir()?.join(path)
    };
    let mut result = PathBuf::new();
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
pub(crate) fn installed_prefix() -> Result<Option<PathBuf>> {
    let exe = std::fs::canonicalize(env::current_exe()?)?;
    if let Some(root) = exe.parent().and_then(Path::parent) {
        let saved = root.join("prefix.json");
        if saved.is_file() {
            let value: serde_json::Value = serde_json::from_slice(&std::fs::read(saved)?)?;
            let prefix = value["prefix"]
                .as_str()
                .context("Installed prefix is missing; reinstall the package.")?;
            return Ok(Some(absolute(Path::new(prefix))?));
        }
    }
    Ok(None)
}
pub(crate) fn prefix(value: Option<&Path>) -> Result<PathBuf> {
    if let Some(path) = value {
        return absolute(path);
    }
    if let Some(path) = installed_prefix()? {
        return Ok(path);
    }
    Ok(
        PathBuf::from(env::var_os("HOME").context("HOME is missing; specify --prefix.")?)
            .join(".local"),
    )
}
pub(crate) fn executable(value: &str) -> Result<PathBuf> {
    let paths: Vec<PathBuf> = if value.contains('/') {
        vec![absolute(Path::new(value))?]
    } else {
        env::split_paths(&env::var_os("PATH").unwrap_or_default())
            .map(|p| p.join(value))
            .collect()
    };
    for path in paths {
        if let Ok(meta) = std::fs::metadata(&path) {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if meta.is_file() && meta.permissions().mode() & 0o111 != 0 {
                    return absolute(&path);
                }
            }
        }
    }
    bail!(
        "Cannot find executable {value}; install DSH and Node first, then use --dsh <absolute path>."
    )
}

pub(crate) fn make_config(scope: &str, args: &Args) -> Result<(Paths, Option<Config>, Config)> {
    let p = Paths::new(&prefix(args.value("prefix").map(Path::new))?, scope)?;
    let previous = p.config.exists().then(|| Config::read(&p)).transpose()?;
    let source = absolute(
        &args
            .value("source")
            .map(PathBuf::from)
            .or_else(|| previous.as_ref().map(|c| c.source.clone()))
            .unwrap_or(env::current_dir()?),
    )?;
    let home =
        PathBuf::from(env::var_os("HOME").context("HOME is missing; set it before installation.")?);
    let mut config = previous.clone().unwrap_or(Config {
        version: 1,
        prefix: p.prefix.clone(),
        scope: scope.into(),
        source: source.clone(),
        components: vec![],
        plugin_owner: None,
        plugin_reports_enabled: None,
        local_admin_enabled: None,
        bind: None,
        client_dir: None,
        tls_cert: None,
        tls_key: None,
        tls_server_name: None,
        ca_cert: None,
        tls_insecure: None,
        dsh_tls: None,
        build_profile: None,
        relay: None,
        port: None,
        dsh: None,
        dsh_managed: None,
        dsh_version: None,
        dsh_home: None,
        workdir: None,
        state: None,
        path: None,
    });
    config.source = source;
    if let Some(insecure) = args.tls_insecure() {
        config.tls_insecure = Some(insecure);
    }
    if let Some(value) = args.value("ca-cert") {
        let path = absolute(Path::new(value))?;
        // Validate an explicitly supplied CA even if verification is disabled,
        // so restoring verification does not reveal a broken saved trust file.
        dr_dsh_tls::client_config_with_options(Some(&path), Some(false))?;
        config.ca_cert = Some(path);
    }
    config.build_profile = Some(
        args.value("build-profile")
            .unwrap_or(config.build_profile.as_deref().unwrap_or("release"))
            .into(),
    );
    if scope == "relay" {
        config.bind = Some(
            args.value("bind")
                .unwrap_or(config.bind.as_deref().unwrap_or("127.0.0.1:8787"))
                .into(),
        );
        if let Some(value) = args.value("client-dir") {
            config.client_dir = Some(absolute(Path::new(value))?);
        }
        for (flag, dest) in [
            ("tls-cert", &mut config.tls_cert),
            ("tls-key", &mut config.tls_key),
        ] {
            if let Some(value) = args.value(flag) {
                *dest = Some(absolute(Path::new(value))?);
            }
        }
        if let Some(value) = args.value("tls-server-name") {
            config.tls_server_name = Some(value.to_owned());
        }
        if let (Some(cert), Some(key)) = (&config.tls_cert, &config.tls_key) {
            dr_dsh_tls::server_config(cert, key)?;
        }
    } else {
        if let Some(owner) = args.value("plugin-owner") {
            config.plugin_owner = Some(match owner {
                "daemon" => PluginOwner::Daemon,
                "external" => PluginOwner::External,
                _ => bail!(
                    "--plugin-owner must be daemon or external; external leaves the DSH bundle to its package manager."
                ),
            });
            if !config.owns_plugin() && config.plugin_reports_enabled.is_none() {
                config.plugin_reports_enabled = Some(config.plugin_reports_enabled());
            }
        }
        ensure!(
            config.owns_plugin()
                || !(args.flag("with-plugin") || args.asset.as_deref() == Some("plugin")),
            "The DSH bundle is externally owned; omit --with-plugin/install plugin and manage it through DSH."
        );
        for (enable, disable, destination) in [
            (
                "plugin-reports",
                "no-plugin-reports",
                &mut config.plugin_reports_enabled,
            ),
            (
                "local-admin",
                "no-local-admin",
                &mut config.local_admin_enabled,
            ),
        ] {
            if args.flag(enable) {
                *destination = Some(true);
            }
            if args.flag(disable) {
                *destination = Some(false);
            }
        }
        if args.flag("dsh-tls") {
            config.dsh_tls = Some(true);
        }
        config.relay = Some(
            args.value("relay")
                .unwrap_or(config.relay.as_deref().unwrap_or("ws://127.0.0.1:8787"))
                .into(),
        );
        config.port = Some(
            args.value("port")
                .map(str::parse::<u16>)
                .transpose()
                .context("DSH --port must be 1 through 65535.")?
                .unwrap_or(config.port.unwrap_or(3080)),
        );
        if let Some(dsh) = args.value("dsh") {
            config.dsh = Some(executable(dsh)?);
            config.dsh_managed = None;
            config.dsh_version = None;
        } else if config.dsh.is_none() {
            config.dsh = Some(crate::provision::launcher(&p));
            config.dsh_managed = Some(true);
            config.dsh_version = Some(crate::provision::DSH_VERSION.into());
        } else if config.dsh_managed != Some(true) {
            config.dsh = Some(executable(
                config
                    .dsh
                    .as_deref()
                    .and_then(Path::to_str)
                    .unwrap_or("dsh"),
            )?);
        }
        for (key, dest, default) in [
            (
                "dsh-home",
                &mut config.dsh_home,
                env::var_os("DSH_HOME")
                    .map(PathBuf::from)
                    .unwrap_or(home.join(".dsh")),
            ),
            (
                "state-dir",
                &mut config.state,
                env::var_os("DSHD_STATE_DIR")
                    .map(PathBuf::from)
                    .unwrap_or(p.prefix.join("share/dr.dsh/daemon")),
            ),
            ("workdir", &mut config.workdir, env::current_dir()?),
        ] {
            *dest = Some(absolute(
                &args
                    .value(key)
                    .map(PathBuf::from)
                    .or_else(|| dest.clone())
                    .unwrap_or(default),
            )?);
        }
        ensure!(
            config.workdir.as_deref().is_some_and(Path::is_dir),
            "DSH working directory is missing; choose --workdir."
        );
        if args.value("dsh").is_some() || config.path.is_none() {
            config.path = Some(format!(
                "{}:{}",
                config
                    .dsh
                    .as_deref()
                    .and_then(Path::parent)
                    .unwrap_or(Path::new("/usr/bin"))
                    .display(),
                env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into())
            ));
        }
        ensure!(
            !previous.as_ref().is_some_and(|c| c.owns_plugin()
                && c.components.iter().any(|s| s == "plugin")
                && c.dsh_home != config.dsh_home),
            "Uninstall plugin before changing --dsh-home so its old registration can be removed."
        );
    }
    config.validate(&p)?;
    Ok((p, previous, config))
}

pub(crate) fn run(scope: &str, args: Args) -> Result<i32> {
    args.validate_scope(scope)?;
    ensure!(
        cfg!(any(target_os = "linux", target_os = "macos")),
        "Installation requires macOS launchd or Linux systemd user services."
    );
    let p = Paths::new(&prefix(args.value("prefix").map(Path::new))?, scope)?;
    if args.action == "update" {
        let script = p.root.join("release-install.sh");
        ensure!(
            script.is_file(),
            "No release updater in this installation; run the current {scope}/install.sh once to migrate."
        );
        let mut command = Command::new("sh");
        command
            .arg(script)
            .args(["--component", scope, "--prefix"])
            .arg(&p.prefix);
        if let Some(version) = args.value("version") {
            command.args(["--version", version]);
        }
        return crate::exec(command).map(|code| {
            if code == std::process::ExitCode::SUCCESS {
                0
            } else {
                1
            }
        });
    }
    let _lock = if ["status", "logs"].contains(&args.action.as_str()) {
        None
    } else {
        Some(files::DirectoryGuard::lock(&p.root)?)
    };
    if args.action == "install" {
        install::install(scope, &args, &p)?;
        return Ok(0);
    }
    let mut config = Config::read(&p)?;
    if let Some(insecure) = args.tls_insecure() {
        config.tls_insecure = Some(insecure);
    }
    ensure!(
        args.action != "uninstall"
            || args.asset.as_deref() != Some("plugin")
            || config.owns_plugin(),
        "The DSH bundle is externally owned; uninstall it through DSH. The daemon and its service have not been changed."
    );
    service::available()?;
    if args.action == "uninstall" {
        install::uninstall(&args, &config, &p)?;
        return Ok(0);
    }
    ensure!(
        config.installed(),
        "No {scope} installed at {}; install it first.",
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
        _ => bail!("Unknown {scope} management command; use --help."),
    }
    Ok(0)
}

pub(crate) fn help(scope: &str) -> String {
    let specific = if scope == "relay" {
        "  run [--bind <ip:port>] [--client-dir <path>] [--tls-cert <pem>] [--tls-key <pem>]\n  install [client] [--bind <ip:port>] [--client-dir <path>]\n      [--tls-cert <pem>] [--tls-key <pem>] [--tls-server-name <name>] [--ca-cert <pem>]\n  TLS serves HTTPS/WSS; --tls-server-name selects the certificate name for status probes.\n"
    } else {
        r#"  run [--relay <ws(s)-origin>] [--port <port>] [--config <path>] [--plugin-reports] [--local-admin]
  pair [--wait <seconds>] | doctor | devices [--revoke <id>]
  audit|crashes [--clear] | room-key
  install [plugin] [--with-plugin] [--dsh <executable>]
      [--relay <ws(s)-origin>] [--port <port>] [--dsh-home <path>]
      [--state-dir <path>] [--workdir <path>] [--ca-cert <pem>] [--dsh-tls]
      [--plugin-owner daemon|external] [--plugin-reports | --no-plugin-reports]
      [--local-admin | --no-local-admin]
  run --attach <port> [--attach-tls] [--attach-token <token>] [--ca-cert <pem>]
  uninstall plugin
  manage [--prefix <path>]    one bounded JSON request on stdin; one JSON response

  --plugin-owner external leaves the DSH bundle to DSH's package manager.
  --plugin-reports is independent of bundle ownership; old settings remain compatible.
  --local-admin enables authenticated local IPC when daemon next starts (default off).
  First installation installs private DSH 0.2.2-rc.1 and the daemon-owned plugin.
  Automatic DSH installation needs Node >=24.9 and npm; --dsh uses an existing DSH.
  Reinstallation preserves an existing DSH path and plugin ownership/selection.

  --relay uses the supplied ws:// or wss:// origin (for example wss://relay.example.com).
  --ca-cert adds a private CA for HTTPS/WSS (also available on pair and pair-as-device).
  run/pair/pair-as-device accept --insecure or --no-insecure for TLS verification.
  --dsh-tls requires an HTTPS DSH readiness URL and uses HTTPS for service health.
  --dsh selects an existing executable; --workdir selects the startup project directory.
  npm: npm install -g @deepseek-ai/dsh, then --dsh "$(npm prefix -g)/bin/dsh".
  Git clone: run pnpm install and pnpm run build in the DSH checkout, then create
  an executable launcher with an absolute Node path and pass its path to --dsh:
    exec "/absolute/path/to/node" "/path/to/deepseek-harness/apps/cli/lib/bin.js" "$@"
  Full examples: https://github.com/luckyuro/dr.dsh/blob/master/daemon/README.md#dsh-installation-methods

  Optional SSH forwarding (run on the daemon computer; keep SSH running):
    ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
      -L 127.0.0.1:8788:127.0.0.1:8787 user@relay.example.com
  This forwards local port 8788 to the relay on the SSH server's 127.0.0.1:8787.
  Check: curl -fsS http://127.0.0.1:8788/healthz
  Then use --relay ws://127.0.0.1:8788. SSH is managed by you.
  Details: https://github.com/luckyuro/dr.dsh/blob/master/daemon/README.md#optional-ssh-forwarding

"#
    };
    format!(
        "drdsh {scope}\n\n{specific}  install --source <bundle-or-checkout> [--start] [--enable]\n      [--skip-build] [--build-profile release|debug] [--insecure | --no-insecure]\n  update [--version <release-tag>]\n  start|stop|restart|status|enable|disable|uninstall\n  status [--insecure | --no-insecure]\n  logs [--follow]\n\n  --insecure      skip HTTPS/WSS certificate trust, expiry and hostname checks\n  --no-insecure   restore certificate verification (the default)\n  install saves this choice for this component; status overrides it for one probe.\n  DRDSH_TLS_INSECURE=1 (skip) or 0 (verify) applies when no saved/CLI choice exists.\n  TLS encryption remains enabled; browsers, Node plugins and Release downloads are unaffected.\n  --prefix <path>   installation prefix (default ~/.local; saved by installed commands)\n\nNo service starts or gains login autostart unless requested. Updates preserve settings,\nkeys and the other component's process. PWA belongs to relay; daemon owns its plugin by default.\nRelease installation and management do not need Node, pnpm or Rust. DSH itself needs Node.\n"
    )
}
