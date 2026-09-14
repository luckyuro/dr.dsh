/**
 * Asserts the TypeScript codec against the shared corpus.
 *
 * Run with `pnpm --filter @dr.dsh/protocol test` (node's built-in test
 * runner, no framework). The Rust side runs the same corpus from
 * `crates/dr-dsh-proto/src/conformance.rs`; a failure on either side means the two
 * implementations disagree, which is a release blocker (ADR-0004).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FRAME_VECTORS,
  REJECTION_VECTORS,
  type FrameVector,
  bytesToHex,
  hexToBytes,
} from './conformance.ts';
import {
  FRAME_HEADER_LEN,
  FrameType,
  ProtocolError,
  decodeFrame,
  encodeFrame,
} from './index.ts';

function decodeVector(vector: FrameVector): void {
  const bytes = hexToBytes(vector.hex);
  const decoded = decodeFrame(bytes);
  assert.ok(decoded !== undefined, `${vector.name}: expected a complete frame`);
  assert.equal(decoded.consumed, bytes.byteLength, `${vector.name}: consumed length`);
  assert.deepEqual(decoded.frame.version, vector.version, `${vector.name}: version`);
  assert.equal(decoded.frame.frameType, vector.frameType, `${vector.name}: frame type`);
  assert.equal(decoded.frame.flags, vector.flags, `${vector.name}: flags`);
  assert.equal(decoded.frame.streamId, vector.streamId, `${vector.name}: stream id`);
  assert.equal(bytesToHex(decoded.frame.payload), vector.payloadHex, `${vector.name}: payload`);
}

for (const vector of FRAME_VECTORS) {
  test(`decodes: ${vector.name}`, () => {
    decodeVector(vector);
  });

  test(`re-encodes byte for byte: ${vector.name}`, () => {
    const decoded = decodeFrame(hexToBytes(vector.hex));
    assert.ok(decoded !== undefined);
    assert.equal(bytesToHex(encodeFrame(decoded.frame)), vector.hex.toLowerCase());
  });
}

for (const vector of REJECTION_VECTORS) {
  test(`rejects: ${vector.name}`, () => {
    assert.throws(() => decodeFrame(hexToBytes(vector.hex)), ProtocolError, vector.reason);
  });
}

test('a truncated frame is incomplete, not an error', () => {
  const full = hexToBytes(FRAME_VECTORS[2]?.hex ?? '');
  for (let length = 0; length < full.byteLength; length += 1) {
    assert.equal(decodeFrame(full.slice(0, length)), undefined, `length ${length}`);
  }
  assert.ok(decodeFrame(full) !== undefined);
});

test('a payload exactly at the cap is accepted', () => {
  const payload = new Uint8Array(64 * 1024);
  const encoded = encodeFrame({
    version: [0, 1],
    frameType: FrameType.Data,
    flags: 0,
    streamId: 1,
    payload,
  });
  assert.equal(encoded.byteLength, FRAME_HEADER_LEN + payload.byteLength);
  assert.ok(decodeFrame(encoded) !== undefined);
});

test('a payload one byte above the cap is refused before encoding', () => {
  assert.throws(
    () =>
      encodeFrame({
        version: [0, 1],
        frameType: FrameType.Data,
        flags: 0,
        streamId: 1,
        payload: new Uint8Array(64 * 1024 + 1),
      }),
    ProtocolError,
  );
});
