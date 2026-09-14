/**
 * The pairing PAKE, pinned to the Rust implementation.
 *
 * These tests read `packages/crypto/conformance/pairing-vectors.json`, which
 * `crates/dr-dsh-crypto/tests/pairing_vectors.rs` generates from the normative Rust construction.
 * A vector mismatch here means the browser and the daemon would derive different keys, which
 * the daemon reports as `pairing_failed` — the same words it uses for a wrong code. That is
 * why the check has to happen here, where the failure can name the step.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  Spake2State,
  SIDE_CLIENT,
  SIDE_DAEMON,
  hashToScalar,
  randomScalar,
} from './spake2.ts';
import {
  PairingClient,
  PairingError,
  checkAcceptance,
  openRoomKey,
  sealRoomKey,
  SEALED_ROOM_KEY_LEN,
  decodeField,
  deriveEnrolmentKey,
  enrolmentConfirmation,
  formatPairingCode,
  pairingRoomFor,
  pairingTransportRoot,
  parsePairingCode,
  roomIdFor,
} from './pairing.ts';
import {
  bytesToBigIntLE,
  bytesToHex,
  bigIntToBytesLE,
  hexToBytes,
  reduceWideScalar,
  SCALAR_ORDER,
} from './ed25519.ts';

/** One vector case, as the corpus stores it. */
interface VectorCase {
  readonly name: string;
  readonly passwordHex: string;
  readonly passwordScalarHex: string;
  readonly clientRandomHex: string;
  readonly clientScalarHex: string;
  readonly clientMessageHex: string;
  readonly daemonRandomHex: string;
  readonly daemonScalarHex: string;
  readonly daemonMessageHex: string;
  readonly exchangedHex: string;
  readonly devicePublicKeyHex: string;
  readonly confirmHex: string;
  readonly enrolmentKeyHex: string;
  readonly roomKeyHex: string;
  readonly sealNonceHex: string;
  readonly sealedRoomKeyHex: string;
  readonly room: string;
  readonly rendezvousRoom: string;
}

interface Corpus {
  readonly cases: readonly VectorCase[];
  readonly transportRootHex: string;
}

const CORPUS_URL = new URL('../../../packages/crypto/conformance/pairing-vectors.json', import.meta.url);
const CORPUS: Corpus = JSON.parse(readFileSync(CORPUS_URL, 'utf8')) as Corpus;

test('the corpus carries cases to check', () => {
  assert.ok(CORPUS.cases.length >= 3, 'a corpus with no cases pins nothing');
});

// One test per case rather than one loop: a failure has to name the case, and `node --test`
// reports the test name.
for (const vector of CORPUS.cases) {
  test(`the Rust vectors agree: ${vector.name}`, async () => {
    const password = hexToBytes(vector.passwordHex);
    const devicePublicKey = hexToBytes(vector.devicePublicKeyHex);

    // The scalar derivations, checked separately from the exchanges so a mismatch points at
    // the hash rather than at the group. Scalars are little-endian in the corpus, which is
    // how `curve25519_dalek::Scalar::as_bytes` writes them.
    assert.equal(
      bytesToHex(bigIntToBytesLE(await hashToScalar(password), 32)),
      vector.passwordScalarHex,
      'the password-to-scalar derivation differs',
    );
    assert.equal(
      reduceWideScalar(hexToBytes(vector.clientRandomHex)),
      bytesToBigIntLE(hexToBytes(vector.clientScalarHex)),
      'the client ephemeral scalar differs',
    );
    assert.equal(
      reduceWideScalar(hexToBytes(vector.daemonRandomHex)),
      bytesToBigIntLE(hexToBytes(vector.daemonScalarHex)),
      'the daemon ephemeral scalar differs',
    );

    const clientScalar = bytesToBigIntLE(hexToBytes(vector.clientScalarHex));
    const daemonScalar = bytesToBigIntLE(hexToBytes(vector.daemonScalarHex));
    const started = await Spake2State.start('client', password, clientScalar);
    const peer = await Spake2State.start('daemon', password, daemonScalar);
    assert.equal(bytesToHex(started.message), vector.clientMessageHex, 'the client message differs');
    assert.equal(bytesToHex(peer.message), vector.daemonMessageHex, 'the daemon message differs');

    const exchanged = await started.state.finish(peer.message);
    assert.equal(bytesToHex(exchanged), vector.exchangedHex, 'the exchanged key differs');
    assert.equal(
      bytesToHex(await peer.state.finish(started.message)),
      vector.exchangedHex,
      'the two halves must derive the same key',
    );

    const confirm = await enrolmentConfirmation(exchanged, devicePublicKey);
    assert.equal(bytesToHex(confirm), vector.confirmHex, 'the enrolment confirmation differs');

    const enrolmentKey = await deriveEnrolmentKey(exchanged);
    assert.equal(bytesToHex(enrolmentKey), vector.enrolmentKeyHex, 'the enrolment key differs');
    assert.equal(await pairingRoomFor(password), vector.rendezvousRoom, 'the rendezvous room differs');

    // The receipt: the room key the daemon serves, sealed under the enrolment key. This is the
    // step that used to hand the room key to the relay and hand the client a key no daemon
    // served, so it is pinned in both directions.
    const roomKey = hexToBytes(vector.roomKeyHex);
    const sealed = hexToBytes(vector.sealedRoomKeyHex);
    assert.equal(sealed.length, SEALED_ROOM_KEY_LEN);
    assert.deepEqual(
      await openRoomKey(enrolmentKey, devicePublicKey, sealed),
      roomKey,
      'the receipt must open to the served room key',
    );
    assert.equal(await roomIdFor(roomKey), vector.room, 'the room id differs');

    // And the sealing direction: this module's sealer must produce the Rust implementation's
    // bytes, or the fake daemon built on it would be testing a format of its own.
    assert.equal(
      bytesToHex(
        await sealRoomKey(
          enrolmentKey,
          devicePublicKey,
          roomKey,
          hexToBytes(vector.sealNonceHex),
        ),
      ),
      vector.sealedRoomKeyHex,
      'the sealed receipt differs from the Rust implementation',
    );
  });
}

