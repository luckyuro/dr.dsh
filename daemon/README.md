# dr.dsh Daemon

> v0.2.0: `drdsh daemon ...` and `drdsh-daemon ...` are equivalent. Release installation and
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

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), either already installed or installed
  automatically by v0.2.0. Model account/API key setup remains a user step.
  The current integration check covers DSH **`0.2.2-alpha.2`** and **`0.2.1-rc.5`**.
  Earlier checks remain in the
  [compatibility record](../docs/integration/dsh-surface.md). Recheck compatibility after upstream updates.
- Node.js **24.9+** and npm for the current DSH and automatic installation. Release daemon binaries
  need no Rust or pnpm; npm dependencies may need their own native build prerequisites.
- A macOS desktop login or Linux `systemctl --user` session. On Windows, use WSL2 with systemd enabled
  and DSH installed inside the same WSL2 environment.
- A running relay, reachable through a `ws://` or `wss://` address.

## Install and start

Run on the DSH computer. Replace `/absolute/path/to/dsh` with the installed **DeepSeek Harness
executable**; `command -v dsh` shows its path when it is on PATH. See
[DSH installation methods](#dsh-installation-methods) for Git clone and npm examples:

```sh
curl -fsSL https://raw.githubusercontent.com/luckyuro/dr.dsh/master/daemon/install.sh | sh -s -- \
  --dsh /absolute/path/to/dsh --relay ws://127.0.0.1:8787 --start
export PATH="$HOME/.local/bin:$PATH"
drdsh-daemon status
```

The installer detects your OS and CPU, downloads a prebuilt daemon from Release and verifies SHA-256.
It installs under `~/.local` by default, without sudo. No source checkout is needed.
Add `--version v0.2.0` to pin the binary version or `--prefix /path/to/install` for a custom directory.

| Option | Purpose | Default on first installation |
| :--- | :--- | :--- |
| `--dsh /absolute/path/to/dsh` | Select an existing executable and save its absolute path | v0.2.0 packages install pinned DSH privately; older releases find `dsh` on PATH |
| `--workdir /path/to/your/project` | Optional startup working directory for DSH; must already exist | The directory where you run the installer |
| `--dsh-home /path/to/dsh-home` | DSH's own configuration and data directory | `DSH_HOME`, or `~/.dsh` |

For `--dsh`, use the executable file, not the Harness source directory. If `dsh` is a shell alias or
function, supply an executable file that the background service can run. Reinstallation preserves
omitted options. Add `--port 3081` if another
process uses the default port `3080`. Wait for DSH HTTP status to say `responding`;
use `drdsh-daemon logs` if it stays unresponsive.

From v0.2.0, a first installation without `--dsh` downloads pinned
DSH `0.2.2-alpha.2` to a private version directory and installs the bundled plugin. The daemon supplies
its relay and report configuration when launching DSH. Existing DSH executables and external plugin
ownership remain unchanged. This is available from v0.2.0; see
[automatic DSH installation](../docs/operations/dsh-provisioning.md) for the package command,
requirements and recovery. It does not sign in to your model provider.

The `export` affects the current terminal only. Add it to your shell configuration or run
`~/.local/bin/drdsh-daemon` directly. Keep the computer powered on, awake, and online.

## DSH installation methods

`--dsh` accepts one executable file path. The daemon appends `web --no-open --port …` when launching it.
In these examples, `/path/to/your/project` is an existing project directory; substitute your relay's
actual `ws://` or `wss://` address.

### Git clone

For a Git checkout, complete the [upstream build steps](https://github.com/deepseek-ai/deepseek-harness#run-from-source)
inside the cloned repository first:

```sh
cd /absolute/path/to/deepseek-harness
pnpm install
pnpm run build
command -v node
```

The built CLI entry is `apps/cli/lib/bin.js`, as declared in the
[upstream CLI manifest](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/package.json).
Create an executable launcher. **Replace both absolute paths below with the output of
`command -v node` and your own DSH checkout path before running this block**:

```sh
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/dsh-from-source" <<'SH'
#!/bin/sh
exec "/absolute/path/to/node" "/absolute/path/to/deepseek-harness/apps/cli/lib/bin.js" "$@"
SH
chmod +x "$HOME/.local/bin/dsh-from-source"
"$HOME/.local/bin/dsh-from-source" --version

curl -fsSL https://raw.githubusercontent.com/luckyuro/dr.dsh/master/daemon/install.sh | sh -s -- \
  --dsh "$HOME/.local/bin/dsh-from-source" --workdir /path/to/your/project \
  --relay ws://127.0.0.1:8787 --start
```

Absolute paths locate Node and DSH; `exec` lets the daemon supervise Node directly, and `"$@"`
forwards every argument. The launcher preserves the daemon's working directory, so `--workdir`
can select your project. Keep the build output and `node_modules`; cloning alone is insufficient.
`--dsh` cannot take a command string such as `pnpm dsh`.

### npm

For a global npm installation, verify the executable in the same terminal, then pass it to the
daemon. Skip the first line if DSH is already installed:

```sh
npm install -g @deepseek-ai/dsh
"$(npm prefix -g)/bin/dsh" --version

curl -fsSL https://raw.githubusercontent.com/luckyuro/dr.dsh/master/daemon/install.sh | sh -s -- \
  --dsh "$(npm prefix -g)/bin/dsh" --workdir /path/to/your/project \
  --relay ws://127.0.0.1:8787 --start
```

On macOS, Linux, and WSL2, npm places global executable links in `$(npm prefix -g)/bin`; see
[npm's directory documentation](https://docs.npmjs.com/cli/v11/configuring-npm/folders#executables).
You can also locate the installed entry with `command -v dsh` and pass its absolute path to `--dsh`.
For a local npm installation, use `--dsh /absolute/path/to/npm-project/node_modules/.bin/dsh`.
Running only `npx @deepseek-ai/dsh web` may leave no persistent `dsh` on PATH; install it globally
or locally first.

Install the daemon from the terminal where Node works; the installer saves its PATH.
After changing Node versions or moving DSH, update the launcher if applicable and reinstall the
daemon with an explicit `--dsh` to refresh both the executable path and PATH.
Select DSH's configuration directory with `--dsh-home`; `--workdir` remains your startup directory.

## Pair and use DSH

```sh
drdsh-daemon pair
```

Leave the command running and use the code within about five minutes:

1. Open the **relay's HTTPS address** on your phone or another computer. For a same-host trial,
   use the [local relay](http://127.0.0.1:8787).
2. Enter the code under **Pairing code or room key** and click **Connect**.
3. Pairing automatically connects and opens Harness when DSH is running. No second click is needed.

**Keep the dr.dsh page open:** it maintains the tunnel. The floating **dr** button opens connection
management, reload and disconnect controls. The browser remembers pairings;
select a saved computer and connect on later visits. Run `drdsh-daemon pair` again after a failed
or expired attempt. Your phone accesses the relay address; DSH's local port stays private.

## Connect to a remote relay

v0.2.0 includes WSS, native TLS and private CA support; see [TLS configuration](../docs/operations/tls.md).

`--relay` belongs to the daemon: it identifies the relay to connect to. Supply the scheme the
endpoint actually serves; the daemon keeps `ws://` as WS and uses TLS for `wss://`.

| Relay endpoint | Daemon option |
| :--- | :--- |
| Local WS listener | `--relay ws://127.0.0.1:8787` |
| WS listener reached by hostname | `--relay ws://relay.example.com:8787` |
| WSS behind an HTTPS proxy | `--relay wss://relay.example.com` |

For an existing installation, select a relay by running the installer again:

```sh
curl -fsSL https://raw.githubusercontent.com/luckyuro/dr.dsh/master/daemon/install.sh | sh -s -- \
  --relay wss://relay.example.com --start
```

Use an origin without `/ws/daemon` or `/ws/client`; the daemon adds its endpoint path.
WSS verifies the server certificate and hostname against the system's trusted roots by default.
Add `--insecure` to `run`, either pairing command, `install`, or `status` to skip certificate verification;
`--no-insecure` restores it. Installation saves the choice; other commands override it for one invocation.
v0.2.0 add `--ca-cert /path/ca.pem` for private CAs on run, pairing and installation.
Use `run --attach <port> --attach-tls` for an existing HTTPS DSH loopback endpoint; installed managed
HTTPS DSH uses `install --dsh-tls` for both readiness enforcement and health checks.
See [TLS configuration](../docs/operations/tls.md) for certificates, Docker and plugin trust.
The browser opens `https://relay.example.com`; both addresses must reach the same relay.
See the [domain setup](../relay/README.md#custom-domain).

### Optional SSH forwarding

To reach relay through SSH, forward its remote WS listener to the DSH computer.
This example assumes relay listens on `127.0.0.1:8787` on the SSH server and the server allows
TCP forwarding. Run in a terminal on the **DSH / daemon computer**:

```sh
ssh -N -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -L 127.0.0.1:8788:127.0.0.1:8787 user@relay.example.com
```

Replace `user@relay.example.com` with your SSH account and server; add `-p <port>` for a custom
SSH port. Local port `8788` must be free. The final `127.0.0.1:8787` identifies **relay on the SSH
server**. Leave this terminal running. In a second terminal, check the forward and update an
existing daemon installation:

```sh
curl -fsS http://127.0.0.1:8788/healthz
curl -fsSL https://raw.githubusercontent.com/luckyuro/dr.dsh/master/daemon/install.sh | sh -s -- \
  --relay ws://127.0.0.1:8788 --start
drdsh-daemon pair
```

For a first installation, also supply `--dsh` and optional `--workdir` as above. The daemon and
pairing command use the saved local WS address. Browsers can continue reaching the same relay
at `https://relay.example.com`. To forward a browser connection from another computer too,
run a separate SSH forward there and open `http://127.0.0.1:8788`; the loopback address belongs
to the computer running that forward.

Keep SSH running yourself. Exiting it closes the forward; the daemon waits to reconnect.
dr.dsh does not start or manage SSH processes. See the [OpenSSH local forwarding reference](https://man.openbsd.org/ssh.1#L).

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

v0.2.0 packages install the bundled plugin by default for a new daemon-owned installation.
For an existing installation, use `drdsh daemon install plugin --source <bundle>` or add `--with-plugin`.
No pnpm is needed. Remove it with `drdsh-daemon uninstall plugin`.
Installing or removing the plugin restarts a previously running DSH host.

Installing the plugin enables the daemon's local report receiver. Turn completion, approval requests,
goal completion and subagent completion travel through the encrypted tunnel to the connected dr.dsh page.
The page shows an activity list and unread count, highlighting approvals and completed goals. Handle
approvals and questions in the real DSH interface. Notifications contain only event type, severity,
timestamp and an opaque session reference, never message content.

For a source checkout, register the bundle in DSH and run `drdsh daemon run --plugin-reports`.
`DSHD_PLUGIN_REPORTS=1` also enables reporting (`0` disables it; unset defaults to off). Installed
management commands use an explicit `pluginReportsEnabled` value when set, falling back to the
plugin installation record for legacy configurations. The receiver binds a random free
port on `127.0.0.1`; the daemon passes its temporary report credential to the managed DSH process.
No fixed port or saved token is needed. Ordinary local DSH runs leave reporting inactive; the local
management page can still load on a compatible DSH version. Attach
mode does not support reports.

Notifications require paired-device authentication; legacy room-key-only connections do not receive
them. Keep the dr.dsh tab and tunnel connected. Events are not stored or replayed while disconnected;
reconnecting or switching computers clears the list. Web Push, system notifications and offline
delivery are not implemented.
Pairing and revocation take effect while the daemon is running, without restarting DSH.
Revocation also closes that device's existing access.

## Manage daemon from a DSH plugin

A complete plugin bundle contains the page and a matching native daemon manager. The management
surface supports **DSH `0.2.2-alpha.2`** and `0.2.1-rc.5`; see the
[management acceptance record](../docs/operations/daemon-management.md#验证) for the tested scope. Native bundles support Linux x86_64 musl and macOS Apple Silicon, using
the user's systemd or launchd session.

Download `drdsh-plugin-0.2.0.tgz` and its `.sha256` from the
[v0.2.0 Release](https://github.com/luckyuro/dr.dsh/releases/tag/v0.2.0),
[verify the checksum](../docs/operations/releases.md#独立插件包), then install through DSH:

```sh
dsh plugin --profile web add /absolute/path/drdsh-plugin-0.2.0.tgz
dsh web
```

Open DSH's authenticated local URL, then **dr.dsh 管理** (`/_drdsh/manage`). Use the page's local browser
authorization or its private unlock-file fallback. Set the relay address, review the current DSH profile
defaults, and install the daemon. If DSH was started manually, install without starting the service and
confirm the page's handoff plan to restart that host under the daemon. Then create a pairing code in
the page, copy it and submit it once in the relay's PWA to pair and connect.

For access only while DSH is open, skip daemon installation and configure `relayUrl` using the
[standalone plugin steps](../docs/integration/dsh-surface.md#42-不安装-daemon-服务的插件连接).

DSH login alone does not grant management rights. A one-time local browser link expires after five
minutes; management sessions last fifteen minutes and are lost when the plugin restarts. The daemon
blocks this namespace for remote HTTP and WebSocket requests. Keep unlock-file contents private.

Installation, update and operations that stop the host run as independent OS jobs with saved results.
Stopping DSH closes the page too; reopen it after DSH returns and check the job's actual result.
Stopping the whole daemon requires a local CLI or user service manager to start it again.

The plugin installs the daemon with external plugin ownership, reports and local administration enabled.
Its own package remains owned by DSH; daemon updates and removal do not unregister it. Existing CLI
installations keep their previous ownership. `drdsh daemon manage` and the private Unix runtime socket
remain available for local automation.

Build the complete `.tgz` with `scripts/package-plugin.mjs --native <target>=<binary> --output <new.tgz>`;
the native option may be repeated for both platforms. This is a local packaging workflow, not an npm
registry publication. A source-only or legacy reporting bundle without matching native files cannot
bootstrap the management page's native operations. See the
[local management guide](../docs/operations/daemon-management.md) for packaging, authorization, jobs,
handoff, configuration and JSON protocol details.

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
