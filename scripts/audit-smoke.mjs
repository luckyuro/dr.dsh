/**
 * The audit log, end to end (ADR-0012).
 *
 * The claims are about what somebody can find out afterwards, so nothing here can be checked by reading
 * code: a device pairs, a session is established and released, a lifecycle command runs, a device is
 * revoked — and each of those has to leave exactly one line in `$DSHD_STATE_DIR/audit.jsonl`, readable
 * with `drdshd audit`, with the device it belongs to and no key material anywhere in the file.
 *
 * It also checks the two states that must never be confused: `DSHD_AUDIT=0` (nothing is being recorded)
 * and an empty log (nothing happened).
 *
 * Usage:
 *   node scripts/audit-smoke.mjs [--drdshd target/debug/drdshd] [--drdsh-relay target/debug/drdsh-relay]
 *                                [--state-dir target/audit-smoke-state]
 *
 * Exit codes: 0 every check passed, 1 a check failed, 2 the run could not start.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

import { ControlClient } from '../apps/pwa/src/control.ts';
import { pairWithCode } from '../apps/pwa/src/pair.ts';
import { Tunnel } from '../apps/pwa/src/tunnel.ts';

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (value === undefined) {
    console.error(`${name} needs a value`);
    process.exit(2);
  }
  return value;
}
const drdshd = option('--drdshd', 'target/debug/drdshd');
const drdshRelay = option('--drdsh-relay', 'target/debug/drdsh-relay');
const stateDir = option('--state-dir', 'target/audit-smoke-state');
const auditPath = join(stateDir, 'audit.jsonl');

if (!existsSync(drdshd) || !existsSync(drdshRelay)) {
  console.error(`need ${drdshd} and ${drdshRelay}; run \`cargo build --workspace\` first`);
  process.exit(2);
}

const results = [];
let failures = 0;
function check(what, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail === undefined ? '' : ` — ${detail}`}`);
  results.push({ what, ok });
  if (!ok) failures += 1;
}

async function freePort() {
  return await new Promise(resolve => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(log, pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !pattern.test(log.text)) await sleep(200);
  return pattern.test(log.text);
}

/**
 * Kills a process **and its children**.
 *
 * Every daemon in these scripts supervises a real DSH, and killing only the daemon leaves that DSH
 * running: it keeps the port it bound, so the next run's daemon refuses to start and the smoke fails
 * with "port is already in use" — which looks like a product defect and is not one. The daemon is
 * spawned detached (its own process group) so the whole tree can be signalled at once.
 */
function killTree(child) {
  if (child === null || child === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Already gone, or never got its own group (a spawn that failed): fall back to the process itself.
    try {
      killTree(child);
    } catch {
      // Nothing left to kill.
    }
  }
}

function start(command, argv, env) {
  const child = spawn(command, argv, { env: { ...process.env, ...env }, detached: true });
  const log = { text: '' };
  const absorb = chunk => {
    log.text += String(chunk);
  };
  child.stdout.on('data', absorb);
  child.stderr.on('data', absorb);
  return { child, log };
}

/** Runs `drdshd <argv>` to completion with this run's state directory. */
function drdshdRun(argv, extraEnv = {}, timeoutMs = 60_000) {
  const result = spawnSync(drdshd, argv, {
    env: {
      ...process.env,
      DSHD_STATE_DIR: stateDir,
      PATH: `${process.cwd()}/target/test-bin:${process.env.PATH ?? ''}`,
      ...extraEnv,
    },
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

/** The audit lines on disk, newest last. */
function auditLines() {
  try {
    return readFileSync(auditPath, 'utf8')
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return { unreadable: line };
        }
      });
  } catch {
    return [];
  }
}

/** Waits until an entry for `event` shows up, so the test is not racing the daemon's write. */
async function waitForEvent(event, device, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = auditLines().find(
      entry => entry.event === event && (device === undefined || entry.device === device),
    );
    if (found !== undefined) return found;
    await sleep(200);
  }
  return null;
}

rmSync(stateDir, { recursive: true, force: true });

const relayPort = await freePort();
const relay = start(drdshRelay, [], { DSH_RELAY_BIND: `127.0.0.1:${relayPort}`, RUST_LOG: 'warn' });
if (!(await waitFor(relay.log, /listening on/, 15_000))) {
  console.error(`the relay never started: ${relay.log.text}`);
  process.exit(2);
}
const relayUrl = `ws://127.0.0.1:${relayPort}`;

const running = [];
function stopEverything() {
  for (const process_ of running) killTree(process_.child);
  killTree(relay.child);
}
process.on('exit', stopEverything);

