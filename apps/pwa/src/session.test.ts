/**
 * The page's session ordering, which is the part of the browser half that fails invisibly.
 *
 * A page that connects and hands over without waiting for the worker to control it looks
 * fine in the console and 404s on the first navigation, because nothing intercepted it.
 * These tests pin the order, and the key handling that decides whether the user's paste
 * even became a key.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Session, decodeRoomKey, handWorkerView, openRelaySocket, type SessionHost, type SessionPhase } from './session.ts';
import { Tunnel, type TunnelSocket } from './tunnel.ts';
import { WorkerViews } from './worker-service.ts';

/** A 32-byte key as the daemon prints it. */
const ROOM_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/**
 * A socket whose connection drops, so the handshake ends in a rejection.
 *
 * A socket that simply never answers would leave `Session.start` pending forever, which
 * makes a test hang instead of fail — the same dead-end a user would see as a spinner.
 */
function droppingSocket(): TunnelSocket {
  let drop: ((reason: string) => void) | null = null;
  const socket: TunnelSocket = {
    send: () => {},
    receive: () => {},
    closed(handler) {
      drop = handler;
    },
    close: () => {},
  };
  setTimeout(() => drop?.('the relay closed the connection'), 5);
  return socket;
}

/**
 * A socket that completes a handshake, so a test can reach the steps after it.
 *
 * `Session.start` opens its own tunnel, so the socket has to be one that answers a
 * handshake — not a scripted stub, since the session drives it for real.
 */
async function handshakenSocket(acceptDevice = false): Promise<{ socket: TunnelSocket }> {
  const handlers: ((data: Uint8Array<ArrayBuffer>) => void)[] = [];
  const closeHandlers: ((reason: string) => void)[] = [];
  const root = decodeRoomKey(ROOM_KEY);
  const { deriveKey, LABELS, carrier, parseCarrier, nonceBytes, additionalData } = await import('./tunnel.ts');

  let openKey = await deriveKey(root, new Uint8Array(32), LABELS.clientToDaemon);
  let sealKey = await deriveKey(root, new Uint8Array(32), LABELS.daemonToClient);
  let openCounter = 0;
  let adopted = false;
  // Frames are opened one at a time. Opening is asynchronous, so handling them as they
  // arrive lets a later frame read `openKey` before an earlier one has re-derived it —
  // and a stand-in daemon that fails under load is a test that lies about the client.
  let chain: Promise<void> = Promise.resolve();

  const deliver = (frame: Uint8Array<ArrayBuffer>): void => {
    for (const handler of [...handlers]) handler(frame);
  };

  const socket: TunnelSocket = {
    send(data) {
      chain = chain.then(async () => {
        const { streamId, body } = parseCarrier(data);
        const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
        const counter = Number(view.getBigUint64(0, false));
        const plaintext = new Uint8Array(
          await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: nonceBytes(counter), additionalData: additionalData(streamId, counter) },
            openKey,
            body.subarray(8),
          ),
        );
        openCounter += 1;
        if (adopted) return;
        adopted = true;
          sealKey = await deriveKey(root, plaintext, LABELS.daemonToClient);
        openKey = await deriveKey(root, plaintext, LABELS.clientToDaemon);
        const sealed = new Uint8Array(
          await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: nonceBytes(0), additionalData: additionalData(0, 0) },
            sealKey,
            new Uint8Array([0x6b]),
          ),
        );
        const ack = new Uint8Array(8 + sealed.length);
        new DataView(ack.buffer).setBigUint64(0, 0n, false);
        ack.set(sealed, 8);
        deliver(carrier(0, ack));
        if (acceptDevice) {
          // Device proof validation lives in device.test.ts; this fixture supplies the explicit
          // verdict required before a stored identity can reach the worker handoff.
          const accepted = new Uint8Array(await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: nonceBytes(1), additionalData: additionalData(0, 1) },
            sealKey,
            new TextEncoder().encode(JSON.stringify({ type: 'resume_accept' })),
          ));
          const verdict = new Uint8Array(8 + accepted.length);
          new DataView(verdict.buffer).setBigUint64(0, 1n, false);
          verdict.set(accepted, 8);
          deliver(carrier(0, verdict));
        }
      });
    },
    receive(handler) {
      handlers.push(handler);
    },
    closed(handler) {
      closeHandlers.push(handler);
    },
    close() {},
  };
  return { socket };
}

