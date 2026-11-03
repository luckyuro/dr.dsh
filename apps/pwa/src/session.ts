/**
 * The page's session: connect to the daemon, then hand the tunnel to the service worker.
 *
 * ## Why the service worker needs the tunnel
 *
 * The DSH interface is a normal web application: it issues `fetch` and `WebSocket` calls
 * against its own origin and expects to be served. It cannot be told to speak a custom
 * protocol, so the *service worker* is what makes those ordinary calls travel through the
 * tunnel — the page only has to get the tunnel to the worker.
 *
 * That handoff is a `MessagePort`, and this module owns it. A port rather than a shared
 * global because the worker lives in a different global scope: it cannot see the page's
 * socket, and it must keep working across the navigations the DSH UI performs.
 *
 * ## What the page does, in order
 *
 * 1. Derive the room from the key and open a tunnel (`tunnel.ts`).
 * 2. Register the service worker and wait for it to control this page.
 * 3. Hand the worker a port, and give the DSH UI the navigation it asked for.
 *
 * Step 2 before step 3 matters: a worker handed a tunnel before it controls the page
 * cannot intercept that page's requests, so the first navigation to the DSH UI would go
 * straight to the relay and 404.
 *
 * @module @dr.dsh/pwa/session
 */

import { t, LocalizedError } from './i18n.ts';

import { checkRoom, restoreDevice, type IdentityRecord } from './identity.ts';
import { serveWorker } from './officer.ts';
import { Tunnel, type TunnelSocket, type DeviceIdentity } from './tunnel.ts';

/** How the page is doing, for the UI to render. */
export type SessionPhase =
  | { readonly phase: 'idle' }
  | { readonly phase: 'connecting' }
  | { readonly phase: 'ready'; readonly room: string }
  | { readonly phase: 'failed'; readonly reason: string; readonly cause?: unknown };

/** What a page passes to {@link Session.start}. */
export interface SessionOptions {
  /** The room key the user typed, when they typed one. */
  readonly roomKey?: string;
  /**
   * The room id this connection is for.
   *
   * Explicit since ADR-0007: the identity is shared by every room, so the room a device proof is bound
   * to has to come from the room record the caller chose, not from the identity.
   */
  readonly room?: string;
  /** The device identity this browser has, when it has one. */
  readonly device?: IdentityRecord | null;
  /** A fresh pairing may briefly reconnect the daemon while it applies the new device policy. */
  readonly waitForDaemon?: boolean;
}

/** What a page needs from the browser, so the logic around it is testable. */
export interface SessionHost {
  /** Opens the carrier socket for a room. */
  connect(room: string): Promise<TunnelSocket>;
  /** Registers the worker and resolves once it controls this page. */
  prepareWorker(): Promise<void>;
  /**
   * Hands the worker a port and starts serving it.
   *
   * A port rather than the tunnel itself: a `MessagePort` cannot carry something that seals
   * its own bytes, so the page keeps the tunnel and answers the worker's requests.
   *
   * @param serve - called with the page's end of the channel; returns a stop function.
   * @returns a function that stops serving.
   */
  hand(serve: (port: MessagePort) => () => void, signal: AbortSignal): Promise<() => void>;
  /** Reports a phase change. */
  report(phase: SessionPhase): void;
}

/**
 * A page's session lifecycle, with every browser dependency injected.
 *
 * The point of the injection is testability: the ordering that matters here — connect,
 * then control the page, then hand over — is invisible in a browser until it is wrong, and
 * then it looks like "the interface 404s".
 */
export class Session {
  private tunnel: Tunnel | null = null;
  private stopServing: (() => void) | null = null;
  private stopClosed: (() => void) | null = null;
  private handAbort: AbortController | null = null;
  private readonly host: SessionHost;

  public constructor(host: SessionHost) {
    this.host = host;
  }

