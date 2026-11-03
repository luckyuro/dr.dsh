import assert from 'node:assert/strict';
import { chmod, link, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { BootstrapError, checksumFor, ensureNativeBundle, nativeTarget, privateDirectory, releaseLocation, unpackNativeArchive } from './bootstrap.ts';

function archive(entries: { name: string; data?: string; type?: string }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? '');
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100);
    header.write('0000700\0', 100, 8);
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12);
    header.fill(32, 148, 156);
    header.write(entry.type ?? '0', 156, 1);
    header.write('ustar\0', 257, 6);
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
const errorCode = (code: string) => (error: unknown) => error instanceof BootstrapError && error.code === code;

test('release origin and target cannot be replaced by arbitrary tags, URLs or hosts', () => {
  assert.equal(nativeTarget('linux', 'x64'), 'x86_64-unknown-linux-musl');
  assert.equal(nativeTarget('darwin', 'arm64'), 'aarch64-apple-darwin');
  assert.throws(() => nativeTarget('win32', 'x64'), errorCode('unsupported_platform'));
  const location = releaseLocation('v0.1.1', nativeTarget('linux', 'x64'));
  assert.equal(location.archive, 'https://github.com/luckyuro/dr.dsh/releases/download/v0.1.1/drdsh-daemon-x86_64-unknown-linux-musl.tar.gz');
  for (const tag of ['latest', '../v1', 'https://evil.example', 'v1.0.0/evil', 'v1.0.0\n']) {
    assert.throws(() => releaseLocation(tag, nativeTarget('linux', 'x64')), errorCode('invalid_release'));
  }
});

test('checksum metadata must name exactly one complete matching digest', () => {
  const hash = 'ab'.repeat(32);
  assert.equal(checksumFor(`${hash}  package.tar.gz\n`, 'package.tar.gz'), hash);
  assert.throws(() => checksumFor(`${hash} package.tar.gz\n${hash} package.tar.gz\n`, 'package.tar.gz'), errorCode('invalid_checksum'));
  assert.throws(() => checksumFor(`${hash} wrong.tar.gz\n`, 'package.tar.gz'), errorCode('invalid_checksum'));
});

test('archive reader extracts only required regular files and rejects traversal and duplicate executables', () => {
  const base = [{ name: './bin/drdsh', data: 'native bytes' }, { name: './bundle.json', data: '{}' }];
  const result = unpackNativeArchive(archive([...base, { name: './bin/drdsh-daemon', type: '2' }, { name: './install.sh', data: 'never execute this' }]));
  assert.equal(result.binary.toString(), 'native bytes');
  assert.equal(result.manifest.toString(), '{}');
  assert.throws(() => unpackNativeArchive(archive([...base, { name: '../escape' }])), errorCode('unsafe_archive'));
  assert.throws(() => unpackNativeArchive(archive([...base, base[0]!])), errorCode('invalid_archive'));
  assert.throws(() => unpackNativeArchive(archive([{ name: 'bin/drdsh', type: '2' }, base[1]!])), errorCode('unsafe_archive'));
  assert.throws(() => unpackNativeArchive(Buffer.from('not gzip')), errorCode('invalid_archive'));
});

