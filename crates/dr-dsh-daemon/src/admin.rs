//! Opt-in local management, separate from the encrypted remote control protocol.
//!
//! Each private Unix socket connection carries one bounded JSON line and one
//! response. Local filesystem permissions and peer credentials are the authority;
//! neither a browser route nor the plugin report token grants administrative access.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context as _, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// The independent local management protocol version.
pub const VERSION: u16 = 1;
/// Maximum encoded request or response, excluding the newline.
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024;
/// Explicit service switch for local management. Absent means disabled.
pub const ENV_ENABLE: &str = "DSHD_ADMIN";
const IO_TIMEOUT: Duration = Duration::from_secs(5);
const OPERATION_TIMEOUT: Duration = Duration::from_secs(60);

/// One fixed management operation; parameters are validated by that operation.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    /// Local protocol version.
    pub version: u16,
    /// Client correlation identifier, at most 128 safe characters.
    pub request_id: String,
    /// Whitelisted operation name.
    pub operation: String,
    /// Operation-specific object, never logged.
    #[serde(default = "empty_object")]
    pub params: Value,
}

fn empty_object() -> Value {
    json!({})
}

impl Request {
    /// Constructs a version-one request.
    #[must_use]
    pub fn new(request_id: impl Into<String>, operation: impl Into<String>, params: Value) -> Self {
        Self {
            version: VERSION,
            request_id: request_id.into(),
            operation: operation.into(),
            params,
        }
    }
}

/// Safe structured failure. It never includes request payloads or credentials.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ErrorBody {
    /// Stable machine-readable reason.
    pub code: String,
    /// Human-readable cause and next step.
    pub message: String,
    /// Whether retrying unchanged may succeed.
    pub retryable: bool,
}

/// The single response envelope used by the plugin and the local CLI.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Response {
    /// Local protocol version.
    pub version: u16,
    /// Correlation identifier copied only from a validated request.
    pub request_id: String,
    /// Whether the operation succeeded.
    pub ok: bool,
    /// Safe result; a pairing code is returned only by `pair.begin`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    /// Failure details.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorBody>,
}

impl Response {
    /// Constructs a successful response.
    #[must_use]
    pub fn success(request_id: impl Into<String>, result: Value) -> Self {
        Self {
            version: VERSION,
            request_id: request_id.into(),
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    /// Constructs a safe failure response.
    #[must_use]
    pub fn failure(
        request_id: impl Into<String>,
        code: impl Into<String>,
        message: impl Into<String>,
        retryable: bool,
    ) -> Self {
        Self {
            version: VERSION,
            request_id: request_id.into(),
            ok: false,
            result: None,
            error: Some(ErrorBody {
                code: code.into(),
                message: message.into(),
                retryable,
            }),
        }
    }
}

// Requests and responses may contain a live pairing code, so Debug is deliberately
// not derived. A logging call must not turn local management into credential output.
impl std::fmt::Debug for Request {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AdminRequest([redacted])")
    }
}
impl std::fmt::Debug for Response {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AdminResponse([redacted])")
    }
}

/// Resolves the explicit local-management switch.
///
/// # Errors
/// Rejects settings other than `0` and `1`.
pub fn enabled_setting(cli: bool, environment: Option<&str>) -> Result<bool> {
    if cli {
        return Ok(true);
    }
    match environment {
        None | Some("0") => Ok(false),
        Some("1") => Ok(true),
        _ => bail!(
            "DSHD_ADMIN must be 1 (enable local management) or 0 (disable); correct the daemon service environment"
        ),
    }
}

