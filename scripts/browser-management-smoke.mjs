/**
 * Install the actual packaged plugin in a temporary real DSH profile, authorize its page,
 * install daemon and verify the management instance survives actual host handoff.
 * Usage: node scripts/browser-management-smoke.mjs <dsh-path> [drdsh-path]
 * Requires a user service session, Playwright and Chromium; no model/API key.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { nativeTarget } from '../plugins/dr.dsh/src/bootstrap.ts';
import { managerAvailable } from './service-manager.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dsh = process.argv[2] && resolve(process.argv[2]);
const binary = resolve(process.argv[3] ?? 'target/debug/drdsh');
let chromium;
try {
  assert.ok(dsh && existsSync(dsh) && existsSync(binary), 'Pass real DSH and built drdsh paths.');
  managerAvailable();
  chromium = (await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core')).chromium;
} catch (error) { console.error(error.message); process.exit(2); }

const scratch = realpathSync(mkdtempSync('/tmp/drdsh-browser-management-'));
const prefix = join(scratch, 'prefix');
const storage = join(scratch, 'manager');
const configPath = join(prefix, 'etc/dr.dsh/daemon.json');
const output = join(root, 'output/playwright');
mkdirSync(output, { recursive: true });
const env = { ...process.env, DSH_HOME: join(scratch, 'dsh-home'), DRDSH_MANAGER_PREFIX: prefix, DRDSH_MANAGER_STORAGE: storage, CI: '1', NO_COLOR: '1', DRDSH_BANNER_SHOWN: '1' };
for (const key of Object.keys(env)) if (/^(DSHD_|DRDSH_REPORT_|DRDSH_MANAGED_)/u.test(key)) delete env[key];
const processes = new Set();
let browser;
let checks = 0;
const check = text => console.log(`ok ${++checks} - ${text}`);
function start(file, args) {
  const child = spawn(file, args, { cwd: scratch, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', bytes => { log = (log + bytes).slice(-256_000); });
  child.stderr.on('data', bytes => { log = (log + bytes).slice(-256_000); });
  const done = new Promise((accept, reject) => { child.once('error', reject); child.once('close', code => accept(code)); });
  done.catch(() => {});
  processes.add(child);
  return { child, done, log: () => log, safeLog: () => log.replace(/token=[^\s)]+/gu, 'token=<redacted>') };
}
async function command(file, args) {
  const run = start(file, args);
  const timeout = setTimeout(() => { try { process.kill(-run.child.pid, 'SIGKILL'); } catch { /* Already exited. */ } }, 90_000);
  try { assert.equal(await run.done, 0, run.safeLog()); } finally { clearTimeout(timeout); }
}
async function until(predicate, label, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(100); }
  throw new Error(`Timed out waiting for ${label}`);
}
try {
  const archive = join(scratch, 'plugin.tgz');
  await command(process.execPath, [join(root, 'scripts/package-plugin.mjs'), '--native', `${nativeTarget()}=${binary}`, '--output', archive]);
  await command(dsh, ['plugin', '--profile', 'web', 'add', archive]);
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; reservation.close(); await once(reservation, 'close');
  const host = start(dsh, ['web', '--no-open', '--port', String(port)]);
  await until(() => {
    if (host.child.exitCode !== null) throw new Error(host.safeLog());
    return /dsh web: (http:\/\/127\.0\.0\.1:\d+\S*)/u.test(host.log()) && existsSync(join(storage, 'local-unlock'));
  }, 'real DSH management readiness');
  const ready = /dsh web: (http:\/\/127\.0\.0\.1:\d+\S*)/u.exec(host.log())[1];
  const origin = new URL(ready).origin;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN, headless: true });
  const context = await browser.newContext({ viewport: { width: 1360, height: 960 }, locale: 'zh-CN' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(ready, { waitUntil: 'domcontentloaded' });
  await page.goto(`${origin}/_drdsh/manage`, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.evaluate(async () => (await fetch('/_drdsh/api/state')).status), 401);
  await page.screenshot({ path: join(output, 'validation-real-dsh-authorization.png'), fullPage: true });
  await page.locator('#authorization summary').click();
  await page.fill('#capability', readFileSync(join(storage, 'local-unlock'), 'utf8').trim());
  await page.locator('#unlock-form button').click();
  await page.locator('#dashboard').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.getElementById('instance-prefix').textContent !== '—');
  assert.equal(await page.locator('#instance-prefix').textContent(), prefix);
  check('a real DSH profile keeps DSH login separate from local capability authorization');
  await page.locator('nav a[href="#configuration"]').click();
  await page.fill('#relay', 'ws://127.0.0.1:18787');
  await page.click('#save-config');
  await until(() => existsSync(configPath), 'private daemon configuration');
  await page.locator('nav a[href="#overview"]').click();
  await until(async () => (await page.locator('#jobs').textContent()).includes('已完成'), 'installation OS job');
  await page.click('#refresh');
  await page.locator('#handoff-card').waitFor({ state: 'visible' });
  assert.equal(host.child.exitCode, null);
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).pluginOwner, 'external');
  check('the real plugin prepares its native daemon package without stopping its manual DSH host');
  page.once('dialog', dialog => dialog.dismiss());
  await page.click('#handoff');
  await page.waitForFunction(() => document.getElementById('handoff-detail').textContent.includes('检查通过'));
  assert.equal(host.child.exitCode, null);
  check('handoff validates the actual host identity, and dismissing confirmation leaves it running');
  await page.locator('nav a[href="#diagnosis"]').click();
  await page.click('[data-read="doctor"]');
  await page.locator('.check').first().waitFor();
  assert.equal(await page.locator('.check').count(), 5);
  await page.screenshot({ path: join(output, 'validation-real-dsh-diagnosis.png'), fullPage: true });
  await page.locator('nav a[href="#overview"]').click();
  page.once('dialog', dialog => dialog.accept());
  await page.click('#handoff');
  await until(() => host.child.exitCode !== null, 'manual host exit during handoff');
  await until(async () => {
    try { return (await fetch(`${origin}/_drdsh/manage`)).status === 401; } catch { return false; }
  }, 'managed DSH management page');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#authorization summary').click();
  await page.fill('#capability', readFileSync(join(storage, 'local-unlock'), 'utf8').trim());
  await page.locator('#unlock-form button').click();
  await page.locator('#dashboard').waitFor({ state: 'visible' });
  await page.waitForFunction(expected => document.getElementById('instance-prefix').textContent === expected, prefix);
  await until(async () => (await page.locator('#jobs').textContent()).includes('接管 DSH')
    && (await page.locator('#jobs').textContent()).includes('已完成'), 'handoff job recovery');
  assert.ok(await page.locator('#handoff-card').isHidden());
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).dshHome, env.DSH_HOME);
  check('actual OS handoff preserves the custom prefix, private authorization storage, profile and saved jobs');
  await page.click('#lock');
  assert.ok(await page.locator('#dashboard').isHidden());
  assert.equal(await page.locator('#diagnostics').textContent(), '');
  assert.deepEqual(errors, []);
  check('the real DSH management page renders native diagnostics and clears them on lock');
} catch (error) {
  console.error(error.message); process.exitCode = 1;
} finally {
  await browser?.close();
  let cleaned = true;
  if (existsSync(configPath)) {
    try { await command(binary, ['daemon', 'uninstall', '--prefix', prefix]); }
    catch (error) { console.error(`Temporary service cleanup failed: ${error.message}`); cleaned = false; process.exitCode = 1; }
  }
  for (const child of processes) if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ } }
  await delay(500);
  for (const child of processes) if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } }
  if (cleaned) { rmSync(scratch, { recursive: true, force: true }); check('the temporary installation, profile and processes are cleaned up'); }
}
if (!process.exitCode) console.log(`Passed ${checks} real DSH browser management checks.`);
