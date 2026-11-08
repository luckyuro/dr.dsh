/** Endpoint-only PX v2 text fragments; the relay still sees bounded opaque carrier frames. */
export const PROXY_TEXT_VERSION = 2;
export const PROXY_TEXT_TAG = 12;
export const MAX_TEXT_BYTES = 8 * 1024 * 1024;
export const MAX_TEXT_CHUNK_BYTES = 64 * 1024 - 64;
const HEADER_BYTES = 24;

export interface TextChunk {
  readonly id: number;
  readonly total: number;
  readonly offset: number;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

function invalid(): Error {
  return new Error('invalid WebSocket text fragment bounds or format; reconnect with matching daemon and client versions');
}
function validate(chunk: TextChunk): void {
  if (!Number.isSafeInteger(chunk.id) || chunk.id < 0
    || !Number.isInteger(chunk.total) || chunk.total < 1 || chunk.total > MAX_TEXT_BYTES
    || !Number.isInteger(chunk.offset) || chunk.offset < 0
    || chunk.bytes.length === 0 || chunk.bytes.length > MAX_TEXT_CHUNK_BYTES
    || chunk.offset + chunk.bytes.length > chunk.total) throw invalid();
}

export function encodeTextChunk(chunk: TextChunk): Uint8Array<ArrayBuffer> {
  validate(chunk);
  const result = new Uint8Array(HEADER_BYTES + chunk.bytes.length);
  result.set([0x50, 0x58, PROXY_TEXT_VERSION, PROXY_TEXT_TAG]);
  const view = new DataView(result.buffer);
  view.setBigUint64(4, BigInt(chunk.id), false);
  view.setUint32(12, chunk.total, false);
  view.setUint32(16, chunk.offset, false);
  view.setUint32(20, chunk.bytes.length, false);
  result.set(chunk.bytes, HEADER_BYTES);
  return result;
}

export function decodeTextChunk(bytes: Uint8Array<ArrayBuffer>): TextChunk {
  if (bytes.length < HEADER_BYTES || bytes[0] !== 0x50 || bytes[1] !== 0x58
    || bytes[2] !== PROXY_TEXT_VERSION || bytes[3] !== PROXY_TEXT_TAG) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(20, false) !== bytes.length - HEADER_BYTES) throw invalid();
  const chunk = { id: Number(view.getBigUint64(4, false)), total: view.getUint32(12, false),
    offset: view.getUint32(16, false), bytes: bytes.subarray(HEADER_BYTES) };
  validate(chunk);
  return chunk;
}

/** A socket delivers one complete text event, never partial JSON or replacement UTF-8. */
export class WebSocketTextAssembler {
  private current: { id: number; bytes: Uint8Array<ArrayBuffer>; offset: number } | undefined;
  public get pending(): boolean { return this.current !== undefined; }
  public reset(): void { this.current = undefined; }
  public push(chunk: TextChunk): string | undefined {
    try {
      validate(chunk);
      if (!this.current) {
        if (chunk.offset !== 0) throw invalid();
        this.current = { id: chunk.id, bytes: new Uint8Array(chunk.total), offset: 0 };
      }
      const current = this.current;
      if (chunk.id !== current.id || chunk.total !== current.bytes.length || chunk.offset !== current.offset) throw invalid();
      current.bytes.set(chunk.bytes, current.offset);
      current.offset += chunk.bytes.length;
      if (current.offset !== current.bytes.length) return undefined;
      this.reset();
      return new TextDecoder('utf-8', { fatal: true }).decode(current.bytes);
    } catch {
      this.reset();
      throw invalid();
    }
  }
}
