//! Machine-readable local administration. Installation state stays in daemon.json.

use crate::{files, management, service};
use anyhow::{Context, Result};
use dr_dsh_daemon::admin::{self, Request, Response};
use management::{Config, Paths};
use serde_json::{Map, Value, json};
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, ExitCode, Stdio};
use std::time::{Duration, Instant};

const MAX_REQUEST_BYTES: usize = 64 * 1024;
const MAX_OUTPUT_BYTES: usize = 64 * 1024;

struct Failure {
    code: &'static str,
    message: String,
    retryable: bool,
    exit_code: Option<i32>,
    result: Option<Value>,
}

type Managed<T> = std::result::Result<T, Failure>;

fn failure(code: &'static str, message: impl Into<String>, retryable: bool) -> Failure {
    Failure {
        code,
        message: message.into(),
        retryable,
        exit_code: None,
        result: None,
    }
}

fn invalid(message: impl Into<String>) -> Failure {
    failure("invalid_request", message, false)
}

fn response_error(request_id: &str, error: Failure) -> Response {
    let mut response = Response::failure(request_id, error.code, error.message, error.retryable);
    response.result = error.result;
    response
}

fn read_request(input: impl Read) -> Managed<Request> {
    let mut bytes = Vec::new();
    input.take((MAX_REQUEST_BYTES + 1) as u64).read_to_end(&mut bytes)
        .map_err(|_| invalid("Cannot read the management request; send one JSON object on stdin and close stdin."))?;
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err(failure(
            "request_too_large",
            "Management requests must not exceed 65536 bytes.",
            false,
        ));
    }
    serde_json::from_slice(&bytes).map_err(|_| invalid("Expected one JSON request with version, requestId, operation and params; trailing requests and unknown fields are not accepted."))
}

fn paths(args: &[String]) -> Managed<Paths> {
    let prefix = match args {
        [] => None,
        [flag, path]
            if flag == "--prefix" && !path.is_empty() && !path.contains(['\0', '\r', '\n']) =>
        {
            Some(Path::new(path))
        }
        _ => {
            return Err(invalid(
                "Use drdsh daemon manage [--prefix <path>]; send the operation on stdin.",
            ));
        }
    };
    management::prefix(prefix)
        .and_then(|prefix| Paths::new(&prefix, "daemon"))
        .map_err(|error| failure("invalid_prefix", format!("{error:#}"), false))
}

fn config(p: &Paths) -> Managed<Config> {
    if !p.config.is_file() {
        return Err(failure(
            "not_installed",
            "No daemon.json exists at this prefix; install daemon or choose its existing --prefix.",
            false,
        ));
    }
    Config::read(p).map_err(|error| failure("invalid_config", format!("{error:#}"), false))
}

fn params(request: &Request) -> Managed<&Map<String, Value>> {
    request
        .params
        .as_object()
        .ok_or_else(|| invalid("params must be a JSON object."))
}

fn empty_params(request: &Request) -> Managed<()> {
    if !params(request)?.is_empty() {
        return Err(invalid(
            "This operation accepts an empty params object only.",
        ));
    }
    Ok(())
}

fn config_view(c: &Config) -> Value {
    json!({"config": c, "effective": {
        "pluginOwner": c.plugin_owner.unwrap_or_default(),
        "pluginReportsEnabled": c.plugin_reports_enabled(),
        "localAdminEnabled": c.local_admin_enabled == Some(true),
    }})
}

