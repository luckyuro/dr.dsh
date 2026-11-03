/**
 * Path rewriting rules for the tunnel.
 *
 * Kept in its own module — and unit-tested — because this is the part of the
 * client that decides what the daemon will ask DSH for. An over-broad rewrite
 * would hand the daemon requests for its own control endpoint; an over-narrow
 * one would break a DSH route nobody thought about. Both are visible here, in a
 * function with no browser dependency.
 *
 * @module
 */

/**
 * Virtual path prefix that means "this belongs to the tunneled DSH instance".
 *
 * Chosen to be a path a DSH route can never occupy: DSH's own routes are served
 * from `/` and `/api`, and a `__`-prefixed segment is the conventional escape
 * hatch.
 */
export const TUNNEL_PREFIX = '/__dr';

/**
 * The path the page asks for when it wants the DSH interface.
 *
 * It exists because of a browser rule that no server-side test can see: **a service worker does
 * not intercept a navigation to its own page**. The client's shell is served at `/`, so asking
 * for `/` again is answered by the browser's own navigation, not by the worker — the interface
 * would never load. A path of its own gives the worker something to intercept, and it keeps the
 * two ideas apart: `/` is the shell (the panel), this is the interface.
 */
export const INTERFACE_PATH = `${TUNNEL_PREFIX}/interface`;

/**
 * Request paths the service worker must leave alone.
 *
 * The relay and DSH share one origin from the page's point of view. This list
 * names the client's own files; the worker's control and internal request
 * paths are excluded separately below. A path listed here is fetched from the
 * relay rather than through the tunnel.
 *
 * `/assets/` and `/icons/` used to be listed, on the assumption that they were the client's.
 * They are not: DSH's own interface is a built web app, and its hashed bundles live under
 * `/assets/`. Passing those through meant the interface loaded its HTML through the tunnel and
 * then asked the relay for its JavaScript, which answered 404 — a blank page whose only clue was
 * in the console. Found by opening the client in a real browser, which is the only thing that
 * could have found it.
 */
const PASS_THROUGH_PREFIXES: readonly string[] = [
  // The client's own modules. The relay serves these from disk; DSH has no `/client/`.
  '/client/',
];

/**
 * The shell's path: the page that owns the tunnel and draws the panel.
 *
 * It is the one path that means two things, because the shell and the tunneled DSH share an origin.
 * A **navigation** to `/` is someone opening (or reloading) the shell, and it must be fetched from
 * the relay: intercepting it meant answering the navigation through a tunnel whose page was being
 * replaced, which hangs — found by reloading a paired page in `scripts/browser-pairing-smoke.mjs`.
 * Anything else at `/` — a `fetch`, an XHR — comes from the interface page, which believes it *is*
 * DSH, and belongs in the tunnel. The request's mode is the only thing that tells them apart, and it
 * is available synchronously, which a `clients.get()` lookup is not.
 */
export const SHELL_PATH = '/';

/**
 * Whether the service worker should tunnel this path.
 *
 * @param pathname - the request's path, as seen by the page.
 * @param mode - the request's mode, as `Request.mode` reports it. Defaults to a non-navigation,
 * which is what a caller that is not the fetch handler means.
 * @returns true when the request belongs to the tunneled DSH instance.
 */
export function isInterceptablePath(pathname: string, mode: string = 'no-cors'): boolean {
  if (!pathname.startsWith('/')) return false;
  // DSH's relative assets resolve beneath the interface's virtual prefix, so
  // only the worker's own endpoints are excluded. Excluding the whole prefix
  // sends /__dr/assets and /__dr/plugins to the relay and leaves a blank UI.
  if (pathname === INTERFACE_PATH) return true;
  if (pathname === TUNNEL_PREFIX
    || pathname === `${TUNNEL_PREFIX}/control`
    || pathname.startsWith(`${TUNNEL_PREFIX}/control/`)
    || pathname === `${TUNNEL_PREFIX}/dsh`
    || pathname.startsWith(`${TUNNEL_PREFIX}/dsh/`)) return false;
  if (pathname === SHELL_PATH && mode === 'navigate') return false;
  return !PASS_THROUGH_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

/**
 * The path DSH should be asked for, given the path the page asked for.
 *
 * The daemon performs the target verbatim, so this is the only translation between the client's
 * namespace and DSH's. The interface path is the page asking for DSH's root; everything else the
 * worker intercepts is already a DSH path.
 *
 * @param pathname - the path as the page wrote it.
 * @returns the path to ask DSH for.
 */
export function toDshPath(pathname: string): string {
  if (pathname === INTERFACE_PATH) return '/';
  // A relative URL inside the interface resolves against the *document's* URL, which is the
  // interface path. `./assets/index.js` therefore arrives as `/__dr/assets/index.js`, and DSH has
  // no such path. Anything that resolves under the tunnel prefix from the interface is a
  // relative URL the interface wrote, so it is translated back to the DSH path it meant.
  //
  // This cannot be used to reach a path outside the interface's own tree by accident: the prefix
  // is stripped and the remainder is what DSH is asked for, exactly as if the interface had used
  // an absolute URL.
  if (pathname.startsWith(`${TUNNEL_PREFIX}/`) && pathname !== INTERFACE_PATH) {
    return pathname.slice(TUNNEL_PREFIX.length);
  }
  return pathname;
}

/**
 * Rewrites a page request into its tunneled form.
 *
 * Method, headers, body, and credentials are preserved: DSH's requests carry
 * their own semantics (a POST body, an `accept: text/event-stream`, a
 * same-origin `Origin`), and the daemon is expected to reproduce them against
 * loopback rather than to reconstruct them.
 *
 * @param request - the original page request.
 * @param url - the parsed original URL.
 * @param origin - the page's own origin, which is where the tunnel lives.
 * @returns a request addressed to the tunnel, same-origin so the browser's
 * cookie jar and service-worker scope still apply.
 */
export function toTunnelRequest(request: Request, url: URL, origin: string): Request {
  // The interface path means DSH's own root, not itself: it is the page asking for the
  // interface, so what DSH should receive is `/`.
  const asked = url.pathname === INTERFACE_PATH ? '/' : url.pathname;
  const tunneled = new URL(asked + url.search, origin);
  tunneled.pathname = `${TUNNEL_PREFIX}/dsh${asked}`;
  return new Request(tunneled, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: 'manual',
    credentials: 'same-origin',
  });
}
