/**
 * The service worker's job: turn a page request into one proxied exchange over the tunnel.
 *
 * ## Why the worker cannot just `fetch`
 *
 * An earlier version rewrote `/api/...` into `/__dr/dsh/api/...` and fetched it. That is a
 * request to its own origin, so the worker intercepted *itself* and the page hung. The
 * tunnel is not an origin: it is a port to the page, and the answer comes back as a
 * message. This module is that message protocol, kept out of the worker so it can be tested
 * with two `MessageChannel` ends in Node.
 *
 * ## The protocol
 *
 * ```text
 * page  ─▶ worker   { kind: 'hand', port }          the tunnel, and the port to ask on
 * worker ─▶ page    { kind: 'request', id, method, path, headers, body }
 * page  ─▶ worker   { kind: 'response', id, status, headers, body }
 * page  ─▶ worker   { kind: 'failed', id, reason }
 * ```
 *
 * `id` pairs a request with its answer. It is not redundant with the port: several requests
 * are in flight at once — a page load fetches a document, a stylesheet, and a script
 * together — and without it their answers would be interchangeable.
 *
 * ## What is deliberately not here
 *
 * No reading of the body, no caching, no retries. The worker forwards what DSH said. A
 * worker that interpreted responses would be a second implementation of DSH's semantics,
 * which is exactly what ADR-0003 avoids.
 *
 * @module @dr.dsh/pwa/worker-service
 */

import { INTERFACE_PATH, toDshPath } from './routing.ts';

/** A routing label, never a credential or a DSH query parameter. */
export const VIEW_PARAMETER = 'drdshView';

export function validViewId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
}

function viewFromUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const view = new URL(value).searchParams.get(VIEW_PARAMETER);
  return validViewId(view) ? view : undefined;
}

/** The tunnel, as the worker sees it: an opaque request/response channel. */
export interface RequestOfficer {
  /**
   * Performs one request and returns the answer.
   *
   * @param request - the request to perform.
   * @returns the answer, or a failure reason.
   */
  perform(request: OutboundRequest): Promise<OutboundAnswer | { readonly failed: string }>;
}

/** A request the worker sends to the page. */
export interface OutboundRequest {
  /** Correlation id, echoed on the answer. */
  readonly id: number;
  /** HTTP method. */
  readonly method: string;
  /** Origin-form path and query. */
  readonly path: string;
  /** Request headers. */
  readonly headers: readonly (readonly [string, string])[];
  /** The request body, already read. */
  readonly body: Uint8Array<ArrayBuffer>;
}

/** An answer from the page. */
export interface OutboundAnswer {
  /** HTTP status. */
  readonly status: number;
  /** Response headers. */
  readonly headers: readonly (readonly [string, string])[];
  /** The response body. */
  readonly body: Uint8Array<ArrayBuffer>;
}

/** What the worker receives over the port. */
export type Inbound =
  | { readonly kind: 'response'; readonly id: number; readonly status: number; readonly headers: readonly (readonly [string, string])[]; readonly body: ArrayBuffer }
  | { readonly kind: 'failed'; readonly id: number; readonly reason: string };

/**
 * Serves page requests over a handed-over tunnel port.
 *
 * One instance per worker. `attach` may be called again when the page reloads and hands
 * over a new tunnel; the old port is dropped, because a port whose page is gone would only
 * ever produce timeouts.
 */
export class WorkerTunnel {
  private port: MessagePort | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (answer: OutboundAnswer) => void; reject: (error: Error) => void }
  >();

  /** Whether a tunnel is attached. */
  public get isAttached(): boolean {
    return this.port !== null;
  }

  /**
   * Attaches a tunnel port, replacing any previous one.
   *
   * @param port - the port the page handed over.
   */
  public attach(port: MessagePort): void {
    this.detach();
    this.port = port;
    port.onmessage = (event: MessageEvent) => this.absorb(event.data as Inbound);
    port.start();
  }

  /** Detaches the tunnel, failing anything in flight. */
  public detach(): void {
    this.port?.close();
    this.port = null;
    for (const [, waiting] of this.pending) {
      waiting.reject(new Error('the tunnel was detached'));
    }
    this.pending.clear();
  }

  /**
   * Performs one page request over the tunnel.
   *
   * @param request - the request, without its id.
   * @returns the answer.
   * @throws Error when no tunnel is attached, or the page reports a failure. The message is
   * written to be shown to a person: it is what the offline banner renders.
   */
  public async fetch(request: Omit<OutboundRequest, 'id'>): Promise<OutboundAnswer> {
    const port = this.port;
    if (port === null) {
      throw new Error('this browser is not paired with a computer yet');
    }
    const id = this.nextId;
    this.nextId += 1;
    const answer = new Promise<OutboundAnswer>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    port.postMessage({ kind: 'request', id, ...request });
    return await answer;
  }

  /** Routes one message from the page. */
  private absorb(message: Inbound): void {
    const waiting = this.pending.get(message.id);
    if (waiting === undefined) {
      // A late answer for a request nobody is waiting for — the page reloaded, or a
      // duplicate. Dropping it is right; throwing here would kill the worker's handler.
      return;
    }
    this.pending.delete(message.id);
    if (message.kind === 'failed') {
      waiting.reject(new Error(message.reason));
      return;
    }
    waiting.resolve({
      status: message.status,
      headers: message.headers,
      body: new Uint8Array(message.body),
    });
  }
}

