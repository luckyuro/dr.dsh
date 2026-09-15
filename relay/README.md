# dr.dsh Relay

[中文](README.zh.md) · [Project home](../README.md) · [Daemon](../daemon/README.md)

**A server component that serves the browser client and forwards encrypted traffic.**
Install, update, and run the relay independently. The server does not need DSH.

## Features

- Serves the browser client (PWA) for phones and other computers.
- Connects clients to daemons by room and forwards end-to-end encrypted traffic.
- Provides keepalive, capacity limits, and a `/healthz` health check.

The [daemon](../daemon/README.md) handles DSH processes, pairing, device registration, and keys.

## Install with one command

Source installation needs Node.js 24+ (or 22.19+ on the 22.x line), Rust stable, pnpm 12.3.4, and
your platform's compiler toolchain. Service management supports a macOS desktop login, a Linux
`systemctl --user` session, or WSL2 with systemd enabled.

Run on the relay server:

```sh
git clone https://github.com/luckyuro/dr.dsh.git
cd dr.dsh
sh relay/install.sh --start
export PATH="$HOME/.local/bin:$PATH"
drdsh-relayctl status
```

The installer builds only the relay and PWA. It installs under `~/.local` by default, without sudo.
When status reports `relay health: responding`, open the [local page](http://127.0.0.1:8787).
Install and start a daemon to pair and access DSH through this page.

The `export` affects the current terminal only. Add it to your shell configuration or run
`~/.local/bin/drdsh-relayctl` directly.

## Make it reachable

The relay listens on `127.0.0.1:8787` by default. Other devices need a reachable **HTTPS entry point
with a trusted certificate**, reverse-proxying to this port on the same host.
See the [self-hosting guide](../docs/operations/self-hosting.md) for configuration examples.

Give users the browser's HTTPS address. A daemon on the same host uses `ws://127.0.0.1:8787`.
On a separate host, the daemon currently needs a [secure forward such as SSH](../daemon/README.md#connect-to-a-remote-relay);
it cannot connect directly to WSS yet.

## Everyday commands

| Operation | Command |
| :--- | :--- |
| Start / stop / restart | `drdsh-relayctl start` / `drdsh-relayctl stop` / `drdsh-relayctl restart` |
| Status / recent logs | `drdsh-relayctl status` / `drdsh-relayctl logs` |
| Follow logs | `drdsh-relayctl logs --follow` |
| Enable / disable login autostart | `drdsh-relayctl enable` / `drdsh-relayctl disable` |
| Update relay and PWA | `drdsh-relayctl install --source /path/to/dr.dsh` |
| Update only the PWA | `drdsh-relayctl install client` |
| Uninstall relay and PWA | `drdsh-relayctl uninstall` |

Reinstall to change the listening port, for example `drdsh-relayctl install --bind 127.0.0.1:8788`.
Updates and restarts affect only the relay. Connections drop and need to be re-established;
the daemon and its DSH process keep running. `enable` / `disable` only change login autostart;
use `start` / `stop` for immediate action.

## Separate files and configuration

These paths are relative to the default `~/.local` prefix. Override it with `--prefix /path/to/install`.

| Path | Contents |
| :--- | :--- |
| `bin/drdsh-relayctl` | Relay management command |
| `etc/dr.dsh/relay.json` | Relay configuration and installation record |
| `lib/dr.dsh/relay/bin/drdsh-relay` | Relay binary |
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
