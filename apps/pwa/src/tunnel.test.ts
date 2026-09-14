/**
 * The tunnel's protocol behaviour, driven without a browser.
 *
 * These tests exist because the alternative is checking this in a browser by hand. The
 * socket and the peer are stand-ins, so every branch — acknowledgement, replay, tampering,
 * a frame for another stream — is reachable from `node --test`.
 *
 * What a stand-in cannot prove is that the **real** daemon agrees. That is
 * `scripts/pwa-tunnel-smoke.mjs`, which runs this same module against a live daemon
 * through a live relay.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CONTROL_STREAM,
  type TunnelSocket,
  LABELS,
  Tunnel,
  TunnelError,
  additionalData,
  carrier,
  deriveKey,
  nonceBytes,
  parseCarrier,
} from './tunnel.ts';

const ROOT: Uint8Array<ArrayBuffer> = new Uint8Array(32).fill(9);

/** The byte the daemon sends to acknowledge a session. */
const ACK = new Uint8Array([0x6b]);

/**
 * A stand-in daemon over a fake socket: it opens the client's salt, adopts the session the
 * salt defines, and acknowledges under it — exactly the sequence the real daemon performs.
 *
 * The socket and the peer are separate values on purpose. A test that wants to deliver a
 * frame should not have to reach through the peer's protocol state to do it, and a test
 * that wants to break the socket should not have to pretend to be the daemon.
 */
interface Peer {
  /** Frames the peer received and decrypted. */
  readonly seen: { streamId: number; payload: Uint8Array<ArrayBuffer> }[];
  /** Sends a payload to the client as the daemon. */
  send(streamId: number, payload: Uint8Array<ArrayBuffer>): Promise<void>;
}

/** A stand-in socket, with the hooks a test needs. */
interface FakeSocket {
  /** Frames the client wrote, as they went on the wire. */
  readonly sent: Uint8Array<ArrayBuffer>[];
  /** Delivers a raw frame as if it came from the daemon. */
  push(frame: Uint8Array<ArrayBuffer>): void;
  /** Reports that the socket closed. */
  drop(reason: string): void;
  /** The tunnel's socket interface. */
  readonly socket: TunnelSocket;
}

/**
 * Builds a stand-in daemon and its socket.
 *
 * A closure rather than a class: the interesting state is function-local, and a reader
 * checking a failing test should be looking at the client rather than at this scaffolding.
 */
async function fakeDaemon(): Promise<{ peer: Peer; fake: FakeSocket }> {
  const handlers: ((data: Uint8Array<ArrayBuffer>) => void)[] = [];
  const closeHandlers: ((reason: string) => void)[] = [];
  const sent: Uint8Array<ArrayBuffer>[] = [];
  const seen: { streamId: number; payload: Uint8Array<ArrayBuffer> }[] = [];

  let openKey = await deriveKey(ROOT, new Uint8Array(32), LABELS.clientToDaemon);
  let sealKey = await deriveKey(ROOT, new Uint8Array(32), LABELS.daemonToClient);
  let openCounter = 0;
  let sealCounter = 0;
  let adopted = false;

  function deliver(frame: Uint8Array<ArrayBuffer>): void {
    for (const handler of [...handlers]) handler(frame);
  }

  async function seal(streamId: number, payload: Uint8Array<ArrayBuffer>): Promise<void> {
    const counter = sealCounter;
    sealCounter += 1;
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: nonceBytes(counter),
          additionalData: additionalData(streamId, counter),
        },
        sealKey,
        payload,
      ),
    );
    const body = new Uint8Array(8 + sealed.length);
    new DataView(body.buffer).setBigUint64(0, BigInt(counter), false);
    body.set(sealed, 8);
    deliver(carrier(streamId, body));
  }

  async function handle(frame: Uint8Array<ArrayBuffer>): Promise<void> {
    const { streamId, body } = parseCarrier(frame);
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const counter = Number(view.getBigUint64(0, false));
    assert.equal(counter, openCounter, 'the daemon expects the next counter');
    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: nonceBytes(counter),
          additionalData: additionalData(streamId, counter),
        },
        openKey,
        body.subarray(8),
      ),
    );
    openCounter += 1;

    if (!adopted && streamId === CONTROL_STREAM) {
      adopted = true;
      sealKey = await deriveKey(ROOT, plaintext, LABELS.daemonToClient);
      openKey = await deriveKey(ROOT, plaintext, LABELS.clientToDaemon);
      sealCounter = 0;
      await seal(CONTROL_STREAM, ACK);
      return;
    }
    // No client confirmation frame: the handshake ends with the daemon's acknowledgement, and
    // the next frame either side sends is real content. A stand-in that expected one used to
    // hide the opposite defect — a client that sent one, which the real daemon read as the
    // answer to its device challenge and as the PAKE message on a pairing room.
    seen.push({ streamId, payload: plaintext });
  }

  const fake: FakeSocket = {
    sent,
    push: deliver,
    drop(reason: string) {
      for (const handler of [...closeHandlers]) handler(reason);
    },
    socket: {
      send(data: Uint8Array<ArrayBuffer>) {
        sent.push(data);
        void handle(data);
      },
      receive(handler: (data: Uint8Array<ArrayBuffer>) => void) {
        handlers.push(handler);
      },
      closed(handler: (reason: string) => void) {
        closeHandlers.push(handler);
      },
      close() {},
    },
  };
  return { peer: { seen, send: seal }, fake };
}