  /**
   * Connects, prepares the worker, and hands the tunnel over.
   *
   * @param options - the room key (as unpadded base64url) and/or the stored device.
   * @returns the room the tunnel is parked on.
   * @throws Error when there is no key, the key is not a room key, the stored device is unusable,
   * or the daemon does not answer.
   */
  public async start(options: SessionOptions): Promise<string> {
    this.host.report({ phase: 'connecting' });
    try {
      // The key comes from the room record the caller chose, or from what the user typed.
      const encoded = options.roomKey;
      if (encoded === undefined || encoded === '') {
        throw new LocalizedError(() => t('error.noPairing'));
      }
      const root = decodeRoomKey(encoded);
      const room = await Tunnel.roomFor(root);

      // Checked before the socket is opened: a room record that disagrees with its own key must fail
      // as "pair this device again" rather than as a refusal from the daemon three steps later, where
      // it is indistinguishable from a revoked device.
      if (options.device !== undefined && options.device !== null && options.room !== undefined) {
        await checkRoom(encoded, options.room);
      }

      // Restored for the same reason: a key that does not match its stored public half fails as
      // "pair again", not as an authentication failure against the daemon.
      let identity: DeviceIdentity | null = null;
      if (options.device !== undefined && options.device !== null) {
        const device = await restoreDevice(options.device);
        identity = {
          deviceId: device.record.deviceId,
          room,
          key: device.keyPair,
        };
      }

      const socket = await this.host.connect(room);
      const tunnel = await Tunnel.open(socket, root, identity);
      this.tunnel = tunnel;
      this.stopClosed = tunnel.onClosed(() => this.stop());
      // The worker must control this page *before* it is handed a tunnel: otherwise the
      // first navigation to the DSH interface is not intercepted, and the browser shows
      // whatever the relay answers for that path instead of the interface.
      await this.host.prepareWorker();
      if (this.tunnel !== tunnel) throw new Error('the connection ended before the interface was ready; reconnect this page');
      // The handoff starts serving from this moment: the worker's end goes to the worker,
      // and the page's end is answered here through the tunnel.
      this.handAbort = new AbortController();
      const stopServing = await this.host.hand(port => serveWorker(tunnel, port), this.handAbort.signal);
      if (this.tunnel !== tunnel || !tunnel.isEstablished) {
        stopServing();
        throw new Error('the connection ended before the interface was ready; reconnect this page');
      }
      this.stopServing = stopServing;
      this.host.report({ phase: 'ready', room });
      return room;
    } catch (error) {
      this.release();
      // Every failure path reports, including the ones before a socket exists: a page that shows
      // "Connecting…" while nothing is happening is the failure mode this reporting exists to
      // prevent.
      const reason = error instanceof Error ? error.message : String(error);
      this.host.report({ phase: 'failed', reason, cause: error });
      throw error;
    }
  }

  /** Closes the session. */
  public stop(): void {
    this.release();
    this.host.report({ phase: 'idle' });
  }

  private release(): void {
    this.handAbort?.abort();
    this.handAbort = null;
    this.stopClosed?.();
    this.stopClosed = null;
    this.stopServing?.();
    this.stopServing = null;
    this.tunnel?.close();
    this.tunnel = null;
  }

  /** Whether a tunnel is open. */
  public get isReady(): boolean {
    return this.tunnel !== null && this.tunnel.isEstablished;
  }

  /**
   * The live tunnel, for a caller that needs to talk to the daemon itself.
   *
   * The page's control panel is such a caller: it asks the daemon for status and lifecycle
   * over the same tunnel that carries DSH's traffic. Returning the tunnel rather than a
   * `ControlClient` keeps this module from having to know what a control plane is.
   *
   * A *getter* rather than a stored reference on the host: the tunnel is replaced on reconnect,
   * and a caller that captured the old one would keep talking into a closed socket.
   */
  public get liveTunnel(): Tunnel | null {
    return this.tunnel;
  }
}

/** The browser bridge surface, kept small so controller replacement can be exercised. */
export interface WorkerBridgeContainer {
  readonly controller: { postMessage(message: unknown, transfer: Transferable[]): void } | null;
  addEventListener(type: 'controllerchange' | 'message', listener: EventListener): void;
  removeEventListener(type: 'controllerchange' | 'message', listener: EventListener): void;
}

