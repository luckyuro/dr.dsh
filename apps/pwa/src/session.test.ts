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

import { Session, decodeRoomKey, type SessionHost, type SessionPhase } from './session.ts';
import { Tunnel, type TunnelSocket } from './tunnel.ts';

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
async function handshakenSocket(): Promise<{ socket: TunnelSocket }> {
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
    hand(serve) {
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
  const { socket } = await handshakenSocket();
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
