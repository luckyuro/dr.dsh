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
  hand(serve: (port: MessagePort) => () => void): () => void;
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
      // The worker must control this page *before* it is handed a tunnel: otherwise the
      // first navigation to the DSH interface is not intercepted, and the browser shows
      // whatever the relay answers for that path instead of the interface.
      await this.host.prepareWorker();
      // The handoff starts serving from this moment: the worker's end goes to the worker,
      // and the page's end is answered here through the tunnel.
      this.stopServing = this.host.hand(port => serveWorker(tunnel, port));
      this.host.report({ phase: 'ready', room });
      return room;
    } catch (error) {
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
    this.stopServing?.();
    this.stopServing = null;
    this.tunnel?.close();
    this.tunnel = null;
    this.host.report({ phase: 'idle' });
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

/**
 * Connects the page's tunnel and hands it to the service worker.
 *
 * This is the function the shell calls, and it is the only place that touches browser
 * globals directly: everything it decides is delegated to `Session`, which takes those
 * globals as parameters so they can be replaced in a test.
 *
 * @param options - what the user typed, and the device this browser has stored.
 * @param hooks - how to report progress; the shell renders these phases.
 * @returns the room the tunnel parked on.
 */
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
    readonly onTunnel?: (tunnel: Tunnel) => void;
  },
): Promise<string> {
  const session = new Session({
    async connect(room) {
      const url = new URL('/ws/client', location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url);
      socket.binaryType = 'arraybuffer';
      return await new Promise<TunnelSocket>((resolve, reject) => {
        socket.addEventListener('error', () => reject(new LocalizedError(() => t('error.relayUnreachable'))), {
          once: true,
        });
        socket.addEventListener(
          'open',
          () => {
            socket.send(JSON.stringify({ role: 'client', room, proto: [0, 1] }));
          },
          { once: true },
        );
        // The relay's handshake reply is text and arrives before any carrier frame; the
        // tunnel takes over from the first binary one.
        const onMessage = (event: MessageEvent): void => {
          if (typeof event.data !== 'string') return;
          socket.removeEventListener('message', onMessage);
          const reply = JSON.parse(event.data) as { type?: string; reason?: string };
          if (reply.type !== 'ready') {
            reject(new LocalizedError(() => t('error.relayRefused', { reason: reply.reason ?? t('error.noReason') })));
            return;
          }
          resolve({
            send: data => socket.send(data),
            receive(handler) {
              socket.addEventListener('message', event => {
                if (typeof event.data !== 'string') handler(new Uint8Array(event.data as ArrayBuffer));
              });
            },
            closed(handler) {
              socket.addEventListener('close', () => handler('the relay closed the connection'));
            },
            close: () => socket.close(),
          });
        };
        socket.addEventListener('message', onMessage);
      });
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
    hand(serve) {
      // The transfer is what makes the worker able to intercept: it stores the port and
      // answers every intercepted request through it. The page's end is served here.
      const channel = new MessageChannel();
      const registration = navigator.serviceWorker.controller;
      if (registration === null) {
        throw new LocalizedError(() => t('error.workerControl'));
      }
      registration.postMessage({ kind: 'hand' }, [channel.port2]);
      return serve(channel.port1);
    },
    report: hooks.report,
  });
  const room = await session.start(options);
  const tunnel = session.liveTunnel;
  if (tunnel !== null) hooks.onTunnel?.(tunnel);
  return room;
}
