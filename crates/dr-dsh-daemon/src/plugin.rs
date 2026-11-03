//! A tunnel owned by a running DSH plugin, without an installed daemon service.
//!
//! The parent's stdin pipe carries the launch capability and owns the lifetime.
//! EOF therefore closes the tunnel even when DSH is killed without disposing plugins.

use std::io::{BufRead as _, Read as _, Write as _};
use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{Context as _, ensure};
use serde::Deserialize;

const MAX_REQUEST: u64 = 16 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    version: u8,
    relay_url: String,
    state_dir: PathBuf,
    port: u16,
    token: String,
    #[serde(default)]
    tls: bool,
}

pub(crate) struct Bridge {
    pub state_dir: PathBuf,
    pub parent_closed: tokio::sync::oneshot::Receiver<()>,
}

fn parse(bytes: &[u8]) -> anyhow::Result<Request> {
    ensure!(
        bytes.len() <= MAX_REQUEST as usize,
        "Plugin connection request is too large; reinstall a matching plugin and native bundle."
    );
    // Serde diagnostics can quote unknown field names. Never attach the raw
    // parse error to a capability-bearing request.
    let request: Request = serde_json::from_slice(bytes).map_err(|_| {
        anyhow::anyhow!(
            "Invalid plugin connection request; reinstall a matching plugin and native bundle."
        )
    })?;
    ensure!(
        request.version == 1 && request.port != 0,
        "Unsupported plugin connection version or port; check the installed DSH/plugin versions."
    );
    ensure!(
        request.state_dir.is_absolute(),
        "Plugin state directory must be absolute; select private local plugin storage."
    );
    ensure!(
        !request.token.is_empty()
            && request.token.len() <= 4096
            && !request.token.chars().any(char::is_control),
        "Plugin did not supply a usable DSH process capability; restart the local DSH host."
    );
    let relay: hyper::Uri = request
        .relay_url
        .parse()
        .map_err(|_| anyhow::anyhow!("Plugin relay URL is invalid; configure a relay origin."))?;
    ensure!(
        matches!(relay.scheme_str(), Some("http" | "https" | "ws" | "wss"))
            && relay
                .authority()
                .is_some_and(|authority| !authority.as_str().contains('@'))
            && relay
                .path_and_query()
                .is_none_or(|path| path.as_str() == "/")
            && !request.relay_url.contains('#'),
        "Plugin relay URL must be an HTTP(S) or WS(S) origin without credentials, path, query or fragment."
    );
    crate::transport::parking_url(&request.relay_url, dr_dsh_crypto::Role::Daemon)
        .map_err(|_| anyhow::anyhow!("Plugin relay URL is invalid; configure a ws:// or wss:// relay origin without credentials, query or fragment."))?;
    Ok(request)
}

/// Runs the plugin's pipe-scoped native connection. This never starts or stops DSH.
///
/// # Errors
/// Rejects malformed private input, unsafe state storage and failed authentication.
pub fn run() -> anyhow::Result<ExitCode> {
    let mut input = std::io::BufReader::new(std::io::stdin());
    let mut bytes = Vec::new();
    (&mut input)
        .take(MAX_REQUEST + 1)
        .read_until(b'\n', &mut bytes)
        .context("Cannot read plugin connection pipe; restart the local DSH host.")?;
    let request = parse(&bytes)?;
    #[cfg(unix)]
    crate::state::private_directory(&request.state_dir).context(
        "Plugin connection storage must be a private 0700 directory owned by this user.",
    )?;
    let (closed, parent_closed) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        // There are no further input messages in version 1. EOF, pipe failure,
        // or unexpected input all revoke this connection's lifetime.
        let _ = input.read(&mut [0_u8; 1]);
        let _ = closed.send(());
    });
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(crate::run_endpoint(
        None,
        Some(&request.relay_url),
        None,
        None,
        Some(request.port),
        Some(&request.token),
        request.tls,
        true,
        true,
        Some(Bridge {
            state_dir: request.state_dir,
            parent_closed,
        }),
    ))
}

pub(crate) fn announce_ready(
    reports: Option<&crate::reports::Credentials>,
    root: Option<&[u8; dr_dsh_crypto::SESSION_KEY_LEN]>,
) -> anyhow::Result<()> {
    let mut value = reports
        .context("Plugin report listener was not initialized; restart the local DSH host.")?
        .pipe_value();
    value["version"] = 1.into();
    value["ready"] = true.into();
    value["roomId"] = dr_dsh_crypto::room_id_for(
        root.context("Plugin relay room was not initialized; check its relay configuration.")?,
    )
    .to_string()
    .into();
    let mut output = std::io::stdout().lock();
    serde_json::to_writer(&mut output, &value)?;
    writeln!(output)?;
    output.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::parse;

    fn request() -> serde_json::Value {
        serde_json::json!({"version":1,"relayUrl":"wss://relay.example","stateDir":"/tmp/plugin-state","port":3080,"token":"private-capability"})
    }

    #[test]
    fn pipe_request_is_closed_and_errors_do_not_echo_capabilities() -> anyhow::Result<()> {
        assert!(parse(&serde_json::to_vec(&request())?).is_ok());
        for (field, value) in [
            ("version", serde_json::json!(2)),
            ("port", serde_json::json!(0)),
            ("stateDir", serde_json::json!("relative")),
            (
                "relayUrl",
                serde_json::json!("https://user:secret@relay.example/?token=secret"),
            ),
            ("token", serde_json::json!("private-capability\n")),
            ("private-capability", serde_json::json!(true)),
        ] {
            let mut input = request();
            input[field] = value;
            let error = parse(&serde_json::to_vec(&input)?)
                .err()
                .ok_or_else(|| anyhow::anyhow!("invalid request accepted"))?;
            assert!(!error.to_string().contains("private-capability"));
            assert!(!error.to_string().contains("secret"));
        }
        assert!(parse(&vec![b'x'; 16385]).is_err());
        Ok(())
    }
}