/** A stored device record, made the way pairing makes one. */
async function storedDevice() {
  const { generateDevice, withRoom, deviceIdFor } = await import('./identity.ts');
  const device = await generateDevice();
  const roomKey = decodeRoomKey(ROOM_KEY);
  const room = await Tunnel.roomFor(roomKey);
  assert.equal(device.record.deviceId, await deviceIdFor(device.publicKeyBytes));
  return withRoom(device, roomKey, room);
}

/** A host that records what the page did, in order. */
function recordingHost(options: { readonly socket?: TunnelSocket; readonly failWorker?: boolean } = {}) {
  const order: string[] = [];
  const phases: SessionPhase[] = [];
  const host: SessionHost = {
    async connect(room: string) {
      order.push(`connect:${room}`);
      return options.socket ?? droppingSocket();
    },
    async prepareWorker() {
      order.push('prepareWorker');
      if (options.failWorker === true) throw new Error('the worker never took control');
    },
    async hand(serve) {
      order.push('hand');
      // The session expects to start serving here; a real port would be answered by the
      // worker, so this records the call and returns the stop function the session keeps.
      void serve;
      return () => order.push('stopServing');
    },
    report(phase: SessionPhase) {
      phases.push(phase);
    },
  };
  return { host, order, phases };
}

test('a room key decodes to 32 bytes', () => {
  assert.equal(decodeRoomKey(ROOM_KEY).length, 32);
  assert.equal(decodeRoomKey(`  ${ROOM_KEY}  `).length, 32, 'a pasted key may carry whitespace');
});

test('a key that lost characters is refused with its length', () => {
  // The likeliest real mistake, and the one a bare "invalid key" would not explain.
  assert.throws(() => decodeRoomKey(ROOM_KEY.slice(0, 40)), /got 30/);
  assert.throws(() => decodeRoomKey(''), /got 0/);
});

test('a value with characters outside base64url is refused', () => {
  assert.throws(() => decodeRoomKey('not a key at all!!'), /base64url/);
});

test('the page connects before it prepares the worker, and hands over last', async () => {
  // The ordering is the whole point: a worker handed a tunnel before it controls the page
  // cannot intercept that page's requests.
  const { host, order } = recordingHost();
  const session = new Session(host);
  // The connection drops, so the handshake fails; what is asserted is the order up to it.
  await assert.rejects(session.start({ roomKey: ROOM_KEY }));
  assert.deepEqual(order, ['connect:' + (await Tunnel.roomFor(decodeRoomKey(ROOM_KEY)))]);
});

test('a worker that never takes control fails the session with its reason', async () => {
  // A socket that completes the handshake, so the failure under test is the worker's.
  const { socket } = await handshakenSocket();
  const { host, phases } = recordingHost({ socket, failWorker: true });
  const session = new Session(host);
  await assert.rejects(session.start({ roomKey: ROOM_KEY }), /never took control/);
  const last = phases.at(-1);
  assert.equal(last?.phase, 'failed');
  assert.match(last?.phase === 'failed' ? last.reason : '', /never took control/);
});

test('a bad key reports a failure instead of a spinner', async () => {
  const { host, phases } = recordingHost();
  const session = new Session(host);
  // Valid base64url, wrong length: the key that lost a character in a paste.
  await assert.rejects(
    session.start({ roomKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }),
    /got 30/,
  );
  assert.deepEqual(phases.map(phase => phase.phase), ['connecting', 'failed']);

  // Not base64url at all: a different mistake, reported as itself.
  const other = recordingHost();
  await assert.rejects(new Session(other.host).start({ roomKey: 'too-short!' }), /base64url/);
  assert.equal(other.phases.at(-1)?.phase, 'failed');
});

test('a stored room record connects with nothing typed', async () => {
  // The point of pairing: after it, the browser needs no pasted secret. The key comes from the room
  // record the caller chose, and the identity travels with the tunnel so an enrolled daemon can
  // challenge it. Since ADR-0007 the identity deliberately carries no room, which is why the caller
  // passes the room it selected — that is the whole difference between "one pairing" and "as many as
  // you have machines".
  const { socket } = await handshakenSocket(true);
  const { host, order } = recordingHost({ socket });
  const record = await storedDevice();
  const session = new Session(host);
  const room = await session.start({ roomKey: record.roomKey, room: record.room, device: record });
  assert.equal(room, await Tunnel.roomFor(decodeRoomKey(record.roomKey)));
  assert.deepEqual(order, ['connect:' + room, 'prepareWorker', 'hand']);
  assert.equal(session.isReady, true);
  session.stop();
});

