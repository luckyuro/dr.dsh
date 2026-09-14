//! Parsing the line DSH prints when it is ready to serve.
//!
//! `dsh web` prints, after its Loader settles:
//!
//! ```text
//! dsh web: http://127.0.0.1:3080/?token=<launchToken>
//! ```
//!
//! and, when it can also derive a LAN address:
//!
//! ```text
//! dsh web: http://127.0.0.1:3080/?token=<launchToken> (LAN: http://192.168.1.5:3080/?token=<launchToken>)
//! ```
//!
//! The upstream source comment next to that `console.log` says supervisors should
//! connect as soon as they observe the line, so this is the interface we are meant
//! to use — but it is a printed string, not a versioned protocol. Two consequences
//! shape this module:
//!
//! * Parsing is strict and total. Anything ambiguous is an error naming what was
//!   expected, never a partially filled struct. A daemon that starts with a wrong
//!   port or no token produces a confusing failure much later.
//! * The LAN suffix is parsed and reported, then deliberately **not used**. It is
//!   useful diagnostics (it tells the user DSH thinks it is reachable on the
//!   LAN), and it is exactly the exposure this project exists to avoid.
//!
//! See `docs/integration/dsh-surface.md` § 2 for the upgrade ritual when this
//! format changes.

use std::net::{IpAddr, ToSocketAddrs as _};

/// The prefix every readiness line starts with.
pub const READY_PREFIX: &str = "dsh web: ";

/// A parsed readiness line.
#[derive(Clone, PartialEq, Eq)]
pub struct ReadyLine {
    /// Loopback address DSH is listening on, as it reported it.
    ///
    /// An `IpAddr` rather than a `SocketAddr` because DSH prints the literal it
    /// bound, and a hostname form must be handled explicitly instead of failing
    /// in a type conversion with a confusing message.
    pub addr: IpAddr,
    /// Port DSH is listening on.
    pub port: u16,
    /// The reverse-proxy base URL: scheme, authority, and an empty path.
    ///
    /// This is the value the daemon uses as the authority for every subsequent
    /// request, because DSH's session cookie is bound to it.
    pub base_url: String,
    /// The one-time process token, already extracted from the query string.
    pub token: String,
    /// The LAN address DSH also announced, if any. Reported, never dialed.
    pub lan_url: Option<String>,
}

/// Redacts a credential that may be inside an echoed line.
///
/// The readiness line carries DSH's one-time process token in its query string, and three of the
/// errors below quote the line they could not use. Quoting it verbatim would put a live credential
/// into the daemon's log — which is exactly what this file's own rules forbid for every other type
/// that holds one. Found while walking the M2 attack surface: the rule "do not print credentials"
/// had been applied to the types that hold keys, and not to the *parse errors* that quote the text
/// they came from.
fn redact(line: &str) -> String {
    const NEEDLE: &str = "token=";
    let mut redacted = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(at) = rest.find(NEEDLE) {
        let (before, after) = rest.split_at(at + NEEDLE.len());
        redacted.push_str(before);
        redacted.push_str("<redacted>");
        // A token runs until something that cannot be part of a query value.
        let end = after
            .find(|c: char| c.is_whitespace() || c == '&' || c == ')' || c == '"')
            .unwrap_or(after.len());
        rest = &after[end..];
    }
    redacted.push_str(rest);
    // Bounded as well as redacted: an error message is a log line, and a log line has a length.
    redacted.chars().take(200).collect()
}

impl core::fmt::Debug for ReadyLine {
    /// Prints where DSH is, never the token it announced with.
    ///
    /// Derived `Debug` printed the token in full. Nothing logged a `ReadyLine` at the time this was
    /// written, which is precisely why it needed fixing: the next person to write
    /// `tracing::debug!(?ready)` would have put a live credential in a log, and the type carried no
    /// hint that it was dangerous to print.
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("ReadyLine")
            .field("addr", &self.addr)
            .field("port", &self.port)
            .field("base_url", &self.base_url)
            .field("token", &"<redacted>")
            .field("lan_url", &self.lan_url.as_deref().map(redact))
            .finish()
    }
}

/// Why a readiness line could not be used.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ReadyParseError {
    /// The line is not a readiness line at all.
    #[error("not a readiness line: {0:?}")]
    NotReady(String),
    /// The URL part could not be parsed.
    #[error("readiness line has no usable URL: {0:?}")]
    BadUrl(String),
    /// The URL has no `token` query parameter.
    #[error("readiness line URL carries no token: {0:?}")]
    NoToken(String),
    /// The URL does not point at loopback, which means this is not a DSH we can
    /// safely proxy. Refusing is the whole point of the project.
    #[error("readiness line points at {addr}, which is not loopback")]
    NotLoopback {
        /// The offending address.
        addr: String,
    },
}