/** Keeps every shell and its documents on the tunnel that shell handed over. */
export class MissingWorkerView extends Error {}

interface ViewRequest {
  clientId: string;
  clientUrl?: string;
  requestUrl: string;
  resultingClientId?: string;
}

export class WorkerViews {
  private readonly views = new Map<string, { owner: string; tunnel: WorkerTunnel }>();
  private readonly owners = new Map<string, string>();
  private readonly documents = new Map<string, string>();
  private readonly waiting = new Set<() => void>();
  private retired = false;

  public get isRetired(): boolean { return this.retired; }

  public attach(owner: string, viewId: string, port: MessagePort): void {
    this.requireActive();
    if (!owner || !validViewId(viewId)) throw new Error('the local interface route is invalid; reconnect this page');
    const existing = this.views.get(viewId);
    if (existing && existing.owner !== owner) throw new Error('this interface belongs to another page; reconnect this page');
    const previous = this.owners.get(owner);
    if (previous && previous !== viewId) this.detach(owner, previous);
    const tunnel = existing?.tunnel ?? new WorkerTunnel();
    tunnel.attach(port);
    this.views.set(viewId, { owner, tunnel });
    this.owners.set(owner, viewId);
    this.changed();
  }

  public bind(documentId: string, viewId: string): void {
    this.requireActive();
    if (!documentId || !this.views.has(viewId)) throw new Error('the interface tunnel is not ready; reconnect its parent page');
    const previous = this.documents.get(documentId) ?? this.owners.get(documentId);
    if (previous && previous !== viewId) throw new Error('the document belongs to another interface; reload it from its parent page');
    if (this.documents.get(documentId) === viewId) return;
    this.documents.set(documentId, viewId);
    this.changed();
  }

  public isDocument(documentId: string): boolean {
    return this.documents.has(documentId);
  }

  public detach(owner: string, viewId: string): void {
    const view = this.views.get(viewId);
    if (!view || view.owner !== owner) return;
    view.tunnel.detach();
    this.views.delete(viewId);
    this.owners.delete(owner);
    for (const [documentId, route] of this.documents) {
      if (route === viewId) this.documents.delete(documentId);
    }
  }

  public route(options: ViewRequest): { viewId: string; tunnel: WorkerTunnel } {
    this.requireActive();
    const url = new URL(options.requestUrl);
    const explicit = url.pathname === INTERFACE_PATH ? viewFromUrl(options.requestUrl) : undefined;
    const bound = this.documents.get(options.clientId) ?? this.owners.get(options.clientId);
    const fromDocument = viewFromUrl(options.clientUrl);
    if (bound && explicit && bound !== explicit) throw new Error('the requested interface belongs to another page; reconnect this page');
    const viewId = explicit ?? bound ?? fromDocument;
    const view = viewId === undefined ? undefined : this.views.get(viewId);
    if (!viewId || !view) throw new MissingWorkerView('this interface has no connected parent page; reconnect that page');
    if (options.clientId && fromDocument === viewId && !this.owners.has(options.clientId)) {
      this.bind(options.clientId, viewId);
    }
    if (options.resultingClientId) this.bind(options.resultingClientId, viewId);
    return { viewId, tunnel: view.tunnel };
  }

  /** A restarted worker waits for the original parent and document to identify themselves. */
  public waitForRoute(options: ViewRequest, timeoutMs = 5_000): Promise<{ viewId: string; tunnel: WorkerTunnel }> {
    return new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(timer); this.waiting.delete(attempt); };
      const attempt = () => {
        try {
          const route = this.route(options);
          finish();
          resolve(route);
        } catch (error) {
          if (error instanceof MissingWorkerView) return;
          finish();
          reject(error);
        }
      };
      const timer = setTimeout(() => {
        finish();
        reject(new MissingWorkerView('the interface route could not be restored; reconnect its parent page'));
      }, timeoutMs);
      this.waiting.add(attempt);
      attempt();
    });
  }

  private changed(): void {
    for (const attempt of [...this.waiting]) attempt();
  }

  /** Long-lived responses must finish before a replacement worker can activate. */
  public retire(): void {
    if (this.retired) return;
    this.retired = true;
    for (const view of this.views.values()) view.tunnel.detach();
    this.views.clear();
    this.owners.clear();
    this.documents.clear();
    this.changed();
  }

  private requireActive(): void {
    if (this.retired) throw new Error('the interface worker is updating; retry after the new worker takes control');
  }
}