test('a room record whose key names another room is refused before a socket is opened', async () => {
  // The check that used to live in `restoreDevice` now belongs here, because the room is the caller's
  // choice: a mismatched pair must fail as "pair again" rather than as an unexplained refusal.
  const { host, phases } = recordingHost();
  const record = await storedDevice();
  await assert.rejects(
    new Session(host).start({ roomKey: record.roomKey, room: 'not-the-derived-room', device: record }),
    /does not match its key/,
  );
  assert.equal(phases.at(-1)?.phase, 'failed');
});

test('a stored device that does not verify asks for a new pairing', async () => {
  // A damaged record must fail here, where the message can say what to do, rather than as a
  // refusal from the daemon — which is indistinguishable from a revoked device.
  const { host, phases } = recordingHost();
  const record = await storedDevice();
  const damaged = { ...record, publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };
  await assert.rejects(
    new Session(host).start({ roomKey: damaged.roomKey, room: damaged.room, device: damaged }),
    /does not match its public half|not a usable Ed25519 key/,
  );
  assert.equal(phases.at(-1)?.phase, 'failed');
});

test('no key and no pairing is a sentence, not a spinner', async () => {
  const { host, phases } = recordingHost();
  await assert.rejects(new Session(host).start({}), /no pairing and no key/);
  assert.deepEqual(phases.map(phase => phase.phase), ['connecting', 'failed']);
});

test('stopping an idle session is safe and reports idle', () => {
  const { host, phases } = recordingHost();
  const session = new Session(host);
  session.stop();
  assert.equal(session.isReady, false);
  assert.deepEqual(phases.map(phase => phase.phase), ['idle']);
});

test('the session does not report ready before the worker acknowledges its route', async () => {
  const { socket } = await handshakenSocket();
  const { host, phases } = recordingHost({ socket });
  let accept!: (stop: () => void) => void;
  let handed!: () => void;
  const handStarted = new Promise<void>(resolve => { handed = resolve; });
  host.hand = async () => { handed(); return new Promise<() => void>(resolve => { accept = resolve; }); };
  const session = new Session(host);
  const starting = session.start({ roomKey: ROOM_KEY });
  await handStarted;
  assert.equal(phases.some(phase => phase.phase === 'ready'), false);
  let stopped = 0;
  accept(() => { stopped += 1; });
  await starting;
  assert.equal(phases.at(-1)?.phase, 'ready');
  session.stop();
  assert.equal(stopped, 1);
});

test('worker route handoff waits for acknowledgements, rebinds on upgrade, and stops its listener and ports', async () => {
  const viewId = '11111111-1111-4111-8111-111111111111';
  const events = new EventTarget();
  const handed: { viewId: string; port: MessagePort }[] = [];
  let unhands = 0;
  const controller = () => ({
    postMessage(value: unknown, transfer: Transferable[]) {
      const message = value as { kind: string; viewId: string };
      if (message.kind === 'unhand') { unhands += 1; return; }
      const port = transfer[0];
      assert.ok(port instanceof MessagePort);
      handed.push({ viewId: message.viewId, port });
    },
  });
  const host = {
    controller: controller(),
    addEventListener(type: 'controllerchange' | 'message', listener: EventListener) { events.addEventListener(type, listener); },
    removeEventListener(type: 'controllerchange' | 'message', listener: EventListener) { events.removeEventListener(type, listener); },
  };
  let ready = 0;
  let released = 0;
  let stop: (() => void) | undefined;
  const starting = handWorkerView(host, viewId, port => () => { released += 1; port.close(); }, () => { ready += 1; });
  try {
    assert.equal(ready, 0);
    assert.equal(handed.length, 1);
    handed[0]!.port.postMessage({ kind: 'handed', viewId });
    stop = await starting;
    assert.equal(ready, 1);
    host.controller = controller();
    events.dispatchEvent(new Event('controllerchange'));
    assert.equal(handed.length, 2);
    assert.equal(released, 1);
    assert.equal(unhands, 1);
    handed[1]!.port.postMessage({ kind: 'handed', viewId: 'another-view' });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(ready, 1);
    handed[1]!.port.postMessage({ kind: 'handed', viewId });
    for (let attempts = 0; ready !== 2 && attempts < 20; attempts += 1) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(ready, 2);
    stop();
    assert.equal(released, 2);
    assert.equal(unhands, 2);
    events.dispatchEvent(new Event('controllerchange'));
    assert.equal(handed.length, 2);
  } finally {
    stop?.();
    for (const hand of handed) hand.port.close();
  }
});