fn patch_config(p: &Paths, patch: &Map<String, Value>) -> Managed<Value> {
    const FIELDS: &[&str] = &[
        "relay",
        "port",
        "dsh",
        "dshHome",
        "workdir",
        "caCert",
        "tlsInsecure",
        "dshTls",
        "pluginOwner",
        "pluginReportsEnabled",
        "localAdminEnabled",
    ];
    if patch.keys().any(|key| !FIELDS.contains(&key.as_str())) {
        return Err(invalid(
            "config.set accepts relay, port, dsh, dshHome, workdir, caCert, tlsInsecure, dshTls, pluginOwner, pluginReportsEnabled and localAdminEnabled only. Prefix, state directory, ownership of installation files and package paths cannot be migrated through this operation.",
        ));
    }
    let _lock = files::DirectoryGuard::lock(&p.root)
        .map_err(|error| failure("operation_locked", format!("{error:#}"), true))?;
    let previous = config(p)?;
    let mut value = serde_json::to_value(&previous).map_err(|_| {
        failure(
            "invalid_config",
            "Cannot encode saved daemon configuration.",
            false,
        )
    })?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| invalid("Saved daemon configuration is not an object."))?;
    for (key, value) in patch {
        if value.is_null() && key != "caCert" {
            return Err(invalid(
                "Only caCert may be null; other configuration fields require explicit values.",
            ));
        }
        object.insert(key.clone(), value.clone());
    }
    let mut updated: Config = serde_json::from_value(value)
        .map_err(|_| invalid("A configuration value has the wrong type; booleans must be true/false, port a number, paths strings, and pluginOwner daemon or external."))?;
    if !updated.owns_plugin() && updated.plugin_reports_enabled.is_none() {
        updated.plugin_reports_enabled = Some(previous.plugin_reports_enabled());
    }
    if patch.contains_key("dsh") {
        updated.dsh_managed = None;
        updated.dsh_version = None;
    }
    updated
        .validate(p)
        .map_err(|error| failure("invalid_config", format!("{error:#}"), false))?;
    if patch.contains_key("relay") {
        let uri = updated.relay.as_deref().unwrap_or_default().parse::<axum::http::Uri>()
            .map_err(|_| failure("invalid_config", "Daemon relay must be a valid ws:// or wss:// origin with a hostname or bracketed IP and a valid port.", false))?;
        let authority = uri
            .authority()
            .map(|authority| authority.as_str())
            .unwrap_or_default();
        let port = if authority.starts_with('[') {
            authority
                .split_once(']')
                .and_then(|(_, suffix)| suffix.strip_prefix(':'))
        } else {
            authority.split_once(':').map(|(_, port)| port)
        };
        if uri.host().is_none_or(str::is_empty)
            || port.is_some_and(|port| !port.parse::<u16>().is_ok_and(|port| port > 0))
        {
            return Err(failure(
                "invalid_config",
                "Daemon relay needs a hostname and, when specified, a port from 1 through 65535.",
                false,
            ));
        }
    }
    if updated.workdir.as_deref().is_none_or(|path| !path.is_dir()) {
        return Err(failure(
            "invalid_config",
            "Daemon workdir does not exist; choose an existing absolute directory.",
            false,
        ));
    }
    if patch.contains_key("dsh") {
        let dsh = updated
            .dsh
            .as_deref()
            .and_then(Path::to_str)
            .ok_or_else(|| invalid("dsh must be an absolute executable path."))?;
        let executable = management::executable(dsh)
            .map_err(|error| failure("invalid_config", format!("{error:#}"), false))?;
        let parent = executable
            .parent()
            .ok_or_else(|| invalid("dsh must name an executable inside a directory."))?;
        // Resolve the executable but retain the saved PATH; the caller's PATH may be
        // the package manager's transient environment rather than the user's runtime.
        if previous.dsh.as_ref() != Some(&executable) {
            updated.path = Some(format!(
                "{}:{}",
                parent.display(),
                previous.path.as_deref().unwrap_or("/usr/bin:/bin")
            ));
        }
        updated.dsh = Some(executable);
    }
    if patch.contains_key("caCert")
        && let Some(ca) = &updated.ca_cert
    {
        dr_dsh_tls::client_config_with_options(Some(ca), Some(false)).map_err(|error| {
            failure(
                "invalid_config",
                format!("Cannot use daemon CA certificate: {error:#}"),
                false,
            )
        })?;
    }
    if previous.owns_plugin()
        && previous
            .components
            .iter()
            .any(|component| component == "plugin")
        && previous.dsh_home != updated.dsh_home
    {
        return Err(failure(
            "plugin_registration_conflict",
            "Remove the daemon-owned plugin registration before changing dshHome, so its old registration is not abandoned.",
            false,
        ));
    }
    let old = serde_json::to_value(&previous)
        .map_err(|_| invalid("Cannot encode prior configuration."))?;
    let new = serde_json::to_value(&updated)
        .map_err(|_| invalid("Cannot encode updated configuration."))?;
    let changed = old != new;
    let restart_required = changed
        && patch
            .keys()
            .any(|key| key != "pluginOwner" && old.get(key) != new.get(key));
    if changed {
        updated.save(p).map_err(|error| {
            failure(
                "config_write_failed",
                format!("Cannot save daemon configuration: {error:#}"),
                false,
            )
        })?;
    }
    let mut result = config_view(&updated);
    result["changed"] = json!(changed);
    result["restartRequired"] = json!(restart_required);
    Ok(result)
}

