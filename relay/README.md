# dr.dsh Relay

[中文](README.zh.md) · [Project home](../README.md) · [Daemon](../daemon/README.md)

**A server component that serves the browser client and forwards encrypted traffic.**
Install, update, and run the relay independently. A bundled installation needs no DSH, Node.js, pnpm, or Rust on the server.

## Features

- Serves the browser client (PWA) for phones and other computers.
- Connects clients to daemons by room and forwards end-to-end encrypted traffic.
- Provides keepalive, capacity limits, and a `/healthz` health check.

The [daemon](../daemon/README.md) handles DSH processes, pairing, device registration, and keys.

## Install without Node on the server

On Linux x86_64, download the static musl relay and prebuilt PWA from Release, verify SHA-256, then install:

```sh
sh relay/install.sh --start
export PATH="$HOME/.local/bin:$PATH"
drdsh relay status
```

Downloading needs Shell, curl, tar and sha256sum or shasum. Installation and management need no Node,
pnpm, Rust, Python or jq. The default prefix is `~/.local`, without sudo. Services require a Linux
systemd user session; without `--start` / `--enable`, they remain stopped without login autostart.
`drdsh-relay ...` equals `drdsh relay ...`; renaming a standalone binary cannot enable daemon.

For offline use, download and verify `drdsh-relay-x86_64-unknown-linux-musl.tar.gz`, extract it and run
its `sh install.sh --start`. This release provides only daemon on macOS; relay can be built from source.
See [release installation](../docs/operations/releases.md) for mixed packages, platforms and pinned versions.

### Source installation

Build PWA and CLI on a development machine, then run the native installer:

```sh
pnpm --filter @dr.dsh/pwa build
cargo build -p dr-dsh-cli
target/debug/drdsh relay install --source "$PWD" --skip-build --build-profile debug --start
```

Use `--client-dir` for separately built PWA files. Missing artifacts fail before stopping services;
the native installer never runs pnpm. `relay/package.sh` / `relay/install-source.sh` preserve the old
manager for migration regression checks; new releases use `scripts/build-release.sh` and
`scripts/package-release.sh`.

## Make it reachable

The relay listens on `127.0.0.1:8787` by default. Other devices need a reachable **HTTPS entry point
with a trusted certificate**, reverse-proxying to this port on the same host.
See the [self-hosting guide](../docs/operations/self-hosting.md) for configuration examples.

Give users the browser's HTTPS address. A daemon on the same host uses `ws://127.0.0.1:8787`.
On a separate host, the daemon currently needs a [secure forward such as SSH](../daemon/README.md#connect-to-a-remote-relay);
it cannot connect directly to WSS yet.

## Serve the PWA directly with nginx

The PWA consists of static HTML, JavaScript, icons, and a manifest. Its JavaScript executes in the
browser. The [nginx example](nginx.conf.example) serves `/` and `/client/*` from disk and proxies
only `/ws/*` and `/healthz` to Rust relay. Proxying everything to relay's static server also works.

Copy the archive's `client/` to a public directory such as `/srv/dr.dsh-relay/client`, readable and
traversable by nginx's worker user. Keep the private installation and configuration directories private.
Set the example's hostname, certificates, root, and relay port. Keep same-origin HTTPS, CSP, MIME/cache
headers, and `Service-Worker-Allowed: /`. Update the public copy alongside the corresponding relay.
The browser's Service Worker retrieves DSH pages through the encrypted tunnel; nginx does not access DSH.

## Everyday commands

| Operation | Command |
| :--- | :--- |
| Start / stop / restart | `drdsh-relay start` / `drdsh-relay stop` / `drdsh-relay restart` |
| Status / recent logs | `drdsh-relay status` / `drdsh-relay logs` |
| Follow logs | `drdsh-relay logs --follow` |
| Enable / disable login autostart | `drdsh-relay enable` / `drdsh-relay disable` |
| Update relay and PWA | `drdsh relay update` |
| Update only the PWA | `drdsh relay install client --source /path/to/bundle` |
| Uninstall relay and PWA | `drdsh-relay uninstall` |

Reinstall to change the listening port, for example `sh relay/install.sh --bind 127.0.0.1:8788`.
Updates and restarts affect only the relay. Connections drop and need to be re-established;
the daemon and its DSH process keep running. `enable` / `disable` only change login autostart;
use `start` / `stop` for immediate action.

## Separate files and configuration

These paths are relative to the default `~/.local` prefix. Override it with `--prefix /path/to/install`.

| Path | Contents |
| :--- | :--- |
| `bin/drdsh-relay` | Relay management command |
| `etc/dr.dsh/relay.json` | Relay configuration and installation record |
| `lib/dr.dsh/relay/bin/drdsh` | Relay binary |
| `lib/dr.dsh/relay/bin/drdsh` | Native management binary |
| `lib/dr.dsh/relay/client` | PWA files |
| `lib/dr.dsh/relay/services` | Service definitions |
| `lib/dr.dsh/relay/logs` | macOS logs; Linux uses the user journal |

Relay configuration contains no DSH executable, project directory, or key directory. Uninstalling
preserves its configuration and logs and leaves daemon files intact. Even under the same prefix,
the two components have separate commands, configurations, services, update locks, and program directories.

## Docker alternative

Use Docker Compose from the repository root as an alternative to the user service installation:

```sh
docker compose up --build -d
```

Manage this instance with Compose:

| Operation | Command |
| :--- | :--- |
| Status | `docker compose ps` |
| Restart | `docker compose restart relay` |
| Logs | `docker compose logs -f relay` |
| Stop and remove the container | `docker compose down` |

The image builds from source and includes the PWA. The host does not need Rust, Node.js, or DSH.
Your reverse proxy still provides HTTPS.

## Implementation and boundaries

The relay lives in [`crates/dr-dsh-relay`](../crates/dr-dsh-relay); its client is in [`apps/pwa`](../apps/pwa).
The relay cannot decrypt sessions, holds no keys, and has no session database. It also distributes
client code, so its infrastructure must be trusted. See the [security model](../docs/security.md) and
[relay design decision](../docs/decisions/0002-zero-knowledge-relay.md).

For an existing `drdsh` installation, see the [migration guide](../docs/operations/cli.md#从旧版安装迁移).

An existing independent `relay.json` installation can run the new installer with the same `--prefix`;
its configuration and service identity are retained while JS management files are replaced.