impl ReadyLine {
    /// Parses one stdout line.
    ///
    /// Returns `Ok(None)` when the line is ordinary output rather than a
    /// readiness announcement: DSH writes plenty of other things to stdout, and
    /// treating every unrecognised line as an error would break on the first
    /// informative message.
    ///
    /// # Errors
    ///
    /// Returns an error only when the line *is* a readiness line but cannot be
    /// used — a malformed URL, a missing token, or a non-loopback address.
    pub fn parse(line: &str) -> Result<Option<Self>, ReadyParseError> {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        let Some(rest) = trimmed.strip_prefix(READY_PREFIX) else {
            return Ok(None);
        };
        // Split off the LAN annotation before touching the URL: its parentheses
        // and spaces would otherwise end up inside the token.
        let (main, lan) = match rest.split_once(" (LAN: ") {
            Some((main, lan_tail)) => (main.trim(), Some(lan_tail.trim_end_matches(')').trim())),
            None => (rest.trim(), None),
        };
        if main.is_empty() {
            return Err(ReadyParseError::NotReady(redact(trimmed)));
        }

        let url = UrlParts::parse(main).ok_or_else(|| ReadyParseError::BadUrl(redact(main)))?;
        if !url.is_loopback() {
            return Err(ReadyParseError::NotLoopback {
                addr: url.authority.clone(),
            });
        }
        let token = url
            .token()
            .map(str::to_owned)
            .ok_or_else(|| ReadyParseError::NoToken(redact(main)))?;

        let addr = url
            .ip()
            .ok_or_else(|| ReadyParseError::BadUrl(main.to_owned()))?;
        let port = url
            .port()
            .ok_or_else(|| ReadyParseError::BadUrl(main.to_owned()))?;

        Ok(Some(Self {
            addr,
            port,
            base_url: url.base_url(addr, port),
            token,
            lan_url: lan.map(str::to_owned),
        }))
    }

    /// The authority every request must present, `host:port`.
    #[must_use]
    pub fn authority(&self) -> String {
        self.base_url
            .strip_prefix("http://")
            .or_else(|| self.base_url.strip_prefix("https://"))
            .unwrap_or(&self.base_url)
            .to_owned()
    }

    /// The absolute URL that redeems the token, i.e. `GET /?token=…`.
    ///
    /// This is the one request whose query string matters; every later request
    /// uses the cookie it returns.
    #[must_use]
    pub fn token_url(&self) -> String {
        format!("{}/?token={}", self.base_url, self.token)
    }
}

/// The parts of `http://127.0.0.1:3080/?token=…` this module needs.
///
/// Hand-rolled rather than built on a URL crate because the shape is fixed by the
/// producer, the parsing rules must be exactly these (no implicit defaulting that
/// could hide an unexpected URL), and one fewer dependency in an unattended
/// daemon is worth twenty lines.
#[derive(Debug, Clone, PartialEq, Eq)]
struct UrlParts {
    scheme: String,
    authority: String,
    host: String,
    query: String,
}

impl UrlParts {
    fn parse(raw: &str) -> Option<Self> {
        let (scheme, rest) = raw.split_once("://")?;
        if scheme != "http" && scheme != "https" {
            return None;
        }
        let (authority, tail) = match rest.find('/') {
            Some(index) => (&rest[..index], &rest[index..]),
            None => (rest, ""),
        };
        if authority.is_empty() {
            return None;
        }
        let query = tail
            .split_once('?')
            .map_or(String::new(), |(_, q)| q.to_owned());
        Some(Self {
            scheme: scheme.to_owned(),
            authority: authority.to_owned(),
            host: host_of(authority).to_owned(),
            query,
        })
    }

    /// Whether the authority names the local machine.
    ///
    /// Accepts exactly the spellings DSH can produce for a loopback bind:
    /// `127.0.0.1`, `localhost`, `[::1]`, and any `127/8` literal with an optional
    /// port. Anything else is refused rather than proxied.
    fn is_loopback(&self) -> bool {
        if self.host == "localhost" || self.host == "[::1]" {
            return true;
        }
        let octets: Vec<&str> = self.host.split('.').collect();
        octets.len() == 4
            && octets[0] == "127"
            && octets.iter().all(|octet| octet.parse::<u8>().is_ok())
    }

