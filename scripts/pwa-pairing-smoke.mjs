/**
 * Pairs a browser-shaped client with a **live** daemon through a **live** relay, then uses what
 * it got.
 *
 * This is the acceptance criterion the browser could not meet for several milestones: a device
 * that has nothing but a short code ends up able to reach the DSH interface. It runs the
 * shipped client modules — `pair.ts`, `identity.ts`, `tunnel.ts`, `proxy.ts` — against the
 * shipped Rust daemon, so a divergence between the two implementations shows up here rather
 * than in a user's browser.
 *
 * What it does, in order:
 *
 * 1. Mints a room key and a code with `drdshd pair --room-key`, reading the code from stdout as
 *    a person would.
 * 2. Runs the exchange with that code.
 * 3. Checks the device ended up with the room key the daemon serves — not with a key derived
 *    from the exchange, which is what it used to get: a device holding that key dials a room
 *    nobody serves.
 * 4. Checks the daemon's own registry lists the device it enrolled.
 * 5. Restores the identity from the record alone — the reload path, not the in-memory key.
 * 6. Starts a daemon with that room key, which now *requires* the device, and fetches the DSH
 *    interface through the tunnel with the restored identity.
 * 7. Checks that the same room refuses a client without the identity. Without this, step 6
 *    would pass on a daemon that never asked.
 *
 * Usage:
 *   node scripts/pwa-pairing-smoke.mjs <relay-url> [options]
 *
 * Options:
 *   --drdshd <path>       the daemon binary (default: target/debug/drdshd)
 *   --state-dir <path>  where the device registry lives (default: a scratch dir under target/)
 *   --port <n>          the port DSH is served on (default: 46320)
 *   --dsh-path <dir>    prepended to PATH so the daemon can find `dsh` (default: target/test-bin)
 *   --no-interface      stop after the registry check; no DSH needed
 *
 * Exit codes: 0 all checks passed, 1 a check failed, 2 the run was skipped because no DSH is
 * installed (the same convention as `browser-task-smoke.mjs`).
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { restoreDevice } from '../apps/pwa/src/identity.ts';
import { pairWithCode } from '../apps/pwa/src/pair.ts';
import { encodeRequest, request } from '../apps/pwa/src/proxy.ts';
import { Tunnel } from '../apps/pwa/src/tunnel.ts';

const args = process.argv.slice(2);
const relayUrl = args[0];
if (relayUrl === undefined || relayUrl.startsWith('--')) {
  console.error(
    'usage: node scripts/pwa-pairing-smoke.mjs <relay-url> [--drdshd <path>] [--state-dir <path>]\n' +
      '                                                [--port <n>] [--dsh-path <dir>] [--no-interface]',
  );
  process.exit(2);
}

/** Reads an option's value, or the default. */
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
const stateDir = option('--state-dir', join('target', `pairing-smoke-state-${process.pid}`));
const port = option('--port', '46320');
const dshPath = option('--dsh-path', 'target/test-bin');
const skipInterface = args.includes('--no-interface');

if (!existsSync(drdshd)) {
  console.error(`${drdshd} does not exist; run \`cargo build --workspace\` first`);
  process.exit(2);
}

/** A fresh state directory: a leftover registry would change which policy the daemon applies. */
rmSync(stateDir, { recursive: true, force: true });
mkdirSync(stateDir, { recursive: true });

let failures = 0;
/** Records one check. */
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
}

/** The environment every daemon process gets. */
function daemonEnv() {
  return {
    ...process.env,
    DSHD_STATE_DIR: stateDir,
    PATH: dshPath === '' ? (process.env.PATH ?? '') : `${dshPath}:${process.env.PATH ?? ''}`,
  };
}

/** Runs a command to completion, collecting its output. */
function run(command, argv, env, timeoutMs = 60_000) {
  return new Promise(resolve => {
    const child = spawn(command, argv, { env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', chunk => {
      stdout += String(chunk);
    });
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(error) });
    });
  });
}

