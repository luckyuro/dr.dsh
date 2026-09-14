/**
 * Runs the PWA's tunnel module against a **live** daemon through a **live** relay.
 *
 * This is the interop test the browser cannot provide from `node --test`: the unit tests
 * prove the client's own logic, and this proves that the logic agrees with the Rust
 * implementation it has to talk to — the same claim `crates/dr-dsh-daemon/tests/acceptance.rs`
 * makes from the other side.
 *
 * Usage:
 *   node scripts/pwa-tunnel-smoke.mjs <relay-url> <room-key> [path]
 *
 * Its exit code is the result, so it can be wired into a verification script.
 */

import { Tunnel } from '../apps/pwa/src/tunnel.ts';
import { encodeRequest, request } from '../apps/pwa/src/proxy.ts';

const [relayUrl, roomKey, path = '/'] = process.argv.slice(2);
if (relayUrl === undefined || roomKey === undefined) {
  console.error('usage: node scripts/pwa-tunnel-smoke.mjs <relay-url> <room-key> [path]');
  process.exit(2);
}

const root = Buffer.from(roomKey, 'base64url');
const room = await Tunnel.roomFor(new Uint8Array(root));
console.log('room derived by the PWA client:', room);

// The PWA's socket, adapted to the interface the tunnel expects. This is exactly what the
// page does around `new WebSocket(...)`, so nothing below is test-only scaffolding.
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
  for (const listener of [...closeListeners]) listener(`the relay closed the connection (${event.code})`);
};
const opened = new Promise((resolve, reject) => {
  socket.onerror = () => reject(new Error('cannot reach the relay'));
  socket.onopen = () => {
    socket.send(JSON.stringify({ role: 'client', room, proto: [0, 1] }));
    resolve();
  };
});
await opened;

// The relay answers the handshake with text; the tunnel takes over from the first binary
// frame. Waiting for `ready` is the one step the page also has to do.
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('the relay never answered the handshake')), 10_000);
  socket.addEventListener('message', event => {
    if (typeof event.data !== 'string') return;
    console.log('relay handshake:', event.data);
    clearTimeout(timer);
    if (event.data.includes('ready')) resolve();
    else reject(new Error(event.data));
  }, { once: true });
});

const tunnel = await Tunnel.open(
  {
    send: data => socket.send(data),
    receive: handler => listeners.push(handler),
    closed: handler => closeListeners.push(handler),
    close: () => socket.close(),
  },
  new Uint8Array(root),
);
console.log('tunnel established:', tunnel.isEstablished);

// One proxied request for DSH's own index, using the same module the page will use. The
// request/response encoding is not written by hand here: it has its own tests
// (`apps/pwa/src/proxy.test.ts`), and a smoke test that hand-rolls the format measures the
// hand-rolled copy rather than the shipped code.
const encoded = encodeRequest(1, 'GET', path, {
  headers: [['accept', 'text/html']],
});

try {
  const response = await request(tunnel, 1, encoded);
  console.log('response status:', response.head.status);
  console.log('response bytes:', response.body.length);
  const isDsh = new TextDecoder().decode(response.body).includes('__DSH_BOOT__');
  console.log('is the real DSH UI:', isDsh ? 'yes (boot global present)' : 'no');
  tunnel.close();
  process.exit(isDsh ? 0 : 1);
} catch (error) {
  console.log('handshake interop: ok');
  console.log(`proxied request failed: ${error.message}`);
  tunnel.close();
  process.exit(1);
}
