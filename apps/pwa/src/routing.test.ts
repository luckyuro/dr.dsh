/**
 * Routing rules for the tunnel: the client-side half of the authority contract.
 *
 * A wrong answer here is not a cosmetic bug — rewriting a control path into
 * DSH's namespace would send the daemon a request it must refuse, and failing to
 * rewrite a DSH path would send the page a 401.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TUNNEL_PREFIX, isInterceptablePath, toDshPath, toTunnelRequest } from './routing.ts';

test('DSH routes are intercepted', () => {
  for (const path of ['/index.html', '/api/sessionController/list', '/api/remote.mux']) {
    assert.equal(isInterceptablePath(path), true, path);
  }
});

test('a navigation to the shell is not tunnelled, but a fetch of it is', () => {
  // `/` means two things because the shell and the tunneled DSH share an origin. A navigation is
  // someone opening or reloading the shell, and must come from the relay: intercepting it meant
  // answering a reload through a tunnel whose page was being replaced, which hangs. Found by
  // reloading a paired page in `scripts/browser-pairing-smoke.mjs`, which is what a phone does when
  // it wakes up. A fetch of `/` is the interface asking for DSH's root, and belongs in the tunnel.
  assert.equal(isInterceptablePath('/', 'navigate'), false);
  assert.equal(isInterceptablePath('/', 'cors'), true);
  assert.equal(isInterceptablePath('/', 'same-origin'), true);
  // The interface has a path of its own precisely so that it *is* intercepted, navigation or not.
  assert.equal(isInterceptablePath('/__dr/interface', 'navigate'), true);
});

test('only the client\'s own paths are left alone', () => {
  // A path listed as pass-through is fetched from the relay rather than through the tunnel, so
  // the list has to name only what is unambiguously the client's. `/assets/` is *not*: DSH's own
  // interface keeps its hashed bundles there, and passing them through gave a blank page whose
  // only clue was a 404 in the console. Found in a real browser.
  for (const path of [
    `${TUNNEL_PREFIX}/control/status`,
    `${TUNNEL_PREFIX}/control/pair`,
    // The worker's own namespace: it rewrites *to* this, and never intercepts it.
    `${TUNNEL_PREFIX}/dsh/api/x`,
    '/client/session.js',
    '/client/service-worker.js',
  ]) {
    assert.equal(isInterceptablePath(path), false, path);
  }
});

test('a relative URL from the interface is translated back to the DSH path it meant', () => {
  // The interface is served at `/__dr/interface`, so `./assets/index.js` in its HTML resolves to
  // `/__dr/assets/index.js`. DSH has no such path; what it wrote was `/assets/index.js`.
  assert.equal(toDshPath('/__dr/assets/index-DXr0P5Et.js'), '/assets/index-DXr0P5Et.js');
  assert.equal(toDshPath('/__dr/plugins/??a,b'), '/plugins/??a,b');
  // The interface path itself still means DSH's root.
  assert.equal(toDshPath('/__dr/interface'), '/');
  // And an ordinary DSH path is untouched.
  assert.equal(toDshPath('/api/session/list'), '/api/session/list');
});

test('the interface path is the one tunnel-prefixed request that is intercepted', () => {
  // A service worker does not intercept a navigation to its own page, and the shell is served at
  // `/`. Without a path of its own the interface could not be asked for at all.
  assert.equal(isInterceptablePath('/__dr/interface'), true);
  // And it means DSH's root, not a file called `interface`.
  const rewritten = toTunnelRequest(
    new Request('http://relay.example/__dr/interface'),
    new URL('http://relay.example/__dr/interface'),
    'http://relay.example',
  );
  assert.equal(new URL(rewritten.url).pathname, '/__dr/dsh/');
});

test('DSH-owned paths are tunnelled, including the ones that look like the client\'s', () => {
  // Each of these belongs to the DSH instance on the other side of the tunnel. The last two are
  // the ones that were wrong: DSH serves its interface assets from the same names a web app
  // normally reserves for itself.
  for (const path of [
    '/api/session/list',
    '/api/remote.mux',
    '/assets/index-DXr0P5Et.js',
    '/assets/vendor-CCJJTK99.css',
    '/icons/anything-dsh-uses.png',
  ]) {
    assert.equal(isInterceptablePath(path), true, path);
  }
});

test('a DSH request is rewritten under the tunnel prefix', () => {
  const request = new Request('https://relay.example/api/sessionController/list?limit=5', { method: 'POST' });
  const rewritten = toTunnelRequest(request, new URL(request.url), 'https://relay.example');
  const url = new URL(rewritten.url);
  assert.equal(url.origin, 'https://relay.example');
  assert.equal(url.pathname, `${TUNNEL_PREFIX}/dsh/api/sessionController/list`);
  assert.equal(url.search, '?limit=5');
  assert.equal(rewritten.method, 'POST');
  // Manual redirects: a 303 from DSH's own token bootstrap must reach the app,
  // not be followed silently by the service worker.
  assert.equal(rewritten.redirect, 'manual');
});

test('the root path maps to the tunnel root, not to a doubled slash', () => {
  const request = new Request('https://relay.example/');
  const rewritten = toTunnelRequest(request, new URL(request.url), 'https://relay.example');
  assert.equal(new URL(rewritten.url).pathname, `${TUNNEL_PREFIX}/dsh/`);
});
