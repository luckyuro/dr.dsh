/** The native tunnel is a child of DSH, with its lifetime owned by a private pipe. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureNativeBundle, nativeTarget, privateDirectory } from './bootstrap.ts';
import type { DshContextLike, DshManagementSurface } from './dsh-surface.ts';
import { Reporter } from './reporter.ts';

export class CompanionError extends Error {}

export interface CompanionReady {
  readonly reportUrl: string;
  readonly reportToken: string;
  readonly roomId: string;
  stop(): Promise<void>;
}

export interface CompanionOptions {
  binary: string;
  relayUrl: string;
  stateDir: string;
  port: number;
  token: string;
  signal: AbortSignal;
  onExit(): void;
  timeoutMs?: number;
}

export function relayOrigin(value: unknown): string {
  let url: URL;
  try { url = new URL(typeof value === 'string' ? value : ''); }
  catch { throw new CompanionError('dr.dsh: relayUrl must be a complete HTTP(S) or WS(S) relay origin.'); }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) {
    throw new CompanionError('dr.dsh: relayUrl must be an HTTP(S) or WS(S) origin without credentials, path, query or fragment.');
  }
  return url.origin;
}

function readyMessage(value: unknown): Omit<CompanionReady, 'stop'> | undefined {
  if (!value || typeof value !== 'object' || !('ready' in value) || value.ready !== true) return undefined;
  const ready = value as Record<string, unknown>;
  let url: URL;
  try { url = new URL(typeof ready.reportUrl === 'string' ? ready.reportUrl : ''); }
  catch { throw new CompanionError('dr.dsh: the native tunnel returned an invalid report receiver; reinstall the matching plugin package.'); }
  if (ready.version !== 1 || url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
    || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || typeof ready.reportToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(ready.reportToken)
    || typeof ready.roomId !== 'string' || !/^[A-Za-z0-9_-]{22}$/u.test(ready.roomId)) {
    throw new CompanionError('dr.dsh: the native tunnel report credentials are incompatible; reinstall the matching plugin package.');
  }
  return { reportUrl: url.origin, reportToken: ready.reportToken, roomId: ready.roomId };
}

/** The launch capability travels only over stdin; raw child output is never logged. */
export function startNativeCompanion(options: CompanionOptions): Promise<CompanionReady> {
  if (options.signal.aborted) return Promise.reject(new CompanionError('dr.dsh: plugin relay startup was cancelled.'));
  if (!isAbsolute(options.binary) || !isAbsolute(options.stateDir)) {
    return Promise.reject(new CompanionError('dr.dsh: native tunnel and state paths must be absolute local paths.'));
  }
  const relayUrl = relayOrigin(options.relayUrl);
  return new Promise((accept, reject) => {
    // The native tunnel needs local runtime paths and the explicit CA setting,
    // not the host's model credentials or ambient daemon/TLS-bypass overrides.
    const environment: NodeJS.ProcessEnv = {};
    for (const key of ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'XDG_RUNTIME_DIR', 'DRDSH_CA_CERT']) {
      if (process.env[key] !== undefined) environment[key] = process.env[key];
    }
    const child = spawn(options.binary, ['daemon', 'plugin-connect'], {
      cwd: options.stateDir, env: environment, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let settled = false;
    let stopped = false;
    let pending = '';
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let finishClose!: () => void;
    const closed = new Promise<void>(resolve => { finishClose = resolve; });
    const stop = async (): Promise<void> => {
      if (!stopped) {
        stopped = true;
        child.stdin.end();
        child.kill('SIGTERM');
        killTimer = setTimeout(() => { child.kill('SIGKILL'); }, 3_000);
        killTimer.unref();
      }
      await closed;
    };
    const fail = (error: CompanionError): void => {
      if (!settled) { settled = true; clearTimeout(timer); reject(error); }
      void stop();
    };
    const abort = (): void => {
      fail(new CompanionError('dr.dsh: plugin relay connection closed with its DSH host.'));
    };
    const timer = setTimeout(() => fail(new CompanionError('dr.dsh: the native tunnel did not become ready; check the local DSH listener, relay configuration and matching native package.')), options.timeoutMs ?? 30_000);
    options.signal.addEventListener('abort', abort, { once: true });
    child.once('error', () => fail(new CompanionError('dr.dsh: the bundled native tunnel could not start; reinstall a complete plugin package for this platform.')));
    child.stdin.on('error', () => fail(new CompanionError('dr.dsh: the native tunnel closed its private input pipe; check the matching plugin package.')));
    child.stderr.on('data', () => { /* Native diagnostics must not leak process capabilities. */ });
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      pending += chunk.toString('utf8');
      if (Buffer.byteLength(pending) > 64 * 1024) {
        fail(new CompanionError('dr.dsh: the native tunnel exceeded its startup response limit; reinstall a matching package.'));
        return;
      }
      let newline: number;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        let value: unknown;
        try { value = JSON.parse(line); } catch { continue; }
        try {
          const ready = readyMessage(value);
          if (!ready) continue;
          settled = true;
          pending = '';
          clearTimeout(timer);
          accept({ ...ready, stop });
          return;
        } catch {
          fail(new CompanionError('dr.dsh: the native tunnel returned incompatible report credentials; reinstall the matching plugin package.'));
          return;
        }
      }
    });
    child.once('close', () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.signal.removeEventListener('abort', abort);
      finishClose();
      if (!settled) {
        settled = true;
        reject(new CompanionError('dr.dsh: the native tunnel stopped before becoming ready; check DSH authentication and local state permissions.'));
      } else if (!stopped) {
        try { options.onExit(); } catch { /* Observers cannot affect DSH. */ }
      }
    });
    child.stdin.write(`${JSON.stringify({ version: 1, relayUrl, stateDir: options.stateDir, port: options.port, token: options.token })}\n`);
    if (options.signal.aborted) abort();
  });
}

