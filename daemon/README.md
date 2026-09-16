# dr.dsh Daemon

> v0.1.0: `drdsh daemon ...` and `drdsh-daemon ...` are equivalent. Release installation and
> management are native Rust; Node is needed by DSH only. No Cargo or pnpm is needed on the host.
> Packages support macOS arm64 and Linux x86_64 musl. See [release installation](../docs/operations/releases.md).

[中文](README.zh.md) · [Project home](../README.md) · [Relay](../relay/README.md)

**Runs on your DSH computer, manages DSH, and establishes encrypted remote connections.**
Install and run the daemon independently, connecting it to an existing relay.

## Features

- Starts, supervises, stops, and restarts local DSH, and proxies its real interface.
- Pairs browsers, establishes end-to-end encrypted tunnels, and stores device registrations and room keys.
- Maintains the relay connection and records local audit and crash reports.
- Can attach to an existing DSH process; remote lifecycle operations are unavailable in this mode.

The [relay](../relay/README.md) distributes the browser client (PWA) and forwards encrypted traffic.

## Prerequisites

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) installed and configured, with local tasks working.
  The integration baseline is DSH **`0.1.5-rc.2`**; check compatibility after upstream updates.
- Node.js 24+ (or 22.19+ on the 22.x line) for DSH. Rust and a compiler are only needed for source builds.
  Installing the base daemon does not require pnpm.
- A macOS desktop login or Linux `systemctl --user` session. On Windows, use WSL2 with systemd enabled
  and DSH installed inside the same WSL2 environment.
- A running relay. Use `ws://127.0.0.1:8787` on the same host; establish the secure forward below for a remote relay.

## Install and start

Run on the DSH computer, replacing the project path with an existing directory:

```sh
git clone https://github.com/luckyuro/dr.dsh.git
cd dr.dsh
sh daemon/install.sh --relay ws://127.0.0.1:8787 --workdir /path/to/your/project --start
export PATH="$HOME/.local/bin:$PATH"
drdsh-daemon status
```

The installer downloads a prebuilt daemon from Release, under `~/.local` by default, without sudo.
Add `--dsh /absolute/path/to/dsh` if DSH is outside your PATH, or `--port 3081` if another process uses
the default port `3080`. Omitting `--workdir` uses the current directory. Wait for DSH HTTP status
to say `responding`; use `drdsh-daemon logs` if it stays unresponsive.

The `export` affects the current terminal only. Add it to your shell configuration or run
`~/.local/bin/drdsh-daemon` directly. Keep the computer powered on, awake, and online.

## Pair and use DSH

```sh
drdsh-daemon pair
```

Leave the command running and use the code within about five minutes:

1. Open the **relay's HTTPS address** on your phone or another computer. For a same-host trial,
   use the [local relay](http://127.0.0.1:8787).
2. Enter the code under **Pairing code or room key** and click **Connect**.
3. After **Paired** appears, click **Connect** again.
4. Click **Open the DeepSeek Harness interface** to use DSH in a new tab.

**Keep the original dr.dsh tab open:** it maintains the tunnel. The browser remembers pairings;
select a saved computer and connect on later visits. Run `drdsh-daemon pair` again after a failed
or expired attempt. Your phone accesses the relay address; DSH's local port stays private.

## Connect to a remote relay

The daemon cannot connect directly to `wss://` yet. Use SSH on the DSH computer to forward the server's relay:

```sh
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:8788:127.0.0.1:8787 user@relay-host
```

Replace the SSH user and server address and leave this running. In another terminal, install or
update the daemon using `--relay ws://127.0.0.1:8788`. For an existing installation:

```sh
sh daemon/install.sh --relay ws://127.0.0.1:8788 --start
```

The browser still opens the server's HTTPS address. Both addresses must reach the same relay.
You maintain the SSH connection; daemon login autostart does not start SSH.

## Everyday commands

| Operation | Command |
| :--- | :--- |
| Start / stop / restart daemon and its managed DSH | `drdsh-daemon start` / `drdsh-daemon stop` / `drdsh-daemon restart` |
| Status / recent logs | `drdsh-daemon status` / `drdsh-daemon logs` |
| Follow logs | `drdsh-daemon logs --follow` |
| Enable / disable login autostart | `drdsh-daemon enable` / `drdsh-daemon disable` |
| Pair / list devices | `drdsh-daemon pair` / `drdsh-daemon devices` |
| Revoke a device | `drdsh-daemon devices --revoke <id>` |
| Audit / crash records | `drdsh-daemon audit` / `drdsh-daemon crashes` |
| Install from Release | `drdsh daemon update` |
| Uninstall daemon and optional plugin | `drdsh-daemon uninstall` |

These commands manage only the daemon. Updates restart a previously running daemon and its DSH,
preserving pairings. The relay's process and configuration remain unchanged. `enable` / `disable`
only change login autostart; use `start` / `stop` for immediate action.
`status` checks the process and DSH HTTP responses; verify the complete connection in your browser.

## Optional plugin

The Release bundle includes the plugin; no pnpm is needed. Register it with `drdsh daemon install plugin --source <bundle>`, or add `--with-plugin`
when first installing the daemon. Remove it with `drdsh-daemon uninstall plugin`.
Installing or removing the plugin restarts a previously running DSH host.

The receiver for supplementary plugin notifications and background push are not implemented yet.
You can handle approvals and questions in the real DSH interface.

## Separate files and configuration

The default prefix is `~/.local`; override it with `--prefix /path/to/install`:

| Path | Contents |
| :--- | :--- |
| `bin/drdsh-daemon` | Daemon management command |
| `etc/dr.dsh/daemon.json` | DSH path, project directory, relay address, and installation record |
| `lib/dr.dsh/daemon/bin/drdsh` | Daemon binary |
| `lib/dr.dsh/daemon/plugin` | Optional plugin |
| `lib/dr.dsh/daemon/services` | Service definitions |
| `lib/dr.dsh/daemon/logs` | macOS logs; Linux uses the user journal |
| `share/dr.dsh/daemon` | Room key, device registrations, audit and crash records; configurable with `--state-dir` |

Back up the complete state directory. Uninstalling preserves configuration and state and leaves relay
files intact. Legacy `drdsh` uses a different installation record; see the
[migration guide](../docs/operations/cli.md#从旧版安装迁移) to preserve existing pairings.

Implementation: [`crates/dr-dsh-daemon`](../crates/dr-dsh-daemon).
More: [attach mode](../docs/operations/install.md#附着模式dsh-已经在你手里跑着),
[troubleshooting](../docs/operations/troubleshooting.md), [security model](../docs/security.md).
