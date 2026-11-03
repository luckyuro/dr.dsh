//! An explicit transfer of the invoking manual DSH process to a prepared daemon.

use crate::{
    jobs,
    management::{Config, Paths},
    service,
};
use anyhow::{Context as _, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
#[cfg(target_os = "macos")]
use std::process::{Command, Stdio};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const PLAN_LIFETIME_MS: u64 = 5 * 60 * 1000;

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Identity {
    pid: u32,
    parent_pid: u32,
    uid: u32,
    start: String,
    executable: PathBuf,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Plan {
    version: u16,
    plan_id: String,
    created_at_ms: u64,
    expires_at_ms: u64,
    identity: Identity,
    dsh_home: PathBuf,
    port: u16,
    config_digest: String,
    consumed: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Expected {
    port: u16,
    dsh_home: PathBuf,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Selection {
    plan_id: String,
}
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}
fn digest(path: &Path) -> Result<String> {
    Ok(Sha256::digest(fs::read(path).context(
        "Cannot read the saved daemon configuration for handoff; check its ownership and permissions before retrying.",
    )?)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

#[cfg(target_os = "linux")]
fn identity(pid: u32) -> Result<Identity> {
    use std::os::unix::fs::MetadataExt as _;
    let root = PathBuf::from(format!("/proc/{pid}"));
    let stat = fs::read_to_string(root.join("stat")).context(
        "Cannot read the caller process identity; keep the DSH host running and allow same-user process inspection.",
    )?;
    let (_, rest) = stat
        .rsplit_once(") ")
        .context("Cannot read the caller process identity; retry from the DSH management page.")?;
    let fields: Vec<&str> = rest.split_whitespace().collect();
    ensure!(
        fields.len() > 19,
        "The caller process identity is incomplete; retry from the DSH management page."
    );
    Ok(Identity {
        pid,
        parent_pid: fields[1].parse().context("The caller parent identity is invalid; retry from the running DSH host.")?,
        uid: fs::metadata(&root).context("Cannot inspect the caller process owner; retry as the DSH host user.")?.uid(),
        start: fields[19].into(),
        executable: fs::read_link(root.join("exe")).context("Cannot inspect the caller executable; keep DSH running and allow same-user process inspection.")?,
    })
}
#[cfg(target_os = "macos")]
fn identity(pid: u32) -> Result<Identity> {
    let pid_i32 =
        i32::try_from(pid).context("The caller PID is outside the supported process range.")?;
    let info=libproc::proc_pid::pidinfo::<libproc::bsd_info::BSDInfo>(pid_i32,0).map_err(|_|anyhow::anyhow!("The caller process no longer exists or cannot be inspected; return to the running DSH management page."))?;
    let executable = libproc::proc_pid::pidpath(pid_i32).map_err(|_| {
        anyhow::anyhow!(
            "Cannot identify the caller executable; keep the DSH process running and retry."
        )
    })?;
    Ok(Identity {
        pid,
        parent_pid: info.pbi_ppid,
        uid: info.pbi_uid,
        start: format!("{}:{}", info.pbi_start_tvsec, info.pbi_start_tvusec),
        executable: PathBuf::from(executable),
    })
}
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn identity(_: u32) -> Result<Identity> {
    bail!("Initial DSH handoff requires Linux or macOS.")
}

#[cfg(target_os = "linux")]
fn process_details(pid: u32) -> Result<(String, BTreeMap<String, String>)> {
    let args = fs::read(format!("/proc/{pid}/cmdline")).context(
        "Cannot read the DSH startup arguments; keep its process running and allow same-user process inspection.",
    )?;
    let environment = fs::read(format!("/proc/{pid}/environ")).context(
        "Cannot read the DSH startup environment; allow same-user process inspection and retry from the same running DSH host.",
    )?;
    ensure!(
        args.len() + environment.len() <= 2 * 1024 * 1024,
        "The DSH process metadata exceeds its inspection bound; use a shorter startup environment."
    );
    let environment = environment
        .split(|b| *b == 0)
        .filter_map(|part| {
            std::str::from_utf8(part)
                .ok()?
                .split_once('=')
                .map(|(k, v)| (k.to_owned(), v.to_owned()))
        })
        .collect();
    let entry = args
        .split(|byte| *byte == 0)
        .nth(1)
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
        .map(PathBuf::from)
        .and_then(|path| {
            let path = if path.is_absolute() {
                path
            } else {
                fs::read_link(format!("/proc/{pid}/cwd")).ok()?.join(path)
            };
            fs::canonicalize(path).ok()
        })
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok((entry, environment))
}
#[cfg(target_os = "macos")]
fn process_details(pid: u32) -> Result<(String, BTreeMap<String, String>)> {
    use std::os::unix::ffi::OsStrExt as _;
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

    let pid = Pid::from_u32(pid);
    let mut system = System::new();
    // ps flattens argv and environment into one ambiguous string. Kernel argument
    // boundaries preserve spaces and ensure an environment value cannot name DSH.
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing()
            .without_tasks()
            .with_cmd(UpdateKind::Always)
            .with_environ(UpdateKind::Always)
            .with_cwd(UpdateKind::Always),
    );
    let process = system.process(pid).context(
        "Cannot inspect the DSH startup identity; keep it running and retry as the same user.",
    )?;
    ensure!(
        process
            .cmd()
            .iter()
            .chain(process.environ())
            .map(|value| value.as_bytes().len())
            .sum::<usize>()
            <= 2 * 1024 * 1024,
        "The DSH process metadata exceeds its inspection bound; use a shorter startup environment."
    );
    ensure!(
        !process.cmd().is_empty() && !process.environ().is_empty(),
        "Cannot inspect the DSH startup arguments or environment; allow same-user process inspection and retry from the running DSH host."
    );
    let mut environment = BTreeMap::new();
    for variable in process.environ() {
        let bytes = variable.as_bytes();
        let Some(separator) = bytes.iter().position(|byte| *byte == b'=') else {
            continue;
        };
        let (key, value) = (&bytes[..separator], &bytes[separator + 1..]);
        if matches!(key, b"HOME" | b"DSH_HOME" | b"DRDSH_MANAGED_INSTANCE") {
            let key = std::str::from_utf8(key)?;
            let value = std::str::from_utf8(value)
                .context("The DSH startup home is not UTF-8; restart DSH with a UTF-8 DSH_HOME.")?;
            environment.insert(key.to_owned(), value.to_owned());
        }
    }
    let entry = process
        .cmd()
        .get(1)
        .map(PathBuf::from)
        .and_then(|path| {
            let path = if path.is_absolute() {
                path
            } else {
                process.cwd()?.join(path)
            };
            fs::canonicalize(path).ok()
        })
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok((entry, environment))
}
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn process_details(_: u32) -> Result<(String, BTreeMap<String, String>)> {
    bail!("Initial DSH handoff requires Linux or macOS.")
}

fn dsh_process(identity: &Identity, command: &str) -> bool {
    matches!(
        identity.executable.file_name().and_then(|v| v.to_str()),
        Some("node" | "nodejs")
    ) && (command.contains("@deepseek-ai/dsh/")
        || command.contains("deepseek-harness/apps/cli/lib/")
        || command.contains("/apps/cli/lib/bin.js"))
}
fn home(environment: &BTreeMap<String, String>) -> Result<PathBuf> {
    let path=match environment.get("DSH_HOME"){
        Some(value)=>PathBuf::from(value),
        None=>PathBuf::from(environment.get("HOME").context("Cannot establish the DSH home from its startup environment; set DSH_HOME explicitly and restart DSH before handoff.")?).join(".dsh"),
    };
    ensure!(
        path.is_absolute(),
        "DSH_HOME must be an absolute path for safe handoff; restart DSH with an absolute DSH_HOME."
    );
    fs::canonicalize(path)
        .context("The DSH home is missing; restore it before handing the process to daemon.")
}
fn ancestor(target: Option<u32>) -> Result<Identity> {
    let mut pid = rustix::process::getppid()
        .map(|p| p.as_raw_nonzero().get() as u32)
        .context(
            "Cannot identify the invoking process; open handoff from the DSH management page.",
        )?;
    for _ in 0..32 {
        if pid <= 1 {
            break;
        }
        let current = identity(pid).context("Cannot inspect the invoking process ancestry; open handoff from the same live DSH page.")?;
        ensure!(
            current.uid == rustix::process::geteuid().as_raw(),
            "The invoking process is owned by another user; handoff is refused."
        );
        if matches!(
            current
                .executable
                .file_name()
                .and_then(|value| value.to_str()),
            Some("node" | "nodejs")
        ) {
            let (command, _) = process_details(pid).context("Cannot inspect the DSH caller's startup identity; keep it running and retry handoff.")?;
            if target.is_none_or(|t| t == pid) && dsh_process(&current, &command) {
                return Ok(current);
            }
        }
        pid = current.parent_pid;
    }
    bail!(
        "No exact DSH Node process exists in this client's ancestor chain. Open handoff from the plugin page in the manual DSH instance; arbitrary process IDs are not accepted."
    )
}

#[cfg(target_os = "linux")]
fn owns_port(pid: u32, port: u16) -> Result<bool> {
    let mut inodes = std::collections::HashSet::new();
    for entry in fs::read_dir(format!("/proc/{pid}/fd")).context(
        "Cannot inspect the DSH listening sockets; allow same-user process inspection before handoff.",
    )? {
        if let Ok(target) = fs::read_link(entry.context("Cannot inspect a DSH socket descriptor; keep the process running and retry handoff.")?.path())
            && let Some(inode) = target
                .to_str()
                .and_then(|s| s.strip_prefix("socket:["))
                .and_then(|s| s.strip_suffix(']'))
        {
            inodes.insert(inode.to_owned());
        }
    }
    for file in ["tcp", "tcp6"] {
        let content = fs::read_to_string(format!("/proc/{pid}/net/{file}")).context(
            "Cannot inspect the DSH TCP listeners; keep its process running and allow same-user network inspection.",
        )?;
        for line in content.lines().skip(1) {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 10 || fields[3] != "0A" || !inodes.contains(fields[9]) {
                continue;
            }
            if let Some((address, number)) = fields[1].split_once(':')
                && u16::from_str_radix(number, 16).ok() == Some(port)
            {
                return Ok(matches!(
                    address,
                    "0100007F" | "00000000000000000000000001000000"
                ));
            }
        }
    }
    Ok(false)
}
#[cfg(target_os = "macos")]
fn owns_port(pid: u32, port: u16) -> Result<bool> {
    let output = Command::new("/usr/sbin/lsof")
        .args([
            "-nP",
            "-a",
            "-p",
            &pid.to_string(),
            &format!("-iTCP:{port}"),
            "-sTCP:LISTEN",
            "-Fpn",
        ])
        .stdin(Stdio::null())
        .output().context("Cannot run the macOS socket inspector; restore /usr/sbin/lsof before retrying handoff.")?;
    if !output.status.success() {
        return Ok(false);
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(text.lines().any(|line| line == format!("p{pid}"))
        && text
            .lines()
            .any(|line| line == format!("n127.0.0.1:{port}") || line == format!("n[::1]:{port}")))
}
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn owns_port(_: u32, _: u16) -> Result<bool> {
    Ok(false)
}

fn plans(p: &Paths) -> Result<PathBuf> {
    let path = jobs::root(p)?.join("handoff-plans");
    jobs::private_directory(&path)?;
    Ok(path)
}
fn selection(params: &Value) -> Result<Selection> {
    let selected: Selection = serde_json::from_value(params.clone())
        .context("handoff requires only the planId returned by handoff.plan.")?;
    ensure!(
        selected.plan_id.len() == 32
            && selected
                .plan_id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "planId is not a handoff plan identifier."
    );
    Ok(selected)
}
fn load(p: &Paths, params: &Value) -> Result<(PathBuf, Plan)> {
    let selected = selection(params)?;
    let path = plans(p)?.join(format!("{}.json", selected.plan_id));
    let plan: Plan = jobs::read_record(&path)?;
    ensure!(
        plan.version == 1
            && plan.plan_id == selected.plan_id
            && !plan.consumed
            && now_ms() <= plan.expires_at_ms,
        "This handoff plan was used or expired; inspect the running DSH host and create a new plan."
    );
    Ok((path, plan))
}
fn prepared(p: &Paths, home: &Path, port: u16) -> Result<Config> {
    let config = Config::read(p)?;
    ensure!(
        config.installed() && config.local_admin_enabled == Some(true),
        "Install daemon with local management enabled before preparing handoff."
    );
    ensure!(
        config.port == Some(port)
            && config
                .dsh_home
                .as_deref()
                .and_then(|path| fs::canonicalize(path).ok())
                .as_deref()
                == Some(home),
        "Saved daemon port and DSH home do not match this manual DSH host; correct config before handoff."
    );
    ensure!(
        !service::state(p)?.running,
        "This daemon service is already running; manage that instance rather than transferring an unrelated manual DSH host."
    );
    Ok(config)
}
fn verify(p: &Paths, plan: &Plan) -> Result<Config> {
    ensure!(
        identity(plan.identity.pid)? == plan.identity,
        "The planned DSH process has exited or its identity changed; no process was stopped. Create a new handoff plan from the running host."
    );
    let (command, environment) = process_details(plan.identity.pid)?;
    ensure!(
        dsh_process(&plan.identity, &command)
            && !environment.contains_key("DRDSH_MANAGED_INSTANCE"),
        "The planned process is not a manual DSH host; use the existing daemon lifecycle controls."
    );
    ensure!(
        home(&environment)? == plan.dsh_home && owns_port(plan.identity.pid, plan.port)?,
        "The planned DSH home or listening port changed; no process was stopped. Create a new handoff plan."
    );
    ensure!(
        digest(&p.config)? == plan.config_digest,
        "Daemon configuration changed after handoff was planned; review it and create a new plan."
    );
    prepared(p, &plan.dsh_home, plan.port)
}

pub(crate) fn plan(p: &Paths, params: &Value) -> Result<Value> {
    let expected: Expected = serde_json::from_value(params.clone())
        .context("handoff.plan requires only port and dshHome.")?;
    ensure!(
        expected.port > 0 && expected.dsh_home.is_absolute(),
        "Handoff needs a nonzero port and absolute DSH home."
    );
    let expected_home = fs::canonicalize(&expected.dsh_home)
        .context("The requested DSH home does not exist; select the current profile home.")?;
    let caller = ancestor(None)?;
    let (_, environment) = process_details(caller.pid)?;
    ensure!(
        !environment.contains_key("DRDSH_MANAGED_INSTANCE"),
        "This DSH host is already managed; use lifecycle.restart or service.restart."
    );
    ensure!(
        home(&environment)? == expected_home,
        "The expected DSH home differs from the invoking host's startup environment; select its actual profile home."
    );
    ensure!(
        owns_port(caller.pid, expected.port)?,
        "The invoking DSH process does not own the expected loopback listener; check the page's actual port before handoff."
    );
    prepared(p, &expected_home, expected.port)?;
    let plan = Plan {
        version: 1,
        plan_id: format!("{:032x}", rand::random::<u128>()),
        created_at_ms: now_ms(),
        expires_at_ms: now_ms() + PLAN_LIFETIME_MS,
        identity: caller,
        dsh_home: expected_home,
        port: expected.port,
        config_digest: digest(&p.config)?,
        consumed: false,
    };
    jobs::save_record(&plans(p)?.join(format!("{}.json", plan.plan_id)), &plan)?;
    Ok(
        json!({"planId":plan.plan_id,"pid":plan.identity.pid,"port":plan.port,"dshHome":plan.dsh_home,"expiresAtMs":plan.expires_at_ms,"requiresRestart":true}),
    )
}

pub(crate) fn validate_submission(p: &Paths, params: &Value) -> Result<()> {
    let (_, plan) = load(p, params)?;
    ensure!(
        ancestor(Some(plan.identity.pid))? == plan.identity,
        "Handoff must be submitted by the same DSH host that created the plan."
    );
    verify(p, &plan)?;
    Ok(())
}

pub(crate) fn execute(p: &Paths, params: &Value) -> Result<Value> {
    let _operation = crate::files::DirectoryGuard::lock(&p.root)?;
    let (path, mut plan) = load(p, params)?;
    let config = verify(p, &plan)?;
    // Opening a pidfd before the final identity check makes Linux signaling immune
    // to PID reuse. macOS verifies its microsecond start identity immediately before TERM.
    let pid = rustix::process::Pid::from_raw(i32::try_from(plan.identity.pid)?)
        .context("Invalid planned DSH process identifier.")?;
    #[cfg(target_os="linux")]
    let process=rustix::process::pidfd_open(pid,rustix::process::PidfdFlags::empty()).context("The kernel cannot pin the planned DSH process; handoff was refused before sending any signal.")?;
    std::thread::sleep(Duration::from_millis(750));
    verify(p, &plan)?;
    plan.consumed = true;
    jobs::save_record(&path, &plan)?;
    #[cfg(target_os = "linux")]
    rustix::process::pidfd_send_signal(&process, rustix::process::Signal::TERM)
        .context("Cannot stop the planned DSH host; check same-user process permissions and inspect its state before retrying handoff.")?;
    #[cfg(target_os = "macos")]
    rustix::process::kill_process(pid, rustix::process::Signal::TERM)
        .context("Cannot stop the planned DSH host; check same-user process permissions and inspect its state before retrying handoff.")?;
    let deadline = Instant::now() + Duration::from_secs(35);
    loop {
        match identity(plan.identity.pid) {
            Ok(current) if current == plan.identity => {}
            _ => break,
        }
        ensure!(
            Instant::now() < deadline,
            "The exact DSH host did not exit within 35 seconds after TERM. No forced kill or unrelated process termination was attempted; close that host and start daemon explicitly."
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    let port=std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST,plan.port)).context("Another process now occupies the DSH port; it was not stopped. Resolve the port conflict, then start daemon.")?;
    drop(port);
    service::start(&config, p)?;
    Ok(
        json!({"completed":true,"handoff":true,"previousPid":plan.identity.pid,"port":plan.port,"dshHome":plan.dsh_home}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn client_cannot_supply_a_pid_instead_of_a_plan() {
        assert!(selection(&json!({"pid":1234})).is_err());
        assert!(selection(&json!({"planId":"../../outside"})).is_err());
    }
    #[test]
    fn process_identity_reads_the_actual_current_process() -> Result<()> {
        let value = identity(std::process::id())?;
        assert_eq!(value.pid, std::process::id());
        assert_eq!(value.uid, rustix::process::geteuid().as_raw());
        assert!(!value.start.is_empty());
        assert!(value.executable.is_absolute());
        Ok(())
    }
    #[test]
    fn ordinary_node_is_not_assumed_to_be_dsh() {
        let identity = Identity {
            pid: 123,
            parent_pid: 1,
            uid: 1,
            start: "123".into(),
            executable: PathBuf::from("/usr/bin/node"),
        };
        assert!(!dsh_process(&identity, "node /tmp/app.js"));
        assert!(dsh_process(
            &identity,
            "node /home/a/node_modules/@deepseek-ai/dsh/lib/bin.js"
        ));
    }
    #[cfg(unix)]
    #[test]
    fn process_details_preserve_argument_and_environment_boundaries() -> Result<()> {
        use std::os::unix::fs::symlink;
        use std::process::{Command, Stdio};

        let directory = tempfile::tempdir()?;
        let script = directory.path().join("space dir/ordinary.js");
        fs::create_dir_all(script.parent().context("missing script parent")?)?;
        fs::write(&script, "process.stdin.resume();\n")?;
        symlink(&script, directory.path().join("entry link"))?;
        let expected_home = directory.path().join("profile DSH_HOME=literal");
        let mut child = Command::new("node")
            .arg("entry link")
            .current_dir(directory.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", directory.path())
            .env("DSH_HOME", &expected_home)
            .env(
                "UNRELATED",
                "value DRDSH_MANAGED_INSTANCE=forged @deepseek-ai/dsh/lib/bin.js",
            )
            .spawn()
            .context("This process-boundary test needs Node on PATH, as does DSH.")?;
        let details = process_details(child.id());
        let _ = child.kill();
        let _ = child.wait();
        let (entry, environment) = details?;
        assert_eq!(PathBuf::from(&entry), fs::canonicalize(script)?);
        assert_eq!(
            environment.get("DSH_HOME"),
            Some(&expected_home.to_string_lossy().into_owned())
        );
        assert!(!environment.contains_key("DRDSH_MANAGED_INSTANCE"));
        assert!(!dsh_process(
            &Identity {
                pid: 123,
                parent_pid: 1,
                uid: 1,
                start: "123".into(),
                executable: PathBuf::from("/usr/bin/node"),
            },
            &entry
        ));
        Ok(())
    }
}
