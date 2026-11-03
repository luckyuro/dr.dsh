/** Native packages are data until their fixed release origin and digest are verified. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const MAX_ARCHIVE = 128 * 1024 * 1024;
const MAX_EXPANDED = 256 * 1024 * 1024;
const MAX_MANIFEST = 16 * 1024;
const RELEASE_ROOT = 'https://github.com/luckyuro/dr.dsh/releases/download/';

export type NativeTarget = 'x86_64-unknown-linux-musl' | 'aarch64-apple-darwin';
export interface NativeBundle {
  binary: string;
  source: string;
  version: string;
  target: NativeTarget;
}
export interface BootstrapOptions {
  storageRoot: string;
  /** A package-owned fixed version, never a browser-provided URL or `latest`. */
  releaseTag?: string;
  /** The matching target directory shipped inside this plugin package. */
  bundledDirectory?: string;
  /** Local administrator configuration only; useful for bundled releases and offline testing. */
  localBundleDirectory?: string;
  /** Optional digest embedded by the plugin release packager. */
  archiveSha256?: Partial<Record<NativeTarget, string>>;
}
interface Manifest { format: number; version: string; target: NativeTarget; components: string[] }
interface CacheRecord { version: 1; binarySha256: string }

export class BootstrapError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'BootstrapError';
    this.code = code;
  }
}
const fail = (code: string, message: string): never => { throw new BootstrapError(code, message); };
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export function nativeTarget(platform = process.platform, arch = process.arch): NativeTarget {
  if (platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-musl';
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  return fail('unsupported_platform', 'Native daemon packages support Linux x86_64 and macOS arm64; use a supported host or build a matching package locally.');
}

export function releaseLocation(tag: string, target: NativeTarget): { archive: string; sums: string; asset: string; version: string } {
  if (!/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9][A-Za-z0-9.-]*)?$/u.test(tag)) {
    return fail('invalid_release', 'The plugin must select an explicit versioned Release tag; latest and arbitrary download locations are not accepted.');
  }
  const asset = `drdsh-daemon-${target}.tar.gz`;
  return { archive: `${RELEASE_ROOT}${tag}/${asset}`, sums: `${RELEASE_ROOT}${tag}/SHA256SUMS`, asset, version: tag.slice(1) };
}

export async function privateDirectory(path: string): Promise<string> {
  if (!isAbsolute(path) || /[\0\r\n]/u.test(path)) return fail('invalid_storage', 'Plugin management storage must be an absolute local directory without control characters.');
  const directory = resolve(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    return fail('unsafe_storage', 'Plugin management storage must be a private directory owned by this user with mode 0700; choose or repair that directory locally.');
  }
  return directory;
}

async function regularFile(path: string, limit: number, boundary: 'package' | 'cache'): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    // pnpm links trusted package inputs to its store. Cache files are our private copies,
    // so aliases there would cross the storage boundary and must still be rejected.
    if (!info.isFile() || (boundary === 'cache' && info.nlink !== 1) || info.size > limit || (info.mode & 0o022) !== 0
        || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
      return fail('unsafe_package', 'Native package files must be regular files owned by this user, within size limits, and not writable by other users.');
    }
    const bytes = await handle.readFile();
    if (bytes.length > limit) return fail('package_too_large', 'The native package exceeds its size limit; select a complete supported release.');
    return bytes;
  } finally { await handle.close(); }
}

function parseManifest(bytes: Uint8Array, expectedVersion: string, target: NativeTarget): Manifest {
  if (bytes.length > MAX_MANIFEST) return fail('invalid_manifest', 'The native package manifest exceeds its size limit.');
  let value: Partial<Manifest>;
  try { value = JSON.parse(Buffer.from(bytes).toString('utf8')) as Partial<Manifest>; }
  catch { return fail('invalid_manifest', 'The native package has no valid bundle.json; use a complete Release package.'); }
  if (!value || value.format !== 1 || value.version !== expectedVersion || value.target !== target
      || !Array.isArray(value.components) || !value.components.includes('daemon')) {
    return fail('package_mismatch', 'The native package target, version or daemon component does not match this plugin release and host.');
  }
  return { format: 1, version: expectedVersion, target, components: ['daemon'] };
}

export function checksumFor(sums: string, asset: string): string {
  const matches = sums.split(/\r?\n/u).flatMap(line => {
    const match = /^([a-fA-F0-9]{64})\s+\*?([^\s]+)\s*$/u.exec(line);
    return match?.[2] === asset && match[1] ? [match[1].toLowerCase()] : [];
  });
  if (matches.length !== 1) return fail('invalid_checksum', 'The fixed Release SHA256SUMS must contain exactly one checksum for this daemon package.');
  return matches[0]!;
}

function allowedDownload(url: URL): boolean {
  return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
    && ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname);
}

