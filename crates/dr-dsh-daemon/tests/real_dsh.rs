//! The DSH contract test: runs against a **real** harness, when one is present.
//!
//! `tests/supervise.rs` proves the daemon's logic with a stand-in. This file
//! proves something different and easy to lose: that the facts recorded in
//! `docs/integration/dsh-surface.md` are still true of the real thing. Those
//! facts are assumptions we cannot derive from our own code — the readiness line's
//! shape, the token exchange's status and cookie, and the loopback host fence —
//! and when upstream changes one, a silent break here becomes a confusing product
//! failure much later.
//!
//! ## Running it
//!
//! It is `#[ignore]`d because it needs a DSH installation and binds a real port.
//! Point it at a harness in either of two ways:
//!
//! ```sh
//! DSH_BIN=/path/to/dsh cargo test -p dr-dsh-daemon --test real_dsh -- --ignored --nocapture
//! DSH_BIN="node /path/to/deepseek-harness/apps/cli/lib/bin.js" \
//!   cargo test -p dr-dsh-daemon --test real_dsh -- --ignored --nocapture
//! ```
//!
//! With no `DSH_BIN`, the test looks for `dsh` on `PATH` and reports a skip. It
//! never fails merely because no harness is installed: a test that fails for
//! environmental reasons trains people to ignore it.
//!
//! ## What it asserts, and why each line matters
//!
//! Every assertion below is a claim this project depends on, and each one has a
//! user-visible consequence when it stops holding. See
//! `docs/integration/dsh-surface.md` § 7 for the full upgrade ritual.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use dr_dsh_daemon::dsh::{DshClient, Supervisor, SupervisorConfig};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

/// A port unlikely to collide with a DSH the developer is actually using.
const TEST_PORT: u16 = 46131;

/// Builds the command the daemon will run, honouring `DSH_BIN`.
///
/// `DSH_BIN` may contain arguments (`"node /path/to/bin.js"`), because a DSH
/// checkout is run through Node rather than through an installed binary. Those
/// extra words are turned into a generated wrapper script, so the supervisor's own
/// command line stays exactly what production uses.
fn harness_command() -> Option<PathBuf> {
    let spec = match std::env::var("DSH_BIN") {
        Ok(value) if !value.trim().is_empty() => value,
        // Fall back to `dsh` on PATH; report a skip when it is not there.
        _ => {
            let probe = std::process::Command::new("dsh")
                .arg("--version")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            return match probe {
                Ok(status) if status.success() => Some(PathBuf::from("dsh")),
                _ => None,
            };
        }
    };

    let mut words = spec.split_whitespace();
    let program = words.next()?;
    let rest: Vec<&str> = words.collect();
    if rest.is_empty() {
        return Some(PathBuf::from(program));
    }
    let directory = std::env::temp_dir().join("drdshd-real-dsh-test");
    std::fs::create_dir_all(&directory).ok()?;
    let wrapper = directory.join("dsh-wrapper.sh");
    let quoted = rest
        .iter()
        .map(|word| format!("'{}'", word.replace('\'', "'\\''")))
        .collect::<Vec<_>>()
        .join(" ");
    std::fs::write(
        &wrapper,
        format!("#!/bin/sh\nexec {program} {quoted} \"$@\"\n"),
    )
    .ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mut permissions = std::fs::metadata(&wrapper).ok()?.permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&wrapper, permissions).ok()?;
    }
    Some(wrapper)
}

