/**
 * The worker's tunnel service, driven with two ends of a real `MessageChannel`.
 *
 * A real channel rather than a fake port: the thing most likely to be wrong here is the
 * message protocol between two globals, and a hand-written port would be written to agree
 * with whichever side the test author had in mind.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { WorkerTunnel, offlineResponse, toOutbound, toResponse, type Inbound } from './worker-service.ts';

/** A page end of the channel, playing the daemon-proxy side. */
function pageEnd(port: MessagePort, answer: (request: Record<string, unknown>) => Inbound | Promise<Inbound>) {
  port.onmessage = (event: MessageEvent) => {
    const message = event.data as { kind: string; id: number };
    if (message.kind !== 'request') return;
    void Promise.resolve(answer(event.data as Record<string, unknown>)).then(reply => {
      port.postMessage(reply);
    });
  };
  port.start();
}

/**
 * A channel with a service on the worker end.
 *
 * The channel is tracked so the test's teardown can close it: an open `MessagePort` keeps
 * Node's event loop alive, and a test file that never exits is a test file that fails by
 * timeout rather than by assertion.
 */
function channel(): { service: WorkerTunnel; page: MessagePort } {
  const pair = new MessageChannel();
  const service = new WorkerTunnel();
  service.attach(pair.port1);
  const page = pair.port2;
  channels.push(pair);
  return { service, page };
}

/** Every channel a test opened, released after it finishes. */
const channels: MessageChannel[] = [];

/**
 * A `MessagePort` keeps Node's event loop alive by default, so a test file that opens one
 * never exits — it fails by timeout instead of by assertion. `unref` takes the port out of
 * the loop's accounting; `close` then releases it.
 */
function release(port: MessagePort): void {
  (port as unknown as { unref?: () => void }).unref?.();
  port.close();
}

afterEach(() => {
  for (const pair of channels.splice(0)) {
    release(pair.port1);
    release(pair.port2);
  }
});

test('a request travels over the port and its answer comes back', async () => {
  const { service, page } = channel();
  pageEnd(page, request => ({
    kind: 'response',
    id: request.id as number,
    status: 200,
    headers: [['content-type', 'text/html']],
    body: new TextEncoder().encode('<html>ok</html>').buffer as ArrayBuffer,
  }));

  const answer = await service.fetch({
    method: 'GET',
    path: '/index.html',
    headers: [],
    body: new Uint8Array(0),
  });
  assert.equal(answer.status, 200);
  assert.equal(new TextDecoder().decode(answer.body), '<html>ok</html>');
});

test('two requests in flight do not swap answers', async () => {
  // A page load fetches a document, a stylesheet, and a script together; without the id
  // their answers would be interchangeable.
  const { service, page } = channel();
  pageEnd(page, request => ({
    kind: 'response',
    id: request.id as number,
    status: 200,
    headers: [],
    body: new TextEncoder().encode(String(request.path)).buffer as ArrayBuffer,
  }));

  const [first, second] = await Promise.all([
    service.fetch({ method: 'GET', path: '/slow.css', headers: [], body: new Uint8Array(0) }),
    service.fetch({ method: 'GET', path: '/fast.js', headers: [], body: new Uint8Array(0) }),
  ]);
  assert.equal(new TextDecoder().decode(first.body), '/slow.css');
  assert.equal(new TextDecoder().decode(second.body), '/fast.js');
});

test('a failure from the page becomes a readable error', async () => {
  const { service, page } = channel();
  pageEnd(page, request => ({
    kind: 'failed',
    id: request.id as number,
    reason: 'DSH is not answering on loopback',
  }));
  await assert.rejects(
    service.fetch({ method: 'GET', path: '/', headers: [], body: new Uint8Array(0) }),
    /DSH is not answering/,
  );
});

test('a request with no tunnel says so instead of hanging', async () => {
  // The likeliest real state: the worker is running but the page has not paired yet.
  const service = new WorkerTunnel();
  assert.equal(service.isAttached, false);
  await assert.rejects(
    service.fetch({ method: 'GET', path: '/', headers: [], body: new Uint8Array(0) }),
    /not paired/,
  );
});

