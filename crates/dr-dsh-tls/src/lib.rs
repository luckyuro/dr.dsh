//! TLS transport shared by the CLI host and daemon, never linked by the relay crate.

use std::{net::SocketAddr, path::Path, sync::Arc, time::Duration};

use anyhow::{Context, Result, ensure};
use futures_util::{StreamExt, future::BoxFuture, stream::FuturesUnordered};
use rustls::{
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::{WebPkiSupportedAlgorithms, verify_tls12_signature, verify_tls13_signature},
    pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime, pem::PemObject},
};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::{TlsAcceptor, server::TlsStream};

/// Optional additional PEM trust anchors, scoped to dr.dsh clients.
pub const ENV_CA_CERT: &str = "DRDSH_CA_CERT";
/// Explicit opt-out from certificate identity checks, scoped to dr.dsh clients.
pub const ENV_TLS_INSECURE: &str = "DRDSH_TLS_INSECURE";

/// Loads a nonempty PEM certificate chain without exposing its contents in errors.
pub fn certificates(path: &Path) -> Result<Vec<CertificateDer<'static>>> {
    let certs = CertificateDer::pem_file_iter(path)
        .with_context(|| {
            format!(
                "Cannot read TLS certificates at {}; check the PEM file and permissions.",
                path.display()
            )
        })?
        .collect::<Result<Vec<_>, _>>()
        .context("Cannot parse TLS certificates; provide a PEM certificate chain.")?;
    ensure!(
        !certs.is_empty(),
        "TLS certificate file is empty; provide a PEM certificate chain."
    );
    Ok(certs)
}

/// Builds a client that verifies certificates unless `DRDSH_TLS_INSECURE=1` is set.
///
/// `SSL_CERT_FILE` / `SSL_CERT_DIR` retain rustls-native-certs' override semantics.
/// An explicit CA or `DRDSH_CA_CERT` adds private roots to that trust store.
pub fn client_config(ca: Option<&Path>) -> Result<rustls::ClientConfig> {
    client_config_with_options(ca, None)
}

/// A saved or command-line choice overrides the environment. Skipping identity
/// checks does not skip TLS handshake signatures or allow plaintext fallback.
pub fn client_config_with_options(
    ca: Option<&Path>,
    insecure: Option<bool>,
) -> Result<rustls::ClientConfig> {
    let insecure = match insecure {
        Some(value) => value,
        None => match std::env::var(ENV_TLS_INSECURE) {
            Ok(value) if value == "1" => true,
            Ok(value) if value == "0" => false,
            Err(std::env::VarError::NotPresent) => false,
            _ => anyhow::bail!(
                "Invalid DRDSH_TLS_INSECURE for the TLS client; set 1 to skip certificate verification or 0 to verify."
            ),
        },
    };
    if insecure {
        // No trust store is required in this explicit mode, including on hosts
        // with missing CA files. Signature checks still parse the peer's key.
        let verifier = SkipServerIdentityVerification {
            algorithms: rustls::crypto::ring::default_provider().signature_verification_algorithms,
        };
        return Ok(rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(verifier))
            .with_no_client_auth());
    }
    let native = rustls_native_certs::load_native_certs();
    let mut roots = rustls::RootCertStore::empty();
    roots.add_parsable_certificates(native.certs);
    let env_ca = std::env::var_os(ENV_CA_CERT).map(std::path::PathBuf::from);
    if let Some(path) = ca.or(env_ca.as_deref()) {
        for cert in certificates(path)? {
            roots
                .add(cert)
                .context("Invalid TLS CA certificate; supply a valid PEM trust anchor.")?;
        }
    }
    ensure!(
        !roots.is_empty(),
        "No trusted TLS roots could be loaded; install system CA certificates or set DRDSH_CA_CERT to a PEM CA file."
    );
    Ok(client_with_roots(roots))
}

#[derive(Debug)]
struct SkipServerIdentityVerification {
    algorithms: WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for SkipServerIdentityVerification {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

/// Creates a connector configuration for a plain HTTP origin without loading CA files.
/// An accidental TLS request will fail because this configuration trusts no certificates.
#[must_use]
pub fn untrusted_client_config() -> rustls::ClientConfig {
    client_with_roots(rustls::RootCertStore::empty())
}

fn client_with_roots(roots: rustls::RootCertStore) -> rustls::ClientConfig {
    // Selecting ring explicitly preserves the musl release toolchain and old-CPU baseline.
    rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth()
}

/// Validates a PEM certificate chain and matching unencrypted private key at startup.
pub fn server_config(cert: &Path, key: &Path) -> Result<rustls::ServerConfig> {
    let certs = certificates(cert)?;
    let key = PrivateKeyDer::from_pem_file(key).context(
        "Cannot load TLS private key; check its path, permissions and unencrypted PEM format.",
    )?;
    let mut config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .context("TLS certificate and private key do not match or are invalid; replace the configured pair.")?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(config)
}

type Handshake = BoxFuture<'static, Option<(TlsStream<TcpStream>, SocketAddr)>>;

/// An axum listener with bounded, concurrent TLS handshakes.
///
/// Handshakes must not block accepting other clients: a silent TCP peer otherwise
/// stalls the whole relay. Both pending handshakes and their lifetimes are bounded.
pub struct TlsListener {
    tcp: TcpListener,
    acceptor: TlsAcceptor,
    pending: FuturesUnordered<Handshake>,
}

impl TlsListener {
    /// Wraps an already bound socket; no plaintext listener is opened alongside it.
    #[must_use]
    pub fn new(tcp: TcpListener, config: rustls::ServerConfig) -> Self {
        Self {
            tcp,
            acceptor: TlsAcceptor::from(Arc::new(config)),
            pending: FuturesUnordered::new(),
        }
    }
}

impl axum::serve::Listener for TlsListener {
    type Io = TlsStream<TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            tokio::select! {
                ready = self.pending.next(), if !self.pending.is_empty() => {
                    if let Some(Some(connection)) = ready {
                        return connection;
                    }
                }
                connection = self.tcp.accept(), if self.pending.len() < 128 => {
                    match connection {
                        Ok((tcp, addr)) => {
                            let acceptor = self.acceptor.clone();
                            self.pending.push(Box::pin(async move {
                                match tokio::time::timeout(Duration::from_secs(10), acceptor.accept(tcp)).await {
                                    Ok(Ok(tls)) => Some((tls, addr)),
                                    _ => None,
                                }
                            }));
                        }
                        Err(error) => {
                            tracing::warn!(%error, "TLS listener cannot accept a connection; retrying");
                            tokio::time::sleep(Duration::from_secs(1)).await;
                        }
                    }
                }
            }
        }
    }

    fn local_addr(&self) -> std::io::Result<SocketAddr> {
        self.tcp.local_addr()
    }
}
