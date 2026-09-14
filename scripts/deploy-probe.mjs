/**
 * Verifies the deployment behaviour M4 asks for, by producing the situations it is about.
 *
 * Three claims are under test, and none of them can be checked by reading code:
 *
 *   1. **The relay says something when it is exposed.** Started on a non-loopback address it must warn,
 *      and on loopback it must stay quiet — a notice printed on every normal start is a notice nobody
 *      reads.
 *   2. **The daemon notices a proxy that closes quiet connections on a schedule.** A real reverse proxy
 *      is simulated with a TCP front end that forwards to a real relay but destroys any connection that
 *      has had nothing crossing it for a fixed interval, which is exactly what nginx's default 60s
 *      `proxy_read_timeout` does to a tunnel with no keepalive. The daemon has to reconnect, see the
 *      pattern, and print one warning naming the cause — because from its side a proxy timeout and a
 *      relay restart are the same event, and only the *regularity* tells them apart.
 *   3. **The keepalive stops that from happening at all**, in both directions and in both of a carrier's
 *      quiet states: a daemon parked with nobody connected (its own ping is the only traffic), and an
 *      established session with a real client attached and nothing to say (the relay's ping is). Each
 *      scenario runs against the same kind of proxy as claim 2, with the *other* end's keepalive off, so
 *      the survival can only be attributed to the end that is pinging.
 *
 * Usage:
 *   node scripts/deploy-probe.mjs [--drdshd target/debug/drdshd] [--drdsh-relay target/debug/drdsh-relay]
 *                                 [--relay-port 8891] [--proxy-port 8892] [--idle-seconds 21]
 *
 * Exit codes: 0 every behaviour observed, 1 a check failed, 2 the run could not start.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { connect as tcpConnect } from 'node:net';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
// The client half of claim 3 is the PWA's own tunnel and control client, imported rather than
// reimplemented: a client written inside this probe could agree with a daemon that is wrong, and the
// point of a live probe is that the two implementations are independent.
import { ControlClient } from '../apps/pwa/src/control.ts';
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
const relayPort = Number(option('--relay-port', '8891'));
const proxyPort = Number(option('--proxy-port', '8892'));
/**
 * How long the simulated proxy waits with nothing to forward before closing the carrier.
 *
 * Above the daemon's own floor for "this could be a proxy timeout" (20 seconds), which is deliberate on
 * both sides: a proxy timeout below that is not a thing real proxies do, and the daemon must not warn
 * about a flapping relay. The first version of this probe used 2 seconds and reported "no warning",
 * which was the heuristic working correctly and the probe being wrong.
 */
const PROXY_IDLE_SECONDS = Number(option('--idle-seconds', '21'));
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

/** Runs a command and resolves with its output once it exits or the timeout fires. */
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
// 1. The relay's own deployment check.
// ---------------------------------------------------------------------------------------------

const roomKey = Buffer.from(createHash('sha256').update('deploy-probe').digest()).toString('base64url');
// Keepalive off on this relay, explicitly rather than by default: claim 3a needs a relay that will not
// keep a carrier warm by itself, so the daemon's own ping is the only thing that can. A default that
// later changed would otherwise turn that check into a measurement of the relay.
const relay = await startRelay({ bind: `0.0.0.0:${relayPort}`, keepaliveSeconds: 0 });
await waitFor(relay.log, /warning:/, 5_000);
check(
  'the relay warns when it is bound to a non-loopback address',
  /warning:.*0\.0\.0\.0/.test(relay.log.text) && /read timeout/.test(relay.log.text),
  relay.log.text.split('\n').find(line => line.startsWith('warning:')) ?? '(no warning)',
);

const loopback = await runToCompletion(drdshRelay, [], { DSH_RELAY_BIND: '127.0.0.1:0', RUST_LOG: 'warn' }, 4000);
check(
  'and stays quiet on loopback',
  !/warning:/.test(loopback.output),
  loopback.output.includes('listening on') ? 'no warning, as expected' : 'the relay never started',
);

// ---------------------------------------------------------------------------------------------

// 2. The daemon's proxy-timeout detection, against a front end that behaves like a proxy.
// ---------------------------------------------------------------------------------------------

