/**
 * Checks that the three failures of § 9.7 reach a **live** client as three different things.
 *
 * `apps/pwa/src/panel.test.ts` pins the wording for each failure on constructed inputs. This
 * drives the same panel through a real tunnel so the wording is reached by the real components:
 * a panel that classifies correctly in a unit test and never receives those inputs in production
 * classifies nothing.
 *
 * Usage: node scripts/pwa-failure-smoke.mjs <relay-url> <room-key>
 *
 * The caller is responsible for the fault, because the fault is a property of the environment:
 * run this with `--kill relay` after it prints "ready", or `--kill daemon`. The script waits for
 * the fault and then reports what the panel showed.
 */

import { ControlClient } from '../apps/pwa/src/control.ts';
import { ControlPanel } from '../apps/pwa/src/panel.ts';
import { Tunnel } from '../apps/pwa/src/tunnel.ts';

const [relayUrl, roomKey, phase] = process.argv.slice(2);
if (relayUrl === undefined || roomKey === undefined) {
  console.error('usage: node scripts/pwa-failure-smoke.mjs <relay-url> <room-key> [phase]');
  process.exit(2);
}

const root = new Uint8Array(Buffer.from(roomKey, 'base64url'));
const room = await Tunnel.roomFor(root);

const socket = new WebSocket(`${relayUrl}/ws/client`);
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
await new Promise((resolve, reject) => {
  socket.onerror = () => reject(new Error('cannot reach the relay'));
  socket.onopen = () => {
    socket.send(JSON.stringify({ role: 'client', room, proto: [0, 1] }));
    resolve();
  };
});
const reply = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('the relay never answered')), 10_000);
  socket.addEventListener(
    'message',
    event => {
      if (typeof event.data !== 'string') return;
      clearTimeout(timer);
      resolve(event.data);
    },
    { once: true },
  );
});
if (!String(reply).includes('ready')) {
  console.error(`the relay refused the client: ${reply}`);
  process.exit(1);
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
const drawn = [];
const panel = new ControlPanel(
  { control: () => control, render: view => drawn.push(view), schedule: () => () => {} },
  { connected: true },
);
// The same wiring the page uses: a tunnel that dies is a fact the panel is told about, not one
// it has to infer from a request timing out.
tunnel.onClosed(reason => panel.socketDropped(reason));

await panel.refresh();
const first = drawn.at(-1);
console.log(`initial: ${JSON.stringify({ headline: first?.headline, tone: first?.tone })}`);
if (first === undefined || first.tone !== 'ok') {
  console.error('the panel never reached a healthy state, so the fault below would prove nothing');
  process.exit(1);
}

// Announce readiness and keep reading, so the caller can inject the fault at a known moment.
console.log(`ready (${drawn.length} view(s) drawn); inject the fault now`);
const before = drawn.length;
const deadline = Date.now() + 40_000;
let reported = null;
while (Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 250));
  // Keep asking, which is what a live panel does. The fault shows up as a request that fails,
  // or as a socket that closes and ends the panel's polling.
  await panel.refresh().catch(() => {});
  const last = drawn.at(-1);
  if (last !== undefined && (last.tone === 'error' || last.tone === 'warn')) {
    reported = last;
    break;
  }
  if (drawn.length > before && last !== undefined && last.tone !== 'ok') {
    reported = last;
    break;
  }
}

if (reported === null) {
  console.error('FAIL: the fault never surfaced — the panel kept reporting a healthy state');
  process.exit(1);
}
console.log(`reported: ${JSON.stringify({ headline: reported.headline, detail: reported.detail, tone: reported.tone })}`);
console.log(`sentence: ${reported.headline}`);
panel.stop();
control.close();
tunnel.close();
process.exit(0);
