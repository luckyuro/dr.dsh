//! Serving the remote client's shell and modules.
//!
//! # What the relay serves
//!
//! Two things, and neither contains user data:
//!
//! * **The shell** — the page a visitor sees. Static, identical for every visitor.
//! * **The client modules** — the PWA's own sources, served so the page can import them.
//!
//! The shell is compiled into the relay. The modules are read from a directory at startup,
//! because they are TypeScript that has to be transpiled by `pnpm --filter @dr.dsh/pwa
//! build` and embedding build output would mean committing it.
//!
//! # Why the modules are served as sources
//!
//! They are written in the subset a browser can run without transpiling: no enums, no
//! decorators, no parameter properties, no type-only runtime syntax. That subset is a
//! standing rule of this repository (`AGENTS.md`), chosen for the Node test runner, and it
//! happens to make the client servable verbatim. A browser without type-stripping support
//! will refuse the module and the page will say so, which is the honest failure.
//!
//! # When the directory is missing
//!
//! The relay still starts and still serves *something*: a page that states the client is not
//! installed and how to build it. A 404 here would look like a broken relay, when in fact
//! the relay is fine and one directory is missing.

use std::path::{Component, Path, PathBuf};

/// The shell page, with no user data and no per-visitor variation.
pub const SHELL: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dr.dsh</title>
<!-- Installable: a manifest, two icons, and the service worker the page already registers. The
     manifest lives under /client/ because that is the one directory the relay serves files from,
     and it is same-origin so the app's scope is the whole relay. -->
<link rel="manifest" href="/client/manifest.webmanifest">
<meta name="theme-color" content='#2563eb'>
<link rel="icon" href="/client/icon-192.png" sizes="192x192" type="image/png">
<link rel="apple-touch-icon" href="/client/icon-192.png">
<style>
  :root { color-scheme: light dark; --fg: #1a1a1a; --muted: #6b7280; --accent: #2563eb; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e5e7eb; --muted: #9ca3af; --accent: #60a5fa; } }
  body { font: 16px/1.6 system-ui, sans-serif; color: var(--fg); margin: 0; padding: 3rem 1.5rem; }
  main { max-width: 34rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 .5rem; }
  p { color: var(--muted); }
  label { display: block; font-weight: 600; margin: 1.5rem 0 .35rem; }
  input { width: 100%; padding: .6rem .7rem; font: inherit; font-family: ui-monospace, monospace;
          border: 1px solid color-mix(in srgb, var(--fg) 25%, transparent); border-radius: .4rem;
          background: transparent; color: inherit; }
  button { margin-top: 1rem; padding: .6rem 1.1rem; font: inherit; font-weight: 600; border: 0;
           border-radius: .4rem; background: var(--accent); color: #fff; cursor: pointer; }
  button[disabled] { opacity: .55; cursor: progress; }
  #state { margin-top: 1.25rem; min-height: 2.5rem; }
  #state[data-phase="failed"] { color: #dc2626; }
  #state[data-phase="offline"] { color: #b45309; }
  #panel { margin-top: 1.5rem; }
  #panel[hidden] { display: none; }
  #headline { font-weight: 600; margin: 0; }
  #detail { margin: .25rem 0 0; font-size: .9rem; }
  #panel[data-tone="ok"] #headline { color: #15803d; }
  #panel[data-tone="warn"] #headline { color: #b45309; }
  #panel[data-tone="error"] #headline { color: #dc2626; }
  #actions { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: 1rem; }
  #actions button { margin-top: 0; }
  #actions p { flex-basis: 100%; margin: .25rem 0 0; font-size: .85rem; color: var(--muted); }
  #open[hidden] { display: none; }
  #forget { background: transparent; color: var(--muted);
            border: 1px solid color-mix(in srgb, var(--fg) 25%, transparent); }
  #forget[hidden] { display: none; }
  #device { font-size: .9rem; }
  code { background: color-mix(in srgb, currentColor 12%, transparent); padding: .1em .35em; border-radius: .25rem; }
  a { color: var(--accent); }
</style>
</head>
<body>
<main>
  <h1>dr.dsh</h1>
  <p>This page connects your browser to the DeepSeek Harness running on your own computer.
     Traffic is end-to-end encrypted: this relay forwards it without being able to read it.</p>

  <label for="key">Pairing code or room key</label>
  <input id="key" autocomplete="off" spellcheck="false" placeholder="the code `drdshd pair` printed">
  <button id="connect" type="button">Connect</button>
  <button id="forget" type="button" hidden>Forget this device</button>
  <div id="state" data-phase="idle"></div>
  <p id="device" hidden></p>

  <!-- One machine per paired room (ADR-0007). Hidden until there is at least one, so a first-time
       visitor sees the code field and nothing else. -->
  <section id="rooms" hidden>
    <h2 style="font-size:1rem">Your computers</h2>
    <ul id="room-list" style="list-style:none;padding:0;margin:0"></ul>
  </section>

  <section id="panel" hidden>
    <p id="headline"></p>
    <p id="detail"></p>
    <div id="actions"></div>
    <button id="open" type="button" hidden>Open the DeepSeek Harness interface</button>
  </section>

  <p style="margin-top:2rem;font-size:.9rem">Either credential is a secret and neither leaves
     this browser except inside the encrypted tunnel. A paired device is remembered in this
     browser, so the code is only ever typed once.</p>
</main>
<script type="module" src="/client/shell.js"></script>
</body>
</html>
"#;

/// The page shown when the client modules are not installed.
pub const SHELL_WITHOUT_CLIENT: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dr.dsh</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; margin: 0; padding: 3rem 1.5rem; max-width: 34rem; }
  code { background: color-mix(in srgb, currentColor 12%, transparent); padding: .1em .35em; border-radius: .25rem; }