/** Waits for route registration, and repeats the handoff when a new worker takes control. */
export async function handWorkerView(
  container: WorkerBridgeContainer,
  viewId: string,
  serve: (port: MessagePort) => () => void,
  onReady: () => void = () => {},
  onFailure: (error: Error) => void = () => {},
  signal?: AbortSignal,
): Promise<() => void> {
  let stopped = false;
  let initialReady = false;
  let releaseCurrent = () => {};
  let accept!: () => void;
  let refuse!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { accept = resolve; refuse = reject; });
  const fail = (error: Error) => {
    releaseCurrent();
    if (initialReady) onFailure(error);
    else refuse(error);
  };
  const hand = () => {
    if (stopped) return;
    releaseCurrent();
    const controller = container.controller;
    if (!controller) { fail(new Error('the service worker stopped controlling this page; reload and reconnect')); return; }
    const channel = new MessageChannel();
    let active = true;
    const timer = setTimeout(() => fail(new Error('the service worker did not confirm the interface route; reload and reconnect')), 10_000);
    const acknowledgement = (event: MessageEvent) => {
      if (!active) return;
      const message = event.data as { kind?: string; viewId?: string; reason?: string } | null;
      if (message?.kind === 'failed') { fail(new Error(message.reason ?? 'the interface route could not be connected')); return; }
      if (message?.kind !== 'handed' || message.viewId !== viewId) return;
      clearTimeout(timer);
      channel.port1.removeEventListener('message', acknowledgement);
      initialReady = true;
      onReady();
      accept();
    };
    channel.port1.addEventListener('message', acknowledgement);
    let stopServing: (() => void) | undefined;
    releaseCurrent = () => {
      if (!active) return;
      active = false;
      clearTimeout(timer);
      channel.port1.removeEventListener('message', acknowledgement);
      // Closing a MessagePort does not reject fetches waiting in the old worker.
      // Tell the controller that owns this handoff before releasing its channel.
      try { controller.postMessage({ kind: 'unhand', viewId }, []); }
      catch { /* A controller that has already exited cannot retain a live route. */ }
      stopServing?.();
      channel.port1.close();
      channel.port2.close();
    };
    try {
      stopServing = serve(channel.port1);
      channel.port1.start();
      controller.postMessage({ kind: 'hand', viewId }, [channel.port2]);
    } catch (error) {
      fail(error instanceof Error ? error : new Error('the interface route could not be connected'));
    }
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    container.removeEventListener('controllerchange', hand);
    container.removeEventListener('message', restore);
    signal?.removeEventListener('abort', aborted);
    releaseCurrent();
  };
  const aborted = () => {
    stop();
    if (!initialReady) refuse(new Error('the connection ended before the interface route was ready'));
  };
  const restore = (event: Event) => {
    const message = event as MessageEvent;
    if (message.source === container.controller && message.data?.kind === 'restore-views') hand();
  };
  container.addEventListener('controllerchange', hand);
  container.addEventListener('message', restore);
  signal?.addEventListener('abort', aborted, { once: true });
  if (signal?.aborted) aborted();
  else hand();
  try { await ready; }
  catch (error) { stop(); throw error; }
  return stop;
}

/**
 * Decodes a room key from unpadded base64url.
 *
 * @param encoded - the key as the user pasted it.
 * @returns the 32 raw bytes.
 * @throws Error when the value is not a room key, naming what was wrong: a paste that lost
 * a character is the likeliest failure, and "invalid key" would not say so.
 */