fn call(c: &Config, request: &Request) -> Managed<Response> {
    let state = c
        .state
        .as_deref()
        .ok_or_else(|| invalid("Daemon state directory is missing."))?;
    tokio::runtime::Builder::new_current_thread().enable_all().build()
        .map_err(|_| failure("runtime_unavailable", "Cannot create a local administration client runtime.", true))?
        .block_on(admin::call(state, request))
        .map_err(|_| failure("daemon_unavailable", "Cannot reach this installation's local daemon endpoint; start daemon with local administration enabled, then retry. No service was started automatically.", true))
}

fn status(p: &Paths, request: &Request) -> Managed<Value> {
    empty_params(request)?;
    if !p.config.is_file() {
        return Ok(json!({"installed": false, "prefix": p.prefix, "configPath": p.config}));
    }
    let c = config(p)?;
    let service_state = match service::state(p) {
        Ok(state) => json!({"available": true, "state": state}),
        Err(_) => {
            json!({"available": false, "reason": "The user service manager is unavailable in this session."})
        }
    };
    let runtime = match call(&c, &Request::new(&request.request_id, "status", json!({}))) {
        Ok(reply) => json!(reply),
        Err(error) => json!(response_error(&request.request_id, error)),
    };
    Ok(
        json!({"installed": c.installed(), "prefix": p.prefix, "configPath": p.config, "settings": config_view(&c), "service": service_state, "runtime": runtime}),
    )
}

fn protected_operation(operation: &str) -> bool {
    matches!(
        operation,
        "install"
            | "update"
            | "uninstall"
            | "plugin.install"
            | "plugin.uninstall"
            | "service.stop"
            | "service.restart"
            | "lifecycle.stop"
            | "lifecycle.restart"
    )
}

pub(crate) fn validate_job_operation(request: &Request) -> Result<()> {
    if ["lifecycle.stop", "lifecycle.restart"].contains(&request.operation.as_str()) {
        return empty_params(request).map_err(|error| anyhow::anyhow!(error.message));
    }
    child_args(request)
        .map(|_| ())
        .map_err(|error| anyhow::anyhow!(error.message))
}

