/**
 * Real user services and binaries, isolated under target/. DSH is the existing HTTP fixture;
 * plugin registration uses a stand-in CLI and must not be called a real upstream DSH test.
 * Build first: cargo build --workspace && pnpm --filter @dr.dsh/pwa build
 * Run: node scripts/service-smoke.mjs (macOS launchd or Linux systemd user session)
 * Exits 0 passed, 1 failed, 2 missing prerequisites. Removes its services in finally.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { managerAvailable, paths, serviceState, shellQuote, stopService, setAutostart } from './service-manager.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  managerAvailable();
  for (const file of ['target/debug/drdshd', 'target/debug/drdsh-relay', 'apps/pwa/dist/shell.js']) {
    if (!existsSync(join(repo, file))) throw new Error(`Missing ${file}; build the workspace and PWA first.`);
  }
} catch (error) { console.error(error.message); process.exit(2); }
const scratch = mkdtempSync(join(repo, 'target/service-smoke-'));
const prefix = join(scratch, "install space & % $literal ' quote");
const p = paths(prefix);
let config;
let checks = 0;

async function command(args, expected = 0, installed = true, scope) {
  const scoped = paths(prefix, scope);
  const executable = installed ? scoped.command : scope ? '/bin/sh' : process.execPath;
  const argv = installed ? args : scope
    ? [join(repo, scope, 'install.sh'), ...args.slice(1), '--prefix', prefix]
    : [join(repo, 'scripts/drdsh.mjs'), ...args, '--prefix', prefix];
  const result = await new Promise((accept, reject) => {
    const child = spawn(executable, argv, { cwd: scratch, env: { ...process.env, DSHD_STATE_DIR: scoped.state } });
    let text = '';
    const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Timed out: ${args.join(' ')}`)); }, 120_000);
    child.stdout.on('data', chunk => { text += chunk; });
    child.stderr.on('data', chunk => { text += chunk; });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); accept({ code, text }); });
  });
  assert.equal(result.code, expected, result.text);
  return result.text;
}
async function freePort() {
  const server = createServer();
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  const port = server.address().port;
  await new Promise(accept => server.close(accept));
  return port;
}
function check(name, condition = true) { assert.ok(condition, name); console.log(`ok ${++checks} - ${name}`); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function eventually(fn, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  do { if (await fn()) return; await delay(200); } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

try {
  const port = await freePort();
  const relayPort = await freePort();
  const wrapper = join(scratch, 'dsh fixture');
  const fixture = join(scratch, 'dsh-fixture.mjs');
  writeFileSync(wrapper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fixture)} "$@"\n`, { mode: 0o755 });
  writeFileSync(fixture, `
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('0.1.5-rc.2'); }
else if (args[0] === 'plugin') {
  if (args[1] !== '--profile' || args[2] !== 'web') throw new Error('unexpected profile');
  mkdirSync(process.env.DSH_HOME, { recursive: true });
  const registration = join(process.env.DSH_HOME, 'fixture-plugin.json');
  if (args[3] === 'add') {
    const manifest = JSON.parse(readFileSync(join(args[4], 'package.json'), 'utf8'));
    const plugin = await import(pathToFileURL(join(args[4], 'src/index.ts')));
    let dispose;
    plugin.apply({ on() { return () => {}; }, effect(fn) { dispose = fn(); } });
    dispose?.();
    writeFileSync(registration, JSON.stringify({ args, name: manifest.name }));
  } else if (args[3] === 'remove') { rmSync(registration, { force: true }); }
  else throw new Error('unexpected plugin operation');
} else {
  if (existsSync('hold-startup')) {
    writeFileSync('starting-child-pid', String(process.pid));
    setInterval(() => {}, 1000);
  } else {
    process.argv[2] = args[args.indexOf('--port') + 1];
    await import(${JSON.stringify(fileURLToPath(new URL('../crates/dr-dsh-daemon/tests/fixtures/fake-dsh.mjs', import.meta.url)))});
  }
}
`);
  await command(['install', 'all', '--source', repo, '--skip-build', '--build-profile', 'debug', '--dsh', wrapper,
    '--dsh-home', join(scratch, 'dsh home'), '--workdir', scratch, '--port', String(port),
    '--bind', `127.0.0.1:${relayPort}`, '--relay', `ws://127.0.0.1:${relayPort}`, '--with-plugin', '--start'], 0, false);
  config = JSON.parse(readFileSync(p.config, 'utf8'));
  check('install handles spaces and metacharacters and starts two real services', serviceState(config, 'daemon').running && serviceState(config, 'relay').running);
  await eventually(async () => {
    try { const r = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(500) }); await r.body?.cancel(); return r.status === 401; } catch { return false; }
  }, 'DSH readiness');
  check('DSH fixture binds and retains its authentication fence');
  const client = await fetch(`http://127.0.0.1:${relayPort}/client/shell.js`);
  check('installed PWA is actually served by the relay', client.ok && (await client.text()).length > 100);
  check('plugin handed to web profile and actual plugin module loads in fixture CLI', JSON.parse(readFileSync(join(config.dshHome, 'fixture-plugin.json'), 'utf8')).name === '@dr.dsh/dsh-plugin');
  await command(['status']); check('status checks services and live HTTP endpoints');
  const before = serviceState(config, 'daemon').pid;
  await command(['start']); check('start is idempotent', serviceState(config, 'daemon').pid === before);
  const keyFile = join(config.state, 'room-key');
  const key = readFileSync(keyFile, 'utf8');
  check('generated room key stays private', (statSync(keyFile).mode & 0o777) === 0o600);
  const log = await command(['logs', 'daemon']);
  const childBefore = Number(log.match(/DSH is listening on .+\(pid (\d+)\)/u)?.[1]);
  check('DSH child PID is visible without exposing the room key', childBefore > 0 && !log.includes(key.trim()));
  await command(['restart', 'daemon']);
  check('restart replaces daemon and cleans up its old DSH child', serviceState(config, 'daemon').pid !== before && !alive(childBefore));
  check('restart keeps the pairing key', readFileSync(keyFile, 'utf8') === key);
  await command(['enable', 'daemon']); await command(['disable', 'daemon']);
  check('autostart toggles preserve a running service', serviceState(config, 'daemon').running);
  const daemonBeforeClient = serviceState(config, 'daemon').pid;
  await command(['install', 'client', '--skip-build']);
  config = JSON.parse(readFileSync(p.config, 'utf8'));
  check('client update preserves settings and restores running services', config.port === port && config.dsh === wrapper && serviceState(config, 'daemon').running && serviceState(config, 'relay').running);
  check('client update does not restart the legacy daemon', serviceState(config, 'daemon').pid === daemonBeforeClient);
  const pluginHost = serviceState(config, 'daemon').pid;
  await command(['uninstall', 'plugin']);
  check('removing plugin restarts a running DSH host to unload the bundle', !existsSync(join(config.dshHome, 'fixture-plugin.json')) && serviceState(config, 'daemon').pid !== pluginHost);
  await command(['install', 'plugin', '--skip-build']);
  config = JSON.parse(readFileSync(p.config, 'utf8'));
  check('plugin can be independently reinstalled', config.components.includes('plugin') && existsSync(join(config.dshHome, 'fixture-plugin.json')));
  const missingSource = join(scratch, 'incomplete checkout');
  mkdirSync(join(missingSource, 'scripts'), { recursive: true });
  writeFileSync(join(missingSource, 'Cargo.toml'), ''); writeFileSync(join(missingSource, 'scripts/drdsh.mjs'), '');
  const healthyPid = serviceState(config, 'daemon').pid;
  await command(['install', 'daemon', '--source', missingSource, '--skip-build'], 1);
  check('missing build artifacts fail before stopping a working service', serviceState(config, 'daemon').pid === healthyPid);
  await command(['devices']); check('daemon tools use the saved state directory');
  await command(['stop']);
  check('stop cleans up both services', !serviceState(config, 'daemon').running && !serviceState(config, 'relay').running);
  await command(['status'], 1); check('stopped status returns a failing exit code');
  writeFileSync(join(scratch, 'hold-startup'), '');
  await command(['start', 'daemon']);
  await eventually(() => existsSync(join(scratch, 'starting-child-pid')), 'DSH child in startup');
  const startingChild = Number(readFileSync(join(scratch, 'starting-child-pid'), 'utf8'));
  await command(['stop', 'daemon']);
  await eventually(() => !alive(startingChild), 'startup child cleanup');
  check('SIGTERM during startup cleans up the not-yet-ready DSH child');
  rmSync(join(scratch, 'hold-startup'));
  await command(['start']);
  await command(['uninstall', 'all']);
  check('uninstall removes commands, services, PWA and plugin registration', !existsSync(join(p.bin, 'drdsh')) && !existsSync(join(p.root, 'client')) && !existsSync(join(config.dshHome, 'fixture-plugin.json')));
  check('uninstall preserves the room key and configuration', readFileSync(keyFile, 'utf8') === key && existsSync(p.config));

  await command(['install', '--source', repo, '--skip-build', '--build-profile', 'debug',
    '--bind', `127.0.0.1:${relayPort}`, '--start'], 0, false, 'relay');
  const rp = paths(prefix, 'relay');
  let relayConfig = JSON.parse(readFileSync(rp.config, 'utf8'));
  const relayPid = serviceState(relayConfig, 'relay').pid;
  check('relay installs alone with no daemon program, DSH settings or state directory', relayPid &&
    !existsSync(join(rp.bin, 'drdshd')) && !existsSync(rp.state) &&
    !['dsh', 'dshHome', 'relay', 'port', 'workdir', 'state', 'path'].some(field => field in relayConfig));
  await command(['status'], 0, true, 'relay');
  check('relay command uses its saved prefix from outside the source directory');

  await command(['install', '--source', repo, '--skip-build', '--build-profile', 'debug',
    '--dsh', wrapper, '--dsh-home', join(scratch, 'dsh home'), '--workdir', scratch,
    '--port', String(port), '--relay', `ws://127.0.0.1:${relayPort}`, '--start'], 0, false, 'daemon');
  const dp = paths(prefix, 'daemon');
  let daemonConfig = JSON.parse(readFileSync(dp.config, 'utf8'));
  await eventually(async () => {
    try { const r = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(500) }); await r.body?.cancel(); return r.status === 401; } catch { return false; }
  }, 'independent DSH readiness');
  check('daemon installs alone without replacing or restarting the relay', serviceState(relayConfig, 'relay').pid === relayPid &&
    !existsSync(join(dp.bin, 'drdsh-relay')) && !existsSync(join(dp.root, 'client')) && !('bind' in daemonConfig));
  await command(['status'], 0, true, 'daemon');
  await command(['devices'], 0, true, 'daemon');
  check('daemon commands use their own service and state directory', daemonConfig.state !== config.state && rp.config !== dp.config);
  const scopedKeyFile = join(daemonConfig.state, 'room-key');
  const scopedKey = readFileSync(scopedKeyFile, 'utf8');
  const scopedDaemonPid = serviceState(daemonConfig, 'daemon').pid;
  const daemonSettings = readFileSync(dp.config, 'utf8');
  await command(['install', 'client', '--skip-build'], 0, true, 'relay');
  relayConfig = JSON.parse(readFileSync(rp.config, 'utf8'));
  check('PWA update restarts only relay and leaves daemon configuration and PID intact',
    serviceState(relayConfig, 'relay').pid !== relayPid && serviceState(daemonConfig, 'daemon').pid === scopedDaemonPid &&
    readFileSync(dp.config, 'utf8') === daemonSettings);
  const relayAfterUpdate = serviceState(relayConfig, 'relay').pid;
  const relaySettings = readFileSync(rp.config, 'utf8');
  await command(['install', '--skip-build', '--build-profile', 'debug'], 0, true, 'daemon');
  daemonConfig = JSON.parse(readFileSync(dp.config, 'utf8'));
  check('daemon update leaves relay configuration and PID intact and preserves pairing',
    serviceState(relayConfig, 'relay').pid === relayAfterUpdate && readFileSync(rp.config, 'utf8') === relaySettings &&
    serviceState(daemonConfig, 'daemon').pid !== scopedDaemonPid && readFileSync(scopedKeyFile, 'utf8') === scopedKey);

  const daemonBeforeRejection = serviceState(daemonConfig, 'daemon').pid;
  await command(['pair'], 1, true, 'relay');
  await command(['install', '--dsh', wrapper], 1, true, 'relay');
  await command(['install', '--bind', `127.0.0.1:${relayPort}`], 1, true, 'daemon');
  check('cross-component commands fail without changing either running service',
    serviceState(daemonConfig, 'daemon').pid === daemonBeforeRejection && serviceState(relayConfig, 'relay').pid === relayAfterUpdate);
  await command(['enable'], 0, true, 'relay'); await command(['disable'], 0, true, 'relay');
  check('independent relay autostart toggles leave daemon running', serviceState(daemonConfig, 'daemon').pid === daemonBeforeRejection);
  await command(['install', 'plugin', '--skip-build'], 0, true, 'daemon');
  daemonConfig = JSON.parse(readFileSync(dp.config, 'utf8'));
  await command(['uninstall', 'plugin'], 0, true, 'daemon');
  check('optional plugin remains entirely on daemon side', serviceState(relayConfig, 'relay').pid === relayAfterUpdate &&
    !existsSync(join(daemonConfig.dshHome, 'fixture-plugin.json')));

  const daemonBeforeRelayRemoval = serviceState(daemonConfig, 'daemon').pid;
  await command(['uninstall'], 0, true, 'relay');
  check('uninstalling relay keeps daemon command, process and pairing state', !existsSync(rp.command) &&
    existsSync(dp.command) && serviceState(daemonConfig, 'daemon').pid === daemonBeforeRelayRemoval &&
    readFileSync(scopedKeyFile, 'utf8') === scopedKey);
  await command(['devices'], 0, true, 'daemon');
  await command(['install', '--skip-build', '--build-profile', 'debug', '--start'], 0, false, 'relay');
  relayConfig = JSON.parse(readFileSync(rp.config, 'utf8'));
  check('relay reinstalls with its saved settings', relayConfig.bind === `127.0.0.1:${relayPort}` && serviceState(relayConfig, 'relay').running);
  const lastRelayPid = serviceState(relayConfig, 'relay').pid;
  await command(['uninstall'], 0, true, 'daemon');
  check('uninstalling daemon keeps relay command and process', !existsSync(dp.command) && existsSync(rp.command) &&
    serviceState(relayConfig, 'relay').pid === lastRelayPid && readFileSync(scopedKeyFile, 'utf8') === scopedKey);
  await command(['status'], 0, true, 'relay');
  await command(['uninstall'], 0, true, 'relay');
  console.log(`Passed ${checks} real-process checks.`);
} catch (error) {
  console.error(error.stack); process.exitCode = 1;
} finally {
  if (!config && existsSync(p.config)) config = JSON.parse(readFileSync(p.config, 'utf8'));
  if (config) for (const name of ['daemon', 'relay']) {
    try { await stopService(config, name); setAutostart(config, name, false); }
    catch (error) { console.error(`cleanup ${name}: ${error.message}`); process.exitCode = 1; }
  }
  for (const scope of ['daemon', 'relay']) {
    const scoped = paths(prefix, scope);
    if (!existsSync(scoped.config)) continue;
    try {
      const saved = JSON.parse(readFileSync(scoped.config, 'utf8'));
      await stopService(saved, scope); setAutostart(saved, scope, false);
    } catch (error) { console.error(`cleanup independent ${scope}: ${error.message}`); process.exitCode = 1; }
  }
  if (!process.exitCode) rmSync(scratch, { recursive: true, force: true });
  else console.error(`Diagnostics retained at ${scratch}`);
}
