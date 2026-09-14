/**
 * The proxy client's encode/collect logic, without a browser or a daemon.
 *
 * The daemon side of this plane has its own tests; these cover the client's half, which is
 * where a streamed response is easy to get wrong — a head mistaken for the whole answer, a
 * body ignored, or an end never noticed.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ResponseCollector, decodeMessage, encodeRequest } from './proxy.ts';
import { TunnelError } from './tunnel.ts';

/** Rebuilds a daemon-side message for the decoder to read. */
function daemonMessage(tag: number, body: readonly number[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array([0x50, 0x58, 0x01, tag, ...body]);
}

/** A big-endian u64. */
function u64(value: number): number[] {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), false);
  return [...out];
}

/** A length-prefixed string. */
function text(value: string): number[] {
  const bytes = new TextEncoder().encode(value);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, bytes.length, false);
  return [...length, ...bytes];
}

test('a request encodes to the layout the daemon decodes', () => {
  const encoded = encodeRequest(7, 'GET', '/api/session/list?limit=5', {
    headers: [['accept', 'application/json']],
  });
  // 'PX', version, RequestStart tag
  assert.deepEqual([...encoded.subarray(0, 4)], [0x50, 0x58, 0x01, 0x01]);
  assert.deepEqual([...encoded.subarray(4, 12)], u64(7), 'the id follows the tag');
  const expectedTail = [...text('GET'), ...text('/api/session/list?limit=5')];
  assert.deepEqual([...encoded.subarray(12, 12 + expectedTail.length)], expectedTail);
});

test('a body gets a content-length the client did not have to compute', () => {
  // The daemon refuses a body whose declared length disagrees with what arrived, so the
  // encoder supplying it is what keeps a caller from having to remember.
  const body = new TextEncoder().encode('{"q":"x"}');
  const encoded = encodeRequest(1, 'POST', '/api/session/search', { body });
  const decoded = new TextDecoder().decode(encoded);
  assert.ok(decoded.includes('content-length'), 'the header must be present');
  assert.ok(decoded.includes(String(body.length)), 'and must match the body');
});

test('a target that names a host is refused at the call site', () => {
  for (const target of ['http://example.com/', '//example.com/', '/../etc/passwd', 'relative']) {
    assert.throws(() => encodeRequest(1, 'GET', target), TunnelError, target);
  }
});

test('a non-proxy payload is not this plane’s business', () => {
  assert.equal(decodeMessage(new Uint8Array([0x7b, 0x7d])), undefined, 'JSON is the control plane');
  assert.equal(decodeMessage(new TextEncoder().encode('{"kind":"status_request"}')), undefined);
});

test('a response head decodes with its status and headers', () => {
  const headers = [0, 1, ...text('location'), ...text('/')];
  const message = decodeMessage(daemonMessage(4, [...u64(7), 0, 195, ...headers]));
  assert.deepEqual(message, {
    kind: 'responseStart',
    id: 7,
    status: 195,
    headers: new Map([['location', '/']]),
  });
});

test('a failure decodes with its reason', () => {
  const message = decodeMessage(daemonMessage(7, [...u64(3), ...text('DSH is not answering')]));
  assert.deepEqual(message, { kind: 'failure', id: 3, reason: 'DSH is not answering' });
});

test('an unknown message type is refused rather than ignored', () => {
  // Ignoring it would leave the collector waiting for an end that this client cannot
  // recognise, which looks exactly like a hung request.
  assert.throws(() => decodeMessage(daemonMessage(40, [])), TunnelError);
});

test('a streamed response assembles from head, chunks, and end', async () => {
  const collector = new ResponseCollector();
  const message = decodeMessage(
    daemonMessage(4, [...u64(1), 0, 200, 0, 0]),
  );
  assert.ok(message !== undefined);
  collector.absorb(message);
  for (const chunk of ['first ', 'second ', 'third']) {
    const body = decodeMessage(daemonMessage(5, text(chunk)));
    assert.ok(body !== undefined);
    collector.absorb(body);
  }
  const end = decodeMessage(daemonMessage(6, []));
  assert.ok(end !== undefined);
  collector.absorb(end);

  const response = await collector.response();
  assert.equal(response.head.status, 200);
  assert.equal(new TextDecoder().decode(response.body), 'first second third');
});

test('a response that arrives before it is awaited is not lost', async () => {
  // A fast daemon answers while the caller is still setting up. If the collector only
  // resolved a promise that happened to be waiting, this exchange would hang forever —
  // which is exactly what a real run did before this was fixed.
  const collector = new ResponseCollector();
  const head = decodeMessage(daemonMessage(4, [...u64(1), 0, 200, 0, 0]));
  const body = decodeMessage(daemonMessage(5, text('early answer')));
  const end = decodeMessage(daemonMessage(6, []));
  assert.ok(head !== undefined && body !== undefined && end !== undefined);
  collector.absorb(head);
  collector.absorb(body);
  collector.absorb(end);

  // Only now does anyone ask.
  const response = await collector.response();
  assert.equal(response.head.status, 200);
  assert.equal(new TextDecoder().decode(response.body), 'early answer');
});

test('a failure that arrives before it is awaited is not lost either', async () => {
  const collector = new ResponseCollector();
  const failure = decodeMessage(daemonMessage(7, [...u64(1), ...text('refused early')]));
  assert.ok(failure !== undefined);
  collector.absorb(failure);
  await assert.rejects(collector.response(), TunnelError);
});

test('a response with no body is a response, not a hang', async () => {
  const collector = new ResponseCollector();
  const head = decodeMessage(daemonMessage(4, [...u64(1), 1, 44, 0, 0]));
  const end = decodeMessage(daemonMessage(6, []));
  assert.ok(head !== undefined && end !== undefined);
  collector.absorb(head);
  collector.absorb(end);
  const response = await collector.response();
  assert.equal(response.head.status, 300);
  assert.equal(response.body.length, 0);
});

test('a failure rejects rather than resolving empty', async () => {
  const collector = new ResponseCollector();
  const failure = decodeMessage(daemonMessage(7, [...u64(1), ...text('no daemon is serving this room')]));
  assert.ok(failure !== undefined);
  collector.absorb(failure);
  await assert.rejects(collector.response(), TunnelError);
  assert.equal(collector.error, 'no daemon is serving this room');
});

test('a body before its head is refused', () => {
  const collector = new ResponseCollector();
  const body = decodeMessage(daemonMessage(5, text('orphan')));
  assert.ok(body !== undefined);
  assert.throws(() => collector.absorb(body), TunnelError);
});

test('a response that ends without a head is refused', () => {
  const collector = new ResponseCollector();
  const end = decodeMessage(daemonMessage(6, []));
  assert.ok(end !== undefined);
  assert.throws(() => collector.absorb(end), TunnelError);
});

test('a truncated message is refused instead of reading past its buffer', () => {
  // A length prefix promising more than the payload holds: the reader must refuse rather
  // than slice out of bounds and hand the caller nonsense.
  const truncated = new Uint8Array([0x50, 0x58, 0x01, 0x05, 0, 0, 0, 40, 1, 2, 3]);
  assert.throws(() => decodeMessage(truncated), TunnelError);
});
