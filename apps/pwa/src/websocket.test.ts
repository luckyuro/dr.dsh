/**
 * The tunneled `WebSocket`, against a stand-in daemon.
 *
 * What is checked here is the part that is easy to get wrong and impossible to see in a browser
 * without a lot of guessing: that a page's `new WebSocket(...)` turns into the upgrade message the
 * daemon expects, that messages travel in both directions, and that a socket which cannot be
 * opened fails in a way the caller can react to instead of hanging.
 *
 * The stand-in decodes with the same `decodeMessage` the client encodes with, which catches a
 * mismatch between the two directions but *not* a mismatch with the Rust side. That one is pinned
 * by `scripts/ws-conformance.mjs`, which runs the client's encoder against the daemon's own
 * decoder — a hand-written mirror that is never compared to its original is a mirror that drifts.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { encodeWsData, encodeWsOpen } from './proxy.ts';
import { tunneledWebSocket } from './websocket.ts';
import type { SocketTunnel } from './websocket.ts';

/**
 * Reads one client-to-daemon message.
 *
 * Deliberately *not* `decodeMessage`: that decoder is for what the daemon sends a client, and it
 * refuses the tags a client sends — which is the right behaviour and the reason these tests need
 * their own reader. Reading the bytes here also keeps the test honest about what it checks: the
 * layout, rather than the layout agreeing with itself.
 */
function readSent(payload: Uint8Array<ArrayBuffer>): {
  tag: number;
  id: number;
  text?: string;
} {
  assert.equal(payload[0], 0x50);
  assert.equal(payload[1], 0x58);
  assert.equal(payload[2], 1, 'version');
  const tag = payload[3] ?? -1;
  const id = Number(new DataView(payload.buffer, payload.byteOffset + 4, 8).getBigUint64(0, false));
  // `wsData` carries a kind byte after the id, then a length-prefixed payload for a text frame
  // and nothing at all for a close — the same shape the daemon's decoder reads.
  let text: string | undefined;
  if (tag === 10) {
    const kind = payload[12];
    if (kind === 1) {
      const length = new DataView(payload.buffer, payload.byteOffset + 13, 4).getUint32(0, false);
      text = new TextDecoder().decode(payload.slice(17, 17 + length));
    } else if (kind === 3) {
      text = '';
    }
  } else if (tag === 8 && payload.length > 12) {
    const length = new DataView(payload.buffer, payload.byteOffset + 12, 4).getUint32(0, false);
    text = new TextDecoder().decode(payload.slice(16, 16 + length));
  }
  return text === undefined ? { tag, id } : { tag, id, text };
}

/** A tunnel that records what the socket sent and lets a test answer. */
function standIn() {
  const sent: { streamId: number; payload: Uint8Array<ArrayBuffer> }[] = [];
  const handlers = new Map<number, (payload: Uint8Array<ArrayBuffer>) => void>();
  const tunnel: SocketTunnel = {
    async send(streamId, payload) {
      sent.push({ streamId, payload });
    },
    on(streamId, handler) {
      handlers.set(streamId, handler);
      return () => handlers.delete(streamId);
    },
  };
  /** Answers whatever is on a stream, as the daemon would. */
  const reply = (streamId: number, payload: Uint8Array<ArrayBuffer>): void => {
    const handler = handlers.get(streamId);
    assert.ok(handler !== undefined, `a socket must be listening on stream ${streamId}`);
    handler(payload);
  };
  return { tunnel, sent, reply, handlers };
}

/** The stream the first socket took. */
function onlyStream(sent: { streamId: number }[]): number {
  const first = sent[0];
  assert.ok(first !== undefined, 'the socket must have sent something');
  return first.streamId;
}

/** Builds an `wsOpened` message the way the daemon does. */
function opened(id: number, status = 101): Uint8Array<ArrayBuffer> {
  // magic(2) version(1) tag(1) id(8) status(2) header-count(4)
  const out = new Uint8Array(4 + 8 + 2 + 4);
  out[0] = 0x50;
  out[1] = 0x58;
  out[2] = 1;
  out[3] = 9; // wsOpened
  const view = new DataView(out.buffer);
  view.setBigUint64(4, BigInt(id), false);
  view.setUint16(12, status, false);
  view.setUint32(14, 0, false);
  return out;
}

/** Builds a `wsData` text message the way the daemon does. */
function text(id: number, body: string): Uint8Array<ArrayBuffer> {
  return encodeWsData(id, { kind: 'text', text: body });
}

let next = 1;
function allocator(): () => number {
  return () => {
    const value = next;
    next += 1;
    return value;
  };
}

test('constructing one sends the upgrade the daemon expects', async () => {
  const { tunnel, sent } = standIn();
  const Socket = tunneledWebSocket(tunnel, allocator());
  const socket = new Socket('ws://127.0.0.1/api/remote.mux');
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(sent.length, 1, 'exactly one upgrade');
  const decoded = readSent(sent[0]?.payload as Uint8Array<ArrayBuffer>);
  assert.equal(decoded.tag, 8, 'wsOpen');
  assert.equal(decoded.text, '/api/remote.mux');
  assert.equal(socket.readyState, 0, 'it starts connecting');
});

