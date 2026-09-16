/**
 * nginx serves the PWA from disk while a real relay has no client files.
 * Browser pairing, authenticated DSH-fixture HTTP and offline shell exercise the full route.
 * Requires built binaries/PWA, nginx, playwright-core and Chromium on the test machine.
 * NGINX_BIN, PLAYWRIGHT_MODULE and CHROMIUM_BIN may select local test dependencies.
 * Exits 0 passed, 1 failed, 2 prerequisites missing. No Node process runs on the relay side.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { shellQuote } from './service-manager.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const multicall = process.env.DRDSH_TEST_BINARY;
const relayBinary = multicall ?? join(repo, 'target/debug/drdsh-relay');
const daemonBinary = multicall ?? join(repo, 'target/debug/drdshd');
let chromium;
try {
  ({ chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core'));
  for (const name of [relayBinary, daemonBinary, join(repo, 'apps/pwa/dist/index.html')]) {
    assert.ok(existsSync(name), `Build ${name} first.`);
  }
} catch (error) { console.error(error.message); process.exit(2); }
const scratch = mkdtempSync(join(repo, 'target/nginx-static-smoke-'));
const children = [];
let browser;
let checks = 0;
function check(name, condition = true) { assert.ok(condition, name); console.log(`ok ${++checks} - ${name}`); }
function start(file, args, env) {
  const child = spawn(file, args, { cwd: scratch, env });
  let output = '';
  let spawnError;
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  child.once('error', error => { spawnError = error; });
  children.push(child);
  return { child, output: () => output, error: () => spawnError };
}
async function until(test, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  do { if (await test()) return; await delay(100); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}
async function port() {
  const server = createServer();
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  const value = server.address().port;
  await new Promise(accept => server.close(accept));
  return value;
}
async function responds(url) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(500) }); await r.body?.cancel(); return r.ok; } catch { return false; }
}

try {
  const relayPort = await port();
  const webPort = await port();
  const dshPort = await port();
  const base = `http://127.0.0.1:${webPort}`;
  const ws = `ws://127.0.0.1:${webPort}`;
  const serverEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: scratch };
  const relay = start(relayBinary, multicall ? ['relay', 'run'] : [], { ...serverEnv,
    DSH_RELAY_BIND: `127.0.0.1:${relayPort}`, DSH_RELAY_CLIENT_DIR: join(scratch, 'no-client') });
  await until(() => responds(`http://127.0.0.1:${relayPort}/healthz`), 'relay readiness');
  assert.ifError(relay.error());
  cpSync(join(repo, 'apps/pwa/dist'), join(scratch, 'public/client'), { recursive: true });
  const example = readFileSync(join(repo, 'relay/nginx.conf.example'), 'utf8')
    .replace('listen 443 ssl;', `listen 127.0.0.1:${webPort};`)
    .replace(/^\s*ssl_certificate(?:_key)? .*;$/gm, '')
    .replace('root /srv/dr.dsh-relay;', `root "${scratch}/public";`)
    .replaceAll('127.0.0.1:8787', `127.0.0.1:${relayPort}`)
    .replaceAll('https://$http_host', 'http://$http_host').replaceAll('wss://$http_host', 'ws://$http_host');
  const conf = join(scratch, 'nginx.conf');
  writeFileSync(conf, `daemon off; master_process off;\npid "${scratch}/nginx.pid";\nerror_log "${scratch}/error.log";\nevents {}\nhttp {\naccess_log "${scratch}/access.log";\nclient_body_temp_path "${scratch}/body";\nproxy_temp_path "${scratch}/proxy";\n${example}\n}\n`);
  const nginx = start(process.env.NGINX_BIN ?? 'nginx', ['-p', `${scratch}/`, '-c', conf], serverEnv);
  await until(() => responds(`${base}/healthz`), 'nginx readiness');
  assert.ifError(nginx.error());
  check('nginx serves exactly the built static homepage', await (await fetch(base)).text() === readFileSync(join(repo, 'apps/pwa/dist/index.html'), 'utf8'));
  check('relay has no PWA files while nginx serves the JavaScript',
    (await fetch(`http://127.0.0.1:${relayPort}/client/shell.js`)).status === 404 &&
    (await fetch(`${base}/client/shell.js`)).headers.get('content-type')?.includes('javascript'));
  const worker = await fetch(`${base}/client/service-worker.js`);
  check('nginx grants root Service Worker scope and revalidates the entry', worker.headers.get('service-worker-allowed') === '/' && worker.headers.get('cache-control') === 'no-cache');
  check('DSH tunnel paths do not fall back to static index.html', (await fetch(`${base}/__dr/interface`)).status === 404);
  check('the entry cannot be loaded through a path without its homepage CSP', (await fetch(`${base}/client/index.html`)).status === 404);

  const fixture = join(scratch, 'fixture.mjs');
  const dsh = join(scratch, 'dsh');
  writeFileSync(fixture, `process.argv[2] = process.argv[process.argv.indexOf('--port') + 1];\nawait import(${JSON.stringify(new URL('../crates/dr-dsh-daemon/tests/fixtures/fake-dsh.mjs', import.meta.url).href)});\n`);
  writeFileSync(dsh, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fixture)} "$@"\n`, { mode: 0o755 });
  const daemonEnv = { ...process.env, HOME: scratch, DSHD_DSH: dsh, DSHD_STATE_DIR: join(scratch, 'state') };
  const pair = start(daemonBinary, [...(multicall ? ['daemon'] : []), 'pair', '--relay', ws, '--wait', '90'], daemonEnv);
  await until(() => /code:\s+(\S+)/.test(pair.output()), 'pairing code');
  const code = /code:\s+(\S+)/.exec(pair.output())[1];
  browser = await chromium.launch({ ...(process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {}), headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); });
  await page.goto(base);
  await page.fill('#key', code);
  await page.click('#connect');
  await page.waitForFunction(() => /Paired as/.test(document.getElementById('state')?.textContent ?? ''), undefined, { timeout: 30_000 });
  await page.fill('#key', '');
  check('real browser pairing crosses nginx WebSocket proxy', true);
  await until(() => pair.child.exitCode !== null, 'pairing process exit');
  const daemon = start(daemonBinary, [...(multicall ? ['daemon'] : []), 'run', '--relay', ws, '--port', String(dshPort)], daemonEnv);
  await until(() => /index reachable/.test(daemon.output()), 'DSH fixture authentication');
  await page.click('#connect');
  await page.waitForFunction(() => document.getElementById('panel')?.dataset.tone === 'ok', undefined, { timeout: 30_000 });
  check('Service Worker controls the origin and the encrypted tunnel connects', await page.evaluate(() => navigator.serviceWorker.controller !== null));
  const opened = context.waitForEvent('page');
  await page.click('#open');
  const iface = await opened;
  await iface.waitForLoadState('domcontentloaded');
  check('authenticated DSH fixture HTML arrives through the tunnel', (await iface.title()) === 'fake dsh' && /redeemed=/.test(await iface.locator('body').innerText()));
  await iface.close();
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('rooms')?.hidden);
  check('paired computer survives a reload of the nginx static page', await page.locator('#key').inputValue() === '');
  await context.setOffline(true);
  await page.reload();
  check('the static shell still loads offline', (await page.title()) === 'dr.dsh');
  await context.setOffline(false);
  check('the page has no uncaught JavaScript errors', errors.length === 0);
  console.log(`Passed ${checks} nginx/static/browser checks (DSH uses the authentication fixture).`);
} catch (error) {
  console.error(error.stack); process.exitCode = 1;
} finally {
  await browser?.close();
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    child.kill('SIGTERM');
    await until(() => child.exitCode !== null || child.signalCode !== null, 'test process cleanup', 10_000).catch(() => child.kill('SIGKILL'));
  }
  if (!process.exitCode) rmSync(scratch, { recursive: true, force: true });
  else console.error(`Diagnostics retained at ${scratch}; pairing credentials are not written to logs.`);
}
