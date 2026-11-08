/** Local browser adapter; every request keeps DSH's own authentication fence. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, open, readFile, realpath, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BootstrapError, nativeTarget } from './bootstrap.ts';
import { ManagementError, createLocalManagementAuthority, createManager } from './manager.ts';
import type { DaemonManager, InstallDefaults, LocalManagementAuthority } from './manager.ts';
import type { DshManagementRouteHandler, DshManagementSurface } from './dsh-surface.ts';

const MAX_BODY = 64 * 1024;
const BODY_TIMEOUT = 5_000;
const REQUEST_TIMEOUT = 115_000;
const MAX_ACTIVE = 16;
const PUBLIC_PATHS = new Set(['/_drdsh/api/access', '/_drdsh/api/open-local', '/_drdsh/api/unlock']);
const STATIC = new Map([
  ['/_drdsh/manage', { file: 'manage.html', type: 'text/html; charset=utf-8' }],
  ['/_drdsh/manage.css', { file: 'manage.css', type: 'text/css; charset=utf-8' }],
  ['/_drdsh/manage.js', { file: 'manage.js', type: 'text/javascript; charset=utf-8' }],
  ['/_drdsh/validation.js', { file: 'validation.js', type: 'text/javascript; charset=utf-8' }],
  ['/_drdsh/diagnostics.js', { file: 'diagnostics.js', type: 'text/javascript; charset=utf-8' }],
]);
const METHODS = new Map([
  ...[...STATIC.keys()].map(path => [path, 'GET'] as const),
  ['/_drdsh/api/access', 'GET'], ['/_drdsh/api/open-local', 'POST'],
  ['/_drdsh/api/unlock', 'POST'], ['/_drdsh/api/state', 'GET'], ['/_drdsh/api/execute', 'POST'],
]);
type ManagerPort = Pick<DaemonManager, 'state' | 'execute'>;
type AuthorityPort = Pick<LocalManagementAuthority, 'capabilityFile' | 'launchFile' | 'unlock' | 'authorize' | 'createLocalLaunchUrl' | 'close'>;
export interface ManagementWebResources {
  manager: ManagerPort;
  authority: AuthorityPort;
  installDefaults: InstallDefaults;
  managed: boolean;
  localBrowserAvailable: boolean;
  readAsset(file: string): Promise<Buffer>;
  openLocal(url: string): Promise<void>;
}
class RequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly launchFile: string | undefined;
  constructor(status: number, code: string, message: string, launchFile?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.launchFile = launchFile;
  }
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function fields(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new RequestError(400, 'invalid_request', 'Send one JSON object containing only the documented fields for this endpoint.');
  }
}
function privateResponse(res: ServerResponse): void {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('pragma', 'no-cache');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
}
function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  const value = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(value));
  res.end(value);
}
function failure(res: ServerResponse, error: unknown): void {
  if (error instanceof RequestError) {
    json(res, error.status, { error: { code: error.code, message: error.message, retryable: error.status >= 500 || error.status === 429 }, ...(error.launchFile ? { launchFile: error.launchFile } : {}) });
  } else if (error instanceof ManagementError || error instanceof BootstrapError) {
    const status = error.code === 'unlock_rate_limited' ? 429 : error.code === 'unlock_refused' ? 403 : 400;
    json(res, status, { error: { code: error.code, message: error.message, retryable: error instanceof ManagementError && error.retryable } });
  } else {
    // Node spawn/fs errors may include argv or URLs; never serialize arbitrary exceptions.
    json(res, 500, { error: { code: 'management_failed', message: 'Local management could not complete this request. Check the local plugin package, permissions and daemon status, then retry.', retryable: false } });
  }
}
export function isLoopbackPeer(address: string | undefined): boolean {
  if (address === '::1') return true;
  const ipv4 = address?.replace(/^::ffff:/iu, '') ?? '';
  return isIP(ipv4) === 4 && ipv4.startsWith('127.');
}
function readJson(req: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  const declared = req.headers['content-length'];
  if (typeof declared === 'string' && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY)) {
    req.resume();
    return Promise.reject(new RequestError(413, 'request_too_large', 'Management JSON must not exceed 64 KiB.'));
  }
  return new Promise((accept, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      req.off('data', data);
      req.off('end', end);
      req.off('error', broken);
      req.off('aborted', broken);
      signal.removeEventListener('abort', aborted);
    };
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) { req.resume(); reject(error); } else accept(value);
    };
    const data = (bytes: Buffer) => {
      length += bytes.length;
      if (length > MAX_BODY) finish(new RequestError(413, 'request_too_large', 'Management JSON must not exceed 64 KiB.'));
      else chunks.push(bytes);
    };
    const end = () => {
      try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish(new RequestError(400, 'invalid_json', 'Send one complete JSON management request.')); }
    };
    const broken = () => finish(new RequestError(400, 'request_interrupted', 'The management request was interrupted before its JSON body arrived.'));
    const aborted = () => finish(new RequestError(503, 'management_closed', 'Local management closed while reading this request; reopen it from the current DSH instance.'));
    const timer = setTimeout(() => finish(new RequestError(408, 'body_timeout', 'The management JSON body did not arrive within five seconds; retry with a complete request.')), BODY_TIMEOUT);
    req.on('data', data);
    req.once('end', end);
    req.once('error', broken);
    req.once('aborted', broken);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

/** The HTTP-only test seam also ensures production and real-socket tests use identical guards. */
export function createManagementHandler(surface: DshManagementSurface, resources: ManagementWebResources): { handler: DshManagementRouteHandler; dispose(): void } {
  const active = new Set<AbortController>();
  let disposed = false;
  const dispatch = async (req: IncomingMessage, res: ServerResponse, signal: AbortSignal): Promise<void> => {
    const rejection = surface.requestRejection(req);
    if (rejection) throw new RequestError(rejection, 'dsh_auth_required', 'Open this page in an authenticated local DSH browser session.');
    if (!isLoopbackPeer(req.socket.remoteAddress)) throw new RequestError(403, 'local_only', 'Daemon management is available only from the DSH computer through its local browser.');
    const path = req.url ?? '';
    const method = METHODS.get(path);
    if (!method) throw new RequestError(404, 'not_found', 'This management endpoint does not exist; reload the plugin management page.');
    if (req.method !== method) throw new RequestError(405, 'method_not_allowed', `Use ${method} for this management endpoint.`);
    const asset = STATIC.get(path);
    if (asset) {
      const bytes = await resources.readAsset(asset.file);
      signal.throwIfAborted();
      res.setHeader('content-type', asset.type);
      res.setHeader('content-length', bytes.length);
      res.end(bytes);
      return;
    }
    if (!PUBLIC_PATHS.has(path)) {
      const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/iu.exec(req.headers.authorization ?? '')?.[1];
      if (!resources.authority.authorize(bearer)) throw new RequestError(401, 'management_unlock_required', 'Unlock management from this computer before viewing or changing daemon state.');
    }
    let body: unknown;
    if (method === 'POST') {
      if (req.headers.origin !== surface.origin) throw new RequestError(403, 'origin_refused', 'Submit management changes from this DSH instance’s local management page.');
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(req.headers['content-type'] ?? '')) throw new RequestError(415, 'json_required', 'Management changes require Content-Type: application/json.');
      body = await readJson(req, signal);
      signal.throwIfAborted();
    }
    if (path === '/_drdsh/api/access') {
      json(res, 200, { capabilityFile: resources.authority.capabilityFile, launchFile: resources.authority.launchFile, localBrowserAvailable: resources.localBrowserAvailable });
    } else if (path === '/_drdsh/api/open-local') {
      fields(body, []);
      const url = await resources.authority.createLocalLaunchUrl(surface.origin);
      signal.throwIfAborted();
      try {
        if (!resources.localBrowserAvailable) throw new Error('no local browser');
        await resources.openLocal(url);
      } catch {
        throw new RequestError(503, 'local_browser_unavailable', 'Cannot open the local browser. On the DSH computer, read the private launch file and open its link in an authenticated DSH browser.', resources.authority.launchFile);
      }
      signal.throwIfAborted();
      json(res, 200, { opened: true });
    } else if (path === '/_drdsh/api/unlock') {
      fields(body, ['capability']);
      if (typeof body.capability !== 'string') throw new RequestError(400, 'invalid_request', 'Unlock requires a capability string read from this computer or supplied by its local browser launch.');
      json(res, 200, resources.authority.unlock(body.capability));
    } else if (path === '/_drdsh/api/state') {
      const state = await resources.manager.state();
      signal.throwIfAborted();
      json(res, 200, { ...state, installDefaults: resources.installDefaults, host: { port: surface.port, profile: surface.profile, managed: resources.managed } });
    } else {
      fields(body, ['operation', 'params']);
      if (typeof body.operation !== 'string' || !object(body.params)) throw new RequestError(400, 'invalid_request', 'Execute requires a documented operation string and a params object.');
      const result = await resources.manager.execute(body.operation, body.params);
      signal.throwIfAborted();
      json(res, 200, result);
    }
  };
  return {
    handler: async (req, res) => {
      privateResponse(res);
      if (disposed) { failure(res, new RequestError(503, 'management_closed', 'This management page has unloaded; reopen it from the current DSH instance.')); return; }
      if (active.size >= MAX_ACTIVE) { failure(res, new RequestError(503, 'management_busy', 'Too many management requests are in progress; wait for an existing request to finish.')); return; }
      const controller = new AbortController();
      active.add(controller);
      let onAbort: (() => void) | undefined;
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      const timer = setTimeout(() => controller.abort(new RequestError(504, 'management_timeout', 'This management request timed out. Inspect its saved job or daemon state before retrying.')), REQUEST_TIMEOUT);
      try { await Promise.race([dispatch(req, res, controller.signal), cancelled]); }
      catch (error) { failure(res, error); }
      finally {
        clearTimeout(timer);
        if (onAbort) controller.signal.removeEventListener('abort', onAbort);
        active.delete(controller);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      resources.authority.close();
      for (const controller of active) controller.abort(new RequestError(503, 'management_closed', 'The DSH management surface unloaded. Submitted native jobs continue independently; reconnect to inspect their saved status.'));
    },
  };
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
export async function createTrustedLauncher(storageRoot: string, prefix: string, executable = process.execPath, entrypoint = process.argv[1]): Promise<string> {
  if ([storageRoot, prefix].some(value => !isAbsolute(value) || /[\0\r\n]/u.test(value))) throw new ManagementError('dsh_launcher_unavailable', 'The management storage and daemon prefix must be absolute local directories; repair the local plugin configuration before installing daemon.');
  if (!entrypoint || !isAbsolute(entrypoint) || !isAbsolute(executable) || /[\0\r\n]/u.test(entrypoint + executable)) throw new ManagementError('dsh_launcher_unavailable', 'DSH did not start through an absolute local CLI entrypoint; restart it through its installed CLI before installing daemon.');
  const node = await realpath(executable);
  const script = await realpath(entrypoint);
  if (!(await lstat(node)).isFile() || !(await lstat(script)).isFile()) throw new ManagementError('dsh_launcher_unavailable', 'The running DSH Node executable and CLI entrypoint must be regular local files.');
  // OS services do not inherit the manual host's environment. Keep this launcher
  // bound to the same manager so handoff cannot fall back to another installation.
  const source = `#!/bin/sh\nexport DRDSH_MANAGER_PREFIX=${quote(prefix)}\nexport DRDSH_MANAGER_STORAGE=${quote(storageRoot)}\nexec ${quote(node)} ${quote(script)} "$@"\n`;
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const path = join(storageRoot, `dsh-launcher-${hash}`);
  try { await writeFile(path, source, { mode: 0o700, flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o700
        || (typeof process.getuid === 'function' && info.uid !== process.getuid())
        || await handle.readFile('utf8') !== source) {
      throw new ManagementError('dsh_launcher_changed', 'The private DSH launcher differs from this running CLI; repair that launcher locally before installing daemon.');
    }
  } finally { await handle.close(); }
  return path;
}

async function browserCommand(): Promise<string | undefined> {
  const command = process.platform === 'darwin' ? '/usr/bin/open'
    : process.platform === 'linux' && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) ? '/usr/bin/xdg-open' : undefined;
  if (!command) return undefined;
  try { await access(command, constants.X_OK); return command; } catch { return undefined; }
}
function openBrowser(command: string, url: string): Promise<void> {
  return new Promise((accept, reject) => {
    const child = spawn(command, [url], { shell: false, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('local browser launch timed out')); }, 10_000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('local browser launch failed')); });
    child.once('close', code => { clearTimeout(timer); if (code === 0) accept(); else reject(new Error('local browser launch failed')); });
  });
}

