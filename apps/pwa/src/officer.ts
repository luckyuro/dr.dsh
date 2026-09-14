/**
 * The page's half of the worker handoff: the tunnel, answering the worker's requests.
 *
 * The worker cannot reach DSH and cannot see the page's socket, so the page lends it both
 * over a `MessageChannel`: the worker sends a request, this side performs it through the
 * tunnel using `proxy.ts`, and the answer goes back as a message.
 *
 * ## Why the page keeps the tunnel instead of transferring it
 *
 * A `MessagePort` can carry a tunnel only if the tunnel lives over a port, which it does
 * not: it seals and frames bytes itself (`tunnel.ts`). So the page holds the tunnel and
 * serves the worker, which is also what lets one tunnel back every request the interface
 * makes without the worker knowing what a stream is.
 *
 * @module @dr.dsh/pwa/officer
 */

import { encodeRequest, request } from './proxy.ts';
import type { Tunnel } from './tunnel.ts';

/** The messages the page sends to the worker. */
export interface OfficerReply {
  /** `response` or `failed`. */
  readonly kind: 'response' | 'failed';
  /** The request this answers. */
  readonly id: number;
  /** HTTP status, on a response. */
  readonly status?: number;
  /** Response headers, on a response. */
  readonly headers?: readonly (readonly [string, string])[];
  /** Response body, on a response. */
  readonly body?: ArrayBuffer;
  /** Why the request failed, on a failure. */
  readonly reason?: string;
}

/** A request as the worker sends it. */
export interface OfficerRequest {
  /** Correlation id. */
  readonly id: number;
  /** HTTP method. */
  readonly method: string;
  /** Origin-form path and query. */
  readonly path: string;
  /** Request headers. */
  readonly headers: readonly (readonly [string, string])[];
  /** The request body. */
  readonly body: ArrayBuffer;
}

/**
 * Serves a worker's requests through a tunnel until the port closes.
 *
 * One stream per request, allocated from a counter: two requests in flight must not share a
 * stream, or their responses would interleave into one another.
 *
 * @param tunnel - the established tunnel.
 * @param port - the port the worker is listening on.
 * @returns a function that stops serving.
 */
export function serveWorker(tunnel: Tunnel, port: MessagePort): () => void {
  let nextStream = 1;
  let stopped = false;

  const onMessage = (event: MessageEvent): void => {
    const message = event.data as { kind?: string };
    if (message.kind !== 'request') return;
    const incoming = event.data as OfficerRequest;
    const streamId = nextStream;
    nextStream += 1;

    void (async (): Promise<void> => {
      try {
        const encoded = encodeRequest(incoming.id, incoming.method, incoming.path, {
          headers: incoming.headers,
          body: new Uint8Array(incoming.body),
        });
        const answer = await request(tunnel, streamId, encoded);
        post(port, {
          kind: 'response',
          id: incoming.id,
          status: answer.head.status,
          headers: [...answer.head.headers],
          // `slice()` rather than the view itself: the body has to be copied to be
          // transferable, and a view into a larger buffer would send that buffer.
          body: answer.body.slice().buffer,
        });
      } catch (error) {
        post(port, {
          kind: 'failed',
          id: incoming.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  };

  port.addEventListener('message', onMessage);
  port.start();

  return () => {
    if (stopped) return;
    stopped = true;
    port.removeEventListener('message', onMessage);
    port.close();
  };
}

/** Posts a reply, ignoring a port that has already closed. */
function post(port: MessagePort, reply: OfficerReply): void {
  try {
    port.postMessage(reply);
  } catch {
    // The worker went away between the request and its answer. Nothing to do and nowhere to
    // report it: the page is closing.
  }
}
