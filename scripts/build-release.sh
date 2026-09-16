#!/bin/sh
# Run on the target build host. Rust toolchain and PWA build are explicit prerequisites.
set -eu
drdsh_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
drdsh_target=${1:?Usage: build-release.sh <Rust target> [output-directory]}
drdsh_out=${2:-$drdsh_root/target/release-assets}
case "$drdsh_target" in
  aarch64-apple-darwin) drdsh_flavors=daemon ;;
  x86_64-unknown-linux-musl) drdsh_flavors='mixed relay daemon' ;;
  *) echo 'Unsupported release target.' >&2; exit 1 ;;
esac
drdsh_build=$drdsh_root/target/release-multicall
cargo build --manifest-path "$drdsh_root/Cargo.toml" --target-dir "$drdsh_build" \
  --locked --release --target "$drdsh_target" -p dr-dsh-cli
for drdsh_flavor in $drdsh_flavors; do
  sh "$drdsh_root/scripts/package-release.sh" --target "$drdsh_target" --flavor "$drdsh_flavor" \
    --binary "$drdsh_build/$drdsh_target/release/drdsh" \
    --output "$drdsh_out/drdsh-$drdsh_flavor-$drdsh_target.tar.gz"
done
