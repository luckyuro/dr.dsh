import assert from 'node:assert/strict';
import { test } from 'node:test';

import { serveWorker } from './officer.ts';
import type { Tunnel } from './tunnel.ts';
import { WorkerTunnel, toResponse } from './worker-service.ts';

function text(value: string): number[] {
  const bytes = new TextEncoder().encode(value);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, bytes.length, false);
  return [...length, ...bytes];
}

test('an open event stream reaches the worker before the HTTP response ends', { timeout: 2_000 }, async () => {
  const handlers = new Map<number, (payload: Uint8Array<ArrayBuffer>) => void>();
  const tunnel = {
    on(stream: number, handler: (payload: Uint8Array<ArrayBuffer>) => void) {
      handlers.set(stream, handler);
      return () => { if (handlers.get(stream) === handler) handlers.delete(stream); };
    },
    onClosed: () => () => {},
    async send(stream: number) {
      const emit = handlers.get(stream)!;
      emit(new Uint8Array([0x50, 0x58, 1, 4, 0, 0, 0, 0, 0, 0, 0, 1, 0, 200, 0, 1,
        ...text('content-type'), ...text('text/event-stream')]));
      emit(new Uint8Array([0x50, 0x58, 1, 5, ...text('data: first\n\n')]));
    },
  } as unknown as Tunnel;
  const pair = new MessageChannel();
  const worker = new WorkerTunnel();
  const stop = serveWorker(tunnel, pair.port2);
  worker.attach(pair.port1);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      worker.fetch({ method: 'GET', path: '/events', headers: [], body: new Uint8Array(0) }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('event stream was buffered until EOF')), 500);
      }),
    ]);
    assert.equal(answer.status, 200);
    const reader = toResponse(answer).body!.getReader();
    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), 'data: first\n\n');
    const next = reader.read();
    worker.detach();
    assert.equal((await next).done, true, 'worker retirement lets an EventSource reconnect at EOF');
  } finally {
    clearTimeout(timeout);
    worker.detach();
    stop();
    pair.port1.close();
    pair.port2.close();
  }
});
