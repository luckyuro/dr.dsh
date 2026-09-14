/**
 * The one field that takes two credentials.
 *
 * The classification is worth testing because its failure is silent: a pairing code treated as a
 * room key derives a room nobody serves, and the page then blames the relay for a paste that was
 * fine.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CredentialError, classifyCredential, describeCredential } from './credential.ts';

/** A room key, as `drdshd room-key` prints it. */
const ROOM_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

test('a pairing code is recognised however it was grouped', () => {
  for (const typed of ['7Q4M-2XKP-9T', '7q4m-2xkp-9t', '7Q4M2XKP9T', ' 7Q4M 2XKP 9T ', '7Q4M-2XKP-9T\n']) {
    const credential = classifyCredential(typed);
    assert.equal(credential.kind, 'code');
    assert.equal(credential.kind === 'code' ? credential.code : '', '7Q4M-2XKP-9T');
  }
});

test('the characters the alphabet omits are folded, not refused', () => {
  // `drdshd pair` never prints I, L, O or U, so a user who reads one off a screen typed what they
  // saw — refusing it would punish them for the alphabet's choice.
  const folded = classifyCredential('7Q4M-2XKP-9O');
  assert.equal(folded.kind === 'code' ? folded.code : '', '7Q4M-2XKP-90');
  const letters = classifyCredential('I234-5678-9T');
  assert.equal(letters.kind === 'code' ? letters.code : '', '1234-5678-9T');
});

test('a room key is recognised as one', () => {
  const credential = classifyCredential(ROOM_KEY);
  assert.equal(credential.kind, 'roomKey');
  assert.equal(credential.kind === 'roomKey' ? credential.roomKey : '', ROOM_KEY);
});

test('ten symbols of the alphabet are a code and not a room key', () => {
  // The two shapes cannot collide: a room key is 43 characters, a code is 10 symbols.
  const code = classifyCredential('0123456789');
  assert.equal(code.kind, 'code');
  assert.equal(describeCredential(code), 'pairing code 0123-4567-89');
  assert.equal(describeCredential(classifyCredential(ROOM_KEY)), 'a room key');
});

test('anything else is refused with both shapes named', () => {
  // An empty field is the common case (the user pressed Connect too early) and gets its own
  // sentence; a near miss gets one that names both lengths, because "that is 42 characters" is
  // only useful to someone who knows it should be 43.
  for (const empty of ['', '   ', '\n']) {
    assert.throws(() => classifyCredential(empty), (error: unknown) =>
      error instanceof CredentialError && /Enter the code/.test(error.message),
    );
  }
  for (const typed of ['too-short!', 'ABCDE-FGH', 'ABCD-EFGH-IJK', `${ROOM_KEY}A`]) {
    assert.throws(
      () => classifyCredential(typed),
      (error: unknown) => error instanceof CredentialError && /43/.test(error.message),
      `expected a refusal for ${JSON.stringify(typed)}`,
    );
  }
});
