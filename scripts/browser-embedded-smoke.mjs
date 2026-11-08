/**
 * Real Chromium + relay + daemon + DSH, without a model or API key.
 * Exercises the embedded interface, simultaneous proxy traffic, worker replacement,
 * room isolation in one browser and explicit refusal of a second client for one room.
 *
 * Usage: node scripts/browser-embedded-smoke.mjs --dsh /absolute/path/to/dsh
 *        [--drdsh target/debug/drdsh] [--headed] [--idle-ms 35000]
 *        [--check-account-origin] [--check-offline] [--check-slow-transfer]
 * PLAYWRIGHT_MODULE and CHROMIUM_BIN select an existing browser installation.
 * Exit codes: 0 passed, 1 failed, 2 prerequisite missing.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { connect as connectTcp, createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  if (at === -1) return fallback;
  if (!args[at + 1]) throw new Error(`${name} requires a value`);
  return args[at + 1];
};
const binary = resolve(option('--drdsh', 'target/debug/drdsh'));
const dsh = option('--dsh', process.env.DSH_BIN);
const chromiumPath = process.env.CHROMIUM_BIN;
if (!dsh || !existsSync(dsh) || !existsSync(binary) || !existsSync('apps/pwa/dist/service-worker.js')) {
  console.error('Build drdsh and PWA, and pass --dsh with an installed real DSH executable.');
  process.exit(2);
}
let chromium;
try {
  const module = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core');
  chromium = (module.default ?? module).chromium;
} catch {
  console.error('Provide PLAYWRIGHT_MODULE pointing to an installed Playwright module.');
  process.exit(2);
}
const repo = process.cwd();
mkdirSync(resolve('target'), { recursive: true });
const scratch = mkdtempSync(resolve('target/embedded-browser-'));
const output = resolve('output/playwright');
mkdirSync(output, { recursive: true });
cpSync(resolve('apps/pwa/dist'), join(scratch, 'client'), { recursive: true });
const children = [];
const report = { checks: [], startedAt: new Date().toISOString() };
let browser;
let page;
let slowGate;
const check = label => { report.checks.push(label); console.log(`ok ${report.checks.length} - ${label}`); };
async function until(condition, label, timeout = 40_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await condition()) return; await delay(100); }
  throw new Error(`Timed out waiting for ${label}`);
}
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
/** Limit real TCP reads so large encrypted responses backpressure the relay, not a browser mock. */
async function receiverGate(port) {
  let bytesPerSecond = 0;
  let held = false;
  let delivered = 0;
  const links = new Set();
  const server = createServer(socket => {
    const upstream = connectTcp(port, '127.0.0.1');
    let pending;
    let timer;
    let closed = false;
    const flush = () => {
      if (closed || held || !pending) return;
      const send = () => {
        timer = undefined;
        if (closed || held || !pending) return;
        const { chunk, done } = pending;
        pending = undefined;
        delivered += chunk.length;
        done(null, chunk);
      };
      if (bytesPerSecond === 0) send();
      else timer = setTimeout(send, Math.ceil(pending.chunk.length * 1000 / bytesPerSecond));
    };
    const slow = new Transform({
      highWaterMark: 64 * 1024,
      transform(chunk, _encoding, done) { pending = { chunk, done }; flush(); },
    });
    const link = {
      resume() { clearTimeout(timer); timer = undefined; flush(); },
      close() {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        pending = undefined;
        socket.destroy(); upstream.destroy(); slow.destroy(); links.delete(link);
      },
    };
    links.add(link);
    for (const stream of [socket, upstream, slow]) {
      stream.on('error', link.close);
      stream.on('close', link.close);
    }
    socket.pipe(upstream);
    upstream.pipe(slow).pipe(socket);
  });
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  return {
    port: server.address().port,
    bytes: () => delivered,
    limit(rate) { bytesPerSecond = rate; for (const link of links) link.resume(); },
    hold() { held = true; for (const link of links) link.resume(); },
    resume() { held = false; for (const link of links) link.resume(); },
    close() { for (const link of links) link.close(); server.close(); },
  };
}
const baseEnv = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !/^(DSHD_|DRDSH_|DSH_RELAY_|DSH_HOME$|FAKE_DSH_)/u.test(key)));
function start(name, argv, env = {}) {
  const child = spawn(binary, ['__runtime', ...argv], {
    cwd: scratch, env: { ...baseEnv, ...env }, detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  for (const pipe of [child.stdout, child.stderr]) pipe.on('data', chunk => { log += String(chunk); });
  children.push(child);
  child.on('error', error => { log += `process error: ${error.message}`; });
  return { child, name, log: () => log };
}
async function frameFor(page, real = true) {
  await page.waitForSelector('#harness-frame', { state: 'visible', timeout: 40_000 });
  const frame = await (await page.locator('#harness-frame').elementHandle()).contentFrame();
  assert.ok(frame, 'the connected page must contain its Harness frame');
  if (real) await frame.waitForFunction(() => typeof window.__DSH_BOOT__ !== 'undefined', undefined, { timeout: 40_000 });
  else await frame.getByText(/^redeemed=\d+$/u, { exact: true }).waitFor({ timeout: 20_000 });
  return frame;
}
async function connect(page, url, key, real = true) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.locator('#connection-manager').isVisible(), true);
  assert.equal(await page.locator('#connection-dialog').isVisible(), false);
  await page.fill('#key', key);
  await page.click('#connect');
  return await frameFor(page, real);
}
async function connectSlow(page, url, key, gate) {
  const wire = [];
  const started = Date.now();
  page.on('websocket', socket => {
    if (new URL(socket.url()).pathname !== '/ws/client') return;
    for (const [event, direction] of [['framesent', 'sent'], ['framereceived', 'received']]) {
      socket.on(event, ({ payload }) => {
        if (!Buffer.isBuffer(payload) || payload.length < 26 || payload[0] !== 0x44 || payload[1] !== 0x52) return;
        // Header, length and counter only: neither ciphertext nor plaintext enters the report.
        wire.push({ direction, atMs: Date.now() - started, stream: payload.readUInt32BE(10),
          counter: Number(payload.readBigUInt64BE(18)), bytes: payload.length });
      });
    }
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.evaluate(() => {
    window.__DRDSH_SLOW_PANEL__ = [];
    const observe = () => {
      const tone = document.getElementById('panel')?.dataset.tone;
      const phase = document.getElementById('state')?.dataset.phase;
      const samples = window.__DRDSH_SLOW_PANEL__;
      const previous = samples.at(-1);
      if (previous?.tone !== tone || previous?.phase !== phase) samples.push({ atMs: performance.now(), tone, phase });
    };
    window.__DRDSH_SLOW_OBSERVER__ = new MutationObserver(observe);
    window.__DRDSH_SLOW_OBSERVER__.observe(document.getElementById('panel'), { attributes: true, attributeFilter: ['data-tone'] });
    window.__DRDSH_SLOW_OBSERVER__.observe(document.getElementById('state'), { attributes: true, attributeFilter: ['data-phase'] });
    observe();
  });
  const firstByteCount = gate.bytes();
  gate.limit(1024 * 1024);
  await page.fill('#key', key);
  const connectedAt = Date.now();
  await page.click('#connect');
  const frame = await frameFor(page);
  // __DSH_BOOT__ is in the small HTML document. A real rendered control proves the
  // large upstream JS bundle arrived and ran, which the boot marker alone cannot do.
  await frame.getByRole('button', { name: 'Continue', exact: true }).waitFor({ timeout: 50_000 });
  const transferMs = Date.now() - connectedAt;
  const transferBytes = gate.bytes() - firstByteCount;
  gate.limit(0);
  const samples = await page.evaluate(() => {
    window.__DRDSH_SLOW_OBSERVER__.disconnect();
    return window.__DRDSH_SLOW_PANEL__;
  });
  const controls = wire.filter(frame => frame.stream === 0 && frame.counter > 0);
  const waits = controls.filter(frame => frame.direction === 'sent').map(sent => {
    const next = controls.find(received => received.direction === 'received' && received.atMs >= sent.atMs);
    return next ? next.atMs - sent.atMs : 0;
  });
  const controlWaitMs = Math.max(0, ...waits);
  report.slowTransfer = { rateBytesPerSecond: 1024 * 1024, transferMs, transferBytes, controlWaitMs, samples };
  assert.ok(transferBytes > 5 * 1024 * 1024, 'the real bundle must exceed 5 MiB so this exercises sustained transfer');
  assert.ok(transferMs > 5_000, 'the real bundle must take longer than the former status timeout');
  assert.ok(controlWaitMs > 5_000, `a status response must really wait behind the bundle for >5s (observed ${controlWaitMs}ms)`);
  assert.ok(!samples.some(sample => sample.tone === 'error' || sample.phase === 'failed'),
    `valid incoming bundle data must not report an unavailable host: ${JSON.stringify(samples)}`);
  assert.equal(await mux(frame, true), true);
  check(`a real ${Math.round(transferBytes / 1024 / 1024)} MiB DSH bundle takes ${transferMs} ms without a false status failure`);

  // Begin only after another successful status probe, so buffered setup work
  // cannot mask the quiet connection being tested next.
  const answered = controls.filter(frame => frame.direction === 'received').length;
  await until(() => wire.filter(frame => frame.stream === 0 && frame.counter > 0 && frame.direction === 'received').length > answered,
    'a fresh status after the slow transfer', 10_000);
  await page.waitForFunction(() => document.getElementById('panel')?.dataset.tone === 'ok');
  gate.hold();
  const heldAt = Date.now();
  await until(async () => await page.locator('#panel').getAttribute('data-tone') === 'error', 'status failure after all incoming data stops', 11_000);
  const silenceFailureMs = Date.now() - heldAt;
  assert.ok(silenceFailureMs >= 4_000 && silenceFailureMs <= 10_500,
    `a silent connection must fail within the 5s budget plus the 3s poll interval (${silenceFailureMs}ms)`);
  gate.resume();
  const resumedAt = Date.now();
  await until(async () => await page.locator('#panel').getAttribute('data-tone') === 'ok', 'status recovery after incoming data resumes', 10_000);
  assert.equal(await mux(frame, true), true);
  if (await page.locator('#connection-dialog').isVisible()) await page.click('#close-controls');
  report.slowTransfer.silenceFailureMs = silenceFailureMs;
  report.slowTransfer.recoveryMs = Date.now() - resumedAt;
  check('stopping all incoming bytes produces a bounded status failure, and resuming restores the same Harness session');
  return frame;
}
async function openControls(page) {
  if (!await page.locator('#connection-dialog').isVisible()) await page.click('#return-to-connection');
  await page.waitForSelector('#connection-dialog[open]');
}
/** The real DSH protocol: a live $events stream answers with its ready item. */
async function mux(frame, keep = false) {
  return await frame.evaluate(async keep => {
    const saved = window.__DRDSH_EMBEDDED_SMOKE_SOCKET__;
    const socket = saved ?? new WebSocket(new URL('api/remote.mux', document.baseURI).href.replace(/^http/u, 'ws'));
    if (keep) window.__DRDSH_EMBEDDED_SMOKE_SOCKET__ = socket;
    return await new Promise(resolve => {
      const id = `embedded-smoke-${crypto.randomUUID()}`;
      let finished = false;
      const finish = result => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        socket.removeEventListener('message', message);
        socket.removeEventListener('close', closed);
        socket.removeEventListener('error', closed);
        if (!keep && !saved) socket.close();
        resolve(result);
      };
      const closed = () => finish(false);
      const message = event => {
        try {
          const value = JSON.parse(String(event.data));
          if (value.streamId === id && value.type === 'item' && value.value?.type === 'ready') finish(true);
        } catch { finish(false); }
      };
      const send = () => socket.send(JSON.stringify({ type: 'open', streamId: id, endpoint: '$events', payload: { args: {} } }));
      const timer = setTimeout(() => finish(false), 15_000);
      socket.addEventListener('message', message);
      socket.addEventListener('close', closed);
      socket.addEventListener('error', closed);
      if (socket.readyState === 1) send();
      else if (socket.readyState === 0) socket.addEventListener('open', send, { once: true });
      else finish(false);
    });
  }, keep);
}

async function workspacePaths(frame) {
  return await frame.evaluate(async () => {
    const socket = new WebSocket(new URL('api/remote.mux', document.baseURI).href.replace(/^http/u, 'ws'));
    return await new Promise((resolve, reject) => {
      const streamId = `workspace-smoke-${crypto.randomUUID()}`;
      const timer = setTimeout(() => { socket.close(); reject(new Error('workspace baseline timed out')); }, 15_000);
      socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'workspace/follow', payload: { args: {} } })));
      socket.addEventListener('message', event => {
        const message = JSON.parse(String(event.data));
        if (message.streamId !== streamId || message.type !== 'item' || message.value?.type !== 'baseline') return;
        clearTimeout(timer);
        socket.close();
        resolve(message.value.value.items.map(workspace => workspace.path));
      });
    });
  });
}