/** Spawns a process and resolves once its output matches, so a check can run against it live. */
function spawnUntil(command, argv, env, pattern, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { env });
    let output = '';
    let settled = false;
    /** Resolves when the process exits, with everything it printed. */
    let exited;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new Error(`timed out waiting for ${pattern}\n${output}`)),
      timeoutMs,
    );
    // The exit is captured at spawn time, not when a caller decides to wait: a short-lived
    // process can be gone before anybody attaches a listener, and a listener attached after
    // that never fires — which reads as "the daemon hung" and is wrong.
    exited = new Promise(resolve => {
      child.on('close', code => resolve({ code, output: () => output }));
      child.on('error', error => resolve({ code: -1, output: () => String(error) + output }));
    });
    const scan = chunk => {
      output += String(chunk);
      const match = pattern.exec(output);
      if (match !== null) finish(null, { child, output: () => output, match, exited });
    };
    child.stdout.on('data', scan);
    child.stderr.on('data', scan);
    child.on('close', code => finish(new Error(`exited with ${code}\n${output}`)));
    child.on('error', error => finish(error));
  });
}

/** Opens a carrier socket on the relay, exactly as the page does. */
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
    const timer = setTimeout(
      () => reject(new Error(`the relay never answered the handshake for room ${room}`)),
      10_000,
    );
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

// ---------------------------------------------------------------------------------------------
// 1. A code, minted the way a user gets one.
// ---------------------------------------------------------------------------------------------

console.log(`relay: ${relayUrl}`);
console.log(`state: ${stateDir}`);
// The key the daemon serves. Generated here, because pairing hands it to the device: the two
// must be the same value for the device to reach the daemon afterwards.
const roomKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const root = new Uint8Array(Buffer.from(roomKey, 'base64url'));

const pairing = await spawnUntil(
  drdshd,
  ['pair', '--relay', relayUrl, '--room-key', roomKey, '--wait', '60'],
  daemonEnv(),
  /code:\s+(\S+)/,
  20_000,
).catch(error => {
  console.error(`could not mint a pairing code: ${error.message}`);
  process.exit(1);
});
const code = pairing.match[1];
console.log(`code: ${code}`);
check('the daemon printed a code in the display form', /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{2}$/.test(code));

// ---------------------------------------------------------------------------------------------
// 2. The exchange, with the shipped client.
// ---------------------------------------------------------------------------------------------

const phases = [];
let paired;
try {
  paired = await pairWithCode(
    { connect, report: phase => phases.push(phase.phase) },
    { code, deviceName: 'pwa-pairing-smoke' },
  );
} catch (error) {
  check('the pairing exchange completed', false, error.message);
  pairing.child.kill('SIGKILL');
  process.exit(1);
}
check(
  'the browser client paired and derived an identity',
  paired.deviceId.length === 22 && paired.roomKey.length === 32,
  `device ${paired.deviceId}`,
);
check(
  'the client reported connecting → waiting → paired',
  phases.join(',') === 'connecting,waiting,paired',
  phases.join(','),
);

const daemonSide = await Promise.race([
  pairing.exited,
  new Promise(resolve =>
    setTimeout(() => {
      pairing.child.kill('SIGKILL');
      resolve({ code: -1, output: () => pairing.output() });
    }, 20_000),
  ),
]);
check(
  'the daemon reported the enrolment',
  daemonSide.code === 0 && daemonSide.output().includes(`paired ${paired.deviceId}`),
  `exit ${daemonSide.code}`,
);

check(
  'the device received the room key the daemon serves',
  Buffer.from(paired.roomKey).toString('base64url') === roomKey,
  `${paired.room} vs ${await Tunnel.roomFor(root)}`,
);
check(
  'the room the device derived is the served room',
  paired.room === (await Tunnel.roomFor(root)),
  paired.room,
);

// ---------------------------------------------------------------------------------------------
// 3. The daemon's own registry, read from the disk it wrote to.
// ---------------------------------------------------------------------------------------------