async function download(location: string, limit: number): Promise<Buffer> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 120_000);
  try {
    let url = new URL(location);
    for (let redirects = 0; redirects <= 4; redirects++) {
      if (!allowedDownload(url)) return fail('untrusted_redirect', 'The native Release download redirected outside the supported GitHub HTTPS hosts.');
      const response = await fetch(url, { redirect: 'manual', signal: abort.signal, headers: { accept: 'application/octet-stream' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const destination = response.headers.get('location');
        if (!destination || redirects === 4) return fail('download_redirect', 'The native Release download has an invalid or excessive redirect chain.');
        url = new URL(destination, url);
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        return fail('download_unavailable', `The fixed native Release is unavailable (HTTP ${response.status}); install its published plugin package or select a verified local bundle in local configuration.`);
      }
      const declared = response.headers.get('content-length');
      if (declared && Number(declared) > limit) {
        await response.body.cancel();
        return fail('download_too_large', 'The native Release download exceeds its allowed size.');
      }
      const chunks: Uint8Array[] = [];
      let length = 0;
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > limit) {
            await reader.cancel();
            return fail('download_too_large', 'The native Release download exceeds its allowed size.');
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      return Buffer.concat(chunks, length);
    }
    return fail('download_redirect', 'The native Release redirect chain could not be resolved.');
  } catch (error) {
    if (error instanceof BootstrapError) throw error;
    return fail('download_failed', 'Cannot download the fixed native Release over verified HTTPS; check local network access and retry.');
  } finally { clearTimeout(timer); }
}

function tarString(bytes: Buffer, from: number, length: number): string {
  return bytes.subarray(from, from + length).toString('utf8').split('\0', 1)[0] ?? '';
}
function tarOctal(bytes: Buffer, from: number, length: number): number {
  const value = tarString(bytes, from, length).trim();
  if (!/^[0-7]*$/u.test(value)) return fail('invalid_archive', 'The native archive contains an unsupported numeric header.');
  const number = Number.parseInt(value || '0', 8);
  if (!Number.isSafeInteger(number)) return fail('invalid_archive', 'The native archive contains an oversized numeric header.');
  return number;
}
function archivePath(value: string): string {
  const path = value.replace(/^(?:\.\/)+/u, '').replace(/\/$/u, '');
  if (value.includes('\0') || value.includes('\\') || path.startsWith('/') || path.split('/').some(part => part === '..')) {
    return fail('unsafe_archive', 'The native archive contains an unsafe path; installation stopped without extracting files.');
  }
  return path;
}

/** Extract only two regular files; tar paths and aliases are never handed to an OS extractor. */
export function unpackNativeArchive(compressed: Uint8Array): { binary: Buffer; manifest: Buffer } {
  if (compressed.length > MAX_ARCHIVE) return fail('package_too_large', 'The native archive exceeds its compressed size limit.');
  let bytes: Buffer;
  try { bytes = gunzipSync(compressed, { maxOutputLength: MAX_EXPANDED }); }
  catch { return fail('invalid_archive', 'The native archive is invalid or exceeds its expanded size limit.'); }
  let binary: Buffer | undefined;
  let manifest: Buffer | undefined;
  let paxPath: string | undefined;
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const expected = tarOctal(header, 148, 8);
    const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (actual !== expected) return fail('invalid_archive', 'The native archive header checksum is invalid.');
    const size = tarOctal(header, 124, 12);
    const prefix = tarString(header, 345, 155);
    const name = tarString(header, 0, 100);
    const path = archivePath(paxPath ?? (prefix ? `${prefix}/${name}` : name));
    const type = header[156];
    const start = offset + 512;
    if (start + size > bytes.length) return fail('invalid_archive', 'The native archive is truncated.');
    const body = bytes.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
    paxPath = undefined;
    if (type === 120 || type === 103) {
      if (size > MAX_MANIFEST) return fail('invalid_archive', 'The native archive extended header is too large.');
      for (let i = 0; i < body.length;) {
        const space = body.indexOf(32, i);
        const length = Number(body.subarray(i, space).toString('ascii'));
        if (space < i || !Number.isInteger(length) || length <= space - i + 1 || i + length > body.length) return fail('invalid_archive', 'The native archive extended header is malformed.');
        const record = body.subarray(space + 1, i + length - 1).toString('utf8');
        if (record.startsWith('path=')) {
          if (type === 103) return fail('invalid_archive', 'Global archive path overrides are unsupported.');
          paxPath = archivePath(record.slice(5));
        }
        if (/^(?:size|linkpath)=/u.test(record)) return fail('invalid_archive', 'Archive size and link overrides are unsupported.');
        i += length;
      }
      continue;
    }
    if (path !== 'bin/drdsh' && path !== 'bundle.json') continue;
    if (type !== 0 && type !== 48) return fail('unsafe_archive', 'The native executable and manifest must be regular archive files.');
    if (path === 'bin/drdsh') {
      if (binary || size === 0 || size > MAX_ARCHIVE) return fail('invalid_archive', 'The native archive must contain exactly one bounded executable.');
      binary = Buffer.from(body);
    } else {
      if (manifest || size > MAX_MANIFEST) return fail('invalid_archive', 'The native archive must contain exactly one bounded manifest.');
      manifest = Buffer.from(body);
    }
  }
  if (!binary || !manifest) return fail('invalid_archive', 'The native archive is missing bin/drdsh or bundle.json.');
  return { binary, manifest };
}