#[tokio::test]
#[ignore = "needs a DSH installation; run with --ignored and DSH_BIN=<harness>"]
async fn the_documented_dsh_contract_still_holds() -> Result<(), Box<dyn std::error::Error>> {
    let Some(executable) = harness_command() else {
        eprintln!("skipped: no DSH found (set DSH_BIN=/path/to/dsh to run this test)");
        return Ok(());
    };

    let config = SupervisorConfig {
        executable,
        port: TEST_PORT,
    };
    let mut supervisor = Supervisor::start(config).await?;
    let ready = supervisor.ready().clone();

    // 1. The readiness line yields a loopback address, a port we chose, and a token.
    assert_eq!(
        ready.addr.to_string(),
        "127.0.0.1",
        "DSH must bind loopback"
    );
    assert_eq!(ready.port, TEST_PORT, "DSH must honour --port");
    assert!(
        !ready.token.is_empty(),
        "the readiness line must carry a token"
    );
    assert!(
        ready.lan_url.is_none(),
        "a loopback bind must not advertise a LAN URL; got {:?}",
        ready.lan_url
    );
    eprintln!(
        "ready line parsed: authority={} token_len={}",
        ready.authority(),
        ready.token.len()
    );

    // 2. The index is refused before the token exchange. If this starts returning
    //    200, DSH's browser fence has been removed and docs/security.md § 2.5 no
    //    longer describes reality.
    let mut client = DshClient::new(&ready.base_url)?;
    let unauthorized = client.get("/").await?;
    assert_eq!(
        unauthorized.status.as_u16(),
        401,
        "the index must require authentication; body: {}",
        unauthorized.text()
    );
    assert!(
        unauthorized.text().contains("authentication required"),
        "the documented 401 body changed: {}",
        unauthorized.text()
    );

    // 3. The token exchange is a redirect carrying the authority-bound cookie.
    client.authenticate(&ready.token).await?;
    assert!(
        client.is_authenticated(),
        "the exchange must yield a session cookie"
    );

    // 4. The authenticated index works, and proves DSH accepted our authority.
    let index = client.get("/").await?;
    assert_eq!(
        index.status.as_u16(),
        200,
        "authenticated index: {}",
        index.text()
    );
    assert!(
        index.text().contains("__DSH_BOOT__"),
        "the index must still boot the client application"
    );

    // 5. The `/api` RPC endpoint answers in the documented envelope. A 404 here
    //    means the route shape moved; see docs/integration/dsh-surface.md § 3.
    let api = client
        .post_json(
            "/api/session/list",
            r#"{"type":"client-request","rpcId":"1","method":"list","payload":{"args":[{}]}}"#,
        )
        .await?;
    assert_ne!(api.status.as_u16(), 404, "the /api endpoint shape changed");
    assert!(
        api.text().contains("server-response"),
        "the RPC envelope changed: {}",
        api.text()
    );

    supervisor.stop().await?;
    assert!(!supervisor.is_running()?, "SIGTERM must stop DSH");
    eprintln!("the documented DSH contract holds");
    Ok(())
}

#[tokio::test]
#[ignore = "needs a DSH installation; run with --ignored and DSH_BIN=<harness>"]
async fn a_foreign_authority_is_refused_even_with_a_valid_cookie()
-> Result<(), Box<dyn std::error::Error>> {
    // The single most important upstream fact for this project: the browser
    // credential is bound to the authority it was minted under, so a reverse proxy
    // that forwards a foreign Host cannot work (`docs/security.md` § 2.5,
    // `docs/decisions/0003-no-fork-integration.md`).
    //
    // This is asserted at the raw HTTP level on purpose. `DshClient` pins `Host` to
    // the authority it was built with and exposes no way to forge one — that is the
    // property we want in the client — so the only honest way to show the fence
    // exists is to speak to DSH directly over a socket and try to bypass it.

    let Some(executable) = harness_command() else {
        eprintln!("skipped: no DSH found (set DSH_BIN=/path/to/dsh to run this test)");
        return Ok(());
    };

    let config = SupervisorConfig {
        executable,
        port: TEST_PORT + 1,
    };
    let mut supervisor = Supervisor::start(config).await?;
    let ready = supervisor.ready().clone();
    let mut client = DshClient::new(&ready.base_url)?;
    client.authenticate(&ready.token).await?;

    // Obtain the cookie exactly as a browser would: read the `Set-Cookie` from the
    // token exchange. Done over a raw socket so the whole exchange is visible here.
    let cookie = raw_token_exchange(ready.port, &ready.token).await?;
    eprintln!(
        "raw exchange yielded a cookie named {}",
        cookie.split('=').next().unwrap_or("?")
    );

    // (a) The cookie works when presented under the authority it was minted for.
    let accepted = raw_get(ready.port, &ready.authority(), &cookie).await?;
    assert!(
        accepted.starts_with("HTTP/1.1 200"),
        "loopback authority must work: {}",
        head(&accepted)
    );

    // (b) Even the *same host without the port* is a different authority, and is
    //     refused. This is the exact trap a proxy implementation falls into: it is
    //     easy to forward a host and lose the port, and the failure is a 401 that
    //     looks like "the cookie expired".
    let missing_port = raw_get(ready.port, "127.0.0.1", &cookie).await?;
    assert!(
        missing_port.starts_with("HTTP/1.1 401"),
        "an authority without the port is a different authority; got: {}",
        head(&missing_port)
    );

    // (c) The same cookie is refused under a foreign Host. This is DSH's
    //     DNS-rebinding fence doing its job, and the reason a plain reverse proxy
    //     cannot serve the remote UI.
    let refused = raw_get(ready.port, "relay.example", &cookie).await?;
    assert!(
        refused.starts_with("HTTP/1.1 401"),
        "a foreign authority must be refused; got: {}",
        head(&refused)
    );
    eprintln!("foreign authority refused with {}", head(&refused));

    supervisor.stop().await?;
    Ok(())
}

