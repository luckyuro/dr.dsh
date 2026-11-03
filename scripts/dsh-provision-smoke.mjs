/** Real npm DSH provisioning and plugin registration in isolated directories.
 * --check-browser also checks first-run settings writes with PLAYWRIGHT_MODULE / CHROMIUM_BIN.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { stagePluginSource } from './package-plugin-source.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const binary = resolve(args[0] === '--drdsh' ? args[1] : join(repo, 'target/debug/drdsh'));
if (!existsSync(binary)) { console.error('Build drdsh first, or pass --drdsh <binary>.'); process.exit(2); }
const scratch = mkdtempSync('/tmp/drdsh-provision-');
const prefix = join(scratch, 'prefix');
const bundle = join(scratch, 'bundle');
const home = join(scratch, 'dsh-home');
const env = { ...process.env, DSH_HOME: home, CI: '1' };
// The automatic provisioner must not inherit a scoped registry override.
const npmConfig = join(scratch, 'unrelated.npmrc');
writeFileSync(npmConfig, '@deepseek-ai:registry=https://invalid.example/\n');
env.NPM_CONFIG_USERCONFIG = npmConfig;
for (const key of ['DSHD_DSH', 'DSHD_STATE_DIR', 'DRDSH_REPORT_URL', 'DRDSH_REPORT_TOKEN', 'DRDSH_MANAGED_INSTANCE']) delete env[key];
let stage = 'package setup';
let checks = 0;
function check(name) { stage = name; console.log(`ok ${++checks} - ${name}`); }
async function command(executable, argv, timeoutMs = 300_000) {
  const child = spawn(executable, argv, { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const pipe of [child.stdout, child.stderr]) pipe.on('data', data => { if (output.length < 1024 * 1024) output += data; });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  try {
    const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept); });
    assert.equal(code, 0, `local ${argv[0]} command failed`);
    return output;
  } finally { clearTimeout(timer); }
}
async function firstRun(dsh) {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core');
  const probe = createServer();
  await new Promise(accept => probe.listen(0, '127.0.0.1', accept));
  const port = probe.address().port;
  await new Promise(accept => probe.close(accept));
  const patch = join(scratch, 'first-run.json');
  writeFileSync(patch, JSON.stringify([{ id: 'ui-settings-models', config: { credentialOnboarding: false } }]));
  const host = spawn(dsh, ['web', '--patch', patch, '--no-open', '--port', String(port)], {
    cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let output = '';
  for (const pipe of [host.stdout, host.stderr]) pipe.on('data', data => { if (output.length < 1024 * 1024) output += data; });
  let browser;
  try {
    const deadline = Date.now() + 60_000;
    while (!/dsh web: (http\S+)/u.test(output)) {
      assert.equal(host.exitCode, null, 'the installed DSH must remain running');
      assert.ok(Date.now() < deadline, 'the installed DSH must print a local ready URL');
      await delay(100);
    }
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN, headless: true });
    const tab = await browser.newPage();
    let saved = false;
    tab.on('response', async response => {
      if (new URL(response.url()).pathname !== '/api/settings/mutate') return;
      try { saved = (await response.json())?.result?.ok === true; } catch { /* Checked below. */ }
    });
    await tab.goto(/dsh web: (http\S+)/u.exec(output)[1]);
    const next = tab.getByRole('button', { name: 'Continue', exact: true });
    await next.click(); await next.waitFor({ state: 'hidden', timeout: 20_000 });
    assert.ok(saved, 'the real settings mutation must succeed, not just close a dialog');
    await tab.reload({ waitUntil: 'networkidle' });
    assert.equal(await next.isVisible(), false, 'first-run acknowledgement must survive a reload');
    check('the downloaded runtime saves first-run settings and retains them after a real browser reload');
  } finally {
    await browser?.close();
    try { process.kill(-host.pid, 'SIGTERM'); } catch { /* Already stopped. */ }
    await delay(500);
    try { process.kill(-host.pid, 'SIGKILL'); } catch { /* Already stopped. */ }
  }
}
try {
  mkdirSync(join(bundle, 'bin'), { recursive: true });
  copyFileSync(binary, join(bundle, 'bin/drdsh'));
  await stagePluginSource(join(bundle, 'plugin'));
  const version = /drdsh\s+(\S+)/u.exec(await command(binary, ['--version']))[1];
  const target = process.platform === 'darwin' ? 'aarch64-apple-darwin' : 'x86_64-unknown-linux-musl';
  writeFileSync(join(bundle, 'bundle.json'), JSON.stringify({ format: 1, version, target, components: ['daemon'] }));
  stage = 'automatic DSH download';
  const install = ['daemon', 'install', '--source', bundle, '--prefix', prefix, '--dsh-home', home, '--workdir', scratch];
  await command(binary, install);
  const configPath = join(prefix, 'etc/dr.dsh/daemon.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(config.dshManaged, true);
  assert.equal(config.dshVersion, '0.2.2-alpha.2');
  assert.equal((await command(config.dsh, ['--version'])).trim(), config.dshVersion);
  assert.deepEqual(config.components, ['daemon', 'plugin']);
  check('omitting --dsh and --with-plugin installs pinned DSH and the plugin');
  const privateRoot = dirname(dirname(config.dsh));
  const lock = join(privateRoot, 'package-lock.json');
  assert.ok(statSync(lock).size > 0);
  const launcherBefore = readFileSync(config.dsh, 'utf8');
  const lockBefore = readFileSync(lock, 'utf8');
  const dump = await command(config.dsh, ['--profile', 'web', '--dump-config']);
  assert.match(dump, /@dr\.dsh\/dsh-plugin/u);
  const plugin = join(prefix, 'lib/dr.dsh/daemon/plugin');
  const metadata = JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8'));
  assert.equal(metadata.exports['.'], './src/index.js');
  for (const file of ['src/index.js', 'web/manage.html', 'web/manage.js', 'web/manage.css', `native/${target}/bin/drdsh`]) assert.ok(existsSync(join(plugin, file)));
  check('the real DSH profile registers an ESM plugin with management assets and matching native payload');
  if (args.includes('--check-browser')) await firstRun(config.dsh);
  await command(binary, install);
  assert.equal(readFileSync(config.dsh, 'utf8'), launcherBefore);
  assert.equal(readFileSync(lock, 'utf8'), lockBefore);
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).dsh, config.dsh);
  check('reinstallation retains the pinned private runtime and package lock');
  await command(binary, ['daemon', 'uninstall', '--prefix', prefix]);
  assert.equal(readFileSync(lock, 'utf8'), lockBefore);
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')).components, []);
  await command(binary, install);
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')).components, ['daemon', 'plugin']);
  check('uninstall preserves private DSH and a fresh reinstall restores the default plugin');
  const dependencyPath = join(privateRoot, 'node_modules/@deepseek-ai/cordis/package.json');
  const dependency = readFileSync(dependencyPath, 'utf8');
  const before = readFileSync(configPath, 'utf8');
  writeFileSync(dependencyPath, dependency.replace('4.0.6-alpha.1', '4.0.6-alpha.2'));
  let rejected = false;
  try { await command(binary, install); } catch { rejected = true; }
  finally { writeFileSync(dependencyPath, dependency); }
  assert.ok(rejected, 'an incompatible existing private runtime must be refused');
  assert.equal(readFileSync(configPath, 'utf8'), before);
  assert.equal(readFileSync(lock, 'utf8'), lockBefore);
  check('incompatible private dependencies fail before changing the saved installation or lock');
  console.log(`Passed ${checks} DSH provisioning checks.`);
} catch (error) {
  console.error(`DSH provisioning smoke failed during ${stage}: ${error instanceof assert.AssertionError ? 'assertion failed' : error.message}`);
  process.exitCode = 1;
} finally { rmSync(scratch, { recursive: true, force: true }); }