/// Returns the stable socket path for a canonical state directory.
///
/// macOS limits Unix socket paths to 104 bytes. Long state paths use an owned
/// private directory below `/tmp`, named by uid and a hash of the canonical path.
/// No configuration or key is written there.
///
/// # Errors
/// Returns an error if the state directory cannot be resolved or Unix sockets are unavailable.
pub fn socket_path(directory: &Path) -> Result<PathBuf> {
    #[cfg(unix)]
    {
        use sha2::{Digest as _, Sha256};
        use std::os::unix::ffi::OsStrExt as _;
        let directory = std::fs::canonicalize(directory)
            .context("cannot locate daemon state; install or start the daemon first")?;
        let path = directory.join(".runtime/admin.sock");
        if path.as_os_str().as_bytes().len() < 100 {
            return Ok(path);
        }
        let digest = Sha256::digest(directory.as_os_str().as_bytes());
        let name: String = digest[..16]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Ok(PathBuf::from(format!(
            "/tmp/drdsh-{}",
            rustix::process::geteuid().as_raw()
        ))
        .join(format!("{name}.sock")))
    }
    #[cfg(not(unix))]
    {
        let _ = directory;
        bail!("local daemon management requires Unix sockets on macOS or Linux")
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.:".contains(&byte))
}

/// Checks the shared envelope before a local CLI or daemon dispatches an operation.
/// Returns a safe failure response when the request is invalid.
#[must_use]
pub fn validate_request(request: &Request) -> Option<Response> {
    let id = if valid_id(&request.request_id) {
        &request.request_id
    } else {
        ""
    };
    if !valid_id(&request.request_id) {
        Some(Response::failure(
            id,
            "invalid_request",
            "requestId must contain 1–128 letters, digits, dots, dashes, underscores or colons",
            false,
        ))
    } else if request.version != VERSION {
        Some(Response::failure(
            id,
            "unsupported_version",
            "this daemon supports local management version 1; update the local client",
            false,
        ))
    } else if request.operation.len() > 64 || !request.params.is_object() {
        Some(Response::failure(
            id,
            "invalid_request",
            "operation must be bounded and params must be a JSON object",
            false,
        ))
    } else {
        None
    }
}

fn encoded_line<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec(value)?;
    ensure!(
        bytes.len() <= MAX_MESSAGE_BYTES,
        "local management message exceeds 64 KiB; reduce the request or page the result"
    );
    bytes.push(b'\n');
    Ok(bytes)
}

/// Calls an already-running daemon; this never starts or reconfigures a service.
///
/// # Errors
/// Returns a connection, timeout or protocol error. An operation refusal is a normal response.
pub async fn call(directory: &Path, request: &Request) -> Result<Response> {
    #[cfg(unix)]
    {
        use tokio::io::AsyncWriteExt as _;
        if let Some(response) = validate_request(request) {
            return Ok(response);
        }
        let path = socket_path(directory)?;
        validate_socket(&path)?;
        let mut stream = tokio::time::timeout(IO_TIMEOUT, tokio::net::UnixStream::connect(&path)).await
            .context("local daemon management connection timed out; inspect daemon status")?
            .context("cannot connect to local daemon management; start it with DSHD_ADMIN=1 or --local-admin")?;
        verify_peer(&stream)?;
        let bytes = encoded_line(request)?;
        tokio::time::timeout(IO_TIMEOUT, stream.write_all(&bytes)).await??;
        let bytes = tokio::time::timeout(OPERATION_TIMEOUT + IO_TIMEOUT, read_line(&mut stream))
            .await
            .context("local daemon operation timed out; inspect its status before retrying")??;
        let response: Response = serde_json::from_slice(&bytes)
            .context("daemon returned an invalid local response; check version compatibility")?;
        ensure!(
            response.version == VERSION && response.request_id == request.request_id,
            "daemon returned a mismatched local response; reconnect and check versions"
        );
        Ok(response)
    }
    #[cfg(not(unix))]
    {
        let _ = (directory, request);
        bail!("local daemon management requires Unix sockets")
    }
}

/// Calls local management from an existing synchronous CLI entry point.
///
/// # Errors
/// Returns the same errors as [`call`].
pub fn call_blocking(directory: &Path, request: &Request) -> Result<Response> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(call(directory, request))
}