test('local native bundle is copied to private stable storage and checked before reuse', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drdsh-bootstrap-'));
  try {
    const source = join(directory, 'source');
    await mkdir(join(source, 'bin'), { recursive: true, mode: 0o700 });
    await writeFile(join(source, 'bin/drdsh'), 'not executed during bootstrap', { mode: 0o700 });
    await writeFile(join(source, 'bundle.json'), JSON.stringify({ format: 1, version: '0.1.1', target: nativeTarget(), components: ['daemon'] }), { mode: 0o600 });
    const options = { storageRoot: join(directory, 'private'), releaseTag: 'v0.1.1', localBundleDirectory: source };
    const ready = await ensureNativeBundle(options);
    assert.notEqual(ready.source, source);
    assert.equal((await stat(ready.binary)).mode & 0o777, 0o700);
    assert.equal((await stat(ready.source)).mode & 0o777, 0o700);
    assert.equal(await readFile(ready.binary, 'utf8'), 'not executed during bootstrap');
    assert.deepEqual(await ensureNativeBundle(options), ready);
    await writeFile(ready.binary, 'corrupted');
    await assert.rejects(ensureNativeBundle(options), errorCode('damaged_cache'));
    await writeFile(join(source, 'bundle.json'), JSON.stringify({ format: 1, version: '999', target: nativeTarget(), components: ['daemon'] }));
    await assert.rejects(ensureNativeBundle(options), errorCode('package_mismatch'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('pnpm-style package hardlinks are copied while private cache hardlinks are rejected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drdsh-package-hardlinks-'));
  try {
    const store = join(directory, 'store');
    const source = join(directory, 'package');
    await mkdir(store, { mode: 0o700 });
    await mkdir(join(source, 'bin'), { recursive: true, mode: 0o755 });
    await writeFile(join(store, 'binary'), 'trusted packaged native bytes', { mode: 0o755 });
    await writeFile(join(store, 'manifest'), JSON.stringify({ format: 1, version: '0.1.1', target: nativeTarget(), components: ['daemon'] }), { mode: 0o644 });
    await link(join(store, 'binary'), join(source, 'bin/drdsh'));
    await link(join(store, 'manifest'), join(source, 'bundle.json'));
    assert.equal((await stat(join(source, 'bin/drdsh'))).nlink, 2);
    assert.equal((await stat(join(source, 'bundle.json'))).nlink, 2);
    const options = { storageRoot: join(directory, 'private'), releaseTag: 'v0.1.1', bundledDirectory: source };
    const ready = await ensureNativeBundle(options);
    assert.equal(await readFile(ready.binary, 'utf8'), 'trusted packaged native bytes');
    assert.equal((await stat(ready.binary)).mode & 0o777, 0o700);
    assert.notEqual((await stat(ready.binary)).ino, (await stat(join(store, 'binary'))).ino);
    for (const file of ['bin/drdsh', 'bundle.json', 'native.json']) {
      assert.equal((await stat(join(ready.source, file))).nlink, 1);
      const alias = join(directory, 'cache-alias');
      await link(join(ready.source, file), alias);
      await assert.rejects(ensureNativeBundle(options), errorCode('unsafe_package'));
      await rm(alias);
    }
    assert.deepEqual(await ensureNativeBundle(options), ready);
    await chmod(join(store, 'binary'), 0o775);
    await assert.rejects(ensureNativeBundle(options), errorCode('unsafe_package'));
    await chmod(join(store, 'binary'), 0o755);
    await rm(join(source, 'bin/drdsh'));
    await symlink(join(store, 'binary'), join(source, 'bin/drdsh'));
    await assert.rejects(ensureNativeBundle(options), (error: NodeJS.ErrnoException) => error.code === 'ELOOP');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('management storage refuses public or symlink directory roots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drdsh-storage-'));
  try {
    const publicDirectory = join(directory, 'public');
    await mkdir(publicDirectory, { mode: 0o755 });
    await assert.rejects(privateDirectory(publicDirectory), errorCode('unsafe_storage'));
    const link = join(directory, 'link');
    await symlink(directory, link);
    await assert.rejects(privateDirectory(link), errorCode('unsafe_storage'));
    await assert.rejects(ensureNativeBundle({ storageRoot: join(directory, 'cache'), bundledDirectory: join(directory, 'absent-native') }), errorCode('native_package_missing'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('fixed Release download verifies SHA-256, refuses foreign redirects and reuses the verified cache', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drdsh-download-'));
  const originalFetch = globalThis.fetch;
  try {
    const bytes = archive([
      { name: './bin/drdsh', data: 'verified native content' },
      { name: './bundle.json', data: JSON.stringify({ format: 1, version: '0.1.1', target: nativeTarget(), components: ['daemon'] }) },
    ]);
    const location = releaseLocation('v0.1.1', nativeTarget());
    const hash = createHash('sha256').update(bytes).digest('hex');
    const requests: string[] = [];
    globalThis.fetch = async input => {
      requests.push(String(input));
      assert.ok(String(input).startsWith('https://github.com/luckyuro/dr.dsh/releases/download/v0.1.1/'));
      return String(input).endsWith('/SHA256SUMS')
        ? new Response(`${hash}  ${location.asset}\n`)
        : new Response(bytes);
    };
    const options = { storageRoot: join(directory, 'good'), releaseTag: 'v0.1.1' };
    const ready = await ensureNativeBundle(options);
    assert.equal(await readFile(ready.binary, 'utf8'), 'verified native content');
    assert.equal(requests.length, 2);
    assert.deepEqual(await ensureNativeBundle(options), ready);
    assert.equal(requests.length, 2);
    await assert.rejects(ensureNativeBundle({ ...options, storageRoot: join(directory, 'mismatch'), archiveSha256: { [nativeTarget()]: '0'.repeat(64) } }), errorCode('checksum_mismatch'));
    globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: 'https://outside.example/package' } });
    await assert.rejects(ensureNativeBundle({ ...options, storageRoot: join(directory, 'redirect') }), errorCode('untrusted_redirect'));
    globalThis.fetch = async () => new Response('too large', { headers: { 'content-length': '999999999' } });
    await assert.rejects(ensureNativeBundle({ ...options, storageRoot: join(directory, 'oversized') }), errorCode('download_too_large'));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
