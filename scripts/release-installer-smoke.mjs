/** Exercises file and curl | sh entrypoints with real native installers against a loopback fixture. */
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
const version = `v${JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version}`;
const archive = join(scratch, asset);
execFileSync('sh', [join(repo, 'scripts/package-release.sh'), '--target', target, '--flavor', scope, '--binary', binary, '--output', archive]);
const bytes = readFileSync(archive), digest = createHash('sha256').update(bytes).digest('hex');
let mode = 'bad', checks = 0;
const requests = [];
const entrypoints = new Map(['install.sh', 'relay/install.sh', 'daemon/install.sh'].map(name => [
  `/${name}`, readFileSync(join(repo, name), 'utf8'),
]));
const server = createServer((request, response) => {
  requests.push(request.url);
  if (entrypoints.has(request.url)) response.end(entrypoints.get(request.url));
  else if (request.url === '/truncated-install.sh') {
    const script = entrypoints.get('/install.sh');
    response.end(script.slice(0, Math.floor(script.length / 2)));
  } else if (request.url.endsWith(`/${asset}`)) response.end(bytes);
  else if (request.url.endsWith('/SHA256SUMS')) response.end(`${mode === 'bad' ? '0'.repeat(64) : digest}  ${mode === 'missing' ? 'wrong-file.tar.gz' : asset}\n`);
  else { response.writeHead(404); response.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const prefix = join(scratch, 'prefix with space & $literal \'quote\'');
const config = join(prefix, `etc/dr.dsh/${scope}.json`);
const check = name => console.log(`ok ${++checks} - ${name}`);
async function command(file, args, expected, env = {}) {
  const result = await new Promise((accept, reject) => {
    const child = spawn(file, args, { cwd: scratch, env: {
      ...process.env, DRDSH_COMPONENT: '', DRDSH_VERSION: '', DRDSH_PREFIX: '',
      DRDSH_RELEASE_BASE_URL: base, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ...env,
    } });
    let text = ''; child.stdout.on('data', b => { text += b; }); child.stderr.on('data', b => { text += b; });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Installer timed out')); }, 90_000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', code => { clearTimeout(timeout); accept({ code, text }); });
  });
  assert.equal(result.code, expected, result.text); return result.text;
}
const nativeArgs = scope === 'daemon'
  ? ['--dsh', '/usr/bin/true', '--dsh-home', join(scratch, 'dsh home'), '--workdir', scratch, '--port', '38917']
  : ['--bind', '127.0.0.1:38917'];
const options = ['--prefix', prefix, '--version', version, ...nativeArgs];
const args = [join(repo, scope, 'install.sh'), ...options];
const pipe = (entrypoint, options, expected, env) => command('sh', [
  '-c', 'drdsh_script_url=$1; shift; curl -fsSL "$drdsh_script_url" | sh -s -- "$@"',
  'drdsh-pipe-test', `${base}/${entrypoint}`, ...options,
], expected, env);
try {
  for (const entrypoint of entrypoints.keys()) {
    assert.match(await pipe(entrypoint.slice(1), ['--help'], 0), /DRDSH_PREFIX/);
  }
  assert.equal(requests.length, 3);
  assert.equal(existsSync(prefix), false);
  check('all three curl entrypoints show help without downloading or installing a package');
  const beforeTruncation = requests.length;
  await pipe('truncated-install.sh', options, 2);
  assert.equal(requests.length, beforeTruncation + 1);
  assert.equal(existsSync(prefix), false);
  check('an incomplete streamed script cannot start downloading or installing');
  await command('sh', args, 1); assert.equal(existsSync(prefix), false);
  check('checksum mismatch stops before creating an installation');
  mode = 'missing'; await command('sh', args, 1); assert.equal(existsSync(prefix), false);
  check('missing asset checksum is rejected');
  mode = 'ok'; await command('sh', args, 0); assert.ok(existsSync(config));
  assert.ok(requests.some(p => p === `/download/${version}/${asset}`));
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
  await pipe(`${scope}/install.sh`, options, 0);
  assert.equal(JSON.parse(readFileSync(config, 'utf8')).prefix, prefix);
  check('curl component entrypoint installs without a checkout and preserves quoted path arguments');
  const envRequests = requests.length;
  await pipe('install.sh', nativeArgs, 0, { DRDSH_COMPONENT: scope, DRDSH_VERSION: version, DRDSH_PREFIX: prefix });
  assert.ok(requests.slice(envRequests).includes(`/download/${version}/${asset}`));
  assert.equal(JSON.parse(readFileSync(config, 'utf8')).prefix, prefix);
  check('root curl entrypoint accepts component, version and prefix environment defaults');
  const unused = join(scratch, 'unused-prefix'), flagRequests = requests.length;
  await pipe('install.sh', ['--component', scope, ...options], 0, {
    DRDSH_COMPONENT: 'invalid', DRDSH_VERSION: 'ignored-tag', DRDSH_PREFIX: unused,
  });
  assert.equal(existsSync(unused), false);
  assert.ok(requests.slice(flagRequests).includes(`/download/${version}/${asset}`));
  assert.ok(requests.slice(flagRequests).every(p => !p.includes('ignored-tag')));
  check('explicit curl installer flags override environment defaults');
  const pipeBefore = readFileSync(config, 'utf8');
  mode = 'bad'; await pipe(`${scope}/install.sh`, options, 1);
  assert.equal(readFileSync(config, 'utf8'), pipeBefore);
  check('checksum failure propagates through curl | sh without changing saved settings');
  await command(ctl, ['uninstall'], 0);
  console.log(`Passed ${checks} Release installer checks.`);
} finally {
  const ctl = join(prefix, `bin/drdsh-${scope}`);
  if (existsSync(ctl)) { try { await command(ctl, ['uninstall'], 0); } catch {} }
  await new Promise(r => server.close(r));
  rmSync(scratch, { recursive: true, force: true });
}
