/** Real native diagnostics: JSON/text parity, occupied ports, failed checks and no configuration writes. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const binary = resolve(process.argv[2] ?? 'target/debug/drdsh');
if (!existsSync(binary) || process.platform === 'win32') {
  console.error('Build drdsh and run this smoke on macOS or Linux.'); process.exit(2);
}
const scratch = mkdtempSync(join(tmpdir(), 'drdsh-doctor-'));
const listener = createServer();
listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
const port = listener.address().port;
const dsh = join(scratch, 'dsh-fixture');
writeFileSync(dsh, '#!/bin/sh\nprintf "0.2.2-alpha.2\\n"\n', { mode: 0o755 });
const run = (executable, json) => {
  const result = spawnSync(binary, ['__runtime', 'daemon', 'doctor', '--dsh', executable, '--port', String(port), ...(json ? ['--json'] : [])], {
    encoding: 'utf8', timeout: 15_000, env: { ...process.env, DSHD_STATE_DIR: join(scratch, 'state'), DRDSH_BANNER_SHOWN: '1' },
  });
  assert.ifError(result.error);
  assert.equal(result.stderr, '');
  return result;
};
try {
  const before = readdirSync(scratch);
  const json = run(dsh, true);
  assert.equal(json.status, 0);
  const report = JSON.parse(json.stdout);
  assert.equal(report.version, 1);
  assert.equal(report.level, 'warn');
  assert.equal(report.checks.length, 5);
  assert.equal(report.checks.find(check => check.id === 'loopback').level, 'warn');
  assert.match(report.checks.find(check => check.id === 'loopback').remedy, /does not enable attach/u);
  const text = run(dsh, false);
  assert.equal(text.status, 0);
  for (const check of report.checks) assert.ok(text.stdout.includes(check.message));
  console.log('ok 1 - occupied port is a warning in both JSON and the compatible text report');
  const missing = run(join(scratch, 'missing-dsh'), true);
  assert.equal(missing.status, 1);
  const failed = JSON.parse(missing.stdout);
  assert.equal(failed.level, 'fail');
  assert.equal(failed.checks.find(check => check.id === 'dsh').level, 'fail');
  assert.ok(failed.checks.find(check => check.id === 'dsh').remedy);
  console.log('ok 2 - unavailable DSH produces a structured failure, remedy and nonzero exit');
  assert.deepEqual(readdirSync(scratch), before);
  console.log('ok 3 - diagnosis neither writes configuration nor creates an installation');
} finally { listener.close(); await once(listener, 'close'); rmSync(scratch, { recursive: true, force: true }); }
