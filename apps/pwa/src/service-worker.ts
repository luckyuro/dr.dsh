/**
 * The PWA's service worker: it makes the DSH Web UI work from the relay's origin.
 *
 * ## The shape of the fix
 *
 * DSH serves its interface for its own origin and authenticates by the authority it is
 * reached under. A remote page is at the relay's origin, so its requests cannot go to DSH
 * directly — and they cannot simply be rewritten to a path on the relay either, because the
 * worker intercepts its own fetches and that recursion is a page that never loads.
 *
 * So the answer is not a rewritten URL but a **port**: the page opens a tunnel, hands the
 * worker one end of a `MessageChannel`, and every intercepted request becomes one message
 * over it. The page performs the exchange through the tunnel (`proxy.ts`); the worker only
 * forwards. Neither side parses DSH's protocol.
 *
 * ## Why this file is thin
 *
 * All the logic lives in `worker-service.ts`, which is tested with two real channel ends in
 * Node. What is left here is the part no test runner can drive: the worker's global scope,
 * its event handlers, and the `respondWith` plumbing. Keeping that residue small is the
 * point — it is the code that can only be verified by opening a browser.
 *
 * @module @dr.dsh/pwa/service-worker
 */

import { OFFLINE_CACHE, PRECACHE_PATHS, isCacheable } from './offline.ts';
import { INTERFACE_PATH, TUNNEL_PREFIX, isInterceptablePath } from './routing.ts';
import { MissingWorkerView, WorkerViews, injectWebSocketBootstrap, offlineResponse, toOutbound, toResponse, validViewId } from './worker-service.ts';

const worker = self as unknown as ServiceWorkerGlobalScope;

/** Each top-level shell owns a separate tunnel, including when rooms share one origin. */
const views = new WorkerViews();
let restoration: Promise<void> | undefined;

function restoreViews(): Promise<void> {
  // Worker termination preserves its registration but loses all ports; it does not fire
  // controllerchange. Each live shell can restore only its own view through the usual handshake.
  restoration ??= worker.clients.matchAll({ type: 'window' }).then(clients => {
    if (views.isRetired) return;
    for (const client of clients) {
      if (client.frameType === 'top-level' && new URL(client.url).origin === worker.location.origin) {
        client.postMessage({ kind: 'restore-views' });
      }
    }
  });
  return restoration;
}

worker.addEventListener('install', event => {
  // Cache the client's own files, then take over immediately: a page that is only half-controlled
  // shows the relay's own answer for DSH paths, which is the confusing failure this whole design
  // avoids.
  event.waitUntil(precache());
});

worker.addEventListener('activate', event => {
  event.waitUntil(worker.clients.claim());
});

worker.addEventListener('message', event => {
  const message = event.data as { kind?: string; viewId?: unknown } | null;
  if (message?.kind === 'retire-views') {
    // A page cannot retire another room's route. Only our registered replacement can
    // release responses (including DSH's endless event stream) that block its activation.
    if (event.source && (event.source === worker.registration.installing || event.source === worker.registration.waiting)) views.retire();
    return;
  }
  if (!message || !['hand', 'bind-view', 'unhand'].includes(message.kind ?? '')) return;
  const port = event.ports[0];
  if (views.isRetired) { port?.close(); return; }
  const source = event.source;
  try {
    if (!source || !('id' in source) || source.type !== 'window'
      || new URL(source.url).origin !== worker.location.origin || !validViewId(message.viewId)) {
      throw new Error('the interface route is invalid; reconnect this page');
    }
    if (message.kind === 'hand') {
      if (source.frameType !== 'top-level' || !port) throw new Error('only the parent page can connect an interface tunnel');
      views.attach(source.id, message.viewId, port);
      port.postMessage({ kind: 'handed', viewId: message.viewId });
    } else if (message.kind === 'bind-view') {
      if (source.frameType !== 'nested' || !port) throw new Error('only an embedded interface can bind its document');
      views.bind(source.id, message.viewId);
      port.postMessage({ kind: 'bound', viewId: message.viewId });
      port.close();
    } else {
      views.detach(source.id, message.viewId);
    }
  } catch (error) {
    port?.postMessage({ kind: 'failed', reason: error instanceof Error ? error.message : 'the interface route could not be connected' });
    port?.close();
  }
});

