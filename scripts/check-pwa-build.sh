#!/bin/sh
# Packaging must not silently ship an older logo or omit an icon copied by the PWA build.
set -eu
drdsh_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
drdsh_dist=$drdsh_root/apps/pwa/dist
for drdsh_name in session.js service-worker.js offline.js i18n.js; do
  [ -s "$drdsh_dist/$drdsh_name" ] || {
    echo "PWA build is missing $drdsh_name; run pnpm --filter @dr.dsh/pwa build before packaging." >&2
    exit 1
  }
done
for drdsh_source in "$drdsh_root/apps/pwa/static/"* "$drdsh_root/apps/pwa/src/shell.js" "$drdsh_root/apps/pwa/src/ws-bootstrap.js"; do
  drdsh_name=${drdsh_source##*/}
  [ -s "$drdsh_source" ] && cmp -s "$drdsh_source" "$drdsh_dist/$drdsh_name" || {
    echo "PWA build has missing or stale $drdsh_name; run pnpm --filter @dr.dsh/pwa build before packaging." >&2
    exit 1
  }
done
for drdsh_test in "$drdsh_dist/"*.test.js; do
  [ ! -e "$drdsh_test" ] || {
    echo 'PWA build contains test output; run pnpm --filter @dr.dsh/pwa build after typechecking and before packaging.' >&2
    exit 1
  }
done
