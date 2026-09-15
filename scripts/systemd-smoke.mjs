/** Linux user-manager checks with real fixture processes; no Rust build or DSH installation needed. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execute, managerAvailable, paths, prepareService, serviceState, setAutostart, shellQuote,
  startService, stopService } from './service-manager.mjs';

try {
  if (process.platform !== 'linux') throw new Error('Run this check on Linux with a systemd user session.');
  managerAvailable();
} catch (error) { console.error(error.message); process.exit(2); }
const scratch = mkdtempSync(join(tmpdir(), 'drdsh-systemd-'));
const prefix = join(scratch, `space & % $literal "double" 'single'`);
const p = paths(prefix);
const config = { version: 1, prefix, source: scratch, relay: 'ws://127.0.0.1:8787', port: 3080,
  bind: '127.0.0.1:8787', dsh: '/bin/true', dshHome: prefix, state: p.state, workdir: prefix,
  path: '/usr/local/bin:/usr/bin:/bin', components: ['daemon'] };
mkdirSync(p.bin, { recursive: true });
writeFileSync(join(p.bin, 'drdshd'), `#!/bin/sh\npwd > ${shellQuote(join(prefix, 'actual-workdir'))}\nexec /bin/sleep 3600\n`, { mode: 0o755 });
let checks = 0;
function check(name, condition = true) { assert.ok(condition, name); console.log(`ok ${++checks} - ${name}`); }
try {
  const s = prepareService(config, 'daemon');
  execute('systemd-analyze', ['--user', 'verify', s.file]);
  check('systemd accepts the generated definition');
  check('status handles an installation that has never been linked', !serviceState(config, 'daemon').running);
  // Disabling a never-enabled installation must work (the uninstall path uses it).
  setAutostart(config, 'daemon', false);
  check('disable is valid before first start');
  await startService(config, 'daemon');
  const pid = serviceState(config, 'daemon').pid;
  check('start uses literal executable and working-directory paths', pid && readFileSync(join(prefix, 'actual-workdir'), 'utf8').trim() === prefix);
  await startService(config, 'daemon');
  check('repeated start keeps the same process', serviceState(config, 'daemon').pid === pid);
  setAutostart(config, 'daemon', true);
  check('enable persists user autostart', execute('systemctl', ['--user', 'is-enabled', s.name]).trim() === 'enabled');
  setAutostart(config, 'daemon', false);
  check('disable leaves the running process available', serviceState(config, 'daemon').running);
  await stopService(config, 'daemon');
  check('stop works after disabling/unlinking a running unit', !serviceState(config, 'daemon').running);
  await startService(config, 'daemon');
  check('a disabled installation can start again', serviceState(config, 'daemon').pid !== pid);
  await stopService(config, 'daemon');
  await stopService(config, 'daemon');
  check('stop is idempotent');
  console.log(`Passed ${checks} systemd checks with real fixture processes.`);
} catch (error) { console.error(error.stack); process.exitCode = 1; }
finally {
  try { await stopService(config, 'daemon'); setAutostart(config, 'daemon', false); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  if (!process.exitCode) rmSync(scratch, { recursive: true, force: true });
  else console.error(`Diagnostics retained at ${scratch}`);
}