fn child_args(request: &Request) -> Managed<Vec<String>> {
    let params = params(request)?;
    let mut args: Vec<String> = match request.operation.as_str() {
        "install" => vec!["install".into()],
        "update" => vec!["update".into()],
        "uninstall" => vec!["uninstall".into()],
        "plugin.install" => vec!["install".into(), "plugin".into()],
        "plugin.uninstall" => vec!["uninstall".into(), "plugin".into()],
        "service.start" => vec!["start".into()],
        "service.stop" => vec!["stop".into()],
        "service.restart" => vec!["restart".into()],
        "service.enable" => vec!["enable".into()],
        "service.disable" => vec!["disable".into()],
        "logs.tail" => vec!["logs".into()],
        "doctor" => vec!["doctor".into()],
        "audit.read" => vec!["audit".into()],
        "audit.clear" => vec!["audit".into(), "--clear".into()],
        "crashes.read" => vec!["crashes".into()],
        "crashes.clear" => vec!["crashes".into(), "--clear".into()],
        _ => {
            return Err(failure(
                "unknown_operation",
                "Unknown management operation; use the documented daemon management protocol.",
                false,
            ));
        }
    };
    for (key, value) in params {
        let flag = match (args[0].as_str(), key.as_str()) {
            ("update", "version") => "version",
            ("install", "source") => "source",
            ("install", "buildProfile") => "build-profile",
            ("install", "pluginOwner") => "plugin-owner",
            ("install", "relay") => "relay",
            ("install", "dsh") => "dsh",
            ("install", "dshHome") => "dsh-home",
            ("install", "workdir") => "workdir",
            ("install", "stateDir") => "state-dir",
            ("install", "caCert") => "ca-cert",
            ("install", "port") => "port",
            ("install", "skipBuild") => "skip-build",
            ("install", "start") => "start",
            ("install", "enable") => "enable",
            ("install", "withPlugin") => "with-plugin",
            ("install", "dshTls") => "dsh-tls",
            ("install", "tlsInsecure") => "insecure",
            ("install", "pluginReportsEnabled") => "plugin-reports",
            ("install", "localAdminEnabled") => "local-admin",
            _ => {
                return Err(invalid(
                    "This operation contains an unsupported parameter; prefix is selected only by --prefix.",
                ));
            }
        };
        if [
            "skip-build",
            "start",
            "enable",
            "with-plugin",
            "dsh-tls",
            "insecure",
            "plugin-reports",
            "local-admin",
        ]
        .contains(&flag)
        {
            match value.as_bool() {
                Some(true) => args.push(format!("--{flag}")),
                Some(false) if ["insecure", "plugin-reports", "local-admin"].contains(&flag) => {
                    args.push(format!("--no-{flag}"))
                }
                Some(false) => {}
                None => return Err(invalid("Install switches require JSON true or false.")),
            }
        } else if flag == "port" {
            let port = value
                .as_u64()
                .filter(|port| (1..=65535).contains(port))
                .ok_or_else(|| invalid("port must be an integer from 1 through 65535."))?;
            args.extend(["--port".into(), port.to_string()]);
        } else {
            let value = value
                .as_str()
                .filter(|value| !value.is_empty() && !value.contains(['\0', '\r', '\n']))
                .ok_or_else(|| {
                    invalid(
                        "Management option values must be nonempty strings without line breaks.",
                    )
                })?;
            args.extend([format!("--{flag}"), value.into()]);
        }
    }
    Ok(args)
}

struct Captured {
    bytes: Vec<u8>,
    truncated: bool,
}

fn drain(mut pipe: impl Read) -> std::io::Result<Captured> {
    let mut result = Captured {
        bytes: Vec::new(),
        truncated: false,
    };
    let mut buffer = [0u8; 8192];
    loop {
        let count = pipe.read(&mut buffer)?;
        if count == 0 {
            return Ok(result);
        }
        result.bytes.extend_from_slice(&buffer[..count]);
        if result.bytes.len() > MAX_OUTPUT_BYTES {
            result.bytes.drain(..result.bytes.len() - MAX_OUTPUT_BYTES);
            result.truncated = true;
        }
    }
}

fn text_result(stdout: Captured, exit_code: Option<i32>) -> Managed<Value> {
    let mut text = String::from_utf8_lossy(&stdout.bytes).into_owned();
    let mut truncated = stdout.truncated;
    loop {
        let result = json!({"text": text, "truncated": truncated, "exitCode": exit_code});
        let size = serde_json::to_vec(&result)
            .map_err(|_| {
                failure(
                    "output_unavailable",
                    "Cannot encode the native diagnostic output.",
                    false,
                )
            })?
            .len();
        // JSON escaping can expand bounded process output. Leave room for the
        // correlation identifier and failure envelope, retaining the latest lines.
        if size <= MAX_REQUEST_BYTES - 2048 {
            return Ok(result);
        }
        let mut start = text.len().div_ceil(2);
        while !text.is_char_boundary(start) {
            start += 1;
        }
        text.drain(..start);
        truncated = true;
    }
}

fn pipe_reader(
    pipe: impl Read + Send + 'static,
) -> std::sync::mpsc::Receiver<std::io::Result<Captured>> {
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let _ = send.send(drain(pipe));
    });
    receive
}

