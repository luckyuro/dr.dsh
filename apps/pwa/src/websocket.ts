/**
 * A `WebSocket` that travels through the tunnel.
 *
 * ## Why this exists
 *
 * A service worker **cannot** intercept a WebSocket upgrade. Its `fetch` handler never sees the
 * request, and `respondWith` cannot synthesise the `101` that upgrades a connection, so a page
 * served through a tunnel opens its sockets directly against the relay — which fails, and does so
 * silently as far as the interface is concerned. DSH's own interface keeps one mux socket open
 * for live updates, so the rendered page sat on `Reconnecting…` with no HTTP error anywhere.
 *
 * The daemon has been able to carry sockets since M0: the proxy plane has
 * `WsOpen`/`WsOpened`/`WsData`/`WsClose` and opens the upstream connection itself, against its own
 * loopback origin. What was missing was this side. A page replaces its own `WebSocket` with this
 * class, and the interface's `new WebSocket(url)` becomes a tunnel request it never knows about.
 *
 * ## What it deliberately is not
 *
 * It is not a WebSocket implementation: it does not parse frames, and it does not do the opening
 * handshake. Both ends' real WebSocket stacks do that — the page's, one layer down, and DSH's, one
 * layer up. What crosses the tunnel is *messages*, so ping/pong and continuation frames stay where
 * they belong and two layers cannot both try to manage one connection's liveness.
 *
 * @module @dr.dsh/pwa/websocket
 */

import { decodeMessage, encodeWsData, encodeWsOpen } from './proxy.ts';

/** The slice of a tunnel this adapter needs, so it can be tested without one. */
export interface SocketTunnel {
  /**
   * Sends one proxy message on a stream.
   *
   * @param streamId - the stream to use; one per socket.
   * @param payload - the encoded message.
   */
  send(streamId: number, payload: Uint8Array<ArrayBuffer>): Promise<void>;
  /**
   * Subscribes to one stream.
   *
   * @param streamId - the stream to watch.
   * @param handler - called for each payload.
   * @returns a function that unsubscribes.
   */
  on(streamId: number, handler: (payload: Uint8Array<ArrayBuffer>) => void): () => void;
}

/** The WebSocket states, matching the platform's numbering. */
const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/** The shape the interface uses. Kept structural so this does not have to extend the DOM type. */
export interface WebSocketLike {
  /** Ready state, as the platform defines it. */
  readonly readyState: number;
  /** Whether the socket is open. */
  readonly isOpen: boolean;
  /** Sends a message. */
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  /** Closes the socket. */
  close(code?: number, reason?: string): void;
}

/**
 * Builds the client's replacement `WebSocket` bound to one tunnel.
 *
 * The returned value is a class so it can be assigned to `window.WebSocket`; it keeps the
 * platform's constructor shape (`new WebSocket(url, protocols?)`) because code that constructs one
 * is not code this project can change.
 *
 * @param tunnel - where the socket's traffic should travel.
 * @param nextStream - allocates a stream per socket. A function rather than a counter so the
 * caller keeps ownership of stream ids across everything else that uses them.
 * @returns a constructor with the shape of `WebSocket`.
 */
export function tunneledWebSocket(
  tunnel: SocketTunnel,
  nextStream: () => number,
): new (url: string, protocols?: string | string[]) => WebSocketLike {
  return class TunneledWebSocket implements WebSocketLike {
    public readyState = CONNECTING;
    /** Handlers, as the platform's own properties. */
    public onopen: ((event: unknown) => void) | null = null;
    public onmessage: ((event: { data: unknown }) => void) | null = null;
    public onclose: ((event: { code: number; reason: string }) => void) | null = null;
    public onerror: ((event: unknown) => void) | null = null;

    private readonly streamId: number;
    private readonly id: number;
    private unsubscribe: (() => void) | null = null;
    private pending: string[] = [];

    public constructor(url: string, _protocols?: string | string[]) {
      this.streamId = nextStream();
      this.id = this.streamId;

      // Only the path crosses the tunnel. The authority is the daemon's to choose — it always
      // chooses its own loopback origin — and letting a page name a host is the one thing the
      // proxy plane refuses outright.
      const parsed = new URL(url, 'http://localhost');
      const target = `${parsed.pathname}${parsed.search}`;

      this.unsubscribe = tunnel.on(this.streamId, payload => this.absorb(payload));
      void this.open(target);
    }

    /** Sends the upgrade request and waits for the daemon's answer. */
    private async open(target: string): Promise<void> {
      const encoded = encodeWsOpen(this.id, target);
      try {
        await tunnel.send(this.streamId, encoded);
      } catch (error) {
        this.finish(1006, (error as Error).message);
      }
    }

    /** Routes one proxied message. */
    private absorb(payload: Uint8Array<ArrayBuffer>): void {
      const message = decodeMessage(payload);
      if (message === undefined) return;
      switch (message.kind) {
        case 'wsOpened':
          if (message.status === 101) {
            this.readyState = OPEN;
            this.onopen?.({});
            for (const queued of this.pending) this.sendNow(queued);
            this.pending = [];
          } else {
            this.finish(1006, `the daemon answered ${message.status} for the upgrade`);
          }
          return;
        case 'wsData': {
          const frame = message.frame;
          if (frame.kind === 'close') {
            this.finish(1000, '');
            return;
          }
          this.onmessage?.({ data: frame.text });
          return;
        }
        case 'failure':
          this.finish(1006, message.reason);
          return;
        default:
          return;
      }
    }

    /** Sends one message, assuming the socket is open. */
    private sendNow(data: string): void {
      void tunnel.send(this.streamId, encodeWsData(this.id, { kind: 'text', text: data }));
    }

    public send(data: string | ArrayBufferLike | ArrayBufferView): void {
      if (this.readyState === CONNECTING) {
        // The platform throws here; queuing would be kinder and would silently change when a
        // message is sent. The interface sends only after `onopen`, so throwing is the honest
        // behaviour and it matches what callers already handle.
        throw new Error('the WebSocket is not open yet');
      }
      if (this.readyState !== OPEN) {
        throw new Error('the WebSocket is closing or closed');
      }
      if (typeof data !== 'string') {
        // Binary frames are supported by the protocol and not by this adapter yet: DSH's
        // interface exchanges JSON. Saying so beats sending something that looks like text.
        throw new Error('binary WebSocket frames are not carried by this client yet');
      }
      this.sendNow(data);
    }

    public close(_code?: number, _reason?: string): void {
      if (this.readyState === CLOSED) return;
      this.readyState = CLOSING;
      void tunnel.send(this.streamId, encodeWsData(this.id, { kind: 'close' }));
      this.finish(1000, '');
    }

    /** Ends the socket once. */
    private finish(code: number, reason: string): void {
      if (this.readyState === CLOSED) return;
      this.readyState = CLOSED;
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.onclose?.({ code, reason });
    }

    /** Whether the socket is open, as the platform exposes it. */
    public get isOpen(): boolean {
      return this.readyState === OPEN;
    }
  };
}
