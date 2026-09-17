#!/bin/sh
# Assemble already-built artifacts, without executing a cross-compiled binary.
set -eu
umask 022
drdsh_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
drdsh_target=
drdsh_flavor=
drdsh_binary=
drdsh_output=
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || { echo 'Each packaging option needs a value.' >&2; exit 1; }
  case "$1" in
    --target) drdsh_target=$2 ;;
    --flavor) drdsh_flavor=$2 ;;
    --binary) drdsh_binary=$2 ;;
    --output) drdsh_output=$2 ;;
    *) echo "Unknown packaging option $1" >&2; exit 1 ;;
  esac
  shift 2
done
[ -n "$drdsh_output" ] && [ -n "$drdsh_target" ] && [ -x "$drdsh_binary" ] || {
  echo 'Usage: package-release.sh --target <Rust target> --flavor mixed|relay|daemon --binary <drdsh> --output <new.tar.gz>' >&2; exit 1;
}
case "$drdsh_target" in aarch64-apple-darwin|x86_64-unknown-linux-musl) ;; *) echo 'Unsupported release target.' >&2; exit 1 ;; esac
case "$drdsh_flavor" in
  mixed) drdsh_components='"relay", "daemon"' ;;
  relay) drdsh_components='"relay"' ;;
  daemon) drdsh_components='"daemon"' ;;
  *) echo 'Choose mixed, relay or daemon.' >&2; exit 1 ;;
esac
[ ! -e "$drdsh_output" ] || { echo 'Output exists; choose a new path.' >&2; exit 1; }
drdsh_version=$(sed -n 's/^version = "\([^"]*\)"/\1/p' "$drdsh_root/Cargo.toml")
[ -n "$drdsh_version" ] || { echo 'Missing workspace version.' >&2; exit 1; }
drdsh_stage=$(mktemp -d "${TMPDIR:-/tmp}/drdsh-package.XXXXXXXX")
trap 'rm -rf "$drdsh_stage"' EXIT HUP INT TERM
mkdir "$drdsh_stage/bundle" "$drdsh_stage/bundle/bin"
cp "$drdsh_binary" "$drdsh_stage/bundle/bin/drdsh"
chmod 755 "$drdsh_stage/bundle/bin/drdsh"
if [ "$drdsh_flavor" != daemon ]; then
  sh "$drdsh_root/scripts/check-pwa-build.sh"
  cp -R "$drdsh_root/apps/pwa/dist" "$drdsh_stage/bundle/client"
  cp "$drdsh_root/relay/nginx.conf.example" "$drdsh_stage/bundle/"
  ln -s drdsh "$drdsh_stage/bundle/bin/drdsh-relay"
fi
if [ "$drdsh_flavor" != relay ]; then
  mkdir "$drdsh_stage/bundle/plugin"
  for drdsh_file in src package.json cordis.patch.yml; do
    cp -R "$drdsh_root/plugins/dr.dsh/$drdsh_file" "$drdsh_stage/bundle/plugin/"
  done
  ln -s drdsh "$drdsh_stage/bundle/bin/drdsh-daemon"
fi
printf '{"format":1,"version":"%s","target":"%s","components":[%s]}\n' "$drdsh_version" "$drdsh_target" "$drdsh_components" > "$drdsh_stage/bundle/bundle.json"
{
  printf '#!/bin/sh\nset -eu\nDRDSH_BUNDLE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\n'
  if [ "$drdsh_flavor" = mixed ]; then
    printf 'exec "$DRDSH_BUNDLE/bin/drdsh" install --source "$DRDSH_BUNDLE" "$@"\n'
  else
    printf 'exec "$DRDSH_BUNDLE/bin/drdsh" %s install --source "$DRDSH_BUNDLE" "$@"\n' "$drdsh_flavor"
  fi
} > "$drdsh_stage/bundle/install.sh"
chmod 755 "$drdsh_stage/bundle/install.sh"
cp "$drdsh_root/docs/operations/releases.md" "$drdsh_stage/bundle/README.md"
COPYFILE_DISABLE=1 tar --exclude='*.test.ts' -czf "$drdsh_stage/package.tar.gz" -C "$drdsh_stage/bundle" .
mkdir -p "$(dirname -- "$drdsh_output")"
mv "$drdsh_stage/package.tar.gz" "$drdsh_output"
printf 'Packaged %s\n' "$drdsh_output"