fn stop_child(child: &mut std::process::Child) {
    #[cfg(unix)]
    let _ = Command::new("/bin/kill")
        .args(["-KILL", "--", &format!("-{}", child.id())])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.kill();
    let _ = child.wait();
}

fn subprocess(p: &Paths, request: &Request) -> Managed<Value> {
    let executable = std::env::current_exe().map_err(|_| {
        failure(
            "command_unavailable",
            "Cannot locate the current daemon management executable.",
            false,
        )
    })?;
    subprocess_at(p, request, &executable, false)
}

fn subprocess_at(
    p: &Paths,
    request: &Request,
    executable: &Path,
    independent: bool,
) -> Managed<Value> {
    let args = child_args(request)?;
    let text_output = matches!(
        request.operation.as_str(),
        "logs.tail" | "doctor" | "audit.read" | "audit.clear" | "crashes.read" | "crashes.clear"
    );
    let mut command = Command::new(executable);
    if independent {
        command.env_remove("DRDSH_MANAGED_INSTANCE");
    }
    command
        .arg("daemon")
        .args(&args)
        .arg("--prefix")
        .arg(&p.prefix)
        .env("DRDSH_BANNER_SHOWN", "1")
        .stdin(Stdio::null())
        .stdout(if text_output {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stderr(Stdio::piped());
    // The synchronous interface never hides an operation in the background. The
    // process group lets timeout cleanup reach package/build subprocesses too.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|_| {
        failure(
            "command_unavailable",
            "Cannot start the native daemon management command.",
            true,
        )
    })?;
    let out = child.stdout.take().map(pipe_reader);
    let err = child.stderr.take().map(pipe_reader);
    let timeout = if matches!(
        request.operation.as_str(),
        "install" | "update" | "plugin.install"
    ) {
        Duration::from_secs(300)
    } else {
        Duration::from_secs(90)
    };
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                stop_child(&mut child);
                return Err(failure(
                    "operation_timeout",
                    "The synchronous management operation did not finish. Inspect daemon status, logs and the component operation lock before retrying; no background job was created.",
                    false,
                ));
            }
        }
    };
    let mut captured =
        |receiver: Option<std::sync::mpsc::Receiver<std::io::Result<Captured>>>| -> Managed<Captured> {
            match receiver {
                Some(receiver) => receiver
                    .recv_timeout(Duration::from_secs(2))
                    .map_err(|_| {
                        stop_child(&mut child);
                        failure("output_unavailable", "A management subprocess retained its output after the command exited; its process group was stopped. Inspect daemon status before retrying.", false)
                    })?
                    .map_err(|_| {
                        failure(
                            "output_unavailable",
                            "Cannot read management output.",
                            false,
                        )
                    }),
                None => Ok(Captured {
                    bytes: vec![],
                    truncated: false,
                }),
            }
        };
    let stdout = captured(out)?;
    let stderr = captured(err)?;
    if request.operation == "doctor"
        && status.code() == Some(1)
        && !stdout.bytes.is_empty()
        && stderr.bytes.is_empty()
    {
        // Doctor reports failed checks on stdout with exit 1. Preserve those
        // findings without turning command failures or timeouts into reports.
        let mut error = failure(
            "diagnostic_failed",
            "Daemon diagnosis found failed checks. Review the diagnostic report and correct its reported causes before retrying.",
            false,
        );
        error.exit_code = Some(1);
        error.result = Some(text_result(stdout, status.code())?);
        return Err(error);
    }
    if !status.success() {
        let detail = String::from_utf8_lossy(&stderr.bytes);
        let mut error = failure(
            "operation_failed",
            if detail.trim().is_empty() {
                "Native daemon command failed; inspect daemon logs and the saved configuration."
                    .into()
            } else {
                format!("Native daemon command failed: {}", detail.trim())
            },
            false,
        );
        error.exit_code = status.code();
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt as _;
            error.exit_code = error
                .exit_code
                .or_else(|| status.signal().map(|signal| 128 + signal));
        }
        return Err(error);
    }
    if text_output {
        return text_result(stdout, status.code());
    }
    let saved = if p.config.is_file() {
        Some(config(p)?)
    } else {
        None
    };
    Ok(json!({"completed": true, "synchronous": true, "exitCode": status.code(), "config": saved}))
}

