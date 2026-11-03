/** Local-only orchestration. Native daemon.json remains the sole daemon configuration. */
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { BootstrapError, ensureNativeBundle, privateDirectory } from './bootstrap.ts';
import type { BootstrapOptions, NativeBundle } from './bootstrap.ts';

const MAX_JSON = 64 * 1024;
const MAX_STDERR = 64 * 1024;
const operations = [
  'status', 'config.get', 'config.set', 'runtime.status', 'pair.begin', 'pair.status', 'pair.cancel',
  'devices.list', 'devices.revoke', 'lifecycle.start', 'lifecycle.stop', 'lifecycle.restart', 'lifecycle.status',
  'service.start', 'service.stop', 'service.restart', 'service.enable', 'service.disable',
  'install', 'update', 'uninstall', 'logs.tail', 'doctor', 'audit.read', 'audit.clear',
  'crashes.read', 'crashes.clear', 'job.status', 'job.list',
  'handoff.plan', 'handoff',
] as const;
export type ManagementOperation = typeof operations[number];
export type ManagementParams = Record<string, unknown>;
export interface NativeFailure { code: string; message: string; retryable: boolean }
export type NativeResponse = { version: 1; requestId: string; ok: true; result: unknown }
  | { version: 1; requestId: string; ok: false; error: NativeFailure };
export interface InstallDefaults { dsh?: string; dshHome?: string; workdir?: string; port?: number }
export interface ManagerOptions extends Omit<BootstrapOptions, 'storageRoot'> {
  storageRoot?: string;
  profileHome?: string;
  installDefaults?: InstallDefaults;
  /** Local plugin configuration only; never accepted in an HTTP management request. */
  prefix?: string;
}
export interface ManagerState { prefix: string; installed: boolean; hasConfiguration: boolean; nativeReady: boolean; bootstrapRequired: boolean }
export interface NativeCallOptions {
  binary: string;
  prefix: string;
  directory: string;
  operation: string;
  params: ManagementParams;
  timeoutMs?: number;
}

export class ManagementError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = 'ManagementError';
    this.code = code;
    this.retryable = retryable;
  }
}
function invalid(message: string): never { throw new ManagementError('invalid_params', message); }
const plainObject = (value: unknown): value is Record<string, unknown> => value !== null
  && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null);

function safeEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'PATH', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'TMPDIR', 'LANG', 'LC_ALL', 'DRDSH_MANAGED_INSTANCE']) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  environment.DRDSH_BANNER_SHOWN = '1';
  return environment;
}

/** One bounded JSON exchange with an absolute executable and no shell or ambient daemon overrides. */
export async function callNative(options: NativeCallOptions): Promise<NativeResponse> {
  if (!isAbsolute(options.binary) || !isAbsolute(options.prefix) || !isAbsolute(options.directory)) invalid('The native executable, prefix and working directory must be absolute local paths.');
  if (options.operation !== 'job.submit' && !operations.includes(options.operation as ManagementOperation)) throw new ManagementError('unknown_operation', 'The native client accepts the documented daemon operation set only.');
  const requestId = randomUUID();
  const encoded = JSON.stringify({ version: 1, requestId, operation: options.operation, params: options.params });
  if (Buffer.byteLength(encoded) > MAX_JSON) throw new ManagementError('request_too_large', 'Management requests must not exceed 64 KiB.');
  return await new Promise<NativeResponse>((accept, reject) => {
    const child = spawn(options.binary, ['daemon', 'manage', '--prefix', options.prefix], {
      cwd: options.directory, env: safeEnvironment(), shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = Buffer.alloc(0);
    let stderrLength = 0;
    let settled = false;
    const stop = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    };
    const fail = (error: ManagementError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      reject(error);
    };
    const timer = setTimeout(() => fail(new ManagementError('native_timeout', 'The native management call timed out. Check its saved job or daemon status before retrying.', true)), options.timeoutMs ?? 105_000);
    child.once('error', () => fail(new ManagementError('native_unavailable', 'Cannot run the verified native daemon manager; check the local package and executable permissions.')));
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length + chunk.length > MAX_JSON + 1) {
        fail(new ManagementError('native_output_too_large', 'The native management response exceeds its 64 KiB limit.'));
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
    });
    // Raw stderr may contain local diagnostics. It never becomes a browser response.
    child.stderr.on('data', (chunk: Buffer) => {
      stderrLength += chunk.length;
      if (stderrLength > MAX_STDERR) fail(new ManagementError('native_output_too_large', 'The native manager exceeded its diagnostic output limit; inspect local logs.'));
    });
    child.once('close', code => {
      if (settled) return;
      let response: unknown;
      try { response = JSON.parse(stdout.toString('utf8')); }
      catch { fail(new ManagementError('invalid_native_response', 'The native manager did not return one valid JSON response; install a plugin-compatible daemon package.')); return; }
      if (!plainObject(response) || response.version !== 1 || response.requestId !== requestId || typeof response.ok !== 'boolean'
          || (response.ok && (code !== 0 || !('result' in response)))
          || (!response.ok && (code !== 1 || !plainObject(response.error)
            || typeof response.error.code !== 'string' || typeof response.error.message !== 'string'
            || typeof response.error.retryable !== 'boolean'))) {
        fail(new ManagementError('invalid_native_response', 'The native management response does not match its request or exit status.'));
        return;
      }
      settled = true;
      clearTimeout(timer);
      accept(response as NativeResponse);
    });
    child.stdin.end(encoded);
  });
}

