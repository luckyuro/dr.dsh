/**
 * The room key, end to end, with nobody typing it (ADR-0013).
 *
 * The failure this exists to prevent is quiet: `drdshd run` and `drdshd pair` used to each need
 * `--room-key`, and giving them different ones produced a device that could never connect — the symptom
 * is `no daemon is serving this room`, which names neither the key nor the command that got it wrong.
 * So the check is not "a file appears"; it is that **a device paired by a command that never saw a key
 * can reach a daemon started by a command that never saw one either**.
 *
 * What it runs, all real: a relay, `drdshd pair` with no `--room-key`, `drdshd pair-as-device` with the
 * printed code, `drdshd run` with no `--room-key`, and then the PWA's own tunnel client fetching the DSH
 * interface through the tunnel — with the room key read from the file, because that is the whole claim.
 *
 * Usage:
 *   node scripts/room-key-smoke.mjs [--drdshd target/debug/drdshd] [--drdsh-relay target/debug/drdsh-relay]
 *                                   [--state-dir target/room-key-smoke-state]
 *
 * Exit codes: 0 every check passed, 1 a check failed, 2 the run could not start.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

import { pairWithCode } from '../apps/pwa/src/pair.ts';
import { encodeRequest, request } from '../apps/pwa/src/proxy.ts';
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
const stateDir = option('--state-dir', 'target/room-key-smoke-state');
const keyPath = join(stateDir, 'room-key');

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

/** Starts a process and keeps its output. */
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

const roomEnv = () => ({
  DSHD_STATE_DIR: stateDir,
  PATH: `${process.cwd()}/target/test-bin:${process.env.PATH ?? ''}`,
});

// A fresh state directory: the checks below are about the first run and the second, and a key left
// behind by an earlier run would make "generated" unmeasurable.
rmSync(stateDir, { recursive: true, force: true });

const relayPort = await freePort();
const relay = start(drdshRelay, [], {
  DSH_RELAY_BIND: `127.0.0.1:${relayPort}`,
  RUST_LOG: 'warn',
});
if (!(await waitFor(relay.log, /listening on/, 15_000))) {
  console.error(`the relay never started: ${relay.log.text}`);
  process.exit(2);
}
const relayUrl = `ws://127.0.0.1:${relayPort}`;

function stopEverything() {
  for (const process_ of running) killTree(process_.child);
  killTree(relay.child);
}
const running = [];
process.on('exit', stopEverything);

// ---------------------------------------------------------------------------------------------
// 1. `pair` with no --room-key: it generates one, stores it, and never prints it.
// ---------------------------------------------------------------------------------------------

const pairing = start(drdshd, ['pair', '--relay', relayUrl, '--wait', '120'], roomEnv());
running.push(pairing);
if (!(await waitFor(pairing.log, /code:/, 20_000))) {
  console.error(`pairing never printed a code: ${pairing.log.text}`);
  stopEverything();
  process.exit(2);
}
const code = /code:\s+(\S+)/.exec(pairing.log.text)?.[1] ?? '';
check(
  'pairing generates a key instead of demanding one',
  pairing.log.text.includes('room key: generated and stored at'),
  pairing.log.text.split('\n').find(line => line.includes('room key:'))?.trim() ?? '(nothing said)',
);
check(
  'the key file exists and only its owner can read it',
  existsSync(keyPath) && (process.platform === 'win32' || (statSync(keyPath).mode & 0o777) === 0o600),
  existsSync(keyPath) ? `mode ${(statSync(keyPath).mode & 0o777).toString(8)}` : '(no file)',
);
const storedKey = readFileSync(keyPath, 'utf8').trim();
check(
  'and the key itself was never printed',
  storedKey.length === 43 && !pairing.log.text.includes(storedKey),
  `${storedKey.length} characters in the file, absent from the output`,
);

// ---------------------------------------------------------------------------------------------
// 2. The client pairs with the printed code, and is never told a key by the operator either.
// ---------------------------------------------------------------------------------------------

/** Opens the carrier socket a pairing exchange needs, the way the PWA does. */
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
    for (const listener of [...closeListeners]) {
      listener(`the relay closed the connection (${event.code})`);
    }
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
  };
}

let paired = null;
try {
  paired = await pairWithCode({ connect, report: () => {} }, { code, deviceName: 'room-key-smoke' });
} catch (error) {
  check('the client pairs with the printed code', false, String(error));
}
check(
  'the client pairs with the printed code and derives a device identity',
  paired !== null && paired.deviceId.length === 22 && paired.roomKey.length === 32,
  paired === null ? '(no device)' : `device ${paired.deviceId}`,
);
// The crux of ADR-0013: the key the device was handed is the key in the file the daemon will read
// later. Nobody typed it, and nothing printed it.
check(
  'and the key it was handed is the stored one, so `run` and `pair` cannot disagree',
  paired !== null && Buffer.from(paired.roomKey).toString('base64url') === storedKey,
  paired === null
    ? '(no device)'
    : `device key ${Buffer.from(paired.roomKey).toString('base64url').slice(0, 8)}… vs stored ${storedKey.slice(0, 8)}…`,
);

// ---------------------------------------------------------------------------------------------
// 3. `run` with no --room-key reads the same file — and the device can actually reach it.
// ---------------------------------------------------------------------------------------------

