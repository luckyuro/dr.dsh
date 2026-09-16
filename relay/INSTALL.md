# Install a locally built dr.dsh relay bundle

This archive contains `bin/drdsh-relay`, `bin/drdsh-relayctl`, prebuilt PWA files in `client/`,
and a shell entry point. It requires a matching operating system and CPU architecture.
Installing and managing the bundle uses no Node.js, pnpm, Cargo, Python or jq.
It uses macOS launchd or a Linux systemd **user** session. Native Windows service management
is unsupported; use systemd-enabled WSL2 with a Linux bundle.

```sh
sh install.sh --start
export PATH="$HOME/.local/bin:$PATH"
drdsh-relayctl status
```

Without `--start` or `--enable`, installation does not start a service or enable login autostart.
The default prefix is `~/.local`; choose another with `--prefix /absolute/path`.
The default bind address is `127.0.0.1:8787`; set a different IP/port with `--bind`.

Commands: `start`, `stop`, `restart`, `status`, `logs [--follow]`, `enable`, `disable`, `uninstall`.
`enable` and `disable` only change login autostart. Linux logout persistence requires an
administrator to configure user lingering. macOS services require a GUI login session.

Update by extracting a new bundle and running its installer, or:

```sh
drdsh-relayctl install --source /absolute/path/to/new-bundle
```

The source path is saved for future updates. Keep the extracted bundle if you want to reinstall
from that path; it is not used by the running service. An update preserves the saved bind address
and restores a previously running relay. PWA-only updates use `install client --source DIR`.
Updates interrupt relay connections but do not change daemon files, configuration or processes.
Uninstall preserves `etc/dr.dsh/relay.json` and relay logs. It does not remove the daemon.

Existing independently installed relays using `relay.json` can run this installer with the same
`--prefix`. It preserves their service identity and replaces only their relay management files.
Old combined installations using `config.json` remain separate; stop them before moving their port
to a new installation. Their `drdsh` command still requires Node.js.

## HTTPS and optional nginx static hosting

Use a trusted HTTPS endpoint in front of relay for remote browsers. The relay itself serves
plain HTTP/WebSocket on loopback. You can proxy all requests to it, or let nginx serve the PWA
directly with `nginx.conf.example` (placed inside nginx's `http` context).

For direct static hosting, copy `client/` to a public directory such as `/srv/dr.dsh-relay/client`.
Give the nginx worker read/traverse access to that public copy; do not expose the private install
or configuration directories. Set the example's root, hostname, certificates and relay port.
Update that public copy alongside the matching relay version.

The example serves `/` and `/client/*` from disk, proxies `/ws/*` and `/healthz` to relay,
and grants `/client/service-worker.js` the `Service-Worker-Allowed: /` header. Keep all of these
paths on the same origin and retain the security, content-type and cache headers.
DSH's interface is fetched through the encrypted browser/daemon tunnel; it is not a static asset.
The browser executes JavaScript; nginx and relay do not execute it.

This is a locally assembled archive, not an officially published or signed release.