worker.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== worker.location.origin) return;
  // A root navigation inside Harness still belongs to that document's machine;
  // only the top-level shell is eligible for the offline shell cache.
  if (request.mode === 'navigate' && (url.pathname === '/' || url.pathname === INTERFACE_PATH)) {
    event.respondWith(interfaceNavigation(event));
    return;
  }
  // The client's own files first, from the cache: with no network they are the difference between a
  // page that explains the outage and a browser error page (M3). DSH's content is never cached — see
  // `offline.ts`.
  if (isCacheable(url.pathname, request.method, request.mode)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  // The mode is passed in because `/` means the shell for a navigation and DSH's root for
  // everything else — see `SHELL_PATH`.
  if (!isInterceptablePath(url.pathname, request.mode)) return;
  event.respondWith(serve(event));
});

async function interfaceNavigation(event: FetchEvent): Promise<Response> {
  const clientId = fetchClientId(event);
  const client = clientId ? await worker.clients.get(clientId) : undefined;
  if (client?.frameType === 'nested' || views.isDocument(clientId) || event.request.destination === 'iframe') return serve(event, client);
  // Old bookmarks opened Harness without a parent. That page cannot own a tunnel;
  // return it to the connection shell instead of waiting for a parent that cannot reply.
  if (new URL(event.request.url).pathname === INTERFACE_PATH) return Response.redirect(new URL('/', worker.location.origin), 303);
  return cacheFirst(event.request);
}

function fetchClientId(event: FetchEvent): string {
  // Some engines expose the replaced document for navigations; others omit it.
  // An absent identifier must stay unbound instead of selecting another page's tunnel.
  return event.clientId || (event as FetchEvent & { replacesClientId?: string }).replacesClientId || '';
}

/** Activate only after the whole release is available; a failed upgrade keeps the old worker. */
async function precache(): Promise<void> {
  const cache = await caches.open(OFFLINE_CACHE);
  // Cache.addAll commits the batch together. A missing dynamic module must fail installation,
  // rather than activate a new shell that fills its gaps from an older release on first use.
  await cache.addAll(PRECACHE_PATHS.map(path => new Request(path, { cache: 'reload' })));
  // Take over immediately, so the page that is loading right now is controlled from its next request
  // rather than after a reload.
  worker.registration.active?.postMessage({ kind: 'retire-views' });
  await worker.skipWaiting();
}

/**
 * Answers a client-owned request from this worker's release cache.
 *
 * Cache-first rather than network-first because the cache is the only thing that works with no
 * network. A cached module is immutable for this release: background revalidation can replace only
 * half a module graph while a page still has the other half loaded. The next worker installs its
 * complete cache before taking control instead.
 */
async function cacheFirst(request: Request): Promise<Response> {
  const cache = await caches.open(OFFLINE_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached !== undefined) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) void cache.put(request, response.clone());
    return response;
  } catch {
    // No cache and no network. The sentence names the file, because "this page could not load" and
    // "the client was never installed here" are different problems for the person reading it.
    return offlineResponse(
      `this device is offline and has no cached copy of ${new URL(request.url).pathname}`,
    );
  }
}

/**
 * Answers one intercepted request through the tunnel.
 *
 * @param request - the page's request; its body is read here, before `respondWith` hands
 * control back to the browser.
 * @returns the response, or a readable failure.
 */
async function serve(event: FetchEvent, knownClient?: Client): Promise<Response> {
  try {
    const request = event.request;
    const clientId = fetchClientId(event);
    const client = knownClient ?? (clientId ? await worker.clients.get(clientId) : undefined);
    const route = {
      clientId,
      ...(client ? { clientUrl: client.url } : {}),
      requestUrl: request.url,
      resultingClientId: event.resultingClientId,
    };
    let routed;
    try { routed = views.route(route); }
    catch (error) {
      if (!(error instanceof MissingWorkerView)) throw error;
      // Start waiting before notifying the shells, so fast acknowledgements cannot be lost.
      const waiting = views.waitForRoute(route);
      void restoreViews().catch(() => { /* The bounded wait reports restoration failure. */ });
      routed = await waiting;
    }
    const { viewId, tunnel } = routed;
    const outbound = await toOutbound(request, worker.location.origin);
    const answer = await tunnel.fetch(outbound);
    const isInterface = new URL(request.url).pathname === INTERFACE_PATH || request.mode === 'navigate';
    const headers = answer.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1];
    return toResponse({
      ...answer,
      body: injectWebSocketBootstrap(answer.body, headers, isInterface, viewId),
    });
  } catch (error) {
    // Failure transparency is a product requirement: a tunnel that is down must say so in
    // words, not show a browser network error the user cannot interpret.
    return offlineResponse(error instanceof Error ? error.message : String(error));
  }
}

/** The tunnel prefix is re-exported so the routing rules and this worker cannot drift. */
export { TUNNEL_PREFIX };
