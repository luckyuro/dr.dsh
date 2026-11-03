import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = 'x86_64-unknown-linux-musl';

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

for (const format of ['plugin', 'daemon release']) {
  test(`${format} archive imports through package exports from a real node_modules directory`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'drdsh-package-import-'));
    try {
      // Packaging checks the target header but must never run the supplied executable.
      const native = Buffer.alloc(64);
      native.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
      native.writeUInt16LE(62, 18);
      const binary = join(directory, 'drdsh');
      await writeFile(binary, native, { mode: 0o755 });
      const archive = join(directory, 'package.tgz');
      if (format === 'plugin') {
        run(process.execPath, [join(root, 'scripts/package-plugin.mjs'), '--native', `${target}=${binary}`, '--output', archive]);
        const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
        assert.equal(await readFile(`${archive}.sha256`, 'utf8'), `${hash}  package.tgz\n`);
      } else {
        run('sh', [join(root, 'scripts/package-release.sh'), '--target', target, '--flavor', 'daemon', '--binary', binary, '--output', archive]);
      }
      const extracted = join(directory, 'extracted');
      await mkdir(extracted);
      run('tar', ['-xzf', archive, '-C', extracted]);
      const consumer = join(directory, 'consumer');
      const installed = join(consumer, 'node_modules/@dr.dsh/dsh-plugin');
      await mkdir(dirname(installed), { recursive: true });
      await rename(join(extracted, format === 'plugin' ? 'package' : 'plugin'), installed);
      const metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
      assert.equal(metadata.exports['.'], './src/index.js');
      assert.equal(metadata.type, 'module');
      assert.equal(metadata.scripts, undefined);
      assert.equal(metadata.devDependencies, undefined);
      const files = await readdir(join(installed, 'src'));
      assert.ok(files.includes('index.js'));
      assert.ok(files.every(file => file.endsWith('.js') && !file.endsWith('.test.js')));
      assert.deepEqual(await readFile(join(installed, 'native', target, 'bin/drdsh')), native);
      // Importing inside node_modules exercises Node's package loader, where .ts
      // stripping is forbidden even though the repository's source tests pass.
      run(process.execPath, ['--input-type=module', '-e', [
        "import assert from 'node:assert/strict';",
        "import { apply, name } from '@dr.dsh/dsh-plugin';",
        "assert.equal(name, 'dr.dsh');",
        "assert.equal(typeof apply, 'function');",
      ].join('\n')], consumer);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
