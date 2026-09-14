/**
 * Runs the PWA's control-plane client against a **live** daemon through a **live** relay.
 *
 * This is the interop test the unit tests cannot provide: `apps/pwa/src/control.ts` mirrors a
 * wire format by hand, and the only thing that proves the mirror is correct is talking to the
 * implementation that defines it. The same claim `scripts/pwa-tunnel-smoke.mjs` makes for the
 * tunnel, made for the control plane.
 *
 * Usage:
 *   node scripts/pwa-control-smoke.mjs <relay-url> <room-key>
 *
 * Its exit code is the result, so it can be wired into a verification script.
 */

import { ControlClient, describe } from '../apps/pwa/src/control.ts';
import { Tunnel } from '../apps/pwa/src/tunnel.ts';

const [relayUrl, roomKey] = process.argv.slice(2);
if (relayUrl === undefined || roomKey === undefined) {
  console.error('usage: node scripts/pwa-control-smoke.mjs <relay-url> <room-key>');
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
let failures = 0;
const check = (what, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
};

/** Sends one raw control frame and waits for the reply with the same id. */
async function rawControl(frame) {
  const reply = new Promise(resolve => {
    const stop = tunnel.on(0, payload => {
      const text = new TextDecoder().decode(payload);
      try {
        const parsed = JSON.parse(text);
        if (parsed.id === frame.id) {
          stop();
          resolve(parsed);
        }
      } catch {
        // Not a control reply; leave it for whoever else is listening.
      }
    });
  });
  const body = new TextEncoder().encode(JSON.stringify(frame));
  await tunnel.send(0, body);
  return await reply;
}

try {
  // The daemon's own state, as the real daemon reports it. Every field is checked because a
  // field the client reads under the wrong name is exactly the bug this script exists for.
  const status = await control.status();
  console.log('status:', JSON.stringify(status));
  check('state is a lifecycle state the client knows', typeof status.state === 'string', status.state);
  check('the protocol pair came through', status.protocol.length === 2, status.protocol.join('.'));
  check(
    'the daemon reports whether it owns the process',
    typeof status.owned === 'boolean',
    String(status.owned),
  );
  console.log('mode:', status.owned ? 'managed' : 'attached');
  check(
    status.owned
      ? 'a managed daemon reports the pid it supervises'
      : 'an attached daemon reports no pid, because it did not start the process',
    status.owned ? typeof status.pid === 'number' : status.pid === null,
    String(status.pid),
  );
  check('the relay state is one the client knows', typeof status.relay === 'string', status.relay);
  console.log('sentence:', describe(status));

  if (status.owned) {
    // Managed: the whitelist reaches the daemon, which performs the operation.
    const stopped = await control.command('stop');
    console.log('stop:', JSON.stringify(stopped));
    check('the daemon accepted the stop', stopped.accepted === true, String(stopped.accepted));
    check(
      'the state after the stop is not running',
      stopped.state !== 'running',
      stopped.state,
    );

    // And the daemon really is stopped: a second status agrees.
    const afterStop = await control.status();
    console.log('status after stop:', JSON.stringify(afterStop));
    check('the daemon agrees it is stopped', afterStop.state !== 'running', afterStop.state);

    // Starting it again closes the loop: the client can bring DSH back.
    const started = await control.command('start');
    console.log('start:', JSON.stringify(started));
    check('the daemon accepted the start', started.accepted === true, String(started.accepted));
    const afterStart = await control.status();
    check('DSH is running again', afterStart.state === 'running', afterStart.state);
  } else {
    // Attached: the daemon did not start this DSH, so it must refuse to stop it — and say why.
    // Criterion 5 is both halves at once: the control is refused *and* the reason is a sentence
    // a person can act on, not an error code.
    for (const op of ['stop', 'restart', 'start']) {
      const refused = await control.command(op);
      console.log(`${op}:`, JSON.stringify(refused));
      check(
        `the daemon refuses to ${op} a DSH it did not start`,
        refused.accepted === false,
        String(refused.accepted),
      );
      check(
        `the refusal explains itself for ${op}`,
        typeof refused.error === 'string' && refused.error.includes('started outside this daemon'),
        refused.error ?? '(no reason)',
      );
    }
    // And refusing did not break the daemon: it still answers status.
    const stillThere = await control.status();
    check('the daemon still reports its state after refusing', typeof stillThere.state === 'string');
  }

  // Last on purpose: the control stream is single-consumer (one handler per stream id), so
  // subscribing here replaces the control client's handler for stream 0. Running it earlier would
  // silently swallow the replies the checks above are waiting for — which is exactly what the first
  // version of this did.
// The daemon's own closed whitelist, over a real tunnel — not the client's guard. The client
  // refuses an operation it does not know before it is sent, so a test that went through it would
  // prove nothing about the daemon. This sends the frame by hand: an operation carrying a command
  // line where a name belongs must come back as a `problem`, which is what "the whitelist is a
  // closed set" means on the wire (docs/security.md § 5.9).
  const hostile = await rawControl({
    kind: 'lifecycle_command',
    id: 90,
    body: { op: 'start --port 1' },
  });
  check(
    'an operation carrying an argument is refused by the daemon itself',
    hostile.kind === 'problem' &&
      typeof hostile.body?.message === 'string' &&
      hostile.body.message.includes('start, stop, or restart'),
    JSON.stringify(hostile.body ?? {}),
  );

  control.close();
  tunnel.close();
  process.exit(failures === 0 ? 0 : 1);
} catch (error) {
  console.error(`control smoke failed: ${error.message}`);
  control.close();
  tunnel.close();
  process.exit(1);
}