export async function mountManagementPage(surface: DshManagementSurface): Promise<() => void> {
  const bundledDirectory = fileURLToPath(new URL(`../native/${nativeTarget()}/`, import.meta.url));
  const first = await createManager({ profileHome: surface.profile.home, bundledDirectory });
  const dsh = await createTrustedLauncher(first.storageRoot, first.prefix);
  const installDefaults: InstallDefaults = { dsh, dshHome: surface.profile.home, workdir: surface.profile.cwd, port: surface.port };
  const manager = await createManager({ profileHome: surface.profile.home, storageRoot: first.storageRoot, prefix: first.prefix, bundledDirectory, installDefaults });
  const authority = await createLocalManagementAuthority({ storageRoot: manager.storageRoot });
  const command = await browserCommand();
  const web = createManagementHandler(surface, {
    manager, authority, installDefaults, managed: Boolean(process.env.DRDSH_MANAGED_INSTANCE), localBrowserAvailable: command !== undefined,
    async readAsset(file) {
      const bytes = await readFile(file === 'validation.js' ? new URL(import.meta.resolve('@dr.dsh/validation')) : new URL(`../web/${file}`, import.meta.url));
      if (bytes.length > 1024 * 1024) throw new ManagementError('management_asset_too_large', 'The plugin management asset exceeds its size limit; reinstall a complete plugin package.');
      return bytes;
    },
    async openLocal(url) {
      if (!command) throw new Error('local browser unavailable');
      await openBrowser(command, url);
    },
  });
  const disposers: (() => void)[] = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    web.dispose();
    for (const stop of disposers.splice(0).reverse()) stop();
  };
  try {
    disposers.push(surface.registerRoute('/_drdsh', 'prefix', web.handler));
    disposers.push(surface.registerManagementLink());
    return dispose;
  } catch (error) { dispose(); throw error; }
}
