/**
 * The client half of the proxy plane: asking the daemon for a DSH route, and assembling
 * the answer.
 *
 * The daemon performs the request; the client's job is to encode what it wants and to
 * reassemble a streamed response. Both halves are pure functions over `Uint8Array`, which
 * is what makes them testable outside a browser — the page and the service worker only
 * supply the tunnel.
 *
 * ## Why it is not just a `fetch`
 *
 * The response arrives as a sequence of messages on one carrier stream: a head, then any
 * number of body chunks, then an end. A client that treated the head as the whole answer
 * would show a page with no content; one that ignored the end would wait forever. The
 * collector below is written as an explicit state machine so both mistakes are impossible
 * to make by accident.
 *
 * @module @dr.dsh/pwa/proxy
 */

import { type Tunnel, TunnelError } from './tunnel.ts';

/** Message tags, matching `crates/dr-dsh-daemon/src/proxy/message.rs`. */
const TAG = {
  requestStart: 1,
  requestBody: 2,
  requestEnd: 3,
  responseStart: 4,
  responseBody: 5,
  responseEnd: 6,
  failure: 7,
  wsOpen: 8,
  wsOpened: 9,
  wsData: 10,
  wsClose: 11,
} as const;

/** The proxy message format's prefix. */
const MAGIC = [0x50, 0x58];

/** The format version this client speaks. */
const VERSION = 1;

/** A response head as the daemon reports it. */
export interface ResponseHead {
  /** The id of the request this answers. */
  readonly id: number;
  /** HTTP status. */
  readonly status: number;
  /** Response headers, lowercased names. */
  readonly headers: ReadonlyMap<string, string>;
}

/** A complete response. */
export interface Response {
  /** Status and headers. */
  readonly head: ResponseHead;
  /** The assembled body. */
  readonly body: Uint8Array<ArrayBuffer>;
}

/**
 * Encodes a request for the daemon.
 *
 * The target must be origin-form: the daemon refuses anything that names a host, because
 * the host is its decision, not the client's. Refusing here as well means a mistake
 * surfaces at the call site instead of as a refused request after a round trip.
 *
 * @param id - correlation id, echoed on the response.
 * @param method - HTTP method.
 * @param target - origin-form path and query.
 * @param options - optional headers and body.
 * @returns the encoded request, ready to send on a stream.
 * @throws TunnelError when the target is not origin-form.
 */
export function encodeRequest(
  id: number,
  method: string,
  target: string,
  options: { headers?: readonly (readonly [string, string])[]; body?: Uint8Array<ArrayBuffer> } = {},
): Uint8Array<ArrayBuffer> {
  if (!target.startsWith('/') || target.startsWith('//') || target.includes('..')) {
    throw new TunnelError(`the target must be an origin-form path, got ${JSON.stringify(target)}`);
  }
  const parts: Uint8Array<ArrayBuffer>[] = [
    new Uint8Array([...MAGIC, VERSION, TAG.requestStart]),
    u64(id),
    bytes(method),
    bytes(target),
  ];

  const headers = [...(options.headers ?? [])];
  const body = options.body ?? new Uint8Array(0);
  if (body.length > 0 && !headers.some(([name]) => name.toLowerCase() === 'content-length')) {
    headers.push(['content-length', String(body.length)]);
  }
  const headerCount = new Uint8Array(2);
  new DataView(headerCount.buffer).setUint16(0, headers.length, false);
  parts.push(headerCount);
  for (const [name, value] of headers) parts.push(bytes(name), bytes(value));
  parts.push(bytesFrom(body));

  return concat(parts);
}

/**
 * Encodes a request to upgrade a stream to a WebSocket.
 *
 * The upgrade is a message of its own rather than an HTTP request with an `upgrade` header: the
 * daemon opens the connection against its own loopback origin and then carries *messages*, so
 * expressing the upgrade as a request would blur the line the daemon needs to route on.
 *
 * @param id - correlation id, echoed on the answer.
 * @param target - origin-form path to upgrade.
 * @param headers - handshake headers to forward.
 */
export function encodeWsOpen(
  id: number,
  target: string,
  headers: readonly (readonly [string, string])[] = [],
): Uint8Array<ArrayBuffer> {
  if (!target.startsWith('/') || target.startsWith('//') || target.includes('..')) {
    throw new TunnelError(`the target must be an origin-form path, got ${JSON.stringify(target)}`);
  }
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, headers.length, false);
  const parts: Uint8Array<ArrayBuffer>[] = [
    new Uint8Array([...MAGIC, VERSION, TAG.wsOpen]),
    u64(id),
    bytes(target),
    count,
  ];
  for (const [name, value] of headers) parts.push(bytes(name), bytes(value));
  return concat(parts);
}

