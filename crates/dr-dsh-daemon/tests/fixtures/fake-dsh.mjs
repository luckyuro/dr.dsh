/**
 * A stand-in for `dsh web`, used by the daemon's integration tests.
 *
 * It reproduces exactly the four externally observable behaviours the daemon
 * depends on (`docs/integration/dsh-surface.md`):
 *
 * 1. it prints the readiness line, `dsh web: http://127.0.0.1:<port>/?token=<token>`;
 * 2. it refuses everything with 401 until the token is redeemed;
 * 3. it redeems the token once — `GET /?token=…` answers 303 + `Set-Cookie` —
 *    with a cookie whose name is derived from the request authority, and whose
 *    signature is checked on every later request;
 * 4. it applies the `/api` host fence: a non-loopback Host is refused even with a
 *    valid cookie.
 *
 * Behaviour 3 is the reason this is a script and not a mock in the test binary:
 * driving it over a real socket with real headers is the only way to prove the
 * Rust client actually presents the authority DSH binds its cookie to.
 *
 * Usage: node fake-dsh.mjs <port>
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? '0');
const token = randomBytes(32).toString('base64url');
const secret = randomBytes(32);

/** The cookie name DSH derives: `dsh-auth-` + base64url(sha256(authority)). */
const cookieName = authority =>
  `dsh-auth-${createHash('sha256').update(authority).digest('base64url')}`;

/** The cookie value: `v1.<base64url(json)>.<base64url(hmac)>`. */
function cookieValue(authority) {
  const payload = Buffer.from(
    JSON.stringify({ version: 1, authority, issuedAt: Date.now(), expiresAt: Date.now() + 86_400_000 }),
    'utf8',
  ).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `v1.${payload}.${signature}`;
}

/** Reads the presented cookie for this authority, if it verifies. */
function authenticated(request) {
  const authority = request.headers.host;
  if (typeof authority !== 'string') return false;
  const raw = request.headers.cookie;
  if (typeof raw !== 'string') return false;
  const pair = raw.split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName(authority)}=`));
  if (pair === undefined) return false;
  const value = pair.slice(cookieName(authority).length + 1);
  const [prefix, payload, signature] = value.split('.');
  if (prefix !== 'v1' || payload === undefined || signature === undefined) return false;
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (expected !== signature) return false;
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  return decoded.authority === authority;
}

/** Whether the request authority is loopback, which the `/api` fence requires. */
const isLoopbackAuthority = authority =>
  /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\])(:\d+)?$/u.test(authority);

let redeemed = 0;

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://fake-dsh.invalid');
  const authority = request.headers.host ?? '';
  const send = (status, body, headers = {}) => {
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
    response.end(body);
  };

  if (url.pathname === '/' && url.searchParams.get('token') !== null) {
    if (url.searchParams.get('token') !== token) return send(401, 'bad token\n');
    redeemed += 1;
    return send(303, '', {
      location: '/',
      'set-cookie': `${cookieName(authority)}=${cookieValue(authority)}; Max-Age=86400; Path=/; HttpOnly; SameSite=Strict`,
    });
  }

  if (url.pathname.startsWith('/api')) {
    if (!isLoopbackAuthority(authority)) return send(403, 'forbidden authority\n');
    if (!authenticated(request)) return send(401, 'unauthorized\n');
    return send(200, JSON.stringify({ type: 'server-response', rpcId: '1', result: { ok: true, value: { sessions: [] } } }), {
      'content-type': 'application/json',
    });
  }

  if (url.pathname === '/') {
    if (!authenticated(request)) return send(401, 'dsh web authentication required\n');
    return send(200, `<!doctype html><title>fake dsh</title><p>redeemed=${redeemed}</p>`, {
      'content-type': 'text/html; charset=utf-8',
      // Proves the cookie reached us and was accepted.
      'authentication-info': 'cookie=accepted',
    });
  }

  send(404, 'not found\n');
});

server.listen(port, '127.0.0.1', () => {
  const bound = server.address().port;
  console.log(`dsh web: http://127.0.0.1:${bound}/?token=${token}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    // If a connection is held open, do not hang the test run.
    setTimeout(() => process.exit(0), 500).unref();
  });
}
