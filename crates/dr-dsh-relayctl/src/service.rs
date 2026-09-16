//! System-owned relay processes; compatible with the former Node service identities.

use crate::{Config, Paths, absolute, files};
use anyhow::{Context, Result, bail, ensure};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const MAC: bool = cfg!(target_os = "macos");

pub(crate) struct Spec {
    name: String,
    pub(crate) file: PathBuf,
    log: PathBuf,
}

pub(crate) struct State {
    loaded: bool,
    pub(crate) running: bool,
    failed: bool,
    pid: Option<u32>,
    detail: String,
}

pub(crate) fn command(program: &str, args: &[&str]) -> Result<String> {
    let output = capture(program, args)?;
    ensure!(
        output.status.success(),
        "{program} failed: {}. Check the command and your user service session.",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn capture(program: &str, args: &[&str]) -> Result<Output> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| {
            format!("Cannot run {program}; install it and check the relay server PATH.")
        })?;
    let stdout = child
        .stdout
        .take()
        .context("Cannot capture service command output.")?;
    let stderr = child
        .stderr
        .take()
        .context("Cannot capture service command errors.")?;
    // Drain both pipes while waiting: launchctl print can exceed a pipe's capacity.
    let read_pipe = |mut pipe: Box<dyn Read + Send>| {
        let mut bytes = Vec::new();
        pipe.read_to_end(&mut bytes).map(|_| bytes)
    };
    let out = thread::spawn(move || read_pipe(Box::new(stdout)));
    let err = thread::spawn(move || read_pipe(Box::new(stderr)));
    let deadline = Instant::now() + Duration::from_secs(45);
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!(
                "{program} timed out; inspect your user service session before retrying the relay command."
            );
        }
        thread::sleep(Duration::from_millis(25));
    };
    Ok(Output {
        status,
        stdout: out.join().map_err(|_| {
            anyhow::anyhow!("Cannot read service output; retry the relay command.")
        })??,
        stderr: err.join().map_err(|_| {
            anyhow::anyhow!("Cannot read service errors; retry the relay command.")
        })??,
    })
}

fn gui() -> Result<String> {
    Ok(format!("gui/{}", command("/usr/bin/id", &["-u"])?.trim()))
}
fn target(s: &Spec) -> Result<String> {
    Ok(format!("{}/{}", gui()?, s.name))
}

pub(crate) fn available() -> Result<()> {
    if MAC {
        command("launchctl", &["print", &gui()?])?;
    } else {
        command("systemctl", &["--user", "show-environment"])?;
        command("/usr/bin/env", &["--chdir", "/", "/bin/true"])?;
    }
    Ok(())
}

fn spec_for(p: &Paths, mac: bool) -> Spec {
    let suffix: String = Sha256::digest(p.root.to_string_lossy().as_bytes())
        .iter()
        .take(6)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let name = if mac {
        format!("dev.drdsh.relay.{suffix}")
    } else {
        format!("drdsh-relay-{suffix}.service")
    };
    let filename = if mac {
        format!("{name}.plist")
    } else {
        name.clone()
    };
    Spec {
        name,
        file: p.root.join("services").join(filename),
        log: p.root.join("logs/relay.log"),
    }
}

fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn systemd_quote(s: &str) -> String {
    format!(
        "\"{}\"",
        s.replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
            .replace('\n', "\\n")
            .replace('\r', "\\r")
            .replace('\t', "\\t")
    )
}

fn render(c: &Config, p: &Paths, mac: bool) -> String {
    let s = spec_for(p, mac);
    let binary = p.bin.join("drdsh-relay");
    let client = p.root.join("client");
    let env = [
        ("RUST_LOG", "info".to_owned()),
        ("DSH_RELAY_BIND", c.bind.clone()),
        (
            "DSH_RELAY_CLIENT_DIR",
            client.to_string_lossy().into_owned(),
        ),
    ];
    if mac {
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n<key>Label</key><string>{}</string>\n<key>ProgramArguments</key><array><string>{}</string></array>\n<key>WorkingDirectory</key><string>{}</string>\n<key>EnvironmentVariables</key><dict>{}</dict>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>5</integer>\n<key>ExitTimeOut</key><integer>35</integer>\n<key>Umask</key><integer>63</integer>\n<key>StandardOutPath</key><string>{}</string>\n<key>StandardErrorPath</key><string>{}</string>\n</dict></plist>\n",
            xml(&s.name),
            xml(&binary.to_string_lossy()),
            xml(&p.root.to_string_lossy()),
            env.iter()
                .map(|(k, v)| format!("<key>{k}</key><string>{}</string>", xml(v)))
                .collect::<String>(),
            xml(&s.log.to_string_lossy()),
            xml(&s.log.to_string_lossy())
        )
    } else {
        let args = [
            "--chdir".to_owned(),
            p.root.to_string_lossy().into_owned(),
            "--".to_owned(),
            binary.to_string_lossy().into_owned(),
        ];
        format!(
            "[Unit]\nDescription=dr.dsh relay\nAfter=network-online.target\nStartLimitIntervalSec=60\nStartLimitBurst=5\n\n[Service]\nType=simple\nExecStart=:/usr/bin/env {}\n{}\nRestart=on-failure\nRestartSec=5\nKillMode=mixed\nTimeoutStopSec=35\nUMask=0077\nStandardOutput=journal\nStandardError=journal\n\n[Install]\nWantedBy=default.target\n",
            args.iter()
                .map(|s| systemd_quote(s))
                .collect::<Vec<_>>()
                .join(" "),
            env.iter()
                .map(|(k, v)| format!("Environment={}", systemd_quote(&format!("{k}={v}"))))
                .collect::<Vec<_>>()
                .join("\n")
        )
    }
}