export function decodeRoomKey(encoded: string): Uint8Array<ArrayBuffer> {
  const trimmed = encoded.trim().replaceAll('-', '+').replaceAll('_', '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(trimmed)) {
    throw new LocalizedError(() => t('error.roomKeyEncoding'));
  }
  const padded = trimmed + '='.repeat((4 - (trimmed.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new LocalizedError(() => t('error.roomKeyEncoding'));
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (bytes.length !== 32) {
    throw new LocalizedError(() => t('error.roomKeyLength', { length: bytes.length }));
  }
  return bytes;
}

/** Wait briefly for a newly paired daemon, without retrying an authentication or busy-room refusal. */
export async function openRelaySocket(url: URL, room: string, waitForDaemon = false): Promise<TunnelSocket> {
  const deadline = Date.now() + (waitForDaemon ? 5_000 : 0);
  for (;;) {
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    const connected = await new Promise<TunnelSocket | null>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        socket.removeEventListener('message', onMessage);
        socket.removeEventListener('error', onError);
        socket.removeEventListener('close', onClose);
      };
      const fail = (error: Error): void => { cleanup(); socket.close(); reject(error); };
      const onError = (): void => fail(new LocalizedError(() => t('error.relayUnreachable')));
      const onClose = (): void => fail(new LocalizedError(() => t('error.relayHandshake')));
      const timer = setTimeout(onClose, 10_000);
      const onMessage = (event: MessageEvent): void => {
        if (typeof event.data !== 'string') return;
        let reply: { type?: string; reason?: string };
        try { reply = JSON.parse(event.data) as typeof reply; }
        catch { onClose(); return; }
        if (reply?.type !== 'ready') {
          // Retry only the relay's explicit empty-room response after a fresh pairing.
          // A busy room, device refusal or failed encrypted handshake must remain visible.
          if (reply?.type === 'reject' && reply.reason === 'no daemon is serving this room' && Date.now() < deadline) {
            cleanup(); socket.close(); resolve(null); return;
          }
          fail(new LocalizedError(() => t('error.relayRefused', { reason: reply?.reason ?? t('error.noReason') })));
          return;
        }
        cleanup();
        resolve({
          send: data => socket.send(data),
          receive(handler) {
            socket.addEventListener('message', event => {
              if (typeof event.data !== 'string') handler(new Uint8Array(event.data as ArrayBuffer));
            });
          },
          closed(handler) { socket.addEventListener('close', () => handler('the relay closed the connection')); },
          close: () => socket.close(),
        });
      };
      socket.addEventListener('error', onError, { once: true });
      socket.addEventListener('close', onClose, { once: true });
      socket.addEventListener('message', onMessage);
      socket.addEventListener('open', () => socket.send(JSON.stringify({ role: 'client', room, proto: [0, 1] })), { once: true });
    });
    if (connected !== null) return connected;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

/** Connect the page's encrypted tunnel and bind its isolated route to the browser's service worker. */
export async function connect(
  options: SessionOptions,
  hooks: {
    readonly report: (phase: SessionPhase) => void;
    /**
     * Called with the live tunnel once it is established.
     *
     * Handed over rather than returned because the session keeps owning it: the caller must not
     * be able to close what the service worker is still serving through.
     */
    readonly onTunnel?: (tunnel: Tunnel, viewId: string) => void;
    /** Rebind the embedded document after a worker upgrade has accepted its parent. */
    readonly onWorkerReady?: (viewId: string) => void;
  },
): Promise<string> {
  const viewId = crypto.randomUUID();
  const session = new Session({
    async connect(room) {
      const url = new URL('/ws/client', location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return await openRelaySocket(url, room, options.waitForDaemon);
    },
    async prepareWorker() {
      if (!('serviceWorker' in navigator)) {
        throw new LocalizedError(() => t('error.workerUnsupported'));
      }
      // `type: 'module'`, because the worker imports its collaborators rather than inlining
      // them. Registered as a classic worker it fails to evaluate — the registration is refused
      // with "ServiceWorker script evaluation failed" and the interface never loads. The relay
      // separately grants the root scope, which a worker under `/client/` does not get by
      // default. Neither failure is visible without a browser.
      await navigator.serviceWorker.register('/client/service-worker.js', {
        scope: '/',
        type: 'module',
      });
      // Registered is not the same as controlling: until the worker controls this page it
      // cannot intercept the navigation that opens the interface.
      const registration = await navigator.serviceWorker.ready;
      if (navigator.serviceWorker.controller === null) {
        await new Promise<void>(resolve => {
          navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
            once: true,
          });
        });
      }
      void registration;
    },
    hand(serve, signal) {
      return handWorkerView(navigator.serviceWorker, viewId, serve, () => hooks.onWorkerReady?.(viewId), error => {
        session.stop();
        hooks.report({ phase: 'failed', reason: error.message, cause: error });
      }, signal);
    },
    report: hooks.report,
  });
  const room = await session.start(options);
  const tunnel = session.liveTunnel;
  if (tunnel !== null) hooks.onTunnel?.(tunnel, viewId);
  return room;
}
