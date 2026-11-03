//! Durable local operations owned by the user's service manager, not by DSH.

use crate::{
    files, manage,
    management::{Config, Paths},
    service,
};
use anyhow::{Context as _, Result, bail, ensure};
use dr_dsh_daemon::admin::{Request, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Read as _,
    path::{Path, PathBuf},
    process::{Command, ExitCode, Stdio},
    time::{Duration, Instant},
};

const RECORD_LIMIT: u64 = 256 * 1024;
const HISTORY_LIMIT: usize = 64;
const ACTIVE_STATES: &[&str] = &["queued", "running"];
const OPERATIONS: &[&str] = &[
    "install",
    "update",
    "uninstall",
    "service.start",
    "service.stop",
    "service.restart",
    "service.enable",
    "service.disable",
    "lifecycle.stop",
    "lifecycle.restart",
    "handoff",
];

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Spec {
    version: u16,
    prefix: PathBuf,
    job_id: String,
    operation: String,
    params: Value,
    idempotency_key: Option<String>,
    original_params: Value,
    executor: PathBuf,
    environment: BTreeMap<String, String>,
    nonce: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Job {
    job_id: String,
    operation: String,
    state: String,
    created_at_ms: u64,
    started_at_ms: Option<u64>,
    finished_at_ms: Option<u64>,
    worker_pid: Option<u32>,
    exit_code: Option<i32>,
    result: Option<Value>,
    error: Option<Value>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}
fn id() -> String {
    format!("{:032x}", rand::random::<u128>())
}
fn valid_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn active(job: &Job) -> bool {
    ACTIVE_STATES.contains(&job.state.as_str())
}

pub(crate) fn private_directory(path: &Path) -> Result<()> {
    files::mkdir(path)?;
    check_private_directory(path)
}

fn check_private_directory(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "The job directory must be a real private directory; repair its location before retrying."
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        ensure!(
            metadata.uid() == rustix::process::geteuid().as_raw()
                && metadata.mode() & 0o777 == 0o700,
            "The job directory must belong to this user and have mode 0700; repair its permissions before retrying."
        );
    }
    Ok(())
}

pub(crate) fn root(p: &Paths) -> Result<PathBuf> {
    let root = p.prefix.join("var/lib/dr.dsh/jobs");
    private_directory(&root)?;
    fs::canonicalize(root)
        .context("Cannot resolve the private job directory; check prefix permissions.")
}

pub(crate) fn read_record<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    #[cfg(unix)]
    let file = {
        use rustix::fs::{Mode, OFlags};
        fs::File::from(rustix::fs::open(
            path,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
            Mode::empty(),
        )?)
    };
    #[cfg(not(unix))]
    let file = fs::File::open(path)?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file() && metadata.len() <= RECORD_LIMIT,
        "The local job record is not a bounded regular file; inspect the job directory before retrying."
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        ensure!(
            metadata.uid() == rustix::process::geteuid().as_raw()
                && metadata.mode() & 0o777 == 0o600
                && metadata.nlink() == 1,
            "The local job record must be owned by this user, mode 0600, and have one link; repair its permissions."
        );
    }
    let mut bytes = Vec::new();
    file.take(RECORD_LIMIT + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= RECORD_LIMIT,
        "The local job record exceeds its size limit; inspect the job directory."
    );
    serde_json::from_slice(&bytes).context("The local job record is damaged or from an incompatible version; inspect the job directory.")
}

pub(crate) fn save_record(path: &Path, value: &impl Serialize) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    ensure!(
        bytes.len() as u64 <= RECORD_LIMIT,
        "The local job record exceeds its size limit; reduce operation metadata."
    );
    files::atomic_write(path, &bytes, 0o600)?;
    fs::File::open(
        path.parent()
            .context("The job record has no parent directory.")?,
    )?
    .sync_all()?;
    Ok(())
}