    /// The announced address, as the IP the daemon will actually dial.
    ///
    /// A literal parses directly. A hostname (`localhost`) is resolved, and the
    /// loopback rule is then re-applied to the *result* — so "we only proxy
    /// loopback" is checked against the address we dial, not against the spelling
    /// DSH happened to print. Resolution happens once per daemon start, which is
    /// why the blocking lookup is acceptable here.
    fn ip(&self) -> Option<IpAddr> {
        let host = self.host.trim_matches(['[', ']']);
        if let Ok(literal) = host.parse::<IpAddr>() {
            return Some(literal);
        }
        let resolved = (host, 0_u16).to_socket_addrs().ok()?;
        resolved.map(|addr| addr.ip()).find(|ip| ip.is_loopback())
    }

    fn port(&self) -> Option<u16> {
        let rest = self.authority.strip_prefix(&self.host)?;
        rest.strip_prefix(':')?.parse().ok()
    }

    /// `scheme://host:port`, bracketing an IPv6 host and dropping any hostname
    /// spelling in favour of the address that was actually resolved.
    ///
    /// Rebuilding the URL from the resolved host is what keeps `base_url`,
    /// `authority()`, and the socket we dial describing the same origin — the
    /// property DSH's cookie binding depends on. It also removes the trailing-port
    /// guesswork: the port is carried explicitly.
    fn base_url(&self, addr: IpAddr, port: u16) -> String {
        match addr {
            IpAddr::V4(v4) => format!("{}://{}:{}", self.scheme, v4, port),
            IpAddr::V6(v6) => format!("{}://[{}]:{}", self.scheme, v6, port),
        }
    }

    fn token(&self) -> Option<&str> {
        self.query
            .split('&')
            .find_map(|pair| pair.strip_prefix("token="))
            .filter(|token| !token.is_empty())
    }
}

