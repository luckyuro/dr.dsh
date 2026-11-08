import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decodeTextChunk, encodeTextChunk, MAX_TEXT_CHUNK_BYTES, WebSocketTextAssembler } from './proxy-ws.ts';

const corpus = JSON.parse(readFileSync(new URL('../conformance/vectors.json', import.meta.url), 'utf8')) as {
  proxyTextChunks: { name: string; hex: string; id: number; total: number; offset: number; payloadHex: string }[];
  proxyTextRejections: { name: string; hex: string }[];
};
const unhex = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(text, 'hex'));
test('PX v2 bytes and invalid bounds match the normative Rust corpus', () => {
  const assembly = new WebSocketTextAssembler();
  const completed: string[] = [];
  for (const vector of corpus.proxyTextChunks) {
    const chunk = { id: vector.id, total: vector.total, offset: vector.offset, bytes: unhex(vector.payloadHex) };
    assert.deepEqual(decodeTextChunk(unhex(vector.hex)), chunk, vector.name);
    assert.equal(Buffer.from(encodeTextChunk(chunk)).toString('hex'), vector.hex, vector.name);
    const text = assembly.push(chunk);
    if (text !== undefined) completed.push(text);
  }
  assert.deepEqual(completed, ['A😀中文']);
  for (const vector of corpus.proxyTextRejections) assert.throws(() => decodeTextChunk(unhex(vector.hex)), /invalid/, vector.name);
});

test('large UTF-8 text is delivered only after its final fragment', () => {
  const text = JSON.stringify({ output: '😀中文\n'.repeat(30000) });
  const bytes = new TextEncoder().encode(text);
  const assembly = new WebSocketTextAssembler();
  let result: string | undefined;
  for (let offset = 0; offset < bytes.length; offset += MAX_TEXT_CHUNK_BYTES) {
    assert.equal(result, undefined);
    result = assembly.push({ id: 9, total: bytes.length, offset, bytes: bytes.slice(offset, offset + MAX_TEXT_CHUNK_BYTES) });
  }
  assert.equal(result, text);
  assert.equal(assembly.pending, false);
});

test('overlap, changed identity and invalid final UTF-8 discard the partial message', () => {
  for (const change of [{ offset: 0 }, { id: 8 }, { total: 4 }]) {
    const assembly = new WebSocketTextAssembler();
    assembly.push({ id: 7, total: 3, offset: 0, bytes: new Uint8Array([97]) });
    assert.throws(() => assembly.push({ id: 7, total: 3, offset: 1, bytes: new Uint8Array([98]), ...change }), /invalid/);
    assert.equal(assembly.pending, false);
  }
  const assembly = new WebSocketTextAssembler();
  assert.throws(() => assembly.push({ id: 7, total: 1, offset: 0, bytes: new Uint8Array([255]) }), /invalid/);
  assert.equal(assembly.pending, false);
});
