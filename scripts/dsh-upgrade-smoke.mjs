/**
 * Install the real bundle into a fresh DSH home and exercise actual services.
 * Usage: node scripts/dsh-upgrade-smoke.mjs /absolute/path/to/dsh
 * Requires an installed Harness and its plugin package manager; no model/API key.
 * The HTTP report receiver here is a test fixture; the daemon chain has its own smoke.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = process.argv[2];
if (!binary || !existsSync(binary)) {
  console.error('Provide an installed DSH executable: node scripts/dsh-upgrade-smoke.mjs /absolute/path/to/dsh');
  process.exit(2);
}
const scratch = mkdtempSync(join(tmpdir(), 'drdsh-upgrade-'));
const reports = [];
const reportToken = randomBytes(32).toString('base64url');
const children = new Set();
let checks = 0;
const check = name => console.log(`ok ${++checks} - ${name}`);
const sink = createServer((req, res) => {
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/report');
  assert.ok(req.headers.authorization === `Bearer ${reportToken}`, 'plugin authenticates to its local receiver');
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => { reports.push(JSON.parse(body)); res.end(); });
});

function start(args) {
  const child = spawn(resolve(binary), args, {
    cwd: scratch, env: { ...process.env, DSH_HOME: join(scratch, 'home'), CI: '1',
      DRDSH_REPORT_URL: sink.listening ? `http://127.0.0.1:${sink.address().port}` : undefined,
      DRDSH_REPORT_TOKEN: sink.listening ? reportToken : undefined,
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { output += bytes; });
  const done = new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('close', code => accept(code));
  });
  done.catch(() => {});
  const running = { child, done, output: () => output.replace(/token=[^\s)]+/gu, 'token=<redacted>') };
  children.add(running);
  return running;
}

async function until(fn, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await fn()) return; await delay(100); }
  throw new Error(`Timed out waiting for ${label}`);
}

async function command(args, timeout = 90_000) {
  const running = start(args);
  let killTimer;
  const timer = setTimeout(() => {
    running.child.kill('SIGTERM');
    killTimer = setTimeout(() => running.child.kill('SIGKILL'), 3000);
  }, timeout);
  try { assert.equal(await running.done, 0, running.output()); }
  finally { clearTimeout(timer); clearTimeout(killTimer); }
  return running.output();
}

try {
  const version = (await command(['--version'])).trim();
  const supported = JSON.parse(readFileSync(join(repo, 'plugins/dr.dsh/package.json'), 'utf8')).engines.dsh.split(' || ');
  assert.ok(supported.includes(version), 'update the reviewed compatibility matrix before testing a new version');
  check(`real DSH ${version} executable`);
  await command(['plugin', '--profile', 'web', 'add', join(repo, 'plugins/dr.dsh')]);
  const profile = JSON.parse(readFileSync(join(scratch, 'home/profiles/web/package.json'), 'utf8'));
  assert.ok(profile.dsh.profile.bundles.includes('@dr.dsh/dsh-plugin'));
  check('bundle installs through the real DSH plugin command');
  sink.listen(0, '127.0.0.1'); await once(sink, 'listening');
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(accept => reservation.close(accept));
  const resultFile = join(scratch, 'result.json');
  const patch = join(scratch, 'upgrade.patch.json');
  writeFileSync(patch, JSON.stringify([
    // No browser is attached in this test: keep requests in the local waterfall
    // so the fixture answerers can exercise the services and plugin together.
    { id: 'api-remotes', disabled: true },
    { id: 'dr.dsh', config: {
      daemonUrl: `http://127.0.0.1:${sink.address().port}`,
      report: ['approval_requested', 'turn_complete', 'goal_complete', 'subagent_complete'],
    } },
    { insert: [{ id: 'dr.dsh-upgrade-probe', name: join(repo, 'scripts/fixtures/dsh-upgrade-probe.mjs'),
      config: { result: resultFile, cwd: scratch } }] },
  ]));
  const dsh = start(['web', '--patch', patch, '--no-open', '--port', String(port)]);
  await until(() => {
    if (dsh.child.exitCode !== null) throw new Error(dsh.output());
    return existsSync(resultFile);
  }, 'real Harness event producers').catch(error => {
    const stage = existsSync(`${resultFile}.stage`) ? readFileSync(`${resultFile}.stage`, 'utf8') : 'plugin mount';
    throw new Error(`${error.message} (${stage})\n${dsh.output()}`);
  });
  const result = JSON.parse(readFileSync(resultFile, 'utf8'));
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.approvalCalls, 1); assert.equal(result.questionCalls, 1);
  check('approval and question services keep their answerers and outcomes');
  await until(() => reports.length >= 5, 'HTTP reports from the installed plugin');
  assert.deepEqual(reports.map(report => report.event).sort(), [
    'approval_requested', 'approval_requested', 'goal_complete', 'subagent_complete', 'turn_complete',
  ]);
  for (const report of reports) {
    assert.deepEqual(Object.keys(report).sort(), ['atMs', 'event', 'sessionRef', 'severity']);
    assert.equal(report.sessionRef, report.event === 'subagent_complete' ? 'upgrade-child-session' : result.sessionId);
    assert.ok(Number.isSafeInteger(report.atMs));
  }
  assert.doesNotMatch(JSON.stringify(reports), /private|sentinel|objective|lastAssistantMessage/);
  check('session, goal and subagent reports contain only event metadata and the correct session id');
  dsh.child.kill('SIGTERM');
  const shutdownTimer = setTimeout(() => dsh.child.kill('SIGKILL'), 10_000);
  try { assert.equal(await dsh.done, 0, 'DSH must exit gracefully after SIGTERM'); }
  finally { clearTimeout(shutdownTimer); }
  check('real DSH and the installed plugin shut down cleanly');
  await command(['plugin', '--profile', 'web', 'remove', '@dr.dsh/dsh-plugin']);
  const after = JSON.parse(readFileSync(join(scratch, 'home/profiles/web/package.json'), 'utf8'));
  assert.equal(after.dsh.profile.bundles.includes('@dr.dsh/dsh-plugin'), false);
  check('bundle removal updates the real profile');
  console.log(`Passed ${checks} DSH ${version} upgrade checks.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  for (const running of children) {
    if (running.child.exitCode !== null || running.child.signalCode !== null) continue;
    running.child.kill('SIGTERM');
    const timer = setTimeout(() => running.child.kill('SIGKILL'), 3000);
    try { await running.done; } catch {} finally { clearTimeout(timer); }
  }
  sink.closeAllConnections();
  await new Promise(accept => sink.close(accept));
  rmSync(scratch, { recursive: true, force: true });
}
