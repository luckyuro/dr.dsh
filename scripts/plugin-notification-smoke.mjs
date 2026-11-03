/**
 * Real plugin -> authenticated loopback report -> real daemon/relay -> PWA control client.
 * DSH's process and event context are fixtures; the plugin, report receiver, pairing, device
 * authentication, encryption and notification subscription are the production implementations.
 *
 * Usage: node scripts/plugin-notification-smoke.mjs [--drdshd target/debug/drdshd]
 *          [--drdsh-relay target/debug/drdsh-relay]
 * Exit codes: 0 passed, 1 failed, 2 missing prerequisites. No model or browser is required.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { ControlClient } from '../apps/pwa/src/control.ts';
import { pairWithCode } from '../apps/pwa/src/pair.ts';
import { CONTROL_STREAM, Tunnel } from '../apps/pwa/src/tunnel.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return resolve(repo, fallback);
  if (!args[index + 1]) { console.error(`${name} requires a binary path`); process.exit(2); }
  return resolve(args[index + 1]);
}
const daemonBinary = option('--drdshd', 'target/debug/drdshd');
const relayBinary = option('--drdsh-relay', 'target/debug/drdsh-relay');
if (!existsSync(daemonBinary) || !existsSync(relayBinary)) {
  console.error('Notification smoke needs daemon and relay binaries; run cargo build --workspace first.');
  process.exit(2);
}
const scratch = mkdtempSync(join(tmpdir(), 'drdsh-notifications-'));
const stateDir = join(scratch, 'state');
mkdirSync(stateDir, { mode: 0o700 });
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const dsh = join(scratch, 'dsh');
writeFileSync(dsh, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(repo, 'scripts/fixtures/plugin-notification-dsh.mjs'))} "$@"\n`, { mode: 0o700 });
const env = {
  ...process.env,
  DSHD_STATE_DIR: stateDir,
  DSHD_DSH: dsh,
  DRDSH_NOTIFICATION_SMOKE_DIR: scratch,
  RUST_LOG: 'info',
};
// Each test run owns its transport and opt-in settings, independent of the caller's service env.
for (const key of ['DRDSH_REPORT_URL', 'DRDSH_REPORT_TOKEN', 'DSHD_PLUGIN_REPORTS', 'DSHD_DSH_TLS',
  'DSH_RELAY_TLS_CERT', 'DSH_RELAY_TLS_KEY', 'DSHD_TLS_CA_FILE']) delete env[key];
const children = new Set();
const clients = new Set();
let checks = 0;
let commandId = 0;
const check = name => console.log(`ok ${++checks} - ${name}`);

function stop(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
}
function cleanup() {
  for (const client of clients) client.close();
  for (const child of children) stop(child);
  rmSync(scratch, { recursive: true, force: true });
}
process.once('exit', cleanup);
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => process.exit(1));

function start(binary, argv, extra = {}) {
  const child = spawn(binary, argv, { env: { ...env, ...extra }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let log = '';
  child.stdout.on('data', bytes => { log += bytes; });
  child.stderr.on('data', bytes => { log += bytes; });
  child.on('error', () => {});
  return { child, log: () => log };
}
async function until(condition, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await condition()) return; await delay(50); }
  throw new Error(`Timed out waiting for ${label}`);
}
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(accept => server.close(accept));
  return port;
}
function fixture() {
  const path = join(scratch, 'fixture.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}
function controlEnvelope(bytes) {
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { return null; }
}
async function command(body) {
  const id = ++commandId;
  const path = join(scratch, 'command.json');
  writeFileSync(`${path}.next`, JSON.stringify({ id, ...body }), { mode: 0o600 });
  renameSync(`${path}.next`, path);
  let result;
  await until(() => {
    const output = join(scratch, 'result.json');
    if (!existsSync(output)) return false;
    result = JSON.parse(readFileSync(output, 'utf8'));
    return result.id === id;
  }, 'managed plugin fixture response');
  assert.ok(!result.failed, 'managed plugin fixture request failed');
  return result;
}

const relayPort = await freePort();
const relayUrl = `ws://127.0.0.1:${relayPort}`;
async function connect(room) {
  const socket = new WebSocket(`${relayUrl}/ws/client`);
  socket.binaryType = 'arraybuffer';
  const listeners = [];
  const closed = [];
  const closedDone = new Promise(accept => socket.addEventListener('close', accept, { once: true }));
  socket.addEventListener('message', event => {
    if (typeof event.data !== 'string') for (const receive of [...listeners]) receive(new Uint8Array(event.data));
  });
  socket.addEventListener('close', () => { for (const close of [...closed]) close('smoke carrier closed'); });
  clients.add(socket);
  await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error('relay join timed out')), 10_000);
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('relay connection failed')); }, { once: true });
    socket.addEventListener('open', () => socket.send(JSON.stringify({ role: 'client', room, proto: [0, 1] })), { once: true });
    socket.addEventListener('message', function ready(event) {
      if (typeof event.data !== 'string') return;
      clearTimeout(timer);
      socket.removeEventListener('message', ready);
      if (JSON.parse(event.data).type === 'ready' || event.data.includes('ready')) accept();
      else reject(new Error('relay refused the test room'));
    });
  });
  return {
    send: bytes => socket.send(bytes), receive: fn => listeners.push(fn), closed: fn => closed.push(fn),
    close: () => socket.close(), closedDone,
  };
}

let started = false;
try {
  const relay = start(relayBinary, [], { DSH_RELAY_BIND: `127.0.0.1:${relayPort}` });
  await until(() => relay.log().includes('listening on'), 'relay startup');
  const pairing = start(daemonBinary, ['pair', '--relay', relayUrl, '--wait', '60']);
  await until(() => /code:\s+\S+/u.test(pairing.log()), 'pairing code');
  const code = /code:\s+(\S+)/u.exec(pairing.log())[1];
  const paired = await pairWithCode({ connect, report: () => {} }, { code, deviceName: 'notification-smoke' });
  await until(() => pairing.child.exitCode !== null, 'pairing process completion');
  assert.equal(pairing.child.exitCode, 0, 'pairing process failed');
  const root = new Uint8Array(Buffer.from(readFileSync(join(stateDir, 'room-key'), 'utf8').trim(), 'base64url'));
  const room = await Tunnel.roomFor(root);
  const identity = { deviceId: paired.deviceId, room: paired.room, key: paired.device.keyPair };
  check('a real pairing enrolls the notification client');

  const dshPort = await freePort();
  const daemonArgs = ['run', '--relay', relayUrl, '--port', String(dshPort)];
  const disabled = start(daemonBinary, daemonArgs, {
    DRDSH_REPORT_URL: 'http://127.0.0.1:1',
    DRDSH_REPORT_TOKEN: 'unused-parent-capability-for-inheritance-check',
  });
  await until(() => fixture() !== null && disabled.log().includes('relay: Connected'), 'default daemon startup');
  const disabledPid = fixture().pid;
  assert.equal(fixture().configured, false);
  assert.equal(fixture().subscriptions, 0);
  check('reporting defaults off, discards inherited report credentials and leaves the plugin inert');
  stop(disabled.child);
  await until(() => disabled.child.exitCode !== null || disabled.child.signalCode !== null, 'default daemon shutdown');

  const daemon = start(daemonBinary, [...daemonArgs, '--plugin-reports']);
  const connections = () => daemon.log().match(/relay: Connected/gu)?.length ?? 0;
  await until(() => fixture()?.pid !== disabledPid && fixture()?.configured && daemon.log().includes('relay: Connected'), 'opted-in daemon startup', 30_000);
  started = true;
  assert.equal(fixture().loopback, true);
  assert.equal(fixture().credentialPresent, true);
  assert.equal(fixture().subscriptions, 5);
  check('managed DSH receives private loopback report configuration and mounts the real plugin');
  assert.equal((await command({ op: 'probe', variant: 'valid' })).status, 503);
  check('reports without an authenticated subscriber are refused rather than queued for later');

  // This relay supports one active client. Test the unproved session first, then release it
  // before the enrolled session so neither test silently replaces the other's carrier.
  const unboundCarrier = await connect(room);
  const unbound = await Tunnel.open(unboundCarrier, root, null, { deviceStep: false });
  let unauthenticatedNotifications = 0;
  unbound.on(CONTROL_STREAM, bytes => {
    if (controlEnvelope(bytes)?.kind === 'notification') unauthenticatedNotifications += 1;
  });
  assert.equal((await command({ op: 'probe', variant: 'valid' })).status, 503);
  assert.equal(unauthenticatedNotifications, 0);
  const beforeUnboundClose = connections();
  unbound.close();
  await unboundCarrier.closedDone;
  await until(() => connections() > beforeUnboundClose, 'daemon re-registering after unproved client');
  check('a client with the room key but no device proof receives no notifications');

  const wire = [];
  async function openClient() {
    const carrier = await connect(room);
    const tunnel = await Tunnel.open(carrier, root, identity);
    assert.equal(tunnel.isDeviceBound, true);
    const control = new ControlClient({
      on(stream, receive) {
        return tunnel.on(stream, bytes => {
          if (stream === CONTROL_STREAM) {
            const envelope = controlEnvelope(bytes);
            if (envelope?.kind === 'notification') wire.push(envelope);
          }
          receive(bytes);
        });
      },
      send: (stream, bytes) => tunnel.send(stream, bytes),
      onClosed: listener => tunnel.onClosed(listener),
    });
    const received = [];
    const unsubscribe = control.onNotification(notification => received.push(notification));
    await control.status();
    return { tunnel, control, received, unsubscribe, closedDone: carrier.closedDone };
  }
  const first = await openClient();
  check('an enrolled client establishes an encrypted, device-authenticated session');

  for (const [variant, expected] of [
    ['missing-auth', 401], ['wrong-auth', 401], ['browser-origin', 403], ['content-type', 415], ['extra-field', 400],
    ['oversized', 413], ['severity', 400], ['session', 400],
  ]) assert.equal((await command({ op: 'probe', variant })).status, expected, `report receiver rejected ${variant}`);
  assert.equal(first.received.length, 0);
  check('report endpoint rejects bad credentials, browser origins, wrong content type, content and invalid metadata');

  const events = [
    ['session/event', 'turn_complete', 'notice'],
    ['approval/request', 'approval_requested', 'alert'],
    ['user-questions/request', 'approval_requested', 'alert'],
    ['goal/changed', 'goal_complete', 'alert'],
    ['subagent/end', 'subagent_complete', 'info'],
  ];
  for (const [event, expected, severity] of events) {
    const before = first.received.length;
    const outcome = await command({ op: 'emit', event });
    assert.equal(outcome.invoked, 1);
    if (event.endsWith('/request')) assert.equal(outcome.continued, true);
    await until(() => first.received.length === before + 1, 'notification delivery');
    const notification = first.received.at(-1);
    assert.equal(notification.event, expected);
    assert.equal(notification.severity, severity);
    assert.equal(notification.sessionRef, 'smoke-session');
    assert.ok(Number.isSafeInteger(notification.atMs) && Math.abs(Date.now() - notification.atMs) < 10_000);
  }
  check('all five observed DSH events reach the PWA client with the four expected notification kinds');
  check('approval and question observers preserve the DSH answer continuation');
  for (const envelope of wire) {
    assert.equal(envelope.id, 0);
    assert.deepEqual(Object.keys(envelope.body).sort(), ['at_ms', 'event', 'session_ref', 'severity']);
    assert.ok(!JSON.stringify(envelope).includes('notification-private-sentinel'));
    assert.ok(!JSON.stringify(envelope).includes('notification-path-sentinel'));
  }
  assert.ok(!daemon.log().includes('notification-private-sentinel'));
  assert.ok(!daemon.log().includes('notification-path-sentinel'));
  check('encrypted control envelopes contain only fixed metadata, with no prompt, title, path or tool output');

  const firstCount = first.received.length;
  const wireCount = wire.length;
  first.unsubscribe();
  await command({ op: 'emit', event: 'session/event' });
  await until(() => wire.length === wireCount + 1, 'notification after unsubscribe');
  assert.equal(first.received.length, firstCount);
  first.control.onNotification(notification => first.received.push(notification));
  await command({ op: 'emit', event: 'session/event' });
  await until(() => first.received.length === firstCount + 1, 'new notification subscription');
  const beforeClientClose = connections();
  first.control.close();
  first.tunnel.close();
  await first.closedDone;
  await until(() => connections() > beforeClientClose, 'daemon re-registering after client disconnect');
  const reconnected = await openClient();
  assert.equal(reconnected.received.length, 0);
  await command({ op: 'emit', event: 'goal/changed' });
  await until(() => reconnected.received.length === 1, 'reconnected subscription');
  assert.equal(reconnected.received[0].event, 'goal_complete');
  check('unsubscribe removes delivery and reconnect receives only new events');

  const oldPid = fixture().pid;
  const restart = await reconnected.control.command('restart');
  assert.equal(restart.ok, true);
  await until(() => fixture()?.pid !== oldPid && fixture()?.configured, 'restarted managed plugin');
  await command({ op: 'emit', event: 'subagent/end' });
  await until(() => reconnected.received.length === 2, 'notification after managed DSH restart');
  assert.equal(reconnected.received.at(-1).event, 'subagent_complete');
  check('managed DSH restart preserves reporting without stacking subscriptions');

  reconnected.control.close();
  reconnected.tunnel.close();
  await reconnected.closedDone;
  await until(async () => (await command({ op: 'probe', variant: 'valid' })).status === 503,
    'last authenticated client release');
  check('closing every authenticated client leaves no offline notification backlog');
  console.log(`Notification smoke passed (${checks} checks).`);
} catch (error) {
  // Assertion values may contain payloads; expose only the test-stage message, never logs or values.
  const message = error instanceof assert.AssertionError ? `A notification smoke assertion failed after check ${checks}.`
    : error instanceof Error ? error.message : 'Notification smoke failed.';
  console.error(message);
  process.exitCode = started ? 1 : 2;
} finally { cleanup(); }
