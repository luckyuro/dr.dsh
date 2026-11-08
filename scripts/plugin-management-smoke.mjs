/**
 * Real local HTTP, verified native package and launchd/systemd jobs in a private prefix.
 * Uses the production plugin handler and manager; only DSH is a process fixture.
 * No existing daemon, relay or user autostart setting is changed.
 *
 * Usage: node scripts/plugin-management-smoke.mjs [--drdsh target/debug/drdsh] [--check-browser]
 * Exit codes: 0 passed, 1 failed, 2 prerequisites unavailable.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { nativeTarget } from '../plugins/dr.dsh/src/bootstrap.ts';
import { createLocalManagementAuthority, createManager } from '../plugins/dr.dsh/src/manager.ts';
import { createManagementHandler } from '../plugins/dr.dsh/src/management-web.ts';
import { managerAvailable, serviceState, shellQuote, stopService } from './service-manager.mjs';

const script = fileURLToPath(import.meta.url);
const repo = resolve(dirname(script), '..');
const args = process.argv.slice(2);

async function serveHost(path) {
  const settings = JSON.parse(readFileSync(path, 'utf8'));
  const manager = await createManager(settings.manager);
  const authority = await createLocalManagementAuthority({ storageRoot: manager.storageRoot });
  let handler;
  const server = createServer((req, res) => { void handler(req, res); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const surface = {
    origin, port,
    profile: { name: 'web', home: settings.dshHome, dir: settings.dshHome, cwd: settings.scratch, installAnchor: settings.scratch },
    requestRejection(req) { return req.headers.cookie === settings.cookie ? undefined : 401; },
    registerRoute() { return () => {}; }, requestHostExit() {}, onReady() { return () => {}; }, registerManagementLink() { return () => {}; },
  };
  const web = createManagementHandler(surface, {
    manager, authority, installDefaults: settings.manager.installDefaults, managed: true, localBrowserAvailable: false,
    async readAsset(file) { return readFile(file === 'validation.js' ? join(repo, 'packages/validation/src/index.js') : join(repo, 'plugins/dr.dsh/web', file)); },
    async openLocal() { throw new Error('This smoke host intentionally has no desktop browser.'); },
  });
  handler = web.handler;
  process.send({ origin });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    web.dispose(); server.closeAllConnections(); server.close(() => process.exit(0));
  });
}

async function runSmoke() {
  const nativeArgs = args.filter(arg => arg !== '--check-browser');
  if (nativeArgs.length !== 0 && (nativeArgs.length !== 2 || nativeArgs[0] !== '--drdsh')) {
    console.error('Usage: node scripts/plugin-management-smoke.mjs [--drdsh <binary>] [--check-browser]');
    process.exitCode = 2; return;
  }
  const binary = resolve(repo, nativeArgs[1] ?? 'target/debug/drdsh');
  let chromium;
  try {
    managerAvailable();
    assert.ok(existsSync(binary), 'Build the native CLI with cargo build -p dr-dsh-cli.');
    nativeTarget();
    if (args.includes('--check-browser')) chromium = (await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core')).chromium;
  } catch (error) { console.error(error.message); process.exitCode = 2; return; }
  const scratch = realpathSync(mkdtempSync('/tmp/drdsh-plugin-management-'));
  const prefix = join(scratch, 'prefix');
  const home = join(scratch, 'home');
  const dshHome = join(scratch, 'dsh-home');
  const bundle = join(scratch, 'bundle');
  const storageRoot = join(scratch, 'plugin-private');
  const configPath = join(prefix, 'etc/dr.dsh/daemon.json');
  const jobsRoot = join(prefix, 'var/lib/dr.dsh/jobs');
  for (const path of [prefix, home, dshHome, join(bundle, 'bin'), storageRoot]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DSHD_|DRDSH_|DSH_RELAY_|DSH_HOME$|FAKE_DSH_)/u.test(key)));
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'), DRDSH_BANNER_SHOWN: '1' });
  let phase = 'setup', checks = 0, host, origin, token, relay, cleaning;
  const processes = new Set();
  const check = value => console.log(`ok ${++checks} - ${value}`);
  const config = () => JSON.parse(readFileSync(configPath, 'utf8'));
  const starts = () => existsSync(join(scratch, 'dsh-starts.jsonl')) ? readFileSync(join(scratch, 'dsh-starts.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const cookie = `dsh-smoke=${randomUUID()}`;
  const alive = child => child && child.exitCode === null && child.signalCode === null;
  const timeout = (promise, label, ms = 90_000) => {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms); })]).finally(() => clearTimeout(timer));
  };
  async function until(predicate, label, ms = 30_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await predicate()) return; await delay(100); }
    throw new Error(`Timed out waiting for ${label}`);
  }
  function launch(file, argv, options = {}) {
    const child = spawn(file, argv, { cwd: scratch, env, stdio: ['pipe', 'pipe', 'pipe'], ...options });
    processes.add(child);
    child.once('close', () => processes.delete(child));
    return child;
  }
  async function command(file, argv, input, expected = 0) {
    const child = launch(file, argv);
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.stdin.end(input);
    let code;
    try { [code] = await timeout(once(child, 'close'), argv.slice(0, 2).join(' ')); }
    catch (error) { child.kill('SIGTERM'); throw error; }
    if (expected !== null) assert.equal(code, expected, `${argv.slice(0, 2).join(' ')} failed: ${stderr}`);
    return { code, stdout, stderr };
  }
  async function native(operation, params = {}, expected = true) {
    const requestId = randomUUID();
    const output = await command(binary, ['daemon', 'manage', '--prefix', prefix], JSON.stringify({ version: 1, requestId, operation, params }), expected ? 0 : 1);
    const result = JSON.parse(output.stdout);
    assert.equal(result.requestId, requestId); assert.equal(result.ok, expected);
    return expected ? result.result : result.error;
  }
  async function freePort() {
    const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = server.address().port; await new Promise(accept => server.close(accept)); return port;
  }
  async function startHost(settingsPath) {
    host = launch(process.execPath, [script, '--host', settingsPath], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...env, DRDSH_MANAGED_INSTANCE: 'plugin-management-smoke' } });
    let diagnostics = '';
    host.stdout.resume(); host.stderr.on('data', bytes => { diagnostics += bytes; });
    const ready = once(host, 'message').then(([message]) => message);
    const failure = once(host, 'exit').then(() => { throw new Error(`Management host exited before startup: ${diagnostics}`); });
    ({ origin } = await timeout(Promise.race([ready, failure]), 'management HTTP host', 15_000));
    token = undefined;
  }
  async function stopHost(signal = 'SIGTERM') {
    if (!alive(host)) return;
    const stopped = once(host, 'close'); host.kill(signal); await timeout(stopped, 'management HTTP host exit', 5_000);
  }
  async function request(path, body, overrides = {}) {
    const response = await fetch(`${origin}/_drdsh${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, ...(body === undefined ? {} : { origin, 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...overrides },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(110_000),
    });
    return response;
  }
  async function unlock() {
    const capability = readFileSync(join(storageRoot, 'local-unlock'), 'utf8').trim();
    const result = await request('/api/unlock', { capability }); assert.equal(result.status, 200);
    token = (await result.json()).token;
  }
  async function execute(operation, params = {}) {
    const response = await request('/api/execute', { operation, params });
    const result = await response.json();
    assert.equal(response.status, 200, `${operation}: ${result.error?.message}`);
    assert.equal(result.ok, true, `${operation}: ${result.error?.message}`);
    return result.result;
  }
  async function finished(id, viaHttp = true) {
    let job;
    await until(async () => {
      job = viaHttp ? await execute('job.status', { jobId: id }) : await native('job.status', { jobId: id });
      return !['queued', 'running'].includes(job.state);
    }, `job ${id}`, 90_000);
    assert.equal(job.state, 'succeeded', `${job.operation}: ${job.error?.message}`);
    assert.equal(job.exitCode, 0); assert.ok(job.workerPid && job.workerPid !== host?.pid);
    return job;
  }
  async function job(operation, params = {}) { return finished((await execute(operation, params)).jobId); }
  async function runtime() {
    let result;
    await until(async () => {
      const status = await native('status'); result = status.runtime;
      return result?.ok === true && result.result?.pid;
    }, 'daemon runtime'); return result.result;
  }
  async function cleanup() {
    if (cleaning) return; cleaning = true;
    let removable = true;
    await stopHost().catch(() => { host?.kill('SIGKILL'); });
    if (existsSync(jobsRoot)) {
      const digest = createHash('sha256').update(realpathSync(jobsRoot)).digest('hex').slice(0, 12);
      for (const id of readdirSync(jobsRoot).filter(name => /^[a-f0-9]{32}$/u.test(name))) {
        const label = `dev.drdsh.job.${digest}.${id}`;
        try {
          if (process.platform === 'darwin') await command('launchctl', ['bootout', `gui/${process.getuid()}/${label}`], undefined, null);
          else await command('systemctl', ['--user', 'stop', `${label}.service`], undefined, null);
        } catch { removable = false; }
      }
    }
    if (existsSync(configPath)) {
      try {
        const saved = config();
        const result = await command(binary, ['daemon', 'uninstall', '--prefix', prefix], undefined, null);
        if (result.code !== 0) await stopService(saved, 'daemon');
        assert.equal(serviceState(saved, 'daemon').running, false);
      } catch (error) { removable = false; console.error(`Temporary daemon cleanup failed: ${error.message}`); }
    }
    for (const child of [...processes]) {
      if (!alive(child)) continue;
      const closed = once(child, 'close'); child.kill('SIGTERM');
      await timeout(closed, 'fixture cleanup', 5_000).catch(() => child.kill('SIGKILL'));
    }
    if (removable) rmSync(scratch, { recursive: true, force: true });
    else { console.error(`Temporary service files retained at ${scratch}; stop that test service before removing them.`); process.exitCode = 1; }
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });

  try {
    const version = /drdsh\s+(\S+)/u.exec((await command(binary, ['--version'])).stdout)?.[1];
    assert.ok(version);
    copyFileSync(binary, join(bundle, 'bin/drdsh'));
    writeFileSync(join(bundle, 'bundle.json'), JSON.stringify({ format: 1, version, target: nativeTarget(), components: ['daemon'] }), { mode: 0o600 });
    const relayPort = await freePort(), dshPort = await freePort();
    const dsh = join(scratch, 'dsh');
    writeFileSync(dsh, `#!/bin/sh\nexport DRDSH_MANAGEMENT_SMOKE_DIR=${shellQuote(scratch)}\nexec ${shellQuote(process.execPath)} ${shellQuote(join(repo, 'scripts/fixtures/daemon-management-dsh.mjs'))} "$@"\n`, { mode: 0o700 });
    const settingsPath = join(scratch, 'host.json');
    const settings = { scratch, dshHome, cookie, manager: { prefix, storageRoot, bundledDirectory: bundle, installDefaults: { dsh, dshHome, workdir: scratch, port: dshPort } } };
    writeFileSync(settingsPath, JSON.stringify(settings), { mode: 0o600 });
    relay = launch(binary, ['relay', 'run', '--bind', `127.0.0.1:${relayPort}`]);
    relay.stdout.resume(); relay.stderr.resume();
    await startHost(settingsPath);

    phase = 'local HTTP authorization and request boundary';
    for (const path of ['/manage', '/manage.js', '/api/access', '/api/state']) {
      const denied = await request(path, undefined, { cookie: '' }); assert.equal(denied.status, 401);
      assert.equal(denied.headers.get('cache-control'), 'no-store');
    }
    assert.equal((await request('/api/state')).status, 401);
    const access = await (await request('/api/access')).json();
    assert.deepEqual(Object.keys(access).sort(), ['capabilityFile', 'launchFile', 'localBrowserAvailable']);
    const opened = await request('/api/open-local', {}); assert.equal(opened.status, 503);
    const openText = await opened.text();
    assert.equal(openText.includes('#launch='), false); assert.equal(JSON.parse(openText).launchFile, access.launchFile);
    assert.equal(statSync(access.launchFile).mode & 0o777, 0o600);
    const launchSecret = new URLSearchParams(new URL(readFileSync(access.launchFile, 'utf8').trim()).hash.slice(1)).get('launch');
    const initialUnlock = await request('/api/unlock', { capability: launchSecret }); assert.equal(initialUnlock.status, 200);
    token = (await initialUnlock.json()).token;
    assert.equal((await request('/api/unlock', { capability: launchSecret })).status, 403);
    assert.equal((await request('/api/execute', { operation: 'status', params: {} }, { origin: 'https://other.example' })).status, 403);
    for (const params of [{ source: '/tmp/arbitrary' }, { prefix: '/tmp/arbitrary' }, { url: 'https://arbitrary.example' }]) {
      assert.equal((await request('/api/execute', { operation: 'install', params })).status, 400);
    }
    assert.equal((await request('/api/execute', { operation: 'shell', params: {} })).status, 400);
    assert.equal((await request('/api/unlock', { capability: 'x'.repeat(70_000) })).status, 413);
    const initial = await (await request('/api/state')).json();
    assert.equal(initial.installed, false); assert.equal(initial.hasConfiguration, false);
    check('real HTTP enforces DSH auth, local unlock, one-use launch, Origin, size and fixed operation boundaries');

    phase = 'OS-owned installation';
    const installed = await job('install', { relay: `ws://127.0.0.1:${relayPort}`, start: false, enable: false });
    assert.equal(installed.operation, 'install');
    assert.equal(config().pluginOwner, 'external'); assert.equal(config().pluginReportsEnabled, true); assert.equal(config().localAdminEnabled, true);
    assert.equal(config().dsh, dsh); assert.equal(config().port, dshPort);
    assert.equal(serviceState(config(), 'daemon').running, false);
    assert.equal(existsSync(join(scratch, 'plugin-calls.jsonl')), false);
    check('the native OS job installs daemon from the private verified package without recursively installing its host plugin');

    phase = 'service start and config persistence';
    await job('service.start');
    const running = await runtime();
    await until(() => starts().length > 0, 'managed DSH fixture');
    const stateDir = config().state;
    writeFileSync(join(stateDir, 'retention-sentinel'), 'preserved pairing state', { mode: 0o600 });
    const savedWorkdir = join(scratch, 'saved-workdir'); mkdirSync(savedWorkdir, { mode: 0o700 });
    const changed = await execute('config.set', { workdir: savedWorkdir });
    assert.equal(changed.restartRequired, true);
    assert.equal((await runtime()).pid, running.pid);
    const oldKey = readFileSync(join(stateDir, 'room-key'), 'utf8');
    check('HTTP configuration writes the sole daemon.json and leaves the running daemon unchanged until restart');

    if (chromium) {
      phase = 'browser pairing copy and cancellation';
      const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN, headless: true });
      try {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
        await context.addCookies([{ name: 'dsh-smoke', value: cookie.split('=')[1], url: origin }]);
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
        const page = await context.newPage();
        const browserErrors = [];
        page.on('pageerror', error => browserErrors.push(error.message));
        const screenshots = join(repo, 'output/playwright');
        mkdirSync(screenshots, { recursive: true });
        await page.goto(`${origin}/_drdsh/manage`, { waitUntil: 'domcontentloaded' });
        await page.screenshot({ path: join(screenshots, 'validation-management-authorization-mobile.png'), fullPage: true });
        await page.locator('#authorization summary').click();
        await page.fill('#capability', 'bad-code');
        await page.locator('#unlock-form button').click();
        await page.locator('#capability-error').waitFor({ state: 'visible' });
        assert.ok(await page.locator('#dashboard').isHidden(), 'format validation must not unlock management');
        await page.fill('#capability', readFileSync(join(storageRoot, 'local-unlock'), 'utf8').trim());
        await page.locator('#unlock-form button').click();
        await page.locator('#dashboard').waitFor({ state: 'visible' });
        await page.locator('nav a[href="#configuration"]').click();
        const beforeInvalid = readFileSync(configPath, 'utf8');
        await page.fill('#relay', 'https://relay.example');
        await page.fill('#port', '0');
        await page.fill('#workdir', 'relative');
        await page.click('#save-config');
        assert.deepEqual(browserErrors, [], 'configuration validation must not throw');
        await page.locator('#config-errors').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#config-errors li').count(), 3);
        assert.equal(await page.evaluate(() => document.activeElement.id), 'relay');
        assert.equal(readFileSync(configPath, 'utf8'), beforeInvalid, 'invalid form data must not reach the configuration writer');
        await page.screenshot({ path: join(screenshots, 'validation-management-errors-mobile.png'), fullPage: true });
        await page.locator('nav a[href="#diagnosis"]').click();
        await page.click('[data-read="doctor"]');
        await page.locator('.check').first().waitFor();
        assert.equal(await page.locator('.check').count(), 5);
        assert.match(await page.locator('#diagnosis-summary').textContent(), /需要确认/u);
        await page.click('[data-filter="warn"]');
        assert.ok(await page.locator('.check').count() > 0);
        assert.equal(await page.locator('.check:not([data-level="warn"])').count(), 0);
        await page.click('[data-filter="all"]');
        await page.screenshot({ path: join(screenshots, 'validation-management-diagnosis-mobile.png'), fullPage: true });
        await page.setViewportSize({ width: 1360, height: 960 });
        await page.screenshot({ path: join(screenshots, 'validation-management-diagnosis-desktop.png'), fullPage: true });
        await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
        await page.screenshot({ path: join(screenshots, 'validation-management-diagnosis-dark.png'), fullPage: true });
        await page.emulateMedia({ colorScheme: 'light' });
        await page.setViewportSize({ width: 390, height: 844 });
        check('browser validation blocks invalid configuration, focuses its first error and filters five real diagnostic checks');
        await page.locator('nav a[href="#devices"]').click();
        await page.click('#pair-begin');
        await page.locator('#pair-copy').waitFor({ state: 'visible' });
        assert.match(await page.locator('#pair-detail').textContent(), /http:\/\/127\.0\.0\.1/u);
        await page.click('#pair-copy');
        await page.waitForFunction(() => document.getElementById('notice').textContent.includes('配对码已复制'));
        assert.ok(await page.evaluate(async () => {
          const code = document.getElementById('pair-code').textContent;
          return !!code && await navigator.clipboard.readText() === code;
        }), 'the clipboard must contain only the visible pairing code');
        await page.click('#pair-cancel');
        await page.locator('#pairing').waitFor({ state: 'hidden' });
        assert.equal(await page.locator('#pair-code').textContent(), '');
        assert.ok(await page.locator('#pair-copy').isHidden());
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile management page must fit its viewport');
        await page.click('#lock');
        await page.locator('#dashboard').waitFor({ state: 'hidden' });
        assert.equal(await page.locator('#diagnostics').textContent(), '');
        assert.deepEqual(browserErrors, [], 'management must not emit browser exceptions');
        await page.evaluate(() => navigator.clipboard.writeText(''));
        check('the real mobile management page unlocks, copies a live pairing code, cancels it and locks without horizontal overflow');
      } finally { await browser.close(); }
    }

    phase = 'host exit during independent service restart';
    const restart = await execute('service.restart');
    assert.ok(restart.jobId);
    await until(() => {
      const state = JSON.parse(readFileSync(join(jobsRoot, restart.jobId, 'state.json'), 'utf8')).state;
      assert.ok(['queued', 'running'].includes(state), 'the restart fixture must keep the OS job active long enough to test recovery');
      return state === 'running';
    }, 'restart worker acquiring its operation lock');
    const savedRequest = JSON.parse(readFileSync(join(jobsRoot, restart.jobId, 'request.json'), 'utf8'));
    const repeated = await native('job.submit', { operation: 'service.restart', params: {}, idempotencyKey: savedRequest.idempotencyKey });
    assert.equal(repeated.jobId, restart.jobId);
    assert.ok(['queued', 'running'].includes(JSON.parse(readFileSync(join(jobsRoot, restart.jobId, 'state.json'), 'utf8')).state), 'the host must exit while its submitted job is still active');
    const oldToken = token;
    await stopHost('SIGKILL');
    await finished(restart.jobId, false);
    const restarted = await runtime(); assert.notEqual(restarted.pid, running.pid);
    await startHost(settingsPath);
    token = oldToken; assert.equal((await request('/api/state')).status, 401);
    await unlock();
    assert.equal((await execute('job.status', { jobId: restart.jobId })).state, 'succeeded');
    assert.equal(config().workdir, savedWorkdir);
    assert.equal(readFileSync(join(stateDir, 'room-key'), 'utf8'), oldKey);
    check('a service restart completes after its HTTP host is killed; a new host revokes old authorization and reads the saved result');

    phase = 'update, job idempotence and failures';
    await job('update'); await runtime();
    assert.equal(config().workdir, savedWorkdir); assert.equal(config().dsh, dsh);
    assert.equal(readFileSync(join(stateDir, 'retention-sentinel'), 'utf8'), 'preserved pairing state');
    assert.equal(readFileSync(join(stateDir, 'room-key'), 'utf8'), oldKey);
    const operation = { operation: 'service.disable', params: {}, idempotencyKey: 'plugin-smoke-repeat' };
    const first = await native('job.submit', operation); await finished(first.jobId);
    const duplicate = await native('job.submit', operation); assert.equal(duplicate.jobId, first.jobId);
    const conflict = await native('job.submit', { ...operation, operation: 'service.stop' }, false); assert.ok(conflict.message);
    const invalid = await native('job.submit', { operation: 'shell', params: {} }, false); assert.ok(invalid.message);
    check('update preserves saved settings and state; durable jobs reject unsupported work and deduplicate the same operation');

    phase = 'uninstall and reinstall from preserved configuration';
    await job('uninstall');
    let current = await (await request('/api/state')).json(); assert.equal(current.installed, false); assert.equal(current.hasConfiguration, true);
    assert.equal(serviceState(config(), 'daemon').running, false);
    assert.equal(readFileSync(join(stateDir, 'room-key'), 'utf8'), oldKey);
    const saved = await execute('config.get'); assert.equal(saved.config.workdir, savedWorkdir);
    const refused = await execute('service.start');
    let refusedResult;
    await until(async () => {
      refusedResult = await execute('job.status', { jobId: refused.jobId });
      return !['queued', 'running'].includes(refusedResult.state);
    }, 'saved failed job');
    assert.equal(refusedResult.state, 'failed'); assert.equal(refusedResult.exitCode, 1); assert.ok(refusedResult.error?.message);
    assert.equal(serviceState(config(), 'daemon').running, false);
    await job('install', { start: false, enable: false });
    current = await (await request('/api/state')).json(); assert.equal(current.installed, true);
    assert.equal(config().workdir, savedWorkdir); assert.equal(config().dsh, dsh);
    assert.equal(readFileSync(join(stateDir, 'room-key'), 'utf8'), oldKey);
    assert.equal(existsSync(join(scratch, 'plugin-calls.jsonl')), false);
    check('uninstall leaves an accurately reported retained configuration; reinstall preserves settings and pairing material');

    phase = 'private bounded job history';
    const listed = await execute('job.list'); assert.ok(listed.jobs.length >= 8);
    assert.equal(statSync(jobsRoot).mode & 0o777, 0o700);
    for (const savedJob of listed.jobs) {
      const path = join(jobsRoot, savedJob.jobId);
      assert.equal(statSync(join(path, 'state.json')).mode & 0o777, 0o600);
      const log = readFileSync(join(path, 'events.log'), 'utf8');
      assert.ok(Buffer.byteLength(log) <= 64 * 1024); assert.equal(log.includes(token), false); assert.equal(log.includes(oldKey.trim()), false);
    }
    check('saved job states and bounded diagnostics remain private and contain no management token or room key');
    console.log(`Passed ${checks} plugin management smoke checks.`);
  } catch (error) {
    console.error(`FAIL during ${phase}: ${error.stack ?? error}`);
    process.exitCode = 1;
  } finally { await cleanup(); }
}

if (args[0] === '--host' && args.length === 2) await serveHost(args[1]);
else await runSmoke();
