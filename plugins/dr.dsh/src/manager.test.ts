import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { nativeTarget } from './bootstrap.ts';
import { ManagementError, callNative, createLocalManagementAuthority, createManager, validateOperation } from './manager.ts';

const isError = (code: string) => (error: unknown) => error instanceof ManagementError && error.code === code;
async function executable(directory: string, source: string): Promise<string> {
  const binary = join(directory, `native-${Math.random().toString(16).slice(2)}.mjs`);
  await writeFile(binary, `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
  return binary;
}
const readRequest = "let input = ''; for await (const bytes of process.stdin) input += bytes; const request = JSON.parse(input);";

test('management requests are a closed typed set, independent of shell command syntax', () => {
  assert.throws(() => validateOperation('exec', { command: 'echo no' }), isError('unknown_operation'));
  for (const [operation, params] of [
    ['install', { source: '/tmp/arbitrary' }], ['install', { prefix: '/tmp/arbitrary' }],
    ['update', { version: 'latest' }], ['config.set', { pluginOwner: 'daemon' }],
    ['config.set', { dsh: 'dsh; echo invalid' }], ['config.set', { relay: 'https://relay.example' }],
    ['pair.begin', { waitSeconds: '30' }], ['pair.status', {}], ['job.status', { jobId: '../private' }],
  ] as const) assert.throws(() => validateOperation(operation, params), isError('invalid_params'));
  assert.deepEqual(validateOperation('config.set', { relay: 'wss://relay.example:443', port: 3080 }), {
    operation: 'config.set', params: { relay: 'wss://relay.example:443', port: 3080 },
  });
});

test('initial state needs no native download and only the prefix reference is persisted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drdsh-manager-'));
  try {
    const prefix = join(directory, 'prefix');
    const manager = await createManager({ storageRoot: join(directory, 'private'), prefix });
    assert.deepEqual(await manager.state(), { prefix, installed: false, hasConfiguration: false, nativeReady: false, bootstrapRequired: true });
    const status = await manager.execute('status');
    assert.equal(status.ok, true);
    await assert.rejects(manager.bootstrap(), /no bundled native daemon or fixed compatible Release/u);
    assert.deepEqual(JSON.parse(await readFile(join(manager.storageRoot, 'instance.json'), 'utf8')), { version: 1, prefix });
    assert.equal((await stat(join(manager.storageRoot, 'instance.json'))).mode & 0o777, 0o600);
    await assert.rejects(createManager({ storageRoot: manager.storageRoot, prefix: join(directory, 'different') }), isError('instance_conflict'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('verified package is used for jobs, install defaults apply once, and update preserves existing configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drdsh-manager-jobs-'));
  try {
    const bundle = join(directory, 'bundle');
    await mkdir(join(bundle, 'bin'), { recursive: true, mode: 0o700 });
    await writeFile(join(bundle, 'bin/drdsh'), `#!${process.execPath}\n${readRequest}\nconsole.log(JSON.stringify({version:1,requestId:request.requestId,ok:true,result:request}));\n`, { mode: 0o700 });
    await writeFile(join(bundle, 'bundle.json'), JSON.stringify({ format: 1, version: '0.1.1', target: nativeTarget(), components: ['daemon'] }), { mode: 0o600 });
    const manager = await createManager({
      storageRoot: join(directory, 'private'), prefix: join(directory, 'prefix'), bundledDirectory: bundle,
      installDefaults: { dsh: '/trusted/dsh', dshHome: '/trusted/home', workdir: '/trusted/work', port: 3080 },
    });
    const native = await manager.bootstrap();
    assert.notEqual(native.source, bundle);
    const installed = await manager.execute('install', { relay: 'wss://relay.example', start: false });
    assert.equal(installed.ok, true);
    if (!installed.ok) return;
    const request = installed.result as { operation: string; params: { operation: string; params: Record<string, unknown> } };
    assert.equal(request.operation, 'job.submit');
    assert.equal(request.params.operation, 'install');
    assert.deepEqual(request.params.params, {
      dsh: '/trusted/dsh', dshHome: '/trusted/home', workdir: '/trusted/work', port: 3080,
      relay: 'wss://relay.example', start: false, source: native.source, pluginOwner: 'external',
      pluginReportsEnabled: true, localAdminEnabled: true,
    });
    await mkdir(join(manager.prefix, 'etc/dr.dsh'), { recursive: true });
    const configPath = join(manager.prefix, 'etc/dr.dsh/daemon.json');
    await writeFile(configPath, JSON.stringify({ components: ['daemon'] }));
    assert.equal((await manager.state()).installed, true);
    const updated = await manager.execute('update');
    assert.equal(updated.ok, true);
    if (!updated.ok) return;
    const update = updated.result as { params: { operation: string; params: Record<string, unknown> } };
    assert.equal(update.params.operation, 'update');
    assert.deepEqual(update.params.params, { source: native.source });
    await writeFile(configPath, JSON.stringify({ components: [], dsh: '/saved/dsh', port: 3090 }));
    assert.deepEqual(await manager.state(), {
      prefix: manager.prefix, installed: false, hasConfiguration: true, nativeReady: true, bootstrapRequired: false,
    });
    const reinstall = await manager.execute('install');
    assert.equal(reinstall.ok, true);
    if (!reinstall.ok) return;
    assert.equal('dsh' in (reinstall.result as typeof request).params.params, false);
    assert.equal('port' in (reinstall.result as typeof request).params.params, false);
    await assert.rejects(manager.execute('install', { source: '/arbitrary' }), isError('invalid_params'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('configuration metadata is read without following links or unbounded files and corruption cannot look uninstalled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drdsh-manager-config-'));
  try {
    const manager = await createManager({ storageRoot: join(directory, 'private'), prefix: join(directory, 'prefix') });
    const configPath = join(manager.prefix, 'etc/dr.dsh/daemon.json');
    await mkdir(join(manager.prefix, 'etc/dr.dsh'), { recursive: true, mode: 0o700 });
    for (const content of ['{', '{}', JSON.stringify({ components: [1] }), ' '.repeat(65_537)]) {
      await writeFile(configPath, content, { mode: 0o600 });
      await assert.rejects(manager.state(), isError('invalid_config'));
    }
    await writeFile(configPath, JSON.stringify({ components: ['daemon'] }));
    await chmod(configPath, 0o666);
    await assert.rejects(manager.state(), isError('invalid_config'));
    await rm(configPath);
    const target = join(directory, 'other.json');
    await writeFile(target, JSON.stringify({ components: ['daemon'] }));
    await symlink(target, configPath);
    await assert.rejects(manager.state());
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('native client validates correlation and exit status, caps output and times out without disclosing stderr', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drdsh-native-client-'));
  try {
    const options = { prefix: directory, directory, operation: 'status', params: {} };
    const wrong = await executable(directory, `${readRequest} process.stderr.write('private-secret'); console.log(JSON.stringify({version:1,requestId:'wrong',ok:true,result:{}}));`);
    await assert.rejects(callNative({ ...options, binary: wrong }), error => {
      assert.ok(isError('invalid_native_response')(error));
      assert.equal(String(error).includes('private-secret'), false);
      return true;
    });
    const excessive = await executable(directory, "process.stdout.write('x'.repeat(70000));");
    await assert.rejects(callNative({ ...options, binary: excessive }), isError('native_output_too_large'));
    const slow = await executable(directory, 'setTimeout(() => {}, 60000);');
    await assert.rejects(callNative({ ...options, binary: slow, timeoutMs: 40 }), isError('native_timeout'));
    const refusal = await executable(directory, `${readRequest} console.log(JSON.stringify({version:1,requestId:request.requestId,ok:false,error:{code:'not_installed',message:'Install daemon first.',retryable:false}})); process.exitCode=1;`);
    const response = await callNative({ ...options, binary: refusal });
    assert.equal(response.ok, false);
    if (!response.ok) assert.equal(response.error.code, 'not_installed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('local capability unlocks bounded sessions; launch fragments are single use and tokens expire across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drdsh-authority-'));
  try {
    let now = 1_000;
    const authority = await createLocalManagementAuthority({ storageRoot: directory, now: () => now });
    const capability = (await readFile(authority.capabilityFile, 'utf8')).trim();
    assert.equal((await stat(authority.capabilityFile)).mode & 0o777, 0o600);
    assert.equal(authority.authorize(capability), false);
    assert.equal(authority.authorize('DSH cookie'), false);
    const session = authority.unlock(capability);
    assert.equal(authority.authorize(session.token), true);
    const url = new URL(await authority.createLocalLaunchUrl('http://127.0.0.1:3080'));
    assert.equal(url.pathname, '/_drdsh/manage');
    const launch = new URLSearchParams(url.hash.slice(1)).get('launch');
    assert.notEqual(launch, capability);
    assert.equal(authority.authorize(authority.unlock(launch).token), true);
    assert.throws(() => authority.unlock(launch), isError('unlock_refused'));
    assert.equal((await stat(authority.launchFile)).mode & 0o777, 0o600);
    await assert.rejects(authority.createLocalLaunchUrl('https://external.example'), isError('invalid_local_origin'));
    const reopened = await createLocalManagementAuthority({ storageRoot: directory, now: () => now });
    assert.equal(reopened.authorize(session.token), false);
    assert.equal(reopened.authorize(reopened.unlock(capability).token), true);
    now = session.expiresAtMs;
    assert.equal(authority.authorize(session.token), false);
    authority.close();
    assert.throws(() => authority.unlock(capability), isError('management_closed'));
    reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unlock failures are rate limited and the limit resets without retaining unbounded requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drdsh-authority-limit-'));
  try {
    let now = 0;
    const authority = await createLocalManagementAuthority({ storageRoot: directory, now: () => now });
    for (let index = 0; index < 8; index++) assert.throws(() => authority.unlock('wrong'), isError('unlock_refused'));
    assert.throws(() => authority.unlock('wrong'), isError('unlock_rate_limited'));
    now = 60_000;
    const capability = (await readFile(authority.capabilityFile, 'utf8')).trim();
    assert.equal(authority.authorize(authority.unlock(capability).token), true);
    authority.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session and launch capabilities have bounded lifetimes and counts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drdsh-authority-bounds-'));
  try {
    let now = 0;
    const authority = await createLocalManagementAuthority({ storageRoot: directory, now: () => now });
    const capability = (await readFile(authority.capabilityFile, 'utf8')).trim();
    const sessions: string[] = [];
    for (let batch = 0; batch < 3; batch++) {
      for (let count = 0; count < 8; count++) sessions.push(authority.unlock(capability).token);
      now += 60_000;
    }
    assert.equal(authority.authorize(sessions[0]), false);
    assert.equal(authority.authorize(sessions.at(-1)), true);
    const launches: string[] = [];
    for (let count = 0; count < 9; count++) {
      const url = new URL(await authority.createLocalLaunchUrl('http://127.0.0.1:3080'));
      launches.push(new URLSearchParams(url.hash.slice(1)).get('launch')!);
    }
    assert.throws(() => authority.unlock(launches[0]), isError('unlock_refused'));
    assert.equal(authority.authorize(authority.unlock(launches.at(-1)).token), true);
    now += 5 * 60_000;
    assert.throws(() => authority.unlock(launches[1]), isError('unlock_refused'));
    authority.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
