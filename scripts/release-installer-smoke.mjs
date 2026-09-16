/** Exercises the actual HTTPS-downloader entrypoint against an explicit loopback fixture. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(repo, 'target/release-installer-smoke-'));
const target = process.platform === 'darwin' ? 'aarch64-apple-darwin' : 'x86_64-unknown-linux-musl';
const scope = process.platform === 'darwin' ? 'daemon' : 'relay';
const binary = resolve(process.env.DRDSH_TEST_BINARY ?? join(repo, 'target/debug/drdsh'));
const asset = `drdsh-${scope}-${target}.tar.gz`;
const archive = join(scratch, asset);
execFileSync('sh', [join(repo, 'scripts/package-release.sh'), '--target', target, '--flavor', scope, '--binary', binary, '--output', archive]);
const bytes = readFileSync(archive), digest = createHash('sha256').update(bytes).digest('hex');
let mode = 'bad', checks = 0;
const requests = [];
const server = createServer((request, response) => {
  requests.push(request.url);
  if (request.url.endsWith(`/${asset}`)) response.end(bytes);
  else if (request.url.endsWith('/SHA256SUMS')) response.end(`${mode === 'bad' ? '0'.repeat(64) : digest}  ${mode === 'missing' ? 'wrong-file.tar.gz' : asset}\n`);
  else { response.writeHead(404); response.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const prefix = join(scratch, 'prefix with space');
const config = join(prefix, `etc/dr.dsh/${scope}.json`);
const check = name => console.log(`ok ${++checks} - ${name}`);
async function command(file, args, expected) {
  const result = await new Promise((accept, reject) => {
    const child = spawn(file, args, { cwd: scratch, env: { ...process.env, DRDSH_RELEASE_BASE_URL: base, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
    let text = ''; child.stdout.on('data', b => { text += b; }); child.stderr.on('data', b => { text += b; });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Installer timed out')); }, 90_000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', code => { clearTimeout(timeout); accept({ code, text }); });
  });
  assert.equal(result.code, expected, result.text); return result.text;
}
const args = [join(repo, scope, 'install.sh'), '--prefix', prefix, '--version', 'v0.1.0', ...(scope === 'daemon' ? ['--dsh', '/usr/bin/true', '--workdir', scratch, '--port', '38917'] : ['--bind', '127.0.0.1:38917'])];
try {
  await command('sh', args, 1); assert.equal(existsSync(prefix), false);
  check('checksum mismatch stops before creating an installation');
  mode = 'missing'; await command('sh', args, 1); assert.equal(existsSync(prefix), false);
  check('missing asset checksum is rejected');
  mode = 'ok'; await command('sh', args, 0); assert.ok(existsSync(config));
  assert.ok(requests.some(p => p === `/download/v0.1.0/${asset}`));
  check('pinned Release installation downloads, verifies and installs without Node/Cargo');
  const ctl = join(prefix, `bin/drdsh-${scope}`);
  const before = readFileSync(config, 'utf8');
  mode = 'bad'; await command(ctl, ['update'], 1); assert.equal(readFileSync(config, 'utf8'), before);
  check('failed update leaves saved configuration unchanged');
  mode = 'ok'; await command(ctl, ['update'], 0);
  const saved = JSON.parse(readFileSync(config, 'utf8'));
  assert.equal(scope === 'daemon' ? saved.port : saved.bind, scope === 'daemon' ? 38917 : '127.0.0.1:38917');
  assert.ok(requests.some(p => p === `/latest/download/${asset}`));
  check('installed update command follows latest and retains component settings');
  await command(ctl, ['uninstall'], 0);
  console.log(`Passed ${checks} Release installer checks.`);
} finally {
  const ctl = join(prefix, `bin/drdsh-${scope}`);
  if (existsSync(ctl)) { try { await command(ctl, ['uninstall'], 0); } catch {} }
  await new Promise(r => server.close(r));
  rmSync(scratch, { recursive: true, force: true });
}