/**
 * A TCP-level reverse proxy that closes quiet connections after a fixed interval, and counts what it
 * forwards.
 *
 * It **forwards** to the real relay — the first version answered the upgrade itself, which meant the
 * daemon never got its `ready`, never parked a room, and there was no carrier lifetime to observe, so the
 * probe reported "no warning" about a situation that never occurred. What it does not do is keep the
 * connection alive: with nothing crossing for `idleSeconds` it destroys both halves of the socket, which
 * is what nginx's default 60s `proxy_read_timeout` does to a tunnel with no keepalive.
 *
 * The byte counters exist because a keepalive is invisible in every log: the only evidence it happened is
 * bytes crossing a socket that has nothing else to say.
 */
async function createIdleProxy({ idleSeconds, listenPort, upstreamPort }) {
  const counters = { upstream: 0, downstream: 0, connections: 0, cuts: 0 };
  const server = createServer((request, response) => {
    response.writeHead(502);
    response.end('this probe only speaks WebSocket\n');
  });
  server.on('upgrade', (request, socket, head) => {
    const upstream = tcpConnect(upstreamPort, '127.0.0.1');
    counters.connections += 1;
    let idle = null;
    const arm = () => {
      if (idle !== null) clearTimeout(idle);
      idle = setTimeout(() => {
        counters.cuts += 1;
        // Destroy both halves: a proxy that closed only its own side would leave the daemon reading
        // from a socket that is still open at the relay, so the cut would not be the one a real proxy
        // makes.
        socket.destroy();
        upstream.destroy();
      }, idleSeconds * 1000);
    };
    upstream.on('connect', () => {
      const lines = [`${request.method} ${request.url} HTTP/1.1`];
      for (const [name, value] of Object.entries(request.headers)) lines.push(`${name}: ${value}`);
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      arm();
    });
    upstream.on('data', chunk => {
      counters.downstream += chunk.length;
      socket.write(chunk);
      arm();
    });
    socket.on('data', chunk => {
      counters.upstream += chunk.length;
      upstream.write(chunk);
      arm();
    });
    const close = () => {
      if (idle !== null) clearTimeout(idle);
      socket.destroy();
      upstream.destroy();
    };
    socket.on('error', close);
    socket.on('close', close);
    upstream.on('error', close);
    upstream.on('close', close);
  });
  await new Promise(resolve => server.listen(listenPort, '127.0.0.1', resolve));
  return { server, counters, port: server.address().port };
}

/** Sleeps, for the windows below where the whole point is that nothing happens. */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

/** Waits until `pattern` shows up in a process's output. */
async function waitFor(log, pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !pattern.test(log.text)) await sleep(200);
  return pattern.test(log.text);
}

/** Starts a relay and waits until it is listening. */
async function startRelay({ bind, keepaliveSeconds }) {
  const child = spawn(drdshRelay, [], {
    env: {
      ...process.env,
      DSH_RELAY_BIND: bind,
      DSH_RELAY_KEEPALIVE_SECS: String(keepaliveSeconds),
      RUST_LOG: 'warn',
    },
  });
  const log = { text: '' };
  const absorb = chunk => {
    log.text += String(chunk);
  };
  child.stdout.on('data', absorb);
  child.stderr.on('data', absorb);
  await waitFor(log, /listening on/, 15_000);
  return { child, log };
}

/**
 * Starts a daemon against `relayUrl` and keeps its output.
 *
 * Its own state directory per run, because a device registry left behind by an earlier probe would
 * change the policy this daemon enforces — and a client refused for a reason from a previous run is a
 * failure that names nothing.
 */
function startDaemon({ relayUrl, roomKey: key, dshPort, keepaliveSeconds, stateDir }) {
  const child = spawn(
    drdshd,
    ['run', '--relay', relayUrl, '--room-key', key, '--port', String(dshPort)],
    {
      env: {
        ...process.env,
        DSHD_STATE_DIR: stateDir,
        DSHD_KEEPALIVE_SECS: String(keepaliveSeconds),
        PATH: `${process.cwd()}/target/test-bin:${process.env.PATH ?? ''}`,
        RUST_LOG: 'info',
      },
    },
  );
  const log = { text: '' };
  const absorb = chunk => {
    log.text += String(chunk);
  };
  child.stdout.on('data', absorb);
  child.stderr.on('data', absorb);
  return { child, log };
}