test('the pairing transport root matches the daemon constant', async () => {
  assert.equal(bytesToHex(await pairingTransportRoot()), CORPUS.transportRootHex);
});

test('a displayed code survives the round trip it was designed for', () => {
  for (const vector of CORPUS.cases) {
    const secret = hexToBytes(vector.passwordHex);
    const displayed = formatPairingCode(secret);
    assert.deepEqual(parsePairingCode(displayed), secret);
    assert.deepEqual(parsePairingCode(displayed.toLowerCase()), secret);
    // A user reading the code off a screen types what they see; the characters the alphabet
    // omits are folded rather than refused.
    assert.deepEqual(parsePairingCode(displayed.replace(/0/g, 'O').replace(/1/g, 'l')), secret);
    assert.deepEqual(parsePairingCode(` ${displayed.replace(/-/g, ' ')} `), secret);
    assert.ok(!displayed.includes('='), 'the display form carries no padding');
  }
});

test('a code that is not a code is refused with a reason', () => {
  assert.throws(() => parsePairingCode(''), PairingError);
  assert.throws(() => parsePairingCode('ABCDE'), PairingError);
  assert.throws(() => parsePairingCode('ABCD-EFGH-!!'), PairingError);
  // 8 symbols: a legal alphabet, the wrong length.
  assert.throws(() => parsePairingCode('ABCD-EFGH'), PairingError);
});

