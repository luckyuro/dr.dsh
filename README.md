# dr.dsh

English | [中文](README.zh.md)

**dr.dsh puts your own DeepSeek Harness in your pocket — without exposing your computer to the internet, and without anyone in the middle being able to read your sessions.**

---

## Status: self-hostable, not released

| | |
| :--- | :--- |
| Version | `0.0.0` — nothing is released (no artifacts, no npm package) |
| What works today | One typed pairing code on a new device, and the **real DSH interface** is one click away: the daemon supervises the local DSH, keeps it bound to loopback, and carries an end-to-end encrypted tunnel through a **self-hosted relay** (binary or Docker image). Remote start/stop/restart, attach mode for a DSH you started yourself, keepalive, a local audit log (`drdshd audit`) and local crash reports (`drdshd crashes`) — the last two never leave your machine |
| What is not done | The release pipeline (reproducible builds, artifact digests — the first gap listed in [`docs/audit-scope.md`](docs/audit-scope.md)), the third-party audit, the new-user field test, and push (off by default per [ADR-0006](docs/decisions/0006-notifications.md) and not implemented). **Per-item status lives in [`docs/product/mvp.md`](docs/product/mvp.md)** |
| Upstream dependency | DeepSeek Harness `0.1.5-rc.2`, a developer preview that has announced compatibility-breaking changes |

The product definition this project is built against is the dr.dsh definition document, version 0.1 draft. Where it leaves a question open, this repository records the decision rather than the intention: see [`docs/product/mvp.md`](docs/product/mvp.md) and [`docs/decisions/`](docs/decisions/).

## The name

**dr.dsh** = **d**aemon & **r**elay **of** **dsh**. The name is also the prefix used everywhere, and changing it means changing all of these together:

| Where | Form | Why |
| :--- | :--- | :--- |
| Project and npm scope | `dr.dsh`, `@dr.dsh/*` | dotted; npm allows `.` in a package name |
| Rust crates | `dr-dsh-proto`, `dr-dsh-crypto`, `dr-dsh-daemon`, `dr-dsh-relay` | hyphenated; a crate name cannot contain `.` |
| Executables | `drdshd` (daemon), `drdsh-relay` (relay) | hyphenated: a binary's name is both a file name and a crate name, so it can contain neither `.` nor the name of its package's library |
| Wire labels | `dsh-remote/v1/...` | **deliberately unchanged** — see below |

**Why the labels stay.** The labels in `docs/protocol.md` § 9 are *wire* identifiers: both ends derive the room id, session keys, frame AAD and the enrolment MAC from them. Renaming them is a wire-breaking change that would need both implementations, both conformance corpora and a protocol version bump (`AGENTS.md` rule 3), with no functional gain. The protocol's label prefix records the name the project had when the protocol was frozen; that is allowed to differ from the project's name.

## What it does

You run DSH on your own computer. dr.dsh adds a small daemon next to it that lets you, from your phone or another machine:

- **use the real DSH interface**, not a reduced remote-control panel;
- **start, stop, and restart DSH**, and see whether it is running, starting, stopped, or broken;
- **get told when something needs you** — a turn finished, an approval is waiting, a goal completed;
- **see the truth when things fail** — which side is down, and why.

Nothing is port-forwarded, no public IP is needed, and no router configuration is involved: the daemon dials out, and the relay in the middle only ever holds ciphertext.

## How it works

```
┌──────────────┐          ┌─────────────────┐          ┌──────────────────┐
│  phone /     │  static  │                 │  opaque  │  your computer   │
│  laptop      │◀────────▶│   relay         │◀────────▶│                  │
│  (PWA)       │  shell   │  (zero-knowledge│  frames  │  drdshd  (daemon)  │
│              │ +cipher- │   forwarder)    │          │    │             │
│              │  text    │                 │          │    ▼             │
└──────────────┘          └─────────────────┘          │  dsh web         │
                                                       │  127.0.0.1 only  │
                                                       └──────────────────┘
```

Four components, and each one has a boundary it does not cross:

| Component | Language | What it is | What it cannot do |
| :--- | :--- | :--- | :--- |
| **`drdsh-relay`** | Rust | Routes opaque frames between a daemon and its paired clients | Read a payload, hold a key, persist anything |
| **`drdshd`** (daemon) | Rust | Supervises DSH, proxies it, terminates end-to-end encryption | Execute a peer-named command, bind DSH to a non-loopback address |
| **`@dr.dsh/dsh-plugin`** | TypeScript | Reports in-process harness events to the local daemon | Encrypt, proxy, or manage DSH lifecycle |
| **PWA** | TypeScript | The remote client: pairing, tunnel, and the real DSH UI | Reach DSH by any path other than the tunnel |

