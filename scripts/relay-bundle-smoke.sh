#!/bin/sh
# Linux acceptance on a server with no Node, pnpm or Cargo: bundle dir, then a disposable test root.
# Requires a systemd user session and curl for HTTP assertions. Uses only its own install prefix.
set -eu
if [ "$#" -ne 2 ]; then echo 'usage: sh scripts/relay-bundle-smoke.sh BUNDLE_DIR TEST_ROOT' >&2; exit 2; fi
DRDSH_BUNDLE=$(CDPATH= cd -- "$1" && pwd)
DRDSH_SCRATCH=$2
DRDSH_PREFIX="$DRDSH_SCRATCH/space & % \$literal \"double\" 'single'"
DRDSH_CTL=$DRDSH_PREFIX/bin/drdsh-relayctl
DRDSH_PORT=${DRDSH_TEST_PORT:-48783}
DRDSH_CHECKS=0
if ! systemctl --user show-environment >/dev/null 2>&1; then echo 'need a systemd user session' >&2; exit 2; fi
if [ -e "$DRDSH_SCRATCH" ]; then echo 'choose a new, disposable TEST_ROOT' >&2; exit 2; fi
mkdir -p "$DRDSH_SCRATCH"
drdsh_check() { DRDSH_CHECKS=$((DRDSH_CHECKS + 1)); echo "ok $DRDSH_CHECKS - $1"; }
drdsh_cleanup() {
  if [ -x "$DRDSH_CTL" ]; then "$DRDSH_CTL" uninstall >/dev/null 2>&1 || true; fi
}
trap drdsh_cleanup EXIT
trap 'exit 1' HUP INT TERM
for DRDSH_TOOL in node pnpm cargo python3 jq; do
  if command -v "$DRDSH_TOOL" >/dev/null 2>&1; then echo "test requires a server without $DRDSH_TOOL" >&2; exit 2; fi
done
drdsh_check 'server has no JS, Rust, Python or jq tools'
sh "$DRDSH_BUNDLE/install.sh" --prefix "$DRDSH_PREFIX" --bind "127.0.0.1:$DRDSH_PORT"
if "$DRDSH_CTL" status; then echo 'installation unexpectedly started the service' >&2; exit 1; fi
"$DRDSH_CTL" disable
drdsh_check 'install and disable work before first start'
DRDSH_UNIT=$(basename "$DRDSH_PREFIX"/lib/dr.dsh/relay/services/*.service)
systemd-analyze --user verify "$DRDSH_PREFIX/lib/dr.dsh/relay/services/$DRDSH_UNIT"
"$DRDSH_CTL" start
"$DRDSH_CTL" status
DRDSH_PID=$(systemctl --user show "$DRDSH_UNIT" --property=MainPID --value)
"$DRDSH_CTL" start
test "$DRDSH_PID" = "$(systemctl --user show "$DRDSH_UNIT" --property=MainPID --value)"
curl -fsS "http://127.0.0.1:$DRDSH_PORT/client/shell.js" > "$DRDSH_SCRATCH/shell.js"
cmp "$DRDSH_SCRATCH/shell.js" "$DRDSH_BUNDLE/client/shell.js"
drdsh_check 'systemd handles literal paths, starts idempotently and serves the built PWA'
"$DRDSH_CTL" enable
test "$(systemctl --user is-enabled "$DRDSH_UNIT")" = enabled
"$DRDSH_CTL" disable
test "$DRDSH_PID" = "$(systemctl --user show "$DRDSH_UNIT" --property=MainPID --value)"
drdsh_check 'autostart changes preserve the running relay'
"$DRDSH_CTL" install client
"$DRDSH_CTL" status
test "$DRDSH_PID" != "$(systemctl --user show "$DRDSH_UNIT" --property=MainPID --value)"
DRDSH_PID=$(systemctl --user show "$DRDSH_UNIT" --property=MainPID --value)
"$DRDSH_CTL" install
"$DRDSH_CTL" status
test "$DRDSH_PID" != "$(systemctl --user show "$DRDSH_UNIT" --property=MainPID --value)"
drdsh_check 'PWA and complete bundle updates restore the running service'
"$DRDSH_CTL" logs > "$DRDSH_SCRATCH/logs.txt"
"$DRDSH_CTL" stop
"$DRDSH_CTL" stop
if "$DRDSH_CTL" status; then echo 'stopped relay status unexpectedly succeeds' >&2; exit 1; fi
"$DRDSH_CTL" start
"$DRDSH_CTL" restart
"$DRDSH_CTL" status
drdsh_check 'logs, idempotent stop, start and restart work after disabling autostart'
"$DRDSH_CTL" uninstall
test ! -e "$DRDSH_CTL"
test -f "$DRDSH_PREFIX/etc/dr.dsh/relay.json"
sh "$DRDSH_BUNDLE/install.sh" --prefix "$DRDSH_PREFIX" --start
"$DRDSH_CTL" status
curl -fsS "http://127.0.0.1:$DRDSH_PORT/healthz" >/dev/null
drdsh_check 'uninstall and reinstall retain the configured port'
"$DRDSH_CTL" uninstall
echo "Passed $DRDSH_CHECKS Linux bundle checks without language runtimes on the server."
