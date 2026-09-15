# dr.dsh

English | [中文](README.zh.md)

**Use the DeepSeek Harness on your own computer from a phone or another computer's browser.**

dr.dsh provides remote access to the real DSH interface, process management, and device pairing.
DSH runs on your computer. Session traffic is encrypted end to end between the browser and daemon,
through a relay you host.

## Two independent components

| | Relay: your server | Daemon: your DSH computer |
| :--- | :--- | :--- |
| Features | Serves the browser client (PWA), forwards encrypted traffic, provides keepalive and health checks | Manages local DSH, pairs devices, establishes encrypted tunnels, records audit and crash reports |
| Where to install | Your server, or the same host as the daemon | A computer with DSH installed |
| Install | `sh relay/install.sh --start` | `sh daemon/install.sh --start` |
| Management command | `drdsh-relayctl` | `drdsh-daemonctl` |
| Separate guide | **[Relay setup and usage](relay/README.md)** | **[Daemon setup and usage](daemon/README.md)** |

Each has its own configuration, program directory, logs, services, and update lock. Updating or
uninstalling one does not restart or uninstall the other. Restarting the relay interrupts connections
and requires reconnection; the DSH process keeps running.

```text
Phone / browser ⇄ Relay (server + PWA) ⇄ Daemon (your computer) → DSH
```

**Version `0.0.0`: available to build from source and self-host.** There are no prebuilt installers,
published npm packages, or official hosted relay. Both components remain in this repository and
share protocol definitions, with independent builds and deployments.

## Quick start

Try both on one computer first, or deploy them separately. Run the following on each machine that
needs a source checkout:

```sh
git clone https://github.com/luckyuro/dr.dsh.git
cd dr.dsh
```

Source installation needs Node.js 24+ (or 22.19+ on the 22.x line), Rust stable, and your platform's
compiler toolchain. Relay also needs pnpm 12.3.4. Daemon needs DSH with a model configured; its base
installation does not require pnpm. Services support a macOS desktop login, a Linux
`systemctl --user` session, or WSL2 with systemd enabled on Windows.

### 1. Install Relay

Run on the relay server, or on your current computer for a same-host trial:

```sh
sh relay/install.sh --start
export PATH="$HOME/.local/bin:$PATH"
drdsh-relayctl status
```

When status says `relay health: responding`, the relay is ready. It listens on `127.0.0.1:8787` by
default. For phones and other computers, configure a [reachable HTTPS entry point](relay/README.md#make-it-reachable).

### 2. Install Daemon

Run on the DSH computer. The address below works for a **relay on the same host**. For a relay on
another server, establish a [secure forward](daemon/README.md#connect-to-a-remote-relay) first and
use its local address. Replace the project path with an existing directory:

```sh
sh daemon/install.sh --relay ws://127.0.0.1:8787 --workdir /path/to/your/project --start
export PATH="$HOME/.local/bin:$PATH"
drdsh-daemonctl status
```

Add `--dsh /absolute/path/to/dsh` if DSH is outside PATH, or `--port 3081` if an existing DSH uses
`3080`. The installer does not install or configure upstream DSH. The integration baseline is DSH
`0.1.5-rc.2`; check compatibility after upstream updates.

Both management commands install under `~/.local/bin` by default. The `export` affects only the
current terminal; add it to your shell configuration for later use.

### 3. Pair and open DSH

Run on the DSH computer and leave the command waiting:

```sh
drdsh-daemonctl pair
```

1. Open the relay's HTTPS address in your browser. For a same-host trial, use the [local relay](http://127.0.0.1:8787).
2. Enter the terminal's code under **Pairing code or room key** and click **Connect**.
3. After **Paired** appears, click **Connect** again to establish the tunnel.
4. Click **Open the DeepSeek Harness interface** to use DSH in a new tab.

**Keep the original dr.dsh tab open:** it maintains the connection. Codes are single-use and valid
for about five minutes; generate a new one after failure or expiry. Your browser remembers pairings
for later visits and can add several computers.

## Everyday management

| Operation | Relay | Daemon |
| :--- | :--- | :--- |
| Start | `drdsh-relayctl start` | `drdsh-daemonctl start` |
| Stop | `drdsh-relayctl stop` | `drdsh-daemonctl stop` |
| Restart | `drdsh-relayctl restart` | `drdsh-daemonctl restart` |
| Status | `drdsh-relayctl status` | `drdsh-daemonctl status` |
| Follow logs | `drdsh-relayctl logs --follow` | `drdsh-daemonctl logs --follow` |
| Login autostart | `drdsh-relayctl enable` | `drdsh-daemonctl enable` |
| Install from updated source | `drdsh-relayctl install --source /path/to/dr.dsh` | `drdsh-daemonctl install --source /path/to/dr.dsh` |
| Uninstall | `drdsh-relayctl uninstall` | `drdsh-daemonctl uninstall` |

Use `disable` to cancel login autostart and `stop` to stop a running service. Uninstalling preserves
each component's configuration and logs, and the daemon's pairing data. Relay includes the PWA;
install the optional plugin on the daemon side with `drdsh-daemonctl install plugin`.

The original `sh install.sh` / `drdsh` commands remain available for legacy installation records,
which use a different layout. Existing users should follow the
[migration guide](docs/operations/cli.md#从旧版安装迁移) to preserve pairings.

## Current requirements and limits

- Keep the DSH computer powered on, awake, and online.
- Remote browsers need HTTPS. The daemon cannot dial WSS directly yet; use a secure forward such as SSH for separate hosts, as described in the Daemon guide.
- Background push and the receiver for supplementary plugin notifications are not implemented. Handle approvals and questions in the real DSH interface while connected.
- The relay also distributes client code, so its infrastructure must be trusted. There has been no third-party security audit; see the [security model](docs/security.md).

## Documentation and development

- **[Relay guide](relay/README.md)**: independent installation, commands, configuration, and Docker.
- **[Daemon guide](daemon/README.md)**: independent installation, remote connections, pairing, plugins, and state backups.
- [Full CLI and migration](docs/operations/cli.md), [troubleshooting](docs/operations/troubleshooting.md), [MVP status](docs/product/mvp.md).
- [Architecture](docs/architecture.md), [design decisions](docs/decisions/README.md), [contributing](docs/development/contributing.md), [repository rules](AGENTS.md).

Detailed documentation under `docs/` is currently in Chinese.

```sh
pnpm install
pnpm run verify
```

## License

MIT.