</style>
</head>
<body>
<h1>dr.dsh relay</h1>
<p>This is a <strong>zero-knowledge relay</strong>. It forwards encrypted frames between your
   own computer and your own devices, and it cannot read them: it holds no keys, keeps no
   database, and writes no payload to disk.</p>
<p>Seeing this page means the relay is running. The remote client is not installed next to
   it, so there is nothing to pair with yet.</p>
<p>To install it, build the client and point the relay at it:</p>
<p><code>pnpm --filter @dr.dsh/pwa build</code><br>
   <code>DSH_RELAY_CLIENT_DIR=&lt;path&gt; drdsh-relay</code></p>
<p>Operators: <code>GET /healthz</code> reports counts only.</p>
</body>
</html>
"#;

/// Where the client modules are read from.
#[derive(Debug, Clone)]
pub struct Assets {
    directory: Option<PathBuf>,
}

impl Assets {
    /// Uses the given directory when it exists and holds a client.
    ///
    /// A missing directory is not an error: the relay's job is forwarding, and refusing to
    /// start because a static file is absent would take the forwarding down with it.
    #[must_use]
    pub fn new(directory: Option<PathBuf>) -> Self {
        let usable = directory.filter(|path| path.join("session.js").is_file());
        if usable.is_none() {
            tracing::warn!(
                "no client modules found; the relay will serve a page explaining how to build them"
            );
        }
        Self { directory: usable }
    }

    /// Whether a client is installed.
    #[must_use]
    pub fn has_client(&self) -> bool {
        self.directory.is_some()
    }

    /// Reads one client module.
    ///
    /// # Errors
    ///
    /// Returns `None` when the client is absent, the path escapes the directory, or the
    /// file is not a module. Refusing `..` and absolute paths matters because this serves
    /// whatever a browser asks for: without it, `/client/../../etc/passwd` would be a file
    /// read on the relay's host.
    #[must_use]
    pub fn module(&self, requested: &str) -> Option<Vec<u8>> {
        let directory = self.directory.as_ref()?;
        if !is_safe_module_path(requested) {
            return None;
        }
        let path = directory.join(requested);
        let bytes = std::fs::read(path).ok()?;
        Some(bytes)
    }

