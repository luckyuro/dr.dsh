//! Enforces ADR-0002: the relay cannot read what it forwards.
//!
//! The claim "the relay is zero-knowledge" is only worth anything if it is a
//! property of the build rather than a promise in a document. Two things make it
//! one:
//!
//! 1. **It has no key material and no crypto.** The relay's dependency tables
//!    must not name a cryptography crate or `dr-dsh-crypto`. Without those it cannot
//!    decrypt, which is stronger than not wanting to.
//! 2. **It cannot interpret payloads.** Its sources must not reach for
//!    `dr_dsh_proto::control`, whose types describe lifecycle commands, device names,
//!    and session handles. Frame headers are all it is allowed to understand.
//!
//! This is deliberately a manifest-and-source check rather than a unit test,
//! because the failure it guards against is a *future* dependency or import — the
//! kind a reviewer can miss in a large diff and a unit test cannot see at all.
//!
//! Consequence to keep in mind when this test fails: the fix is almost never to
//! add the dependency here. It is to move the behaviour behind an endpoint, or to
//! the daemon, which is the side that legitimately holds keys.

use std::fs;
use std::path::{Path, PathBuf};

/// Dependency names that would give the relay the ability to decrypt or verify.
const FORBIDDEN_CRYPTO_DEPENDENCIES: &[&str] = &[
    // Suites and primitives.
    "aes-gcm",
    "chacha20poly1305",
    "x25519-dalek",
    "ed25519-dalek",
    "hkdf",
    "sha2",
    "sha3",
    "blake3",
    "ring",
    "rustls",
    "openssl",
    "sodiumoxide",
    "libsodium-sys",
    "argon2",
    "pbkdf2",
    "spake2",
    "dryoc",
    // This workspace's own crypto crate: linking it would hand the relay the
    // session types even if it never called them.
    "dr-dsh-crypto",
];

/// Source-path prefixes that would let the relay read payload semantics.
const FORBIDDEN_SOURCE_PREFIXES: &[&str] = &["dr_dsh_crypto", "dr_dsh_proto::control"];

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

fn crate_root() -> PathBuf {
    // CARGO_MANIFEST_DIR points at crates/dr-dsh-relay.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn workspace_root() -> PathBuf {
    crate_root()
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(crate_root)
}

/// Parses the dependency names of one Cargo manifest section.
///
/// A deliberately small line-based reader: this test must not itself depend on a
/// TOML parser, because a test that needs an extra dependency is a test that stops
/// running the moment someone tightens the dependency policy.
fn dependency_names(manifest: &str, section: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut in_section = false;
    for raw in manifest.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            in_section = line == format!("[{section}]");
            continue;
        }
        if !in_section || line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, _)) = line.split_once('=') {
            // `key.workspace = true` inherits the version from the workspace table;
            // the dependency's name is still the leading segment.
            let name = key.trim().split('.').next().unwrap_or_default();
            names.push(name.to_owned());
        }
    }
    names
}

fn rust_sources(directory: &Path, found: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in fs::read_dir(directory)? {
        let path = entry?.path();
        if path.is_dir() {
            rust_sources(&path, found)?;
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            found.push(path);
        }
    }
    Ok(())
}

#[test]
fn the_relay_has_no_cryptography_in_its_dependency_table() -> TestResult {
    let manifest = fs::read_to_string(crate_root().join("Cargo.toml"))?;
    let normal = dependency_names(&manifest, "dependencies");
    assert!(
        !normal.is_empty(),
        "the relay must declare its dependencies explicitly; found none"
    );
    let offenders: Vec<&String> = normal
        .iter()
        .filter(|name| FORBIDDEN_CRYPTO_DEPENDENCIES.contains(&name.as_str()))
        .collect();
    assert!(
        offenders.is_empty(),
        "the relay must not depend on {offenders:?}: it holds no keys and must not be able to \
         decrypt (ADR-0002). Move the behaviour behind an endpoint or into the daemon."
    );
    Ok(())
}

#[test]
fn the_relay_never_reaches_for_payload_semantics() -> TestResult {
    let mut sources = Vec::new();
    rust_sources(&crate_root().join("src"), &mut sources)?;
    assert!(
        !sources.is_empty(),
        "expected the relay to have sources to scan"
    );

    let mut violations = Vec::new();
    for path in &sources {
        let text = fs::read_to_string(path)?;
        for (index, line) in text.lines().enumerate() {
            // Skip comments: prose about the boundary is what this file wants to
            // encourage, and `//! ... dr_dsh_crypto ...` is not a dependency.
            let code = line.trim_start();
            if code.starts_with("//") || code.starts_with('*') {
                continue;
            }
            for prefix in FORBIDDEN_SOURCE_PREFIXES {
                if line.contains(prefix) {
                    violations.push(format!(
                        "{}:{} references {prefix}",
                        path.display(),
                        index + 1
                    ));
                }
            }
        }
    }
    assert!(
        violations.is_empty(),
        "the relay must only understand frame headers, never payload semantics (ADR-0002):\n  {}",
        violations.join("\n  ")
    );
    Ok(())
}

#[test]
fn the_relay_does_not_link_this_workspace_s_crypto_crate() -> TestResult {
    // Belt and braces for the case that matters most: `dr-dsh-crypto` is ours, so a
    // "temporary" dependency on it is the most plausible way this property would be
    // lost. Checked in every table, because test code is copied into examples and
    // benchmarks more often than anyone expects.
    let manifest = fs::read_to_string(crate_root().join("Cargo.toml"))?;
    for section in ["dependencies", "dev-dependencies", "build-dependencies"] {
        let names = dependency_names(&manifest, section);
        assert!(
            !names.iter().any(|name| name == "dr-dsh-crypto"),
            "the relay must not link dr-dsh-crypto in [{section}]: without it, the zero-knowledge \
             property holds by construction rather than by discipline (ADR-0002)"
        );
    }
    Ok(())
}

#[test]
fn the_scan_finds_the_expected_shape() -> TestResult {
    // Guards against the checks above silently passing because they looked at
    // nothing: the manifest parser must see the relay's real dependencies, and the
    // walker must find the modules main.rs declares.
    let manifest = fs::read_to_string(crate_root().join("Cargo.toml"))?;
    let normal = dependency_names(&manifest, "dependencies");
    assert!(
        normal.iter().any(|name| name == "dr-dsh-proto"),
        "expected dr-dsh-proto: {normal:?}"
    );
    assert!(
        normal.iter().any(|name| name == "tokio"),
        "expected tokio: {normal:?}"
    );

    let mut sources = Vec::new();
    rust_sources(&crate_root().join("src"), &mut sources)?;
    let names: Vec<String> = sources
        .iter()
        .filter_map(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .collect();
    // Every module that carries relay behaviour must be scanned: a new file is
    // fine, but these are the ones the zero-knowledge argument names explicitly.
    for expected in ["lib.rs", "config.rs", "rooms.rs", "ingress.rs"] {
        assert!(
            names.iter().any(|name| name == expected),
            "expected src/{expected} in {names:?}"
        );
    }

    let root = workspace_root();
    assert!(
        root.join("Cargo.toml").is_file(),
        "expected a workspace manifest at {}",
        root.display()
    );
    Ok(())
}
