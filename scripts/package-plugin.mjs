#!/usr/bin/env node
// A DSH-installable package owns its native payload; no install hook downloads or executes it.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stagePluginSource } from './package-plugin-source.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const targets = new Set(['aarch64-apple-darwin', 'x86_64-unknown-linux-musl']);
const native = new Map();
let output;
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  const value = process.argv[i + 1];
  if (!value) throw new Error('Each option needs a value: --native <target>=<binary> (repeatable) --output <new.tgz>.');
  if (key === '--output' && output === undefined) output = resolve(value);
  else if (key === '--native') {
    const separator = value.indexOf('=');
    const target = value.slice(0, separator);
    if (separator < 1 || !targets.has(target) || native.has(target)) throw new Error('Each native payload needs one distinct supported target: aarch64-apple-darwin or x86_64-unknown-linux-musl.');
    native.set(target, resolve(value.slice(separator + 1)));
  } else throw new Error(`Unknown or duplicate packaging option: ${key}`);
}
if (!output || native.size === 0) throw new Error('Usage: node scripts/package-plugin.mjs --native <target>=<binary> [--native <target>=<binary>] --output <new.tgz>');
for (const path of [output, `${output}.sha256`]) {
  try { await lstat(path); throw new Error('Output or checksum already exists; choose a new output filename.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const workspace = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const stage = await mkdtemp(join(tmpdir(), 'drdsh-plugin-'));
try {
  const packaged = join(stage, 'package');
  await mkdir(packaged);
  const metadata = await stagePluginSource(packaged);
  for (const [target, binary] of native) {
    const info = await lstat(binary);
    if (!info.isFile() || info.isSymbolicLink() || !(info.mode & 0o111)) throw new Error(`Native payload for ${target} must be a regular executable file.`);
    const bytes = await readFile(binary);
    const matches = target === 'aarch64-apple-darwin'
      ? bytes.length >= 32 && bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(4) === 0x0100000c
      : bytes.length >= 64 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) && bytes[4] === 2 && bytes[5] === 1 && bytes.readUInt16LE(18) === 62;
    if (!matches) throw new Error(`Native payload does not match ${target}; cross-compiled programs are never executed by this packager.`);
    const bundle = join(packaged, 'native', target);
    await mkdir(join(bundle, 'bin'), { recursive: true });
    await writeFile(join(bundle, 'bin/drdsh'), bytes, { mode: 0o755 });
    await chmod(join(bundle, 'bin/drdsh'), 0o755);
    await writeFile(join(bundle, 'bundle.json'), `${JSON.stringify({ format: 1, version: workspace.version, target, components: ['daemon'] })}\n`);
  }
  const archive = join(stage, 'plugin.tgz');
  const tar = spawnSync('tar', ['--no-xattrs', '-czf', archive, '-C', stage, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' }, encoding: 'utf8' });
  if (tar.error || tar.status !== 0) throw new Error('Cannot create plugin tarball; install tar and check output permissions.');
  const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
  await mkdir(dirname(output), { recursive: true });
  await copyFile(archive, output, constants.COPYFILE_EXCL);
  await writeFile(`${output}.sha256`, `${hash}  ${basename(output)}\n`, { flag: 'wx' });
  console.log(`Packaged ${metadata.name}@${metadata.version}: ${output}\nTargets: ${[...native.keys()].join(', ')}\nSHA-256: ${hash}`);
} finally { await rm(stage, { recursive: true, force: true }); }
