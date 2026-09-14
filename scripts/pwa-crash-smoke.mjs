/**
 * The crash-report path, end to end: a real client, a real daemon, a real file.
 *
 * What M5 promises is "crash reporting usable" — and usable here means a failure in the client ends
 * up somewhere the person who owns the machine can read it. There is no service in that sentence: the
 * report goes one hop to the user's own daemon and is written beside its state, so this script checks
 * the whole path rather than a handshake: the daemon accepts it, the file exists with the mode the
 * daemon promises, `drdshd crashes` prints it, an oversized report is refused without being written,
 * and clearing makes room again.
 *
 * The report is built by the client's own `health.ts` — the same function the browser shell calls —
 * so a change in the report's shape breaks here rather than in the field.
 *
 * Usage:
 *   node scripts/pwa-crash-smoke.mjs [--drdshd target/debug/drdshd] [--drdsh-relay target/debug/drdsh-relay]
 *                                    [--state-dir target/crash-smoke-state]
 *
 * Exit codes: 0 every check passed, 1 a check failed, 2 the run could not start.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';

import { ControlClient } from '../apps/pwa/src/control.ts';
import { crashReport, emptyHealth, recordFailure } from '../apps/pwa/src/health.ts';
import { CONTROL_STREAM, Tunnel } from '../apps/pwa/src/tunnel.ts';

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
const stateDir = option('--state-dir', 'target/crash-smoke-state');
const reportsPath = `${stateDir}/crash-reports.jsonl`;

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

/** An OS-assigned port, released immediately. */
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

/** Waits until `pattern` shows up in a process's output. */
async function waitFor(log, pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !pattern.test(log.text)) await sleep(200);
  return pattern.test(log.text);
}