/// First line of an HTTP response, for messages.
fn head(response: &str) -> &str {
    response.lines().next().unwrap_or("<empty>")
}

/// Performs `GET /?token=…` over a raw socket and returns the `Set-Cookie` pair.
async fn raw_token_exchange(port: u16, token: &str) -> Result<String, Box<dyn std::error::Error>> {
    let request = format!(
        "GET /?token={token} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    let response = raw_request(port, &request).await?;
    assert!(
        response.starts_with("HTTP/1.1 303"),
        "the token exchange must redirect; got: {}",
        head(&response)
    );
    let cookie = response
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("set-cookie")
                .then(|| value.trim().to_owned())
        })
        .ok_or("the token exchange returned no Set-Cookie")?;
    Ok(cookie
        .split(';')
        .next()
        .unwrap_or(&cookie)
        .trim()
        .to_owned())
}

/// Sends `GET /` with a chosen `Host` and the cookie, returning the raw response.
async fn raw_get(
    port: u16,
    authority: &str,
    cookie: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    let request = format!(
        "GET / HTTP/1.1\r\nHost: {authority}\r\nCookie: {cookie}\r\nConnection: close\r\n\r\n"
    );
    raw_request(port, &request).await
}

/// Writes one HTTP/1.1 request to loopback and reads the whole response.
///
/// `Connection: close` is what makes this simple: DSH ends the response by closing
/// the socket, so a single read loop suffices without parsing `Content-Length` or
/// chunked framing.
async fn raw_request(port: u16, request: &str) -> Result<String, Box<dyn std::error::Error>> {
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await?;
    stream.write_all(request.as_bytes()).await?;
    stream.flush().await?;
    let mut buffer = Vec::new();
    tokio::time::timeout(Duration::from_secs(10), stream.read_to_end(&mut buffer)).await??;
    Ok(String::from_utf8_lossy(&buffer).into_owned())
}

#[tokio::test]
#[ignore = "needs a DSH installation; run with --ignored"]
async fn the_stop_path_is_graceful() -> Result<(), Box<dyn std::error::Error>> {
    // DSH disposes its plugin tree on SIGTERM. The daemon relies on that to avoid
    // interrupting a session mid-turn, so the observable claim is simply that the
    // child exits and releases the port within the grace window.
    let Some(executable) = harness_command() else {
        eprintln!("skipped: no DSH found (set DSH_BIN=/path/to/dsh to run this test)");
        return Ok(());
    };

    let config = SupervisorConfig {
        executable,
        port: TEST_PORT + 2,
    };
    let mut supervisor = Supervisor::start(config).await?;
    assert!(supervisor.is_running()?);

    let started = std::time::Instant::now();
    supervisor.stop().await?;
    let elapsed = started.elapsed();
    assert!(!supervisor.is_running()?, "DSH must be gone after stop()");
    assert!(
        elapsed < Duration::from_secs(20),
        "graceful stop took {elapsed:?}, which suggests SIGTERM was ignored"
    );
    eprintln!("graceful stop took {elapsed:?}");
    Ok(())
}
