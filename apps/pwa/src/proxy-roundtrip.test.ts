/**
 * A full client-side round trip against a stand-in daemon: encode a request, feed the
 * answer back through the collector, and assert the assembled response.
 *
 * The unit tests above cover the pieces; this covers the path `request()` actually takes —
 * subscribe, send, collect — which is where ordering bugs live. It exists because a live
 * run stalled with every piece passing its own test.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { encodeRequest, request } from './proxy.ts';
import type { Tunnel } from './tunnel.ts';

/** A tunnel that replays a scripted response as soon as a request is sent. */
function scriptedTunnel(script: (streamId: number) => Uint8Array<ArrayBuffer>[]): {
  tunnel: Tunnel;
  sent: { streamId: number; payload: Uint8Array }[];
  handlers: Map<number, (payload: Uint8Array<ArrayBuffer>) => void>;
  closed: Set<(reason: string) => void>;
} {
  const handlers = new Map<number, (payload: Uint8Array<ArrayBuffer>) => void>();
  const closed = new Set<(reason: string) => void>();
  const sent: { streamId: number; payload: Uint8Array }[] = [];
  const tunnel = {
    on(streamId: number, handler: (payload: Uint8Array<ArrayBuffer>) => void) {
      handlers.set(streamId, handler);
      return () => { if (handlers.get(streamId) === handler) handlers.delete(streamId); };
    },
    onClosed(handler: (reason: string) => void) { closed.add(handler); return () => closed.delete(handler); },
    async send(streamId: number, payload: Uint8Array<ArrayBuffer>) {
      sent.push({ streamId, payload });
      // Delivered synchronously on purpose: a daemon that answers before the caller awaits
      // is the case that stalled a live run.
      for (const frame of script(streamId)) handlers.get(streamId)?.(frame);
    },
  } as unknown as Tunnel;
  return { tunnel, sent, handlers, closed };
}

/** A daemon-side message. */
function message(tag: number, body: readonly number[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array([0x50, 0x58, 0x01, tag, ...body]);
}

function u64(value: number): number[] {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), false);
  return [...out];
}

function text(value: string): number[] {
  const bytes = new TextEncoder().encode(value);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, bytes.length, false);
  return [...length, ...bytes];
}

test('a request round-trips through a daemon that answers immediately', async () => {
  const { tunnel, sent } = scriptedTunnel(() => [
    message(4, [...u64(1), 0, 200, 0, 0]),
    message(5, text('<html>')),
    message(5, text('body</html>')),
    message(6, []),
  ]);
  const response = await request(tunnel, 3, encodeRequest(1, 'GET', '/'));
  assert.equal(response.head.status, 200);
  assert.equal(new TextDecoder().decode(response.body), '<html>body</html>');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.streamId, 3, 'the request goes out on the stream it was given');
});

test('a refusal surfaces as an error rather than an empty response', async () => {
  const { tunnel } = scriptedTunnel(() => [message(7, [...u64(1), ...text('no daemon is serving this room')])]);
  await assert.rejects(
    request(tunnel, 1, encodeRequest(1, 'GET', '/')),
    /no daemon is serving this room/,
  );
});

test('the subscription is released after the exchange', async () => {
  const handlers = new Map<number, unknown>();
  const tunnel = {
    onClosed: () => () => {},
    on(streamId: number, handler: unknown) {
      handlers.set(streamId, handler);
      return () => handlers.delete(streamId);
    },
    async send(streamId: number) {
      const deliver = handlers.get(streamId) as (payload: Uint8Array<ArrayBuffer>) => void;
      deliver(message(4, [...u64(1), 0, 204, 0, 0]));
      deliver(message(6, []));
    },
  } as unknown as Tunnel;
  await request(tunnel, 5, encodeRequest(1, 'GET', '/'));
  assert.equal(handlers.size, 0, 'a leaked subscription would collect the next response too');
});

test('carrier closure rejects an unfinished HTTP response and releases its subscriptions', async () => {
  const { tunnel, handlers, closed } = scriptedTunnel(() => [message(4, [...u64(1), 0, 200, 0, 0]), message(5, text('partial body'))]);
  const pending = request(tunnel, 7, encodeRequest(1, 'GET', '/events'));
  const rejected = assert.rejects(pending, /carrier ended/);
  for (const notify of closed) notify('carrier ended');
  await rejected;
  assert.equal(handlers.size, 0);
  assert.equal(closed.size, 0);
});

test('aborting a request drops its collector immediately and drains late frames until the response ends', async () => {
  const { tunnel, handlers, closed } = scriptedTunnel(() => [message(4, [...u64(1), 0, 200, 0, 0]), message(5, text('partial body'))]);
  const abort = new AbortController();
  const pending = request(tunnel, 9, encodeRequest(1, 'GET', '/events'), abort.signal);
  const rejected = assert.rejects(pending, /cancelled/);
  abort.abort();
  await rejected;
  assert.equal(handlers.size, 1, 'late data must be discarded instead of buffered as unmatched tunnel frames');
  assert.equal(closed.size, 1);
  assert.doesNotThrow(() => handlers.get(9)?.(message(5, [])), 'the cancelled collector must no longer decode or retain body chunks');
  handlers.get(9)?.(message(6, []));
  assert.equal(handlers.size, 0);
  assert.equal(closed.size, 0);
});

test('abort does not wait for an in-progress send, and carrier closure releases its discard subscription', async () => {
  const { tunnel, handlers, closed } = scriptedTunnel(() => []);
  let finishSend!: () => void;
  tunnel.send = () => new Promise<void>(resolve => { finishSend = resolve; });
  const abort = new AbortController();
  const pending = request(tunnel, 11, encodeRequest(1, 'GET', '/slow'), abort.signal);
  const rejected = assert.rejects(pending, /cancelled/);
  abort.abort();
  await rejected;
  assert.equal(handlers.size, 1);
  for (const notify of closed) notify('carrier ended');
  assert.equal(handlers.size, 0);
  assert.equal(closed.size, 0);
  finishSend();
});

test('an already aborted request never enters the tunnel', async () => {
  const { tunnel, handlers, closed, sent } = scriptedTunnel(() => []);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(request(tunnel, 13, encodeRequest(1, 'GET', '/unused'), abort.signal), /cancelled/);
  assert.equal(sent.length, 0);
  assert.equal(handlers.size, 0);
  assert.equal(closed.size, 0);
});