test('a client and daemon holding the same code reach the same root key', async () => {
  const secret = hexToBytes('7f3a9105c4');
  const devicePublicKey = hexToBytes('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
  const daemon = await Spake2State.start('daemon', secret);
  const client = await PairingClient.begin(formatPairingCode(secret));

  assert.equal(client.rendezvousRoom, await pairingRoomFor(secret));
  const outcome = await client.finish(daemon.message, devicePublicKey);
  const daemonKey = await daemon.state.finish(client.message);

  assert.equal(bytesToHex(await deriveEnrolmentKey(daemonKey)), bytesToHex(outcome.enrolmentKey));
  assert.equal(
    bytesToHex(outcome.confirm),
    bytesToHex(await enrolmentConfirmation(daemonKey, devicePublicKey)),
  );
});

test('a daemon with the wrong code derives a different key, and the proof fails with it', async () => {
  const devicePublicKey = hexToBytes('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
  const daemon = await Spake2State.start('daemon', hexToBytes('7f3a9105c5'));
  const client = await PairingClient.begin(formatPairingCode(hexToBytes('7f3a9105c4')));
  const outcome = await client.finish(daemon.message, devicePublicKey);
  const daemonKey = await daemon.state.finish(client.message);

  // The PAKE itself cannot tell: a wrong code produces a key, which is the whole point.
  assert.notEqual(bytesToHex(daemonKey), bytesToHex(await deriveEnrolmentKey(hexToBytes('00'))));
  // What fails is the confirmation, which is why the daemon can refuse a wrong code without
  // being an oracle for it.
  assert.notEqual(
    bytesToHex(outcome.confirm),
    bytesToHex(await enrolmentConfirmation(daemonKey, devicePublicKey)),
  );
});

test('the client refuses a peer that is not playing the other side', async () => {
  const secret = hexToBytes('0102030405');
  const client = await PairingClient.begin(formatPairingCode(secret));
  const sameSide = await Spake2State.start('client', secret);
  await assert.rejects(
    () => client.finish(sameSide.message, new Uint8Array(32)),
    /the peer is playing the same side/,
  );
});

test('a malformed or truncated SPAKE2 message is refused by name', async () => {
  const secret = hexToBytes('0102030405');
  const peer = await Spake2State.start('daemon', secret);
  const client = await PairingClient.begin(formatPairingCode(secret));

  await assert.rejects(
    () => client.finish(peer.message.slice(0, 32), new Uint8Array(32)),
    /usable pairing message/,
  );

  // A point that is not on the curve: the canonical encoding of a y with no matching x.
  const notAPoint = new Uint8Array(33);
  notAPoint[0] = SIDE_DAEMON;
  notAPoint.set(hexToBytes('0200000000000000000000000000000000000000000000000000000000000080'), 1);
  const second = await PairingClient.begin(formatPairingCode(secret));
  await assert.rejects(() => second.finish(notAPoint, new Uint8Array(32)), /not a point/);
});

test('an exchange is finished once', async () => {
  const secret = hexToBytes('0102030405');
  const daemon = await Spake2State.start('daemon', secret);
  const client = await PairingClient.begin(formatPairingCode(secret));
  await client.finish(daemon.message, new Uint8Array(32));
  await assert.rejects(() => client.finish(daemon.message, new Uint8Array(32)), PairingError);
});

test('an acceptance for a room the key does not derive is refused', async () => {
  const roomKey = hexToBytes('5a'.repeat(32));
  await checkAcceptance(roomKey, await roomIdFor(roomKey));
  await assert.rejects(() => checkAcceptance(roomKey, 'somebody-elses-room'), PairingError);
});

test('a receipt that was not sealed for this device is refused', async () => {
  const vector = CORPUS.cases[0];
  assert.ok(vector !== undefined, 'the corpus must carry at least one case');
  const enrolmentKey = hexToBytes(vector.enrolmentKeyHex);
  const devicePublicKey = hexToBytes(vector.devicePublicKeyHex);
  const sealed = hexToBytes(vector.sealedRoomKeyHex);

  // A different identity: the AAD binds the receipt to the key being enrolled, so a receipt
  // captured on one pairing cannot be replayed onto another device.
  await assert.rejects(
    () => openRoomKey(enrolmentKey, hexToBytes('11'.repeat(32)), sealed),
    /could not be opened/,
  );
  // A different enrolment key: the relay knows the transport root, not this.
  await assert.rejects(
    () => openRoomKey(hexToBytes('22'.repeat(32)), devicePublicKey, sealed),
    /could not be opened/,
  );
  // A flipped byte, and a truncated blob.
  const flipped = sealed.slice();
  flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 0x01;
  await assert.rejects(() => openRoomKey(enrolmentKey, devicePublicKey, flipped), /could not be opened/);
  await assert.rejects(
    () => openRoomKey(enrolmentKey, devicePublicKey, sealed.slice(0, 40)),
    /an enrolment receipt is 60 bytes, got 40/,
  );
});

test('the side bytes are the ones the protocol names', async () => {
  const secret = hexToBytes('0102030405');
  const client = await Spake2State.start('client', secret);
  const daemon = await Spake2State.start('daemon', secret);
  assert.equal(client.message[0], SIDE_CLIENT);
  assert.equal(daemon.message[0], SIDE_DAEMON);
  assert.equal(client.message.length, 33);
});

test('ephemeral scalars are drawn fresh and reduced', () => {
  const first = randomScalar();
  const second = randomScalar();
  assert.notEqual(first, second);
  assert.ok(first >= 0n && first < SCALAR_ORDER);
});

test('a base64url field of the wrong length is refused', () => {
  assert.equal(decodeField('AAAA', 3, 'a nonce').length, 3);
  assert.throws(() => decodeField('AAAA', 4, 'a nonce'), /a nonce is 4 bytes, got 3/);
  assert.throws(() => decodeField('!!!!', 3, 'a nonce'), /not base64url/);
});