async function cached(directory: string, version: string, target: NativeTarget): Promise<NativeBundle | undefined> {
  let present = false;
  try {
    await lstat(directory);
    present = true;
    await privateDirectory(directory);
    parseManifest(await regularFile(join(directory, 'bundle.json'), MAX_MANIFEST, 'cache'), version, target);
    const record = JSON.parse((await regularFile(join(directory, 'native.json'), MAX_MANIFEST, 'cache')).toString('utf8')) as CacheRecord;
    const binary = await regularFile(join(directory, 'bin/drdsh'), MAX_ARCHIVE, 'cache');
    if (record.version !== 1 || record.binarySha256 !== digest(binary)) return fail('damaged_cache', 'The cached native package failed its integrity check; remove that package cache locally and retry.');
    return { binary: join(directory, 'bin/drdsh'), source: directory, version, target };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (present) return fail('damaged_cache', 'The cached native package is incomplete; remove that package cache locally and retry.');
      return undefined;
    }
    if (error instanceof SyntaxError) return fail('damaged_cache', 'The cached native package metadata is damaged; remove that package cache locally and retry.');
    throw error;
  }
}

export async function ensureNativeBundle(options: BootstrapOptions): Promise<NativeBundle> {
  const target = nativeTarget();
  let source = options.localBundleDirectory ?? options.bundledDirectory;
  let suppliedManifest: Buffer | undefined;
  if (source) {
    if (!isAbsolute(source)) return fail('invalid_local_bundle', 'The administrator-selected local native bundle must use an absolute path.');
    try { suppliedManifest = await regularFile(join(source, 'bundle.json'), MAX_MANIFEST, 'package'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (options.localBundleDirectory) return fail('local_bundle_unavailable', 'The locally configured native bundle is missing bundle.json; select a complete compatible bundle in local plugin configuration.');
        source = undefined;
      } else { throw error; }
    }
  }
  let tag = options.releaseTag;
  if (!tag && suppliedManifest) {
    try {
      const value: unknown = JSON.parse(suppliedManifest.toString('utf8'));
      if (value && typeof value === 'object' && 'version' in value && typeof value.version === 'string') tag = `v${value.version}`;
    } catch { /* parseManifest below provides the bounded actionable diagnostic. */ }
  }
  if (!tag) return fail('native_package_missing', 'This plugin has no bundled native daemon or fixed compatible Release. Install a complete dr.dsh plugin release package, or select a verified local native bundle in local plugin configuration.');
  const release = releaseLocation(tag, target);
  const root = await privateDirectory(options.storageRoot);
  const packages = await privateDirectory(join(root, 'packages'));
  let binary: Buffer;
  let manifest: Manifest;
  let cacheName = `${tag}-${target}`;
  if (source && suppliedManifest) {
    manifest = parseManifest(suppliedManifest, release.version, target);
    binary = await regularFile(join(source, 'bin/drdsh'), MAX_ARCHIVE, 'package');
    cacheName += `-${digest(binary).slice(0, 16)}`;
  } else {
    const existing = await cached(join(packages, cacheName), release.version, target);
    if (existing) return existing;
    const trusted = options.archiveSha256?.[target];
    if (trusted !== undefined && !/^[a-fA-F0-9]{64}$/u.test(trusted)) return fail('invalid_checksum', 'The plugin package contains an invalid pinned Release digest.');
    const expected = trusted?.toLowerCase() ?? checksumFor((await download(release.sums, 256 * 1024)).toString('utf8'), release.asset);
    const archive = await download(release.archive, MAX_ARCHIVE);
    if (digest(archive) !== expected) return fail('checksum_mismatch', 'The native Release SHA-256 does not match; no executable was installed or run.');
    const unpacked = unpackNativeArchive(archive);
    manifest = parseManifest(unpacked.manifest, release.version, target);
    binary = unpacked.binary;
  }
  const destination = join(packages, cacheName);
  const existing = await cached(destination, release.version, target);
  if (existing) return existing;
  const staging = await privateDirectory(join(packages, `.stage-${randomUUID()}`));
  try {
    await mkdir(join(staging, 'bin'), { mode: 0o700 });
    await writeFile(join(staging, 'bin/drdsh'), binary, { mode: 0o700, flag: 'wx' });
    await writeFile(join(staging, 'bundle.json'), `${JSON.stringify(manifest)}\n`, { mode: 0o600, flag: 'wx' });
    await writeFile(join(staging, 'native.json'), `${JSON.stringify({ version: 1, binarySha256: digest(binary) })}\n`, { mode: 0o600, flag: 'wx' });
    try { await rename(staging, destination); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      const concurrent = await cached(destination, release.version, target);
      if (concurrent) return concurrent;
      throw error;
    }
    return { binary: join(destination, 'bin/drdsh'), source: destination, version: release.version, target };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
