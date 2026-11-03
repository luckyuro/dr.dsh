/**
 * Real Chromium verifies a complete PWA upgrade and a failed upgrade without touching a user profile.
 * Usage: node scripts/browser-cache-upgrade-smoke.mjs --previous <old-dist> [--current apps/pwa/dist] [--reproduce-legacy]
 * PLAYWRIGHT_MODULE and CHROMIUM_BIN select an existing browser installation. No DSH or model needed.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { reloadOffline, restoreOnline } from './browser-network.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(name); return index === -1 ? fallback : args[index + 1]; };
const previous = option('--previous');
const current = resolve(option('--current', 'apps/pwa/dist'));
if (!previous || ![previous, current].every(directory => existsSync(join(directory, 'service-worker.js')))) {
  console.error('Provide --previous with an earlier complete PWA build and build the current PWA first.');
  process.exit(2);
}
const oldDirectory = resolve(previous);
const cacheName = directory => /(?:const|let) OFFLINE_CACHE = ['"]([^'"]+)['"]/u.exec(readFileSync(join(directory, 'offline.js'), 'utf8'))?.[1];
const oldCache = cacheName(oldDirectory);
const newCache = cacheName(current);
assert.ok(oldCache && newCache && oldCache !== newCache, 'the upgrade must use a different release cache');
let chromium;
try { chromium = (await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core')).chromium; }
catch { console.error('Provide PLAYWRIGHT_MODULE pointing to an installed Playwright module.'); process.exit(2); }

let directory = oldDirectory;
let unavailable;
const requests = new Map();
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  requests.set(path, (requests.get(path) ?? 0) + 1);
  response.setHeader('cache-control', 'no-cache');
  response.setHeader('service-worker-allowed', '/');
  const name = path === '/' ? 'index.html' : path.startsWith('/client/') ? path.slice('/client/'.length) : '';
  if (!name || name !== basename(name) || path === unavailable || !existsSync(join(directory, name))) {
    response.writeHead(path === unavailable ? 503 : 404); response.end(); return;
  }
  const type = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.html') ? 'text/html'
    : name.endsWith('.png') ? 'image/png' : 'application/json';
  response.writeHead(200, { 'content-type': type });
  response.end(readFileSync(join(directory, name)));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const browserErrors = [];
let activePage;
let checks = 0;
const check = message => console.log(`ok ${++checks} - ${message}`);
async function until(fn, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await fn()) return; await delay(50); }
  throw new Error(`Timed out waiting for ${label}`);
}
async function visit(context) {
  const page = await context.newPage();
  activePage = page;
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.evaluate(() => import('/client/storage.js'));
  return page;
}
async function cachedVersion(page, name) {
  return await page.evaluate(async name => (await (await caches.open(name)).match('/client/offline.js'))?.text(), name);
}
async function snapshot(page, name) {
  return await page.evaluate(async name => {
    const cache = await caches.open(name);
    const entries = await Promise.all((await cache.keys()).map(async request => {
      const bytes = await (await cache.match(request)).arrayBuffer();
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      return [new URL(request.url).pathname, digest];
    }));
    return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
  }, name);
}
async function pairingFingerprint(page) {
  return await page.evaluate(async () => {
    const { IndexedDbRoomStore } = await import('/client/storage.js');
    const store = new IndexedDbRoomStore();
    const stored = JSON.stringify([await store.loadIdentity(), await store.listRooms()]);
    // Only the comparison digest leaves this isolated browser, never key material.
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stored)))];
  });
}
async function update(page, expected) {
  return await page.evaluate(async expected => {
    const registration = await navigator.serviceWorker.getRegistration();
    const finished = new Promise((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('worker update timed out')), 20_000);
      const observe = () => {
        const candidate = registration.installing;
        if (!candidate) return;
        const changed = () => {
          if (!['activated', 'redundant'].includes(candidate.state)) return;
          clearTimeout(timer); registration.removeEventListener('updatefound', observe);
          accept(candidate.state);
        };
        candidate.addEventListener('statechange', changed); changed();
      };
      registration.addEventListener('updatefound', observe); observe();
    });
    await registration.update();
    const state = await finished;
    if (state !== expected) throw new Error(`worker ended in ${state}, expected ${expected}`);
  }, expected);
}

try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN, headless: !args.includes('--headed') });
  // Older releases used mutable caches. Keep that reproduction opt-in so upgrades between fixed
  // releases can use the same regression without expecting the old bug to remain present.
  if (args.includes('--reproduce-legacy')) {
    const legacyContext = await browser.newContext();
    const page = await visit(legacyContext);
    assert.equal(await page.evaluate(async () => (await import('/client/offline.js')).OFFLINE_CACHE), oldCache);
    directory = current;
    assert.ok((await page.evaluate(() => fetch('/client/offline.js').then(response => response.text()))).includes(oldCache));
    await until(async () => (await cachedVersion(page, oldCache))?.includes(newCache), 'legacy background replacement');
    assert.ok((await page.evaluate(() => fetch('/client/offline.js').then(response => response.text()))).includes(newCache));
    assert.equal(await page.evaluate(async () => (await import('/client/offline.js')).OFFLINE_CACHE), oldCache);
    check('legacy background revalidation reproducibly changes its cache while the live page retains an earlier module');
    await legacyContext.close();
  }

  directory = oldDirectory;
  const context = await browser.newContext();
  const page = await visit(context);
  await page.evaluate(async () => {
    const { generateDevice } = await import('/client/identity.js');
    const { Tunnel, base64url } = await import('/client/tunnel.js');
    const { IndexedDbRoomStore } = await import('/client/storage.js');
    const root = crypto.getRandomValues(new Uint8Array(32));
    const identity = await generateDevice();
    await new IndexedDbRoomStore().remember({ ...identity.record, roomKey: base64url(root), room: await Tunnel.roomFor(root) }, 'cache-upgrade-host', Date.now());
  });
  const pairing = await pairingFingerprint(page);
  const oldSnapshot = await snapshot(page, oldCache);
  check('an earlier worker and a valid isolated browser identity are ready before the upgrade');

  directory = current; unavailable = '/client/health.js';
  await update(page, 'redundant');
  assert.deepEqual(await snapshot(page, oldCache), oldSnapshot);
  const incomplete = await snapshot(page, newCache);
  assert.deepEqual(incomplete, {}, 'a failed atomic batch must not publish a partial release');
  check('one missing dynamic module rejects the upgrade and leaves the earlier cache unchanged');
  await reloadOffline(context, page);
  await page.waitForFunction(() => document.getElementById('state')?.dataset.phase === 'offline');
  assert.equal(await page.title(), 'dr.dsh');
  assert.deepEqual(await pairingFingerprint(page), pairing);
  assert.ok((await page.locator('#room-list').textContent()).includes('cache-upgrade-host'));
  check('after the failed upgrade the earlier shell reloads offline and retains its pairing');

  await restoreOnline(context, page); unavailable = undefined;
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  await update(page, 'activated');
  assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin);
  assert.equal(await page.evaluate(async () => (await import('/client/offline.js')).OFFLINE_CACHE), oldCache);
  check('the complete new worker takes over without reloading the live document or changing its loaded modules');
  const expected = Object.fromEntries(readdirSync(current).map(name => [name === 'index.html' ? '/' : `/client/${name}`,
    createHash('sha256').update(readFileSync(join(current, name))).digest('hex')]).sort(([left], [right]) => left.localeCompare(right)));
  assert.deepEqual(await snapshot(page, newCache), expected);
  await page.reload({ waitUntil: 'domcontentloaded' });
  assert.equal(await page.evaluate(async () => (await import('/client/offline.js')).OFFLINE_CACHE), newCache);
  assert.deepEqual(await pairingFingerprint(page), pairing);
  check('the next navigation uses all current release files with matching SHA-256 and the same pairing');

  const beforeRequests = requests.get('/client/control.js') ?? 0;
  directory = oldDirectory;
  await page.evaluate(async () => { await fetch('/client/control.js'); await fetch('/client/control.js'); });
  await delay(300);
  assert.equal(requests.get('/client/control.js') ?? 0, beforeRequests);
  assert.deepEqual(await snapshot(page, newCache), expected);
  check('cached modules trigger no background network fetch and cannot be overwritten by another server release');
  directory = current;
  await reloadOffline(context, page);
  await page.waitForFunction(() => document.getElementById('state')?.dataset.phase === 'offline');
  assert.deepEqual(await pairingFingerprint(page), pairing);
  assert.ok((await page.locator('#room-list').textContent()).includes('cache-upgrade-host'));
  assert.ok(Object.keys(await snapshot(page, newCache)).every(path => path === '/' || path.startsWith('/client/')));
  check('the upgraded complete shell also reloads offline without caching DSH paths or losing pairing');
  await context.close();
  console.log(`Passed ${checks} cache upgrade checks (${oldCache} → ${newCache}).`);
} catch (error) {
  // Assertions compare only public asset hashes or private in-memory test digests; avoid dumping either.
  console.error(`Cache upgrade smoke failed after ${checks} checks: ${error instanceof assert.AssertionError ? 'assertion failed' : error.message}`);
  console.error('Browser errors:', browserErrors.join(' | '));
  console.error('Page state:', await activePage?.evaluate(() => ({ online: navigator.onLine, phase: document.getElementById('state')?.dataset.phase, text: document.getElementById('state')?.textContent, booted: !!window.__DR_DSH_HEALTH__, form: !!document.getElementById('connection-form') })));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise(accept => server.close(accept));
}