async function browseHostDirectory(frame, path) {
  await frame.getByRole('button', { name: 'Add workspace', exact: true }).click();
  const dialog = frame.getByRole('dialog', { name: 'Select Workspace Directory', exact: true });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Edit path', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Edit path', exact: true }).fill(path);
  await dialog.getByRole('textbox', { name: 'Edit path', exact: true }).press('Enter');
  await dialog.getByRole('button', { name: 'Edit path', exact: true }).waitFor();
  return dialog;
}

try {
  const relayPort = await freePort();
  const realPort = await freePort();
  const fakePort = await freePort();
  let url = `http://127.0.0.1:${relayPort}`;
  const relayWs = url.replace(/^http/u, 'ws');
  start('relay', ['relay', 'run', '--bind', `127.0.0.1:${relayPort}`, '--client-dir', join(scratch, 'client')]);
  await until(async () => { try { return (await fetch(`${url}/healthz`)).ok; } catch { return false; } }, 'relay');
  if (args.includes('--check-slow-transfer')) {
    slowGate = await receiverGate(relayPort);
    url = `http://127.0.0.1:${slowGate.port}`;
  }
  const firstKey = randomBytes(32).toString('base64url');
  const secondKey = randomBytes(32).toString('base64url');
  mkdirSync(join(scratch, 'host-home'), { recursive: true });
  mkdirSync(join(scratch, 'real-home/profiles/web'), { recursive: true });
  // Directory browsing needs no model credentials. Keep the normal preview
  // notice, but avoid the automatic credential dialog in this isolated profile.
  writeFileSync(join(scratch, 'real-home/profiles/web/cordis.patch.yml'),
    "- id: ui-settings-models\n  name: '@deepseek-ai/dsh-client-ui-settings-models'\n  config:\n    credentialOnboarding: false\n");
  const real = start('real DSH', ['daemon', 'run', '--relay', relayWs, '--room-key', firstKey, '--port', String(realPort)], {
    HOME: join(scratch, 'host-home'), DSH_HOME: join(scratch, 'real-home'), DSHD_STATE_DIR: join(scratch, 'real-state'), DSHD_DSH: resolve(dsh),
  });
  const wrapper = join(scratch, 'fake-dsh.mjs');
  writeFileSync(wrapper, `#!${process.execPath}\nif (process.argv.includes('--dump-config')) { console.log('[]'); process.exit(0); }\nconst port = process.argv[process.argv.indexOf('--port') + 1];\nprocess.argv = [process.argv[0], process.argv[1], port];\nawait import(${JSON.stringify(new URL('../crates/dr-dsh-daemon/tests/fixtures/fake-dsh.mjs', import.meta.url).href)});\n`, { mode: 0o700 });
  const fake = start('second room fixture', ['daemon', 'run', '--relay', relayWs, '--room-key', secondKey, '--port', String(fakePort)], {
    DSH_HOME: join(scratch, 'fake-home'), DSHD_STATE_DIR: join(scratch, 'fake-state'), DSHD_DSH: wrapper,
  });
  await until(() => /relay: Connected/u.test(real.log()) && /relay: Connected/u.test(fake.log()), 'both daemon rooms', 90_000);
  browser = await chromium.launch({ executablePath: chromiumPath, headless: !args.includes('--headed') });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  if (args.includes('--diagnose-api')) context.on('response', async response => {
    if (!new URL(response.url()).pathname.includes('/api/')) return;
    try {
      const body = await response.json();
      if (body?.result?.ok === false) console.log('API diagnostic', new URL(response.url()).pathname, JSON.stringify({ code: body.result.error?.code, message: body.result.error?.message }));
    } catch { /* Only structured API failures are relevant. */ }
  });
  const errors = [];
  context.on('weberror', event => errors.push(event.error().message));
  page = await context.newPage();
  let frame = slowGate ? await connectSlow(page, url, firstKey, slowGate) : await connect(page, url, firstKey);
  assert.equal(context.pages().length, 1);
  assert.equal(new URL(page.url()).pathname, '/');
  assert.equal(await mux(frame, true), true);
  check('a real DSH opens automatically in the connected page and its live mux answers');
  await frame.evaluate(() => {
    const events = new EventSource(new URL('./plugins/events', location.href));
    window.__DRDSH_SMOKE_EVENTS__ = { source: events, graphs: 0 };
    events.addEventListener('message', event => {
      if (JSON.parse(event.data).type === 'graph') window.__DRDSH_SMOKE_EVENTS__.graphs += 1;
    });
  });
  await until(() => frame.evaluate(() => window.__DRDSH_SMOKE_EVENTS__.graphs > 0), 'an initial plugin graph before the event stream ends', 8000);
  assert.equal(await frame.evaluate(() => window.__DRDSH_SMOKE_EVENTS__.source.readyState), 1);
  check('the real plugin event stream delivers its graph while the HTTP response remains open');
  if (args.includes('--check-account-origin')) {
    const account = await frame.evaluate(async () => {
      const call = async (method, args) => {
        const response = await fetch(`/api/${method}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } }),
        });
        if (!response.ok) throw new Error(`account RPC returned HTTP ${response.status}`);
        return await response.json();
      };
      const state = await call('account/getState', {});
      const refusal = await call('account/startSignIn', {
        client: { version: 'drdsh-browser-smoke', locale: 'en', timezoneOffsetSeconds: 0 },
        callbackOrigin: 'https://relay.example', loginSource: 'web',
      });
      return { state, refusal };
    });
    assert.equal(account.state.result.ok, true);
    assert.equal(account.state.result.value.status, 'signed-out');
    assert.equal(account.refusal.result.ok, false);
    assert.match(JSON.stringify(account.refusal.result.error), /protocol|callback|origin/iu);
    check('account status works through the tunnel; DSH rejects a public sign-in callback without weakening its loopback boundary');
  }

  const stale = await context.newPage();
  await stale.goto(`${url}/__dr/interface`, { waitUntil: 'domcontentloaded' });
  assert.equal(new URL(stale.url()).pathname, '/', 'an old standalone interface bookmark must return to the connection shell');
  assert.equal(await stale.locator('#connection-manager').isVisible(), true);
  await stale.close();
  assert.equal(await mux(frame, true), true);
  check('an old standalone interface bookmark returns to the connection page without borrowing another room');

  const initialDocument = await frame.evaluate(() => performance.timeOrigin);
  const frameBox = await page.locator('#harness-frame').boundingBox();
  assert.deepEqual(frameBox, { x: 0, y: 0, width: 1280, height: 900 });
  const float = page.locator('#return-to-connection');
  let floatBox = await float.boundingBox();
  assert.equal(floatBox.width, 44);
  await page.mouse.move(floatBox.x + 22, floatBox.y + 22);
  await page.mouse.down();
  await page.mouse.move(115, 620, { steps: 10 });
  await page.mouse.up();
  assert.equal(await page.locator('#connection-dialog').isVisible(), false, 'a drag must not also open controls');
  floatBox = await float.boundingBox();
  assert.equal(floatBox.x, 12, 'the dragged button docks to the nearest edge');
  await float.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal((await float.boundingBox()).x, 1224);
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#connection-dialog').isVisible(), true);
  assert.equal(await frame.evaluate(() => performance.timeOrigin), initialDocument);
  assert.equal(await mux(frame, true), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#connection-dialog').isVisible(), false);
  assert.equal(await float.evaluate(button => document.activeElement === button), true);
  await openControls(page);
  await page.mouse.click(5, 5);
  assert.equal(await page.locator('#connection-dialog').isVisible(), false, 'clicking the backdrop dismisses controls');
  await openControls(page);
  await page.click('#close-controls');
  assert.equal(await frame.evaluate(() => performance.timeOrigin), initialDocument);
  check('floating controls dock by drag or keyboard; their dialog closes without replacing the live Harness');

  await frame.getByRole('button', { name: 'Continue', exact: true }).click();
  const hostDirectory = join(scratch, 'host folders');
  const existingWorkspace = join(hostDirectory, 'existing 工作区');
  mkdirSync(existingWorkspace, { recursive: true });
  let directoryDialog = await browseHostDirectory(frame, hostDirectory);
  await directoryDialog.getByRole('button', { name: 'existing 工作区', exact: true }).click();
  await page.screenshot({ path: join(output, 'embedded-host-directory.png'), fullPage: true });
  await directoryDialog.getByRole('button', { name: 'Open', exact: true }).click();
  await directoryDialog.waitFor({ state: 'hidden' });
  assert.ok((await workspacePaths(frame)).includes(realpathSync(existingWorkspace)));
  assert.equal(await mux(frame, true), true);
  check('Add workspace browses the actual DSH host and adopts the selected directory');

  directoryDialog = await browseHostDirectory(frame, hostDirectory);
  await directoryDialog.getByRole('button', { name: 'New folder', exact: true }).click();
  await frame.getByRole('textbox', { name: 'Folder name', exact: true }).fill('created from browser');
  await frame.getByRole('button', { name: 'Create', exact: true }).click();
  await directoryDialog.getByRole('button', { name: 'Open', exact: true }).click();
  await directoryDialog.waitFor({ state: 'hidden' });
  const createdWorkspace = join(hostDirectory, 'created from browser');
  assert.ok(existsSync(createdWorkspace));
  assert.ok((await workspacePaths(frame)).includes(realpathSync(createdWorkspace)));
  check('a new folder created in the browser exists on the DSH host and becomes the workspace');

  // Previously HTTP stream 100 could deliver a failure to the live socket using
  // stream 100. Rejected management paths exercise that collision without reading data.
  const refusals = await frame.evaluate(async () => {
    const statuses = [];
    for (let start = 0; start < 160; start += 8) {
      statuses.push(...await Promise.all(Array.from({ length: 8 }, (_, index) =>
        fetch(`/__dr/_drdsh/manage?smoke=${start + index}`).then(async response => { await response.arrayBuffer(); return response.status; }))));
    }
    return statuses;
  });
  assert.ok(refusals.every(status => status === 503));
  assert.equal(await mux(frame, true), true);
  check('160 concurrent HTTP refusals do not close or confuse the existing live socket');
  const managementSocketRefused = await frame.evaluate(() => new Promise(resolve => {
    const url = new URL('/_drdsh/manage', location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    const finish = refused => { clearTimeout(timer); socket.close(); resolve(refused); };
    const timer = setTimeout(() => finish(false), 5000);
    socket.addEventListener('open', () => finish(false), { once: true });
    socket.addEventListener('error', () => finish(true), { once: true });
    socket.addEventListener('close', () => finish(true), { once: true });
  }));
  assert.equal(managementSocketRefused, true);
  assert.equal(await mux(frame, true), true);
  check('the encrypted WebSocket proxy also refuses the local management namespace');

  const second = await context.newPage();
  const otherFrame = await connect(second, url, secondKey, false);
  assert.ok(await frame.evaluate(async () => (await (await fetch('/')).text()).includes('__DSH_BOOT__')));
  assert.ok(await otherFrame.evaluate(async () => (await (await fetch('/')).text()).includes('fake dsh')));
  check('two pages on one origin keep their HTTP traffic bound to their own machines');

  const workerDebug = await context.newCDPSession(page);
  let activeWorkerId;
  workerDebug.on('ServiceWorker.workerVersionUpdated', event => {
    for (const version of event.versions) {
      if (version.status === 'activated' && version.runningStatus === 'running') activeWorkerId = version.versionId;
    }
  });
  await workerDebug.send('ServiceWorker.enable');
  const graphsBeforeReplacement = await frame.evaluate(() => window.__DRDSH_SMOKE_EVENTS__.graphs);
  const replacement = [page, second].map(tab => tab.evaluate(() => new Promise(resolve => {
    navigator.serviceWorker.addEventListener('controllerchange', () => resolve(true), { once: true });
  })));
  appendFileSync(join(scratch, 'client/service-worker.js'), `\n// smoke worker replacement ${Date.now()}\n`);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register(`/client/service-worker.js?replacement=${Date.now()}`, { type: 'module', scope: '/', updateViaCache: 'none' });
  });
  await Promise.race([Promise.all(replacement), delay(20_000).then(() => { throw new Error('worker replacement timed out'); })]);
  await until(async () => {
    try {
      return await frame.evaluate(async () => (await (await fetch('/')).text()).includes('__DSH_BOOT__'))
        && await otherFrame.evaluate(async () => (await (await fetch('/')).text()).includes('fake dsh'));
    } catch { return false; }
  }, 'HTTP routing after worker replacement');
  assert.equal(await mux(frame, true), true);
  check('a service worker replacement restores both live ports without mixing machines');
  await until(() => frame.evaluate(previous => window.__DRDSH_SMOKE_EVENTS__.graphs > previous,
    graphsBeforeReplacement), 'plugin events reconnecting after worker replacement');
  check('an open plugin event stream releases the old worker and reconnects after replacement');

  assert.ok(activeWorkerId, 'Chromium exposes the active service worker for the cold-start check');
  await workerDebug.send('ServiceWorker.stopWorker', { versionId: activeWorkerId });
  assert.ok(await frame.evaluate(async () => (await (await fetch('/')).text()).includes('__DSH_BOOT__')));
  assert.ok(await otherFrame.evaluate(async () => (await (await fetch('/')).text()).includes('fake dsh')));
  assert.equal(await mux(frame, true), true);
  check('a terminated service worker restores both HTTP routes without changing the live socket');
  await frame.evaluate(() => window.__DRDSH_SMOKE_EVENTS__.source.close());

  const rival = await browser.newContext();
  const rivalPage = await rival.newPage();
  await rivalPage.goto(url, { waitUntil: 'domcontentloaded' });
  await rivalPage.fill('#key', firstKey);
  await rivalPage.click('#connect');
  await rivalPage.waitForFunction(() => document.getElementById('state')?.dataset.phase === 'failed', undefined, { timeout: 15_000 });
  assert.match(await rivalPage.locator('#state').innerText(), /in use|already|occupied|占用|其他/u);
  assert.equal(await mux(frame, true), true);
  await rival.close();
  check('a second browser is refused clearly while the first encrypted session remains usable');
  await second.close();

  for (let i = 0; i < 2; i += 1) {
    const previousOrigin = await frame.evaluate(() => performance.timeOrigin);
    await openControls(page);
    await page.click('#reload-harness');
    if (await page.locator('#connection-dialog').isVisible()) await page.click('#close-controls');
    await until(async () => {
      try {
        frame = await frameFor(page);
        return await frame.evaluate(origin => performance.timeOrigin !== origin, previousOrigin);
      } catch { return false; }
    }, 'replacement iframe document');
    assert.equal(await mux(frame), true);
  }
  check('reloading the embedded document twice replaces its socket bridge cleanly');
  assert.equal(await mux(frame, true), true);
  await page.click('#return-to-connection');
  assert.equal(await page.locator('#connection-manager').isVisible(), true);
  await page.click('#open');
  assert.equal(await mux(frame), true);
  check('returning to connection management and back preserves the Harness session');

  const idleMs = Number(option('--idle-ms', '35000'));
  await delay(idleMs);
  assert.equal(await mux(frame), true);
  assert.ok(await frame.evaluate(async () => (await (await fetch('/')).text()).includes('__DSH_BOOT__')));
  check(`the same live socket and HTTP route still answer after ${idleMs} ms idle`);
  await page.screenshot({ path: join(output, 'embedded-harness-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  floatBox = await float.boundingBox();
  assert.ok(floatBox.x >= 0 && floatBox.x + floatBox.width <= 390 && floatBox.y >= 0 && floatBox.y + floatBox.height <= 844);
  assert.deepEqual(await page.locator('#harness-frame').boundingBox(), { x: 0, y: 0, width: 390, height: 844 });
  await page.screenshot({ path: join(output, 'embedded-harness-mobile.png'), fullPage: true });
  await openControls(page);
  await page.locator('#key').evaluate(input => { input.value = ''; });
  await page.screenshot({ path: join(output, 'embedded-controls-mobile.png'), fullPage: true });
  assert.ok(await page.locator('#connection-dialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth));
  assert.deepEqual(errors, [], 'the shell and embedded page must not raise uncaught exceptions');
  check('desktop and mobile views render without uncaught browser exceptions');

  await page.click('#disconnect');
  assert.equal(await page.locator('#connection-manager').isVisible(), true);
  await page.fill('#key', firstKey);
  await page.click('#connect');
  frame = await frameFor(page);
  assert.equal(await mux(frame), true);
  check('explicit disconnect releases the room and the same page can reconnect');
  if (args.includes('--check-offline')) {
    await openControls(page);
    await page.click('#disconnect');
    await new Promise((resolveRun, rejectRun) => {
      const child = spawn(process.execPath, [join(repo, 'scripts/browser-offline-smoke.mjs'), url, firstKey], {
        cwd: repo, env: baseEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(child);
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => process.stdout.write(chunk));
      child.on('error', rejectRun);
      child.on('exit', code => code === 0 ? resolveRun() : rejectRun(new Error(`offline browser checks exited ${code}`)));
    });
    check('offline shell reload and reconnection pass in a separate real browser');
  }

  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = error.message;
  console.error(error.stack);
  if (page) {
    console.log('Failure dialogs:', JSON.stringify(await page.frames()[1]?.getByRole('dialog').allInnerTexts()));
    await page.screenshot({ path: join(output, 'embedded-failure.png'), fullPage: true, mask: [page.locator('#key')] });
  }
  process.exitCode = 1;
} finally {
  slowGate?.close();
  await browser?.close();
  for (const child of children.reverse()) {
    if (child.exitCode !== null) continue;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
  }
  await delay(700);
  for (const child of children) {
    if (child.exitCode !== null) continue;
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
  }
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(output, 'embedded-harness-checks.json'), `${JSON.stringify(report, null, 2)}\n`);
  rmSync(scratch, { recursive: true, force: true });
}