test('a rejected worker route closes the new port and never becomes ready', async () => {
  let released = 0;
  let removed = 0;
  let ready = false;
  const ports: MessagePort[] = [];
  const host = {
    controller: {
      postMessage(value: unknown, transfer: Transferable[]) {
        if ((value as { kind: string }).kind !== 'hand') return;
        const port = transfer[0];
        assert.ok(port instanceof MessagePort);
        ports.push(port);
        port.postMessage({ kind: 'failed', reason: 'the route belongs to another page' });
      },
    },
    addEventListener() {},
    removeEventListener() { removed += 1; },
  };
  try {
    await assert.rejects(handWorkerView(host, '11111111-1111-4111-8111-111111111111', () => () => { released += 1; }, () => { ready = true; }), /another page/);
    assert.equal(ready, false);
    assert.equal(released, 1);
    assert.equal(removed, 2);
  } finally { for (const port of ports) port.close(); }
});

test('worker replacement detaches its old route and rejects pending HTTP in the previous worker', async () => {
  const viewId = '11111111-1111-4111-8111-111111111111';
  const previous = new WorkerViews();
  const replacement = new WorkerViews();
  const events = new EventTarget();
  const controller = (views: WorkerViews) => ({
    postMessage(value: unknown, transfer: Transferable[]) {
      const message = value as { kind: string; viewId: string };
      if (message.kind === 'unhand') { views.detach('shell', message.viewId); return; }
      const port = transfer[0];
      assert.ok(port instanceof MessagePort);
      views.attach('shell', message.viewId, port);
      port.postMessage({ kind: 'handed', viewId: message.viewId });
    },
  });
  const host = {
    controller: controller(previous),
    addEventListener(type: 'controllerchange' | 'message', listener: EventListener) { events.addEventListener(type, listener); },
    removeEventListener(type: 'controllerchange' | 'message', listener: EventListener) { events.removeEventListener(type, listener); },
  };
  const stop = await handWorkerView(host, viewId, port => () => port.close());
  try {
    const old = previous.route({ clientId: 'shell', requestUrl: 'https://relay.example/slow' });
    const pending = old.tunnel.fetch({ method: 'GET', path: '/slow', headers: [], body: new Uint8Array(0) });
    const rejected = assert.rejects(pending, /detached/);
    host.controller = controller(replacement);
    events.dispatchEvent(new Event('controllerchange'));
    assert.throws(() => previous.route({ clientId: 'shell', requestUrl: 'https://relay.example/slow' }), /no connected parent/);
    await rejected;
    assert.equal(replacement.route({ clientId: 'shell', requestUrl: 'https://relay.example/new' }).viewId, viewId);
  } finally {
    stop();
    previous.detach('shell', viewId);
    replacement.detach('shell', viewId);
  }
});