/// Strips the port from an authority, keeping IPv6 brackets.
fn host_of(authority: &str) -> &str {
    if let Some(end) = authority.find(']') {
        // IPv6 literal: `[::1]:3080` -> `[::1]`.
        return &authority[..=end];
    }
    authority.split(':').next().unwrap_or(authority)
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_credential_never_appears_in_a_parse_error_or_a_debug_print()
    -> Result<(), Box<dyn std::error::Error>> {
        // The M2 review found this: the errors that quote the line they could not use quoted the
        // token with it, and `ReadyLine`'s derived `Debug` printed the token in full. Both are one
        // `tracing::debug!` away from a credential in a log file, which every other type in this
        // workspace refuses to allow.
        let token = "SECRET-TOKEN-9f3a2b";
        let cases = [
            // A URL that cannot be parsed, a URL with no token, and a line that is not a readiness
            // line at all — the three variants that echo their input.
            format!("dsh web: http://[not a url]/?token={token}"),
            "dsh web: http://127.0.0.1:3080/".to_owned(),
            format!("something else entirely token={token}"),
        ];
        for line in cases {
            let error = match super::ReadyLine::parse(&line) {
                Ok(_) => continue,
                Err(error) => error,
            };
            let printed = format!("{error}");
            assert!(
                !printed.contains(token),
                "a parse error printed the token: {printed}"
            );
        }

        // And the parsed value itself, whose `Debug` is what a future log line would reach for.
        let parsed =
            super::ReadyLine::parse(&format!("dsh web: http://127.0.0.1:3080/?token={token}"))
                .map_err(|error| format!("a well-formed readiness line was refused: {error}"))?
                .ok_or("a readiness line must parse as one")?;
        let ready = parsed;
        let printed = format!("{ready:?}");
        assert!(
            !printed.contains(token),
            "ReadyLine's Debug printed the token"
        );
        assert!(printed.contains("<redacted>"), "{printed}");
        // The port stays visible: the reason to print this type at all is to see where DSH is.
        assert!(printed.contains("3080"), "{printed}");
        Ok(())
    }

    use super::*;

    fn parse(line: &str) -> Result<Option<ReadyLine>, ReadyParseError> {
        ReadyLine::parse(line)
    }

    #[test]
    fn parses_the_plain_form() -> Result<(), ReadyParseError> {
        let some = parse("dsh web: http://127.0.0.1:3080/?token=abc123")?
            .ok_or_else(|| ReadyParseError::NotReady("expected a readiness line".to_owned()))?;
        assert_eq!(some.addr.to_string(), "127.0.0.1");
        assert_eq!(some.port, 3080);
        assert_eq!(some.base_url, "http://127.0.0.1:3080");
        assert_eq!(some.token, "abc123");
        assert_eq!(some.lan_url, None);
        assert_eq!(some.authority(), "127.0.0.1:3080");
        assert_eq!(some.token_url(), "http://127.0.0.1:3080/?token=abc123");
        Ok(())
    }

    #[test]
    fn parses_the_lan_variant_without_letting_it_into_the_token() -> Result<(), ReadyParseError> {
        let some = parse(
            "dsh web: http://127.0.0.1:3080/?token=abc123 (LAN: http://192.168.1.5:3080/?token=abc123)",
        )?
        .ok_or_else(|| ReadyParseError::NotReady("expected a readiness line".to_owned()))?;
        assert_eq!(
            some.token, "abc123",
            "the trailing LAN note must not join the token"
        );
        assert_eq!(some.base_url, "http://127.0.0.1:3080");
        assert_eq!(
            some.lan_url.as_deref(),
            Some("http://192.168.1.5:3080/?token=abc123")
        );
        Ok(())
    }

    #[test]
    fn ordinary_output_is_not_a_readiness_line() -> Result<(), ReadyParseError> {
        // DSH writes plenty of ordinary output to stdout; only the announced
        // prefix may be interpreted, and a non-matching line is simply skipped.
        assert_eq!(parse("some other log line")?, None);
        assert_eq!(parse("")?, None);
        assert_eq!(parse("dsh-web: http://127.0.0.1:1/?token=t")?, None);
        Ok(())
    }

    #[test]
    fn the_browser_handoff_note_is_not_mistaken_for_a_readiness_line() {
        // DSH prints a second `dsh web: ` line when it opens a browser. It carries
        // no URL, so it must be rejected as unusable rather than parsed as one —
        // and the daemon's own spawn always passes --no-open, so seeing it means
        // something changed.
        let outcome = parse("dsh web: opening the default browser; pass --no-open to disable");
        assert!(
            matches!(outcome, Err(ReadyParseError::BadUrl(_))),
            "{outcome:?}"
        );
    }

    #[test]
    fn a_url_without_a_token_is_refused() {
        assert!(matches!(
            parse("dsh web: http://127.0.0.1:3080/"),
            Err(ReadyParseError::NoToken(_))
        ));
    }

    #[test]
    fn a_non_loopback_announcement_is_refused() {
        // The whole project exists to avoid proxying a public bind; if DSH ever
        // announces one, refusing loudly is the correct behaviour.
        let outcome = parse("dsh web: http://0.0.0.0:3080/?token=abc");
        assert!(
            matches!(outcome, Err(ReadyParseError::NotLoopback { .. })),
            "{outcome:?}"
        );
        let outcome = parse("dsh web: http://192.168.1.5:3080/?token=abc");
        assert!(
            matches!(outcome, Err(ReadyParseError::NotLoopback { .. })),
            "{outcome:?}"
        );
    }

    #[test]
    fn accepts_every_loopback_spelling_dsh_might_use() -> Result<(), ReadyParseError> {
        for line in [
            "dsh web: http://127.0.0.1:9/?token=t",
            "dsh web: http://127.5.5.5:9/?token=t",
            "dsh web: http://localhost:9/?token=t",
        ] {
            let some = parse(line)?.ok_or_else(|| {
                ReadyParseError::NotReady(format!("expected a readiness line: {line}"))
            })?;
            assert_eq!(some.token, "t", "{line}");
        }
        // IPv6 loopback parses too; its authority keeps the brackets for `Host`.
        let some = parse("dsh web: http://[::1]:9/?token=t")?
            .ok_or_else(|| ReadyParseError::NotReady("expected a readiness line".to_owned()))?;
        assert_eq!(some.authority(), "[::1]:9");
        assert_eq!(some.addr.to_string(), "::1");
        assert_eq!(some.port, 9);
        Ok(())
    }

    #[test]
    fn trailing_newlines_from_stdout_are_tolerated() -> Result<(), ReadyParseError> {
        let some = parse("dsh web: http://127.0.0.1:3080/?token=abc\r\n")?
            .ok_or_else(|| ReadyParseError::NotReady("expected a readiness line".to_owned()))?;
        assert_eq!(some.token, "abc");
        Ok(())
    }
}