test('attaching a new tunnel replaces the old one', async () => {
  const { service, page: first } = channel();
  pageEnd(first, request => ({
    kind: 'response',
    id: request.id as number,
    status: 200,
    headers: [],
    body: new ArrayBuffer(0),
  }));
  await service.fetch({ method: 'GET', path: '/', headers: [], body: new Uint8Array(0) });

  const second = new MessageChannel();
  channels.push(second);
  service.attach(second.port1);
  pageEnd(second.port2, request => ({
    kind: 'response',
    id: request.id as number,
    status: 204,
    headers: [],
    body: new ArrayBuffer(0),
  }));
  const answer = await service.fetch({ method: 'GET', path: '/', headers: [], body: new Uint8Array(0) });
  assert.equal(answer.status, 204, 'the new tunnel answers');
});

test('detaching fails what is in flight rather than leaving it pending', async () => {
  const { service, page } = channel();
  // A page that never answers.
  pageEnd(page, () => new Promise<Inbound>(() => {}));
  const pending = service.fetch({ method: 'GET', path: '/', headers: [], body: new Uint8Array(0) });
  service.detach();
  await assert.rejects(pending, /detached/);
  assert.equal(service.isAttached, false);
});

test('a late answer for an unknown request is dropped, not thrown', async () => {
  // A page that answers with an id nobody is waiting for — a stale reply after a reload.
  // The worker must ignore it rather than throw inside its own message handler, and the
  // request that *is* waiting must still be answerable afterwards.
  const { service, page } = channel();
  let seen = 0;
  page.onmessage = (event: MessageEvent) => {
    const message = event.data as { kind: string; id: number };
    if (message.kind !== 'request') return;
    seen += 1;
    if (seen === 1) {
      page.postMessage({ kind: 'response', id: 999, status: 200, headers: [], body: new ArrayBuffer(0) });
      return;
    }
    page.postMessage({
      kind: 'response',
      id: message.id,
      status: 200,
      headers: [],
      body: new TextEncoder().encode('answered').buffer as ArrayBuffer,
    });
  };
  page.start();

  // The first request is answered only by the stray id, so it stays pending; that is the
  // behaviour under test — the worker is still alive to serve the second.
  const pending = service.fetch({ method: 'GET', path: '/first', headers: [], body: new Uint8Array(0) });
  await new Promise(resolve => setTimeout(resolve, 20));
  const second = await service.fetch({ method: 'GET', path: '/second', headers: [], body: new Uint8Array(0) });
  assert.equal(new TextDecoder().decode(second.body), 'answered');
  // Settle the first so the test does not leave a pending promise behind.
  service.detach();
  await assert.rejects(pending, /detached/);
});

test('a page request becomes an origin-form tunnel request', async () => {
  const request = new Request('https://relay.example/api/session/list?limit=5', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"q":1}',
  });
  const outbound = await toOutbound(request, 'https://relay.example');
  assert.equal(outbound.method, 'POST');
  assert.equal(outbound.path, '/api/session/list?limit=5');
  assert.ok(outbound.headers.some(([name]) => name === 'content-type'));
  assert.equal(new TextDecoder().decode(outbound.body), '{"q":1}');
});

test('a GET carries no body even when the browser would allow one', async () => {
  const request = new Request('https://relay.example/', { method: 'GET' });
  const outbound = await toOutbound(request, 'https://relay.example');
  assert.equal(outbound.body.length, 0);
});

test('a request for another origin is refused', async () => {
  // The worker should only ever see its own origin, but a mistake here would forward a
  // third party's request into the tunnel.
  const request = new Request('https://evil.example/steal');
  await assert.rejects(toOutbound(request, 'https://relay.example'), /another origin/);
});

test('framing headers DSH sent are not passed to the browser', () => {
  // The browser is handed the bytes directly; a stale content-length or content-encoding
  // would truncate or mangle the page.
  const response = toResponse({
    status: 200,
    headers: [
      ['content-length', '99999'],
      ['content-encoding', 'gzip'],
      ['content-type', 'text/html'],
    ],
    body: new TextEncoder().encode('plain'),
  });
  assert.equal(response.headers.get('content-length'), null);
  assert.equal(response.headers.get('content-encoding'), null);
  assert.equal(response.headers.get('content-type'), 'text/html');
});

test('the offline response says why, in words a person can act on', async () => {
  const response = offlineResponse('DSH is not answering on loopback');
  assert.equal(response.status, 503);
  assert.match(await response.text(), /DSH is not answering/);
});
