/**
 * Drives the real client in a **real browser**, against a **real** daemon and DSH.
 *
 * This is the evidence the other tests cannot produce. Everything else checks a piece: the tunnel
 * against a stand-in, the panel's decisions on constructed inputs, the proxy's bytes through a
 * script. None of them can answer the questions the MVP acceptance criteria actually ask — does a
 * page load in a browser and reach the DSH interface, does the service worker intercept the
 * navigations DSH performs, does a long response survive the trip. Those need a browser because
 * the browser is half of the system.
 *
 * Usage:
 *   node scripts/browser-smoke.mjs <relay-url> <room-key> [--pair-as <device-id>] [--headed]
 *
 * What it checks:
 *   1. the page loads and its modules execute (no console errors, no failed imports)
 *   2. the tunnel establishes and the panel reports DSH running
 *   3. the service worker takes control and the DSH interface is served through it
 *   4. the interface is the real DSH — the boot global is present and the DOM is non-trivial
 *   5. a long response arrives intact (the "long output" half of the fidelity criterion)
 *
 * Its exit code is the result, so it can be wired into a verification script.
 */

import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

const [relayUrl, roomKey, ...flags] = process.argv.slice(2);
if (relayUrl === undefined || roomKey === undefined) {
  console.error('usage: node scripts/browser-smoke.mjs <relay-url> <room-key> [--headed]');
  process.exit(2);
}
const headed = flags.includes('--headed');

/** Where Playwright's Chromium lives in this environment. */
const CHROME = `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;

const results = [];
function check(what, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail === undefined ? '' : ` — ${detail}`}`);
  results.push({ what, ok });
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: !headed,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
const context = await browser.newContext();
const page = await context.newPage();

