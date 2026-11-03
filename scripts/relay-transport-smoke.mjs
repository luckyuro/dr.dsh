/**
 * Real daemon processes dial WS and WSS through native TLS and a reverse proxy.
 * Also checks HTTPS DSH and plugin clients, with a private CA scoped to tests.
 * No DSH installation, system trust changes, or external endpoint is needed.
 *
 * Usage: node scripts/relay-transport-smoke.mjs [path/to/drdsh]
 * Requires Node, openssl, built PWA and native CLI. Exit: 0 pass, 1 fail, 2 unavailable.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as httpServer } from 'node:http';
import { get as httpsGet, createServer as httpsServer } from 'node:https';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createServer as tlsServer } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { ControlClient } from '../apps/pwa/src/control.ts';
import { Tunnel } from '../apps/pwa/src/tunnel.ts';
import { request, encodeRequest } from '../apps/pwa/src/proxy.ts';
import { tunneledWebSocket } from '../apps/pwa/src/websocket.ts';
import { Reporter } from '../plugins/dr.dsh/src/reporter.ts';

// Node reads extra CAs at process startup. Keep test trust scoped to this child,
// so the browser-compatible WebSocket/fetch clients validate certificates too.
if (process.argv[2] === '--probe-client') {
  try {
    const root = new Uint8Array(Buffer.from(readFileSync(process.argv[4], 'utf8').trim(), 'base64url'));
    await probeClient(process.argv[3], root, process.argv[5] === 'proxy');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
} else if (process.argv[2] === '--probe-report') {
  const handlers = new Map();
  const reporter = new Reporter({ daemonUrl: process.argv[3], daemonToken: 'x'.repeat(43), report: ['approval_requested'] });
  reporter.start({ on: (event, callback) => { handlers.set(event, callback); return () => {}; } });
  handlers.get('approval/request')('tls-test-session');
  await waitFor(() => reporter.stats().delivered + reporter.stats().dropped === 1, 'HTTPS plugin report');
  assert.equal(reporter.stats().delivered, Number(process.argv[4]));
} else {

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceBinary = resolve(process.argv[2] ?? join(repo, 'target/debug/drdsh'));
if (!existsSync(sourceBinary) || !existsSync(join(repo, 'apps/pwa/dist/shell.js'))) {
  console.error('Build dr-dsh-cli and @dr.dsh/pwa before running the TLS smoke test.');
  process.exit(2);
}
try { execFileSync('openssl', ['version'], { stdio: 'pipe' }); }
catch { console.error('Install openssl to generate temporary test certificates.'); process.exit(2); }

const scratch = mkdtempSync(join(tmpdir(), 'drdsh-relay-transport-'));
// Keep the real CLI flag parser while making saved production settings unreachable.
// __runtime would skip the --insecure/--ca-cert parsing this probe must exercise.
mkdirSync(join(scratch, 'bin'));
const binary = join(scratch, 'bin', 'drdsh');
copyFileSync(sourceBinary, binary);
writeFileSync(join(scratch, 'prefix.json'), JSON.stringify({ prefix: join(scratch, 'prefix') }));
const baseEnv = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !/^(DSHD_|DRDSH_|DSH_RELAY_|DSH_HOME$|FAKE_DSH_)/u.test(key)));
const children = new Set();
const sockets = new Set();
const servers = [];
let checks = 0;
let stateCounter = 0;
const check = name => console.log(`ok ${++checks} - ${name}`);
const certFile = name => join(scratch, name);
const openssl = args => execFileSync('openssl', args, { cwd: scratch, stdio: 'pipe', timeout: 15_000 });

function start(args, overrides = {}, executable = binary) {
  const state = join(scratch, `state-${++stateCounter}`);
  const env = {
    ...baseEnv, DSHD_STATE_DIR: state, DSH_HOME: join(state, 'dsh-home'), DRDSH_TLS_INSECURE: '0',
    SSL_CERT_FILE: certFile('ca.pem'), SSL_CERT_DIR: certFile('empty-roots'),
  };
  delete env.DRDSH_CA_CERT;
  const child = spawn(executable, args, { cwd: scratch, env: { ...env, ...overrides } });
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

async function proxyPort(relayPort, certificate = 'server.pem', version) {
  const proxy = tlsServer({
    key: readFileSync(certFile('server.key')), cert: readFileSync(certFile(certificate)),
    minVersion: version, maxVersion: version,
  }, socket => {
    track(socket);
    const upstream = track(connect(relayPort, '127.0.0.1'));
    socket.on('error', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
    socket.pipe(upstream).pipe(socket);
  });
  proxy.on('tlsClientError', () => {});
  return listen(proxy);
}

async function controlRoundTrip(relayUrl, clientUrl, attachPort, roots, extraArgs = [], proxy = false) {
  const daemon = start(['daemon', 'run', '--relay', relayUrl, '--attach', String(attachPort), ...extraArgs], roots);
  try {
    await waitFor(() => /relay: Connected/.test(daemon.output), `${relayUrl} daemon registration`);
    const rootFile = join(daemon.state, 'room-key');
    if (clientUrl.startsWith('wss:')) {
      await nodeProbe(['--probe-client', clientUrl, rootFile, proxy ? 'proxy' : 'control']);
    } else {
      const root = new Uint8Array(Buffer.from(readFileSync(rootFile, 'utf8').trim(), 'base64url'));
      await probeClient(clientUrl, root, proxy);
    }
  } finally { await stop(daemon); }
}

async function nodeProbe(args, ca = 'ca.pem') {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: certFile(ca) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  try {
    assert.equal((await bounded(once(child, 'exit'), 'TLS Node client'))[0], 0, output);
  } finally { child.kill('SIGKILL'); }
}

function httpsResponse(port, path = '/healthz', options = {}) {
  return new Promise((accept, reject) => {
    const req = httpsGet({ hostname: '127.0.0.1', port, path, servername: 'localhost', ca: readFileSync(certFile('ca.pem')), timeout: 2000, ...options }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => accept({ status: response.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('HTTPS health timed out')));
  });
}

async function unusedPort() {
  const reservation = httpServer();
  const port = await listen(reservation);
  await new Promise(accept => reservation.close(accept));
  servers.pop();
  return port;
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
  const tlsPort = await proxyPort(relayPort);
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

  const noRoots = { SSL_CERT_FILE: certFile('missing.pem'), DRDSH_CA_CERT: certFile('missing.pem') };
  await controlRoundTrip(`wss://127.0.0.1:${tlsPort}`, plainUrl, attachPort, noRoots, ['--insecure']);
  check('--insecure carries WSS control traffic with an untrusted, mismatched certificate and no CA files');
  const insecurePair = start(['daemon', 'pair', '--relay', `wss://127.0.0.1:${tlsPort}`, '--insecure', '--wait', '15'], noRoots);
  await waitFor(() => /code:\s+\S+/.test(insecurePair.output), 'insecure WSS pairing code');
  const insecureCode = /code:\s+(\S+)/.exec(insecurePair.output)[1];
  const insecureDevice = start(['daemon', 'pair-as-device', '--relay', `wss://127.0.0.1:${tlsPort}`,
    '--code', insecureCode, '--name', 'explicit insecure', '--out', certFile('insecure-device.json')], { ...noRoots, DRDSH_TLS_INSECURE: '1' });
  assert.equal((await bounded(insecureDevice.done, 'insecure device pairing')).code, 0, insecureDevice.output);
  assert.equal((await bounded(insecurePair.done, 'insecure daemon pairing')).code, 0, insecurePair.output);
  const insecureEnrollment = JSON.parse(readFileSync(certFile('insecure-device.json'), 'utf8'));
  assert.deepEqual(Buffer.from(insecureEnrollment.root_key), Buffer.from(readFileSync(join(insecurePair.state, 'room-key'), 'utf8').trim(), 'base64url'));
  check('both WSS pairing roles support explicit CLI/environment opt-out and preserve the paired key');

  const restored = start(['daemon', 'pair', '--relay', secureUrl, '--wait', '2', '--no-insecure'], {
    SSL_CERT_FILE: certFile('other-ca.pem'), DRDSH_TLS_INSECURE: '1',
  });
  assert.equal((await bounded(restored.done, 'restored certificate verification')).code, 1);
  assert.match(restored.output, /UnknownIssuer|BadSignature|invalid peer certificate/i);
  for (const [args, env, pattern] of [
    [['--insecure', '--no-insecure'], {}, /cannot be used together/],
    [['--insecure', '--insecure'], {}, /once/],
    [[], { DRDSH_TLS_INSECURE: 'yes' }, /Invalid DRDSH_TLS_INSECURE/],
  ]) {
    const invalid = start(['daemon', 'pair', '--relay', secureUrl, '--wait', '2', ...args], env);
    assert.equal((await bounded(invalid.done, 'invalid verification options')).code, 1);
    assert.match(invalid.output, pattern);
  }
  check('--no-insecure overrides the environment; conflicting flags and invalid environment values fail');

  writeFileSync(certFile('self.cnf'), '[req]\ndistinguished_name=dn\nx509_extensions=leaf\nprompt=no\n[dn]\nCN=localhost\n[leaf]\n' + readFileSync(certFile('server.ext'), 'utf8'));
  openssl(['req', '-new', '-x509', '-key', 'server.key', '-days', '1', '-config', 'self.cnf', '-out', 'self.pem']);
  writeFileSync(certFile('ca-index.txt'), '');
  writeFileSync(certFile('ca-serial.txt'), '10\n');
  writeFileSync(certFile('sign.cnf'), '[ca]\ndefault_ca=local\n[local]\ndatabase=ca-index.txt\nserial=ca-serial.txt\nnew_certs_dir=.\nprivate_key=ca.key\ncertificate=ca.pem\ndefault_md=sha256\npolicy=policy\nx509_extensions=leaf\n[policy]\ncommonName=supplied\n[leaf]\n' + readFileSync(certFile('server.ext'), 'utf8'));
  openssl(['ca', '-batch', '-config', 'sign.cnf', '-startdate', '20000101000000Z', '-enddate', '20000102000000Z',
    '-in', 'server.csr', '-out', 'expired.pem', '-notext']);
  for (const [certificate, version, pattern] of [
    ['self.pem', 'TLSv1.3', /UnknownIssuer|BadSignature|invalid peer certificate/i],
    ['expired.pem', 'TLSv1.2', /expired/i],
  ]) {
    const url = `wss://localhost:${await proxyPort(relayPort, certificate, version)}`;
    const strict = start(['daemon', 'pair', '--relay', url, '--wait', '2']);
    assert.equal((await bounded(strict.done, `${certificate} strict verification`)).code, 1);
    assert.match(strict.output, pattern);
    await controlRoundTrip(url, plainUrl, attachPort, noRoots, ['--insecure']);
    check(`${version} rejects ${certificate} by default and connects with --insecure`);
  }

  const nativePort = await unusedPort();
  const nativeUrl = `wss://localhost:${nativePort}`;
  const native = start(['relay', 'run', '--bind', `127.0.0.1:${nativePort}`,
    '--client-dir', join(repo, 'apps/pwa/dist'), '--tls-cert', certFile('server.pem'), '--tls-key', certFile('server.key')]);
  await waitFor(async () => {
    if (native.result) throw new Error(`Native relay failed: ${native.output}`);
    try { return (await httpsResponse(nativePort)).status === 200; } catch { return false; }
  }, 'native HTTPS relay');
  for (const version of ['TLSv1.2', 'TLSv1.3']) {
    assert.equal((await httpsResponse(nativePort, '/healthz', { minVersion: version, maxVersion: version })).status, 200);
  }
  assert.match((await httpsResponse(nativePort, '/')).body, /dr\.dsh/);
  assert.equal((await httpsResponse(nativePort, '/client/shell.js')).status, 200);
  check('native relay serves health, PWA and modules over TLS 1.2 and 1.3');
  const stalled = track(connect(nativePort, '127.0.0.1'));
  await once(stalled, 'connect');
  assert.equal((await httpsResponse(nativePort)).status, 200);
  stalled.destroy();
  await assert.rejects(fetch(`http://127.0.0.1:${nativePort}/healthz`, { signal: AbortSignal.timeout(2000) }));
  check('a stalled handshake does not block HTTPS and the TLS port never falls back to plaintext');
  for (const extraArgs of [
    ['--tls-cert', certFile('server.pem')],
    ['--tls-cert', certFile('server.pem'), '--tls-key', certFile('other-ca.key')],
    ['--tls-cert', certFile('ca.cnf'), '--tls-key', certFile('server.key')],
  ]) {
    const invalid = start(['relay', 'run', '--bind', `127.0.0.1:${await unusedPort()}`, ...extraArgs]);
    assert.equal((await bounded(invalid.done, 'invalid TLS configuration')).code, 1);
    assert.match(invalid.output, /TLS/);
  }
  check('partial, mismatched and malformed TLS credentials refuse startup');
  const rawBinary = join(dirname(sourceBinary), 'drdsh-relay');
  if (existsSync(rawBinary)) {
    const raw = start(['--tls-cert', certFile('server.pem'), '--tls-key', certFile('server.key')], {}, rawBinary);
    assert.equal((await bounded(raw.done, 'raw relay TLS refusal')).code, 1);
    assert.match(raw.output, /No plaintext listener was started/);
    check('the raw development relay refuses TLS flags instead of silently starting plaintext');
  }

  await controlRoundTrip(nativeUrl, nativeUrl, attachPort, { SSL_CERT_FILE: certFile('other-ca.pem') }, ['--ca-cert', certFile('ca.pem')]);
  check('native WSS carries encrypted control traffic on both ends with an explicitly supplied CA');
  const nativePair = start(['daemon', 'pair', '--relay', nativeUrl, '--wait', '15']);
  await waitFor(() => /code:\s+\S+/.test(nativePair.output), 'native WSS pairing code');
  const nativeCode = /code:\s+(\S+)/.exec(nativePair.output)[1];
  const nativeDevice = start(['daemon', 'pair-as-device', '--relay', nativeUrl, '--code', nativeCode,
    '--name', 'native TLS', '--out', certFile('native-device.json'), '--ca-cert', certFile('ca.pem')], { SSL_CERT_FILE: certFile('other-ca.pem') });
  assert.equal((await bounded(nativeDevice.done, 'native WSS device pairing')).code, 0);
  assert.equal((await bounded(nativePair.done, 'native WSS pairing')).code, 0);
  check('native TLS listener supports both pairing roles');

  execFileSync('sh', [join(repo, 'scripts/relay-healthcheck.sh')], { env: {
    ...process.env, DRDSH_TLS_INSECURE: '0', DSH_RELAY_BIND: `127.0.0.1:${nativePort}`, DSH_RELAY_TLS_CERT: certFile('server.pem'),
    DSH_RELAY_TLS_KEY: certFile('server.key'), DSH_RELAY_TLS_SERVER_NAME: 'localhost', DRDSH_CA_CERT: certFile('ca.pem'),
  }, stdio: 'pipe' });
  check('container healthcheck validates the local TLS listener with its certificate DNS name');
  const healthEnv = {
    ...process.env, DSH_RELAY_BIND: `127.0.0.1:${nativePort}`, DSH_RELAY_TLS_CERT: certFile('server.pem'),
    DSH_RELAY_TLS_KEY: certFile('server.key'), DSH_RELAY_TLS_SERVER_NAME: 'wrong.example', DRDSH_CA_CERT: certFile('missing.pem'),
  };
  const healthScript = join(repo, 'scripts/relay-healthcheck.sh');
  execFileSync('sh', [healthScript], { env: { ...healthEnv, DRDSH_TLS_INSECURE: '1' }, stdio: 'pipe' });
  for (const value of ['0', 'yes', '']) {
    assert.throws(() => execFileSync('sh', [healthScript], { env: { ...healthEnv, DRDSH_TLS_INSECURE: value }, stdio: 'pipe' }));
  }
  check('container healthcheck bypass is explicit; restoring verification and invalid settings reject');

  writeFileSync(certFile('ip.ext'), 'subjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
  openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1', '-extfile', 'ip.ext', '-out', 'ip.pem']);
  const dshPort = await unusedPort();
  const dsh = start([join(repo, 'crates/dr-dsh-daemon/tests/fixtures/fake-dsh.mjs'), String(dshPort)], {
    FAKE_DSH_TLS_CERT: certFile('ip.pem'), FAKE_DSH_TLS_KEY: certFile('server.key'),
  }, process.execPath);
  await waitFor(() => /dsh web: https:/.test(dsh.output), 'HTTPS DSH fixture');
  const token = /\?token=(\S+)/.exec(dsh.output)[1];
  await controlRoundTrip(nativeUrl, nativeUrl, dshPort, {}, ['--attach-tls', '--attach-token', token], true);
  check('HTTPS DSH token exchange, authenticated HTTP and WSS upgrade survive the encrypted tunnel');
  const badDsh = start(['daemon', 'run', '--attach', String(dshPort), '--attach-tls', '--attach-token', token], { SSL_CERT_FILE: certFile('other-ca.pem') });
  assert.equal((await bounded(badDsh.done, 'DSH untrusted certificate')).code, 1);
  check('DSH HTTPS rejects an untrusted certificate');
  await controlRoundTrip(`wss://127.0.0.1:${nativePort}`, nativeUrl, dshPort, noRoots,
    ['--attach-tls', '--attach-token', token, '--insecure'], true);
  check('--insecure covers HTTPS DSH authentication, HTTP proxy and WSS upgrade without CA files');

  let reports = 0, redirects = 0;
  const sink = await listen(httpServer((_, response) => { redirects += 1; response.end(); }));
  const reportPort = await listen(httpsServer({ cert: readFileSync(certFile('ip.pem')), key: readFileSync(certFile('server.key')) }, (req, response) => {
    req.resume(); reports += 1;
    if (reports === 1) response.end();
    else { response.writeHead(307, { location: `http://127.0.0.1:${sink}/report` }); response.end(); }
  }));
  await nodeProbe(['--probe-report', `https://127.0.0.1:${reportPort}`, '1']);
  await nodeProbe(['--probe-report', `https://127.0.0.1:${reportPort}`, '0']);
  await nodeProbe(['--probe-report', `https://127.0.0.1:${reportPort}`, '0'], 'other-ca.pem');
  assert.equal(reports, 2);
  assert.equal(redirects, 0);
  check('plugin HTTPS reports validate CA trust and refuse a redirect to plaintext');
  console.log(`Passed ${checks} TLS transport checks.`);
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

async function probeClient(relayUrl, root, proxy = false) {
  let socket;
  let tunnel;
  let control;
  try {
    const room = await Tunnel.roomFor(root);
    // The independent PWA implementation exercises the encrypted carrier after TLS negotiation.
    socket = new WebSocket(`${relayUrl}/ws/client`);
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
    if (proxy) {
      const response = await bounded(request(tunnel, 1, encodeRequest(1, 'GET', '/')), 'HTTPS proxy response');
      assert.equal(response.head.status, 200);
      assert.match(new TextDecoder().decode(response.body), /fake dsh/);
      const Ws = tunneledWebSocket(tunnel, () => 3);
      const ws = new Ws('wss://unused/api/remote.mux');
      const text = await bounded(new Promise((accept, reject) => {
        ws.onmessage = event => accept(event.data);
        ws.onerror = () => reject(new Error('TLS upstream WebSocket failed'));
      }), 'WSS upstream response');
      assert.equal(text, 'TLS websocket fixture');
      ws.close();
    }
  } finally {
    control?.close();
    tunnel?.close();
    socket?.close();
  }
}