test('the upgrade carries only the path, never a host', async () => {
  // The daemon refuses to be told which host to reach: it chooses its own loopback origin. A
  // client that forwarded the authority would be asking the daemon to trust it with a destination.
  const { tunnel, sent } = standIn();
  const Socket = tunneledWebSocket(tunnel, allocator());
  void new Socket('ws://evil.example:9999/api/remote.mux?x=1');
  await new Promise(resolve => setTimeout(resolve, 0));

  const target = readSent(sent[0]?.payload as Uint8Array<ArrayBuffer>).text ?? '';
  assert.equal(target, '/api/remote.mux?x=1');
  assert.ok(!target.includes('evil.example'), 'no host may cross the tunnel');
});

test('a message sent after opening arrives as a text frame', async () => {
  const { tunnel, sent, reply } = standIn();
  const Socket = tunneledWebSocket(tunnel, allocator());
  const socket = new Socket('ws://x/api/remote.mux');
  await new Promise(resolve => setTimeout(resolve, 0));
  const streamId = onlyStream(sent);

  let openedEvent = false;
  (socket as unknown as { onopen: (() => void) | null }).onopen = () => {
    openedEvent = true;
  };
  reply(streamId, opened(streamId));
  assert.equal(openedEvent, true, 'the caller is told it opened');
  assert.equal(socket.readyState, 1);

  socket.send('hello');
  const decoded = readSent(sent.at(-1)?.payload as Uint8Array<ArrayBuffer>);
  assert.equal(decoded.tag, 10, 'wsData');
  assert.equal(decoded.text, 'hello');
});

test('a message from the daemon reaches the caller as data', async () => {
  const { tunnel, sent, reply } = standIn();
  const Socket = tunneledWebSocket(tunnel, allocator());
  const socket = new Socket('ws://x/api/remote.mux');
  await new Promise(resolve => setTimeout(resolve, 0));
  const streamId = onlyStream(sent);
  reply(streamId, opened(streamId));

  const seen: unknown[] = [];
  (socket as unknown as { onmessage: ((event: { data: unknown }) => void) | null }).onmessage =
    event => seen.push(event.data);
  reply(streamId, text(streamId, 'a live update'));
  assert.deepEqual(seen, ['a live update']);
});

test('an upgrade the daemon refuses ends the socket instead of hanging', async () => {
  // The failure mode this prevents is the one that made the interface sit on `Reconnecting…`: a
  // socket that neither opens nor closes leaves the caller waiting forever.
  const { tunnel, sent, reply } = standIn();
  const Socket = tunneledWebSocket(tunnel, allocator());
  const socket = new Socket('ws://x/api/remote.mux');
  await new Promise(resolve => setTimeout(resolve, 0));
  const streamId = onlyStream(sent);

  const closed: { code: number; reason: string }[] = [];
  (socket as unknown as { onclose: ((event: { code: number; reason: string }) => void) | null }).onclose =
    event => closed.push(event);
  reply(streamId, opened(streamId, 500));
  assert.equal(closed.length, 1, 'a refused upgrade must end the socket');
  assert.equal(socket.readyState, 3);
});

test('closing sends the frame that ends it and stops delivering', async () => {
  const { tunnel, sent, reply, handlers } = standIn();
  const Socket = tunneledWebSocket(tunnel, allocator());
  const socket = new Socket('ws://x/api/remote.mux');
  await new Promise(resolve => setTimeout(resolve, 0));
  const streamId = onlyStream(sent);
  reply(streamId, opened(streamId));

  const seen: unknown[] = [];
  (socket as unknown as { onmessage: ((event: { data: unknown }) => void) | null }).onmessage =
    event => seen.push(event.data);

  socket.close();
  const last = readSent(sent.at(-1)?.payload as Uint8Array<ArrayBuffer>);
  assert.equal(last.tag, 10, 'wsData');
  // A close is a data message with no payload: the kind lives in what follows the id, and the
  // daemon reads an absent string as the end of the connection.
  assert.equal(last.text, '');
  assert.equal(handlers.has(streamId), false, 'and it stops listening');
  assert.equal(socket.readyState, 3);
});

test('sending before it opens throws, as the platform does', async () => {
  const { tunnel } = standIn();
  const Socket = tunneledWebSocket(tunnel, allocator());
  const socket = new Socket('ws://x/api/remote.mux');
  assert.throws(() => socket.send('too early'), /not open yet/);
});

test('every socket gets its own stream', async () => {
  // Two sockets on one stream would interleave two conversations into one, which is the same
  // failure the per-request streams exist to prevent.
  const { tunnel, sent } = standIn();
  const Socket = tunneledWebSocket(tunnel, allocator());
  void new Socket('ws://x/a');
  void new Socket('ws://x/b');
  await new Promise(resolve => setTimeout(resolve, 0));
  const streams = new Set(sent.map(entry => entry.streamId));
  assert.equal(streams.size, 2, 'one stream per socket');
});

test('the upgrade encoder refuses a target that names a host', () => {
  // Belt and braces with the daemon's own refusal: a target the daemon would reject is a target
  // this client should not be able to express.
  assert.throws(() => encodeWsOpen(1, 'ws://evil.example/x'), /origin-form/);
  assert.throws(() => encodeWsOpen(1, '//evil.example/x'), /origin-form/);
});
