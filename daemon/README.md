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
Add `--version v0.1.1` to pin the binary version or `--prefix /path/to/install` for a custom directory.

| Option | Purpose | Default on first installation |
| :--- | :--- | :--- |
| `--dsh /absolute/path/to/dsh` | The executable used to launch DeepSeek Harness; the installer saves its absolute path | Find `dsh` on PATH |
| `--workdir /path/to/your/project` | Optional startup working directory for DSH; must already exist | The directory where you run the installer |
| `--dsh-home /path/to/dsh-home` | DSH's own configuration and data directory | `DSH_HOME`, or `~/.dsh` |

For `--dsh`, use the executable file, not the Harness source directory. If `dsh` is a shell alias or
function, supply an executable file that the background service can run. The installer does not install
or configure upstream DSH. Reinstallation preserves omitted options. Add `--port 3081` if another
process uses the default port `3080`. Wait for DSH HTTP status to say `responding`;
use `drdsh-daemon logs` if it stays unresponsive.

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
3. After **Paired** appears, click **Connect** again.
4. Click **Open the DeepSeek Harness interface** to use DSH in a new tab.

**Keep the original dr.dsh tab open:** it maintains the tunnel. The browser remembers pairings;
select a saved computer and connect on later visits. Run `drdsh-daemon pair` again after a failed
or expired attempt. Your phone accesses the relay address; DSH's local port stays private.

## Connect to a remote relay

WSS is available in the updated source build and has not been published to Release yet;
see [build and release notes](../docs/operations/releases.md).

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
WSS verifies the server certificate and hostname against the system's trusted roots.
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
