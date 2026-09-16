#!/bin/sh
# Run on the build machine; the resulting archive needs no JS or Rust toolchain on the server.
set -eu
DRDSH_SOURCE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DRDSH_PROFILE=release
DRDSH_TARGET=
DRDSH_OUTPUT=
DRDSH_SKIP_BUILD=no
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output|--target|--build-profile)
      if [ "$#" -lt 2 ]; then echo "relay/package.sh: $1 needs a value." >&2; exit 1; fi
      case "$1" in
        --output) DRDSH_OUTPUT=$2 ;;
        --target) DRDSH_TARGET=$2 ;;
        --build-profile) DRDSH_PROFILE=$2 ;;
      esac
      shift 2 ;;
    --skip-build) DRDSH_SKIP_BUILD=yes; shift ;;
    --help|-h)
      echo 'sh relay/package.sh --output /path/relay.tar.gz [--target TRIPLE] [--build-profile release|debug] [--skip-build]'
      echo 'Build dependencies: Rust/Cargo, Node.js and pnpm. Servers only need the archive and their system service manager.'
      exit 0 ;;
    *) echo "relay/package.sh: unknown option $1; use --help." >&2; exit 1 ;;
  esac
done
case "$DRDSH_PROFILE" in release|debug) ;; *) echo 'relay/package.sh: profile must be release or debug.' >&2; exit 1 ;; esac
if [ -z "$DRDSH_OUTPUT" ]; then echo 'relay/package.sh: choose --output /path/relay.tar.gz.' >&2; exit 1; fi
case "$DRDSH_OUTPUT" in /*) ;; *) DRDSH_OUTPUT=$PWD/$DRDSH_OUTPUT ;; esac
if [ -e "$DRDSH_OUTPUT" ]; then echo "relay/package.sh: output already exists: $DRDSH_OUTPUT; choose another filename." >&2; exit 1; fi
DRDSH_BIN=$DRDSH_SOURCE/target
if [ -n "$DRDSH_TARGET" ]; then DRDSH_BIN=$DRDSH_BIN/$DRDSH_TARGET; fi
DRDSH_BIN=$DRDSH_BIN/$DRDSH_PROFILE
if [ "$DRDSH_SKIP_BUILD" = no ]; then
  (cd "$DRDSH_SOURCE" && pnpm install --frozen-lockfile --filter '@dr.dsh/pwa...' && pnpm --filter @dr.dsh/pwa build)
  set -- build --locked --manifest-path "$DRDSH_SOURCE/Cargo.toml" --target-dir "$DRDSH_SOURCE/target" -p dr-dsh-relay -p dr-dsh-relayctl
  if [ "$DRDSH_PROFILE" = release ]; then set -- "$@" --release; fi
  if [ -n "$DRDSH_TARGET" ]; then set -- "$@" --target "$DRDSH_TARGET"; fi
  cargo "$@"
fi
for DRDSH_BINARY in drdsh-relay drdsh-relayctl; do
  if [ ! -x "$DRDSH_BIN/$DRDSH_BINARY" ]; then echo "relay/package.sh: missing $DRDSH_BIN/$DRDSH_BINARY; build the selected target first." >&2; exit 1; fi
done
for DRDSH_ASSET in index.html shell.js session.js service-worker.js manifest.webmanifest icon-192.png icon-512.png; do
  if [ ! -s "$DRDSH_SOURCE/apps/pwa/dist/$DRDSH_ASSET" ]; then echo "relay/package.sh: missing PWA $DRDSH_ASSET; build the PWA first." >&2; exit 1; fi
done
DRDSH_STAGE=$(mktemp -d "${TMPDIR:-/tmp}/drdsh-relay-package.XXXXXX")
trap 'rm -rf "$DRDSH_STAGE"' EXIT
trap 'exit 1' HUP INT TERM
mkdir "$DRDSH_STAGE/bin"
cp "$DRDSH_BIN/drdsh-relay" "$DRDSH_BIN/drdsh-relayctl" "$DRDSH_STAGE/bin/"
cp -R "$DRDSH_SOURCE/apps/pwa/dist" "$DRDSH_STAGE/client"
cp "$DRDSH_SOURCE/relay/install-source.sh" "$DRDSH_STAGE/install.sh"
cp "$DRDSH_SOURCE/relay/nginx.conf.example" "$DRDSH_SOURCE/relay/INSTALL.md" "$DRDSH_STAGE/"
chmod 755 "$DRDSH_STAGE/install.sh" "$DRDSH_STAGE/bin/"*
find "$DRDSH_STAGE/client" -type d -exec chmod 755 {} +
find "$DRDSH_STAGE/client" -type f -exec chmod 644 {} +
COPYFILE_DISABLE=1 tar -C "$DRDSH_STAGE" -czf "$DRDSH_STAGE/relay.tar.gz" bin client install.sh nginx.conf.example INSTALL.md
mv "$DRDSH_STAGE/relay.tar.gz" "$DRDSH_OUTPUT"
echo "Relay bundle: $DRDSH_OUTPUT"
echo 'Copy to a server with a matching OS/CPU, extract it, then run sh install.sh --start.'