#[cfg(unix)]
struct Lease {
    _file: std::os::fd::OwnedFd,
}
#[cfg(unix)]
fn lease(root: &Path) -> Result<Option<Lease>> {
    use rustix::fs::{FlockOperation, Mode, OFlags};
    let file = rustix::fs::open(
        root.join(".instance-lock"),
        OFlags::RDWR | OFlags::CREATE | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::RUSR | Mode::WUSR,
    )?;
    let stat = rustix::fs::fstat(&file)?;
    ensure!(
        stat.st_uid == rustix::process::geteuid().as_raw()
            && stat.st_mode & 0o777 == 0o600
            && stat.st_nlink == 1
            && rustix::fs::FileType::from_raw_mode(stat.st_mode)
                == rustix::fs::FileType::RegularFile,
        "The job operation lock is not a private owned regular file; inspect the job directory."
    );
    match rustix::fs::flock(&file, FlockOperation::NonBlockingLockExclusive) {
        Ok(()) => Ok(Some(Lease { _file: file })),
        Err(rustix::io::Errno::WOULDBLOCK) => Ok(None),
        Err(error) => Err(error.into()),
    }
}
#[cfg(not(unix))]
fn lease(_: &Path) -> Result<Option<()>> {
    bail!("Independent jobs require macOS launchd or Linux systemd user services.")
}

fn label(root: &Path, job_id: &str) -> String {
    let digest = Sha256::digest(root.as_os_str().to_string_lossy().as_bytes());
    let prefix: String = digest[..6].iter().map(|b| format!("{b:02x}")).collect();
    format!("dev.drdsh.job.{prefix}.{job_id}")
}
fn environment() -> BTreeMap<String, String> {
    [
        "HOME",
        "PATH",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_RUNTIME_DIR",
        "DBUS_SESSION_BUS_ADDRESS",
        "CURL_CA_BUNDLE",
        "DRDSH_RELEASE_BASE_URL",
    ]
    .into_iter()
    .filter_map(|key| {
        std::env::var(key)
            .ok()
            .filter(|v| !v.contains(['\0', '\r', '\n']) && v.len() < 16384)
            .map(|value| (key.into(), value))
    })
    .chain([("DRDSH_BANNER_SHOWN".into(), "1".into())])
    .collect()
}
fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
fn launchd_plist(root: &Path, directory: &Path, spec: &Spec) -> String {
    let arguments = [
        directory.join("runner").to_string_lossy().into_owned(),
        "__job-worker".into(),
        spec.prefix.to_string_lossy().into_owned(),
        spec.job_id.clone(),
        spec.nonce.clone(),
    ];
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\"><plist version=\"1.0\"><dict><key>Label</key><string>{}</string><key>ProgramArguments</key><array>{}</array><key>WorkingDirectory</key><string>{}</string><key>EnvironmentVariables</key><dict>{}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>ProcessType</key><string>Background</string><key>Umask</key><integer>63</integer><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string></dict></plist>",
        xml(&label(root, &spec.job_id)),
        arguments
            .iter()
            .map(|a| format!("<string>{}</string>", xml(a)))
            .collect::<String>(),
        xml(&directory.to_string_lossy()),
        spec.environment
            .iter()
            .map(|(k, v)| format!("<key>{}</key><string>{}</string>", xml(k), xml(v)))
            .collect::<String>()
    )
}

fn schedule(root: &Path, directory: &Path, spec: &Spec) -> Result<()> {
    service::available()?;
    if cfg!(target_os = "macos") {
        let plist = directory.join("job.plist");
        files::atomic_write(
            &plist,
            launchd_plist(root, directory, spec).as_bytes(),
            0o600,
        )?;
        let domain = format!("gui/{}", rustix::process::geteuid().as_raw());
        service::command(
            "launchctl",
            &["bootstrap", &domain, &plist.to_string_lossy()],
        )?;
    } else {
        let mut args = vec![
            "--user".into(),
            "--no-block".into(),
            "--collect".into(),
            format!("--unit={}", label(root, &spec.job_id)),
            "--property=Type=exec".into(),
            "--property=RuntimeMaxSec=900".into(),
            "--property=KillMode=control-group".into(),
            "--property=UMask=0077".into(),
            "--property=StandardOutput=null".into(),
            "--property=StandardError=null".into(),
            format!("--working-directory={}", directory.display()),
        ];
        args.extend(
            spec.environment
                .iter()
                .map(|(k, v)| format!("--setenv={k}={v}")),
        );
        args.extend([
            "--".into(),
            directory.join("runner").to_string_lossy().into_owned(),
            "__job-worker".into(),
            spec.prefix.to_string_lossy().into_owned(),
            spec.job_id.clone(),
            spec.nonce.clone(),
        ]);
        service::command(
            "systemd-run",
            &args.iter().map(String::as_str).collect::<Vec<_>>(),
        )?;
    }
    Ok(())
}