const consoleErrors = [];
const failedRequests = [];
page.on('console', message => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('requestfailed', request => {
  failedRequests.push(`${request.url()} (${request.failure()?.errorText ?? 'unknown'})`);
});
page.on('pageerror', error => consoleErrors.push(`uncaught: ${error.message}`));

try {
  // 1. The page loads and the shell's own code runs. The relay serves the shell; a syntax error
  //    in the inline module or a missing client module shows up as a console error or a failed
  //    request, neither of which any other test in this repository can see.
  await page.goto(relayUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  check('the page loaded', (await page.title()) === 'dr.dsh', await page.title());

  // 0. Installability, checked through the browser's own parser rather than by fetching the file: the
  //    manifest has to be valid JSON with a name, a start URL and an icon large enough to install,
  //    and every icon it names has to load. A manifest that 404s or parses with errors leaves the
  //    install prompt silently absent, which no server-side test can see (M3).
  const cdp = await context.newCDPSession(page);
  await cdp.send('Page.enable');
  const manifest = await cdp.send('Page.getAppManifest');
  const parsed = (() => {
    try {
      return JSON.parse(manifest.data ?? '{}');
    } catch {
      return {};
    }
  })();
  const iconResponses = await page.evaluate(async () => {
    const urls = ['/client/icon-192.png', '/client/icon-512.png'];
    const out = [];
    for (const url of urls) {
      const response = await fetch(url);
      out.push(`${url}: ${response.status}`);
    }
    return out;
  });
  const iconsOk = iconResponses.every(entry => entry.endsWith(': 200'));
  check(
    'the app manifest parses and names what an install needs',
    (manifest.errors ?? []).length === 0 &&
      typeof parsed.name === 'string' &&
      parsed.name.length > 0 &&
      typeof parsed.start_url === 'string' &&
      Array.isArray(parsed.icons) &&
      parsed.icons.some(icon => /512x512/.test(icon.sizes ?? '')),
    `${manifest.errors?.length ?? 0} manifest error(s); name=${JSON.stringify(parsed.name)} start=${JSON.stringify(parsed.start_url)} icons=${parsed.icons?.length ?? 0}`,
  );
  check('the manifest icons load', iconsOk, iconResponses.join(', '));
  check(
    'the page links the manifest it was served',
    (manifest.url ?? '').includes('manifest.webmanifest'),
    manifest.url ?? '(no manifest url)',
  );

  // Enter the key exactly as a person does.
  await page.fill('#key', roomKey);
  await page.click('#connect');

  // 2. The panel appears and reports a healthy state. This is the tunnel *and* the control plane
  //    working inside a browser, which is the first thing the criteria ask for.
  await page.waitForSelector('#panel:not([hidden])', { timeout: 30_000 });
  await page.waitForFunction(
    () => document.getElementById('panel')?.dataset.tone === 'ok',
    undefined,
    { timeout: 30_000 },
  );
  const headline = await page.textContent('#headline');
  check('the panel reports a healthy state', /running/i.test(headline ?? ''), headline ?? '(none)');

  // 3. The interface opens in its own tab, because the tunnel lives in *this* page: a page owns
  //    the carrier socket and answers the worker's requests, and a navigation replaces that page.
  //    Opening it in place is what made the interface's HTML arrive and every asset after it hang.
  const popup = context.waitForEvent('page', { timeout: 30_000 });
  await page.click('#open');
  const iface = await popup;
  await iface.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
  // The interface boots its own module system; give it the moment that takes.
  await iface.waitForFunction(() => typeof window.__DSH_BOOT__ !== 'undefined', undefined, {
    timeout: 30_000,
  });
  // The boot global appears before the interface has painted: the module system then loads and
  // renders its plugins. Waiting for a shape rather than a count is what makes this a check of
  // "did the interface render" rather than "how fast is this machine".
  await iface
    .waitForFunction(() => document.querySelectorAll('*').length > 100, undefined, {
      timeout: 30_000,
    })
    .catch(() => {});

  const served = await iface.evaluate(() => ({
    hasBoot: typeof window.__DSH_BOOT__ !== 'undefined',
    nodes: document.querySelectorAll('*').length,
    title: document.title,
  }));
  check('the DSH boot global is present', served.hasBoot);
  check('the interface rendered something', served.nodes > 20, `${served.nodes} nodes`);

  // 4. The interface is live: DSH opens its multiplexed WebSocket against its own origin, and
  //    through the worker that request travels the tunnel. A WebSocket that never opens means
  //    the interface is a static picture.
  const socketOpened = await iface.evaluate(
    () =>
      new Promise(resolve => {
        // DSH's own mux path, as `docs/integration/dsh-surface.md` records it. Asked for from the
        // page, so it goes through the same service worker the interface uses.
        //
        // `addEventListener` and a real stream request, because that is how DSH's own client uses
        // this socket: a shim that only fired `onopen` passed an `onopen`-based check while the
        // interface's live features waited forever for an event that never came.
        const socket = new WebSocket(`ws://${location.host}/api/remote.mux`);
        const done = value => resolve(value);
        socket.addEventListener('open', () => {
          socket.send(
            JSON.stringify({
              type: 'open',
              streamId: 'dr.dsh-smoke',
              endpoint: '$events',
              payload: { args: {} },
            }),
          );
        });
        socket.addEventListener('message', event => {
          if (!String(event.data).includes('"type":"item"')) return;
          socket.close();
          done(true);
        });
        socket.addEventListener('error', () => done(false));
        setTimeout(() => done(false), 10_000);
      }),
  );
  // The live-update half of the fidelity criterion. A service worker cannot intercept a WebSocket
  // upgrade, so the interface page's `WebSocket` is replaced by `ws-bootstrap.js` and its sockets
  // travel the tunnel; this is the check that the replacement is actually in place. Before it was,
  // the socket went straight at the relay and the interface sat on `Reconnecting…`.
  check('the multiplexed WebSocket opens through the tunnel', socketOpened === true);

  // 5. A long response survives the trip. The fidelity criterion names "a long output" as one of
  //    the things that must not degrade, and a body far larger than one carrier frame is where a
  //    reassembly bug would show. DSH's own page is the largest thing a client can ask for without
  //    guessing at an RPC, and it is the request the interface itself made to get here.
  const longBody = await iface.evaluate(async () => {
    const response = await fetch('/', { headers: { accept: 'text/html' } });
    const text = await response.text();
    return { status: response.status, bytes: text.length, boots: text.includes('__DSH_BOOT__') };
  });
  check(
    'a large response arrives intact through the worker',
    longBody.status === 200 && longBody.bytes > 20_000 && longBody.boots,
    `status ${longBody.status}, ${longBody.bytes} bytes, boot global in body: ${longBody.boots}`,
  );

  // 6. Nothing threw. A page that renders but logs an exception is a page that breaks on the next
  //    interaction, and only a browser can see it.
  check(
    'no console errors',
    consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(' | ') || undefined,
  );
  const realFailures = failedRequests.filter(url => !url.includes('favicon'));
  check(
    'no failed requests',
    realFailures.length === 0,
    realFailures.slice(0, 3).join(' | ') || undefined,
  );
} catch (error) {
  check('the browser run completed', false, error.message);
} finally {
  await browser.close();
}

const failed = results.filter(result => !result.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