/// Only the OS-managed worker calls this after validating its on-disk job identity.
pub(crate) fn execute_job(p: &Paths, request: &Request, executable: &Path) -> (Response, i32) {
    let result = if ["lifecycle.stop", "lifecycle.restart"].contains(&request.operation.as_str()) {
        config(p).and_then(|config| call(&config, request))
    } else {
        subprocess_at(p, request, executable, true)
            .map(|result| Response::success(&request.request_id, result))
    };
    match result {
        Ok(response) => {
            let code = if response.ok { 0 } else { 1 };
            (response, code)
        }
        Err(error) => {
            let code = error.exit_code.unwrap_or(1);
            (response_error(&request.request_id, error), code)
        }
    }
}

fn dispatch(p: &Paths, request: &Request) -> Managed<Response> {
    if let Some(response) = admin::validate_request(request) {
        return Ok(response);
    }
    params(request)?;
    if std::env::var_os("DRDSH_MANAGED_INSTANCE").is_some()
        && protected_operation(&request.operation)
    {
        return Err(failure(
            "requires_external_job",
            "This operation could stop the DSH process that is invoking it. Submit it through job.submit so an independent OS job can finish after DSH exits, or use a separate local terminal.",
            false,
        ));
    }
    let result = match request.operation.as_str() {
        "job.submit" | "job.status" | "job.list" | "handoff.plan" => {
            crate::jobs::dispatch(p, request)
                .map_err(|error| failure("job_request_failed", format!("{error:#}"), false))?
        }
        "status" => status(p, request)?,
        "config.get" => {
            empty_params(request)?;
            config_view(&config(p)?)
        }
        "config.set" => patch_config(p, params(request)?)?,
        "runtime.status" | "pair.begin" | "pair.status" | "pair.cancel" | "devices.list"
        | "devices.revoke" | "lifecycle.start" | "lifecycle.stop" | "lifecycle.restart"
        | "lifecycle.status" => return call(&config(p)?, request),
        _ => subprocess(p, request)?,
    };
    Ok(Response::success(&request.request_id, result))
}

pub(crate) fn run(args: &[String]) -> Result<ExitCode> {
    let request = read_request(std::io::stdin().lock());
    let mut response = match request {
        Err(error) => response_error("", error),
        Ok(request) => {
            if let Some(response) = admin::validate_request(&request) {
                response
            } else {
                match crate::unavailable("daemon")
                    .map_err(|error| failure("component_unavailable", format!("{error:#}"), false))
                    .and_then(|()| paths(args))
                    .and_then(|p| dispatch(&p, &request))
                {
                    Ok(response) => response,
                    Err(error) => response_error(&request.request_id, error),
                }
            }
        }
    };
    let mut encoded =
        serde_json::to_vec(&response).context("Cannot encode the management response.")?;
    if encoded.len() > MAX_REQUEST_BYTES {
        response = Response::failure(
            &response.request_id,
            "response_too_large",
            "The management result exceeds 64 KiB; use the human CLI to inspect the complete configuration or logs.",
            false,
        );
        encoded = serde_json::to_vec(&response)?;
    }
    let code = if response.ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    };
    let mut stdout = std::io::stdout().lock();
    stdout
        .write_all(&encoded)
        .context("Cannot write the management JSON response.")?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;
    Ok(code)
}

#[cfg(test)]
mod tests {
    use super::*;
    use management::PluginOwner;

    fn fixture(root: &Path) -> Result<(Paths, Config)> {
        let p = Paths::new(root, "daemon")?;
        let c: Config = serde_json::from_value(json!({
            "version":1,"prefix":p.prefix,"scope":"daemon","source":root,
            "components":["daemon"],"relay":"ws://127.0.0.1:8787","port":3080,
            "dsh":"/usr/bin/true","dshHome":root,"workdir":root,"state":root.join("state"),"path":"/usr/bin:/bin"
        }))?;
        c.save(&p)?;
        Ok((p, c))
    }

