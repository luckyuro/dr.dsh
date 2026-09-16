#!/bin/sh
set -eu
DRDSH_INSTALL_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DRDSH_SOURCE=$DRDSH_INSTALL_DIR
if [ -f "$DRDSH_INSTALL_DIR/../Cargo.toml" ]; then
  DRDSH_SOURCE=$(CDPATH= cd -- "$DRDSH_INSTALL_DIR/.." && pwd)
fi
DRDSH_PROFILE=release
DRDSH_SKIP_BUILD=no
DRDSH_HAS_SOURCE=no
DRDSH_PREVIOUS=
for DRDSH_ARGUMENT in "$@"; do
  case "$DRDSH_PREVIOUS" in
    --source) DRDSH_SOURCE=$DRDSH_ARGUMENT; DRDSH_HAS_SOURCE=yes ;;
    --build-profile) DRDSH_PROFILE=$DRDSH_ARGUMENT ;;
  esac
  case "$DRDSH_ARGUMENT" in
    --skip-build) DRDSH_SKIP_BUILD=yes ;;
    --help|-h)
      echo 'Install relay/PWA without Node.js: sh install.sh [--prefix PATH] [--start] [--enable]'
      echo 'Use --source DIR for an extracted bundle or checkout; source installs need Cargo and a prebuilt PWA (--client-dir DIR).'
      echo 'Source options: --skip-build --build-profile release|debug. Prepare bundles on a build machine with relay/package.sh.'
      exit 0 ;;
  esac
  DRDSH_PREVIOUS=$DRDSH_ARGUMENT
done
case "$DRDSH_PROFILE" in
  release|debug) ;;
  *) echo 'dr.dsh relay: --build-profile must be release or debug.' >&2; exit 1 ;;
esac
if [ -x "$DRDSH_SOURCE/bin/drdsh-relayctl" ]; then
  DRDSH_CTL=$DRDSH_SOURCE/bin/drdsh-relayctl
else
  DRDSH_CTL=$DRDSH_SOURCE/target/$DRDSH_PROFILE/drdsh-relayctl
  if [ "$DRDSH_SKIP_BUILD" = no ]; then
    if ! command -v cargo >/dev/null 2>&1; then
      echo 'dr.dsh relay: this is a source checkout. Install Rust or use a relay bundle containing bin/drdsh-relayctl and prebuilt PWA files; Node.js is not needed.' >&2
      exit 1
    fi
    if [ "$DRDSH_PROFILE" = release ]; then
      cargo build --manifest-path "$DRDSH_SOURCE/Cargo.toml" --target-dir "$DRDSH_SOURCE/target" --locked --release -p dr-dsh-relayctl
    else
      cargo build --manifest-path "$DRDSH_SOURCE/Cargo.toml" --target-dir "$DRDSH_SOURCE/target" --locked -p dr-dsh-relayctl
    fi
  fi
fi
if [ ! -x "$DRDSH_CTL" ]; then
  echo "dr.dsh relay: missing native installer $DRDSH_CTL; build dr-dsh-relayctl or unpack a complete relay bundle." >&2
  exit 1
fi
if [ "$DRDSH_HAS_SOURCE" = yes ]; then
  exec "$DRDSH_CTL" install "$@"
fi
exec "$DRDSH_CTL" install --source "$DRDSH_SOURCE" "$@"
