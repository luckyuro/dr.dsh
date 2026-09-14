/**
 * What still works with no network: the client's own files, and the sentence that explains the rest.
 *
 * ## Why the shell has to come from a cache
 *
 * Everything the page needs is served by the relay, so with no network there is nothing to load —
 * the browser shows its own error page and the user learns nothing about *what* is unreachable. The
 * fix is the one a PWA is for: the service worker keeps the shell, its modules and its icons, and
 * serves them from `CacheStorage` first. Then the page renders while offline, and the page is where
 * a readable sentence can live.
 *
 * ## What is deliberately not cached
 *
 * Anything that belongs to the tunnel. DSH's interface, its assets and its RPC traffic are one user's
 * live content; caching them would put session data in a browser cache that outlives the session, and
 * the point of the tunnel is that the content is not stored anywhere but the two ends. `/client/*` and
 * `/` are code and markup with no user data in them, which is exactly why they are the exception.
 *
 * @module @dr.dsh/pwa/offline
 */

/** The cache the client's own files live in. Versioned, so a format change cannot read old entries. */
export const OFFLINE_CACHE = 'dr.dsh-client-v1';

/**
 * The paths cached at install time rather than on first use.
 *
 * The shell and the modules it imports statically are here because they are what a *reload* needs:
 * without `/` there is no page, and without `shell.js` there is no code to explain the state. The
 * rest of the client is cached as it is fetched, which is what makes the second visit work offline
 * even though the first one never asked for every module.
 */
export const PRECACHE_PATHS: readonly string[] = [
  '/',
  '/client/shell.js',
  '/client/manifest.webmanifest',
  '/client/icon-192.png',
  '/client/icon-512.png',
];

/**
 * Whether a path is the client's own, and therefore cacheable.
 *
 * `/client/…` is served from the relay's disk and `/` is the shell itself. DSH has neither: its
 * interface is reached through the tunnel at `/__dr/interface` and its own paths are tunnelled
 * content, so a request that is not one of these two is never answered from a cache.
 *
 * @param pathname - the request's path.
 */
export function isClientOwned(pathname: string): boolean {
  return pathname === '/' || pathname.startsWith('/client/');
}

/** What the page knows when it cannot reach the relay. */
export interface OfflineContext {
  /** Whether this browser has a pairing stored, so the user is not told to pair again. */
  readonly paired: boolean;
}

/**
 * One sentence for being offline, and the two versions differ on purpose.
 *
 * "You are offline" is only useful if it also says what that costs: a paired user loses the interface
 * until the network returns and nothing else, while an unpaired one cannot get started at all. Both
 * say what was *not* lost, because the two things a person wonders about are whether their pairing is
 * gone and whether their computer stopped.
 *
 * @param context - what the page knows about this browser.
 */
export function offlineNotice(context: OfflineContext): string {
  if (context.paired) {
    return (
      'This device is offline, so dr.dsh cannot reach the relay. Your computer is probably still ' +
      'running DSH, and this browser still remembers the pairing — reconnect when the network is ' +
      'back and the interface will open again.'
    );
  }
  return (
    'This device is offline, so dr.dsh cannot reach the relay. Pairing needs the network: ' +
    'reconnect, then enter the code `drdshd pair` printed.'
  );
}

/**
 * Whether a request may be answered from the client's cache.
 *
 * Only `GET`s, and only for the client's own paths — with one distinction that has already mattered
 * once in this project and matters again here: **`/` is the shell only for a navigation.** The
 * tunneled DSH interface is served at `/__dr/interface` but believes it is DSH at `/`, so its own
 * `fetch('/')` for the interface root must go through the tunnel. Serving that from the client's cache
 * hands the interface the shell's HTML and the run reports "the response is not the real DSH UI" —
 * which is exactly what the browser smoke caught when this branch ignored the mode.
 *
 * A `POST` is never cacheable: caching a response to one turns a convenience into a security problem.
 *
 * @param pathname - the request's path.
 * @param method - the request's method.
 * @param mode - the request's mode, as `Request.mode` reports it.
 */
export function isCacheable(pathname: string, method: string, mode: string = 'no-cors'): boolean {
  if (method.toUpperCase() !== 'GET') return false;
  if (!isClientOwned(pathname)) return false;
  // `/client/**` is unambiguously the client's whatever asks for it; `/` is not.
  if (pathname === '/' && mode !== 'navigate') return false;
  return true;
}
