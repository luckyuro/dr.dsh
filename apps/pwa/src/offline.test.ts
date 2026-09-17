/**
 * The offline policy, checked where it can be: the decisions are pure functions, and the cache itself
 * is exercised by `scripts/browser-offline-smoke.mjs` in a real browser.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  OFFLINE_CACHE,
  PRECACHE_PATHS,
  isCacheable,
  isClientOwned,
  offlineNotice,
} from './offline.ts';

test('the client owns exactly its own files', () => {
  for (const path of ['/', '/client/shell.js', '/client/manifest.webmanifest', '/client/icon-192.png']) {
    assert.equal(isClientOwned(path), true, path);
  }
  // DSH's content is reached through the tunnel and must never be answered from a cache: it is one
  // user's live session, and the point of the tunnel is that it is stored nowhere but the two ends.
  for (const path of [
    '/__dr/interface',
    '/__dr/control/status',
    '/api/session/list',
    '/assets/index-DXr0P5Et.js',
    '/clientish/shell.js',
  ]) {
    assert.equal(isClientOwned(path), false, path);
  }
});

test('only GETs to the client are cacheable, and `/` only for a navigation', () => {
  assert.equal(isCacheable('/client/shell.js', 'GET'), true);
  assert.equal(isCacheable('/client/shell.js', 'GET', 'cors'), true);
  assert.equal(isCacheable('/', 'get', 'navigate'), true);
  // The tunneled interface believes it *is* DSH at `/`, so its own `fetch('/')` must reach the tunnel:
  // answering it from the client's cache hands the interface the shell's HTML instead of DSH's, which
  // is a failure the browser smoke caught as "the response is not the real DSH UI".
  assert.equal(isCacheable('/', 'GET', 'cors'), false);
  assert.equal(isCacheable('/', 'GET', 'same-origin'), false);
  assert.equal(isCacheable('/', 'POST', 'navigate'), false);
  assert.equal(isCacheable('/api/session/create', 'POST'), false);
  assert.equal(isCacheable('/__dr/interface', 'GET', 'navigate'), false);
});

test('the pre-cache list is the client\'s own files and nothing else', () => {
  assert.ok(PRECACHE_PATHS.includes('/'), 'the shell itself must be cached: a reload needs it');
  assert.ok(PRECACHE_PATHS.includes('/client/shell.js'), 'the code that explains the state');
  for (const path of PRECACHE_PATHS) {
    assert.equal(isClientOwned(path), true, path);
    assert.equal(isCacheable(path, 'GET', path === '/' ? 'navigate' : 'cors'), true, path);
  }
  assert.equal(OFFLINE_CACHE, 'dr.dsh-client-v2');
});

test('the offline sentence says what is lost and what is not', () => {
  const paired = offlineNotice({ paired: true });
  const unpaired = offlineNotice({ paired: false });
  assert.notEqual(paired, unpaired, 'the two situations need different advice');
  assert.match(paired, /still remembers the pairing/);
  assert.match(paired, /still running DSH/);
  assert.match(unpaired, /drdshd pair/, 'an unpaired user needs to know how to start');
  // Neither sentence may read like a browser error, and neither may tell a paired user to re-pair.
  for (const sentence of [paired, unpaired]) {
    assert.ok(sentence.length > 80, 'the sentence must be informative, not a label');
    assert.match(sentence, /^This device is offline/);
  }
  assert.doesNotMatch(paired, /enter the code/);
});

test('both theme logos and every platform icon are available before going offline', () => {
  const shell = readFileSync(new URL('../static/index.html', import.meta.url), 'utf8');
  const manifest = JSON.parse(readFileSync(new URL('../static/manifest.webmanifest', import.meta.url), 'utf8')) as {
    icons: { src: string }[];
  };
  const images = new Set([
    ...Array.from(shell.matchAll(/(?:src|srcset|href)="(\/client\/[^" ]+\.png)"/g), match => match[1]),
    ...manifest.icons.map(icon => icon.src),
  ]);
  assert.ok(images.size > 0);
  for (const path of images) {
    assert.ok(path !== undefined, 'each image reference must have a path');
    assert.ok(PRECACHE_PATHS.includes(path), `${path} must survive an offline reload or theme switch`);
  }
});
