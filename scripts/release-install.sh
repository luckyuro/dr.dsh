#!/bin/sh
# Standalone Release installer. Keep generated public entrypoints in sync with release-entrypoints.sh.
set -eu
umask 077
drdsh_component=${DRDSH_COMPONENT:-auto}
drdsh_version=${DRDSH_VERSION:-latest}
drdsh_remaining=$#
while [ "$drdsh_remaining" -gt 0 ]; do
  drdsh_arg=$1
  shift
  drdsh_remaining=$((drdsh_remaining - 1))
  case "$drdsh_arg" in
    --component|--version)
      [ "$drdsh_remaining" -gt 0 ] || { echo "$drdsh_arg needs a value" >&2; exit 1; }
      if [ "$drdsh_arg" = --component ]; then drdsh_component=$1; else drdsh_version=$1; fi
      shift
      drdsh_remaining=$((drdsh_remaining - 1))
      ;;
    --source|--skip-build|--build-profile)
      echo 'Release installation does not build source. For a local bundle use its bin/drdsh <component> install --source <directory>; for development see docs/operations/releases.md.' >&2
      exit 1
      ;;
    --help|-h)
      cat <<'HELP'
Install dr.dsh from GitHub Releases (no Node, pnpm or Rust needed).

  sh install.sh [--component mixed|relay|daemon] [--version v0.1.0]
      [--prefix <path>] [--start] [--enable]
      [--bind <ip:port>] [--relay <ws-origin>] [--dsh <path>]
      [--workdir <path>] [--state-dir <path>] [--with-plugin]

Linux x86_64: mixed, relay or daemon (static musl).
macOS arm64: daemon. Default selects mixed on Linux and daemon on macOS.
Without --start/--enable, services remain stopped without login autostart.
Updates preserve saved settings, pairing keys and the other component's process.
DSH must already be installed for daemon; DSH itself requires Node.
HELP
      exit 0
      ;;
    *) set -- "$@" "$drdsh_arg" ;;
  esac
done
case "$(uname -s):$(uname -m)" in
  Linux:x86_64|Linux:amd64) drdsh_target=x86_64-unknown-linux-musl ;;
  Darwin:arm64|Darwin:aarch64) drdsh_target=aarch64-apple-darwin ;;
  *) echo 'No release for this OS/CPU. Supported: Linux x86_64 musl and macOS arm64 daemon; build from source for other targets.' >&2; exit 1 ;;
esac
if [ "$drdsh_component" = auto ]; then
  case "$drdsh_target" in *darwin) drdsh_component=daemon ;; *) drdsh_component=mixed ;; esac
fi
[ "$drdsh_component" != all ] || drdsh_component=mixed
case "$drdsh_component" in relay|daemon|mixed) ;; *) echo 'Choose --component mixed, relay or daemon.' >&2; exit 1 ;; esac
if [ "$drdsh_target" = aarch64-apple-darwin ] && [ "$drdsh_component" != daemon ]; then
  echo 'This release provides macOS arm64 daemon only. Use --component daemon, or build relay/mixed from source.' >&2
  exit 1
fi
case "$drdsh_version" in *[!a-zA-Z0-9._-]*|'') echo 'Invalid release version; use a release tag such as v0.1.0.' >&2; exit 1 ;; esac
command -v curl >/dev/null 2>&1 || { echo 'Install curl to download the release.' >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then drdsh_hash=sha256sum
elif command -v shasum >/dev/null 2>&1; then drdsh_hash=shasum
else echo 'Install sha256sum or shasum to verify the download.' >&2; exit 1
fi
drdsh_base=${DRDSH_RELEASE_BASE_URL:-https://github.com/luckyuro/dr.dsh/releases}
drdsh_proto='=https'
case "$drdsh_base" in
  https://*) ;;
  http://127.0.0.1:*|http://localhost:*) drdsh_proto='=http,https' ;;
  *) echo 'Release base must use HTTPS (HTTP is allowed only for a loopback test mirror).' >&2; exit 1 ;;
esac
if [ "$drdsh_version" = latest ]; then drdsh_url=$drdsh_base/latest/download
else drdsh_url=$drdsh_base/download/$drdsh_version
fi
drdsh_asset=drdsh-$drdsh_component-$drdsh_target.tar.gz
drdsh_tmp=$(mktemp -d "${TMPDIR:-/tmp}/drdsh-release.XXXXXXXX")
trap 'rm -rf "$drdsh_tmp"' EXIT HUP INT TERM
for drdsh_file in "$drdsh_asset" SHA256SUMS; do
  curl --fail --location --retry 3 --connect-timeout 15 --max-time 300 \
    --proto "$drdsh_proto" --proto-redir "$drdsh_proto" \
    --output "$drdsh_tmp/$drdsh_file" "$drdsh_url/$drdsh_file"
done
drdsh_digest=$(awk -v name="$drdsh_asset" '$2 == name && NF == 2 { print $1 }' "$drdsh_tmp/SHA256SUMS")
[ "${#drdsh_digest}" -eq 64 ] || { echo 'Release checksum is missing or duplicated; installation stopped before changing services.' >&2; exit 1; }
case "$drdsh_digest" in *[!a-fA-F0-9]*) echo 'Invalid SHA-256 digest in Release metadata.' >&2; exit 1 ;; esac
(
  cd "$drdsh_tmp"
  if [ "$drdsh_hash" = sha256sum ]; then
    printf '%s  %s\n' "$drdsh_digest" "$drdsh_asset" | sha256sum -c -
  else
    printf '%s  %s\n' "$drdsh_digest" "$drdsh_asset" | shasum -a 256 -c -
  fi
)
mkdir "$drdsh_tmp/bundle"
tar -xzf "$drdsh_tmp/$drdsh_asset" -C "$drdsh_tmp/bundle"
if [ "$drdsh_component" = mixed ]; then
  "$drdsh_tmp/bundle/bin/drdsh" install --source "$drdsh_tmp/bundle" "$@"
else
  "$drdsh_tmp/bundle/bin/drdsh" "$drdsh_component" install --source "$drdsh_tmp/bundle" "$@"
fi