fn supervisor_running(root: &Path, job_id: &str) -> Result<bool> {
    let name = label(root, job_id);
    let mut command = if cfg!(target_os = "macos") {
        let mut command = Command::new("launchctl");
        command.args([
            "print",
            &format!("gui/{}/{name}", rustix::process::geteuid().as_raw()),
        ]);
        command
    } else {
        let mut command = Command::new("systemctl");
        command.args([
            "--user",
            "show",
            "--property=ActiveState",
            "--property=SubState",
            &format!("{name}.service"),
        ]);
        command
    };
    let output=command.stdin(Stdio::null()).output().context("Cannot inspect the user service manager; retry job.status after restoring the user session.")?;
    if !output.status.success() {
        return Ok(false);
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(if cfg!(target_os = "macos") {
        text.lines().any(|l| l.trim().starts_with("pid = "))
    } else {
        text.lines().any(|l| {
            matches!(
                l,
                "ActiveState=active" | "ActiveState=activating" | "ActiveState=deactivating"
            )
        })
    })
}

fn job_directories(root: &Path) -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_name().to_str().is_some_and(valid_id) {
            ensure!(
                entry.file_type()?.is_dir(),
                "A job identifier names an unexpected file; inspect the job directory."
            );
            let directory = entry.path();
            check_private_directory(&directory)?;
            // Older status lookups created empty directories for unknown IDs.
            // Only these empty remnants are safe to omit from job admission.
            if fs::read_dir(&directory)?.next().transpose()?.is_none() {
                continue;
            }
            paths.push(directory);
        }
    }
    Ok(paths)
}
fn load_job(root: &Path, job_id: &str) -> Result<Job> {
    ensure!(
        valid_id(job_id),
        "jobId must be the 32-character identifier returned by job.submit."
    );
    let directory = root.join(job_id);
    let result = (|| {
        check_private_directory(&directory)?;
        read_record(&directory.join("state.json"))
    })();
    result.map_err(|error: anyhow::Error| {
        let missing = error
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound);
        #[cfg(unix)]
        let missing = missing
            || error.downcast_ref::<rustix::io::Errno>() == Some(&rustix::io::Errno::NOENT);
        error.context(if missing {
            "No saved local job record exists for this jobId in this instance. Refresh the job list (job.list) to inspect available jobs."
        } else {
            "Cannot read the saved local job record. Refresh the job list (job.list) and inspect its directory and permissions before retrying."
        })
    })
}
fn refresh(root: &Path, mut job: Job) -> Result<Job> {
    if active(&job)
        && now_ms().saturating_sub(job.created_at_ms) > 10_000
        && !supervisor_running(root, &job.job_id)?
        && let Some(_lease) = lease(root)?
    {
        job = load_job(root, &job.job_id)?;
        if active(&job) {
            job.state = "interrupted".into();
            job.finished_at_ms = Some(now_ms());
            job.error = Some(
                json!({"code":"job_interrupted","message":"The independent OS job exited before recording a result. Inspect daemon status and the job log before submitting a new operation; it was not replayed automatically.","retryable":false}),
            );
            save_record(&root.join(&job.job_id).join("state.json"), &job)?;
        }
    }
    Ok(job)
}

