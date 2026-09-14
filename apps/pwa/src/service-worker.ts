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
import { WorkerTunnel, injectWebSocketBootstrap, offlineResponse, toOutbound, toResponse } from './worker-service.ts';

const worker = self as unknown as ServiceWorkerGlobalScope;

/** The tunnel, once the page has handed one over. */
const tunnel = new WorkerTunnel();

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
  const message = event.data as { kind?: string } | null;
  if (message?.kind !== 'hand') return;
  // A port, not data: `event.ports` is where a transferred channel arrives.
  const port = event.ports[0];
  if (port === undefined) return;
  tunnel.attach(port);
});

worker.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== worker.location.origin) return;
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
  event.respondWith(serve(request));
});

/** Caches the client's own entry points, one at a time. */
async function precache(): Promise<void> {
  const cache = await caches.open(OFFLINE_CACHE);
  await Promise.all(
    PRECACHE_PATHS.map(async path => {
      try {
        // Individually and best-effort: one missing file must not fail the whole install, because a
        // failed install leaves the page uncontrolled — a much worse state than an incomplete cache.
        await cache.add(new Request(path, { cache: 'reload' }));
      } catch {
        // Ignored on purpose; the fetch handler still caches whatever the page asks for next.
      }
    }),
  );
  // Take over immediately, so the page that is loading right now is controlled from its next request
  // rather than after a reload.
  await worker.skipWaiting();
}

/**
 * Answers a client-owned request from the cache, refreshing the copy in the background.
 *
 * Cache-first rather than network-first because the cache is the only thing that works with no
 * network, and the files are this project's own code — the version skew this trades away is handled
 * by the cache name being versioned and by the relay's short `max-age`.
 */
async function cacheFirst(request: Request): Promise<Response> {
  const cache = await caches.open(OFFLINE_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached !== undefined) {
    void fetch(request)
      .then(response => {
        if (response.ok) return cache.put(request, response.clone());
        return undefined;
      })
      .catch(() => {
        // Offline. The cached copy was just served, which is the point.
      });
    return cached;
  }
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
async function serve(request: Request): Promise<Response> {
  try {
    const outbound = await toOutbound(request, worker.location.origin);
    const answer = await tunnel.fetch(outbound);
    const isInterface = new URL(request.url).pathname === INTERFACE_PATH;
    const headers = answer.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1];
    return toResponse({
      ...answer,
      body: injectWebSocketBootstrap(answer.body, headers, isInterface),
    });
  } catch (error) {
    // Failure transparency is a product requirement: a tunnel that is down must say so in
    // words, not show a browser network error the user cannot interpret.
    return offlineResponse(error instanceof Error ? error.message : String(error));
  }
}

/** The tunnel prefix is re-exported so the routing rules and this worker cannot drift. */
export { TUNNEL_PREFIX };
