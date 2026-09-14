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
} {
  const handlers = new Map<number, (payload: Uint8Array<ArrayBuffer>) => void>();
  const sent: { streamId: number; payload: Uint8Array }[] = [];
  const tunnel = {
    on(streamId: number, handler: (payload: Uint8Array<ArrayBuffer>) => void) {
      handlers.set(streamId, handler);
      return () => handlers.delete(streamId);
    },
    async send(streamId: number, payload: Uint8Array<ArrayBuffer>) {
      sent.push({ streamId, payload });
      // Delivered synchronously on purpose: a daemon that answers before the caller awaits
      // is the case that stalled a live run.
      for (const frame of script(streamId)) handlers.get(streamId)?.(frame);
    },
  } as unknown as Tunnel;
  return { tunnel, sent };
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