const stringFields = new Set(['relay', 'dsh', 'dshHome', 'workdir', 'stateDir', 'caCert']);
const booleanFields = new Set(['tlsInsecure', 'dshTls', 'pluginReportsEnabled', 'localAdminEnabled', 'start', 'enable']);
const configFields = ['relay', 'port', 'dsh', 'dshHome', 'workdir', 'caCert', 'tlsInsecure', 'dshTls', 'pluginReportsEnabled', 'localAdminEnabled'];
const installFields = [...configFields, 'stateDir', 'start', 'enable'];
const jobOperations = new Set<ManagementOperation>(['install', 'update', 'uninstall', 'service.start', 'service.stop', 'service.restart', 'service.enable', 'service.disable', 'lifecycle.stop', 'lifecycle.restart', 'handoff']);

export function validateOperation(operation: unknown, value: unknown): { operation: ManagementOperation; params: ManagementParams } {
  if (typeof operation !== 'string' || !operations.includes(operation as ManagementOperation)) throw new ManagementError('unknown_operation', 'Choose a documented local daemon management operation.');
  if (!plainObject(value)) invalid('Management params must be a JSON object.');
  const selected = operation as ManagementOperation;
  const fields: readonly string[] = operation === 'config.set' ? configFields
    : operation === 'install' ? installFields
      : operation === 'pair.begin' ? ['waitSeconds']
        : ['pair.status', 'pair.cancel'].includes(operation) ? ['pairingId']
          : operation === 'devices.revoke' ? ['deviceId']
            : operation === 'job.status' ? ['jobId']
              : operation === 'handoff.plan' ? ['port', 'dshHome']
                : operation === 'handoff' ? ['planId'] : [];
  if (Object.keys(value).some(key => !fields.includes(key))) invalid('This operation contains unsupported fields; executable paths, package sources, prefixes and download locations are selected only in local plugin configuration.');
  for (const [key, item] of Object.entries(value)) {
    if (stringFields.has(key)) {
      if (key === 'caCert' && item === null && operation === 'config.set') continue;
      if (typeof item !== 'string' || item.length === 0 || item.length > 4096 || /[\0\r\n]/u.test(item)) invalid(`${key} requires a nonempty string without control characters.`);
      if (key !== 'relay' && !isAbsolute(item)) invalid(`${key} requires an absolute local path.`);
      if (key === 'relay') {
        try {
          const url = new URL(item);
          if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) invalid('relay requires a ws:// or wss:// origin without credentials, path, query or fragment.');
        } catch { invalid('relay requires a valid ws:// or wss:// origin.'); }
      }
    } else if (booleanFields.has(key)) {
      if (typeof item !== 'boolean') invalid(`${key} requires true or false.`);
    } else if (key === 'port' || key === 'waitSeconds') {
      const maximum = key === 'port' ? 65535 : 300;
      if (!Number.isInteger(item) || (item as number) < 1 || (item as number) > maximum) invalid(`${key} requires an integer from 1 through ${maximum}.`);
    } else if (typeof item !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(item)) invalid(`${key} is not a valid local management identifier.`);
  }
  for (const required of fields.filter(field => ['pairingId', 'deviceId', 'jobId', 'planId'].includes(field))) {
    if (!(required in value)) invalid(`${required} is required for this operation.`);
  }
  return { operation: selected, params: { ...value } };
}

