/** A private port keeps one embedded Harness document attached to its own tunnel. */
import { decodeMessage, encodeWsData, encodeWsOpen } from './proxy.ts';
import { allocateProxyStream } from './proxy-stream.ts';
import { toDshPath } from './routing.ts';
import type { SocketTunnel } from './websocket.ts';
import { WebSocketTextAssembler } from '@dr.dsh/protocol/proxy-ws';

export interface InterfaceBridge {
  workerReady(): void;
  close(): void;
}

/** Origin alone cannot distinguish two relay tabs; the exact iframe window must match too. */
export function interfacePort(event: Pick<MessageEvent, 'origin' | 'source' | 'data' | 'ports'>, origin: string, source: MessageEventSource | null, viewId: string): MessagePort | undefined {
  if (source === null || event.origin !== origin || event.source !== source) return undefined;
  const data: unknown = event.data;
  if (data === null || typeof data !== 'object') return undefined;
  const message = data as { kind?: unknown; viewId?: unknown };
  if (message.kind !== 'drdsh-interface-connect' || message.viewId !== viewId || event.ports.length !== 1) return undefined;
  return event.ports[0];
}

/** All wire identifiers come from the tunnel allocator, including across iframe reloads. */
export function serveInterfacePort(tunnel: SocketTunnel, port: MessagePort): InterfaceBridge {
  const sockets = new Map<number, { streamId: number; text: WebSocketTextAssembler; stop(): void }>();
  let closed = false;
  const post = (message: unknown): void => {
    if (closed) return;
    try { port.postMessage(message); } catch { /* The document may have unloaded. */ }
  };
  const retire = (id: number, code: number, reason: string, upstream: boolean): void => {
    const socket = sockets.get(id);
    if (socket === undefined) return;
    sockets.delete(id);
    socket.text.reset();
    socket.stop();
    if (upstream) void tunnel.send(socket.streamId, encodeWsData(socket.streamId, { kind: 'close' })).catch(() => {});
    post({ kind: 'closed', id, code, reason });
  };
  const receive = (event: MessageEvent): void => {
    const value: unknown = event.data;
    if (closed || value === null || typeof value !== 'object') return;
    const message = value as { kind?: unknown; id?: unknown; target?: unknown; text?: unknown };
    if (message.kind === 'dispose') { close(); return; }
    if (typeof message.id !== 'number' || !Number.isSafeInteger(message.id) || message.id < 1) return;
    const id = message.id;
    if (message.kind === 'open') {
      if (sockets.has(id)) return;
      if (typeof message.target !== 'string' || sockets.size >= 64) {
        post({ kind: 'closed', id, code: 1006, reason: 'The interface socket request is invalid or too many sockets are open. Reload the Harness interface.' });
        return;
      }
      try {
        const streamId = allocateProxyStream(tunnel);
        const encoded = encodeWsOpen(streamId, toDshPath(message.target));
        const text = new WebSocketTextAssembler();
        const stop = tunnel.on(streamId, payload => {
          if (closed || !sockets.has(id)) return;
          let decoded;
          try { decoded = decodeMessage(payload); }
          catch { retire(id, 1006, 'The DSH computer sent an unsupported interface socket frame. Reconnect after checking both software versions.', true); return; }
          if (decoded === undefined || !('id' in decoded) || decoded.id !== streamId) return;
          if (decoded.kind === 'wsOpened') {
            if (decoded.status !== 101) retire(id, 1006, `The DSH computer refused the socket upgrade (${decoded.status}). Reload the Harness interface.`, false);
            else post({ kind: 'opened', id, status: decoded.status });
          } else if (decoded.kind === 'wsData') {
            if (decoded.frame.kind === 'close') retire(id, 1000, '', false);
            else if (text.pending) retire(id, 1006, 'DSH interrupted a fragmented message; reconnect the interface.', true);
            else post({ kind: 'data', id, text: decoded.frame.text });
          } else if (decoded.kind === 'wsTextChunk') {
            try {
              const complete = text.push(decoded);
              if (complete !== undefined) post({ kind: 'data', id, text: complete });
            } catch {
              retire(id, 1006, 'DSH sent invalid WebSocket text fragments; update both daemon and client, then reconnect.', true);
            }
          } else if (decoded.kind === 'failure') retire(id, 1006, decoded.reason, false);
        });
        sockets.set(id, { streamId, text, stop });
        void tunnel.send(streamId, encoded).catch(() => retire(id, 1006, 'The tunnel could not open the interface socket. Reconnect to your computer.', true));
      } catch {
        post({ kind: 'closed', id, code: 1006, reason: 'The tunnel could not allocate this interface socket. Reconnect to your computer.' });
      }
      return;
    }
    const socket = sockets.get(id);
    if (socket === undefined) return;
    if (message.kind === 'send' && typeof message.text === 'string') {
      void tunnel.send(socket.streamId, encodeWsData(socket.streamId, { kind: 'text', text: message.text }))
        .catch(() => retire(id, 1006, 'The tunnel could not send the interface message. Reconnect to your computer.', true));
    } else if (message.kind === 'close') retire(id, 1000, '', true);
  };
  const close = (): void => {
    if (closed) return;
    for (const id of [...sockets.keys()]) retire(id, 1000, '', true);
    closed = true;
    port.removeEventListener('message', receive);
    port.close();
  };
  port.addEventListener('message', receive);
  port.start();
  return { workerReady: () => post({ kind: 'worker-ready' }), close };
}
