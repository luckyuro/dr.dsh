import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createManagementHandler, createTrustedLauncher, isLoopbackPeer } from './management-web.ts';
import { createLocalManagementAuthority } from './manager.ts';
import type { NativeResponse } from './manager.ts';
import type { DshManagementSurface } from './dsh-surface.ts';

async function fixture(execute?: (operation: unknown, params: unknown) => Promise<NativeResponse>) {
  const directory = await mkdtemp(join(tmpdir(), 'drdsh-management-web-'));
  let handler: ReturnType<typeof createManagementHandler>['handler'] | undefined;
  const server = createServer((req, res) => { void handler?.(req, res); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const authority = await createLocalManagementAuthority({ storageRoot: directory });
  const capability = (await readFile(authority.capabilityFile, 'utf8')).trim();
  const seen: { operation: unknown; params: unknown }[] = [];
  const launched: string[] = [];
  let failOpen = false;
  const surface: DshManagementSurface = {
    origin, port: address.port,
    attachCredentials() { return { port: address.port, token: 'x'.repeat(43) }; },
    profile: { name: 'web', home: join(directory, 'dsh-home'), dir: join(directory, 'profile'), cwd: directory, installAnchor: directory },
    registerRoute() { return () => {}; },
    requestRejection(req) { return req.headers.cookie === 'dsh-session=valid' ? undefined : 401; },
    requestHostExit() {}, onReady() { return () => {}; }, registerManagementLink() { return () => {}; },
  };
  const web = createManagementHandler(surface, {
    manager: {
      async state() { return { prefix: join(directory, 'prefix'), installed: false, hasConfiguration: false, nativeReady: false, bootstrapRequired: true }; },
      async execute(operation, params) {
        seen.push({ operation, params });
        if (execute) return execute(operation, params);
        return { version: 1, requestId: 'native-test', ok: true, result: { accepted: true } };
      },
    },
    authority, managed: false, localBrowserAvailable: true,
    installDefaults: { dsh: join(directory, 'launcher'), dshHome: surface.profile.home, workdir: directory, port: address.port },
    async readAsset(file) { return Buffer.from(`asset:${file}`); },
    async openLocal(url) { launched.push(url); if (failOpen) throw new Error(`untrusted spawnargs ${url}`); },
  });
  handler = web.handler;
  const headers = { cookie: 'dsh-session=valid', origin, 'content-type': 'application/json' };
  const send = (path: string, body: unknown, extra: Record<string, string> = {}) => fetch(`${origin}/_drdsh${path}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  const unlock = async () => {
    const response = await send('/api/unlock', { capability });
    assert.equal(response.status, 200);
    return (await response.json() as { token: string }).token;
  };
  return {
    directory, origin, capability, authority, surface, headers, seen, launched, send, unlock, web,
    failOpen() { failOpen = true; },
    async close() {
      web.dispose();
      server.closeAllConnections();
      await new Promise<void>(accept => server.close(() => accept()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('all real HTTP paths retain DSH auth, headers prevent embedding, and public access exposes paths only', async () => {
  const app = await fixture();
  try {
    for (const path of ['/manage', '/manage.css', '/manage.js', '/api/access', '/api/state']) {
      const denied = await fetch(`${app.origin}/_drdsh${path}`);
      assert.equal(denied.status, 401);
      assert.equal(denied.headers.get('cache-control'), 'no-store');
      assert.match(denied.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/u);
      assert.equal(denied.headers.get('access-control-allow-origin'), null);
    }
    const page = await fetch(`${app.origin}/_drdsh/manage`, { headers: app.headers });
    assert.equal(page.status, 200);
    assert.equal(await page.text(), 'asset:manage.html');
    const access = await fetch(`${app.origin}/_drdsh/api/access`, { headers: app.headers });
    const text = await access.text();
    assert.equal(text.includes(app.capability), false);
    assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['capabilityFile', 'launchFile', 'localBrowserAvailable']);
    assert.equal((await fetch(`${app.origin}/_drdsh/manage?unknown=1`, { headers: app.headers })).status, 404);
    assert.equal((await app.send('/api/access', {})).status, 405);
  } finally { await app.close(); }
});

test('cookie and Origin never replace local management unlock; POST body and field contracts are enforced', async () => {
  const app = await fixture();
  try {
    assert.equal((await fetch(`${app.origin}/_drdsh/api/state`, { headers: app.headers })).status, 401);
    assert.equal((await app.send('/api/unlock', { capability: app.capability }, { origin: 'http://unrelated.example' })).status, 403);
    assert.equal((await app.send('/api/unlock', { capability: app.capability }, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await app.send('/api/unlock', { capability: app.capability, extra: true })).status, 400);
    assert.equal((await app.send('/api/unlock', { capability: 'x'.repeat(70_000) })).status, 413);
    const malformed = await fetch(`${app.origin}/_drdsh/api/unlock`, { method: 'POST', headers: app.headers, body: '{' });
    assert.equal(malformed.status, 400);
    assert.equal((await app.send('/api/execute', { operation: 'status', params: {} })).status, 401);
    assert.equal(app.seen.length, 0);
    const token = await app.unlock();
    const authorization = { authorization: `Bearer ${token}` };
    const state = await fetch(`${app.origin}/_drdsh/api/state`, { headers: { ...app.headers, ...authorization } });
    const value = await state.json() as { host: { port: number; managed: boolean }; installDefaults: { dsh: string } };
    assert.equal(state.status, 200);
    assert.equal(value.host.port, app.surface.port);
    assert.equal(value.host.managed, false);
    assert.equal(value.installDefaults.dsh, join(app.directory, 'launcher'));
    assert.equal((await app.send('/api/execute', { operation: 'status', params: {}, ignored: true }, authorization)).status, 400);
    assert.equal((await app.send('/api/execute', { operation: 'status', params: {} }, authorization)).status, 200);
    assert.deepEqual(app.seen, [{ operation: 'status', params: {} }]);
    app.authority.close();
    assert.equal((await app.send('/api/execute', { operation: 'status', params: {} }, authorization)).status, 401);
  } finally { await app.close(); }
});

test('local-open keeps the launch capability out of both successful and failed HTTP responses', async () => {
  const app = await fixture();
  try {
    const result = await app.send('/api/open-local', {});
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { opened: true });
    assert.equal(app.launched.length, 1);
    const launch = new URLSearchParams(new URL(app.launched[0]!).hash.slice(1)).get('launch');
    assert.ok(launch);
    assert.equal((await app.send('/api/unlock', { capability: launch })).status, 200);
    assert.equal((await app.send('/api/unlock', { capability: launch })).status, 403);
    app.failOpen();
    const failed = await app.send('/api/open-local', {});
    assert.equal(failed.status, 503);
    const text = await failed.text();
    const fragment = new URLSearchParams(new URL(app.launched[1]!).hash.slice(1)).get('launch');
    assert.equal(text.includes(fragment!), false);
    assert.equal(text.includes('spawnargs'), false);
    assert.equal(JSON.parse(text).launchFile, app.authority.launchFile);
  } finally { await app.close(); }
});

test('real HTTP slow bodies time out in five seconds', async () => {
  const app = await fixture();
  try {
    const started = Date.now();
    const response = await new Promise<{ status: number; text: string }>((accept, reject) => {
      const req = request(`${app.origin}/_drdsh/api/unlock`, { method: 'POST', headers: { ...app.headers, 'transfer-encoding': 'chunked' } }, res => {
        let text = '';
        res.on('data', bytes => { text += bytes; });
        res.on('end', () => { req.destroy(); accept({ status: res.statusCode ?? 0, text }); });
      });
      req.on('error', reject);
      req.write('{');
    });
    assert.equal(response.status, 408);
    assert.equal(JSON.parse(response.text).error.code, 'body_timeout');
    assert.ok(Date.now() - started >= 4_900 && Date.now() - started < 7_000);
  } finally { await app.close(); }
});

test('sixteen in-flight calls bound the HTTP surface and disposal revokes sessions without cancelling native jobs', async () => {
  const completions: (() => void)[] = [];
  const app = await fixture(async () => new Promise(accept => {
    completions.push(() => accept({ version: 1, requestId: 'later', ok: true, result: { jobId: 'durable' } }));
  }));
  try {
    const token = await app.unlock();
    const pending = Array.from({ length: 16 }, () => app.send('/api/execute', { operation: 'job.status', params: { jobId: 'test' } }, { authorization: `Bearer ${token}` }));
    const deadline = Date.now() + 2_000;
    while (completions.length < 16 && Date.now() < deadline) await delay(10);
    assert.equal(completions.length, 16);
    assert.equal((await fetch(`${app.origin}/_drdsh/api/access`, { headers: app.headers })).status, 503);
    app.web.dispose();
    assert.equal(app.authority.authorize(token), false);
    for (const response of await Promise.all(pending)) assert.equal(response.status, 503);
    for (const complete of completions) complete();
    await delay(5);
  } finally { for (const complete of completions) complete(); await app.close(); }
});

test('arbitrary backend errors cannot expose native diagnostics to HTTP callers', async () => {
  const app = await fixture(async () => { throw new Error('secret payload from a raw Node exception'); });
  try {
    const token = await app.unlock();
    const response = await app.send('/api/execute', { operation: 'status', params: {} }, { authorization: `Bearer ${token}` });
    assert.equal(response.status, 500);
    assert.equal((await response.text()).includes('secret payload'), false);
  } finally { await app.close(); }
});

test('loopback addresses are checked from the socket and the generated launcher preserves literal argv', async () => {
  for (const value of ['127.0.0.1', '127.2.3.4', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopbackPeer(value), true);
  for (const value of [undefined, 'localhost', '127.0.0.999', '192.168.1.1', '::ffff:192.168.1.1']) assert.equal(isLoopbackPeer(value), false);
  const directory = await mkdtemp(join(tmpdir(), 'drdsh-launcher-'));
  try {
    const script = join(directory, "entry's script.mjs");
    await writeFile(script, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
    const launcher = await createTrustedLauncher(directory, process.execPath, script);
    assert.equal((await stat(launcher)).mode & 0o777, 0o700);
    const expected = ['web', 'a b', "literal'quote", '$(not-a-command)'];
    const child = spawn(launcher, expected, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    assert.equal((await once(child, 'close'))[0], 0);
    assert.deepEqual(JSON.parse(stdout), expected);
    await writeFile(launcher, 'changed');
    await assert.rejects(createTrustedLauncher(directory, process.execPath, script), /differs from this running CLI/u);
    await assert.rejects(createTrustedLauncher(directory, process.execPath, 'relative.mjs'), /absolute local CLI/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