// A port chosen by the OS and released immediately, rather than a constant: a daemon killed by this
// probe leaves its DSH running, that DSH keeps the port, and the next run's daemon then refuses to start
// — which looks exactly like "the detection did not fire". Two runs of this probe were spent learning
// that, so the port is fresh every time and the daemon's log is printed when a check fails.
const detectionProxy = await createIdleProxy({
  idleSeconds: PROXY_IDLE_SECONDS,
  listenPort: proxyPort,
  upstreamPort: relayPort,
});
const detection = startDaemon({
  relayUrl: `ws://127.0.0.1:${proxyPort}`,
  roomKey,
  dshPort: await freePort(),
  // Off: with a keepalive running on either end there would be nothing silent left for the detection to
  // notice, and this claim is about what happens *without* one. Claim 3 turns it on and shows the
  // difference.
  keepaliveSeconds: 0,
  stateDir: 'target/deploy-probe-state',
});
await waitFor(detection.log, /relay: Connected/, 20_000);

// Three lifetimes of ~21s plus the daemon's backoff between them.
await waitFor(detection.log, /proxy_read_timeout/, 150_000);
const warned = /proxy_read_timeout/.test(detection.log.text) && /silence/.test(detection.log.text);
check(
  'the daemon notices connections being closed on a schedule and names the proxy',
  warned,
  warned
    ? detection.log.text.split('\n').find(line => line.includes('proxy_read_timeout'))?.slice(0, 200)
    : `(no warning before the deadline) daemon log tail: ${detection.log.text.trim().split('\n').slice(-4).join(' | ').slice(0, 300)}`,
);
// Counted by the warning's own opening phrase, not by `proxy_read_timeout`: that string appears twice
// *inside* one message (once as the nginx default being explained, once in the suggested setting), so
// counting it reported "2 occurrences" for a warning that was printed exactly once.
const occurrences = (detection.log.text.match(/the carrier connection has been closed after about/g) ?? [])
  .length;
check('and says it once, not once per reconnection', occurrences === 1, `${occurrences} occurrence(s)`);
detection.child.kill('SIGKILL');
detectionProxy.server.close();

// ---------------------------------------------------------------------------------------------
// 3. The keepalive, against the same proxy: the same situation, with the defence turned on.
// ---------------------------------------------------------------------------------------------

/**
 * The keepalive interval both scenarios below use, and the proxy's idle window they have to beat.
 *
 * Five seconds is short enough that several pings fit inside the proxy's window and the scenario is over
 * quickly; it is also a plausible operator setting. Twelve seconds is *not* a plausible nginx timeout —
 * it is chosen to be short, and what makes it a fair test is that it is many times the interval, so a
 * keepalive that is merely late still fails. The daemon's own floor for "this looks like a proxy timeout"
 * (20s) does not apply here: nothing is supposed to be cut at all.
 */
const KEEPALIVE_EVERY_SECONDS = 5;
const KEEPALIVE_IDLE_SECONDS = 12;

/** How long each scenario watches a quiet carrier: more than twice the interval that kills a silent one. */
const QUIET_WINDOW_MS = KEEPALIVE_IDLE_SECONDS * 2200;

if (typeof WebSocket !== 'function') {
  console.error('the session scenario needs node\'s global WebSocket (node 22 or newer)');
  process.exit(2);
}

// --- 3a. A parked carrier: the daemon pings, the relay is told not to. ---------------------------------

const parkedProxy = await createIdleProxy({
  idleSeconds: KEEPALIVE_IDLE_SECONDS,
  listenPort: 0,
  upstreamPort: relayPort,
});
const parked = startDaemon({
  relayUrl: `ws://127.0.0.1:${parkedProxy.port}`,
  roomKey,
  dshPort: await freePort(),
  keepaliveSeconds: KEEPALIVE_EVERY_SECONDS,
  stateDir: 'target/deploy-probe-state',
});
const parkedInTime = await waitFor(parked.log, /relay: Connected/, 20_000);
// Taken after `Connected`, which the daemon reports once the relay's `ready` has been read: everything
// before this line is the handshake, so anything counted after it crossed a quiet socket.
const parkedBefore = { ...parkedProxy.counters };
await sleep(QUIET_WINDOW_MS);
const parkedAfter = { ...parkedProxy.counters };
const parkedUpstream = parkedAfter.upstream - parkedBefore.upstream;
check(
  'a parked carrier survives a proxy that cuts silent connections, with only the daemon pinging',
  parkedInTime &&
    parkedAfter.cuts === 0 &&
    !/relay: Reconnecting/.test(parked.log.text) &&
    !/proxy_read_timeout/.test(parked.log.text),
  `idle window ${KEEPALIVE_IDLE_SECONDS}s, watched ${Math.round(QUIET_WINDOW_MS / 1000)}s, ` +
    `${parkedAfter.cuts} cut(s), ${parkedAfter.connections} connection(s); ` +
    `the relay's own keepalive was off (DSH_RELAY_KEEPALIVE_SECS=0)`,
);
check(
  'and what kept it alive was the daemon pinging, which no log would have shown',
  parkedUpstream > 0,
  `${parkedUpstream} bytes crossed upstream while the carrier had nothing else to say`,
);
parked.child.kill('SIGKILL');
parkedProxy.server.close();

