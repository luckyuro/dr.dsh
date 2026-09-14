/**
 * Proves the offline claim: the shell loads with no network and says something a person can act on.
 *
 * This is M3's "离线提示可读", and it can only be checked in a browser — the service worker, its cache
 * and the reload are all browser objects, and the failure mode is a browser error page, which no
 * server-side test produces.
 *
 * What it checks, in order:
 *   1. a normal visit caches the client's own files (the worker caches at install and on first fetch)
 *   2. with the network cut, a **reload still renders the shell** — not the browser's error page
 *   3. the page says it is offline, in a sentence that mentions what is not lost
 *   4. coming back online clears the notice and connects as usual, so the offline path is not a
 *      one-way door
 *
 * Usage:
 *   node scripts/browser-offline-smoke.mjs <relay-url> <room-key> [--headed]
 *
 * Exit codes: 0 all checks passed, 1 a check failed, 2 the run could not start.
 */

import { chromium } from 'playwright-core';

const [relayUrl, roomKey, ...flags] = process.argv.slice(2);
if (relayUrl === undefined || roomKey === undefined) {
  console.error('usage: node scripts/browser-offline-smoke.mjs <relay-url> <room-key> [--headed]');
  process.exit(2);
}
const headed = flags.includes('--headed');
/** Where Playwright's Chromium lives in this environment. */
const CHROME = `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;

const results = [];
let failures = 0;
function check(what, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail === undefined ? '' : ` — ${detail}`}`);
  results.push({ what, ok });
  if (!ok) failures += 1;
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: !headed,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
const context = await browser.newContext();
const page = await context.newPage();
const consoleErrors = [];
page.on('console', message => {
  if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 160));
});
page.on('pageerror', error => consoleErrors.push(`uncaught: ${error.message}`));

try {
  // 1. A normal visit, which is what fills the cache. The worker is registered by the page and takes
  //    over immediately (`skipWaiting` + `clients.claim`), so the second navigation is already
  //    controlled — and the second navigation is what the offline test needs.
  await page.goto(relayUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await page.waitForFunction(
    () => navigator.serviceWorker?.controller !== null,
    undefined,
    { timeout: 20_000 },
  );
  // One reload so the pre-cache is in place and this document itself was served under the worker.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });

  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    const cache = await caches.open('dr.dsh-client-v1');
    const keys = await cache.keys();
    return { names, paths: keys.map(request => new URL(request.url).pathname).sort() };
  });
  check(
    'the service worker cached the client\'s own files',
    cached.names.includes('dr.dsh-client-v1') && cached.paths.includes('/'),
    cached.paths.join(', ') || 'nothing cached',
  );

  // 2. Cut the network and reload. Without the cache this is the browser's own error page, which is
  //    what "the offline experience" was before this round.
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });
  const title = await page.title();
  check('the shell still loads with no network', title === 'dr.dsh', `title ${JSON.stringify(title)}`);

  // 3. And it says so. The sentence has to be the page's, not the browser's: the check reads the DOM
  //    the shell drew.
  const notice = await page.evaluate(() => ({
    phase: document.getElementById('state')?.dataset.phase ?? '',
    text: document.getElementById('state')?.textContent ?? '',
  }));
  check(
    'the page says it is offline, in words a person can act on',
    notice.phase === 'offline' && /offline/i.test(notice.text) && notice.text.length > 80,
    `${notice.phase}: ${notice.text.slice(0, 120)}…`,
  );

  // A pairing is not required for the sentence to be useful, but the shell must not have crashed on
  // the way: its own module has to have executed, which is visible as the connect button being wired.
  const wired = await page.evaluate(() => {
    const button = document.getElementById('connect');
    return button !== null && button.disabled === false;
  });
  check('the shell\'s own code ran while offline', wired);

  // 4. Back online: the notice goes away and a connection works, so the offline path is not a dead end.
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(
    () => document.getElementById('state')?.dataset.phase !== 'offline',
    undefined,
    { timeout: 10_000 },
  );
  await page.fill('#key', roomKey);
  await page.click('#connect');
  await page.waitForSelector('#panel:not([hidden])', { timeout: 30_000 });
  await page.waitForFunction(
    () => document.getElementById('panel')?.dataset.tone === 'ok',
    undefined,
    { timeout: 30_000 },
  );
  const headline = (await page.textContent('#headline')) ?? '';
  check('reconnecting after the outage works', /running/i.test(headline), headline.trim());

  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | ') || undefined);
} catch (error) {
  check('the offline run completed', false, error.message);
} finally {
  await browser.close();
}

console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures === 0 ? 0 : 1);
