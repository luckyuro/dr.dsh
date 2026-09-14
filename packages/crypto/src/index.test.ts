/**
 * Browser-side invariants for the session layer.
 *
 * These are the checks that keep this implementation honest against
 * `crates/dr-dsh-crypto`: the nonce layout, the AAD binding, and the refusal of
 * short key material. The full handshake corpus lands with M0/M1.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LABELS, SESSION_KEY_LEN, frameAdditionalData, importSessionKey, nonceBytes } from './index.ts';

test('nonce is four zero bytes followed by a big-endian counter', () => {
  assert.deepEqual(Array.from(nonceBytes(0)), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(nonceBytes(1)), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(Array.from(nonceBytes(258)), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2]);
});

test('frame additional data binds the label and the stream id', () => {
  const aad = frameAdditionalData(3);
  const label = new TextEncoder().encode(LABELS.frameAad);
  assert.equal(aad.byteLength, label.byteLength + 4);
  assert.deepEqual(aad.slice(0, label.byteLength), label);
  assert.deepEqual(Array.from(aad.slice(label.byteLength)), [0, 0, 0, 3]);
  assert.notDeepEqual(frameAdditionalData(3), frameAdditionalData(4));
});

test('session keys must be exactly 32 bytes', async () => {
  await assert.rejects(() => importSessionKey(new Uint8Array(SESSION_KEY_LEN - 1)));
  const key = await importSessionKey(new Uint8Array(SESSION_KEY_LEN));
  assert.equal(key.algorithm.name, 'AES-GCM');
  assert.equal(key.extractable, false);
});
