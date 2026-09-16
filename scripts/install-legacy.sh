#!/bin/sh
# Run from a checkout; no remote script or unpublished artifact is fetched.
set -eu
if ! command -v node >/dev/null 2>&1; then
  echo 'dr.dsh: install Node.js 22.19+ (or 24+) first, then run this installer again.' >&2
  exit 1
fi
DRDSH_SOURCE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec node "$DRDSH_SOURCE/scripts/drdsh.mjs" install "$@"