/**
 * Encodes one WebSocket message.
 *
 * @param id - the socket's correlation id.
 * @param frame - the message, as the proxy plane describes it.
 */
export function encodeWsData(
  id: number,
  frame: { readonly kind: 'text'; readonly text: string } | { readonly kind: 'close' },
): Uint8Array<ArrayBuffer> {
  // A kind byte, then the payload for a text frame and nothing at all for a close. The daemon's
  // decoder reads the kind first and treats an absent payload as the end of the connection, so a
  // close is three bytes shorter rather than a zero-length string.
  const kind = frame.kind === 'text' ? 1 : 3;
  const body = frame.kind === 'text' ? bytes(frame.text) : new Uint8Array(0);
  return concat([new Uint8Array([...MAGIC, VERSION, TAG.wsData]), u64(id), new Uint8Array([kind]), body]);
}

/**
 * Decodes one message from the daemon.
 *
 * @param payload - the payload of one carrier frame.
 * @returns the message, or `undefined` when it is not a proxy message at all.
 * @throws TunnelError when it claims to be one but is malformed.
 */
export function decodeMessage(payload: Uint8Array<ArrayBuffer>): ProxyInbound | undefined {
  if (payload.length < 4 || payload[0] !== MAGIC[0] || payload[1] !== MAGIC[1]) return undefined;
  if (payload[2] !== VERSION) {
    throw new TunnelError(`the daemon speaks proxy message version ${payload[2]}, this client speaks ${VERSION}`);
  }
  const reader = new Reader(payload, 4);
  switch (payload[3]) {
    case TAG.responseStart: {
      const id = reader.u64();
      const status = reader.u16();
      return { kind: 'responseStart', id, status, headers: reader.headers() };
    }
    case TAG.responseBody:
      return { kind: 'responseBody', chunk: reader.chunk() };
    case TAG.responseEnd:
      return { kind: 'responseEnd' };
    case TAG.failure: {
      const id = reader.u64();
      return { kind: 'failure', id, reason: reader.text() };
    }
    case TAG.wsOpened: {
      const id = reader.u64();
      const status = reader.u16();
      return { kind: 'wsOpened', id, status, headers: reader.headers() };
    }
    case TAG.wsData: {
      const id = reader.u64();
      const kind = reader.u8();
      // The daemon's frame kinds: text, binary, close. Binary is carried by the protocol and not
      // by this client yet, so it is reported as a failure rather than silently as text.
      if (kind === 1) return { kind: 'wsData', id, frame: { kind: 'text', text: reader.text() } };
      if (kind === 2) {
        throw new TunnelError('the daemon sent a binary WebSocket frame, which this client cannot carry yet');
      }
      return { kind: 'wsData', id, frame: { kind: 'close' } };
    }
    default:
      throw new TunnelError(`unknown proxy message type ${payload[3]}`);
  }
}

/** What the daemon can send on a proxied stream. */
export type ProxyInbound =
  | { readonly kind: 'responseStart'; readonly id: number; readonly status: number; readonly headers: ReadonlyMap<string, string> }
  | { readonly kind: 'responseBody'; readonly chunk: Uint8Array<ArrayBuffer> }
  | { readonly kind: 'responseEnd' }
  | { readonly kind: 'failure'; readonly id: number; readonly reason: string }
  | { readonly kind: 'wsOpened'; readonly id: number; readonly status: number; readonly headers: ReadonlyMap<string, string> }
  | {
      readonly kind: 'wsData';
      readonly id: number;
      readonly frame: { readonly kind: 'text'; readonly text: string } | { readonly kind: 'close' };
    };

/**
 * Collects a streamed response into one value.
 *
 * Holds the state a hand-written loop gets wrong: which head belongs to which id, that
 * chunks may arrive in any number (including none), and that `failure` ends the exchange
 * just as much as `responseEnd` does.
 */
export class ResponseCollector {
  private readonly chunks: Uint8Array<ArrayBuffer>[] = [];
  private head: ResponseHead | null = null;
  private failure: string | null = null;
  private ended = false;
  /**
   * The finished response, once it exists.
   *
   * Kept rather than only handed to a waiting promise, because a fast daemon answers before
   * the caller awaits: without this the response is assembled, nobody is listening, and
   * `response()` waits forever on an exchange that has already finished. That failure looks
   * exactly like a hung request.
   */
  private settled: Response | null = null;
  private resolve: ((response: Response) => void) | null = null;
  private reject: ((error: Error) => void) | null = null;