    /// Reads one static client asset — the manifest and the icons it points at.
    ///
    /// A **named allowlist**, not a general static file server: the relay's job is forwarding
    /// ciphertext, and every path it learns to serve is a path it must reason about. Four names that
    /// a PWA cannot be installed without are worth reasoning about; a directory of arbitrary files is
    /// not. MIME types are fixed by the same table, so a file cannot choose to be served as HTML.
    ///
    /// # Errors
    ///
    /// Returns `None` for any name outside the list, which is also what keeps `.html` — the one type
    /// that could impersonate the shell — unreachable.
    #[must_use]
    pub fn asset(&self, requested: &str) -> Option<(Vec<u8>, &'static str)> {
        let directory = self.directory.as_ref()?;
        let content_type = asset_content_type(requested)?;
        if Path::new(requested).components().count() != 1 {
            return None;
        }
        let bytes = std::fs::read(directory.join(requested)).ok()?;
        Some((bytes, content_type))
    }
}

/// The static client assets the relay serves, and what each one is.
///
/// The names are the build's output names (`apps/pwa/package.json` copies them from `static/`), so
/// the manifest the shell links is the same file the build produced — a rename on one side and not
/// the other is a blank install prompt with no error anywhere, which is why the list lives next to
/// the serving function rather than in the shell.
pub const CLIENT_ASSETS: &[(&str, &str)] = &[
    ("manifest.webmanifest", "application/manifest+json"),
    ("icon-192.png", "image/png"),
    ("icon-512.png", "image/png"),
];

/// The content type for a client asset, or `None` when it is not one.
#[must_use]
pub fn asset_content_type(requested: &str) -> Option<&'static str> {
    CLIENT_ASSETS
        .iter()
        .find(|(name, _)| *name == requested)
        .map(|(_, content_type)| *content_type)
}

/// Whether a requested module path stays inside the client directory and is a module.
///
/// Only plain file names ending in `.js` (optionally under flat subdirectories) are allowed:
/// the client is a handful of modules with no nesting, so anything more elaborate is a
/// request the relay has no reason to satisfy.
#[must_use]
pub fn is_safe_module_path(requested: &str) -> bool {
    // A name, not just an extension: `session.js` is a module, `.js` is a file whose name
    // is its extension.
    let Some(stem) = requested.strip_suffix(".js") else {
        return false;
    };
    if stem.is_empty() {
        return false;
    }
    // A backslash is an ordinary character in a Unix file name and a separator on Windows;
    // refusing it keeps one request from meaning two different files.
    if requested.contains('\\') {
        return false;
    }
    // Test modules are refused by name, not merely left out of the build.
    //
    // The build excludes them, and that is not enough: `dist/` is a directory that accumulates,
    // so a file emitted by an earlier build stays there and stays servable. The stakes are not
    // theoretical — the client's tests carry fixed room keys and device keys, so serving one
    // hands a stranger a key this project's own tests treat as secret, and a test module also
    // runs code no user asked for. A build rule can be forgotten; a request filter cannot.
    if requested.contains(".test.") || requested.ends_with("_test.js") {
        return false;
    }
    let path = Path::new(requested);
    path.components()
        .all(|component| matches!(component, Component::Normal(_)))
}

