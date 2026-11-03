/**
 * A managed DSH process stand-in. A tracking proxy wraps the shared authenticated
 * fixture so revocation can prove its pending HTTP and WebSocket sockets are reclaimed.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv.includes('--dump-config')) { console.log('[]'); process.exit(0); }

const scratch = process.env.DRDSH_MANAGEMENT_SMOKE_DIR;
if (!scratch) throw new Error('management fixture requires its private scratch directory');
if (process.argv.includes('--version')) {
  console.log('dsh management smoke fixture');
  process.exit(0);
}
const args = process.argv.slice(2);
if (args[0] === 'plugin') {
  if (args[1] !== '--profile' || args[2] !== 'web' || !['add', 'remove'].includes(args[3])) {
    throw new Error('management fixture received an unsupported plugin operation');
  }
  const home = process.env.DSH_HOME;
  if (!home) throw new Error('management fixture plugin operation requires DSH_HOME');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  appendFileSync(join(scratch, 'plugin-calls.jsonl'), `${JSON.stringify({ verb: args[3], spec: args[4] })}\n`, { mode: 0o600 });
  const registration = join(home, 'plugin-registration.json');
  if (args[3] === 'add') writeFileSync(registration, JSON.stringify({ spec: args[4] }), { mode: 0o600 });
  else rmSync(registration, { force: true });
  process.exit(0);
}
const portAt = process.argv.indexOf('--port');
if (portAt < 0 || !process.argv[portAt + 1]) throw new Error('management fixture requires --port');
appendFileSync(join(scratch, 'dsh-starts.jsonl'), `${JSON.stringify({
  pid: process.pid, reportsEnabled: Boolean(process.env.DRDSH_REPORT_URL && process.env.DRDSH_REPORT_TOKEN),
})}\n`, { mode: 0o600 });
const port = Number(process.argv[portAt + 1]);
const stats = { pid: process.pid, httpOpen: 0, httpClosed: 0, wsOpen: 0, wsClosed: 0 };
const statsPath = join(scratch, 'proxy-state.json');
function publish() {
  writeFileSync(`${statsPath}.next`, JSON.stringify(stats), { mode: 0o600 });
  renameSync(`${statsPath}.next`, statsPath);
}
publish();
let backendPort;
const connections = new Set();
const server = createServer((incoming, outgoing) => {
  const slow = incoming.url === '/smoke/slow';
  const upstream = request({
    hostname: '127.0.0.1', port: backendPort, method: incoming.method,
    path: slow ? '/' : incoming.url, headers: incoming.headers,
  }, response => {
    if (!slow || response.statusCode !== 200) {
      outgoing.writeHead(response.statusCode, response.headers);
      response.pipe(outgoing);
      return;
    }
    // Authenticate with the normal DSH cookie before deliberately holding the body.
    response.resume();
    response.once('end', () => {
      if (outgoing.destroyed) return;
      stats.httpOpen += 1;
      publish();
      outgoing.once('close', () => {
        stats.httpOpen -= 1;
        stats.httpClosed += 1;
        publish();
      });
      outgoing.writeHead(200, { 'content-type': 'text/plain' });
      outgoing.write('waiting for revocation');
    });
  });
  upstream.on('error', () => {
    if (!outgoing.headersSent) outgoing.writeHead(503);
    outgoing.end();
  });
  outgoing.once('close', () => upstream.destroy());
  incoming.pipe(upstream);
});
server.on('connection', socket => {
  connections.add(socket);
  socket.once('close', () => connections.delete(socket));
});
server.on('upgrade', (incoming, downstream, head) => {
  const upstream = createConnection({ host: '127.0.0.1', port: backendPort });
  connections.add(upstream);
  let counted = false;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    upstream.destroy();
    downstream.destroy();
    connections.delete(upstream);
    if (counted) {
      stats.wsOpen -= 1;
      stats.wsClosed += 1;
      publish();
    }
  };
  upstream.on('error', finish);
  downstream.on('error', finish);
  // HTTP upgrade sockets can remain half-open after the daemon sends FIN. A
  // transparent fixture must end the other leg as soon as either peer reaches EOF.
  upstream.once('end', finish);
  downstream.once('end', finish);
  upstream.once('close', finish);
  downstream.once('close', finish);
  upstream.once('connect', () => {
    if (finished) return;
    counted = true;
    stats.wsOpen += 1;
    publish();
    const headers = [];
    for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
      headers.push(`${incoming.rawHeaders[i]}: ${incoming.rawHeaders[i + 1]}`);
    }
    upstream.write(`${incoming.method} ${incoming.url} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    upstream.pipe(downstream);
    downstream.pipe(upstream);
  });
});

const backend = spawn(process.execPath, [fileURLToPath(new URL('../../crates/dr-dsh-daemon/tests/fixtures/fake-dsh.mjs', import.meta.url)), '0'], {
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('FAKE_DSH_'))),
  stdio: ['ignore', 'pipe', 'inherit'],
});
let stdout = '';
backend.stdout.on('data', bytes => {
  stdout += bytes;
  const match = /dsh web: http:\/\/127\.0\.0\.1:(\d+)\/\?token=([^\s]+)/u.exec(stdout);
  if (!match || backendPort !== undefined) return;
  backendPort = Number(match[1]);
  server.listen(port, '127.0.0.1', () => {
    console.log(`dsh web: http://127.0.0.1:${port}/?token=${match[2]}`);
    stdout = '';
  });
});
let stopping = false;
backend.once('exit', () => { if (!stopping) process.exit(1); });
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  if (stopping) return;
  stopping = true;
  server.close();
  for (const socket of connections) socket.destroy();
  backend.kill('SIGTERM');
  setTimeout(() => process.exit(0), 600).unref();
});
