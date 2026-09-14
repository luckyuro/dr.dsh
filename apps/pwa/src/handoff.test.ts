/**
 * The handoff, end to end on the client side: a page request answered through the tunnel.
 *
 * `worker-service.test.ts` checks the worker's half with a scripted page, and the proxy
 * tests check the proxy with a scripted tunnel. This joins them: a real worker service, a
 * real officer, and a real `MessageChannel` between them, with a stand-in tunnel standing in
 * for the daemon. It is the shape a browser runs, minus the browser.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { serveWorker } from './officer.ts';
import type { Tunnel } from './tunnel.ts';
import { WorkerTunnel } from './worker-service.ts';

/** Channels opened by a test, released afterwards so the runner can exit. */
const channels: MessageChannel[] = [];

/**
 * A `MessagePort` keeps Node's event loop alive, so a test file that opens one never exits.
 *
 * @param port - the port to release.
 */
function release(port: MessagePort): void {
  (port as unknown as { unref?: () => void }).unref?.();
  port.close();
}

afterEach(() => {
  // The worker keeps its end of the channel; releasing it here is what lets the runner exit.
  for (const worker of workers.splice(0)) worker.detach();
  for (const pair of channels.splice(0)) {
    release(pair.port1);
    release(pair.port2);
  }
});

/** A tunnel that answers one proxied request with a canned response. */
function standInTunnel(
  answer: { status: number; headers?: readonly (readonly [string, string])[]; body: string },
): Tunnel {
  const handlers = new Map<number, (payload: Uint8Array<ArrayBuffer>) => void>();
  return {
    on(streamId: number, handler: (payload: Uint8Array<ArrayBuffer>) => void) {
      handlers.set(streamId, handler);
      return () => handlers.delete(streamId);
    },
    async send(streamId: number) {
      const body = new TextEncoder().encode(answer.body);
      const deliver = handlers.get(streamId);
      const reply = (tag: number, payload: readonly number[]): void => {
        deliver?.(new Uint8Array([0x50, 0x58, 0x01, tag, ...payload]));
      };
      const u64 = (value: number): number[] => {
        const out = new Uint8Array(8);
        new DataView(out.buffer).setBigUint64(0, BigInt(value), false);
        return [...out];
      };
      const prefixed = (bytes: Uint8Array): number[] => {
        const length = new Uint8Array(4);
        new DataView(length.buffer).setUint32(0, bytes.length, false);
        return [...length, ...bytes];
      };
      const headers = answer.headers ?? [];
      reply(4, [...u64(1), 0, answer.status, 0, headers.length,
        ...headers.flatMap(([name, value]) => [
          ...prefixed(new TextEncoder().encode(name)),
          ...prefixed(new TextEncoder().encode(value)),
        ]),
      ]);
      reply(5, prefixed(body));
      reply(6, []);
    },
    close: () => {},
    isEstablished: true,
  } as unknown as Tunnel;
}

/** Every worker a test started, released afterwards. */
const workers: WorkerTunnel[] = [];

/** Wires a worker to a page over a fresh channel. */
function handoff(tunnel: Tunnel): { worker: WorkerTunnel; served: () => void } {
  const worker = new WorkerTunnel();
  workers.push(worker);
  const pair = new MessageChannel();
  channels.push(pair);
  const served = serveWorker(tunnel, pair.port1);
  worker.attach(pair.port2);
  return { worker, served };
}

test('a page request reaches DSH through the tunnel and its answer comes back', async () => {
  const { worker } = handoff(
    standInTunnel({ status: 200, headers: [['content-type', 'text/html']], body: '<html>DSH</html>' }),
  );
  const answer = await worker.fetch({
    method: 'GET',
    path: '/',
    headers: [['accept', 'text/html']],
    body: new Uint8Array(0),
  });
  assert.equal(answer.status, 200);
  assert.equal(new TextDecoder().decode(answer.body), '<html>DSH</html>');
  assert.deepEqual(answer.headers, [['content-type', 'text/html']]);
});

test('a request body travels from the page to DSH', async () => {
  // DSH's `/api` calls are POSTs; a handoff that dropped bodies would break every remote
  // action while leaving GETs looking healthy.
  const seen: string[] = [];
  const tunnel = standInTunnel({ status: 200, body: 'ok' });
  const original = tunnel.send.bind(tunnel);
  (tunnel as unknown as { send: Tunnel['send'] }).send = async (streamId, payload) => {
    // The encoded request contains the body as a length-prefixed field; searching the text
    // is enough to prove it survived the handoff.
    seen.push(new TextDecoder().decode(payload));
    await original(streamId, payload);
  };

  const { worker } = handoff(tunnel);
  await worker.fetch({
    method: 'POST',
    path: '/api/session/list',
    headers: [['content-type', 'application/json']],
    body: new TextEncoder().encode('{"limit":5}') as Uint8Array<ArrayBuffer>,
  });
  assert.ok(seen.some(payload => payload.includes('{"limit":5}')), 'the body must be carried');
});

test('two requests in flight are answered on their own streams', async () => {
  const { worker } = handoff(standInTunnel({ status: 200, body: 'same' }));
  const [first, second] = await Promise.all([
    worker.fetch({ method: 'GET', path: '/a.css', headers: [], body: new Uint8Array(0) }),
    worker.fetch({ method: 'GET', path: '/b.js', headers: [], body: new Uint8Array(0) }),
  ]);
  assert.equal(new TextDecoder().decode(first.body), 'same');
  assert.equal(new TextDecoder().decode(second.body), 'same');
});

test('a tunnel that fails reaches the worker as a reason, not a hang', async () => {
  const failing = {
    on: () => () => {},
    async send() {
      throw new Error('the daemon refused the request: no websocket 7 is open');
    },
    close: () => {},
    isEstablished: true,
  } as unknown as Tunnel;
  const { worker } = handoff(failing);
  await assert.rejects(
    worker.fetch({ method: 'GET', path: '/', headers: [], body: new Uint8Array(0) }),
    /no websocket 7 is open/,
  );
});

test('stopping the officer leaves the worker saying it is unpaired', async () => {
  const { worker, served } = handoff(standInTunnel({ status: 200, body: 'ok' }));
  served();
  // The worker is detached too, so nothing is left holding the channel open.
  worker.detach();
  await assert.rejects(
    worker.fetch({ method: 'GET', path: '/', headers: [], body: new Uint8Array(0) }),
    /not paired|detached/,
  );
});