    #[test]
    fn bounded_single_request_rejects_trailing_data() {
        assert!(read_request(&b"{} {}"[..]).is_err());
        assert!(read_request(vec![b' '; MAX_REQUEST_BYTES + 1].as_slice()).is_err());
        let encoded = br#"{"version":1,"requestId":"test","operation":"config.get","params":{}}"#;
        assert!(read_request(&encoded[..]).is_ok());
    }

    #[test]
    fn config_patch_is_atomic_and_keeps_state_and_component_boundaries() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let (p, before) = fixture(temp.path())?;
        let relay = Paths::new(temp.path(), "relay")?;
        files::atomic_write(&relay.config, b"relay remains unchanged\n", 0o600)?;
        let patch = json!({"relay":"wss://relay.example", "pluginOwner":"external", "pluginReportsEnabled":true});
        let changed = patch_config(&p, patch.as_object().context("patch")?)
            .map_err(|e| anyhow::anyhow!(e.message))?;
        assert_eq!(changed["restartRequired"], true);
        let saved = Config::read(&p)?;
        assert_eq!(saved.state, before.state);
        assert_eq!(saved.plugin_owner, Some(PluginOwner::External));
        assert!(saved.plugin_reports_enabled());
        assert_eq!(std::fs::read(&relay.config)?, b"relay remains unchanged\n");
        let committed = std::fs::read(&p.config)?;
        for patch in [
            json!({"state":"/tmp/other"}),
            json!({"prefix":"/tmp/other"}),
            json!({"port":0}),
            json!({"relay":"https://wrong"}),
            json!({"relay":"ws://localhost:wrong"}),
            json!({"pluginOwner":"unknown"}),
        ] {
            assert!(patch_config(&p, patch.as_object().context("patch")?).is_err());
            assert_eq!(std::fs::read(&p.config)?, committed);
        }
        let lock = files::DirectoryGuard::lock(&p.root)?;
        assert!(patch_config(&p, json!({"port":3081}).as_object().context("patch")?).is_err());
        drop(lock);
        assert_eq!(std::fs::read(&p.config)?, committed);
        Ok(())
    }

    #[test]
    fn configuration_owner_change_does_not_require_runtime_restart() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let (p, _) = fixture(temp.path())?;
        let result = patch_config(
            &p,
            json!({"pluginOwner":"external"})
                .as_object()
                .context("patch")?,
        )
        .map_err(|e| anyhow::anyhow!(e.message))?;
        assert_eq!(result["restartRequired"], false);
        assert!(!p.root.join("services").exists());
        Ok(())
    }

    #[test]
    fn selecting_an_external_dsh_releases_only_runtime_ownership() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let (p, mut before) = fixture(temp.path())?;
        before.dsh = Some(crate::provision::launcher(&p));
        before.dsh_managed = Some(true);
        before.dsh_version = Some(crate::provision::DSH_VERSION.into());
        before.save(&p)?;
        let result = patch_config(
            &p,
            json!({"dsh":"/usr/bin/true"})
                .as_object()
                .context("patch")?,
        )
        .map_err(|e| anyhow::anyhow!(e.message))?;
        let after = Config::read(&p)?;
        assert_eq!(result["restartRequired"], true);
        assert_eq!(after.dsh_managed, None);
        assert_eq!(after.dsh_version, None);
        assert_eq!(after.dsh_home, before.dsh_home);
        assert_eq!(after.state, before.state);
        assert_eq!(after.components, before.components);
        Ok(())
    }

    #[test]
    fn subprocess_options_are_typed_and_do_not_accept_another_prefix() {
        assert!(
            child_args(&Request::new(
                "r",
                "install",
                json!({"prefix":"/elsewhere"})
            ))
            .is_err()
        );
        assert!(child_args(&Request::new("r", "install", json!({"start":"false"}))).is_err());
        assert!(child_args(&Request::new("r", "service.stop", json!({"source":"/tmp"}))).is_err());
        let args = child_args(&Request::new(
            "r",
            "install",
            json!({"pluginOwner":"external","pluginReportsEnabled":false,"localAdminEnabled":true}),
        ));
        assert!(
            args.is_ok_and(|args| args.contains(&"--no-plugin-reports".into())
                && args.contains(&"--local-admin".into()))
        );
    }

    #[cfg(unix)]
    fn diagnostic_command(root: &Path, content: &str) -> Result<std::path::PathBuf> {
        let executable = root.join("diagnostic-command");
        files::atomic_write(
            &executable,
            format!("#!/bin/sh\n{content}\n").as_bytes(),
            0o700,
        )?;
        Ok(executable)
    }

    #[cfg(unix)]
    #[test]
    fn doctor_failed_checks_keep_the_report_and_failure_status() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let (p, _) = fixture(temp.path())?;
        let executable = diagnostic_command(
            temp.path(),
            "printf '[FAIL] DSH executable is missing; install it first.\\n'; exit 1",
        )?;
        let error = subprocess_at(
            &p,
            &Request::new("diagnosis", "doctor", json!({})),
            &executable,
            false,
        )
        .err()
        .context("failed checks must remain a failed management operation")?;
        assert_eq!(error.code, "diagnostic_failed");
        assert_eq!(error.exit_code, Some(1));
        let response = response_error("diagnosis", error);
        assert!(!response.ok);
        let result = response
            .result
            .context("diagnostic findings must be retained")?;
        assert_eq!(result["exitCode"], 1);
        assert_eq!(result["truncated"], false);
        assert_eq!(
            result["text"],
            "[FAIL] DSH executable is missing; install it first.\n"
        );
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn command_failures_are_distinct_from_failed_doctor_checks() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let (p, _) = fixture(temp.path())?;
        for (operation, script) in [
            ("doctor", "exit 1"),
            (
                "doctor",
                "printf 'partial report'; printf 'cannot execute doctor' >&2; exit 1",
            ),
            ("doctor", "printf 'invalid invocation'; exit 2"),
            ("logs.tail", "printf 'partial logs'; exit 1"),
        ] {
            let executable = diagnostic_command(temp.path(), script)?;
            let error = subprocess_at(
                &p,
                &Request::new("failure", operation, json!({})),
                &executable,
                false,
            )
            .err()
            .context("a command failure must be rejected")?;
            assert_eq!(error.code, "operation_failed");
            assert!(error.result.is_none());
        }
        let unavailable = subprocess_at(
            &p,
            &Request::new("missing", "doctor", json!({})),
            &temp.path().join("missing-program"),
            false,
        )
        .err()
        .context("a missing program must be rejected")?;
        assert_eq!(unavailable.code, "command_unavailable");
        assert!(unavailable.result.is_none());
        Ok(())
    }

    #[test]
    fn diagnostic_text_fits_the_json_envelope_even_when_escaping_expands_it() -> Result<()> {
        for bytes in [
            vec![0; MAX_OUTPUT_BYTES],
            "诊断内容".repeat(MAX_OUTPUT_BYTES / 4).into_bytes(),
        ] {
            let result = text_result(
                Captured {
                    bytes,
                    truncated: false,
                },
                Some(1),
            )
            .map_err(|error| anyhow::anyhow!(error.message))?;
            assert_eq!(result["exitCode"], 1);
            assert_eq!(result["truncated"], true);
            let mut failure = failure(
                "diagnostic_failed",
                "Review the diagnostic findings.",
                false,
            );
            failure.result = Some(result);
            let response = response_error(&"r".repeat(128), failure);
            assert!(serde_json::to_vec(&response)?.len() < MAX_REQUEST_BYTES);
        }
        let normal = text_result(
            Captured {
                bytes: b"readable report\n".to_vec(),
                truncated: false,
            },
            Some(0),
        )
        .map_err(|error| anyhow::anyhow!(error.message))?;
        assert_eq!(
            normal,
            json!({"text":"readable report\n", "truncated":false, "exitCode":0})
        );
        Ok(())
    }
}
