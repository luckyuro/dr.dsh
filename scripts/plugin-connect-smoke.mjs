/** Real DSH plugin owns the production native tunnel, without installing a daemon service.
 * Usage: node scripts/plugin-connect-smoke.mjs --dsh /absolute/path/dsh [--drdsh /absolute/path/drdsh] [--check-browser]
 * Requires native binaries; uses temporary profiles, pairing and real DSH events without a model.
 * --check-browser also checks DSH's explicit browse patch across settings recomposition in Chromium.
 * PLAYWRIGHT_MODULE and CHROMIUM_BIN select an existing browser installation.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect as netConnect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ControlClient } from '../apps/pwa/src/control.ts';
import { pairWithCode } from '../apps/pwa/src/pair.ts';
import { encodeRequest, request } from '../apps/pwa/src/proxy.ts';
import { Tunnel } from '../apps/pwa/src/tunnel.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (key, fallback) => { const index = args.indexOf(key); return index === -1 ? fallback : args[index + 1]; };
const dsh = option('--dsh');
const native = resolve(option('--drdsh', join(repo, 'target/debug/drdsh')));
const relayBinary = resolve(option('--relay-binary', join(dirname(native), 'drdsh-relay')));
if (!dsh || ![dsh, native, relayBinary].every(existsSync)) {
  console.error('Provide --dsh and built drdsh/drdsh-relay binaries; run cargo build --workspace first.');
  process.exit(2);
}
let chromium;
if (args.includes('--check-browser')) {
  try { chromium = (await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core')).chromium; }
  catch { console.error('Provide PLAYWRIGHT_MODULE pointing to an installed Playwright module for --check-browser.'); process.exit(2); }
}
const scratch = mkdtempSync('/tmp/drdsh-plugin-connect-');
const home = join(scratch, 'home');
const managerStorage = join(scratch, 'manager');
mkdirSync(managerStorage, { mode: 0o700 });
const environment = { ...process.env, DSH_HOME: home, CI: '1', DRDSH_MANAGER_STORAGE: managerStorage };
for (const key of ['DRDSH_REPORT_URL', 'DRDSH_REPORT_TOKEN', 'DRDSH_MANAGED_INSTANCE', 'DSHD_STATE_DIR',
  'DSHD_DSH_TLS', 'DSHD_PLUGIN_REPORTS', 'DSHD_ADMIN', 'DSH_RELAY_TLS_CERT', 'DSH_RELAY_TLS_KEY']) delete environment[key];
const children = new Set();
const sockets = new Set();
const descendantPids = new Set();
let checks = 0;
let lastStage = 'prerequisites';
const check = name => { console.log(`ok ${++checks} - ${name}`); lastStage = name; };
function start(binary, argv, extra = {}) {
  const child = spawn(binary, argv, { cwd: scratch, env: { ...environment, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let output = '';
  child.stdout.on('data', data => { if (output.length < 1024 * 1024) output += data; });
  child.stderr.on('data', data => { if (output.length < 1024 * 1024) output += data; });
  const done = new Promise((accept, reject) => { child.once('error', reject); child.once('close', code => accept(code)); });
  done.catch(() => {});
  return { child, done, output: () => output };
}
async function command(binary, argv, extra = {}, timeout = 120_000) {
  const running = start(binary, argv, extra);
  const timer = setTimeout(() => running.child.kill('SIGKILL'), timeout);
  try { assert.equal(await running.done, 0, 'local setup command failed'); return running.output(); }
  finally { clearTimeout(timer); }
}
async function until(fn, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await fn()) return; await delay(50); }
  throw new Error(`Timed out waiting for ${label}`);
}
async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(accept => server.close(accept)); return port;
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function adminSocket(stateDir) {
  const canonical = realpathSync(stateDir);
  const direct = join(canonical, '.runtime/admin.sock');
  return Buffer.byteLength(direct) < 100 ? direct
    : `/tmp/drdsh-${process.getuid()}/${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}.sock`;
}
async function adminRequest(stateDir, operation, params = {}) {
  return await new Promise((accept, reject) => {
    const socket = netConnect(adminSocket(stateDir));
    let data = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('local management timed out')); }, 5_000);
    socket.once('connect', () => socket.end(`${JSON.stringify({ version: 1, requestId: `smoke-${operation}`, operation, params })}\n`));
    socket.on('data', chunk => { data += chunk; });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
    socket.once('end', () => { clearTimeout(timer); try { accept(JSON.parse(data)); } catch { reject(new Error('invalid local status')); } });
  });
}
const relayPort = await freePort();
const relayUrl = `ws://127.0.0.1:${relayPort}`;
async function connect(room) {
  const socket = new WebSocket(`${relayUrl}/ws/client`); sockets.add(socket); socket.binaryType = 'arraybuffer';
  const receive = [], closed = [];
  socket.addEventListener('message', event => { if (typeof event.data !== 'string') for (const fn of [...receive]) fn(new Uint8Array(event.data)); });
  socket.addEventListener('close', () => { for (const fn of [...closed]) fn('smoke connection closed'); });
  await new Promise((accept, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('relay room join timed out')); }, 10_000);
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('relay connection failed')); }, { once: true });
    socket.addEventListener('open', () => socket.send(JSON.stringify({ role: 'client', room, proto: [0, 1] })), { once: true });
    socket.addEventListener('message', function ready(event) {
      if (typeof event.data !== 'string') return;
      socket.removeEventListener('message', ready); clearTimeout(timer);
      if (event.data.includes('ready')) accept(); else { socket.close(); reject(new Error('relay room is not ready')); }
    });
  });
  return { send: bytes => socket.send(bytes), receive: fn => receive.push(fn), closed: fn => closed.push(fn), close: () => socket.close() };
}
async function connectWhenReady(room) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try { return await connect(room); }
    catch (error) {
      if (error.message !== 'relay room is not ready' || Date.now() >= deadline) throw error;
      await delay(50);
    }
  }
}
let control, tunnel, browser;
try {
  const version = (await command(dsh, ['--version'])).trim();
  const target = process.platform === 'darwin' && process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-unknown-linux-musl';
  const archive = join(scratch, 'plugin.tgz');
  await command(process.execPath, [join(repo, 'scripts/package-plugin.mjs'), '--native', `${target}=${native}`, '--output', archive]);
  await command(dsh, ['plugin', '--profile', 'web', 'add', archive]);
  check(`real DSH ${version} installs the production plugin with its native companion`);
  const stateDir = join(home, 'dr.dsh', createHash('sha256').update(join(home, 'profiles/web')).digest('hex').slice(0, 16), 'state');
  const trigger = join(scratch, 'trigger'), result = join(scratch, 'result.json'), hostFile = join(scratch, 'host.json');
  const fixture = join(scratch, 'probe.mjs');
  writeFileSync(fixture, `import {writeFileSync} from 'node:fs';\nimport {apply as events} from ${JSON.stringify(pathToFileURL(join(repo, 'scripts/fixtures/live-notification-probe.mjs')).href)};\nexport const inject=['agents','goals'];\nexport function apply(ctx,config){writeFileSync(${JSON.stringify(hostFile)},JSON.stringify({pid:process.pid}));events(ctx,config);}\n`);
  const patch = join(scratch, 'relay.patch.json');
  writeFileSync(patch, JSON.stringify([
    { id: 'dr.dsh', config: { relayUrl, report: ['turn_complete', 'approval_requested', 'goal_complete', 'subagent_complete'] } },
    { insert: [{ id: 'dr.dsh-connect-smoke', name: fixture, config: { trigger, result, cwd: scratch } }] },
    ...(chromium ? [
      { id: 'directory-picker', name: '@deepseek-ai/dsh-host-directory-picker-auto', disabled: true },
      { insert: [
        { id: 'drdsh-directory-picker', name: '@deepseek-ai/dsh-host-directory-picker-browse' },
        { id: 'drdsh-directory-picker-ui', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' },
      ] },
      { id: 'ui-settings-models', config: { credentialOnboarding: false } },
    ] : []),
  ]));
  let relay = start(relayBinary, [], { DSH_RELAY_BIND: `127.0.0.1:${relayPort}` });
  await until(() => relay.output().includes('listening on'), 'relay startup');
  const port = await freePort();
  const host = start(dsh, ['web', '--patch', patch, '--no-open', '--port', String(port)]);
  await until(() => {
    assert.equal(host.child.exitCode, null, 'DSH exited before plugin startup');
    return host.output().includes('plugin tunnel ready') && existsSync(hostFile);
  }, 'plugin native startup', 60_000);
  const hostPid = JSON.parse(readFileSync(hostFile, 'utf8')).pid; descendantPids.add(hostPid);
  const nativeState = await adminRequest(stateDir, 'status');
  assert.equal(nativeState.ok, true); assert.equal(nativeState.result.lifecycle.owned, false);
  const nativePid = nativeState.result.pid; descendantPids.add(nativePid);
  check('standalone plugin starts an attach tunnel with owned=false and no installed daemon service');
  const origin = `http://127.0.0.1:${port}`;
  const launchToken = /dsh web: http:\/\/127\.0\.0\.1:\d+\/\?token=([A-Za-z0-9_-]+)/u.exec(host.output())?.[1];
  assert.ok(launchToken, 'DSH must publish its authenticated local launch URL');
  const login = await fetch(`${origin}/?token=${launchToken}`, { redirect: 'manual' });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
  await login.body?.cancel();
  assert.equal((await fetch(`${origin}/_drdsh/manage`)).status, 401);
  const localPage = await fetch(`${origin}/_drdsh/manage`, { headers: { cookie } });
  assert.equal(localPage.status, 200); await localPage.body?.cancel();
  assert.equal((await fetch(`${origin}/_drdsh/api/state`, { headers: { cookie } })).status, 401);
  const capability = readFileSync(join(managerStorage, 'local-unlock'), 'utf8').trim();
  const unlock = await fetch(`${origin}/_drdsh/api/unlock`, { method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ capability }) });
  assert.equal(unlock.status, 200);
  const managementToken = (await unlock.json()).token;
  const localState = await fetch(`${origin}/_drdsh/api/state`, { headers: { cookie, authorization: `Bearer ${managementToken}` } });
  assert.equal(localState.status, 200);
  const safeState = JSON.stringify(await localState.json());
  assert.equal(safeState.includes(capability), false); assert.equal(safeState.includes(launchToken), false);
  check('real DSH local management preserves host login and requires an independent private capability');
  if (chromium) {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN, headless: true });
    const tab = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try { await tab.goto(`${origin}/?token=${launchToken}`, { waitUntil: 'domcontentloaded' }); }
    catch { throw new Error('the isolated DSH browser could not open its local authenticated launch URL'); }
    await tab.getByRole('button', { name: 'Continue', exact: true }).click();
    await tab.getByRole('button', { name: 'Continue', exact: true }).waitFor({ state: 'hidden' });
    check('standalone DSH accepts the preview notice and recomposes settings without duplicate picker providers');
    for (const name of ['selected before reload', 'selected after reload']) {
      if (name.endsWith('after reload')) await tab.reload({ waitUntil: 'domcontentloaded' });
      const directory = join(scratch, name);
      mkdirSync(directory);
      await tab.getByRole('button', { name: 'Add workspace', exact: true }).click();
      const dialog = tab.getByRole('dialog', { name: 'Select Workspace Directory', exact: true });
      await dialog.waitFor();
      await dialog.getByRole('button', { name: 'Edit path', exact: true }).click();
      const path = dialog.getByRole('textbox', { name: 'Edit path', exact: true });
      await path.fill(directory); await path.press('Enter');
      await dialog.getByRole('button', { name: 'Edit path', exact: true }).waitFor();
      await dialog.getByRole('button', { name: 'Open', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      const paths = await tab.evaluate(async () => {
        const socket = new WebSocket(new URL('api/remote.mux', document.baseURI).href.replace(/^http/u, 'ws'));
        return await new Promise((accept, reject) => {
          const streamId = `plugin-browser-${crypto.randomUUID()}`;
          const timer = setTimeout(() => { socket.close(); reject(new Error('workspace baseline timed out')); }, 15_000);
          socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'workspace/follow', payload: { args: {} } })));
          socket.addEventListener('message', event => {
            const message = JSON.parse(String(event.data));
            if (message.streamId !== streamId || message.type !== 'item' || message.value?.type !== 'baseline') return;
            clearTimeout(timer); socket.close();
            accept(message.value.value.items.map(workspace => workspace.path));
          });
        });
      });
      assert.ok(paths.includes(realpathSync(directory)));
    }
    check('explicit DSH browse patch selects actual host workspaces before and after a browser reload');
    await browser.close(); browser = undefined;
  }
  // The CLI deliberately applies an existing default-prefix configuration over
  // DSHD_STATE_DIR. Address this isolated companion directly instead of pairing
  // with a user's installed daemon when the smoke runs on a deployed machine.
  const pairing = await adminRequest(stateDir, 'pair.begin', { waitSeconds: 60, expectedRelay: relayUrl });
  assert.equal(pairing.ok, true);
  assert.equal(pairing.result.relay, relayUrl);
  // IPC returns before the background pairing task has parked its relay socket.
  lastStage = 'isolated companion pairing rendezvous';
  const paired = await pairWithCode({ connect: connectWhenReady, report() {} }, { code: pairing.result.code, deviceName: 'plugin-connect-smoke' });
  let pairingStatus;
  await until(async () => {
    pairingStatus = await adminRequest(stateDir, 'pair.status', { pairingId: pairing.result.pairingId });
    assert.equal(pairingStatus.ok, true);
    return pairingStatus.result.state !== 'pending';
  }, 'isolated companion pairing completion');
  assert.equal(pairingStatus.result.state, 'complete');
  const identity = { deviceId: paired.deviceId, room: paired.room, key: paired.device.keyPair };
  lastStage = 'paired companion tunnel';
  tunnel = await Tunnel.open(await connectWhenReady(paired.room), paired.roomKey, identity);
  control = new ControlClient(tunnel);
  const status = await control.status(); assert.equal(status.owned, false); assert.equal(status.state, 'running');
  check('pairing enrolls a client and status crosses the encrypted relay tunnel');
  const page = await request(tunnel, 1, encodeRequest(1, 'GET', '/', { headers: [['accept', 'text/html']] }));
  assert.equal(page.head.status, 200); assert.match(new TextDecoder().decode(page.body), /__DSH_BOOT__/u);
  check('the client receives the real authenticated DSH interface through the plugin tunnel');
  await assert.rejects(request(tunnel, 3, encodeRequest(2, 'GET', '/_drdsh/manage')), /remote access to local daemon management is disabled/u);
  const restart = await control.command('restart'); assert.equal(restart.ok, false); assert.equal(restart.accepted, false);
  assert.equal(alive(hostPid), true);
  check('remote management paths and DSH lifecycle controls remain denied in standalone mode');
  const notifications = []; control.onNotification(value => notifications.push(value));
  writeFileSync(trigger, 'go');
  await until(() => notifications.length >= 3 && existsSync(result), 'real DSH event notifications');
  assert.deepEqual(notifications.map(value => value.event).sort(), ['goal_complete', 'subagent_complete', 'turn_complete']);
  assert.equal(JSON.parse(readFileSync(result, 'utf8')).ok, true);
  check('real DSH session and goal events reach the client as minimized plugin notifications');
  control.close(); tunnel.close(); control = undefined; tunnel = undefined;
  relay.child.kill('SIGTERM'); await relay.done; await delay(800);
  assert.equal(alive(hostPid), true); assert.equal(alive(nativePid), true);
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 401);
  relay = start(relayBinary, [], { DSH_RELAY_BIND: `127.0.0.1:${relayPort}` });
  await until(() => relay.output().includes('listening on'), 'relay restart');
  await until(async () => {
    try { tunnel = await Tunnel.open(await connect(paired.room), paired.roomKey, identity); return true; } catch { return false; }
  }, 'plugin reconnection', 30_000);
  control = new ControlClient(tunnel); assert.equal((await control.status()).state, 'running');
  check('relay loss leaves DSH running and the plugin reconnects when relay returns');
  control.close(); tunnel.close(); control = undefined; tunnel = undefined;
  process.kill(hostPid, 'SIGKILL');
  await until(() => !alive(nativePid), 'native companion exit after abrupt DSH host death');
  check('killing the DSH host closes the private pipe and reaps its native companion');
  console.log(`Passed ${checks} standalone plugin checks on DSH ${version}.`);
} catch (error) {
  // Startup output can contain the DSH launch capability; never print raw logs or assertion values.
  const location = /plugin-connect-smoke\.mjs:\d+:\d+/u.exec(error.stack ?? '')?.[0];
  console.error(`Standalone plugin smoke failed after ${lastStage}: ${error instanceof assert.AssertionError ? 'assertion failed' : error.message}${location ? ` (${location})` : ''}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  control?.close(); tunnel?.close();
  for (const socket of sockets) socket.close();
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await delay(250);
  for (const pid of descendantPids) if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  rmSync(scratch, { recursive: true, force: true });
}
