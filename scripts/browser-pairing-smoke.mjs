/**
 * Pairs a **real browser** with a **real daemon**, through a **real relay**, with one typed code.
 *
 * This is the acceptance criterion itself, not a piece of it: criterion 1 asks that a brand-new
 * device reach the DSH interface by entering a pairing code once. Everything below runs in a
 * browser, because the parts that fail there are the parts no other test can see — IndexedDB,
 * service-worker scope, the page's own state after a reload.
 *
 * What it checks:
 *   1. a fresh page (no stored device) mints nothing, pairs with a code typed into the field
 *   2. the pairing lands, and the page says which device it is
 *   3. the record is in IndexedDB, not only in memory
 *   4. a daemon that **requires** the device accepts it, and the panel goes healthy
 *   5. the DSH interface opens inside the connected page and renders through the tunnel
 *   6. after a reload the page still knows the device, and connects with nothing typed — an
 *      enrolled daemon refuses a client without the identity, so this is also the check that
 *      the restored key is the enrolled one
 *   7. a page that recorded a failure sends one crash report to the daemon, which stores it — the
 *      browser half of M5's "crash reporting usable", which no node-side test can reach
 *
 * Usage:
 *   node scripts/browser-pairing-smoke.mjs <relay-ws-url> [--drdshd <path>] [--port <n>]
 *                                          [--state-dir <path>] [--headed]
 *   CHROMIUM_BIN and PLAYWRIGHT_MODULE may select a browser and Playwright installation.
 *
 * The relay must already be running and serving this build of the client (that is what every other
 * smoke script assumes too). Exit codes: 0 all checks passed, 1 a check failed, 2 the run could not
 * start (no daemon binary, no client build, no code minted).
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const playwright = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core');
const { chromium } = playwright.default ?? playwright;

const args = process.argv.slice(2);
const relayUrl = args[0];
if (relayUrl === undefined || relayUrl.startsWith('--')) {
  console.error(
    'usage: node scripts/browser-pairing-smoke.mjs <relay-ws-url> [--drdshd <path>] [--port <n>]\n' +
      '                                              [--state-dir <path>] [--headed]',
  );
  process.exit(2);
}

/** Reads an option's value, or the default. */
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (value === undefined) {
    console.error(`${name} needs a value`);
    process.exit(2);
  }
  return value;
}

const drdshd = option('--drdshd', 'target/debug/drdshd');
const port = option('--port', '46330');
const stateDir = option('--state-dir', join('target', `browser-pairing-state-${process.pid}`));
const dshPath = option('--dsh-path', 'target/test-bin');
const headed = args.includes('--headed');
/** Where Playwright's Chromium lives in this environment. */
const CHROME = process.env.CHROMIUM_BIN
  ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;

if (!existsSync(drdshd)) {
  console.error(`${drdshd} does not exist; run \`cargo build --workspace\` first`);
  process.exit(2);
}
rmSync(stateDir, { recursive: true, force: true });
mkdirSync(stateDir, { recursive: true });

