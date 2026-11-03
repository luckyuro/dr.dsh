/**
 * Real daemon management: private IPC, CLI compatibility, live pairing/revocation and ownership.
 * Uses a private relay, a DSH process fixture and the PWA's actual encrypted pairing/tunnel client.
 * Every directory and process belongs to this run; no installed user service is changed.
 *
 * Usage: node scripts/daemon-management-smoke.mjs [--drdsh target/debug/drdsh]
 * Exit codes: 0 passed, 1 failed, 2 missing prerequisites. No browser, API key or model is needed.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { ControlClient } from '../apps/pwa/src/control.ts';
import { pairWithCode } from '../apps/pwa/src/pair.ts';
import { decodeMessage, encodeRequest, encodeWsOpen, request } from '../apps/pwa/src/proxy.ts';
import { Tunnel } from '../apps/pwa/src/tunnel.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--drdsh')) {
  console.error('Usage: node scripts/daemon-management-smoke.mjs [--drdsh <binary>]');
  process.exit(2);
}
const binary = resolve(repo, args[1] ?? 'target/debug/drdsh');
if (!existsSync(binary) || !['darwin', 'linux'].includes(process.platform)
    || typeof WebSocket === 'undefined') {
  console.error('Management smoke requires macOS/Linux, a modern Node with WebSocket/type stripping, and cargo build -p dr-dsh-cli.');
  process.exit(2);
}

// macOS's default TMPDIR can exceed sockaddr_un's limit before admin.sock is appended.
const scratch = mkdtempSync('/tmp/drdsh-mgmt-');
const prefix = join(scratch, 'prefix');
const state = join(scratch, 'state');
const disabledState = join(scratch, 'disabled');
const home = join(scratch, 'home');
for (const path of [prefix, state, disabledState, home]) mkdirSync(path, { recursive: true, mode: 0o700 });
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const dsh = join(scratch, 'dsh');
writeFileSync(dsh, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(repo, 'scripts/fixtures/daemon-management-dsh.mjs'))} "$@"\n`, { mode: 0o700 });
const env = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !/^(DSHD_|DRDSH_|DSH_RELAY_|DSH_HOME$|FAKE_DSH_)/u.test(key)));
Object.assign(env, {
  HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'),
  XDG_STATE_HOME: join(home, 'state'), DSH_HOME: join(home, 'dsh'),
  DSHD_STATE_DIR: state, DSHD_DSH: dsh, DRDSH_MANAGEMENT_SMOKE_DIR: scratch, RUST_LOG: 'info',
});
const children = new Set();
const sockets = new Set();
let checks = 0;
let requestId = 0;
let phase = 'prerequisites';
let daemon;
let relay;
const check = text => console.log(`ok ${++checks} - ${text}`);
const alive = child => child.exitCode === null && child.signalCode === null;

function kill(child, signal = 'SIGKILL') {
  if (!child?.pid || !alive(child)) return;
  try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
}
function cleanup() {
  for (const socket of sockets) {
    if ('destroy' in socket) socket.destroy();
    else socket.close();
  }
  for (const child of children) kill(child);
  rmSync(scratch, { recursive: true, force: true });
}
process.once('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => process.exit(1));

function start(argv, extra = {}, stdin) {
  const child = spawn(binary, argv, {
    cwd: scratch, env: { ...env, ...extra }, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  let stdout = '';
  let stderr = '';
  let error;
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', failure => { error = failure; });
  child.stdin.on('error', () => {});
  child.stdin.end(stdin);
  return { child, stdout: () => stdout, stderr: () => stderr, log: () => stdout + stderr, error: () => error };
}
async function until(condition, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await delay(40);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function bounded(promise, label, timeout = 15_000, abort = () => {}) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => { abort(); reject(new Error(`Timed out waiting for ${label}`)); }, timeout);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
async function exited(record, timeout = 15_000) {
  await until(() => record.error() || !alive(record.child), 'command completion', timeout);
  if (record.error()) throw record.error();
  return record.child.exitCode;
}
async function command(argv, extra = {}, stdin) {
  const record = start(argv, extra, stdin);
  const code = await exited(record);
  return { code, stdout: record.stdout(), stderr: record.stderr() };
}
async function stop(record) {
  if (!record || !alive(record.child)) return;
  // Let the daemon dispose its lock/socket before the next run tests reuse.
  record.child.kill('SIGTERM');
  await exited(record);
}
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(accept => server.close(accept));
  return port;
}
const starts = () => existsSync(join(scratch, 'dsh-starts.jsonl'))
  ? readFileSync(join(scratch, 'dsh-starts.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const proxyState = () => JSON.parse(readFileSync(join(scratch, 'proxy-state.json'), 'utf8'));
const socketPath = directory => join(directory, '.runtime', 'admin.sock');

function envelope(operation, params = {}) {
  return { version: 1, requestId: `smoke-${++requestId}`, operation, params };
}
async function rawIpc(payload, directory = state) {
  return await new Promise((accept, reject) => {
    const socket = createConnection(socketPath(directory));
    sockets.add(socket);
    let output = '';
    let settled = false;
    const done = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sockets.delete(socket);
      socket.destroy();
      if (error) reject(error); else accept(result);
    };
    const timer = setTimeout(() => done(new Error('private management IPC did not answer')), 8_000);
    socket.on('connect', () => socket.end(payload));
    socket.on('data', bytes => {
      if (settled) return;
      output += bytes;
      try {
        assert.ok(Buffer.byteLength(output) <= 64 * 1024 + 1, 'IPC response must be bounded JSON');
        const newline = output.indexOf('\n');
        if (newline < 0) return;
        assert.equal(newline, output.length - 1, 'IPC response must contain exactly one JSON line');
        // Linux can reset a socket after the refusal line when an oversized request
        // still has unread bytes. The protocol completes at the newline, not EOF.
        done(null, JSON.parse(output));
      } catch (error) { done(error); }
    });
    socket.on('error', error => done(error));
    socket.on('end', () => {
      if (!settled) done(new Error('IPC ended before a complete JSON response line'));
    });
  });
}
async function ipc(operation, params = {}) {
  const input = envelope(operation, params);
  const response = await rawIpc(`${JSON.stringify(input)}\n`);
  assert.equal(response.version, 1);
  assert.equal(response.requestId, input.requestId);
  assert.equal(response.ok, true, `IPC ${operation} failed: ${response.error?.message ?? 'no reason'}`);
  return response.result;
}
async function manage(operation, params = {}) {
  const input = envelope(operation, params);
  const output = await command(['daemon', 'manage', '--prefix', prefix], {}, JSON.stringify(input));
  assert.equal(output.code, 0, `manage ${operation} failed: ${output.stderr}`);
  assert.equal(output.stdout.trim().split('\n').length, 1, 'machine CLI stdout must contain exactly one JSON result');
  const response = JSON.parse(output.stdout);
  assert.equal(response.version, 1);
  assert.equal(response.requestId, input.requestId);
  assert.equal(response.ok, true, `manage ${operation} failed: ${response.error?.message ?? 'no reason'}`);
  return response.result;
}
function assertRefused(value, label) {
  assert.equal(value.ok, false, `${label} must be rejected`);
  assert.equal(typeof value.error?.code, 'string', `${label} needs a machine-readable reason`);
  assert.ok(value.error.message.length > 0, `${label} needs an actionable reason`);
}

const relayPort = await freePort();
const dshPort = await freePort();
const relayUrl = `ws://127.0.0.1:${relayPort}`;
const daemonArgs = ['daemon', 'run', '--relay', relayUrl, '--port', String(dshPort)];

async function connect(room) {
  const socket = new WebSocket(`${relayUrl}/ws/client`);
  socket.binaryType = 'arraybuffer';
  sockets.add(socket);
  const receivers = [];
  const closers = [];
  let closed = false;
  const closedDone = new Promise(accept => socket.addEventListener('close', accept, { once: true }));
  socket.addEventListener('message', event => {
    if (typeof event.data !== 'string') for (const receive of [...receivers]) receive(new Uint8Array(event.data));
  });
  socket.addEventListener('close', () => {
    sockets.delete(socket);
    closed = true;
    for (const close of [...closers]) close('management smoke carrier closed');
  });
  await bounded(new Promise((accept, reject) => {
    socket.addEventListener('error', () => reject(new Error('relay carrier connection failed')), { once: true });
    socket.addEventListener('open', () => socket.send(JSON.stringify({ role: 'client', room, proto: [0, 1] })), { once: true });
    socket.addEventListener('message', function joined(event) {
      if (typeof event.data !== 'string') return;
      socket.removeEventListener('message', joined);
      const reply = JSON.parse(event.data);
      if (reply.type === 'ready') accept(); else reject(new Error(`relay refused room: ${reply.reason ?? reply.type}`));
    });
  }), 'relay join', 10_000, () => socket.close());
  return {
    send: bytes => socket.send(bytes), receive: fn => receivers.push(fn),
    closed: fn => { if (closed) fn('management smoke carrier closed'); else closers.push(fn); },
    close: () => socket.close(), closedDone, isClosed: () => closed,
  };
}
async function legacyPair(name, directory = state) {
  const pairing = start(['daemon', 'pair', '--relay', relayUrl, '--wait', '40'], { DSHD_STATE_DIR: directory });
  await until(() => /code:\s+\S+/u.test(pairing.stdout()) || !alive(pairing.child), 'legacy pairing code');
  const code = /code:\s+(\S+)/u.exec(pairing.stdout())?.[1];
  assert.ok(code, 'legacy pair must still print its human-readable code: line');
  const paired = await pairWithCode({ connect, report: () => {} }, { code, deviceName: name, timeoutMs: 10_000 });
  assert.equal(await exited(pairing), 0, 'legacy live pairing must complete successfully');
  assert.match(pairing.stdout(), /pairing/u);
  assert.ok(pairing.stdout().includes(paired.deviceId), 'legacy pair output must identify the enrolled device');
  assert.equal(pairing.log().includes(Buffer.from(paired.roomKey).toString('base64url')), false, 'legacy pairing must not print the room key');
  return paired;
}
const connections = () => daemon.log().match(/relay: Connected/gu)?.length ?? 0;
async function openClient(paired) {
  const carrier = await connect(paired.room);
  const identity = { deviceId: paired.deviceId, room: paired.room, key: paired.device.keyPair };
  const tunnel = await bounded(Tunnel.open(carrier, paired.roomKey, identity), 'device-authenticated tunnel', 10_000, () => carrier.close());
  assert.equal(tunnel.isDeviceBound, true);
  const control = new ControlClient(tunnel);
  return { carrier, tunnel, control };
}
async function closeClient(client) {
  const before = connections();
  client.control.close();
  client.tunnel.close();
  await bounded(client.carrier.closedDone, 'client close');
  await until(() => connections() > before, 'daemon re-registering its carrier');
}
async function probeDsh(client) {
  const response = await bounded(request(client.tunnel, 1, encodeRequest(1, 'GET', '/')), 'authenticated DSH proxy');
  assert.equal(response.head.status, 200);
  assert.match(new TextDecoder().decode(response.body), /fake dsh/u);
}
async function holdProxyConnections(client) {
  let httpSettled = false;
  void request(client.tunnel, 20, encodeRequest(20, 'GET', '/smoke/slow'))
    .then(() => { httpSettled = true; }, () => { httpSettled = true; });
  let opened;
  const wsOpened = new Promise(accept => { opened = accept; });
  const unsubscribe = client.tunnel.on(21, bytes => {
    const message = decodeMessage(bytes);
    if (message?.kind === 'wsOpened') opened(message.status);
  });
  await client.tunnel.send(21, encodeWsOpen(21, '/api/socket'));
  assert.equal(await bounded(wsOpened, 'proxied WebSocket opening'), 101);
  await until(() => proxyState().httpOpen === 1 && proxyState().wsOpen === 1, 'held upstream HTTP and WebSocket');
  assert.equal(httpSettled, false, 'the slow HTTP request must still be pending before revocation');
  return unsubscribe;
}

try {
  phase = 'private relay and legacy command defaults';
  relay = start(['relay', 'run', '--bind', `127.0.0.1:${relayPort}`]);
  await until(() => relay.log().includes('listening on') || !alive(relay.child), 'relay startup');
  assert.ok(alive(relay.child), 'private relay must start');
  const empty = await command(['daemon', 'devices']);
  assert.equal(empty.code, 0);
  assert.match(empty.stdout, /no devices are enrolled/u);
  check('the existing devices command retains its human-readable empty-state output');

  phase = 'default-disabled IPC and state ownership';
  const disabled = start(daemonArgs, { DSHD_STATE_DIR: disabledState });
  daemon = disabled;
  await until(() => disabled.log().includes('relay: Connected') || !alive(disabled.child), 'default daemon startup');
  assert.ok(alive(disabled.child), 'default daemon must start');
  assert.equal(existsSync(socketPath(disabledState)), false);
  const startedWithoutAdmin = starts().length;
  const stateAlias = join(scratch, 'state-alias');
  symlinkSync(disabledState, stateAlias);
  const duplicate = await command([...daemonArgs, '--local-admin'], { DSHD_STATE_DIR: stateAlias });
  assert.notEqual(duplicate.code, 0, 'second daemon must refuse the occupied state directory');
  assert.match(duplicate.stderr, /already|running|lock|owned/iu);
  assert.equal(starts().length, startedWithoutAdmin, 'rejected daemon must not spawn another DSH');
  assert.equal(existsSync(socketPath(disabledState)), false, 'rejected daemon must not enable IPC on its owner');
  check('IPC defaults off and a second daemon cannot claim its live state or spawn DSH');

  const beforeDefaultPair = connections();
  const defaultDevice = await legacyPair('management-default-ipc-off', disabledState);
  await until(() => connections() > beforeDefaultPair, 'default daemon applying its first enrollment');
  const defaultClient = await openClient(defaultDevice);
  assert.equal((await defaultClient.control.status()).state, 'running');
  const defaultRevoke = await command(['daemon', 'devices', '--revoke', defaultDevice.deviceId], { DSHD_STATE_DIR: disabledState });
  assert.equal(defaultRevoke.code, 0);
  await bounded(defaultClient.carrier.closedDone, 'default-mode live revocation', 5_000);
  defaultClient.control.close();
  assert.equal(existsSync(socketPath(disabledState)), false);
  assert.equal(starts().length, startedWithoutAdmin);
  check('legacy pairing and revocation take effect live while private management IPC remains disabled');
  await stop(disabled);

  phase = 'enabled IPC and machine CLI';
  daemon = start([...daemonArgs, '--local-admin']);
  await until(() => existsSync(socketPath(state)) && daemon.log().includes('relay: Connected'), 'admin-enabled daemon startup');
  const runtimePid = daemon.child.pid;
  const dshStartsBefore = starts().length;
  assert.equal(statSync(join(state, '.runtime')).mode & 0o777, 0o700);
  assert.equal(statSync(socketPath(state)).mode & 0o777, 0o600);
  assert.equal(statSync(socketPath(state)).isSocket(), true);
  const status = await ipc('status');
  assert.ok(status && typeof status === 'object');
  check('opted-in IPC uses an owner-only Unix socket and answers a correlated versioned request');

  for (const [label, input] of [
    ['invalid JSON', '{"broken":\n'],
    ['oversized request', `${JSON.stringify({ ...envelope('status'), padding: 'x'.repeat(65_536) })}\n`],
    ['unknown operation', `${JSON.stringify(envelope('run-arbitrary-command'))}\n`],
    ['unknown protocol version', `${JSON.stringify({ ...envelope('status'), version: 999 })}\n`],
  ]) assertRefused(await rawIpc(input), label);
  await ipc('status');
  check('IPC rejects invalid JSON, oversized packets, unknown operations and unsupported versions without dying');

  mkdirSync(join(prefix, 'etc/dr.dsh'), { recursive: true, mode: 0o700 });
  const configFile = join(prefix, 'etc/dr.dsh/daemon.json');
  const config = {
    version: 1, prefix, scope: 'daemon', source: repo, components: ['daemon'], relay: relayUrl,
    port: dshPort, dsh, dshHome: env.DSH_HOME, workdir: scratch, state, path: env.PATH,
    pluginOwner: 'external', pluginReportsEnabled: false, localAdminEnabled: true,
  };
  writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  await manage('runtime.status');
  const loaded = await manage('config.get');
  assert.ok(JSON.stringify(loaded).includes(relayUrl));
  const changed = await manage('config.set', { pluginReportsEnabled: true });
  assert.equal(changed.restartRequired, true);
  assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).pluginReportsEnabled, true);
  assert.equal(daemon.child.pid, runtimePid);
  assert.equal(starts().length, dshStartsBefore);
  const savedConfig = readFileSync(configFile, 'utf8');
  for (const patch of [{ port: 0 }, { state: join(scratch, 'unapproved-state') }]) {
    const invalid = await command(['daemon', 'manage', '--prefix', prefix], {}, JSON.stringify(envelope('config.set', patch)));
    assert.equal(invalid.code, 1);
    assertRefused(JSON.parse(invalid.stdout), 'invalid configuration patch');
    assert.equal(readFileSync(configFile, 'utf8'), savedConfig);
  }
  assert.equal(statSync(configFile).mode & 0o777, 0o600);
  check('the structured CLI reads and atomically changes the saved config without restarting running processes');

  for (const input of ['{', JSON.stringify(envelope('not-an-operation'))]) {
    const result = await command(['daemon', 'manage', '--prefix', prefix], {}, input);
    assert.equal(result.code, 1);
    assert.equal(result.stdout.trim().split('\n').length, 1);
    assertRefused(JSON.parse(result.stdout), 'machine CLI error');
  }
  check('the structured CLI returns one JSON error and a failing exit status on malformed or unsupported input');

  const selfStop = await command(['daemon', 'manage', '--prefix', prefix], {
    DRDSH_MANAGED_INSTANCE: 'management-smoke-supervised-host',
  }, JSON.stringify(envelope('lifecycle.stop')));
  assert.equal(selfStop.code, 1);
  assert.equal(JSON.parse(selfStop.stdout).error.code, 'requires_external_job');
  assert.equal(starts().length, dshStartsBefore);
  assert.equal(daemon.child.pid, runtimePid);
  check('a management call inherited from supervised DSH refuses to stop its own host before independent jobs exist');

  phase = 'live legacy pairing and existing proxy';
  const beforeFirstPair = connections();
  const first = await legacyPair('management-smoke-first');
  await until(() => connections() > beforeFirstPair, 'daemon applying its first enrollment');
  const active = await openClient(first);
  assert.equal((await active.control.status()).state, 'running');
  await probeDsh(active);
  check('legacy pair enrolls into an already-running daemon and the device immediately opens authenticated DSH');
  const second = await legacyPair('management-smoke-second');
  let listed = await manage('devices.list');
  assert.deepEqual(listed.devices.map(device => device.id).sort(), [first.deviceId, second.deviceId].sort());
  const legacyList = await command(['daemon', 'devices']);
  assert.equal(legacyList.code, 0);
  assert.match(legacyList.stdout, /2 device\(s\):/u);
  assert.ok(legacyList.stdout.includes(first.deviceId) && legacyList.stdout.includes(second.deviceId));
  assert.equal(active.carrier.isClosed(), false, 'adding another device must not terminate an authorized session');
  assert.equal((await active.control.status()).state, 'running');
  check('a second live enrollment preserves both device records and legacy list formatting');
  const stopProxyObservation = await holdProxyConnections(active);

  phase = 'revocation during pending enrollment';
  const thirdPending = await manage('pair.begin', { waitSeconds: 40 });
  assert.equal(thirdPending.state, 'pending');
  assert.ok(thirdPending.pairingId && thirdPending.code);
  const busyPair = await command(['daemon', 'pair', '--relay', relayUrl, '--wait', '1']);
  assert.equal(busyPair.code, 1);
  assert.match(busyPair.stderr, /pending|pairing/iu);
  assert.doesNotMatch(busyPair.stdout, /code:\s+\S+/u, 'an IPC refusal must not silently fall back to an independent pairing');
  const beforeRevocation = connections();
  const revoke = await command(['daemon', 'devices', '--revoke', first.deviceId]);
  assert.equal(revoke.code, 0);
  assert.match(revoke.stdout, new RegExp(`revoked ${first.deviceId}`, 'u'));
  await bounded(active.carrier.closedDone, 'revocation closing the authenticated live session', 5_000);
  active.control.close();
  await until(() => {
    const observed = proxyState();
    return observed.httpOpen === 0 && observed.wsOpen === 0 && observed.httpClosed === 1 && observed.wsClosed === 1;
  }, 'revocation reclaiming the actual pending HTTP and WebSocket sockets', 5_000);
  stopProxyObservation();
  await until(() => connections() > beforeRevocation, 'daemon carrier after revocation');
  const beforeThirdPair = connections();
  const third = await pairWithCode({ connect, report: () => {} }, {
    code: thirdPending.code, deviceName: 'management-smoke-third', timeoutMs: 10_000,
  });
  let pairStatus;
  await until(async () => {
    pairStatus = await manage('pair.status', { pairingId: thirdPending.pairingId });
    return pairStatus.state !== 'pending';
  }, 'managed pairing completion');
  listed = await manage('devices.list');
  assert.deepEqual(listed.devices.map(device => device.id).sort(), [second.deviceId, third.deviceId].sort());
  await until(() => connections() > beforeThirdPair, 'daemon applying the third enrollment');
  check('legacy revoke closes its live session and held HTTP/WS sockets; an in-flight enrollment cannot resurrect the device');

  phase = 'revoked device cannot reconnect';
  const rejectedCarrier = await connect(first.room);
  const beforeRejected = connections();
  await assert.rejects(bounded(Tunnel.open(rejectedCarrier, first.roomKey, {
    deviceId: first.deviceId, room: first.room, key: first.device.keyPair,
  }), 'revoked device rejection', 10_000, () => rejectedCarrier.close()), error => {
    assert.doesNotMatch(error.message, /timed out/iu, 'revoked credentials need an explicit refusal, not a silent timeout');
    assert.match(error.message, /paired|device|revoked|配对|设备/iu);
    return true;
  });
  rejectedCarrier.close();
  await bounded(rejectedCarrier.closedDone, 'rejected client close');
  await until(() => connections() > beforeRejected, 'daemon carrier after rejected device');
  const survivor = await openClient(second);
  assert.equal((await survivor.control.status()).state, 'running');
  await probeDsh(survivor);
  await closeClient(survivor);
  await manage('devices.revoke', { deviceId: third.deviceId });
  listed = await manage('devices.list');
  assert.deepEqual(listed.devices.map(device => device.id), [second.deviceId]);
  assert.equal(daemon.child.pid, runtimePid);
  assert.equal(starts().length, dshStartsBefore);
  check('revoked credentials are refused on reconnect, the other device remains usable, and neither daemon nor DSH restarted');

  phase = 'managed pairing cancellation';
  const cancelled = await manage('pair.begin', { waitSeconds: 40 });
  await manage('pair.cancel', { pairingId: cancelled.pairingId });
  const cancelledStatus = await manage('pair.status', { pairingId: cancelled.pairingId });
  assert.equal(cancelledStatus.state, 'cancelled');
  assert.deepEqual((await manage('devices.list')).devices.map(device => device.id), [second.deviceId]);
  check('pair cancellation is observable and does not change existing devices');

  phase = 'abnormal exit recovery';
  const keyBefore = readFileSync(join(state, 'room-key'), 'utf8');
  kill(daemon.child);
  await exited(daemon);
  daemon = start([...daemonArgs, '--local-admin']);
  await until(() => daemon.log().includes('relay: Connected') && existsSync(socketPath(state)), 'daemon recovering stale IPC after SIGKILL');
  assert.equal(readFileSync(join(state, 'room-key'), 'utf8'), keyBefore);
  assert.deepEqual((await ipc('devices.list')).devices.map(device => device.id), [second.deviceId]);
  const restored = await openClient(second);
  assert.equal((await restored.control.status()).state, 'running');
  await closeClient(restored);
  check('a killed daemon releases state ownership; restart replaces stale IPC and preserves the room key and surviving device');
  await stop(daemon);
  assert.equal(existsSync(socketPath(state)), false, 'graceful shutdown must remove its IPC socket');
  check('graceful shutdown removes the private IPC endpoint');

  phase = 'paired registry deletion fails closed across restart';
  const startsBeforeMissingRegistry = starts().length;
  assert.equal(readFileSync(join(state, 'devices-required'), 'utf8'), '1\n');
  assert.equal(statSync(join(state, 'devices-required')).mode & 0o777, 0o600);
  // Disposable sockets/locks must not carry the evidence that device auth is required.
  rmSync(join(state, '.runtime'), { recursive: true, force: true });
  rmSync(join(state, 'devices.json'));
  const missingRegistry = await command([...daemonArgs, '--local-admin']);
  assert.equal(missingRegistry.code, 1);
  assert.match(missingRegistry.stderr, /registry|paired|enrolled|device/iu);
  assert.equal(starts().length, startsBeforeMissingRegistry, 'damaged pairing state must fail before starting DSH');
  assert.equal(existsSync(socketPath(state)), false);
  assert.equal(readFileSync(join(state, 'room-key'), 'utf8'), keyBefore);
  check('deleting a previously paired registry cannot turn a restarted daemon into room-key-only access');
  console.log(`Passed ${checks} daemon management smoke checks.`);
} catch (error) {
  console.error(`FAIL during ${phase}: ${error.stack ?? error}`);
  if (existsSync(join(scratch, 'proxy-state.json'))) console.error(`DSH proxy counters: ${JSON.stringify(proxyState())}`);
  // Pairing codes and fixture authentication URLs are unnecessary in failure output.
  const redact = text => text.replace(/(code:\s*)\S+/gu, '$1[redacted]')
    .replace(/([?&]token=)[^\s]+/gu, '$1[redacted]');
  if (daemon) console.error(redact(daemon.log()).split('\n').slice(-18).join('\n'));
  process.exitCode = 1;
} finally {
  cleanup();
}
