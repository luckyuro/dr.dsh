/**
 * The worker's tunnel service, driven with two ends of a real `MessageChannel`.
 *
 * A real channel rather than a fake port: the thing most likely to be wrong here is the
 * message protocol between two globals, and a hand-written port would be written to agree
 * with whichever side the test author had in mind.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { WorkerTunnel, WorkerViews, injectWebSocketBootstrap, offlineResponse, toOutbound, toResponse, type Inbound } from './worker-service.ts';

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
  assert.equal(await toResponse(answer).text(), '<html>ok</html>');
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
  assert.equal(await toResponse(first).text(), '/slow.css');
  assert.equal(await toResponse(second).text(), '/fast.js');
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

test('replacing a port rejects its pending requests before accepting the new page', async () => {
  const { service } = channel();
  const pending = service.fetch({ method: 'GET', path: '/slow', headers: [], body: new Uint8Array(0) });
  const rejected = assert.rejects(pending, /detached/);
  const replacement = new MessageChannel();
  channels.push(replacement);
  service.attach(replacement.port1);
  await rejected;
  pageEnd(replacement.port2, request => ({ kind: 'response', id: request.id as number, status: 204, headers: [], body: new ArrayBuffer(0) }));
  assert.equal((await service.fetch({ method: 'GET', path: '/new', headers: [], body: new Uint8Array(0) })).status, 204);
});

const VIEW_A = '11111111-1111-4111-8111-111111111111';
const VIEW_B = '22222222-2222-4222-8222-222222222222';
const VIEW_C = '33333333-3333-4333-8333-333333333333';

function attachView(views: WorkerViews, owner: string, viewId: string, status: number): void {
  const pair = new MessageChannel();
  channels.push(pair);
  views.attach(owner, viewId, pair.port1);
  pageEnd(pair.port2, request => ({ kind: 'response', id: request.id as number, status, headers: [], body: new ArrayBuffer(0) }));
}

test('two parent pages route HTTP to their own rooms through document navigation and pushState', async () => {
  const views = new WorkerViews();
  attachView(views, 'shell-a', VIEW_A, 201);
  attachView(views, 'shell-b', VIEW_B, 202);
  for (const [owner, child, viewId] of [['shell-a', 'frame-a', VIEW_A], ['shell-b', 'frame-b', VIEW_B]]) {
    views.route({ clientId: owner!, requestUrl: `https://relay.example/__dr/interface?drdshView=${viewId}`, resultingClientId: child! });
  }
  const a = views.route({ clientId: 'frame-a', clientUrl: 'https://relay.example/sessions/one', requestUrl: 'https://relay.example/api/state' });
  const b = views.route({ clientId: 'frame-b', clientUrl: 'https://relay.example/sessions/two', requestUrl: 'https://relay.example/api/state' });
  const request = { method: 'GET', path: '/api/state', headers: [], body: new Uint8Array(0) };
  assert.equal((await a.tunnel.fetch(request)).status, 201);
  assert.equal((await b.tunnel.fetch(request)).status, 202);
  views.route({ clientId: 'frame-a', requestUrl: 'https://relay.example/', resultingClientId: 'frame-a-after-navigation' });
  assert.equal(views.route({ clientId: 'frame-a-after-navigation', requestUrl: 'https://relay.example/api/state' }).viewId, VIEW_A);
  assert.throws(() => views.route({ clientId: 'unrelated', requestUrl: 'https://relay.example/api/state' }), /no connected parent/);
});

test('room replacement removes old document routes without stealing another parent or document', () => {
  const views = new WorkerViews();
  attachView(views, 'shell-a', VIEW_A, 201);
  attachView(views, 'shell-b', VIEW_B, 202);
  views.bind('frame-a', VIEW_A);
  views.bind('frame-b', VIEW_B);
  assert.throws(() => views.bind('frame-a', VIEW_B), /another interface/);
  assert.throws(() => views.route({ clientId: 'shell-a', requestUrl: `https://relay.example/__dr/interface?drdshView=${VIEW_B}` }), /another page/);
  const intruder = new MessageChannel();
  channels.push(intruder);
  assert.throws(() => views.attach('shell-b', VIEW_A, intruder.port1), /another page/);
  attachView(views, 'shell-a', VIEW_C, 203);
  assert.throws(() => views.route({ clientId: 'frame-a', requestUrl: 'https://relay.example/api/state' }), /no connected parent/);
  assert.equal(views.route({ clientId: 'frame-b', requestUrl: 'https://relay.example/api/state' }).viewId, VIEW_B);
  views.detach('shell-a', VIEW_B);
  assert.equal(views.route({ clientId: 'frame-b', requestUrl: 'https://relay.example/api/state' }).viewId, VIEW_B);
});

test('a restarted worker requires a registered owner and can rebind a document whose URL lost its view query', () => {
  const views = new WorkerViews();
  assert.throws(() => views.bind('frame-a', VIEW_A), /not ready/);
  attachView(views, 'shell-a', VIEW_A, 201);
  assert.throws(() => views.route({ clientId: 'frame-a', clientUrl: 'https://relay.example/sessions/one', requestUrl: 'https://relay.example/api/state' }), /no connected parent/);
  views.bind('frame-a', VIEW_A);
  assert.equal(views.route({ clientId: 'frame-a', clientUrl: 'https://relay.example/sessions/one', requestUrl: 'https://relay.example/api/state' }).viewId, VIEW_A);
});

test('cold worker recovery waits for the original document without routing through another restored room', async () => {
  const views = new WorkerViews();
  let resolved = false;
  const waiting = views.waitForRoute({ clientId: 'frame-a', clientUrl: 'https://relay.example/sessions/one', requestUrl: 'https://relay.example/api/state' });
  void waiting.then(() => { resolved = true; });
  attachView(views, 'shell-b', VIEW_B, 202);
  views.bind('frame-b', VIEW_B);
  attachView(views, 'shell-a', VIEW_A, 201);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(resolved, false, 'restoring the parent alone cannot guess which document it owns');
  views.bind('frame-a', VIEW_A);
  const route = await waiting;
  assert.equal(route.viewId, VIEW_A);
  assert.equal((await route.tunnel.fetch({ method: 'GET', path: '/api/state', headers: [], body: new Uint8Array(0) })).status, 201);
  assert.equal(views.route({ clientId: 'frame-b', requestUrl: 'https://relay.example/api/state' }).viewId, VIEW_B);
});

test('cold worker recovery is bounded when no original parent can restore the document', async () => {
  const views = new WorkerViews();
  attachView(views, 'unrelated-shell', VIEW_B, 202);
  await assert.rejects(views.waitForRoute({ clientId: 'missing', requestUrl: 'https://relay.example/api/state' }, 10), /could not be restored/);
});

test('retiring a worker ends long responses and restoration waits without allowing its routes to restart', async () => {
  const views = new WorkerViews();
  const pair = new MessageChannel();
  channels.push(pair);
  views.attach('shell-a', VIEW_A, pair.port1);
  const route = views.route({ clientId: 'shell-a', requestUrl: 'https://relay.example/events' });
  const response = assert.rejects(route.tunnel.fetch({ method: 'GET', path: '/events', headers: [], body: new Uint8Array(0) }), /detached/);
  const restoring = assert.rejects(views.waitForRoute({ clientId: 'missing', requestUrl: 'https://relay.example/api/state' }), /worker is updating/);
  views.retire();
  await Promise.all([response, restoring]);
  assert.equal(views.isRetired, true);
  assert.throws(() => views.route({ clientId: 'shell-a', requestUrl: 'https://relay.example/' }), /worker is updating/);
  assert.throws(() => views.attach('shell-a', VIEW_A, pair.port1), /worker is updating/);
  assert.throws(() => views.bind('frame-a', VIEW_A), /worker is updating/);
  views.retire();
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
  assert.equal(await toResponse(second).text(), 'answered');
  // Settle the first so the test does not leave a pending promise behind.
  service.detach();
  await assert.rejects(pending, /detached/);
});

test('a late streamed answer cancels its producer', { timeout: 2000 }, async () => {
  const { service, page } = channel();
  let cancel!: () => void;
  const cancelled = new Promise<void>(resolve => { cancel = resolve; });
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({ cancel });
  page.postMessage({ kind: 'response-stream', id: 999, status: 200, headers: [], body }, [body]);
  try {
    await cancelled;
  } finally {
    service.detach();
  }
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

test('view routing stays out of DSH queries and is injected only into an interface document', async () => {
  const request = new Request(`https://relay.example/__dr/interface?drdshView=${VIEW_A}&mode=web`);
  assert.equal((await toOutbound(request, 'https://relay.example')).path, '/?mode=web');
  const html = new TextEncoder().encode('<html><head><script>boot()</script></head></html>');
  const embedded = new TextDecoder().decode(injectWebSocketBootstrap(html, 'text/html', true, VIEW_A));
  assert.match(embedded, new RegExp(`data-drdsh-view="${VIEW_A}"`));
  assert.ok(embedded.indexOf('/client/ws-bootstrap.js') < embedded.indexOf('boot()'));
  assert.deepEqual(injectWebSocketBootstrap(html, 'text/html', false, VIEW_A), html);
  const response = toResponse({ status: 200, headers: [['x-frame-options', 'SAMEORIGIN'], ['content-security-policy', "frame-ancestors 'self'"]], body: html });
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(response.headers.get('content-security-policy'), "frame-ancestors 'self'");
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
