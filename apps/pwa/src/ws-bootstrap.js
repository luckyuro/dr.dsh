/**
 * Replaces the interface page's `WebSocket` with one that travels through the tunnel.
 *
 * ## Why this is a separate page script, and why a channel
 *
 * A service worker cannot intercept a WebSocket upgrade, so DSH's own mux socket used to go
 * straight at the relay and fail silently — the rendered interface sat on `Reconnecting…`. The fix
 * has to replace `window.WebSocket` **before** DSH's scripts run, which means a script in the
 * interface document itself.
 *
 * The parent shell owns the tunnel. Each embedded document transfers it one private MessagePort;
 * the parent accepts only the expected origin, iframe window and view id. A same-origin tab has
 * no shared channel on which it can hear or inject another computer's socket messages.
 *
 * ## What is deliberately not here
 *
 * It does not import DSH or interpret its page. It only wires the document's HTTP route and
 * WebSocket transport; the interface remains DSH's application.
 *
 * Plain JavaScript, served from the client directory, for the same reason `shell.js` is: the
 * relay serves modules, and a script that has to run before a page's own modules cannot be part of
 * their build order.
 */

(() => {
const NativeWebSocket = globalThis.WebSocket;
const viewId = document.currentScript?.dataset.drdshView ?? new URL(location.href).searchParams.get('drdshView');
const handlers = new Map();
let nextId = 1;
let disposed = false;
let workerBinding = 0;
const pair = new MessageChannel();
const channel = pair.port1;
const deadline = setTimeout(() => {
  for (const handler of [...handlers.values()]) handler({ kind: 'closed', code: 1006, reason: 'The connection page did not attach this interface. Return to dr.dsh and reconnect.' });
}, 15_000);

// A restarted worker has forgotten its client routes. Rebind this exact document after both
// its controller changes and the parent confirms that its tunnel route has been restored.
function bindWorker() {
  const worker = navigator.serviceWorker?.controller;
  if (!worker || !viewId || disposed) return;
  globalThis.__DSH_REMOTE_WS__.workerBound = false;
  const generation = ++workerBinding;
  const binding = new MessageChannel();
  const timeout = setTimeout(() => binding.port1.close(), 5_000);
  binding.port1.onmessage = event => {
    clearTimeout(timeout);
    binding.port1.close();
    if (generation !== workerBinding || disposed) return;
    // A failed bind can race the parent's handoff; worker-ready retries it without guessing.
    if (event.data?.kind === 'bound') globalThis.__DSH_REMOTE_WS__.workerBound = true;
  };
  worker.postMessage({ kind: 'bind-view', viewId }, [binding.port2]);
}
channel.onmessage = event => {
  const message = event.data;
  if (message === null || typeof message !== 'object' || disposed) return;
  if (message.kind === 'worker-ready') {
    clearTimeout(deadline);
    bindWorker();
    return;
  }
  handlers.get(message.id)?.(message);
};
channel.start();

/**
 * A `WebSocket` whose traffic travels through the tunnel.
 *
 * Shaped like the platform's: applications construct it, assign `onopen`/`onmessage`/`onclose`,
 * and call `send`/`close`. Nothing about the substitution is visible to them, which is the point —
 * DSH's interface cannot be asked to know it is being tunnelled.
 */
class TunneledWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url, protocols) {
    super();
    this.url = String(url);
    this.readyState = TunneledWebSocket.CONNECTING;
    this.binaryType = 'blob';
    this.id = nextId;
    nextId += 1;

    // `onopen` and friends are **accessors that register a real listener**, not fields that the
    // dispatch below pokes by hand. The platform's `WebSocket` supports both styles, and so must
    // this: DSH's own stream client uses `addEventListener('open', …)` and
    // `addEventListener('message', …)`, so a shim that only called `onopen` left the interface's
    // multiplexed socket permanently `CONNECTING` — every live feature (the workspace list, the
    // session list, a turn's output) waited forever, and the page looked merely slow rather than
    // broken. It was found by driving the interface in a browser, and it is the reason
    // `browser-task-smoke.mjs` now checks the mux with `addEventListener` rather than `onopen`.
    this.handlers = Object.create(null);
    for (const type of ['open', 'message', 'close', 'error']) {
      Object.defineProperty(this, `on${type}`, {
        configurable: true,
        get: () => this.handlers[type] ?? null,
        set: value => {
          const previous = this.handlers[type];
          if (previous !== undefined && previous !== null) {
            this.removeEventListener(type, previous);
          }
          this.handlers[type] = typeof value === 'function' ? value : null;
          if (this.handlers[type] !== null) this.addEventListener(type, this.handlers[type]);
        },
      });
    }

    handlers.set(this.id, message => this.absorb(message));
    // Only the path crosses: the daemon chooses the host, and a page naming one is the thing the
    // proxy plane refuses outright.
    const parsed = new URL(this.url, location.href);
    channel.postMessage({
      kind: 'open',
      id: this.id,
      target: `${parsed.pathname}${parsed.search}`,
      protocols: protocols ?? null,
    });
  }

  absorb(message) {
    switch (message.kind) {
      case 'opened':
        if (message.status === 101) {
          this.readyState = TunneledWebSocket.OPEN;
          // Dispatched, not called: one path serves `onopen` and `addEventListener` alike, which is
          // exactly the property the previous version lacked.
          this.dispatchEvent(new Event('open'));
        } else {
          this.finish(1006, `the daemon answered ${message.status}`);
        }
        return;
      case 'data':
        this.dispatchEvent(new MessageEvent('message', { data: message.text }));
        return;
      case 'closed':
        this.finish(message.code ?? 1006, message.reason ?? '');
        return;
      default:
    }
  }

  finish(code, reason) {
    if (this.readyState === TunneledWebSocket.CLOSED) return;
    this.readyState = TunneledWebSocket.CLOSED;
    handlers.delete(this.id);
    // `CloseEvent` where the platform has it, a plain event carrying the same fields where it does
    // not: a test runner is allowed to lack it, and the shape is what applications read.
    const event =
      typeof CloseEvent === 'function'
        ? new CloseEvent('close', { code, reason, wasClean: code === 1000 })
        : Object.assign(new Event('close'), { code, reason, wasClean: code === 1000 });
    this.dispatchEvent(event);
  }

  send(data) {
    if (this.readyState !== TunneledWebSocket.OPEN) {
      throw new Error('the WebSocket is not open');
    }
    if (typeof data !== 'string') {
      // Binary frames are carried by the protocol and not by this adapter yet. DSH's interface
      // exchanges JSON, so saying so beats sending something the far side would misread.
      throw new Error('binary WebSocket frames are not carried by this client yet');
    }
    channel.postMessage({ kind: 'send', id: this.id, text: data });
  }

  close() {
    if (this.readyState === TunneledWebSocket.CLOSED) return;
    this.readyState = TunneledWebSocket.CLOSING;
    channel.postMessage({ kind: 'close', id: this.id });
    this.finish(1000, '');
  }
}

globalThis.WebSocket = TunneledWebSocket;
globalThis.__DSH_REMOTE_WS__ = { transport: 'message-port', viewId, native: NativeWebSocket, workerBound: false };
navigator.serviceWorker?.addEventListener('controllerchange', bindWorker);
window.addEventListener('pagehide', () => {
  disposed = true;
  clearTimeout(deadline);
  navigator.serviceWorker?.removeEventListener('controllerchange', bindWorker);
  channel.postMessage({ kind: 'dispose' });
  channel.close();
  handlers.clear();
}, { once: true });
if (parent !== window && viewId) {
  parent.postMessage({ kind: 'drdsh-interface-connect', viewId }, location.origin, [pair.port2]);
  bindWorker();
} else {
  pair.port2.close();
}
})();