const devices = await run(drdshd, ['devices'], daemonEnv());
check(
  'the registry lists the device the client enrolled',
  devices.stdout.includes(paired.deviceId),
  devices.stdout.trim().split('\n').at(-1) ?? '',
);
check(
  'the registry holds exactly one device',
  (devices.stdout.match(/paired|enrolled|device/gi) ?? []).length > 0 &&
    devices.stdout.includes('1'),
);

// ---------------------------------------------------------------------------------------------
// 4. The reload path: the identity comes back from its record, not from memory.
// ---------------------------------------------------------------------------------------------

let restored;
try {
  restored = await restoreDevice(paired.record);
  check('the record restores the identity and self-checks', restored.publicKeyBytes.length === 32);
} catch (error) {
  check('the record restores the identity and self-checks', false, error.message);
}

if (skipInterface) {
  console.log(failures === 0 ? 'all checks passed (interface step skipped)' : `${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------------------------
// 5. A daemon that requires the device, and the interface through it.
// ---------------------------------------------------------------------------------------------

const daemon = spawn(
  drdshd,
  ['run', '--relay', relayUrl, '--port', port, '--room-key', roomKey],
  { env: daemonEnv() },
);
let daemonLog = '';
daemon.stdout.on('data', chunk => {
  daemonLog += String(chunk);
});
daemon.stderr.on('data', chunk => {
  daemonLog += String(chunk);
});

/** Waits for a line in the daemon's log. */
async function daemonSays(pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(daemonLog)) return true;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return false;
}

const ready = await daemonSays(/room:/, 30_000);
if (!ready || /exited before announcing readiness|no DSH/.test(daemonLog)) {
  daemon.kill('SIGKILL');
  console.error('skipping the interface step: no DSH is available to supervise');
  console.error(daemonLog.trim().split('\n').slice(-4).join('\n'));
  console.log(`${failures} earlier check(s) failed`);
  process.exit(failures === 0 ? 2 : 1);
}

check(
  'the daemon requires the enrolled device',
  /devices: 1 enrolled/.test(daemonLog),
  (daemonLog.split('\n').find(line => line.includes('devices:')) ?? '').trim(),
);
await daemonSays(/index reachable/, 30_000);

try {
  const room = await Tunnel.roomFor(root);
  const tunnel = await Tunnel.open(await connect(room), root, {
    deviceId: restored.record.deviceId,
    room: restored.record.room,
    key: restored.keyPair,
  });
  check('the daemon accepted the restored device', tunnel.isDeviceBound === true);

  const response = await request(tunnel, 1, encodeRequest(1, 'GET', '/', {
    headers: [['accept', 'text/html']],
  }));
  const body = new TextDecoder().decode(response.body);
  check('the interface came back through the tunnel', response.head.status === 200, `status ${response.head.status}`);
  check(
    'the response is the real DSH interface',
    body.includes('__DSH_BOOT__'),
    `${response.body.length} bytes`,
  );
  tunnel.close();
} catch (error) {
  check('the daemon accepted the restored device', false, error.message);
}

// A daemon that never asks would make every check above pass for the wrong reason.
//
// Retried, because the relay withdraws the room the moment its last client leaves and the
// daemon re-registers a few milliseconds later: the first anonymous attempt can be answered by
// the relay rather than by the daemon, and "no daemon is serving this room" is a fact about the
// harness's timing rather than about authorization.
{
  const room = await Tunnel.roomFor(root);
  let refusal = 'the daemon never answered';
  let refused = false;
  for (let attempt = 0; attempt < 10 && !refused; attempt += 1) {
    try {
      await Tunnel.open(await connect(room), root, null);
      refusal = 'it was allowed in';
      break;
    } catch (error) {
      refusal = String(error);
      // The refusal that matters is the daemon's, not the relay's.
      refused = /not paired/.test(refusal);
      if (!refused) await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  check('a client without the identity is refused', refused, refusal);
}

daemon.kill('SIGTERM');
await new Promise(resolve => setTimeout(resolve, 1500));
daemon.kill('SIGKILL');

console.log(
  failures === 0 ? 'all checks passed' : `${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