// --- 3b. An established session: the relay pings, the daemon is told not to. ---------------------------

/** Sleeps, then answers whether it finished before the timeout. */
async function within(promise, timeoutMs) {
  return await Promise.race([
    promise.then(
      () => true,
      () => false,
    ),
    sleep(timeoutMs).then(() => false),
  ]);
}

// The relay runs its own keepalive here, so the daemon is told to stay quiet: with only one of the two
// pinging, survival can be attributed to that one rather than to "keepalive works somewhere".
const warmRelayPort = await freePort();
const warmRelay = await startRelay({
  bind: `127.0.0.1:${warmRelayPort}`,
  keepaliveSeconds: KEEPALIVE_EVERY_SECONDS,
});
const sessionProxy = await createIdleProxy({
  idleSeconds: KEEPALIVE_IDLE_SECONDS,
  listenPort: 0,
  upstreamPort: warmRelayPort,
});
const session = startDaemon({
  relayUrl: `ws://127.0.0.1:${sessionProxy.port}`,
  roomKey,
  dshPort: await freePort(),
  keepaliveSeconds: 0,
  stateDir: 'target/deploy-probe-session-state',
});
const sessionInTime = await waitFor(session.log, /relay: Connected/, 20_000);

// A real client, running the PWA's own tunnel and control client over a real session. The client connects
// to the relay **directly** rather than through the cutting proxy: it has no keepalive of its own, so
// proxying both ends would measure the client's socket dying instead of the carrier's.
const sessionRoot = new Uint8Array(Buffer.from(roomKey, 'base64url'));
const sessionRoom = await Tunnel.roomFor(sessionRoot);
const socket = new WebSocket(`ws://127.0.0.1:${warmRelayPort}/ws/client`);
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
let clientOpened = false;
try {
  await new Promise((resolve, reject) => {
    socket.onerror = () => reject(new Error('cannot reach the relay'));
    socket.onopen = () => {
      socket.send(JSON.stringify({ role: 'client', room: sessionRoom, proto: [0, 1] }));
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
  clientOpened = true;
} catch (error) {
  check('a real client can join the session', false, String(error));
}
const tunnel = clientOpened
  ? await Tunnel.open(
      {
        send: data => socket.send(data),
        receive: handler => listeners.push(handler),
        closed: handler => closeListeners.push(handler),
        close: () => socket.close(),
      },
      sessionRoot,
    )
  : null;
const control = tunnel === null ? null : new ControlClient(tunnel);
const beforeStatus = control === null ? null : await within(control.status(), 10_000);

// Baselines after the client's own request has been answered, so what follows is a quiet socket.
const sessionBefore = { ...sessionProxy.counters };
await sleep(QUIET_WINDOW_MS);
const sessionAfter = { ...sessionProxy.counters };
const sessionDownstream = sessionAfter.downstream - sessionBefore.downstream;
const survived = control === null ? false : await within(control.status(), 10_000);
check(
  'a session left idle for twice the cutting interval is still there afterwards',
  sessionInTime &&
    beforeStatus === true &&
    survived &&
    socket.readyState === 1 &&
    sessionAfter.cuts === 0 &&
    !/relay: Reconnecting/.test(session.log.text) &&
    !/carrier connection ended/.test(session.log.text),
  `idle window ${KEEPALIVE_IDLE_SECONDS}s, watched ${Math.round(QUIET_WINDOW_MS / 1000)}s, ` +
    `${sessionAfter.cuts} cut(s); the first status answered: ${beforeStatus}, the one after: ${survived}`,
);
check(
  'and the bytes that kept the session alive were the relay ping, with the daemon told not to',
  sessionDownstream > 0,
  `${sessionDownstream} bytes crossed downstream while the session had nothing to say ` +
    `(DSHD_KEEPALIVE_SECS=0 on the daemon)`,
);
socket.close();
session.child.kill('SIGKILL');
warmRelay.child.kill('SIGKILL');
sessionProxy.server.close();

relay.child.kill('SIGKILL');

console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures === 0 ? 0 : 1);