interface InstanceReference { version: 1; prefix: string }
async function instanceReference(root: string, configured?: string): Promise<InstanceReference> {
  const path = join(root, 'instance.json');
  const requested = configured ?? process.env.DRDSH_MANAGER_PREFIX ?? join(homedir(), '.local');
  if (!isAbsolute(requested) || /[\0\r\n]/u.test(requested)) invalid('The configured daemon prefix must be an absolute local directory.');
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 16 * 1024 || info.nlink !== 1 || (info.mode & 0o777) !== 0o600
          || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new ManagementError('unsafe_reference', 'The plugin instance reference must be a private 0600 regular file owned by this user.');
      const value: unknown = JSON.parse(await handle.readFile('utf8'));
      if (!plainObject(value) || value.version !== 1 || typeof value.prefix !== 'string' || !isAbsolute(value.prefix)
          || /[\0\r\n]/u.test(value.prefix) || value.prefix !== resolve(value.prefix)
          || Object.keys(value).some(key => !['version', 'prefix'].includes(key))) throw new ManagementError('invalid_reference', 'The local plugin instance reference is invalid; repair it locally without changing daemon.json.');
      if (configured && resolve(configured) !== value.prefix) throw new ManagementError('instance_conflict', 'This plugin storage already refers to another daemon prefix; choose the existing prefix or separate private plugin storage.');
      return { version: 1, prefix: value.prefix };
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const reference: InstanceReference = { version: 1, prefix: resolve(requested) };
  const temporary = join(root, `.instance-${randomUUID()}`);
  try {
    await writeFile(temporary, `${JSON.stringify(reference)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
  return reference;
}

export class DaemonManager {
  readonly prefix: string;
  readonly storageRoot: string;
  private readonly options: BootstrapOptions;
  private readonly installDefaults: InstallDefaults;
  private native: NativeBundle | undefined;
  private preparing: Promise<NativeBundle> | undefined;
  constructor(options: BootstrapOptions, prefix: string, installDefaults: InstallDefaults = {}) {
    this.options = options;
    this.prefix = prefix;
    this.storageRoot = options.storageRoot;
    this.installDefaults = installDefaults;
  }
  async state(): Promise<ManagerState> {
    let installed = false;
    let hasConfiguration = false;
    try {
      const handle = await open(join(this.prefix, 'etc/dr.dsh/daemon.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_JSON || info.nlink !== 1 || (info.mode & 0o022) !== 0
            || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new ManagementError('invalid_config', 'The saved daemon configuration must be a bounded regular file owned by this user and not writable by other users.');
        const bytes = Buffer.alloc(MAX_JSON + 1);
        let length = 0;
        while (length < bytes.length) {
          const read = await handle.read(bytes, length, bytes.length - length, length);
          if (read.bytesRead === 0) break;
          length += read.bytesRead;
        }
        if (length > MAX_JSON) throw new ManagementError('invalid_config', 'The saved daemon configuration exceeds 64 KiB; repair it locally before managing this installation.');
        let config: unknown;
        try { config = JSON.parse(bytes.subarray(0, length).toString('utf8')); }
        catch { throw new ManagementError('invalid_config', 'The saved daemon configuration is not valid JSON; repair it locally without deleting pairing state.'); }
        if (!plainObject(config) || !Array.isArray(config.components) || config.components.some(item => typeof item !== 'string')) throw new ManagementError('invalid_config', 'The saved daemon configuration has no valid component list; repair it with the native daemon installer.');
        hasConfiguration = true;
        installed = config.components.includes('daemon');
      } finally { await handle.close(); }
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return { prefix: this.prefix, installed, hasConfiguration, nativeReady: this.native !== undefined, bootstrapRequired: this.native === undefined };
  }
  async bootstrap(): Promise<NativeBundle> {
    if (this.native) return this.native;
    if (!this.preparing) this.preparing = ensureNativeBundle(this.options);
    try { this.native = await this.preparing; return this.native; }
    finally { this.preparing = undefined; }
  }
  async execute(operation: unknown, suppliedParams: unknown = {}): Promise<NativeResponse> {
    const validated = validateOperation(operation, suppliedParams);
    const current = await this.state();
    if (validated.operation === 'status' && !current.hasConfiguration && !this.native) {
      return { version: 1, requestId: randomUUID(), ok: true, result: current };
    }
    const native = await this.bootstrap();
    let actualOperation: string = validated.operation;
    let params = validated.params;
    if (validated.operation === 'install') {
      // These invariants prevent the daemon installer from recursively owning its host plugin.
      params = { ...(!current.hasConfiguration ? this.installDefaults : {}), ...params, source: native.source, pluginOwner: 'external', localAdminEnabled: true, pluginReportsEnabled: true };
    } else if (validated.operation === 'update') {
      params = { source: native.source };
    }
    if (jobOperations.has(validated.operation)) {
      params = { operation: actualOperation, params, idempotencyKey: randomUUID() };
      actualOperation = 'job.submit';
    }
    try {
      return await callNative({ binary: native.binary, prefix: this.prefix, directory: this.storageRoot, operation: actualOperation, params });
    } catch (error) {
      if (error instanceof ManagementError || error instanceof BootstrapError) throw error;
      throw new ManagementError('native_failed', 'The local native manager could not finish this operation; inspect its saved job and daemon status before retrying.');
    }
  }
}

export async function createManager(options: ManagerOptions = {}): Promise<DaemonManager> {
  const profileHome = resolve(options.profileHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'));
  const profileHash = createHash('sha256').update(profileHome).digest('hex').slice(0, 16);
  const root = await privateDirectory(options.storageRoot ?? process.env.DRDSH_MANAGER_STORAGE ?? join(homedir(), '.local/share/dr.dsh/plugin-manager', profileHash));
  const reference = await instanceReference(root, options.prefix ?? process.env.DRDSH_MANAGER_PREFIX);
  if (options.installDefaults) validateOperation('install', options.installDefaults);
  return new DaemonManager({ ...options, storageRoot: root }, reference.prefix, options.installDefaults);
}

interface ManagementSession { token: string; expiresAtMs: number }
interface AuthorityOptions { storageRoot: string; now?: () => number }
const SESSION_TTL = 15 * 60_000;
const LAUNCH_TTL = 5 * 60_000;
const MAX_SESSIONS = 16;
const MAX_LAUNCHES = 8;
const secretHash = (value: string): Buffer => createHash('sha256').update(value).digest();

async function atomicPrivateText(path: string, value: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}`;
  try {
    await writeFile(temporary, value, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function capabilityAt(path: string): Promise<string> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 256 || (info.mode & 0o777) !== 0o600
          || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
        throw new ManagementError('unsafe_capability', 'The local management unlock file must be a 0600 regular file owned by this user.');
      }
      const capability = (await handle.readFile('utf8')).trim();
      if (!/^[A-Za-z0-9_-]{43}$/u.test(capability)) throw new ManagementError('invalid_capability', 'The local management unlock file is damaged; repair or remove that file locally before restarting the plugin.');
      return capability;
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const capability = randomBytes(32).toString('base64url');
  try {
    await writeFile(path, `${capability}\n`, { mode: 0o600, flag: 'wx' });
    return capability;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return capabilityAt(path);
    throw error;
  }
}

/** Possession of a local capability is mandatory; DSH cookies and network addresses are insufficient. */
export class LocalManagementAuthority {
  readonly capabilityFile: string;
  readonly launchFile: string;
  private readonly capabilityHash: Buffer;
  private readonly now: () => number;
  private readonly sessions = new Map<string, number>();
  private readonly launches = new Map<string, number>();
  private readonly attempts: number[] = [];
  private closed = false;
  constructor(storageRoot: string, capability: string, now: () => number = Date.now) {
    this.capabilityFile = join(storageRoot, 'local-unlock');
    this.launchFile = join(storageRoot, 'local-launch.url');
    this.capabilityHash = secretHash(capability);
    this.now = now;
  }
  private expire(): void {
    const now = this.now();
    for (const [hash, until] of this.sessions) if (until <= now) this.sessions.delete(hash);
    for (const [hash, until] of this.launches) if (until <= now) this.launches.delete(hash);
    while (this.attempts.length && this.attempts[0]! <= now - 60_000) this.attempts.shift();
  }
  unlock(candidate: unknown): ManagementSession {
    this.expire();
    if (this.closed) throw new ManagementError('management_closed', 'Local management is closed; reopen it from the running local DSH instance.');
    if (this.attempts.length >= 8) throw new ManagementError('unlock_rate_limited', 'Too many local management unlock attempts; wait one minute and use the current local unlock file.', true);
    this.attempts.push(this.now());
    if (typeof candidate !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(candidate)) throw new ManagementError('unlock_refused', 'Local management requires its local unlock capability or a fresh local browser launch.');
    const hash = secretHash(candidate);
    const key = hash.toString('hex');
    const launch = this.launches.has(key);
    // Hashing both values keeps the secret comparison fixed-length for all candidate lengths.
    const capability = timingSafeEqual(hash, this.capabilityHash);
    if (!launch && !capability) throw new ManagementError('unlock_refused', 'Local management requires its local unlock capability or a fresh local browser launch.');
    if (launch) this.launches.delete(key);
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest) this.sessions.delete(oldest);
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAtMs = this.now() + SESSION_TTL;
    this.sessions.set(secretHash(token).toString('hex'), expiresAtMs);
    return { token, expiresAtMs };
  }
  authorize(candidate: unknown): boolean {
    this.expire();
    return !this.closed && typeof candidate === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(candidate)
      && this.sessions.has(secretHash(candidate).toString('hex'));
  }
  async createLocalLaunchUrl(origin: string, path = '/_drdsh/manage'): Promise<string> {
    this.expire();
    if (this.closed) throw new ManagementError('management_closed', 'Local management is closed; reopen it from the running local DSH instance.');
    let url: URL;
    try { url = new URL(origin); }
    catch { throw new ManagementError('invalid_local_origin', 'A local browser launch requires the running DSH HTTP origin.'); }
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
        || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)
        || !/^\/_drdsh\/[A-Za-z0-9/_-]+$/u.test(path) || path.includes('..')) {
      throw new ManagementError('invalid_local_origin', 'A local browser launch must target this DSH instance on a loopback HTTP origin and its management path.');
    }
    if (this.launches.size >= MAX_LAUNCHES) {
      const oldest = this.launches.keys().next().value;
      if (oldest) this.launches.delete(oldest);
    }
    const launch = randomBytes(32).toString('base64url');
    this.launches.set(secretHash(launch).toString('hex'), this.now() + LAUNCH_TTL);
    url.pathname = path;
    url.hash = `launch=${launch}`;
    // This file is intentionally outside DSH's profile/workspace. Neither its contents
    // nor the returned fragment belongs in a generic RPC, route index or server log.
    await atomicPrivateText(this.launchFile, `${url.href}\n`);
    return url.href;
  }
  close(): void {
    this.closed = true;
    this.sessions.clear();
    this.launches.clear();
    this.attempts.length = 0;
  }
}

export async function createLocalManagementAuthority(options: AuthorityOptions): Promise<LocalManagementAuthority> {
  const root = await privateDirectory(options.storageRoot);
  const capability = await capabilityAt(join(root, 'local-unlock'));
  return new LocalManagementAuthority(root, capability, options.now);
}