/** Opens the carrier socket a client needs. */
async function connect(room) {
  const socket = new WebSocket(`${relayUrl}/ws/client`);
  socket.binaryType = 'arraybuffer';
  const listeners = [];
  const closeListeners = [];
  socket.onmessage = event => {
    if (typeof event.data === 'string') return;
    const bytes = new Uint8Array(event.data);
    for (const listener of [...listeners]) listener(bytes);
  };
  socket.onclose = event => {
    for (const listener of [...closeListeners]) listener(`the relay closed the connection (${event.code})`);
  };
  await new Promise((resolve, reject) => {
    socket.onerror = () => reject(new Error('cannot reach the relay'));
    socket.onopen = () => {
      socket.send(JSON.stringify({ role: 'client', room, proto: [0, 1] }));
      resolve();
    };
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the relay never answered for room ${room}`)), 10_000);
    socket.addEventListener(
      'message',
      event => {
        if (typeof event.data !== 'string') return;
        clearTimeout(timer);
        if (event.data.includes('ready')) resolve();
        else reject(new Error(event.data));
      },
      { once: true },
    );
  });
  return {
    send: data => socket.send(data),
    receive: handler => listeners.push(handler),
    closed: handler => closeListeners.push(handler),
    close: () => socket.close(),
    socket,
  };
}

// ---------------------------------------------------------------------------------------------
// 1. Pairing: the daemon's own audit trail starts before anything else works.
// ---------------------------------------------------------------------------------------------

const pairing = start(drdshd, ['pair', '--relay', relayUrl, '--wait', '120'], {
  DSHD_STATE_DIR: stateDir,
  PATH: `${process.cwd()}/target/test-bin:${process.env.PATH ?? ''}`,
});
running.push(pairing);
if (!(await waitFor(pairing.log, /code:/, 20_000))) {
  console.error(`pairing never printed a code: ${pairing.log.text}`);
  stopEverything();
  process.exit(2);
}
const code = /code:\s+(\S+)/.exec(pairing.log.text)?.[1] ?? '';
const roomKey = readFileSync(join(stateDir, 'room-key'), 'utf8').trim();
const root = new Uint8Array(Buffer.from(roomKey, 'base64url'));

let paired = null;
try {
  paired = await pairWithCode({ connect, report: () => {} }, { code, deviceName: 'audit-smoke' });
} catch (error) {
  check('the client pairs', false, String(error));
}
// The daemon side finishes its own half — registry, receipt, audit line — *after* the client's half
// returns, so killing it here would race the very write this smoke is about: the first version killed
// it immediately and `pairing_accepted` was missing while every later event was present.
//
// What is waited for is the audit line itself, not the `paired …` announcement: the announcement is
// written after the audit call, but a wait that depends on the order of two writes inside another
// process is a race with a comment. This waits for the fact, then kills.
const enrolled = await waitForEvent('pairing_accepted', paired?.deviceId, 20_000);
if (enrolled === null) {
  console.log(`      pairing log tail: ${pairing.log.text.trim().split('\n').slice(-4).join(' | ')}`);
}
killTree(pairing.child);

const accepted = await waitForEvent('pairing_accepted', paired?.deviceId);
check(
  'a pairing leaves one line naming the device',
  accepted !== null && accepted.outcome === 'ok' && accepted.reason === 'audit-smoke',
  accepted === null ? '(no pairing_accepted entry)' : JSON.stringify(accepted).slice(0, 140),
);
check(
  'the audit log is private to its owner',
  existsSync(auditPath) && (process.platform === 'win32' || (statSync(auditPath).mode & 0o777) === 0o600),
  existsSync(auditPath) ? `mode ${(statSync(auditPath).mode & 0o777).toString(8)}` : '(no file)',
);

// ---------------------------------------------------------------------------------------------
// 2. A session: established with the device id, released when the client goes away.
// ---------------------------------------------------------------------------------------------

const dshPort = await freePort();
const daemon = start(drdshd, ['run', '--relay', relayUrl, '--port', String(dshPort)], {
  DSHD_STATE_DIR: stateDir,
  PATH: `${process.cwd()}/target/test-bin:${process.env.PATH ?? ''}`,
});
running.push(daemon);
if (!(await waitFor(daemon.log, /relay: Connected/, 40_000))) {
  console.error(`the daemon never parked: ${daemon.log.text}`);
  stopEverything();
  process.exit(2);
}

const room = await Tunnel.roomFor(root);
const socket = await connect(room);
const tunnel = await Tunnel.open(socket, root, {
  deviceId: paired?.deviceId ?? '',
  room: paired?.room ?? '',
  key: paired?.device.keyPair,
});
const established = await waitForEvent('tunnel_established', paired?.deviceId);
check(
  'a session is recorded with the device that proved itself',
  established !== null && established.outcome === 'ok',
  established === null ? '(no tunnel_established entry)' : JSON.stringify(established).slice(0, 140),
);

const control = new ControlClient(tunnel);
const status = await control.status();
check(
  'the control plane works on that session',
  status.state === 'running' || status.state === 'starting',
  `state ${status.state}`,
);

// A lifecycle command: the audit line records what happened to the process, not what was asked.
const stopped = await control.command('stop');
const commandEntry = await waitForEvent('lifecycle_command');
check(
  'a lifecycle command is recorded with its outcome',
  commandEntry !== null &&
    commandEntry.reason !== null &&
    commandEntry.reason.includes('Stop') &&
    commandEntry.outcome === (stopped.ok ? 'ok' : 'failed'),
  commandEntry === null ? '(no lifecycle_command entry)' : JSON.stringify(commandEntry).slice(0, 160),
);
const started = await control.command('start');
check('and the daemon can be started again', started.ok, `state ${started.state}`);

// Closing the client ends the session; the release is recorded with the same device.
socket.close();
const released = await waitForEvent('tunnel_released', paired?.deviceId, 20_000);
check(
  'and the session ending is recorded too',
  released !== null && released.outcome === 'ok' && released.reason === 'the relay released the session',
  released === null ? '(no tunnel_released entry)' : JSON.stringify(released).slice(0, 160),
);
control.close();
killTree(daemon.child);

// ---------------------------------------------------------------------------------------------
// 3. Revocation, and the privacy property the whole shape exists for.
// ---------------------------------------------------------------------------------------------

const revoked = drdshdRun(['devices', '--revoke', paired?.deviceId ?? '']);
check(
  'revoking a device is recorded as an operator action',
  (await waitForEvent('device_revoked', paired?.deviceId)) !== null,
  revoked.output.trim().split('\n')[0] ?? '(no output)',
);
check(
  'the log contains no key material',
  !readFileSync(auditPath, 'utf8').includes(roomKey),
  `${auditLines().length} entries, none carrying the room key`,
);

// ---------------------------------------------------------------------------------------------
// 3.5 A refusal reaches the log too: a locked-out throttle refuses before minting a code.
// ---------------------------------------------------------------------------------------------

// The throttle is pre-seeded with a lockout in the future. Driving five real failed attempts instead
// would need a client that knocks on the *right* room with the *wrong* code, which the client half only
// supports through `--rendezvous`; the state file is the honest shortcut, and what is being checked here
// is that the refusal path writes its audit line.
const nowSeconds = Math.floor(Date.now() / 1000);
writeFileSync(
  join(stateDir, 'pairing-throttle.json'),
  JSON.stringify({ failures: 5, last_attempt: nowSeconds, locked_until: nowSeconds + 300 }, null, 2),
);
const refused = drdshdRun(['pair', '--relay', relayUrl, '--wait', '5'], {}, 20_000);
check(
  'a throttled pairing is refused before a code exists',
  refused.status !== 0 && !refused.output.includes('code:'),
  refused.output.trim().split('\n')[0] ?? '(no output)',
);
const refusedEntry = await waitForEvent('pairing_refused');
check(
  'and the refusal is in the log with its reason',
  refusedEntry !== null && refusedEntry.outcome === 'refused' && refusedEntry.reason !== null,
  refusedEntry === null ? '(no pairing_refused entry)' : JSON.stringify(refusedEntry).slice(0, 160),
);
// Put the throttle back so the reader checks below see the same log the daemon wrote.
rmSync(join(stateDir, 'pairing-throttle.json'), { force: true });

// ---------------------------------------------------------------------------------------------
// 4. `drdshd audit`: the reader, the off switch, and the difference between the two.
// ---------------------------------------------------------------------------------------------

const listed = drdshdRun(['audit']);
check(
  '`drdshd audit` prints the events with their device and outcome',
  listed.status === 0 &&
    listed.output.includes('pairing_accepted') &&
    listed.output.includes('tunnel_established') &&
    listed.output.includes('lifecycle_command') &&
    listed.output.includes('device_revoked') &&
    listed.output.includes('pairing_refused') &&
    listed.output.includes(paired?.deviceId ?? '(no device)'),
  listed.output.split('\n')[0]?.trim() ?? '(no output)',
);
check(
  'and says nothing was ever sent anywhere',
  listed.output.includes('Nothing here was ever sent anywhere'),
  undefined,
);

const off = drdshdRun(['audit'], { DSHD_AUDIT: '0' });
check(
  'with auditing off it says so instead of showing "no events"',
  off.status === 0 && off.output.includes('auditing is OFF') && !off.output.includes('pairing_accepted'),
  off.output.split('\n')[0]?.trim() ?? '(no output)',
);

const cleared = drdshdRun(['audit', '--clear']);
const afterClear = drdshdRun(['audit']);
check(
  'clearing removes the log and leaves a working reader',
  cleared.status === 0 && afterClear.output.includes('no audit events') && auditLines().length === 0,
  cleared.output.trim(),
);

// A daemon with auditing off records nothing at all — the log stays absent.
const offDir = join('target', `audit-smoke-off-${process.pid}`);
rmSync(offDir, { recursive: true, force: true });
const offDaemon = start(drdshd, ['run', '--relay', relayUrl, '--port', String(await freePort())], {
  DSHD_STATE_DIR: offDir,
  DSHD_AUDIT: '0',
  PATH: `${process.cwd()}/target/test-bin:${process.env.PATH ?? ''}`,
});
running.push(offDaemon);
await sleep(3000);
killTree(offDaemon.child);
check(
  'a daemon started with DSHD_AUDIT=0 writes no log at all',
  !existsSync(join(offDir, 'audit.jsonl')),
  existsSync(join(offDir, 'audit.jsonl')) ? 'a file appeared' : 'no file, as asked',
);
rmSync(offDir, { recursive: true, force: true });

console.log(`\n${results.length - failures}/${results.length} checks passed`);
stopEverything();
rmSync(stateDir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
