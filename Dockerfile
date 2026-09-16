# dr.dsh relay, in three stages: build the client, build the relay, ship both on a slim base.
#
# The relay is the piece that has to be reachable from outside the user's machine, so it is the piece
# worth containerising: a daemon in a container cannot supervise DSH on the host without sharing the
# host's process and filesystem namespaces, and that is a decision with security consequences this
# project deliberately leaves to the operator (see docs/operations/install.md).
#
# Nothing here needs a C toolchain beyond what the Rust stage brings: the workspace's cryptography is
# pure Rust (ADR-0001), which is also what keeps this image buildable for people on machines without
# one — the same property M5's "old CPU" path depends on.

# ------------------------------------------------------------------------------------------------
# 1. The client bundle: the relay serves it, so it has to be in the image.
# ------------------------------------------------------------------------------------------------
FROM node:24.19.0-bookworm-slim AS client

# An explicit working directory in **every** stage: without one here the files landed in `/` and the
# runtime stage's `COPY --from=client /src/apps/pwa/dist` had nothing to copy — a failure that names the
# destination path and not the missing `WORKDIR`, which is why it is called out.
WORKDIR /src

# The version is pinned in package.json (`packageManager`), and corepack is how the base image is
# meant to honour it; a floating `pnpm` would make two builds of the same commit differ.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/pwa ./apps/pwa

RUN corepack enable \
 && corepack prepare "$(node -p "require('./package.json').packageManager")" --activate \
 && pnpm install --frozen-lockfile --filter '@dr.dsh/pwa...' \
 && pnpm --filter '@dr.dsh/pwa' build

# ------------------------------------------------------------------------------------------------
# 2. The relay binary. Only its own crate (and the protocol crate it depends on) is compiled: the
#    daemon and its DSH-facing dependencies are not in this image at all, which is the zero-knowledge
#    argument expressed as a build step (ADR-0002).
# ------------------------------------------------------------------------------------------------
FROM rust:1.97.1-bookworm AS relay

WORKDIR /src
# The lockfile is copied and honoured: a relay image should be reproducible from a commit, and
# `--locked` is what makes a dependency change show up as a failed build rather than as a different
# binary.
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY apps/pwa/static/index.html ./apps/pwa/static/index.html
RUN cargo build --release --locked -p dr-dsh-relay \
 && strip target/release/drdsh-relay

# ------------------------------------------------------------------------------------------------
# 3. Runtime: a slim base, a non-root user, no build tooling.
# ------------------------------------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime

# `curl` only for the healthcheck below. Without one, an orchestrator restarting the container has no
# way to tell "the relay is serving" from "the process is up but wedged".
RUN apt-get update \
 && apt-get install --no-install-recommends --yes curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin drdsh

# `--chmod` on both copies, because file modes travel with `COPY` and the runtime user is not the one
# that created the files. Without it a source file that happens to be mode 0600 — which is what an
# editor or a tool that writes private files by default produces — becomes a 404 in the container while
# the same file works on the host, where the relay runs as its owner. Found exactly that way: the
# manifest 404ed while its icons, created by a script with the usual umask, were fine.
COPY --from=relay --chmod=0755 /src/target/release/drdsh-relay /usr/local/bin/drdsh-relay
COPY --from=client --chmod=0644 /src/apps/pwa/dist /usr/share/dr.dsh/client

# The relay forwards ciphertext and keeps nothing: a writable filesystem is not needed, and a
# read-only root is the honest default for a process whose whole job is passing bytes on.
ENV DSH_RELAY_CLIENT_DIR=/usr/share/dr.dsh/client \
    DSH_RELAY_BIND=0.0.0.0:8787 \
    RUST_LOG=info

EXPOSE 8787
USER drdsh

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl --fail --silent --show-error http://127.0.0.1:8787/healthz || exit 1

ENTRYPOINT ["/usr/local/bin/drdsh-relay"]