/** Opens a tunnel against a stand-in daemon. */
async function connected(): Promise<{ tunnel: Tunnel; peer: Peer; fake: FakeSocket }> {
  const { peer, fake } = await fakeDaemon();
  const tunnel = await Tunnel.open(fake.socket, ROOT);
  return { tunnel, peer, fake };
}

/** Lets queued microtasks and crypto promises settle. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 20));
}

test('the room id matches the derivation the daemon documents', async () => {
  // Pinned so a change fails loudly: a different room id means the client and the daemon
  // never meet, and the symptom is "no daemon is serving this room".
  assert.equal((await Tunnel.roomFor(ROOT)).length, 22, '16 bytes of base64url');
  assert.notEqual(await Tunnel.roomFor(ROOT), await Tunnel.roomFor(new Uint8Array(32).fill(8)));
});

test('a tunnel establishes against a daemon that acknowledges', async () => {
  const { tunnel } = await connected();
  assert.equal(tunnel.isEstablished, true);
  assert.equal(tunnel.failure, null);
});

test('a payload travels both ways', async () => {
  const { tunnel, peer } = await connected();
  const received: Uint8Array<ArrayBuffer>[] = [];
  tunnel.on(4, payload => received.push(payload));

  await tunnel.send(4, new TextEncoder().encode('hello daemon'));
  await settle();
  assert.equal(peer.seen.length, 1);
  assert.equal(peer.seen[0]?.streamId, 4);
  assert.equal(new TextDecoder().decode(peer.seen[0]?.payload), 'hello daemon');

  await peer.send(4, new TextEncoder().encode('hello client'));
  await settle();
  assert.equal(received.length, 1);
  assert.equal(new TextDecoder().decode(received[0]), 'hello client');
});

test('a payload that arrives before anyone subscribes is not lost', async () => {
  // The worker subscribes after it has already sent a request, so an early response is
  // normal and must be buffered rather than dropped.
  const { tunnel, peer } = await connected();
  await peer.send(7, new TextEncoder().encode('early'));
  await settle();
  const received: Uint8Array<ArrayBuffer>[] = [];
  tunnel.on(7, payload => received.push(payload));
  assert.equal(received.length, 1);
  assert.equal(new TextDecoder().decode(received[0]), 'early');
});

test('nothing but the salt reaches the wire before the session exists', async () => {
  const { fake } = await fakeDaemon();
  // A socket nobody answers: the handshake cannot complete, so the only frame written is the
  // salt. A payload here would be sent under a session the daemon has not adopted. The
  // daemon's handler is detached so this socket really is silent.
  const silent = { ...fake.socket, receive: () => {} };
  const pending = Tunnel.open(silent, ROOT);
  await settle();
  assert.equal(fake.sent.length, 1, 'the salt, and nothing else');
  fake.drop('the test is done');
  await assert.rejects(pending, TunnelError);
});

test('the client sends nothing after the salt, because the daemon reads the next frame', async () => {
  // This test used to assert the opposite — that the client sends a confirmation frame after
  // the salt — and the stand-in daemon skipped it, so both ends agreed on a step the real
  // daemon does not have. A live daemon reads the next frame as the answer to its device
  // challenge (refusing it as a bad proof) and, on a pairing room, as the client's PAKE
  // message (`a SPAKE2 message is 33 bytes, got 1`). The property is now the absence: after
  // the handshake the wire carries the salt and nothing else.
  const { tunnel, peer, fake } = await connected();
  assert.equal(tunnel.isEstablished, true);
  assert.equal(peer.seen.length, 0, 'the handshake itself sends no request');
  assert.equal(fake.sent.length, 1, 'the salt, and nothing else');
  tunnel.close();

  // And the caller's own frame is the very next thing to arrive — not swallowed by a
  // handshake step, and not preceded by one.
  const { tunnel: second, peer: secondPeer } = await connected();
  await second.send(CONTROL_STREAM, new TextEncoder().encode('hello'));
  await settle();
  assert.deepEqual(
    secondPeer.seen.map(frame => new TextDecoder().decode(frame.payload)),
    ['hello'],
  );
  second.close();
});

test('a socket that dies during the handshake rejects instead of hanging', async () => {
  const { fake } = await fakeDaemon();
  const silent = { ...fake.socket, receive: () => {} };
  const pending = Tunnel.open(silent, ROOT);
  // Dropped before the socket has answered anything: a page whose connection dies mid
  // handshake must say so rather than spin.
  fake.drop('the relay closed the connection');
  await assert.rejects(pending, TunnelError);
});

test('a frame that fails authentication ends the tunnel', async () => {
  const { tunnel, fake } = await connected();
  fake.push(carrier(1, new Uint8Array(8 + 16).fill(0xab)));
  await settle();
  assert.ok(
    tunnel.failure instanceof TunnelError,
    `expected a failure, got ${String(tunnel.failure)}`,
  );
});

test('an out-of-order frame is refused instead of silently skipping content', async () => {
  const { tunnel, fake } = await connected();
  const body = new Uint8Array(8 + 16);
  new DataView(body.buffer).setBigUint64(0, 5n, false);
  fake.push(carrier(1, body));
  await settle();
  assert.ok(tunnel.failure instanceof TunnelError);
});

test('a non-data frame is refused', () => {
  const frame = carrier(1, new Uint8Array(8));
  new DataView(frame.buffer).setUint16(6, 0x30, false); // Ping
  assert.throws(() => parseCarrier(frame), TunnelError);
});

test('a frame that disagrees with its declared length is refused', () => {
  const frame = carrier(1, new Uint8Array(8));
  new DataView(frame.buffer).setUint32(14, 99, false);
  assert.throws(() => parseCarrier(frame), TunnelError);
});

test('a payload larger than one frame is refused at the source', () => {
  assert.throws(() => carrier(1, new Uint8Array(64 * 1024 + 1)), TunnelError);
});

test('the nonce and additional data layouts are the ones the daemon uses', () => {
  assert.deepEqual(Array.from(nonceBytes(0)), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(nonceBytes(258)), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2]);
  const aad = additionalData(3, 5);
  const label = new TextEncoder().encode(LABELS.frame);
  assert.equal(aad.length, label.length + 12);
  assert.deepEqual(aad.subarray(0, label.length), label);
  assert.deepEqual(Array.from(aad.subarray(label.length)), [0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 5]);
  assert.notDeepEqual(additionalData(3, 5), additionalData(4, 5));
  assert.notDeepEqual(additionalData(3, 5), additionalData(3, 6));
});

test('two subscribers on one stream do not evict each other', async () => {
  // The regression this exists for: `on` used to keep one handler per stream and the unsubscribe
  // deleted whatever was registered for that id, so a caller reading raw frames alongside the control
  // client silently killed the client's subscription — its next reply arrived on the wire and was
  // seen by nobody. Found by the crash-report smoke, whose request after a raw read never came back.
  const { tunnel, peer } = await connected();
  const first: string[] = [];
  const second: string[] = [];
  const stopFirst = tunnel.on(CONTROL_STREAM, payload =>
    first.push(new TextDecoder().decode(payload)),
  );
  const stopSecond = tunnel.on(CONTROL_STREAM, payload =>
    second.push(new TextDecoder().decode(payload)),
  );

  // Both see the same payload: subscribing again must not take the stream away from anyone.
  await peer.send(CONTROL_STREAM, new TextEncoder().encode('hello'));
  await settle();
  assert.deepEqual(first, ['hello']);
  assert.deepEqual(second, ['hello']);

  // One unsubscribe removes only itself.
  stopFirst();
  await peer.send(CONTROL_STREAM, new TextEncoder().encode('after'));
  await settle();
  assert.deepEqual(first, ['hello']);
  assert.deepEqual(second, ['hello', 'after']);

  // Stopping twice is a no-op, and does not remove a handler registered afterwards.
  stopFirst();
  const third: string[] = [];
  tunnel.on(CONTROL_STREAM, payload => third.push(new TextDecoder().decode(payload)));
  await peer.send(CONTROL_STREAM, new TextEncoder().encode('last'));
  await settle();
  assert.deepEqual(third, ['last']);
  assert.deepEqual(second, ['hello', 'after', 'last']);
  stopSecond();
});