/// Whether a local socket is present. A malformed path is an error, not a fallback.
///
/// # Errors
/// Returns path or permission errors.
pub(crate) fn available(directory: &Path) -> Result<bool> {
    // A stale socket after a crash is not an online daemon. Never downgrade a
    // real IPC refusal to an offline mutation, however.
    #[cfg(unix)]
    if crate::state::FileLock::try_acquire(directory, "runtime.lock")?.is_some() {
        return Ok(false);
    }
    let path = socket_path(directory)?;
    match std::fs::symlink_metadata(&path) {
        Ok(_) => {
            validate_socket(&path)?;
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn cleanup_stale_socket(directory: &Path) -> Result<()> {
    let path = socket_path(directory)?;
    if std::fs::symlink_metadata(&path)
        .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    {
        return Ok(());
    }
    validate_socket(&path)?;
    std::fs::remove_file(path)?;
    Ok(())
}

fn result(response: Response) -> Result<Value> {
    if response.ok {
        return response.result.context("local daemon returned no result");
    }
    let error = response
        .error
        .context("local daemon returned an invalid error response")?;
    bail!("{}: {}", error.code, error.message)
}

pub(crate) async fn legacy_pair(
    directory: &Path,
    relay: Option<&str>,
    room_key: Option<&str>,
    wait: Option<Duration>,
) -> Result<std::process::ExitCode> {
    let mut params = serde_json::Map::new();
    if let Some(relay) = relay {
        params.insert("expectedRelay".into(), json!(relay));
    }
    if let Some(key) = room_key {
        params.insert(
            "expectedRoom".into(),
            json!(dr_dsh_crypto::room_id_for(&crate::decode_room_key(key)?)),
        );
    }
    if let Some(wait) = wait {
        params.insert("waitSeconds".into(), json!(wait.as_secs()));
    }
    let began = result(
        call(
            directory,
            &Request::new("legacy-pair-begin", "pair.begin", Value::Object(params)),
        )
        .await?,
    )?;
    let id = began["pairingId"]
        .as_str()
        .context("daemon returned no pairing identifier")?;
    println!(
        "drdshd {} — pairing through the running daemon",
        env!("CARGO_PKG_VERSION")
    );
    println!(
        "  code:  {}",
        began["code"].as_str().unwrap_or("unavailable")
    );
    println!(
        "  relay: {}",
        began["relay"].as_str().unwrap_or("unavailable")
    );
    println!(
        "  room:  {}",
        began["room"].as_str().unwrap_or("unavailable")
    );
    println!(
        "  valid: single use, expires at {} milliseconds since the Unix epoch",
        began["expiresAtMs"]
    );
    let interrupted = tokio::signal::ctrl_c();
    tokio::pin!(interrupted);
    loop {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(150)) => {}
            _ = &mut interrupted => {
                let _ = call(directory, &Request::new("legacy-pair-cancel", "pair.cancel", json!({"pairingId": id}))).await;
                eprintln!("pairing cancelled; its code can no longer be used");
                return Ok(std::process::ExitCode::FAILURE);
            }
        }
        let status = result(
            call(
                directory,
                &Request::new(
                    "legacy-pair-status",
                    "pair.status",
                    json!({"pairingId": id}),
                ),
            )
            .await?,
        )?;
        match status["state"].as_str() {
            Some("pending") => {}
            Some("complete") => {
                println!("paired {}", status["deviceId"].as_str().unwrap_or("device"));
                return Ok(std::process::ExitCode::SUCCESS);
            }
            _ => {
                eprintln!(
                    "pairing {}: {}",
                    status["state"].as_str().unwrap_or("failed"),
                    status["error"]["message"]
                        .as_str()
                        .unwrap_or("create a new code to retry")
                );
                return Ok(std::process::ExitCode::FAILURE);
            }
        }
    }
}

pub(crate) fn legacy_devices(
    directory: &Path,
    revoke: Option<&str>,
) -> Result<std::process::ExitCode> {
    let request = match revoke {
        Some(id) => Request::new("legacy-revoke", "devices.revoke", json!({"deviceId": id})),
        None => Request::new("legacy-devices", "devices.list", json!({})),
    };
    let response = result(call_blocking(directory, &request)?)?;
    if let Some(id) = revoke {
        if response["revoked"] == true {
            println!("revoked {id}; the running daemon invalidated its authorization");
        } else {
            println!("no device with id {id} is enrolled; nothing changed");
        }
    } else if let Some(devices) = response["devices"].as_array() {
        println!("{} device(s):", devices.len());
        for device in devices {
            println!(
                "  {}  {}",
                device["id"].as_str().unwrap_or("unknown"),
                device["label"].as_str().unwrap_or("")
            );
        }
    }
    Ok(std::process::ExitCode::SUCCESS)
}

#[cfg(unix)]
fn validate_socket(path: &Path) -> Result<()> {
    use std::os::unix::fs::{FileTypeExt as _, MetadataExt as _};
    let parent = path.parent().context("local socket has no parent")?;
    let metadata = std::fs::symlink_metadata(parent)?;
    ensure!(
        metadata.is_dir()
            && metadata.uid() == rustix::process::geteuid().as_raw()
            && metadata.mode() & 0o777 == 0o700,
        "local management directory must be owned by this user and mode 0700; repair its permissions"
    );
    let metadata = std::fs::symlink_metadata(path)?;
    ensure!(
        metadata.file_type().is_socket()
            && metadata.uid() == rustix::process::geteuid().as_raw()
            && metadata.mode() & 0o777 == 0o600,
        "local management endpoint must be an owned Unix socket with mode 0600; inspect the runtime directory"
    );
    Ok(())
}

#[cfg(unix)]
fn verify_peer(stream: &tokio::net::UnixStream) -> Result<()> {
    ensure!(
        stream.peer_cred()?.uid() == rustix::process::geteuid().as_raw(),
        "local management peer is not the current user"
    );
    Ok(())
}

#[cfg(unix)]
async fn read_line(stream: &mut tokio::net::UnixStream) -> Result<Vec<u8>> {
    use tokio::io::{AsyncBufReadExt as _, AsyncReadExt as _, BufReader};
    let mut bytes = Vec::new();
    let mut limited = BufReader::new(stream.take((MAX_MESSAGE_BYTES + 2) as u64));
    limited.read_until(b'\n', &mut bytes).await?;
    ensure!(
        bytes.last() == Some(&b'\n') && bytes.len() <= MAX_MESSAGE_BYTES + 1,
        "local management requires one JSON line of at most 64 KiB"
    );
    bytes.pop();
    Ok(bytes)
}

pub(crate) struct Context {
    pub(crate) facts: crate::control::DaemonFacts,
    pub(crate) registry: crate::registry::LiveRegistry,
    pub(crate) relay: Option<String>,
    pub(crate) root: Option<[u8; dr_dsh_crypto::SESSION_KEY_LEN]>,
    instance_id: String,
    pairing: Mutex<Option<PairSession>>,
}

impl Context {
    pub(crate) fn new(
        facts: crate::control::DaemonFacts,
        registry: crate::registry::LiveRegistry,
        relay: Option<String>,
        root: Option<[u8; dr_dsh_crypto::SESSION_KEY_LEN]>,
    ) -> Self {
        Self {
            facts,
            registry,
            relay,
            root,
            instance_id: format!("{:032x}", rand::random::<u128>()),
            pairing: Mutex::new(None),
        }
    }

    fn fail(
        &self,
        request: &Request,
        code: &str,
        message: impl Into<String>,
        retryable: bool,
    ) -> Response {
        Response::failure(&request.request_id, code, message, retryable)
    }

    async fn handle(self: &Arc<Self>, request: Request) -> Response {
        if let Some(response) = validate_request(&request) {
            return response;
        }
        let allowed: &[&str] = match request.operation.as_str() {
            "status" | "runtime.status" | "lifecycle.status" | "devices.list"
            | "lifecycle.start" | "lifecycle.stop" | "lifecycle.restart" => &[],
            "devices.revoke" => &["deviceId"],
            "pair.begin" => &["waitSeconds", "expectedRelay", "expectedRoom"],
            "pair.status" | "pair.cancel" => &["pairingId"],
            _ => &[],
        };
        if request
            .params
            .as_object()
            .is_some_and(|params| params.keys().any(|key| !allowed.contains(&key.as_str())))
        {
            return self.fail(
                &request,
                "invalid_params",
                "this operation received an unsupported parameter; check the local API schema",
                false,
            );
        }
        match request.operation.as_str() {
            "status" | "runtime.status" | "lifecycle.status" => Response::success(&request.request_id, json!({
                "instanceId": self.instance_id, "pid": std::process::id(), "stateDir": self.facts.state_dir,
                "localAdmin": true, "lifecycle": crate::control::status(&self.facts),
                "devices": self.registry.snapshot().devices(),
                "pairing": self.pairing.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(PairSession::status),
            })),
            "devices.list" => {
                self.registry.reload();
                Response::success(&request.request_id, self.registry.snapshot().devices())
            }
            "devices.revoke" => {
                let Some(id) = request.params.get("deviceId").and_then(Value::as_str) else {
                    return self.fail(&request, "invalid_params", "devices.revoke requires deviceId", false);
                };
                let Ok(device) = dr_dsh_crypto::DeviceId::from_base64url(id) else {
                    return self.fail(&request, "invalid_params", "deviceId is not a valid enrolled-device identifier", false);
                };
                match self.registry.revoke(&device) {
                    Ok(revoked) => {
                        crate::audit::record(&self.facts.state_dir, crate::audit::Event::DeviceRevoked, Some(id),
                            if revoked { crate::audit::Outcome::Ok } else { crate::audit::Outcome::Refused }, Some("local management revocation"));
                        Response::success(&request.request_id, json!({"revoked": revoked, "deviceId": id, "revision": self.registry.snapshot().revision}))
                    }
                    Err(_) => self.fail(&request, "registry_write_failed", "cannot update the device registry; inspect state-directory permissions and retry", true),
                }
            }
            "pair.begin" => self.begin_pairing(&request),
            "pair.status" | "pair.cancel" => self.pairing_status(&request),
            "lifecycle.start" | "lifecycle.stop" | "lifecycle.restart" => {
                let op = match request.operation.as_str() {
                    "lifecycle.start" => dr_dsh_proto::control::LifecycleOp::Start,
                    "lifecycle.stop" => dr_dsh_proto::control::LifecycleOp::Stop,
                    _ => dr_dsh_proto::control::LifecycleOp::Restart,
                };
                let result = self.facts.lifecycle.command(op).await;
                crate::audit::record(&self.facts.state_dir, crate::audit::Event::LifecycleCommand, None,
                    if result.ok { crate::audit::Outcome::Ok } else { crate::audit::Outcome::Refused }, Some("local management lifecycle command"));
                if result.ok {
                    Response::success(&request.request_id, serde_json::to_value(result).unwrap_or(Value::Null))
                } else {
                    self.fail(&request, "lifecycle_refused", result.error.unwrap_or_else(|| "DSH lifecycle operation failed; inspect daemon status and logs".to_owned()), false)
                }
            }
            _ => self.fail(&request, "unknown_operation", "this daemon does not support that local operation; check client and daemon versions", false),
        }
    }

    fn begin_pairing(self: &Arc<Self>, request: &Request) -> Response {
        let (Some(relay), Some(root)) = (&self.relay, self.root) else {
            return self.fail(
                request,
                "not_configured",
                "pairing requires a configured relay; save the daemon relay setting first",
                false,
            );
        };
        if request
            .params
            .get("expectedRelay")
            .and_then(Value::as_str)
            .is_some_and(|expected| expected != relay)
        {
            return self.fail(request, "configuration_mismatch", "the running daemon uses another relay; use its saved configuration or apply the relay change first", false);
        }
        if request
            .params
            .get("expectedRoom")
            .and_then(Value::as_str)
            .is_some_and(|expected| expected != dr_dsh_crypto::room_id_for(&root))
        {
            return self.fail(
                request,
                "configuration_mismatch",
                "the running daemon serves another room key; pair using its active configuration",
                false,
            );
        }
        let seconds = match request.params.get("waitSeconds") {
            None => crate::pairing::DEFAULT_EXCHANGE_TIMEOUT.as_secs(),
            Some(value) => match value.as_u64() {
                Some(seconds @ 1..=300) => seconds,
                _ => {
                    return self.fail(
                        request,
                        "invalid_params",
                        "waitSeconds must be an integer from 1 to 300",
                        false,
                    );
                }
            },
        };
        let mut session = self
            .pairing
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if session
            .as_ref()
            .is_some_and(|session| session.state == "pending")
        {
            return self.fail(
                request,
                "pairing_busy",
                "a pairing is already pending; complete or cancel it before creating another code",
                true,
            );
        }
        #[cfg(unix)]
        let lock = match crate::state::FileLock::try_acquire(&self.facts.state_dir, "pairing.lock") {
            Ok(Some(lock)) => lock,
            Ok(None) => return self.fail(request, "pairing_busy", "another local pairing is pending; finish or cancel it first", true),
            Err(_) => return self.fail(request, "state_unavailable", "cannot lock local pairing state; inspect state-directory ownership and permissions", false),
        };
        let guard_path = crate::state::throttle_path_in(&self.facts.state_dir);
        let guard = match dr_dsh_crypto::PairingGuard::load(&guard_path) {
            Ok(guard) => guard,
            Err(_) => {
                return self.fail(
                    request,
                    "state_unavailable",
                    "cannot read pairing throttle state; repair the state file before pairing",
                    false,
                );
            }
        };
        if let Err(error) = guard.check(std::time::SystemTime::now()) {
            return self.fail(request, "pairing_throttled", error.to_string(), true);
        }
        let code = dr_dsh_crypto::pairing::PairingCode::generate();
        let room = crate::pairing::pairing_room(&code);
        let pairing_id = format!("{:032x}", rand::random::<u128>());
        let expires_at_ms = now_ms().saturating_add(seconds * 1000);
        let result = json!({"pairingId": pairing_id, "code": code.display_form(), "room": room,
            "relay": relay, "expiresAtMs": expires_at_ms, "state": "pending"});
        let context = Arc::clone(self);
        let relay = relay.clone();
        let id = pairing_id.clone();
        let commit_gate = Arc::new(Mutex::new(CommitState::Pending));
        let committing = Arc::clone(&commit_gate);
        let task = tokio::spawn(async move {
            #[cfg(unix)]
            let _pairing_lock = lock;
            let path = crate::state::registry_path_in(&context.facts.state_dir);
            let outcome = crate::pairing::run_daemon_side_with_commit(
                &relay,
                &code,
                &root,
                Duration::from_secs(seconds),
                |key, label| {
                    // Cancellation and enrollment choose exactly one winner. Once the
                    // registry commit exists, cancel must never claim it did not happen.
                    let mut gate = committing.lock().unwrap_or_else(|error| error.into_inner());
                    if matches!(*gate, CommitState::Cancelled) {
                        return Err(crate::pairing::ExchangeError::Transport(
                            "pairing was cancelled locally".into(),
                        ));
                    }
                    let registry = crate::registry::enrol(&path, key, label).map_err(|error| {
                        crate::pairing::ExchangeError::Transport(format!(
                            "cannot commit the paired device: {error}"
                        ))
                    })?;
                    *gate = CommitState::Committed;
                    Ok(registry)
                },
            )
            .await;
            context.registry.reload();
            let mut guard = guard;
            let (state, error, device_id) = match outcome {
                Ok((device, _)) => {
                    guard.record_success();
                    crate::audit::record(
                        &context.facts.state_dir,
                        crate::audit::Event::PairingAccepted,
                        Some(&device.device_id),
                        crate::audit::Outcome::Ok,
                        Some("local management pairing"),
                    );
                    ("complete", None, Some(device.device_id))
                }
                Err(error) => {
                    let _ = guard.record_failure(std::time::SystemTime::now());
                    crate::audit::record(
                        &context.facts.state_dir,
                        crate::audit::Event::PairingFailed,
                        None,
                        crate::audit::Outcome::Failed,
                        Some("local management pairing did not complete"),
                    );
                    let state = if matches!(error, crate::pairing::ExchangeError::Timeout { .. }) {
                        "expired"
                    } else {
                        "failed"
                    };
                    (
                        state,
                        Some(ErrorBody {
                            code: "pairing_failed".into(),
                            message: format!(
                                "pairing did not complete: {error}; generate a new code to retry"
                            ),
                            retryable: true,
                        }),
                        None,
                    )
                }
            };
            let _ = guard.save(&guard_path);
            let mut slot = context
                .pairing
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if let Some(session) = slot
                .as_mut()
                .filter(|session| session.id == id && session.state == "pending")
            {
                session.state = state;
                session.error = error;
                session.device_id = device_id;
            }
        });
        *session = Some(PairSession {
            id: pairing_id,
            expires_at_ms,
            state: "pending",
            error: None,
            device_id: None,
            task: task.abort_handle(),
            commit_gate,
        });
        Response::success(&request.request_id, result)
    }

    fn pairing_status(&self, request: &Request) -> Response {
        let Some(id) = request.params.get("pairingId").and_then(Value::as_str) else {
            return self.fail(
                request,
                "invalid_params",
                "pairingId is required to inspect or cancel a pairing",
                false,
            );
        };
        let mut session = self
            .pairing
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let Some(session) = session.as_mut().filter(|session| session.id == id) else {
            return self.fail(
                request,
                "pairing_not_found",
                "that pairing is no longer available; create a new pairing code",
                false,
            );
        };
        if request.operation == "pair.cancel" && session.state == "pending" {
            let mut gate = session
                .commit_gate
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if matches!(*gate, CommitState::Committed) {
                return self.fail(request, "pairing_already_committed", "the device enrollment was already committed; wait for completion or revoke the device", false);
            }
            *gate = CommitState::Cancelled;
            session.task.abort();
            session.state = "cancelled";
        }
        Response::success(&request.request_id, session.status())
    }

    fn cancel_pairing(&self) {
        if let Some(session) = self
            .pairing
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_mut()
        {
            session.task.abort();
            if session.state == "pending" {
                session.state = "cancelled";
            }
        }
    }
}

struct PairSession {
    id: String,
    expires_at_ms: u64,
    state: &'static str,
    error: Option<ErrorBody>,
    device_id: Option<String>,
    task: tokio::task::AbortHandle,
    commit_gate: Arc<Mutex<CommitState>>,
}

enum CommitState {
    Pending,
    Committed,
    Cancelled,
}

impl PairSession {
    fn status(&self) -> Value {
        json!({"pairingId": self.id, "expiresAtMs": self.expires_at_ms,
        "state": self.state, "deviceId": self.device_id, "error": self.error})
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

pub(crate) struct Server {
    path: PathBuf,
    context: Arc<Context>,
    task: tokio::task::JoinHandle<()>,
}

impl Server {
    #[cfg(unix)]
    pub(crate) async fn start(context: Context) -> Result<Self> {
        use std::os::unix::fs::{FileTypeExt as _, MetadataExt as _, PermissionsExt as _};
        let path = socket_path(&context.facts.state_dir)?;
        crate::state::private_directory(path.parent().context("local socket has no parent")?)?;
        // The caller holds the runtime lock. Only its own stale socket is removable.
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) => {
                ensure!(
                    metadata.file_type().is_socket()
                        && metadata.uid() == rustix::process::geteuid().as_raw(),
                    "refusing to replace a non-owned local management socket; inspect the runtime path"
                );
                std::fs::remove_file(&path)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let listener = tokio::net::UnixListener::bind(&path).context(
            "cannot bind local management socket; inspect runtime directory permissions",
        )?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        let context = Arc::new(context);
        let serving = Arc::clone(&context);
        let task = tokio::spawn(async move {
            let slots = Arc::new(tokio::sync::Semaphore::new(16));
            let mut handlers = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((mut stream, _)) = accepted else { break; };
                        let Ok(permit) = Arc::clone(&slots).try_acquire_owned() else { continue; };
                        let serving = Arc::clone(&serving);
                        handlers.spawn(async move {
                            let _permit = permit;
                            if verify_peer(&stream).is_err() { return; }
                            let response = match tokio::time::timeout(IO_TIMEOUT, read_line(&mut stream)).await {
                                Ok(Ok(bytes)) => match serde_json::from_slice::<Request>(&bytes) {
                                    Ok(request) => {
                                        let id = if valid_id(&request.request_id) { request.request_id.clone() } else { String::new() };
                                        match tokio::time::timeout(OPERATION_TIMEOUT, serving.handle(request)).await {
                                            Ok(response) => response,
                                            Err(_) => Response::failure(id, "operation_timeout", "local operation is taking too long; check its status before retrying", true),
                                        }
                                    }
                                    Err(_) => Response::failure("", "invalid_request", "expected one versioned local-management JSON object; request contents were not logged", false),
                                },
                                Ok(Err(_)) => Response::failure("", "message_too_large", "send one newline-terminated JSON request of at most 64 KiB", false),
                                Err(_) => Response::failure("", "request_timeout", "local request was not received within 5 seconds", true),
                            };
                            let bytes = encoded_line(&response).or_else(|_| encoded_line(&Response::failure(&response.request_id, "response_too_large", "local result exceeds 64 KiB; reduce stored metadata before retrying", false)));
                            if let Ok(bytes) = bytes {
                                use tokio::io::AsyncWriteExt as _;
                                let _ = tokio::time::timeout(IO_TIMEOUT, stream.write_all(&bytes)).await;
                            }
                        });
                    }
                    _ = handlers.join_next(), if !handlers.is_empty() => {}
                }
            }
        });
        Ok(Self {
            path,
            context,
            task,
        })
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.context.cancel_pairing();
        self.task.abort();
        #[cfg(unix)]
        if validate_socket(&self.path).is_ok() {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt as _;
    type TestResult = Result<(), Box<dyn std::error::Error>>;

    #[tokio::test]
    async fn private_socket_enforces_the_versioned_bounded_protocol() -> TestResult {
        let directory = tempfile::tempdir()?;
        let _lock = crate::state::FileLock::try_acquire(directory.path(), "runtime.lock")?;
        let registry = crate::registry::LiveRegistry::open(directory.path())?;
        let (lifecycle, _driver) = crate::lifecycle::channel(
            crate::lifecycle::Mode::Attached { port: 3080 },
            crate::lifecycle::RestartPolicy::default(),
        );
        let facts = crate::control::DaemonFacts {
            owned: false,
            lifecycle,
            state_dir: directory.path().to_path_buf(),
            relay: Arc::new(Mutex::new(crate::uplink::RelayState::Connected)),
        };
        let server = Server::start(Context::new(facts, registry, None, None)).await?;
        let path = socket_path(directory.path())?;
        assert_eq!(
            std::fs::metadata(&path)?.permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(path.parent().ok_or("no parent")?)?
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        let response = call(
            directory.path(),
            &Request::new("status-1", "status", json!({})),
        )
        .await?;
        assert!(response.ok);
        assert_eq!(response.result.ok_or("no result")?["localAdmin"], true);
        let response = call(
            directory.path(),
            &Request::new("bad-op", "shell.exec", json!({})),
        )
        .await?;
        assert_eq!(response.error.ok_or("no error")?.code, "unknown_operation");
        let response = call(
            directory.path(),
            &Request::new("stop", "lifecycle.stop", json!({})),
        )
        .await?;
        assert_eq!(response.error.ok_or("no error")?.code, "lifecycle_refused");
        use tokio::io::AsyncWriteExt as _;
        let mut socket = tokio::net::UnixStream::connect(&path).await?;
        socket
            .write_all(
                b"{\"version\":2,\"requestId\":\"v2\",\"operation\":\"status\",\"params\":{}}\n",
            )
            .await?;
        let bytes = read_line(&mut socket).await?;
        let response: Response = serde_json::from_slice(&bytes)?;
        assert_eq!(
            response.error.ok_or("no error")?.code,
            "unsupported_version"
        );
        let mut socket = tokio::net::UnixStream::connect(&path).await?;
        // Leave bytes unread on the peer: Linux may reset after the refusal, so
        // clients must finish at its newline instead of waiting for EOF.
        socket
            .write_all(&vec![b'x'; MAX_MESSAGE_BYTES + 4096])
            .await?;
        let response: Response = serde_json::from_slice(&read_line(&mut socket).await?)?;
        assert_eq!(response.error.ok_or("no error")?.code, "message_too_large");
        let response = call(
            directory.path(),
            &Request::new("after-oversize", "status", json!({})),
        )
        .await?;
        assert!(response.ok);
        drop(server);
        assert!(!path.exists());
        Ok(())
    }

    #[test]
    fn long_state_paths_have_a_stable_short_socket_name() -> TestResult {
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("long-state-directory-".repeat(8));
        std::fs::create_dir(&path)?;
        let first = socket_path(&path)?;
        assert_eq!(first, socket_path(&path.join("."))?);
        assert!(first.to_string_lossy().len() < 100);
        Ok(())
    }
}
