/** Real native CLI processes and user services. DSH uses a process/HTTP fixture. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { managerAvailable, serviceState, shellQuote, stopService, setAutostart } from './service-manager.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = resolve(process.env.DRDSH_TEST_BINARY ?? join(repo, 'target/debug/drdsh'));
try { managerAvailable(); assert.ok(existsSync(binary)); }
catch (error) { console.error(error.message); process.exit(2); }
const scratch = mkdtempSync(join(repo, 'target/multicall-smoke-'));
mkdirSync(join(scratch, 'physical parent'));
symlinkSync(join(scratch, 'physical parent'), join(scratch, 'parent alias'));
const prefix = join(scratch, 'parent alias', 'install space & % $literal "double" \'single\'');
const bundle = join(scratch, 'mixed');
const serverPath = '/usr/bin:/bin:/usr/sbin:/sbin';
let checks = 0;
const check = name => console.log(`ok ${++checks} - ${name}`);
const configPath = scope => join(prefix, `etc/dr.dsh/${scope}.json`);
const config = scope => JSON.parse(readFileSync(configPath(scope), 'utf8'));
const pid = scope => serviceState(config(scope), scope).pid;
const snapshot = scope => ({ pid: pid(scope), config: readFileSync(configPath(scope), 'utf8') });
const unchanged = (scope, before) => assert.deepEqual(snapshot(scope), before);

async function command(file, args, code = 0, env = {}) {
  const result = await new Promise((accept, reject) => {
    const child = spawn(file, args, { cwd: scratch, env: { ...process.env, PATH: serverPath, ...env } });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Timed out: ${args.slice(0, 2).join(' ')}`)); }, 90_000);
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', code => { clearTimeout(timeout); accept({ code, stdout, stderr }); });
  });
  assert.equal(result.code, code, `${result.stdout}\n${result.stderr}`);
  return result;
}
const run = (scope, args, code = 0) => command(join(prefix, `bin/drdsh-${scope}`), args, code);
const install = (scope, args = [], code = 0) => command(join(bundle, 'bin/drdsh'), [scope, 'install', '--source', bundle, '--prefix', prefix, ...args], code);
async function port() {
  const s = createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const value = s.address().port; await new Promise(r => s.close(r)); return value;
}
async function until(fn) {
  const end = Date.now() + 20_000;
  while (Date.now() < end) { if (await fn()) return; await delay(150); }
  throw new Error('Process readiness timed out');
}

try {
  const tar = join(scratch, 'mixed.tar.gz');
  execFileSync('sh', [join(repo, 'scripts/package-release.sh'), '--target', process.platform === 'darwin' ? 'aarch64-apple-darwin' : 'x86_64-unknown-linux-musl', '--flavor', 'mixed', '--binary', binary, '--output', tar]);
  mkdirSync(bundle); execFileSync('tar', ['-xzf', tar, '-C', bundle]);
  const version = await command(join(bundle, 'bin/drdsh'), ['--version']);
  assert.match(version.stdout, /^drdsh 0\.1\.0 \(relay \+ daemon\)\n$/u);
  assert.match(version.stderr, /dr\.dsh/u); assert.equal(version.stderr.match(/dr\.dsh/gu).length, 1);
  assert.equal(readlinkSync(join(bundle, 'bin/drdsh-relay')), 'drdsh');
  assert.equal(readlinkSync(join(bundle, 'bin/drdsh-daemon')), 'drdsh');
  check('one packaged binary, name aliases, logo on stderr and clean version stdout');
  for (const [scope, other] of [['relay', 'daemon'], ['daemon', 'relay']]) {
    const result = await command(join(bundle, `bin/drdsh-${scope}`), [other, '--help'], 1);
    assert.match(result.stderr, /selects/u);
  }
  check('aliases reject the opposite component before help or installation');
  for (const scope of ['relay', 'daemon']) {
    const archive = join(scratch, `${scope}.tar.gz`);
    execFileSync('sh', [join(repo, 'scripts/package-release.sh'), '--target', process.platform === 'darwin' ? 'aarch64-apple-darwin' : 'x86_64-unknown-linux-musl', '--flavor', scope, '--binary', binary, '--output', archive]);
    const single = join(scratch, scope); mkdirSync(single);
    execFileSync('tar', ['-xzf', archive, '-C', single]);
    const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
    assert.equal(hash(join(single, 'bin/drdsh')), hash(join(bundle, 'bin/drdsh')));
    const other = scope === 'relay' ? 'daemon' : 'relay';
    await command(join(single, 'bin/drdsh'), [scope, '--help']);
    assert.match((await command(join(single, 'bin/drdsh'), [other, 'run'], 1)).stderr, /unavailable/u);
    symlinkSync('drdsh', join(single, `bin/drdsh-${other}`));
    assert.match((await command(join(single, `bin/drdsh-${other}`), ['run'], 1)).stderr, /unavailable/u);
    assert.equal(existsSync(join(single, scope === 'relay' ? 'plugin' : 'client')), false);
    check(`${scope} package shares identical binary bytes but rejects the other component`);
  }
  const relayPort = await port(), daemonPort = await port();
  const fixture = join(scratch, 'dsh-fixture.mjs');
  const dsh = join(scratch, 'dsh fixture');
  writeFileSync(dsh, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fixture)} "$@"\n`, { mode: 0o755 });
  writeFileSync(fixture, `
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('0.1.5-rc.2');
else if (args[0] === 'plugin') {
  if (args[1] !== '--profile' || args[2] !== 'web') throw new Error('wrong profile');
  mkdirSync(process.env.DSH_HOME, { recursive: true });
  const p = join(process.env.DSH_HOME, 'plugin-fixture.json');
  if (args[3] === 'add') writeFileSync(p, JSON.stringify({ spec: args[4] }));
  else if (args[3] === 'remove') rmSync(p, { force: true });
  else throw new Error('wrong plugin action');
} else {
  process.argv[2] = args[args.indexOf('--port') + 1];
  await import(${JSON.stringify(new URL('../crates/dr-dsh-daemon/tests/fixtures/fake-dsh.mjs', import.meta.url).href)});
}
`);
  await install('relay', ['--bind', `127.0.0.1:${relayPort}`]);
  await run('relay', ['status'], 1);
  assert.equal(serviceState(config('relay'), 'relay').running, false);
  await run('relay', ['disable']); await run('relay', ['start']); await run('relay', ['status']);
  const first = pid('relay'); await run('relay', ['start']); assert.equal(pid('relay'), first);
  assert.match(await (await fetch(`http://127.0.0.1:${relayPort}/`)).text(), /dr\.dsh/u);
  check('no-Node relay management installs stopped, starts idempotently and serves static PWA');
  await install('daemon', ['--dsh', dsh, '--relay', `ws://127.0.0.1:${relayPort}`, '--port', String(daemonPort), '--workdir', scratch, '--dsh-home', join(scratch, 'dsh home'), '--start', '--with-plugin']);
  await until(async () => { try { return [200, 401, 403].includes((await fetch(`http://127.0.0.1:${daemonPort}/`)).status); } catch { return false; } });
  await command(join(prefix, 'bin/drdsh'), ['daemon', 'status']);
  await command(join(prefix, 'bin/drdsh'), ['relay', 'status']);
  assert.ok(existsSync(join(scratch, 'dsh home/plugin-fixture.json')));
  check('native daemon service launches DSH fixture, installs plugin and shares canonical command');
  const state = config('daemon').state;
  writeFileSync(join(state, 'retention-fixture'), 'pairing-state-preserved');
  let before = snapshot('daemon');
  await run('relay', ['enable']); await run('relay', ['disable']); unchanged('daemon', before);
  await install('relay'); unchanged('daemon', before);
  await run('relay', ['install', 'client']); unchanged('daemon', before);
  check('relay full/PWA updates and autostart preserve daemon PID and config');
  before = snapshot('relay'); await install('daemon'); unchanged('relay', before);
  assert.equal(readFileSync(join(state, 'retention-fixture'), 'utf8'), 'pairing-state-preserved');
  check('daemon update preserves relay PID/config and existing state');
  before = snapshot('relay');
  const client = join(bundle, 'client/session.js'), backup = readFileSync(client); rmSync(client);
  assert.match((await install('relay', [], 1)).stderr, /artifact/u); unchanged('relay', before); writeFileSync(client, backup);
  const lock = join(prefix, 'lib/dr.dsh/relay/.operation-lock'); mkdirSync(lock);
  assert.match((await install('relay', [], 1)).stderr, /lock/u); unchanged('relay', before); rmSync(lock, { recursive: true });
  check('incomplete bundle and concurrent-operation lock fail before stopping service');
  before = snapshot('relay'); await run('daemon', ['uninstall', 'plugin']); unchanged('relay', before);
  assert.equal(existsSync(join(scratch, 'dsh home/plugin-fixture.json')), false);
  assert.equal(config('daemon').components.includes('plugin'), false);
  check('plugin removal restores daemon without touching relay');
  before = snapshot('daemon'); await run('relay', ['uninstall']); unchanged('daemon', before);
  assert.ok(existsSync(configPath('relay')));
  await command(join(prefix, 'bin/drdsh'), ['daemon', 'status']);
  assert.equal(existsSync(join(prefix, 'bin/drdsh-relay')), false);
  check('relay uninstall retains config and canonical drdsh continues to manage daemon');
  await install('relay', ['--start']); await run('relay', ['status']);
  assert.equal(config('relay').bind, `127.0.0.1:${relayPort}`);
  before = snapshot('relay'); await run('daemon', ['uninstall']); unchanged('relay', before);
  await command(join(prefix, 'bin/drdsh'), ['relay', 'status']);
  assert.equal(readFileSync(join(state, 'retention-fixture'), 'utf8'), 'pairing-state-preserved');
  check('reinstallation retains settings; daemon uninstall leaves relay and pairing state intact');
  await run('relay', ['logs']); await run('relay', ['stop']); await run('relay', ['stop']);
  await run('relay', ['start']); await run('relay', ['restart']); await run('relay', ['status']);
  check('logs, repeated stop and restart use real user services');
  await run('relay', ['uninstall']);
  assert.equal(existsSync(join(prefix, 'bin/drdsh')), false);
  for (const scope of ['relay', 'daemon']) {
    await command(process.execPath, [join(repo, 'scripts/component-cli.mjs'), scope, 'install', '--source', repo,
      '--prefix', prefix, '--skip-build', '--build-profile', 'debug', '--start'], 0, { PATH: process.env.PATH });
  }
  before = snapshot('daemon'); await install('relay'); unchanged('daemon', before);
  await run('relay', ['status']);
  check('old Node relay migrates to the unified binary without changing daemon PID/config');
  before = snapshot('relay'); await install('daemon'); unchanged('relay', before);
  await run('daemon', ['status']);
  assert.equal(readFileSync(join(state, 'retention-fixture'), 'utf8'), 'pairing-state-preserved');
  check('old Node daemon migrates with service identity and pairing state retained');
  await run('daemon', ['uninstall']); await run('relay', ['uninstall']);
  console.log(`Passed ${checks} native multicall checks.`);
} finally {
  for (const scope of ['daemon', 'relay']) {
    if (!existsSync(configPath(scope))) continue;
    try { await stopService(config(scope), scope); setAutostart(config(scope), scope, false); } catch {}
  }
  rmSync(scratch, { recursive: true, force: true });
}