test('only the current worker can request restoration without a controller change', async () => {
  const viewId = '11111111-1111-4111-8111-111111111111';
  const events = new EventTarget();
  const ports: MessagePort[] = [];
  let hands = 0;
  let ready = 0;
  const host = {
    controller: {
      postMessage(value: unknown, transfer: Transferable[]) {
        const message = value as { kind: string; viewId: string };
        if (message.kind !== 'hand') return;
        assert.equal(message.viewId, viewId);
        hands += 1;
        const port = transfer[0];
        assert.ok(port instanceof MessagePort);
        ports.push(port);
        port.postMessage({ kind: 'handed', viewId });
      },
    },
    addEventListener(type: 'controllerchange' | 'message', listener: EventListener) { events.addEventListener(type, listener); },
    removeEventListener(type: 'controllerchange' | 'message', listener: EventListener) { events.removeEventListener(type, listener); },
  };
  const requestRestore = (source: unknown) => events.dispatchEvent(Object.assign(new Event('message'), { source, data: { kind: 'restore-views' } }));
  const stop = await handWorkerView(host, viewId, port => () => port.close(), () => { ready += 1; });
  try {
    requestRestore({ postMessage() {} });
    assert.equal(hands, 1);
    requestRestore(host.controller);
    assert.equal(hands, 2);
    for (let attempts = 0; ready !== 2 && attempts < 20; attempts += 1) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(ready, 2);
    stop();
    requestRestore(host.controller);
    assert.equal(hands, 2);
  } finally {
    stop();
    for (const port of ports) port.close();
  }
});

test('stopping while the route is unacknowledged releases its controller listener immediately', async () => {
  const abort = new AbortController();
  let released = 0;
  let removed = 0;
  const ports: MessagePort[] = [];
  const host = {
    controller: { postMessage(_value: unknown, transfer: Transferable[]) {
      if (transfer[0] instanceof MessagePort) ports.push(transfer[0]);
    } },
    addEventListener() {},
    removeEventListener() { removed += 1; },
  };
  const pending = handWorkerView(host, '11111111-1111-4111-8111-111111111111', () => () => { released += 1; }, () => {}, () => {}, abort.signal);
  const rejected = assert.rejects(pending, /connection ended/);
  abort.abort();
  await rejected;
  assert.equal(released, 1);
  assert.equal(removed, 2);
  for (const port of ports) port.close();
});

async function withRelayReplies(replies: (() => unknown)[], run: (sockets: { closed: boolean }[]) => Promise<void>): Promise<void> {
  const original = globalThis.WebSocket;
  const sockets: { closed: boolean }[] = [];
  class RelaySocket extends EventTarget {
    closed = false;
    binaryType = '';
    constructor() { super(); sockets.push(this); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(): void {
      const reply = replies.shift()?.();
      queueMicrotask(() => this.dispatchEvent(reply === undefined ? new Event('close')
        : new MessageEvent('message', { data: JSON.stringify(reply) })));
    }
    close(): void { this.closed = true; }
  }
  globalThis.WebSocket = RelaySocket as unknown as typeof WebSocket;
  try { await run(sockets); } finally { globalThis.WebSocket = original; }
}

const noDaemon = (): unknown => ({ type: 'reject', reason: 'no daemon is serving this room' });
const relayUrl = new URL('ws://localhost/ws/client');

test('a newly paired daemon can re-register before the first encrypted connection', async () => {
  await withRelayReplies([noDaemon, () => ({ type: 'ready' })], async sockets => {
    const tunnel = await openRelaySocket(relayUrl, 'test-room', true);
    assert.equal(sockets.length, 2);
    assert.equal(sockets[0]?.closed, true);
    assert.equal(sockets[1]?.closed, false);
    tunnel.close();
    assert.equal(sockets[1]?.closed, true);
  });
});

test('an ordinary connection and a busy room are refused without retrying', async () => {
  for (const [fresh, reply] of [[false, noDaemon], [true, () => ({ type: 'reject', reason: 'room is already in use' })]] as const) {
    await withRelayReplies([reply], async sockets => {
      await assert.rejects(openRelaySocket(relayUrl, 'test-room', fresh), /relay refused/);
      assert.equal(sockets.length, 1);
      assert.equal(sockets[0]?.closed, true);
    });
  }
});

test('the fresh-pairing retry window expires and closes rejected sockets', async context => {
  let now = 0;
  context.mock.method(Date, 'now', () => now);
  await withRelayReplies([noDaemon, () => { now = 5_001; return noDaemon(); }], async sockets => {
    await assert.rejects(openRelaySocket(relayUrl, 'test-room', true), /no daemon is serving/);
    assert.equal(sockets.length, 2);
    assert.ok(sockets.every(socket => socket.closed));
  });
});

test('a relay closing before its greeting ends the connection instead of leaving a spinner', async () => {
  await withRelayReplies([() => undefined], async sockets => {
    await assert.rejects(openRelaySocket(relayUrl, 'test-room', true));
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0]?.closed, true);
  });
});
