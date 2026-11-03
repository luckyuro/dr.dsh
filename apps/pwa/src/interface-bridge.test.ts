import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { interfacePort, serveInterfacePort, type InterfaceBridge } from './interface-bridge.ts';
import { encodeWsData } from './proxy.ts';
import { serveWorker } from './officer.ts';
import { WorkerTunnel } from './worker-service.ts';
import type { SocketTunnel } from './websocket.ts';
import type { Tunnel } from './tunnel.ts';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const stop of cleanup.splice(0)) stop(); });
const tick = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 10)); };
function channel(): MessageChannel {
  const pair = new MessageChannel();
  cleanup.push(() => { pair.port1.close(); pair.port2.close(); });
  return pair;
}
function standIn() {
  const sent: { stream: number; payload: Uint8Array<ArrayBuffer> }[] = [];
  const listeners = new Map<number, (payload: Uint8Array<ArrayBuffer>) => void>();
  const tunnel: SocketTunnel & Pick<Tunnel, 'onClosed'> = {
    onClosed: () => () => {},
    on(stream, handler) {
      assert.ok(!listeners.has(stream), 'live HTTP and WebSocket streams must never overlap');
      listeners.set(stream, handler);
      return () => listeners.delete(stream);
    },
    async send(stream, payload) {
      sent.push({ stream, payload });
      if (payload[3] === 1) {
        const head = new Uint8Array(16);
        head.set([0x50, 0x58, 1, 4]);
        new DataView(head.buffer).setBigUint64(4, 1n);
        new DataView(head.buffer).setUint16(12, 200);
        listeners.get(stream)?.(head);
        listeners.get(stream)?.(new Uint8Array([0x50, 0x58, 1, 6]));
      }
    },
  };
  return { tunnel, sent, listeners };
}
function attach(tunnel: SocketTunnel): { bridge: InterfaceBridge; client: MessagePort; seen: unknown[] } {
  const pair = channel();
  const seen: unknown[] = [];
  pair.port2.onmessage = event => seen.push(event.data);
  const bridge = serveInterfacePort(tunnel, pair.port1);
  cleanup.push(() => bridge.close());
  return { bridge, client: pair.port2, seen };
}
function opened(id: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(18);
  bytes.set([0x50, 0x58, 1, 9]);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(4, BigInt(id));
  view.setUint16(12, 101);
  return bytes;
}
function wireId(payload: Uint8Array<ArrayBuffer>): number {
  return Number(new DataView(payload.buffer, payload.byteOffset).getBigUint64(4));
}

test('only the expected origin, iframe window and view can transfer a socket port', () => {
  const pair = channel();
  const frame = {} as Window;
  const event = { origin: 'https://relay.example', source: frame, data: { kind: 'drdsh-interface-connect', viewId: 'view-a' }, ports: [pair.port1] };
  assert.equal(interfacePort(event, event.origin, frame, 'view-a'), pair.port1);
  assert.equal(interfacePort({ ...event, origin: 'https://other.example' }, event.origin, frame, 'view-a'), undefined);
  assert.equal(interfacePort({ ...event, source: {} as Window }, event.origin, frame, 'view-a'), undefined);
  assert.equal(interfacePort(event, event.origin, frame, 'view-b'), undefined);
  assert.equal(interfacePort(event, event.origin, null, 'view-a'), undefined);
  assert.equal(interfacePort({ ...event, ports: [] }, event.origin, frame, 'view-a'), undefined);
});

test('two embedded documents can use the same local socket id without sharing traffic', async () => {
  const left = standIn();
  const right = standIn();
  const a = attach(left.tunnel);
  const b = attach(right.tunnel);
  a.client.postMessage({ kind: 'open', id: 1, target: '/__dr/api/remote.mux' });
  b.client.postMessage({ kind: 'open', id: 1, target: '/__dr/api/remote.mux' });
  await tick();
  assert.equal(left.sent.length, 1);
  assert.equal(right.sent.length, 1);
  const stream = left.sent[0]!.stream;
  left.listeners.get(stream)?.(opened(stream));
  left.listeners.get(stream)?.(encodeWsData(stream, { kind: 'text', text: 'computer A only' }));
  await tick();
  assert.deepEqual(a.seen, [{ kind: 'opened', id: 1, status: 101 }, { kind: 'data', id: 1, text: 'computer A only' }]);
  assert.deepEqual(b.seen, []);
  const payload = left.sent[0]!.payload;
  assert.equal(new TextDecoder().decode(payload.slice(16, 16 + new DataView(payload.buffer).getUint32(12))), '/api/remote.mux');
});

test('reloading closes every old upstream socket and allocates fresh wire ids', async () => {
  const host = standIn();
  const first = attach(host.tunnel);
  first.client.postMessage({ kind: 'open', id: 1, target: '/one' });
  first.client.postMessage({ kind: 'open', id: 2, target: '/two' });
  await tick();
  first.bridge.close();
  assert.equal(host.listeners.size, 0);
  const closes = host.sent.filter(item => item.payload[3] === 10);
  assert.equal(closes.length, 2);
  assert.deepEqual(closes.map(item => wireId(item.payload)), [1, 3]);
  const second = attach(host.tunnel);
  second.client.postMessage({ kind: 'open', id: 1, target: '/one' });
  first.client.postMessage({ kind: 'open', id: 3, target: '/stale' });
  await tick();
  assert.equal(host.sent.at(-1)?.stream, 5);
  assert.equal(wireId(host.sent.at(-1)!.payload), 5, 'daemon identifiers also survive a document-local counter reset');
  assert.equal(host.listeners.size, 1);
});

test('HTTP requests and worker replacement share the allocator with active sockets', async () => {
  const host = standIn();
  const socket = attach(host.tunnel);
  socket.client.postMessage({ kind: 'open', id: 1, target: '/mux' });
  await tick();
  for (let round = 0; round < 2; round += 1) {
    const pair = channel();
    const worker = new WorkerTunnel();
    worker.attach(pair.port2);
    const stop = serveWorker(host.tunnel as Tunnel, pair.port1);
    const response = await worker.fetch({ method: 'GET', path: '/asset.js', headers: [], body: new Uint8Array(0) });
    assert.equal(response.status, 200);
    stop();
    worker.detach();
  }
  assert.deepEqual(host.sent.map(item => item.stream), [1, 3, 5]);
  assert.equal(host.listeners.size, 1, 'the mux socket keeps its own stream through both handoffs');
});

test('a failed send retires its socket without an unhandled rejection', async () => {
  const host = standIn();
  host.tunnel.send = async () => { throw new Error('carrier closed'); };
  const frame = attach(host.tunnel);
  frame.client.postMessage({ kind: 'open', id: 1, target: '/mux' });
  await tick();
  assert.equal(host.listeners.size, 0);
  assert.match(JSON.stringify(frame.seen), /Reconnect/);
});
