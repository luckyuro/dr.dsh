/**
 * The Ed25519 group arithmetic, checked against published vectors.
 *
 * A hand-written group is exactly the kind of code that is wrong in a way that still
 * "works": an off-by-one in a formula produces a point that is on the curve and a key that
 * two ends do not share. So the checks here are the ones that can fail loudly — RFC 8032's
 * public-key vectors, the group order, and the encoding round trip — and
 * `pairing.test.ts` pins the result against the Rust implementation.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BASE_POINT,
  Ed25519Error,
  IDENTITY,
  SCALAR_ORDER,
  addPoints,
  bigIntToBytesLE,
  bytesToBigIntLE,
  bytesToHex,
  compressPoint,
  decompressPoint,
  hexToBytes,
  negatePoint,
  reduceWideScalar,
  scalarFromBigEndian,
  scalarMult,
} from './ed25519.ts';

/**
 * RFC 8032 § 7.1 test vectors: the secret seed and the public key it must produce.
 *
 * Deriving a public key from a seed is the standard test of a group implementation: it
 * exercises the base point, the scalar multiplication, and the canonical encoding at once,
 * against numbers nobody in this repository chose.
 */
const RFC8032: readonly { readonly seed: string; readonly publicKey: string }[] = [
  {
    seed: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    publicKey: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
  },
  {
    seed: '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
    publicKey: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
  },
  {
    seed: 'c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7',
    publicKey: 'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025',
  },
];

for (const vector of RFC8032) {
  test(`RFC 8032 public key: ${vector.publicKey.slice(0, 16)}…`, async () => {
    const seed = hexToBytes(vector.seed);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-512', seed));
    const scalar = digest.slice(0, 32);
    // The clamping RFC 8032 specifies. Doing it by hand keeps this test independent of the
    // signing code path: what is under test is the group, not WebCrypto.
    scalar[0] = (scalar[0] ?? 0) & 248;
    scalar[31] = ((scalar[31] ?? 0) & 127) | 64;
    const publicKey = compressPoint(scalarMult(BASE_POINT, bytesToBigIntLE(scalar)));
    assert.equal(bytesToHex(publicKey), vector.publicKey);
  });
}

test('the base point round-trips through its canonical encoding', () => {
  assert.equal(
    bytesToHex(compressPoint(BASE_POINT)),
    '5866666666666666666666666666666666666666666666666666666666666666',
  );
});

test('the group order annihilates the base point', () => {
  // If this fails, the arithmetic is a *different group*, and every derived key is wrong in
  // a way that only shows up as a failed exchange.
  assert.equal(bytesToHex(compressPoint(scalarMult(BASE_POINT, SCALAR_ORDER))), bytesToHex(compressPoint(IDENTITY)));
  assert.equal(bytesToHex(compressPoint(scalarMult(BASE_POINT, SCALAR_ORDER + 1n))), bytesToHex(compressPoint(BASE_POINT)));
});

test('addition and scalar multiplication agree', () => {
  const a = 12345n;
  const b = 67890n;
  const sum = addPoints(scalarMult(BASE_POINT, a), scalarMult(BASE_POINT, b));
  assert.equal(bytesToHex(compressPoint(sum)), bytesToHex(compressPoint(scalarMult(BASE_POINT, a + b))));
  assert.equal(
    bytesToHex(compressPoint(addPoints(scalarMult(BASE_POINT, a), scalarMult(BASE_POINT, b)))),
    bytesToHex(compressPoint(addPoints(scalarMult(BASE_POINT, b), scalarMult(BASE_POINT, a)))),
    'addition must commute',
  );
});

test('negation undoes addition', () => {
  const point = scalarMult(BASE_POINT, 987654321n);
  assert.equal(
    bytesToHex(compressPoint(addPoints(point, negatePoint(point)))),
    bytesToHex(compressPoint(IDENTITY)),
  );
});

test('every compressed point decompresses to what it came from', () => {
  for (const scalar of [1n, 2n, 3n, 255n, 256n, 65537n, 12345678901234567890n]) {
    const point = scalarMult(BASE_POINT, scalar);
    const encoded = compressPoint(point);
    assert.equal(bytesToHex(compressPoint(decompressPoint(encoded))), bytesToHex(encoded));
  }
});

test('the encoding refuses what is not a point', () => {
  assert.throws(() => decompressPoint(new Uint8Array(31)), Ed25519Error);
  assert.throws(() => decompressPoint(new Uint8Array(33)), Ed25519Error);
  // y = 2 with the sign bit set: not on the curve for either sign.
  assert.throws(
    () => decompressPoint(hexToBytes('0200000000000000000000000000000000000000000000000000000000000080')),
    /not a point/,
  );
  // y = p is not a canonical field element.
  const notCanonical = bigIntToBytesLE((1n << 255n) - 19n, 32);
  assert.throws(() => decompressPoint(notCanonical), /not canonical/);
  // x = 0 with the sign bit set: the "negative zero" encoding, which RFC 8032 forbids.
  const negativeZero = bigIntToBytesLE(1n, 32);
  negativeZero[31] = (negativeZero[31] ?? 0) | 0x80;
  assert.throws(() => decompressPoint(negativeZero), /sign bit/);
});

test('wide scalars reduce exactly as the Rust side reduces them', () => {
  const all = new Uint8Array(64).fill(0xff);
  assert.equal(reduceWideScalar(all), bytesToBigIntLE(all) % SCALAR_ORDER);
  assert.throws(() => reduceWideScalar(new Uint8Array(63)), Ed25519Error);
});

test('big-endian scalars reduce the way the password hash does', () => {
  // `spake2` reads its 48 HKDF bytes big-endian; reading them little-endian would produce a
  // different scalar and a different key, with nothing to point at.
  const leadingOne = new Uint8Array(48);
  leadingOne[0] = 1;
  assert.equal(scalarFromBigEndian(leadingOne), (1n << 376n) % SCALAR_ORDER);
  const trailingOne = new Uint8Array(48);
  trailingOne[47] = 1;
  assert.equal(scalarFromBigEndian(trailingOne), 1n, 'the last byte is the least significant');
  assert.equal(scalarFromBigEndian(new Uint8Array(0)), 0n);
});

test('byte conversion round-trips and refuses what does not fit', () => {
  const value = 0x0123456789abcdefn;
  assert.equal(bytesToBigIntLE(bigIntToBytesLE(value, 8)), value);
  assert.throws(() => bigIntToBytesLE(256n, 1), Ed25519Error);
  assert.throws(() => bigIntToBytesLE(-1n, 4), Ed25519Error);
  assert.throws(() => hexToBytes('abc'), Ed25519Error);
});