/** Starts after DSH commits readiness, and stops on plugin unload or DSH exit. */
export function mountPluginTunnel(
  ctx: DshContextLike,
  surface: DshManagementSurface,
  options: { relayUrl: string; report: readonly string[] },
): () => Promise<void> {
  const controller = new AbortController();
  let connection: CompanionReady | undefined;
  let stopReports: (() => void) | undefined;
  let started = false;
  const reportFailure = (): void => {
    console.error('dr.dsh: plugin relay connection is unavailable; check relayUrl, local DSH authentication and the bundled native package, then reload the plugin.');
  };
  const run = async (): Promise<void> => {
    const key = createHash('sha256').update(surface.profile.dir).digest('hex').slice(0, 16);
    const root = await privateDirectory(join(surface.profile.home, 'dr.dsh', key));
    const stateDir = await privateDirectory(join(root, 'state'));
    const native = await ensureNativeBundle({ storageRoot: root, bundledDirectory: fileURLToPath(new URL(`../native/${nativeTarget()}/`, import.meta.url)) });
    controller.signal.throwIfAborted();
    connection = await startNativeCompanion({
      binary: native.binary, stateDir, relayUrl: options.relayUrl,
      ...surface.attachCredentials(), signal: controller.signal,
      onExit() { stopReports?.(); stopReports = undefined; reportFailure(); },
    });
    if (controller.signal.aborted) { await connection.stop(); return; }
    stopReports = new Reporter({ daemonUrl: connection.reportUrl, daemonToken: connection.reportToken, report: options.report }).start(ctx);
    // Room identity and state path help local pairing; neither is a capability.
    console.info(`dr.dsh: plugin tunnel ready; room ${connection.roomId}; state ${stateDir}`);
  };
  let pending: Promise<void> | undefined;
  const stopReady = surface.onReady(() => {
    if (started || controller.signal.aborted) return;
    started = true;
    pending = run().catch(() => { if (!controller.signal.aborted) reportFailure(); });
  });
  return async () => {
    stopReady();
    controller.abort();
    stopReports?.();
    stopReports = undefined;
    await connection?.stop();
    await pending;
  };
}
