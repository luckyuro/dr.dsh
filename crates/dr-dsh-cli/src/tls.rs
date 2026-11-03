//! TLS termination belongs to the CLI host, outside the zero-knowledge relay crate.

#[cfg(feature = "relay")]
pub(crate) fn run_relay(
    config: dr_dsh_relay::config::Config,
    cert: &std::path::Path,
    key: &std::path::Path,
) -> anyhow::Result<std::process::ExitCode> {
    use anyhow::Context;

    let tls = dr_dsh_tls::server_config(cert, key)?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("Cannot start the relay TLS runtime; check available system resources.")?;
    runtime.block_on(async move {
        tracing_subscriber::fmt()
            .with_env_filter(
                tracing_subscriber::EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
            )
            .init();
        let tcp = tokio::net::TcpListener::bind(config.bind)
            .await
            .with_context(|| {
                format!(
                    "Cannot bind relay TLS listener at {}; choose an available address and port.",
                    config.bind
                )
            })?;
        let ingress = dr_dsh_relay::ingress::Ingress::with_keepalive(
            config.max_rooms,
            dr_dsh_relay::assets::Assets::new(config.client_dir),
            config.keepalive,
        );
        println!("drdsh relay — HTTPS/WSS listening on {}", tcp.local_addr()?);
        axum::serve(dr_dsh_tls::TlsListener::new(tcp, tls), ingress.router())
            .with_graceful_shutdown(shutdown())
            .await
            .context("Relay HTTPS listener stopped unexpectedly; inspect the service logs.")?;
        Ok(std::process::ExitCode::SUCCESS)
    })
}

#[cfg(feature = "relay")]
async fn shutdown() {
    #[cfg(unix)]
    {
        if let Ok(mut term) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            tokio::select! {
                _ = term.recv() => {},
                _ = tokio::signal::ctrl_c() => {},
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}