const dshPort = await freePort();
const daemon = start(drdshd, ['run', '--relay', relayUrl, '--port', String(dshPort)], roomEnv());
running.push(daemon);
const parked = await waitFor(daemon.log, /relay: Connected/, 40_000);
check(
  'the daemon starts without a key on the command line and uses the stored one',
  parked && daemon.log.text.includes(`room key: ${keyPath}`),
  daemon.log.text.split('\n').find(line => line.includes('room key:'))?.trim() ?? '(nothing said)',
);
// The client half is the PWA's own tunnel, carrying the device identity pairing produced: if `run` and
// `pair` had disagreed about the key, or the enrolled device were not accepted, this is where it shows.
const root = new Uint8Array(Buffer.from(storedKey, 'base64url'));
const room = await Tunnel.roomFor(root);
const roomInDaemon = /room: (\S+)/.exec(daemon.log.text)?.[1] ?? '';
check(
  'and the room it serves is the one the stored key derives',
  roomInDaemon !== '' && roomInDaemon === room,
  `${roomInDaemon} (daemon) vs ${room} (derived from the file)`,
);

let interfaceBytes = 0;
let status = 0;
let sawBoot = false;
if (paired !== null) {
  try {
    const socket = await connect(room);
    const tunnel = await Tunnel.open(socket, root, {
      deviceId: paired.deviceId,
      room: paired.room,
      key: paired.device.keyPair,
    });
    const response = await request(tunnel, 1, encodeRequest(1, 'GET', '/'));
    status = response.head.status;
    interfaceBytes = response.body.length;
    sawBoot = new TextDecoder().decode(response.body).includes('__DSH_BOOT__');
    tunnel.close();
  } catch (error) {
    check('a client using the stored key reaches the DSH interface', false, String(error));
  }
}
check(
  'a client using the stored key reaches the DSH interface, as the device pairing enrolled',
  status === 200 && interfaceBytes > 1000,
  `status ${status}, ${interfaceBytes} bytes${sawBoot ? ', DSH boot global present' : ''}`,
);

killTree(daemon.child);

// ---------------------------------------------------------------------------------------------
// 4. A different key on the command line is used, and the disagreement is said out loud.
// ---------------------------------------------------------------------------------------------

const otherKey = Buffer.from(new Uint8Array(32).fill(5)).toString('base64url');
// Detached, and its group killed afterwards: a daemon started this way supervises a real DSH, and
// `spawnSync`'s timeout kills only the daemon — the DSH would keep the port it bound and the next run
// would fail with "port is already in use". Two runs of this script were spent learning that.
const conflicting = spawnSync(
  drdshd,
  ['run', '--relay', relayUrl, '--room-key', otherKey, '--port', String(await freePort())],
  { env: { ...process.env, ...roomEnv() }, encoding: 'utf8', timeout: 15_000, detached: true },
);
if (typeof conflicting.pid === 'number') {
  try {
    process.kill(-conflicting.pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}
const conflictingOutput = `${conflicting.stdout ?? ''}${conflicting.stderr ?? ''}`;
check(
  'a command-line key that disagrees with the file is used and reported, not silently preferred',
  conflictingOutput.includes('different, and was not changed'),
  conflictingOutput.split('\n').find(line => line.includes('NOTE'))?.trim() ?? '(no notice)',
);
check(
  'and the stored key is left alone',
  readFileSync(keyPath, 'utf8').trim() === storedKey,
  'the file still holds the key the device was paired with',
);

// ---------------------------------------------------------------------------------------------
// 5. A damaged key file stops the daemon instead of quietly invalidating every device.
// ---------------------------------------------------------------------------------------------

const damaged = join('target', `room-key-smoke-damaged-${process.pid}`);
rmSync(damaged, { recursive: true, force: true });
const { mkdirSync, writeFileSync } = await import('node:fs');
mkdirSync(damaged, { recursive: true });
// A key that is valid base64url but the wrong length, which is what a truncated copy or a
// half-written file actually looks like — the message has to carry the length, not just "invalid".
writeFileSync(join(damaged, 'room-key'), 'AAAA\n');
const broken = spawnSync(drdshd, ['run', '--relay', relayUrl, '--port', String(await freePort())], {
  env: { ...process.env, DSHD_STATE_DIR: damaged, PATH: `${process.cwd()}/target/test-bin:${process.env.PATH ?? ''}` },
  encoding: 'utf8',
  timeout: 20_000,
});
const brokenOutput = `${broken.stdout ?? ''}${broken.stderr ?? ''}`;
check(
  'a damaged key file fails loudly, with the reason and the cost of replacing it',
  broken.status !== 0 &&
    brokenOutput.includes('is not a room key') &&
    brokenOutput.includes('32 bytes') &&
    brokenOutput.includes('must be paired again'),
  brokenOutput.trim().split('\n').at(-1) ?? '(no output)',
);
check(
  'and the damaged file was not replaced',
  readFileSync(join(damaged, 'room-key'), 'utf8').trim() === 'AAAA',
  'the file is untouched',
);
rmSync(damaged, { recursive: true, force: true });

console.log(`\n${results.length - failures}/${results.length} checks passed`);
stopEverything();
rmSync(stateDir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
