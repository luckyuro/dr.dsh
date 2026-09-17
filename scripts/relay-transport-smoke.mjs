/**
 * Real daemon processes dial WS and WSS through a real relay. TLS terminates in a
 * temporary local proxy, with a private test CA supplied only to child processes.
 * No DSH installation, system trust changes, or external endpoint is needed.
 *
 * Usage: node scripts/relay-transport-smoke.mjs [path/to/drdsh]
 * Requires Node, openssl and a built native CLI. Exit: 0 pass, 1 fail, 2 unavailable.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as httpServer } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createServer as tlsServer } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { ControlClient } from '../apps/pwa/src/control.ts';
import { Tunnel } from '../apps/pwa/src/tunnel.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = resolve(process.argv[2] ?? join(repo, 'target/debug/drdsh'));
if (!existsSync(binary)) {
  console.error('Build dr-dsh-cli before running the WS/WSS smoke test.');
  process.exit(2);
}
try { execFileSync('openssl', ['version'], { stdio: 'pipe' }); }
catch { console.error('Install openssl to generate temporary test certificates.'); process.exit(2); }

const scratch = mkdtempSync(join(tmpdir(), 'drdsh-relay-transport-'));
const children = new Set();
const sockets = new Set();
const servers = [];
let checks = 0;
let stateCounter = 0;
const check = name => console.log(`ok ${++checks} - ${name}`);
const certFile = name => join(scratch, name);
const openssl = args => execFileSync('openssl', args, { cwd: scratch, stdio: 'pipe', timeout: 15_000 });

function start(args, overrides = {}) {
  const state = join(scratch, `state-${++stateCounter}`);
  const child = spawn(binary, args, { cwd: scratch, env: {
    ...process.env, DSHD_STATE_DIR: state,
    SSL_CERT_FILE: certFile('ca.pem'), SSL_CERT_DIR: certFile('empty-roots'), ...overrides,
  } });
  const running = { child, state, output: '', done: null, result: undefined };
  children.add(running);
  child.stdout.on('data', chunk => { running.output += chunk; });
  child.stderr.on('data', chunk => { running.output += chunk; });
  running.done = new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { running.result = { code, signal }; accept(running.result); });
  });
  // A spawn failure must remain observable without becoming an unhandled rejection during polling.
  running.done.catch(() => {});
  return running;
}

async function stop(running) {
  if (running.result === undefined) running.child.kill('SIGTERM');
  const timer = setTimeout(() => running.child.kill('SIGKILL'), 3000);
  try { await running.done; } finally { clearTimeout(timer); children.delete(running); }
}

async function bounded(promise, label, timeout = 12_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

async function waitFor(predicate, label) {
  for (let i = 0; i < 120; i += 1) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}

async function listen(server) {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function track(socket) {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
  return socket;
}

async function controlRoundTrip(relayUrl, plainUrl, attachPort, roots) {
  const daemon = start(['daemon', 'run', '--relay', relayUrl, '--attach', String(attachPort)], roots);
  let socket;
  let tunnel;
  let control;
  try {
    await waitFor(() => /relay: Connected/.test(daemon.output), `${relayUrl} daemon registration`);
    const root = new Uint8Array(Buffer.from(readFileSync(join(daemon.state, 'room-key'), 'utf8').trim(), 'base64url'));
    const room = await Tunnel.roomFor(root);
    // The independent PWA implementation exercises the encrypted carrier after TLS negotiation.
    socket = new WebSocket(`${plainUrl}/ws/client`);
    socket.binaryType = 'arraybuffer';
    const received = [], closed = [];
    const ready = new Promise((accept, reject) => {
      socket.onopen = () => socket.send(JSON.stringify({ role: 'client', room, proto: [0, 1] }));
      socket.onerror = () => reject(new Error('PWA client could not connect to the relay.'));
      socket.onmessage = event => {
        if (typeof event.data === 'string') {
          const reply = JSON.parse(event.data);
          if (reply.type === 'ready') accept();
          else reject(new Error(`Relay refused the PWA client: ${reply.type}`));
        } else {
          for (const receive of received) receive(new Uint8Array(event.data));
        }
      };
      socket.onclose = () => { for (const close of closed) close('relay closed'); };
    });
    await bounded(ready, 'PWA registration');
    tunnel = await bounded(Tunnel.open({
      send: bytes => socket.send(bytes), receive: fn => received.push(fn),
      closed: fn => closed.push(fn), close: () => socket.close(),
    }, root), 'encrypted tunnel');
    control = new ControlClient(tunnel);
    const status = await bounded(control.status(), 'encrypted status reply');
    assert.equal(status.owned, false);
    assert.equal(status.relay, 'connected');
    assert.deepEqual(status.protocol, [0, 1]);
  } finally {
    control?.close();
    tunnel?.close();
    socket?.close();
    await stop(daemon);
  }
}

try {
  mkdirSync(certFile('empty-roots'));
  writeFileSync(certFile('ca.cnf'), '[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=dr.dsh test CA\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
  openssl(['req', '-new', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', 'ca.cnf', '-keyout', 'ca.key', '-out', 'ca.pem']);
  openssl(['req', '-new', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', 'ca.cnf', '-keyout', 'other-ca.key', '-out', 'other-ca.pem']);
  openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', 'server.key', '-out', 'server.csr']);
  writeFileSync(certFile('server.ext'), 'subjectAltName=DNS:localhost\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
  openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1', '-extfile', 'server.ext', '-out', 'server.pem']);

  const reservation = httpServer();
  const relayPort = await listen(reservation);
  await new Promise(accept => reservation.close(accept));
  servers.pop();
  const relay = start(['relay', 'run', '--bind', `127.0.0.1:${relayPort}`]);
  const plainUrl = `ws://127.0.0.1:${relayPort}`;
  const roomCount = async () => (await (await fetch(`http://127.0.0.1:${relayPort}/healthz`)).json()).rooms;
  await waitFor(async () => {
    try { return await roomCount() === 0; } catch { return false; }
  }, 'relay startup');
  const proxy = tlsServer({ key: readFileSync(certFile('server.key')), cert: readFileSync(certFile('server.pem')) }, socket => {
    track(socket);
    const upstream = track(connect(relayPort, '127.0.0.1'));
    socket.on('error', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
    socket.pipe(upstream).pipe(socket);
  });
  proxy.on('tlsClientError', () => {});
  const tlsPort = await listen(proxy);
  const secureUrl = `wss://localhost:${tlsPort}`;
  const attachPort = await listen(httpServer((_, response) => response.end('DSH health fixture')));

  await controlRoundTrip(plainUrl, plainUrl, attachPort, { SSL_CERT_FILE: certFile('missing.pem') });
  check('ws:// carries encrypted control traffic without needing TLS roots');
  await controlRoundTrip(secureUrl, plainUrl, attachPort);
  check('wss:// carries encrypted control traffic with a trusted certificate');
  await waitFor(async () => await roomCount() === 0, 'previous rooms to close');

  const pairing = start(['daemon', 'pair', '--relay', secureUrl, '--wait', '15']);
  await waitFor(async () => /code:\s+\S+/.test(pairing.output) && await roomCount() === 1, 'WSS pairing registration');
  const code = /code:\s+(\S+)/.exec(pairing.output)[1];
  const device = start(['daemon', 'pair-as-device', '--relay', secureUrl, '--code', code, '--name', 'transport smoke', '--out', certFile('device.json')]);
  assert.equal((await bounded(device.done, 'device pairing')).code, 0, 'WSS device pairing failed');
  assert.equal((await bounded(pairing.done, 'daemon pairing')).code, 0, 'WSS daemon pairing failed');
  const enrolled = JSON.parse(readFileSync(certFile('device.json'), 'utf8'));
  assert.deepEqual(Buffer.from(enrolled.root_key), Buffer.from(readFileSync(join(pairing.state, 'room-key'), 'utf8').trim(), 'base64url'), 'WSS pairing returned a different room key');
  check('both pairing processes use WSS and receive the same room key');

  for (const [label, url, roots, pattern] of [
    ['an untrusted certificate', secureUrl, certFile('other-ca.pem'), /UnknownIssuer|BadSignature|invalid peer certificate/i],
    ['a certificate for a different hostname', `wss://127.0.0.1:${tlsPort}`, certFile('ca.pem'), /NotValidForName|not valid for name/i],
  ]) {
    const rejected = start(['daemon', 'pair', '--relay', url, '--wait', '2'], { SSL_CERT_FILE: roots });
    assert.equal((await bounded(rejected.done, label)).code, 1, `${label} must fail`);
    assert.match(rejected.output, pattern, `${label} must fail during certificate verification`);
    check(`WSS rejects ${label}`);
  }
  console.log(`Passed ${checks} WS/WSS transport checks.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  const stopped = await Promise.allSettled([...children].map(stop));
  if (stopped.some(result => result.status === 'rejected')) {
    console.error('A test process failed to start or stop cleanly.');
    process.exitCode = 1;
  }
  for (const socket of sockets) socket.destroy();
  for (const server of servers) {
    server.closeAllConnections?.();
    await new Promise(accept => server.close(accept));
  }
  rmSync(scratch, { recursive: true, force: true });
}