/**
 * Turns a request the browser gave the worker into one the tunnel can carry.
 *
 * @param request - the page's request.
 * @param origin - the worker's own origin, used to derive the path.
 * @returns the request to send over the tunnel, without an id.
 */
export async function toOutbound(request: Request, origin: string): Promise<Omit<OutboundRequest, 'id'>> {
  const url = new URL(request.url);
  if (new URL(origin).origin !== url.origin) {
    throw new Error(`refusing to tunnel a request for another origin: ${url.origin}`);
  }
  // The path DSH should receive, which is *not* always the path the page asked for.
  //
  // The daemon performs the target verbatim against DSH's loopback origin, so whatever the
  // worker sends *is* the request DSH sees. The page's tunnel prefix is this side's business and
  // must not appear in it: the first version forwarded the raw path, so asking the client for its
  // interface sent DSH a request for `/__dr/interface` and DSH answered 404 with nothing to
  // explain it.
  //
  // The path is taken from the **referrer** when the page is the interface, because DSH's HTML
  // uses relative URLs (`./assets/index-*.js`) and those resolve against the document's URL. On
  // the interface path that document is `/__dr/interface`, so `./assets/x` resolves to
  // `/__dr/assets/x` and DSH never sees the request it wrote. Resolving every sub-resource
  // against DSH's root is what makes a single-page app's relative URLs work through a tunnel that
  // has to give the page a path of its own.
  if (url.pathname === INTERFACE_PATH) url.searchParams.delete(VIEW_PARAMETER);
  const path = toDshPath(url.pathname) + url.search;
  const headers: [string, string][] = [];
  request.headers.forEach((value, name) => headers.push([name, value]));
  // A body can only be read once, and GET/HEAD carry none.
  const body =
    request.method === 'GET' || request.method === 'HEAD'
      ? new Uint8Array(0)
      : new Uint8Array(await request.arrayBuffer());
  return { method: request.method, path, headers, body };
}

/**
 * Builds the response the browser sees from an answer.
 *
 * @param answer - what the page reported.
 * @returns a `Response` for the intercepted request.
 */
export function toResponse(answer: OutboundAnswer): Response {
  const headers = new Headers();
  for (const [name, value] of answer.headers) {
    // `content-encoding` and `content-length` describe the bytes DSH sent. The browser is
    // handed those bytes directly, so a stale length would truncate the page.
    const lowered = name.toLowerCase();
    if (lowered === 'content-encoding' || lowered === 'content-length' || lowered === 'transfer-encoding') {
      continue;
    }
    headers.append(name, value);
  }
  return new Response(answer.body, { status: answer.status, headers });
}

/**
 * Injects the WebSocket bootstrap into the interface document.
 *
 * A service worker cannot intercept a WebSocket upgrade, so the only place a socket can be
 * replaced is inside the page — and it has to be replaced **before** the page's own scripts run,
 * or the application will already hold the native constructor. A parser-blocking script placed
 * first in `<head>` is what guarantees that ordering.
 *
 * Only DSH's own document is touched, and only to insert one script tag. Rewriting more than that
 * would mean this project interpreting DSH's HTML, which is the coupling ADR-0003 exists to avoid.
 *
 * @param body - the response body, untouched when it is not an HTML document.
 * @param contentType - the response's content type.
 * @param isInterface - whether this response is the interface document itself.
 * @returns the body, with the bootstrap inserted when it applies.
 */
export function injectWebSocketBootstrap(
  body: Uint8Array<ArrayBuffer>,
  contentType: string | undefined,
  isInterface: boolean,
  viewId?: string,
): Uint8Array<ArrayBuffer> {
  if (!isInterface || contentType === undefined || !contentType.includes('text/html')) return body;
  const html = new TextDecoder().decode(body);
  // Before the first script the page declares, whatever kind it is: the interface's own bootstrap
  // is an inline script in `<head>`, and a module in `<body>` would still be too late for the
  // application code that follows it.
  const at = html.indexOf('<script');
  const route = validViewId(viewId) ? ` data-drdsh-view="${viewId}"` : '';
  const tag = `<script src="/client/ws-bootstrap.js"${route}></script>`;
  const injected = at === -1 ? html.replace('</head>', `${tag}</head>`) : html.slice(0, at) + tag + html.slice(at);
  return new TextEncoder().encode(injected);
}

/**
 * The message a person sees when the tunnel cannot answer.
 *
 * @param reason - why the request failed.
 * @returns a readable page rather than a browser network error.
 */
export function offlineResponse(reason: string): Response {
  return new Response(`dr.dsh: ${reason}\n`, {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}
