/**
 * A real relay process, real WebSockets and a bounded TCP gate that stops a receiver reading.
 * Opaque carrier payloads deliberately exceed the forwarding queue and OS socket buffers.
 * Checks both directions, unrelated-room progress, byte/order integrity and stalled-peer cleanup.
 *
 * Usage: node scripts/relay-backpressure-smoke.mjs [--drdsh-relay target/debug/drdsh-relay]
 *        --drdsh <unified CLI path> may be used instead. Exit codes: 0 pass, 1 fail, 2 prerequisite.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { resolve } from 'node:path';
import { Transform } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { decodeFrame, encodeFrame, FrameType, MAX_PAYLOAD_LEN } from '../packages/protocol/src/index.ts';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1]) throw new Error(`${name} requires a binary path`);
  return args[index + 1];
};
const unified = option('--drdsh', null);
const binary = resolve(unified ?? option('--drdsh-relay', 'target/debug/drdsh-relay'));
if (!existsSync(binary)) {
  console.error('Build the relay first with cargo build -p dr-dsh-relay.');
  process.exit(2);
}
const sockets = new Set();
const proxies = new Set();
const FRAMES = 512;
let checks = 0;
let relay;
const check = label => console.log(`ok ${++checks} - ${label}`);
function cleanup() {
  for (const socket of sockets) socket.close();
  for (const proxy of proxies) proxy.close();
  relay?.kill('SIGKILL');
}
process.once('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => process.exit(1));
const deadline = setTimeout(() => { console.error('Backpressure smoke exceeded 90 seconds.'); process.exit(1); }, 90_000);
async function until(condition, label, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await condition()) return; await delay(20); }
  throw new Error(`Timed out waiting for ${label}`);
}
async function freePort() {
  const server = createServer();
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  const port = server.address().port;
  await new Promise(accept => server.close(accept));
  return port;
}

/** Backpressure reaches the actual relay socket; delaying onmessage would only buffer in Node. */
async function receiverGate(port) {
  let held = false;
  const links = new Set();
  const channels = new Set();
  const server = createServer(socket => {
    const upstream = connect(port, '127.0.0.1');
    let pending;
    const slow = new Transform({
      highWaterMark: 64 * 1024,
      transform(chunk, _encoding, done) {
        const deliver = () => setTimeout(() => done(null, chunk), 2);
        if (held) pending = deliver;
        else deliver();
      },
    });
    const link = { resume() { const next = pending; pending = undefined; next?.(); } };
    links.add(link);
    channels.add(socket); channels.add(upstream);
    const close = () => { socket.destroy(); upstream.destroy(); slow.destroy(); links.delete(link); };
    socket.on('error', close); upstream.on('error', close);
    socket.on('close', close); upstream.on('close', close);
    socket.pipe(upstream);
    upstream.pipe(slow).pipe(socket);
  });
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  const proxy = {
    port: server.address().port,
    hold() { held = true; },
    resume() { held = false; for (const link of links) link.resume(); },
    close() { for (const channel of channels) channel.destroy(); server.close(); },
  };
  proxies.add(proxy);
  return proxy;
}
async function park(port, role, room) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/${role}`);
  socket.binaryType = 'arraybuffer';
  sockets.add(socket);
  let reason = '';
  socket.addEventListener('message', event => {
    if (typeof event.data === 'string') {
      const value = JSON.parse(event.data);
      if (value.type === 'close') reason = value.reason;
    }
  });
  const closed = new Promise(accept => socket.addEventListener('close', accept, { once: true }));
  await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error('relay handshake timed out')), 5000);
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('relay socket failed')); }, { once: true });
    socket.addEventListener('open', () => socket.send(JSON.stringify({ role, room, proto: [0, 1] })), { once: true });
    socket.addEventListener('message', event => {
      clearTimeout(timer);
      if (typeof event.data === 'string' && JSON.parse(event.data).type === 'ready') accept();
      else reject(new Error('relay refused the test room'));
    }, { once: true });
  });
  return { socket, closed, reason: () => reason };
}
function carrier(index, length = MAX_PAYLOAD_LEN) {
  const payload = new Uint8Array(length).fill(index % 251);
  new DataView(payload.buffer).setUint32(0, index, false);
  return encodeFrame({ version: [0, 1], frameType: FrameType.Data, flags: 0, streamId: 1, payload });
}
function receive(peer, count) {
  const hash = createHash('sha256');
  let seen = 0;
  let accept, reject;
  const done = new Promise((resolve_, reject_) => { accept = resolve_; reject = reject_; });
  done.catch(() => {});
  const message = event => {
    if (typeof event.data === 'string') return;
    try {
      const bytes = new Uint8Array(event.data);
      const decoded = decodeFrame(bytes);
      assert.ok(decoded && decoded.consumed === bytes.length, 'relay returned an incomplete carrier frame');
      const { frame } = decoded;
      assert.equal(new DataView(frame.payload.buffer, frame.payload.byteOffset).getUint32(0, false), seen,
        'relay dropped or reordered an opaque carrier frame');
      hash.update(bytes);
      seen += 1;
      if (seen === count) { peer.socket.removeEventListener('message', message); accept(hash.digest('hex')); }
    } catch (error) { reject(error); }
  };
  peer.socket.addEventListener('message', message);
  peer.closed.then(() => { if (seen < count) reject(new Error('relay closed before the full payload arrived')); });
  return done;
}
function send(peer, count) {
  let sent = 0;
  const hash = createHash('sha256');
  const done = (async () => {
    for (let index = 0; index < count; index += 1) {
      // The probe is bounded too: native WebSocket.send does not await TCP capacity.
      while (peer.socket.bufferedAmount > 512 * 1024) {
        if (peer.socket.readyState !== WebSocket.OPEN) throw new Error('sender was closed');
        await delay(1);
      }
      if (peer.socket.readyState !== WebSocket.OPEN) throw new Error('sender was closed');
      const bytes = carrier(index);
      hash.update(bytes); peer.socket.send(bytes); sent += 1;
      if (index % 8 === 0) await delay(0);
    }
    return hash.digest('hex');
  })();
  done.catch(() => {});
  return { done, sent: () => sent };
}

try {
  const port = await freePort();
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DSH_RELAY_|DRDSH_)/u.test(key)));
  const env = { ...inherited, DSH_RELAY_BIND: `127.0.0.1:${port}`, DSH_RELAY_KEEPALIVE_SECS: '0', RUST_LOG: 'info' };
  delete env.DSH_RELAY_TLS_CERT; delete env.DSH_RELAY_TLS_KEY;
  relay = spawn(binary, unified ? ['__runtime', 'relay', 'run'] : [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  relay.stdout.on('data', bytes => { log += bytes; });
  relay.stderr.on('data', bytes => { log += bytes; });
  relay.on('error', () => {});
  await until(() => log.includes('listening on'), 'relay startup');
  for (const slowRole of ['client', 'daemon']) {
    const gate = await receiverGate(port);
    const room = `backpressure-${slowRole}`;
    const daemon = await park(slowRole === 'daemon' ? gate.port : port, 'daemon', room);
    const client = await park(slowRole === 'client' ? gate.port : port, 'client', room);
    const target = slowRole === 'client' ? client : daemon;
    const source = slowRole === 'client' ? daemon : client;
    const incoming = receive(target, FRAMES);
    gate.hold();
    const outgoing = send(source, FRAMES);
    await delay(700);
    assert.ok(outgoing.sent() < FRAMES, 'a paused receiver must backpressure the sender instead of dropping frames');
    check(`${slowRole} stops reading and the sender waits with bounded buffering`);

    const otherDaemon = await park(port, 'daemon', `independent-${slowRole}`);
    const otherClient = await park(port, 'client', `independent-${slowRole}`);
    const otherFrame = receive(otherClient, 1);
    otherDaemon.socket.send(carrier(0, 32));
    const otherTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error('a blocked room held the relay hub lock')), 2000));
    await Promise.race([otherFrame, otherTimeout]);
    otherClient.socket.close(); otherDaemon.socket.close();
    check(`an unrelated room still routes while the ${slowRole} is paused`);

    gate.resume();
    const [expected, actual] = await Promise.all([outgoing.done, incoming]);
    assert.equal(actual, expected, 'forwarded bytes changed');
    check(`32 MiB toward the ${slowRole} arrives in order with an identical digest`);
    client.socket.close(); daemon.socket.close();
    try {
      await until(() => client.socket.readyState === WebSocket.CLOSED && daemon.socket.readyState === WebSocket.CLOSED,
        `completed ${slowRole} sockets to close (client/daemon)`, 5000);
    } catch (error) {
      console.error(`Socket states: client=${client.socket.readyState}, daemon=${daemon.socket.readyState}`);
      console.error(log);
      throw error;
    }
    gate.close();
  }

  const gate = await receiverGate(port);
  const daemon = await park(port, 'daemon', 'never-reads');
  const client = await park(gate.port, 'client', 'never-reads');
  gate.hold();
  const started = Date.now();
  const stalled = send(daemon, FRAMES);
  await until(() => daemon.socket.readyState === WebSocket.CLOSED, '30-second forwarding stall termination', 38_000);
  assert.ok(Date.now() - started >= 25_000, 'a full queue must wait before declaring a stalled peer');
  assert.ok(daemon.reason().includes('30 seconds without forwarding progress'), 'the close must explain the forwarding stall');
  await stalled.done.catch(() => {});
  gate.resume();
  client.socket.close();
  await client.closed;
  gate.close();
  await until(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    return (await response.json()).rooms === 0;
  }, 'all stalled and completed rooms to be released');
  check('a permanently stalled receiver is closed with a reason and its room is reclaimed');
  console.log(`Relay backpressure smoke passed (${checks} checks).`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Relay backpressure smoke failed.');
  process.exitCode = 1;
} finally { clearTimeout(deadline); cleanup(); }