const results = [];
let failures = 0;
function check(what, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail === undefined ? '' : ` — ${detail}`}`);
  results.push({ what, ok });
  if (!ok) failures += 1;
}

/** The environment every daemon process gets. */
function daemonEnv() {
  return {
    ...process.env,
    DSHD_STATE_DIR: stateDir,
    DSH_HOME: resolve(stateDir, 'dsh-home'),
    PATH: `${dshPath}:${process.env.PATH ?? ''}`,
  };
}

const roomKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
let servingDaemon = null;

async function startDaemon() {
  const daemon = spawn(drdshd, ['run', '--local-admin', '--relay', relayUrl, '--port', port, '--room-key', roomKey], {
    env: daemonEnv(),
  });
  servingDaemon = daemon;
  let log = '';
  daemon.stdout.on('data', chunk => { log += String(chunk); });
  daemon.stderr.on('data', chunk => { log += String(chunk); });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (/index reachable/.test(log) && /relay: Connected/.test(log)) return { daemon, log: () => log };
    if (daemon.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  daemon.kill('SIGTERM');
  throw new Error('The isolated DSH daemon did not become ready; check the DSH executable and port.');
}
// Installed daemons pair through the live local socket. Starting first exercises the user's
// one-submit journey and the immediate switch from room-key access to an enrolled identity.
const serving = await startDaemon();

// ---------------------------------------------------------------------------------------------
// A code, minted the way a user gets one. `--room-key` is the key the daemon will serve: the
// receipt hands it to the device, so both commands must be given the same one.
// ---------------------------------------------------------------------------------------------

const pairing = spawn(drdshd, ['pair', '--relay', relayUrl, '--room-key', roomKey, '--wait', '120'], {
  env: daemonEnv(),
});
let pairingLog = '';
pairing.stdout.on('data', chunk => {
  pairingLog += String(chunk);
});
pairing.stderr.on('data', chunk => {
  pairingLog += String(chunk);
});

/** Waits for a pattern in the pairing process's output. */
async function waitForCode(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = /code:\s+(\S+)/.exec(pairingLog);
    if (match !== null) return match[1];
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return null;
}

const code = await waitForCode(20_000);
if (code === null) {
  console.error('the daemon never printed a pairing code');
  console.error(pairingLog.trim().split('\n').slice(-4).join('\n'));
  pairing.kill('SIGKILL');
  servingDaemon.kill('SIGTERM');
  process.exit(2);
}
console.log(`relay: ${relayUrl}`);

// The acceptance criterion's clock: from the moment the code exists on screen to the moment the
// interface is visible. Everything the person does — read it, type it, press Connect — is inside
// this window, and so is the whole pairing exchange and the first paint of DSH.
const startedAt = Date.now();

// ---------------------------------------------------------------------------------------------
// The browser.
// ---------------------------------------------------------------------------------------------

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: !headed,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
const context = await browser.newContext();
const page = await context.newPage();

const consoleErrors = [];
context.on('console', message => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
context.on('weberror', error => consoleErrors.push(`uncaught: ${error.error().message}`));

try {
  const pageUrl = relayUrl.replace(/^ws:/u, 'http:').replace(/^wss:/u, 'https:');
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  check('the page loaded', (await page.title()) === 'dr.dsh', await page.title());

  // A fresh context has no stored device, so the page must not claim one.
  const storedBefore = await page.evaluate(() => document.getElementById('device')?.hidden === true);
  check('a fresh browser reports no stored device', storedBefore === true);

  // A deliberate failure, recorded the way a real one is: the shell's own `error` listener counts
  // it. Injected here rather than at the end because the report is built from what the run recorded
  // up to the moment the connection has an outcome.
  await page.evaluate(() => {
    window.dispatchEvent(new ErrorEvent('error', { message: 'smoke: deliberate failure' }));
  });
  const counted = await page.evaluate(() => window.__DR_DSH_HEALTH__?.errors ?? 0);
  check('the page counted the injected failure', counted === 1, `${counted} error(s)`);

  // Submit once with the keyboard; no second click may be needed after pairing.
  await page.fill('#key', code);
  await page.press('#key', 'Enter');
  await page.waitForFunction(
    () => /Paired as/.test(document.getElementById('device')?.textContent ?? ''),
    undefined,
    { timeout: 60_000 },
  );
  const pairedText = (await page.textContent('#device')) ?? '';
  check('the page reports the device it paired as', /Paired as \S+/.test(pairedText), pairedText.trim());

  // 2. Identity and room must both be stored: a reload needs the same device key and room key.
  const stored = await page.evaluate(
    () =>
      new Promise(resolve => {
        const request = indexedDB.open('dr.dsh', 2);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction(['identity', 'rooms'], 'readonly');
          const identity = transaction.objectStore('identity').get('this-device');
          const rooms = transaction.objectStore('rooms').getAll();
          transaction.oncomplete = () => {
            const record = identity.result;
            database.close();
            resolve(
              record === undefined
                ? null
                : {
                    deviceId: record.deviceId,
                    hasKey: typeof record.privateKey === 'string',
                    hasRoom: rooms.result.some(room => typeof room.roomKey === 'string'),
                  },
            );
          };
          transaction.onerror = () => resolve(null);
        };
        request.onerror = () => resolve(null);
      }),
  );
  check(
    'the device identity and room are in IndexedDB',
    stored !== null && typeof stored.deviceId === 'string' && stored.hasKey === true && stored.hasRoom === true,
    stored === null ? 'nothing stored' : `device ${stored.deviceId}`,
  );

  check('live pairing preserves the serving daemon process', serving.daemon.exitCode === null);
  // The shell must use the identity it just enrolled without another user action.
  await page.waitForSelector('#panel:not([hidden])', { state: 'attached', timeout: 40_000 });
  await page.waitForFunction(
    () => document.getElementById('panel')?.dataset.tone === 'ok',
    undefined,
    { timeout: 40_000 },
  );
  const headline = (await page.textContent('#headline')) ?? '';
  check('an enrolled daemon accepts the paired browser', /running/i.test(headline), headline.trim());

  // 5. The interface appears automatically in the connected shell through the tunnel.
  await page.waitForSelector('#harness-frame', { state: 'visible', timeout: 30_000 });
  const iface = await (await page.locator('#harness-frame').elementHandle()).contentFrame();
  if (iface === null) throw new Error('the connected page has no embedded Harness document');
  check('the connection opens Harness in the same page', context.pages().length === 1);
  await iface.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
  await iface
    .waitForFunction(() => typeof window.__DSH_BOOT__ !== 'undefined', undefined, { timeout: 30_000 })
    .catch(() => {});
  await iface
    .waitForFunction(() => document.querySelectorAll('*').length > 100, undefined, { timeout: 30_000 })
    .catch(() => {});
  // DSH resolves the mux relative to its document, just like its HTTP assets.
  // A root-absolute probe would miss a broken /__dr/api/remote.mux translation.
  const muxReady = await iface.evaluate(() => new Promise(resolve => {
    const url = new URL('api/remote.mux', document.baseURI);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url.href);
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 10_000);
    socket.addEventListener('open', () => socket.send(JSON.stringify({
      type: 'open', streamId: 'pairing-smoke', endpoint: '$events', payload: { args: {} },
    })));
    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === 'item' && message.streamId === 'pairing-smoke'
          && message.value?.type === 'ready') finish(true);
      } catch { finish(false); }
    });
    socket.addEventListener('error', () => finish(false));
    socket.addEventListener('close', () => finish(false));
  }));
  check('the interface relative live socket answers $events', muxReady === true);
  // The loading screen also has DOM nodes; wait for interactive DSH chrome.
  await iface.getByRole('button', { name: /new session|新建会话|新会话/i }).first()
    .waitFor({ timeout: 20_000 });
  const served = await iface.evaluate(() => ({
    hasBoot: typeof window.__DSH_BOOT__ !== 'undefined',
    nodes: document.querySelectorAll('*').length,
    title: document.title,
    visibleTextLength: document.body.innerText.trim().length,
  }));
  check('the DSH interface rendered through the tunnel', served.hasBoot && served.nodes > 100 && served.visibleTextLength > 0,
    `${served.nodes} nodes, ${served.visibleTextLength} visible characters, title ${JSON.stringify(served.title)}`);

  // Criterion 1's other half, and the reason this is measured rather than asserted by hand: "under
  // two minutes" is a claim about a person's experience, and a stopwatch in a test is the only kind
  // of evidence that does not decay.
  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  check(
    'the whole journey fits in the two minutes the criterion allows',
    elapsedSeconds < 120,
    `${elapsedSeconds.toFixed(1)}s from the printed code to the rendered interface`,
  );

  // 6. Reload: the page must come back knowing the device, and connect with nothing typed. The
  //    daemon refuses a client without the identity, so a healthy panel here means the restored key
  //    is the one that was enrolled.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });
  await page.waitForFunction(
    () => /Paired as/.test(document.getElementById('device')?.textContent ?? ''),
    undefined,
    { timeout: 20_000 },
  );
  const deviceLine = (await page.textContent('#device')) ?? '';
  await page.fill('#key', '');
  await page.click('#connect');
  await page.waitForFunction(
    () => document.getElementById('panel')?.dataset.tone === 'ok',
    undefined,
    { timeout: 40_000 },
  );
  const afterReload = (await page.textContent('#headline')) ?? '';
  check(
    'after a reload the browser reconnects with nothing typed',
    /running/i.test(afterReload),
    `${deviceLine.trim().slice(0, 60)}… → ${afterReload.trim()}`,
  );

  // 7. The browser's own crash report: one hop to the daemon, stored beside its state.
  const reportsPath = join(stateDir, 'crash-reports.jsonl');
  let reports = '';
  const reportDeadline = Date.now() + 20_000;
  while (Date.now() < reportDeadline) {
    try {
      reports = readFileSync(reportsPath, 'utf8');
      if (reports.trim() !== '') break;
    } catch {
      // Not written yet.
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  let report = null;
  try {
    report = JSON.parse(reports.trim().split('\n')[0] ?? '');
  } catch {
    // Reported below.
  }
  check(
    'a browser that recorded a failure sends one crash report to its daemon',
    report !== null &&
      report.reached_ready === true &&
      report.phase === 'ready' &&
      report.errors === 1 &&
      Array.isArray(report.samples) &&
      report.samples.join(' ').includes('smoke: deliberate failure'),
    report === null
      ? `(nothing stored at ${reportsPath})`
      : `phase=${report.phase} reached_ready=${report.reached_ready} samples=${JSON.stringify(report.samples).slice(0, 120)}`,
  );
  if (process.platform !== 'win32' && report !== null) {
    const mode = statSync(reportsPath).mode & 0o777;
    check('and the file it lands in is private to its owner', mode === 0o600, `mode ${mode.toString(8)}`);
  }

  check(
    'no console errors',
    consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(' | ') || undefined,
  );
} catch (error) {
  console.error('Connection state:', await page.locator('#state').textContent());
  check('the browser run completed', false, error.message);
} finally {
  // A failed browser assertion must also release DSH's port. Otherwise the
  // next run attaches to the orphan and tests a different lifecycle mode.
  if (servingDaemon !== null) {
    servingDaemon.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 1000));
    servingDaemon.kill('SIGKILL');
  }
  pairing.kill('SIGKILL');
  await browser.close();
}

console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures === 0 ? 0 : 1);