fn stage_bundle(source: &Path, destination: &Path) -> Result<()> {
    let source = fs::canonicalize(source).context(
        "Cannot locate the verified release bundle; prepare it before submitting installation.",
    )?;
    let manifest = source.join("bundle.json");
    let bundle:crate::install::Bundle=serde_json::from_slice(&fs::read(&manifest).context("Background installation requires a complete release bundle with bundle.json; use the synchronous CLI for source builds.")?)?;
    ensure!(
        bundle.format == 1 && bundle.components.iter().any(|c| c == "daemon"),
        "The verified bundle does not contain daemon; select a matching daemon package."
    );
    private_directory(destination)?;
    files::copy(&manifest, &destination.join("bundle.json"))?;
    files::copy(&source.join("bin/drdsh"), &destination.join("bin/drdsh"))?;
    if source.join("plugin").is_dir() {
        files::copy(&source.join("plugin"), &destination.join("plugin"))?;
    }
    Ok(())
}

fn submit(p: &Paths, request: &Request) -> Result<Value> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Submit {
        operation: String,
        #[serde(default = "empty")]
        params: Value,
        idempotency_key: Option<String>,
    }
    fn empty() -> Value {
        json!({})
    }
    let input: Submit = serde_json::from_value(request.params.clone())
        .context("job.submit accepts operation, params and optional idempotencyKey only.")?;
    ensure!(
        OPERATIONS.contains(&input.operation.as_str()),
        "This operation cannot run as a job; choose an install, update, uninstall, service, lifecycle, or planned handoff operation."
    );
    ensure!(
        input.params.is_object(),
        "Job params must be a JSON object."
    );
    if let Some(key) = &input.idempotency_key {
        ensure!(
            !key.is_empty()
                && key.len() <= 128
                && key
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b)),
            "idempotencyKey must contain 1–128 safe identifier characters."
        );
    }
    let root = root(p)?;
    // Repeating a request must return its durable receipt even while the worker
    // owns the execution lease. This read precedes admission of any new work.
    if input.idempotency_key.is_some() {
        for directory in job_directories(&root)? {
            if !directory.join("request.json").is_file() || !directory.join("state.json").is_file()
            {
                continue;
            }
            let previous: Spec = read_record(&directory.join("request.json"))?;
            if previous.idempotency_key == input.idempotency_key {
                ensure!(
                    previous.operation == input.operation
                        && previous.original_params == input.params,
                    "This idempotencyKey already names a different operation; use its original request or choose a new key."
                );
                let job = read_record(&directory.join("state.json"))?;
                return Ok(serde_json::to_value(refresh(&root, job)?)?);
            }
        }
    }
    let _lease=lease(&root)?.context("Another daemon job is being submitted or executed for this prefix; inspect job.list and wait for it to finish.")?;
    let mut history = Vec::new();
    for directory in job_directories(&root)? {
        let previous: Spec = read_record(&directory.join("request.json"))?;
        let mut job: Job = read_record(&directory.join("state.json"))?;
        if input.idempotency_key.is_some() && previous.idempotency_key == input.idempotency_key {
            ensure!(
                previous.operation == input.operation && previous.original_params == input.params,
                "This idempotencyKey already names a different operation; use its original request or choose a new key."
            );
            return Ok(serde_json::to_value(job)?);
        }
        if active(&job) {
            if now_ms().saturating_sub(job.created_at_ms) > 10_000
                && !supervisor_running(&root, &job.job_id)?
            {
                job.state = "interrupted".into();
                job.finished_at_ms = Some(now_ms());
                job.error = Some(
                    json!({"code":"job_interrupted","message":"The OS job stopped before recording its result; inspect daemon status before retrying.","retryable":false}),
                );
                save_record(&directory.join("state.json"), &job)?;
            } else {
                bail!(
                    "Another daemon job is queued or running for this prefix; inspect job.status before submitting another operation."
                );
            }
        }
        history.push((job.created_at_ms, directory));
    }
    service::available()?;
    let job_id = id();
    let directory = root.join(&job_id);
    private_directory(&directory)?;
    let staged = (|| -> Result<Spec> {
        let runner = directory.join("runner");
        files::copy(&fs::canonicalize(std::env::current_exe()?)?, &runner)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            fs::set_permissions(&runner, fs::Permissions::from_mode(0o700))?;
        }
        let mut params = input.params.clone();
        let mut executor = runner;
        if input.operation == "handoff" {
            crate::handoff::validate_submission(p, &params)?;
        } else if matches!(input.operation.as_str(), "install" | "update")
            && params.get("source").is_some()
        {
            if input.operation == "update" {
                ensure!(
                    params.as_object().is_some_and(|p| p.len() == 1),
                    "update with source accepts only the verified bundle source; configuration changes use config.set."
                );
                ensure!(
                    p.config.is_file(),
                    "Install daemon before submitting an update."
                );
            }
            let source = params["source"]
                .as_str()
                .context("source must name a verified release bundle directory.")?;
            stage_bundle(Path::new(source), &directory.join("bundle"))?;
            params["source"] = json!(directory.join("bundle"));
            executor = directory.join("bundle/bin/drdsh");
            let operation = if input.operation == "update" {
                "install"
            } else {
                &input.operation
            };
            manage::validate_job_operation(&Request::new("validate", operation, params.clone()))?;
        } else {
            manage::validate_job_operation(&Request::new(
                "validate",
                &input.operation,
                params.clone(),
            ))?;
        }
        Ok(Spec {
            version: 1,
            prefix: p.prefix.clone(),
            job_id: job_id.clone(),
            operation: input.operation.clone(),
            params,
            idempotency_key: input.idempotency_key,
            original_params: input.params,
            executor,
            environment: environment(),
            nonce: id(),
        })
    })();
    let spec = match staged {
        Ok(spec) => spec,
        Err(error) => {
            let _ = files::remove(&directory);
            return Err(error);
        }
    };
    let mut job = Job {
        job_id,
        operation: spec.operation.clone(),
        state: "queued".into(),
        created_at_ms: now_ms(),
        started_at_ms: None,
        finished_at_ms: None,
        worker_pid: None,
        exit_code: None,
        result: None,
        error: None,
    };
    save_record(&directory.join("request.json"), &spec)?;
    save_record(&directory.join("state.json"), &job)?;
    if let Err(error) = schedule(&root, &directory, &spec) {
        job.state = "failed".into();
        job.finished_at_ms = Some(now_ms());
        job.error = Some(
            json!({"code":"scheduler_failed","message":format!("Cannot schedule the independent OS job: {error:#}"),"retryable":true}),
        );
        save_record(&directory.join("state.json"), &job)?;
    }
    history.sort_by_key(|(created, _)| *created);
    let current_source = Config::read(p).ok().map(|c| c.source);
    let remove_count = history.len().saturating_sub(HISTORY_LIMIT - 1);
    for (_, old) in history.into_iter().take(remove_count) {
        if current_source
            .as_ref()
            .is_some_and(|source| source.starts_with(&old))
        {
            continue;
        }
        if cfg!(target_os = "macos") {
            let _ = service::command(
                "launchctl",
                &[
                    "bootout",
                    &format!(
                        "gui/{}/{}",
                        rustix::process::geteuid().as_raw(),
                        label(
                            &root,
                            old.file_name().and_then(|v| v.to_str()).unwrap_or_default()
                        )
                    ),
                ],
            );
        }
        let _ = files::remove(&old);
    }
    Ok(serde_json::to_value(job)?)
}