/** Runs a command to completion and returns its output and exit code. */
function runToCompletion(command, argv, env, timeoutMs) {
  return new Promise(resolve => {
    const child = spawn(command, argv, { env: { ...process.env, ...env } });
    let output = '';
    child.stdout.on('data', chunk => {
      output += String(chunk);
    });
    child.stderr.on('data', chunk => {
      output += String(chunk);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

// ---------------------------------------------------------------------------------------------
// A real relay and a real daemon, in a state directory this script owns.
// ---------------------------------------------------------------------------------------------

const relayPort = await freePort();
const relay = spawn(drdshRelay, [], {
  env: { ...process.env, DSH_RELAY_BIND: `127.0.0.1:${relayPort}`, RUST_LOG: 'warn' },
});
const relayLog = { text: '' };
const absorbRelay = chunk => {
  relayLog.text += String(chunk);
};
relay.stdout.on('data', absorbRelay);
relay.stderr.on('data', absorbRelay);
if (!(await waitFor(relayLog, /listening on/, 15_000))) {
  console.error(`the relay never started: ${relayLog.text}`);
  process.exit(2);
}

// A fresh state directory per run: the daemon's device policy depends on what is in it, and a report
// left by an earlier run would make "the first report is stored" unmeasurable.
const { rmSync } = await import('node:fs');
rmSync(stateDir, { recursive: true, force: true });

const roomKey = Buffer.from(
  await crypto.subtle.digest('SHA-256', new TextEncoder().encode('crash-smoke')),
).toString('base64url');
const daemon = spawn(
  drdshd,
  ['run', '--relay', `ws://127.0.0.1:${relayPort}`, '--room-key', roomKey, '--port', String(await freePort())],
  {
    env: {
      ...process.env,
      DSHD_STATE_DIR: stateDir,
      // The daemon supervises a real DSH; this is the wrapper the other smokes use.
      PATH: `${process.cwd()}/target/test-bin:${process.env.PATH ?? ''}`,
      RUST_LOG: 'info',
    },
  },
);
const daemonLog = { text: '' };
const absorbDaemon = chunk => {
  daemonLog.text += String(chunk);
};
daemon.stdout.on('data', absorbDaemon);
daemon.stderr.on('data', absorbDaemon);

function stopEverything() {
  daemon.kill('SIGKILL');
  relay.kill('SIGKILL');
}
process.on('exit', stopEverything);

if (!(await waitFor(daemonLog, /relay: Connected/, 30_000))) {
  console.error(`the daemon never parked its room: ${daemonLog.text}`);
  stopEverything();
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------
// The client: the PWA's own tunnel and control client, running in node.
// ---------------------------------------------------------------------------------------------

const root = new Uint8Array(Buffer.from(roomKey, 'base64url'));
const room = await Tunnel.roomFor(root);
const socket = new WebSocket(`ws://127.0.0.1:${relayPort}/ws/client`);
socket.binaryType = 'arraybuffer';
const listeners = [];
const closeListeners = [];
socket.onmessage = event => {
  if (typeof event.data === 'string') return;
  const bytes = new Uint8Array(event.data);
  for (const listener of [...listeners]) listener(bytes);
};
socket.onclose = () => {
  for (const listener of [...closeListeners]) listener('the relay closed the connection');
};

let opened = false;
try {
  await new Promise((resolve, reject) => {
    socket.onerror = () => reject(new Error('cannot reach the relay'));
    socket.onopen = () => {
      socket.send(JSON.stringify({ role: 'client', room, proto: [0, 1] }));
      resolve();
    };
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the relay never answered')), 10_000);
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
  opened = true;
} catch (error) {
  console.error(`the client could not join: ${String(error)}`);
  stopEverything();
  process.exit(2);
}

const tunnel = await Tunnel.open(
  {
    send: data => socket.send(data),
    receive: handler => listeners.push(handler),
    closed: handler => closeListeners.push(handler),
    close: () => socket.close(),
  },
  root,
);
const control = new ControlClient(tunnel);

/** Sends one raw control frame and waits for the reply with the same id. */
async function rawControl(frame) {
  const reply = new Promise(resolve => {
    const stop = tunnel.on(CONTROL_STREAM, payload => {
      const text = new TextDecoder().decode(payload);
      try {
        const parsed = JSON.parse(text);
        if (parsed.id === frame.id) {
          stop();
          resolve(parsed);
        }
      } catch {
        // Not a control reply; leave it for whoever else is listening.
      }
    });
  });
  await tunnel.send(CONTROL_STREAM, new TextEncoder().encode(JSON.stringify(frame)));
  return await reply;
}

// ---------------------------------------------------------------------------------------------
// 1. A failing run's report is accepted and lands in a file a person can read.
// ---------------------------------------------------------------------------------------------

const health = emptyHealth();
health.errors = 2;
health.rejections = 1;
recordFailure(health, 'TypeError: the panel never appeared');
// Deliberately the *client's* builder: the shape the browser sends is the shape that is measured.
const report = crashReport(health, 'connecting', {
  now: 1_700_000_000_000,
  userAgent: 'crash-smoke/1.0',
});

let outcome = null;
try {
  outcome = await control.reportCrash(report);
} catch (error) {
  check('the daemon answers a crash report', false, String(error));
}
check(
  'the daemon accepts a report from a client whose run failed',
  outcome !== null && outcome.accepted === true && outcome.stored === 1,
  outcome === null ? '(no answer)' : `accepted=${outcome.accepted} stored=${outcome.stored}`,
);

/** The stored file, or an empty string when the daemon has not written one. */
function readStored() {
  try {
    return readFileSync(reportsPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

/** How many complete lines the file holds. */
function storedCount() {
  return readStored()
    .split('\n')
    .filter(line => line.trim() !== '').length;
}

const stored = readStored();
let storedBody = null;
try {
  storedBody = JSON.parse(stored.trim());
} catch {
  // Left null: the check below reports it.
}
check(
  'the report is stored as one line carrying the failure and the phase',
  storedCount() === 1 &&
    storedBody !== null &&
    storedBody.phase === 'connecting' &&
    storedBody.reached_ready === false &&
    storedBody.errors === 2 &&
    Array.isArray(storedBody.samples) &&
    storedBody.samples.join(' ').includes('the panel never appeared'),
  storedCount() === 1 ? `${stored.length} bytes: ${stored.trim().slice(0, 120)}` : `${storedCount()} lines`,
);
if (process.platform !== 'win32') {
  const mode = statSync(reportsPath).mode & 0o777;
  check('the file is private to its owner', mode === 0o600, `mode ${mode.toString(8)}`);
}

const listed = await runToCompletion(drdshd, ['crashes'], { DSHD_STATE_DIR: stateDir }, 10_000);
check(
  '`drdshd crashes` shows it to the person who owns the machine',
  listed.code === 0 && listed.output.includes('the panel never appeared'),
  listed.output.trim().split('\n')[0] ?? '(no output)',
);

// ---------------------------------------------------------------------------------------------
// 2. Bounds: the client is the component that failed, so its word is not the limit.
// ---------------------------------------------------------------------------------------------

const oversized = await rawControl({
  kind: 'crash_report',
  id: 4242,
  body: {
    client: 'pwa 0.0.0',
    phase: 'ready',
    reached_ready: true,
    errors: 99,
    rejections: 0,
    samples: Array.from({ length: 25 }, () => 'x'),
    user_agent: 'crash-smoke/1.0',
    at_ms: 1,
  },
});
check(
  'a report past the daemon limits is refused with the reason, not stored anyway',
  oversized.body?.accepted === false && String(oversized.body?.error ?? '').includes('failure samples'),
  String(oversized.body?.error ?? '(no reason)'),
);
check(
  'and the refusal changed nothing on disk',
  storedCount() === 1,
  `${storedCount()} report(s)`,
);

// A body that is not a report at all is refused as one rather than stored as something else.
const broken = await rawControl({ kind: 'crash_report', id: 4243, body: { client: 'pwa 0.0.0' } });
check(
  'a body that is not a report is refused as one',
  broken.body?.accepted === false && String(broken.body?.error ?? '').includes('not a crash report'),
  String(broken.body?.error ?? '(no reason)'),
);

// ---------------------------------------------------------------------------------------------
// 3. Clearing makes room again: a full store must be recoverable without deleting files by hand.
// ---------------------------------------------------------------------------------------------

const cleared = await runToCompletion(drdshd, ['crashes', '--clear'], { DSHD_STATE_DIR: stateDir }, 10_000);
check(
  'clearing deletes the file and leaves the store usable',
  cleared.code === 0 && storedCount() === 0,
  `${cleared.output.trim()} (now ${storedCount()} report(s))`,
);

const again = await control.reportCrash(report);
check(
  'and the next report starts a fresh file',
  again.accepted === true && again.stored === 1,
  `stored=${again.stored}`,
);

console.log(`\n${results.length - failures}/${results.length} checks passed`);
tunnel.close();
socket.close();
stopEverything();
process.exit(failures === 0 ? 0 : 1);