  /**
   * Feeds one decoded message.
   *
   * @param message - the message to absorb.
   * @throws TunnelError when the stream ends before a response head arrives, which means
   * the daemon answered a different request on this stream.
   */
  public absorb(message: ProxyInbound): void {
    switch (message.kind) {
      case 'responseStart':
        this.head = { id: message.id, status: message.status, headers: message.headers };
        return;
      case 'responseBody':
        if (this.head === null) {
          throw new TunnelError('a response body arrived before its head');
        }
        this.chunks.push(message.chunk);
        return;
      case 'responseEnd':
        if (this.head === null) {
          throw new TunnelError('a response ended before its head arrived');
        }
        this.ended = true;
        this.settled = { head: this.head, body: concat(this.chunks) };
        this.resolve?.(this.settled);
        return;
      case 'failure':
        this.failure = message.reason;
        this.reject?.(new TunnelError(message.reason));
        return;
      default:
        return;
    }
  }

  /** Whether the exchange is over, for either reason. */
  public get isComplete(): boolean {
    return this.ended || this.failure !== null;
  }

  /** The failure that ended the exchange, if one did. */
  public get error(): string | null {
    return this.failure;
  }

  /**
   * Waits for the response.
   *
   * @returns the assembled response.
   * @throws TunnelError when the daemon reported a failure.
   */
  public async response(): Promise<Response> {
    if (this.settled !== null) return this.settled;
    if (this.failure !== null) throw new TunnelError(this.failure);
    return new Promise<Response>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

/**
 * Performs one proxied request over a tunnel and returns the response.
 *
 * @param tunnel - the established tunnel.
 * @param streamId - the stream to use; one per in-flight request, which is what lets two
 * requests overlap without their responses being interleaved into one another.
 * @param request - the encoded request.
 * @returns the assembled response.
 * @throws TunnelError when the daemon refuses the request.
 */
export async function request(
  tunnel: Tunnel,
  streamId: number,
  encoded: Uint8Array<ArrayBuffer>,
): Promise<Response> {
  const collector = new ResponseCollector();
  const stop = tunnel.on(streamId, payload => {
    const message = decodeMessage(payload);
    if (message !== undefined) collector.absorb(message);
  });
  try {
    await tunnel.send(streamId, encoded);
    return await collector.response();
  } finally {
    stop();
  }
}

/** A bounds-checked reader over a message payload. */
class Reader {
  private readonly source: Uint8Array<ArrayBuffer>;
  private at: number;

  public constructor(bytes: Uint8Array<ArrayBuffer>, at: number) {
    this.source = bytes;
    this.at = at;
  }

  public u8(): number {
    const value = this.source[this.at] ?? 0;
    this.at += 1;
    return value;
  }

  public u16(): number {
    const value = new DataView(this.source.buffer, this.source.byteOffset + this.at, 2).getUint16(0, false);
    this.at += 2;
    return value;
  }

  public u64(): number {
    const value = Number(
      new DataView(this.source.buffer, this.source.byteOffset + this.at, 8).getBigUint64(0, false),
    );
    this.at += 8;
    return value;
  }

  public chunk(): Uint8Array<ArrayBuffer> {
    const length = new DataView(this.source.buffer, this.source.byteOffset + this.at, 4).getUint32(0, false);
    this.at += 4;
    if (this.at + length > this.source.length) {
      throw new TunnelError('a proxy message is shorter than it declares');
    }
    const slice = this.source.slice(this.at, this.at + length);
    this.at += length;
    return slice;
  }

  public text(): string {
    return new TextDecoder().decode(this.chunk());
  }

  public headers(): ReadonlyMap<string, string> {
    const count = this.u16();
    const headers = new Map<string, string>();
    for (let index = 0; index < count; index += 1) {
      const name = this.text().toLowerCase();
      headers.set(name, this.text());
    }
    return headers;
  }
}

/** Encodes a big-endian `u64` as eight bytes. */
function u64(value: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), false);
  return out;
}

/** Encodes text with a `u32` length prefix. */
function bytes(text: string): Uint8Array<ArrayBuffer> {
  return bytesFrom(new TextEncoder().encode(text));
}

/** Prefixes bytes with their `u32` length. */
function bytesFrom(value: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(4 + value.length);
  new DataView(out.buffer).setUint32(0, value.length, false);
  out.set(value, 4);
  return out;
}

/** Concatenates byte arrays. */
function concat(parts: readonly Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