pub(crate) fn dispatch(p: &Paths, request: &Request) -> Result<Value> {
    match request.operation.as_str() {
        "job.submit" => submit(p, request),
        "handoff.plan" => crate::handoff::plan(p, &request.params),
        "job.status" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Query {
                job_id: String,
            }
            let query: Query = serde_json::from_value(request.params.clone())
                .context("job.status requires only jobId.")?;
            let root = root(p)?;
            Ok(serde_json::to_value(refresh(
                &root,
                load_job(&root, &query.job_id)?,
            )?)?)
        }
        "job.list" => {
            ensure!(
                request.params.as_object().is_some_and(|p| p.is_empty()),
                "job.list accepts an empty params object."
            );
            let root = root(p)?;
            let mut jobs = Vec::new();
            for directory in job_directories(&root)? {
                if !directory.join("state.json").is_file() {
                    continue;
                }
                jobs.push(refresh(&root, read_record(&directory.join("state.json"))?)?);
            }
            jobs.sort_by_key(|j| std::cmp::Reverse(j.created_at_ms));
            jobs.truncate(HISTORY_LIMIT);
            Ok(json!({"jobs":jobs}))
        }
        _ => bail!("Unknown independent job operation; use job.submit, job.status, or job.list."),
    }
}

pub(crate) fn worker(args: &[String]) -> Result<ExitCode> {
    let [prefix, job_id, nonce] = args else {
        bail!("Internal job invocation is incomplete; submit work with daemon manage job.submit.")
    };
    ensure!(
        valid_id(job_id) && valid_id(nonce),
        "Invalid internal job identity; submit work through job.submit."
    );
    let p = Paths::new(Path::new(prefix), "daemon")?;
    let root = root(&p)?;
    let directory = root.join(job_id);
    private_directory(&directory)?;
    ensure!(
        fs::canonicalize(std::env::current_exe()?)? == fs::canonicalize(directory.join("runner"))?,
        "This worker is not the staged independent job executable; use job.submit."
    );
    let spec: Spec = read_record(&directory.join("request.json"))?;
    ensure!(
        spec.version == 1
            && spec.job_id == *job_id
            && spec.nonce == *nonce
            && spec.prefix == p.prefix
            && OPERATIONS.contains(&spec.operation.as_str()),
        "The saved job identity does not match this worker; inspect its record."
    );
    let deadline = Instant::now() + Duration::from_secs(45);
    let _lease = loop {
        if let Some(lease) = lease(&root)? {
            break lease;
        }
        ensure!(
            Instant::now() < deadline,
            "Another job still owns this instance; inspect job.list before retrying."
        );
        std::thread::sleep(Duration::from_millis(25));
    };
    let mut job = load_job(&root, job_id)?;
    ensure!(
        job.state == "queued",
        "This job has already started or finished; jobs are never replayed automatically."
    );
    job.state = "running".into();
    job.started_at_ms = Some(now_ms());
    job.worker_pid = Some(std::process::id());
    save_record(&directory.join("state.json"), &job)?;
    let _ = files::atomic_write(
        &directory.join("events.log"),
        format!("{} job started: {}\n", now_ms(), job.operation).as_bytes(),
        0o600,
    );
    let (response, exit_code) = if spec.operation == "handoff" {
        match crate::handoff::execute(&p, &spec.params) {
            Ok(result) => (Response::success(job_id, result), 0),
            Err(error) => (
                Response::failure(job_id, "handoff_failed", format!("{error:#}"), false),
                1,
            ),
        }
    } else {
        let operation = if spec.operation == "update" && spec.params.get("source").is_some() {
            "install"
        } else {
            &spec.operation
        };
        manage::execute_job(
            &p,
            &Request::new(job_id, operation, spec.params),
            &spec.executor,
        )
    };
    job.state = if response.ok { "succeeded" } else { "failed" }.into();
    job.finished_at_ms = Some(now_ms());
    job.exit_code = Some(exit_code);
    job.result = response.result;
    job.error = response.error.map(|error| json!(error));
    if let Some(result) = &mut job.result
        && result.is_object()
    {
        result["synchronous"] = json!(false);
    }
    save_record(&directory.join("state.json"), &job)?;
    let mut log = format!(
        "{} job started: {}\n{} job finished: {} (exit {})\n",
        job.started_at_ms.unwrap_or_default(),
        job.operation,
        job.finished_at_ms.unwrap_or_default(),
        job.state,
        job.exit_code.unwrap_or(1)
    );
    if let Some(error) = &job.error {
        let message = error["message"]
            .as_str()
            .unwrap_or("Operation failed; inspect daemon status.");
        log.extend(message.chars().take(8192));
        log.push('\n');
    }
    files::atomic_write(&directory.join("events.log"), log.as_bytes(), 0o600)?;
    // The result outlives both the daemon installation and this per-job executable.
    let _ = files::remove(&directory.join("runner"));
    Ok(if job.state == "succeeded" {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn job_ids_cannot_escape_the_private_directory() {
        for id in [
            "../other",
            "",
            "ABCDEF0123456789ABCDEF0123456789",
            "1/2345678901234567890123456789012",
        ] {
            assert!(!valid_id(id));
        }
        assert!(valid_id("0123456789abcdef0123456789abcdef"));
    }
    #[test]
    fn unknown_job_lookup_has_context_without_creating_a_job_directory() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let p = Paths::new(temp.path(), "daemon")?;
        let root = root(&p)?;
        let job_id = "a".repeat(32);
        let directory = root.join(&job_id);
        let request = Request::new("missing-job", "job.status", json!({"jobId":job_id}));

        let error = dispatch(&p, &request)
            .err()
            .context("an unknown job ID must fail lookup")?;
        assert!(
            error
                .to_string()
                .contains("No saved local job record exists")
        );
        assert!(
            error
                .to_string()
                .contains("Refresh the job list (job.list)")
        );
        assert!(!directory.exists());
        assert_eq!(fs::read_dir(&root)?.count(), 0);

        private_directory(&directory)?;
        let error = dispatch(&p, &request)
            .err()
            .context("a job without its saved state must fail lookup")?;
        assert!(
            error
                .to_string()
                .contains("No saved local job record exists")
        );
        assert!(
            error
                .to_string()
                .contains("Refresh the job list (job.list)")
        );
        assert_eq!(fs::read_dir(&directory)?.count(), 0);
        Ok(())
    }
    #[test]
    fn admission_skips_only_private_empty_legacy_lookup_directories() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let p = Paths::new(temp.path(), "daemon")?;
        let root = root(&p)?;
        let empty = root.join("a".repeat(32));
        private_directory(&empty)?;
        assert!(job_directories(&root)?.is_empty());

        let incomplete = root.join("b".repeat(32));
        private_directory(&incomplete)?;
        save_record(
            &incomplete.join("request.json"),
            &json!({"incomplete":true}),
        )?;
        assert_eq!(job_directories(&root)?, vec![incomplete.clone()]);
        assert!(read_record::<Job>(&incomplete.join("state.json")).is_err());

        #[cfg(unix)]
        {
            use std::os::unix::fs::{PermissionsExt as _, symlink};
            fs::set_permissions(&empty, fs::Permissions::from_mode(0o755))?;
            assert!(
                job_directories(&root)
                    .err()
                    .context("job admission must reject a directory with public permissions")?
                    .to_string()
                    .contains("0700")
            );
            fs::set_permissions(&empty, fs::Permissions::from_mode(0o700))?;
            symlink(&empty, root.join("c".repeat(32)))?;
            assert!(job_directories(&root).is_err());
        }
        Ok(())
    }
    #[test]
    fn launchd_arguments_are_literal_and_do_not_use_a_shell() {
        let spec = Spec {
            version: 1,
            prefix: PathBuf::from("/tmp/a & b"),
            job_id: "a".repeat(32),
            operation: "service.stop".into(),
            params: json!({}),
            idempotency_key: None,
            original_params: json!({}),
            executor: PathBuf::from("/tmp/runner"),
            environment: BTreeMap::from([("HOME".into(), "/tmp/a & b".into())]),
            nonce: "b".repeat(32),
        };
        let xml = launchd_plist(Path::new("/tmp/jobs"), Path::new("/tmp/jobs/one"), &spec);
        assert!(xml.contains("/tmp/a &amp; b"));
        assert!(xml.contains("__job-worker"));
        assert!(!xml.contains("/bin/sh"));
        assert!(xml.contains("<key>KeepAlive</key><false/>"));
    }
    #[test]
    fn records_are_private_and_survive_a_new_reader() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let p = Paths::new(temp.path(), "daemon")?;
        let root = root(&p)?;
        let path = root.join("record.json");
        save_record(&path, &json!({"state":"running"}))?;
        let value: Value = read_record(&path)?;
        assert_eq!(value["state"], "running");
        Ok(())
    }
}
