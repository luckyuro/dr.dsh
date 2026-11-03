/**
 * Actual install/update/uninstall and user services with daemon-owned and external DSH bundles.
 * Uses a private prefix, a generated package of the current binary/assets and a DSH process fixture.
 * The only services touched have this run's prefix-derived identities; autostart is never enabled.
 *
 * Usage: node scripts/plugin-owner-smoke.mjs [--drdsh target/debug/drdsh]
 * Requires: macOS launchd or Linux systemd user session, built CLI and apps/pwa/dist.
 * Exit codes: 0 passed, 1 failed, 2 prerequisites unavailable.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { managerAvailable, serviceState, shellQuote, stopService } from './service-manager.mjs';
import { stagePluginSource } from './package-plugin-source.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--drdsh')) {
  console.error('Usage: node scripts/plugin-owner-smoke.mjs [--drdsh <binary>]');
  process.exit(2);
}
const binary = resolve(repo, args[1] ?? 'target/debug/drdsh');
try {
  managerAvailable();
  assert.ok(existsSync(binary), 'Build the native CLI with cargo build -p dr-dsh-cli.');
  for (const name of ['index.html', 'shell.js', 'session.js', 'service-worker.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png']) {
    assert.ok(existsSync(join(repo, 'apps/pwa/dist', name)), 'Build PWA assets with pnpm --filter @dr.dsh/pwa build.');
  }
} catch (error) { console.error(error.message); process.exit(2); }

const scratch = mkdtempSync('/tmp/drdsh-owner-');
const prefix = join(scratch, 'prefix');
const home = join(scratch, 'home');
const dshHome = join(scratch, 'dsh-home');
const bundle = join(scratch, 'bundle');
const packageBinary = join(bundle, 'bin/drdsh');
for (const path of [prefix, home, dshHome, join(bundle, 'bin'), join(bundle, 'plugin')]) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}
const dsh = join(scratch, 'dsh');
writeFileSync(dsh, `#!/bin/sh\nexport DRDSH_MANAGEMENT_SMOKE_DIR=${shellQuote(scratch)}\nexec ${shellQuote(process.execPath)} ${shellQuote(join(repo, 'scripts/fixtures/daemon-management-dsh.mjs'))} "$@"\n`, { mode: 0o700 });
const env = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !/^(DSHD_|DRDSH_|DSH_RELAY_|DSH_HOME$|FAKE_DSH_)/u.test(key)));
Object.assign(env, { HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state') });
let checks = 0;
let cleaning = false;
let phase = 'package setup';
const commands = new Set();
const check = text => console.log(`ok ${++checks} - ${text}`);
const configPath = scope => join(prefix, 'etc/dr.dsh', `${scope}.json`);
const config = scope => JSON.parse(readFileSync(configPath(scope), 'utf8'));
const calls = () => existsSync(join(scratch, 'plugin-calls.jsonl'))
  ? readFileSync(join(scratch, 'plugin-calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const starts = () => existsSync(join(scratch, 'dsh-starts.jsonl'))
  ? readFileSync(join(scratch, 'dsh-starts.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];

async function command(file, argv, expected = 0) {
  const output = await new Promise((accept, reject) => {
    const child = spawn(file, argv, { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] });
    commands.add(child);
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Timed out: ${argv.slice(0, 2).join(' ')}`)); }, 55_000);
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.once('error', error => { clearTimeout(timer); commands.delete(child); reject(error); });
    child.once('close', code => { clearTimeout(timer); commands.delete(child); accept({ code, stdout, stderr }); });
  });
  if (expected !== null) assert.equal(output.code, expected, `command failed: ${argv.slice(0, 2).join(' ')}\n${output.stdout}\n${output.stderr}`);
  return output;
}
const installed = (scope, argv, code = 0) => command(join(prefix, `bin/drdsh-${scope}`), argv, code);
const install = (scope, argv = [], code = 0) => command(packageBinary, [scope, 'install', '--source', bundle, '--prefix', prefix, ...argv], code);
async function until(test, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) { if (await test()) return; await delay(100); }
  throw new Error(`Timed out waiting for ${label}`);
}
async function freePort() {
  const server = createServer();
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  const port = server.address().port;
  await new Promise(accept => server.close(accept));
  return port;
}
function snapshotRelay() {
  return { pid: serviceState(config('relay'), 'relay').pid, config: readFileSync(configPath('relay'), 'utf8') };
}
function assertRelayUnchanged(snapshot) { assert.deepEqual(snapshotRelay(), snapshot); }
async function awaitDsh(previousStarts) {
  await until(() => starts().length > previousStarts, 'managed DSH process start');
  assert.ok(serviceState(config('daemon'), 'daemon').pid, 'daemon service must stay running');
  return starts().at(-1);
}
async function cleanup() {
  if (cleaning) return;
  cleaning = true;
  let removable = true;
  for (const scope of ['daemon', 'relay']) {
    if (!existsSync(configPath(scope))) continue;
    try {
      const current = config(scope);
      // The fallback still identifies only this prefix's service if an install failed halfway.
      const result = await command(binary, [scope, 'uninstall', '--prefix', prefix], null);
      if (result.code !== 0) await stopService(current, scope);
      if (serviceState(current, scope).running) throw new Error(`${scope} service is still running`);
    } catch (error) {
      removable = false;
      console.error(`Cannot clean temporary ${scope} service: ${error.message}`);
    }
  }
  for (const child of commands) child.kill('SIGTERM');
  if (removable) rmSync(scratch, { recursive: true, force: true });
  else {
    console.error(`Temporary service files retained at ${scratch}; do not delete them before stopping that test service.`);
    process.exitCode = 1;
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  void cleanup().finally(() => process.exit(1));
});

try {
  const version = /drdsh\s+(\S+)/u.exec((await command(binary, ['--version'])).stdout)?.[1];
  assert.ok(version, 'native binary must report its release version');
  const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
  assert.ok(arch, 'this smoke requires a supported native architecture');
  const target = `${arch}-${process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl'}`;
  copyFileSync(binary, packageBinary);
  await stagePluginSource(join(bundle, 'plugin'));
  cpSync(join(repo, 'apps/pwa/dist'), join(bundle, 'client'), { recursive: true });
  writeFileSync(join(bundle, 'bundle.json'), JSON.stringify({ format: 1, version, target, components: ['relay', 'daemon'] }));
  const relayPort = await freePort();
  const dshPort = await freePort();

  phase = 'independent relay baseline';
  await install('relay', ['--bind', `127.0.0.1:${relayPort}`, '--start']);
  await installed('relay', ['status']);
  const relaySnapshot = snapshotRelay();
  assert.ok(relaySnapshot.pid);
  check('a private relay service establishes the PID/config baseline in the temporary prefix');

  phase = 'legacy-owned plugin installation';
  let beforeStarts = starts().length;
  await install('daemon', [
    '--dsh', dsh, '--relay', `ws://127.0.0.1:${relayPort}`, '--port', String(dshPort),
    '--dsh-home', dshHome, '--workdir', scratch, '--with-plugin', '--start',
  ]);
  assert.equal((await awaitDsh(beforeStarts)).reportsEnabled, true);
  assert.deepEqual(calls().map(call => call.verb), ['add']);
  assert.ok(config('daemon').components.includes('plugin'));
  const registration = readFileSync(join(dshHome, 'plugin-registration.json'), 'utf8');
  const pluginDir = join(prefix, 'lib/dr.dsh/daemon/plugin');
  const originalIndex = readFileSync(join(pluginDir, 'src/index.js'), 'utf8');
  writeFileSync(join(pluginDir, 'external-sentinel'), 'DSH-owned bundle must remain available');
  const stateDir = config('daemon').state;
  writeFileSync(join(stateDir, 'retention-sentinel'), 'existing pairing state');
  assertRelayUnchanged(relaySnapshot);
  check('the legacy installation still registers the DSH bundle and enables its report listener');

  phase = 'handover of bundle ownership';
  // If external ownership accidentally copies packaged assets, either this content or the
  // sentinel will change. Registration calls are counted by a separate real DSH process.
  writeFileSync(join(bundle, 'plugin/src/index.js'), '// Different package content that external ownership must not install.\n');
  beforeStarts = starts().length;
  await install('daemon', ['--plugin-owner', 'external', '--plugin-reports', '--local-admin']);
  assert.equal((await awaitDsh(beforeStarts)).reportsEnabled, true);
  assert.equal(config('daemon').pluginOwner, 'external');
  assert.equal(config('daemon').pluginReportsEnabled, true);
  assert.equal(config('daemon').localAdminEnabled, true);
  assert.equal(config('daemon').components.includes('plugin'), false);
  const assertExternalUntouched = () => {
    assert.deepEqual(calls().map(call => call.verb), ['add']);
    assert.equal(readFileSync(join(dshHome, 'plugin-registration.json'), 'utf8'), registration);
    assert.equal(readFileSync(join(pluginDir, 'src/index.js'), 'utf8'), originalIndex);
    assert.equal(readFileSync(join(pluginDir, 'external-sentinel'), 'utf8'), 'DSH-owned bundle must remain available');
    assert.equal(readFileSync(join(stateDir, 'retention-sentinel'), 'utf8'), 'existing pairing state');
    assertRelayUnchanged(relaySnapshot);
  };
  assertExternalUntouched();
  check('ownership transfers to DSH without recursive plugin registration or replacement of its existing bundle');

  phase = 'external plugin commands rejected before service changes';
  const daemonPid = serviceState(config('daemon'), 'daemon').pid;
  for (const verb of ['install', 'uninstall']) {
    const result = await installed('daemon', [verb, 'plugin'], 1);
    assert.match(result.stderr, /externally owned/u);
    assert.equal(serviceState(config('daemon'), 'daemon').pid, daemonPid);
  }
  const conflicting = await install('daemon', ['--with-plugin'], 1);
  assert.match(conflicting.stderr, /externally owned/u);
  assert.equal(serviceState(config('daemon'), 'daemon').pid, daemonPid);
  assertExternalUntouched();
  check('external plugin add/remove requests fail before stopping the daemon or changing either component');

  phase = 'normal update retains external ownership';
  beforeStarts = starts().length;
  await install('daemon');
  assert.equal((await awaitDsh(beforeStarts)).reportsEnabled, true);
  assert.equal(config('daemon').pluginOwner, 'external');
  assertExternalUntouched();
  check('an ordinary daemon package update inherits external ownership and leaves DSH bundle assets intact');

  phase = 'reporting is an independent runtime setting';
  beforeStarts = starts().length;
  await install('daemon', ['--no-plugin-reports']);
  assert.equal((await awaitDsh(beforeStarts)).reportsEnabled, false);
  assert.equal(config('daemon').pluginReportsEnabled, false);
  assertExternalUntouched();
  beforeStarts = starts().length;
  await install('daemon', ['--plugin-reports']);
  assert.equal((await awaitDsh(beforeStarts)).reportsEnabled, true);
  assert.equal(config('daemon').components.includes('plugin'), false);
  assertExternalUntouched();
  check('report listening can be disabled and enabled without daemon ownership of the DSH plugin');

  phase = 'uninstall preserves externally owned plugin';
  await installed('daemon', ['uninstall']);
  assert.equal(serviceState(config('daemon'), 'daemon').running, false);
  assert.equal(existsSync(join(prefix, 'bin/drdsh-daemon')), false);
  assertExternalUntouched();
  await command(join(prefix, 'bin/drdsh'), ['relay', 'status']);
  check('daemon uninstall removes its service while preserving the external plugin, saved state and relay PID/config');
  console.log(`Passed ${checks} plugin ownership smoke checks.`);
} catch (error) {
  console.error(`FAIL during ${phase}: ${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