pub(crate) fn prepare(c: &Config, p: &Paths) -> Result<Spec> {
    let s = spec_for(p, MAC);
    files::mkdir(&p.root.join("logs"))?;
    if !s.log.exists() {
        files::atomic_write(&s.log, b"", 0o600)?;
    }
    files::atomic_write(&s.file, render(c, p, MAC).as_bytes(), 0o600)?;
    Ok(s)
}

pub(crate) fn state(p: &Paths) -> Result<State> {
    let s = spec_for(p, MAC);
    if MAC {
        let out = capture("launchctl", &["print", &target(&s)?])?;
        let text = String::from_utf8_lossy(&out.stdout);
        let pid = text
            .lines()
            .find_map(|line| {
                line.trim()
                    .strip_prefix("pid = ")
                    .and_then(|s| s.parse::<u32>().ok())
            })
            .filter(|pid| *pid != 0);
        return Ok(State {
            loaded: out.status.success(),
            running: pid.is_some(),
            failed: false,
            pid,
            detail: pid.map_or_else(
                || {
                    if out.status.success() {
                        "loaded, no running process; inspect logs".into()
                    } else {
                        "stopped".into()
                    }
                },
                |pid| format!("running (pid {pid})"),
            ),
        });
    }
    let out = capture(
        "systemctl",
        &[
            "--user",
            "show",
            &s.name,
            "--property=ActiveState,MainPID,LoadState",
        ],
    )?;
    let text = String::from_utf8_lossy(&out.stdout);
    let value = |key: &str| text.lines().find_map(|line| line.strip_prefix(key));
    let load = value("LoadState=")
        .context("Cannot read relay LoadState; check systemctl --user and your login session.")?;
    let active = value("ActiveState=")
        .context("Cannot read relay ActiveState; check systemctl --user and your login session.")?;
    ensure!(
        out.status.success() || load == "not-found",
        "Cannot read relay service state: {}; check systemctl --user.",
        String::from_utf8_lossy(&out.stderr)
    );
    let pid = value("MainPID=")
        .and_then(|s| s.parse::<u32>().ok())
        .filter(|pid| *pid != 0);
    Ok(State {
        loaded: load == "loaded",
        running: active == "active" && pid.is_some(),
        failed: active == "failed",
        pid,
        detail: format!(
            "{active}{}",
            pid.map_or_else(String::new, |p| format!(" (pid {p})"))
        ),
    })
}

pub(crate) fn stop(_c: &Config, p: &Paths) -> Result<()> {
    let s = spec_for(p, MAC);
    let before = state(p)?;
    if MAC {
        if before.loaded {
            command("launchctl", &["bootout", &target(&s)?])?;
        }
        if let Some(pid) = before.pid {
            let deadline = Instant::now() + Duration::from_secs(40);
            while capture("/bin/kill", &["-0", &pid.to_string()])?
                .status
                .success()
            {
                ensure!(
                    Instant::now() < deadline,
                    "Relay has not stopped; inspect drdsh-relayctl logs before restarting."
                );
                thread::sleep(Duration::from_millis(100));
            }
        }
    } else if before.loaded || before.running {
        command("systemctl", &["--user", "stop", &s.name])?;
    }
    println!("relay: stopped");
    Ok(())
}

pub(crate) fn start(c: &Config, p: &Paths) -> Result<()> {
    let s = prepare(c, p)?;
    let before = state(p)?;
    if before.running {
        println!("relay: already {}", before.detail);
        return Ok(());
    }
    if MAC {
        if before.loaded {
            command("launchctl", &["bootout", &target(&s)?])?;
        }
        command("launchctl", &["enable", &target(&s)?])?;
        command(
            "launchctl",
            &["bootstrap", &gui()?, &s.file.to_string_lossy()],
        )?;
    } else {
        command("systemctl", &["--user", "link", &s.file.to_string_lossy()])?;
        command("systemctl", &["--user", "daemon-reload"])?;
        if before.failed {
            command("systemctl", &["--user", "reset-failed", &s.name])?;
        }
        command("systemctl", &["--user", "start", &s.name])?;
    }
    thread::sleep(Duration::from_secs(1));
    let after = state(p)?;
    ensure!(
        after.running,
        "Relay did not stay running; run drdsh-relayctl logs to see the startup failure."
    );
    println!(
        "relay: {}; use drdsh-relayctl status to check readiness",
        after.detail
    );
    Ok(())
}