/// The content type for a client module.
///
/// `text/javascript`, not `application/typescript`: these files are served to a browser that
/// runs them as modules, and the module MIME type is what makes that legal.
#[must_use]
pub fn module_content_type() -> &'static str {
    "text/javascript; charset=utf-8"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shell_has_no_user_data_and_declares_no_scripts_beyond_its_own() {
        assert!(SHELL.contains("dr.dsh"));
        assert!(
            !SHELL.contains("window.__DSH_BOOT__"),
            "the shell must not fake a DSH boot"
        );
        // The shell names the modules it loads as strings, so the check that they exist is the
        // *serving* rule below; what this asserts is that the shell loads code from its own
        // origin and nothing else.
        assert!(
            SHELL.contains("/client/shell.js"),
            "the shell must load its own module"
        );
        assert!(
            !SHELL.contains("<script type=\"module\">"),
            "no inline script: the CSP refuses it"
        );
    }

    #[test]
    fn every_module_the_shell_loads_is_one_the_relay_would_serve() {
        // The shell names its module as a string and that module names the rest, so a renamed or
        // mistyped one is a runtime failure in a browser and nothing else. Each name is checked
        // against the same filter that decides what may be served, so the client cannot ask for
        // something the relay would refuse.
        let script = include_str!("../../../apps/pwa/src/shell.js");
        assert!(
            SHELL.contains("/client/shell.js"),
            "the shell loads its own module"
        );
        for name in ["shell.js", "session.js", "panel.js", "control.js"] {
            assert!(
                is_safe_module_path(name),
                "the client loads {name}, which the relay would refuse to serve"
            );
        }
        assert!(
            script.contains("/client/session.js"),
            "the shell module loads the session, which is where the tunnel is made"
        );
        assert!(
            script.contains("window.open('/__dr/interface'"),
            "the shell must open the interface path, which the worker intercepts"
        );
        assert!(
            !script.contains("location.assign("),
            "the interface must open in its own page: the tunnel lives in this one, and a \
             navigation replaces it — the interface's HTML then arrives through a tunnel nobody \
             is serving, and every asset after it hangs"
        );
    }

    #[test]
    fn the_client_modules_the_shell_needs_are_servable_by_name() {
        // These are the modules the client loads by string at runtime — the service worker is
        // registered from inside `session.js`, not from the shell, so a shell-only check would
        // miss it. What the relay must guarantee is that each *name* is one it would serve.
        for name in [
            "session.js",
            "panel.js",
            "control.js",
            "service-worker.js",
            "tunnel.js",
            // The pairing path: the exchange, the identity it produces, where that identity is
            // kept, and the classifier that decides which credential the user pasted.
            "pair.js",
            "pairing.js",
            "spake2.js",
            "ed25519.js",
            "identity.js",
            "storage.js",
            "credential.js",
        ] {
            assert!(
                is_safe_module_path(name),
                "the client loads {name}, which the relay would refuse to serve"
            );
        }
    }

    #[test]
    fn the_shell_module_only_reaches_for_ids_the_markup_declares() {
        // The panel is wired by id from a module the compiler cannot check against this HTML, so
        // a renamed id leaves a blank box with no error anywhere — in a browser only. Reading both
        // sides here is the only place they meet.
        let script = include_str!("../../../apps/pwa/src/shell.js");
        for id in [
            "panel",
            "headline",
            "detail",
            "actions",
            "open",
            "forget",
            "device",
            "key",
            "state",
            "connect",
            "rooms",
            "room-list",
        ] {
            assert!(
                SHELL.contains(&format!("id=\"{id}\"")),
                "the shell must declare id=\"{id}\""
            );
            assert!(
                script.contains(&format!("getElementById('{id}')")),
                "the shell module must reach for {id}"
            );
        }
    }

    #[test]
    fn the_fallback_says_what_is_missing_and_how_to_fix_it() {
        // A 404 would look like a broken relay; this says the relay is fine.
        assert!(SHELL_WITHOUT_CLIENT.contains("relay is running"));
        assert!(SHELL_WITHOUT_CLIENT.contains("DSH_RELAY_CLIENT_DIR"));
    }

    #[test]
    fn the_static_assets_are_an_allowlist_with_fixed_types() {
        // A PWA cannot be installed without a manifest and an icon, and the relay is the only thing
        // serving them, so a named list is the narrowest way to make that possible. Everything else
        // keeps the module rule's refusals — including `.html`, the one type that could impersonate
        // the shell.
        assert_eq!(
            asset_content_type("manifest.webmanifest"),
            Some("application/manifest+json")
        );
        assert_eq!(asset_content_type("icon-192.png"), Some("image/png"));
        assert_eq!(asset_content_type("icon-512.png"), Some("image/png"));
        for refused in [
            "index.html",
            "shell.js", // a module, served by the other path
            "icon.svg", // not in the list, so not served
            "manifest.json",
            "../manifest.webmanifest",
            "nested/manifest.webmanifest",
            "",
        ] {
            assert_eq!(asset_content_type(refused), None, "{refused}");
        }
    }

    #[test]
    fn every_served_asset_is_named_by_the_shell_or_the_manifest() {
        // Three lists have to agree: what the relay serves, what the page asks for, and what the build
        // copies. A rename in one of them is an install prompt that never appears, with no error
        // anywhere — the same class of failure as the panel's DOM ids, and found the same way, by
        // reading both sides in one place.
        //
        // The shell links the manifest and one icon; the manifest names both icons. So the property is
        // "named by one of them", not "named by the shell": requiring the shell to link every icon
        // would be requiring it to duplicate what the manifest already says.
        let manifest = include_str!("../../../apps/pwa/static/manifest.webmanifest");
        let build = include_str!("../../../apps/pwa/package.json");
        for (name, _) in CLIENT_ASSETS {
            assert!(
                SHELL.contains(name) || manifest.contains(name),
                "{name} is served but nothing asks for it"
            );
            assert!(build.contains(name), "the build must copy {name}");
            // Resolved from the manifest directory, not the process's: a test binary's working
            // directory is wherever cargo was invoked from, and a check that passes only when run
            // from the root is a check that will one day be skipped.
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../apps/pwa/static")
                .join(name);
            assert!(
                path.exists(),
                "the repository must contain {name}: {path:?}"
            );
        }
        // And the other direction: what the page asks for must be something the relay serves, or the
        // install prompt silently has no manifest.
        assert!(
            SHELL.contains("manifest.webmanifest"),
            "the shell must link the manifest"
        );
        for (name, _) in CLIENT_ASSETS {
            if SHELL.contains(name) {
                assert!(asset_content_type(name).is_some(), "{name}");
            }
        }
    }

    #[test]
    fn only_flat_javascript_modules_are_served() {
        for good in ["session.js", "tunnel.js", "proxy.js"] {
            assert!(is_safe_module_path(good), "{good}");
        }
        // Each of these is either an escape attempt or a file the relay has no business
        // serving.
        for bad in [
            "../secrets.js",
            "/etc/passwd.js",
            "a/../../b.js",
            "session.ts",
            "",
            ".js",
            "a\\b.js",
            // Test modules carry fixed keys and are never part of the client.
            "control.test.js",
            "session.test.js",
            "tunnel_test.js",
        ] {
            assert!(!is_safe_module_path(bad), "{bad}");
        }
    }

    #[test]
    fn a_missing_client_is_not_an_error() {
        let assets = Assets::new(Some(PathBuf::from("/nonexistent-client-directory")));
        assert!(!assets.has_client());
        assert!(assets.module("session.js").is_none());
    }

    #[test]
    fn a_client_directory_is_used_when_it_holds_a_session_module() -> std::io::Result<()> {
        let directory = std::env::temp_dir().join("drdsh-relay-assets-test");
        std::fs::create_dir_all(&directory)?;
        std::fs::write(directory.join("session.js"), b"export const ok = true;\n")?;
        let assets = Assets::new(Some(directory.clone()));
        assert!(assets.has_client());
        assert_eq!(
            assets.module("session.js").as_deref(),
            Some(&b"export const ok = true;\n"[..])
        );
        assert!(
            assets.module("../secret.js").is_none(),
            "an escape must not be read"
        );
        assert!(assets.module("absent.js").is_none());
        std::fs::remove_dir_all(&directory)?;
        Ok(())
    }

    #[test]
    fn the_module_content_type_is_javascript() {
        assert!(module_content_type().starts_with("text/javascript"));
    }
}