Three decisions explain most of the design:

1. **The relay cannot decrypt, because it cannot link a decryption library.** That is enforced by the dependency graph, not by policy — see [ADR-0002](docs/decisions/0002-zero-knowledge-relay.md).
2. **DSH is never exposed and never forked.** It stays bound to loopback, exactly as upstream intends; the daemon performs DSH's own authentication and proxies it, preserving the authority that DSH's session cookie is bound to — see [ADR-0003](docs/decisions/0003-no-fork-integration.md).
3. **The protocol exists twice and is compared mechanically.** Rust owns the definition, TypeScript mirrors it, and both must pass the same conformance corpus — see [ADR-0004](docs/decisions/0004-wire-protocol.md).

## Quick start

On the machine that runs DSH (the relay can be the same machine or another one):

```sh
cargo build --workspace
pnpm install && pnpm --filter @dr.dsh/pwa build

# The relay: loopback, serving the built client to the browser. See the self-hosting doc for TLS.
DSH_RELAY_BIND=127.0.0.1:8787 DSH_RELAY_CLIENT_DIR=apps/pwa/dist ./target/debug/drdsh-relay

drdshd doctor                                          # check this machine before anything else
drdshd run --relay ws://<host>:8787                    # supervise DSH, dial the relay (a room key is generated and stored 0600)
drdshd pair --relay ws://<host>:8787                   # print a single-use pairing code
```

Then open the relay's address in a browser, type that code once, and the DSH interface is one click
away. You never handle the room key: `drdshd run` and `drdshd pair` read the same generated file.
The relay also runs from [`compose.yaml`](compose.yaml); the full systemd / launchd / Task Scheduler
and Docker versions are in [`docs/operations/install.md`](docs/operations/install.md) and
[`docs/operations/self-hosting.md`](docs/operations/self-hosting.md).

Every change is expected to keep this green:

```sh
pnpm run verify                  # cargo check/clippy/test + tsc + node --test + import isolation + doc links
pnpm run fmt:rs
```

Claims about *behaviour* (the tunnel, pairing, keepalive, crash reporting, several rooms, old CPUs)
are measured by the scripts in [`scripts/`](scripts/) — the list is in [`AGENTS.md`](AGENTS.md).

## Repository layout

```
crates/
  dr-dsh-proto/        wire protocol: framing, multiplexing, control messages (normative)
  dr-dsh-crypto/       pairing and session crypto (Rust side)
  dr-dsh-daemon/       drdshd — supervision, proxying, encryption endpoint
  dr-dsh-relay/        drdsh-relay — the zero-knowledge forwarder
packages/
  protocol/        TypeScript mirror + the shared conformance corpus
  crypto/          browser-side WebCrypto implementation
plugins/
  dr.dsh/          the DSH bundle plugin, and the only DSH-aware TypeScript
apps/
  pwa/             the remote client
docs/
  product/         scope, MVP, milestones
  architecture.md  components, data flow, session bootstrap
  security.md      threat model, guarantees, and what is not guaranteed
  protocol.md      the normative wire description
  decisions/       ADRs — why, and what was rejected
  operations/      self-hosting, troubleshooting
  development/     contributing, and the DSH upgrade ritual
  integration/     the exact DSH surface relied on, and how it is verified
```

## Principles

- **Local first.** dr.dsh is an amplifier for a local tool, never a replacement for it. Losing the relay must never cost you a local session.
- **Zero knowledge by construction.** The relay's inability to read your sessions is a property of what it is built from.
- **No fork, no patch, no plugin that weakens DSH.** We use the seams upstream documents, and we ask upstream for new ones instead of reaching around it.
- **Least privilege, closed whitelist.** Four lifecycle operations, no general command execution, no file transfer, no remote shell.
- **Failure transparency.** Every "it did not work" names which side failed and why. A silent spinner is a bug.
- **Security defaults, auditable configuration.** Nothing that weakens a guarantee is a default, and every such option is documented as what it costs.

## Contributing

Start with [`docs/development/contributing.md`](docs/development/contributing.md). It lists the verification commands, the layout, the five rules reviewers enforce, and why each exists. `pnpm run verify` must be green before a PR is reviewed.

If you are here to report a problem rather than fix one, [`docs/operations/troubleshooting.md`](docs/operations/troubleshooting.md) starts with what to collect so the report is answerable.

## Security

Read [`docs/security.md`](docs/security.md) before trusting this project with anything. It states what is guaranteed, what is not, and where the remaining risk sits — including the honest weaknesses, such as the relay's position in the client's trust base and the traffic-analysis metadata that a byte-forwarding relay inevitably observes.

## License

MIT.