pub(crate) fn autostart(c: &Config, p: &Paths, enabled: bool) -> Result<()> {
    let s = prepare(c, p)?;
    if MAC {
        let home = std::env::var_os("HOME").context(
            "HOME is unavailable; set it to your login home before managing relay autostart.",
        )?;
        let link = PathBuf::from(home)
            .join("Library/LaunchAgents")
            .join(format!("{}.plist", s.name));
        files::mkdir(link.parent().context("LaunchAgent link has no parent.")?)?;
        let present = match fs::symlink_metadata(&link) {
            Ok(m) => {
                ensure!(
                    m.is_symlink()
                        && absolute(
                            &link
                                .parent()
                                .context("Invalid LaunchAgent path.")?
                                .join(fs::read_link(&link)?)
                        )? == s.file,
                    "Refusing to replace unrelated LaunchAgent {}; move it manually before retrying relay autostart.",
                    link.display()
                );
                true
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(e) => {
                return Err(e).context("Cannot inspect relay LaunchAgent; check its permissions.");
            }
        };
        #[cfg(unix)]
        if enabled && !present {
            std::os::unix::fs::symlink(&s.file, &link)?;
        }
        if !enabled && present {
            fs::remove_file(link)?;
        }
        if enabled {
            command("launchctl", &["enable", &target(&s)?])?;
        }
    } else {
        if enabled {
            command(
                "systemctl",
                &["--user", "enable", &s.file.to_string_lossy()],
            )?;
        } else if state(p)?.loaded {
            command("systemctl", &["--user", "disable", &s.name])?;
        }
        command("systemctl", &["--user", "daemon-reload"])?;
    }
    println!(
        "relay: login autostart {}",
        if enabled { "enabled" } else { "disabled" }
    );
    Ok(())
}

fn health(bind: &str) -> Result<bool> {
    let mut addr: SocketAddr = bind.parse()?;
    if addr.ip().is_unspecified() {
        addr.set_ip(if addr.is_ipv4() {
            IpAddr::V4(Ipv4Addr::LOCALHOST)
        } else {
            IpAddr::V6(Ipv6Addr::LOCALHOST)
        });
    }
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2))?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    write!(
        stream,
        "GET /healthz HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n"
    )?;
    let mut line = String::new();
    BufReader::new(stream.take(4096)).read_line(&mut line)?;
    Ok(line
        .split_whitespace()
        .nth(1)
        .is_some_and(|s| s.parse::<u16>().is_ok_and(|n| (200..300).contains(&n))))
}

pub(crate) fn status(c: &Config, p: &Paths) -> Result<i32> {
    let state = state(p)?;
    println!("relay: {}", state.detail);
    if !state.running {
        return Ok(1);
    }
    if health(&c.bind).unwrap_or(false) {
        println!("  relay health: responding");
        Ok(0)
    } else {
        println!("  relay HTTP: not responding; inspect drdsh-relayctl logs");
        Ok(1)
    }
}

pub(crate) fn logs(_c: &Config, p: &Paths, follow: bool) -> Result<()> {
    let s = spec_for(p, MAC);
    let mut child = if MAC {
        if !s.log.exists() {
            println!("No relay logs yet; start the service first.");
            return Ok(());
        }
        let mut c = Command::new("tail");
        c.args(["-n", "100"]);
        if follow {
            c.arg("-F");
        }
        c.arg(s.log);
        c
    } else {
        let mut c = Command::new("journalctl");
        c.args([
            "--user",
            "-u",
            &s.name,
            "-n",
            "100",
            if follow { "-f" } else { "--no-pager" },
        ]);
        c
    };
    ensure!(
        child
            .status()
            .context("Cannot read relay logs; check tail/journalctl and the user service session.")?
            .success(),
        "Relay log command failed; check file permissions or journal access."
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn service_formats_preserve_literal_paths_and_only_relay_environment() -> Result<()> {
        let p = Paths::new(Path::new("/tmp/space & % $literal \"double\" 'single'"))?;
        let c = Config {
            version: 1,
            prefix: p.prefix.clone(),
            scope: "relay".into(),
            source: PathBuf::from("/src"),
            bind: "127.0.0.1:8787".into(),
            components: vec!["relay".into(), "client".into()],
            client_dir: None,
            build_profile: None,
        };
        let linux = render(&c, &p, false);
        assert!(linux.contains("ExecStart=:/usr/bin/env \"--chdir\""));
        assert!(linux.contains("%% $literal \\\"double\\\" 'single'"));
        assert!(linux.contains("DSH_RELAY_CLIENT_DIR="));
        let mac = render(&c, &p, true);
        assert!(mac.contains("&amp; % $literal &quot;double&quot; &apos;single&apos;"));
        for output in [linux, mac] {
            assert!(!output.contains("node"));
            assert!(!output.contains("DSHD_"));
        }
        Ok(())
    }
}
