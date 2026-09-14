/**
 * What survives a restart, checked where it can be checked without a browser.
 *
 * The IndexedDB implementation itself needs a browser and is covered by
 * `scripts/browser-pairing-smoke.mjs` — which is the only place it can be, and the reason that
 * script exists. What runs here is the part that decides whether a value read back is usable at
 * all, plus the two things ADR-0007 added: one identity shared by many rooms, and the migration of
 * the v1 record that held both in one object.
 *
 * The migration gets its own tests because it runs exactly once per browser, on the one piece of
 * state whose loss means pairing again — "it worked on my machine" is not evidence for code with
 * that property.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MemoryRoomStore,
  StorageError,
  asDeviceRecord,
  asIdentityRecord,
  asRoomRecord,
  byMostRecent,
  identityOf,
  migrateLegacy,
  roomOf,
} from './storage.ts';

/** A pairing record shaped the way pairing produces one. */
const RECORD = {
  privateKey: 'cHJpdmF0ZQ',
  publicKey: 'cHVibGlj',
  deviceId: 'device-id',
  roomKey: 'cm9vbS1rZXk',
  room: 'room-one',
};

test('a well-formed pairing record survives the round trip', () => {
  assert.deepEqual(asDeviceRecord({ ...RECORD }), RECORD);
});

test('a pairing record with a field missing or of the wrong type is not usable', () => {
  for (const broken of [
    null,
    undefined,
    42,
    'a string',
    {},
    { ...RECORD, privateKey: undefined },
    { ...RECORD, room: 7 },
    { ...RECORD, deviceId: null },
  ]) {
    assert.equal(asDeviceRecord(broken), null, `expected null for ${JSON.stringify(broken)}`);
  }
});

test('extra fields are ignored rather than rejected', () => {
  // A record written by a later version may carry more than this one reads; refusing it would
  // turn a forward-compatible addition into a forced re-pairing.
  const stored = asDeviceRecord({ ...RECORD, createdAt: 1234 });
  assert.deepEqual(stored, RECORD);
});

test('an identity is the half without a room, and a room needs its bookkeeping', () => {
  assert.deepEqual(asIdentityRecord({ ...RECORD }), {
    privateKey: RECORD.privateKey,
    publicKey: RECORD.publicKey,
    deviceId: RECORD.deviceId,
  });
  // A room without a label or a pairing time is not something a list can show.
  assert.equal(asRoomRecord({ room: 'r', roomKey: 'k' }), null);
  assert.equal(asRoomRecord({ room: 'r', roomKey: 'k', label: 'l' }), null);
  assert.deepEqual(
    asRoomRecord({ room: 'r', roomKey: 'k', label: 'l', pairedAtMs: 1, lastConnectedAtMs: null }),
    { room: 'r', roomKey: 'k', label: 'l', pairedAtMs: 1, lastConnectedAtMs: null },
  );
  // A record written before `lastConnectedAtMs` existed reads as never connected, not as broken.
  assert.deepEqual(
    asRoomRecord({ room: 'r', roomKey: 'k', label: 'l', pairedAtMs: 1 }),
    { room: 'r', roomKey: 'k', label: 'l', pairedAtMs: 1, lastConnectedAtMs: null },
  );
});

test('the identity and the room are the two halves of one pairing record', () => {
  assert.deepEqual(identityOf(RECORD), {
    privateKey: RECORD.privateKey,
    publicKey: RECORD.publicKey,
    deviceId: RECORD.deviceId,
  });
  assert.deepEqual(roomOf(RECORD, 'my laptop', 1700), {
    room: RECORD.room,
    roomKey: RECORD.roomKey,
    label: 'my laptop',
    pairedAtMs: 1700,
    lastConnectedAtMs: null,
  });
});

test('the v1 record migrates into one identity and one room', () => {
  const migrated = migrateLegacy({ ...RECORD }, 4242);
  assert.notEqual(migrated, null);
  assert.deepEqual(migrated?.identity, identityOf(RECORD));
  assert.equal(migrated?.room.room, RECORD.room);
  assert.equal(migrated?.room.roomKey, RECORD.roomKey);
  assert.equal(migrated?.room.pairedAtMs, 4242);
  // The old record had no name; the label says what is actually known rather than inventing one.
  assert.match(migrated?.room.label ?? '', /^paired room-o/);
});

test('a damaged v1 record migrates to nothing instead of to half a pairing', () => {
  for (const broken of [null, 7, {}, { ...RECORD, room: undefined }]) {
    assert.equal(migrateLegacy(broken, 1), null, `expected null for ${JSON.stringify(broken)}`);
  }
});

test('rooms are listed most recently used first, with a stable tiebreak', () => {
  const rooms = [
    { room: 'b', roomKey: 'k', label: 'b', pairedAtMs: 10, lastConnectedAtMs: null },
    { room: 'a', roomKey: 'k', label: 'a', pairedAtMs: 10, lastConnectedAtMs: null },
    { room: 'c', roomKey: 'k', label: 'c', pairedAtMs: 5, lastConnectedAtMs: 99 },
  ];
  assert.deepEqual(
    byMostRecent(rooms).map(room => room.room),
    ['c', 'a', 'b'],
  );
});

test('the in-memory store keeps one identity and as many rooms as are paired', async () => {
  const store = new MemoryRoomStore();
  assert.equal(await store.loadIdentity(), null);
  assert.deepEqual(await store.listRooms(), []);

  const first = await store.remember({ ...RECORD }, 'laptop', 100);
  assert.equal(first.room, 'room-one');
  assert.deepEqual(await store.loadIdentity(), identityOf(RECORD));

  // The whole point of ADR-0007: a second pairing adds a room instead of replacing the first.
  const second = await store.remember(
    { ...RECORD, room: 'room-two', roomKey: 'other-key' },
    'desktop',
    200,
  );
  assert.equal(second.room, 'room-two');
  assert.deepEqual(
    (await store.listRooms()).map(room => room.room),
    ['room-two', 'room-one'],
  );
  assert.equal((await store.loadIdentity())?.deviceId, RECORD.deviceId);

  await store.touch('room-one', 300);
  assert.deepEqual(
    (await store.listRooms()).map(room => room.room),
    ['room-one', 'room-two'],
    'using a room moves it to the top of the list',
  );

  // Re-pairing the same machine keeps when it was first paired and when it was last used: a new
  // authorisation is not a reason to forget that the room has been used.
  const again = await store.remember({ ...RECORD }, 'laptop', 400);
  assert.equal(again.pairedAtMs, 100);
  assert.equal(again.lastConnectedAtMs, 300);

  await store.forget('room-one');
  assert.deepEqual(
    (await store.listRooms()).map(room => room.room),
    ['room-two'],
  );
  assert.notEqual(await store.loadIdentity(), null, 'forgetting a room keeps the identity');

  await store.forgetAll();
  assert.equal(await store.loadIdentity(), null);
  assert.deepEqual(await store.listRooms(), []);
});

test('touching a room that is not stored does nothing', async () => {
  const store = new MemoryRoomStore();
  await store.touch('never-paired', 1);
  assert.deepEqual(await store.listRooms(), []);
});

test('storage failures are named as storage failures', () => {
  // The page shows this sentence to a user whose browser refuses site data; it has to be about
  // storage rather than about pairing, or the advice is wrong.
  const error = new StorageError('something');
  assert.equal(error.name, 'StorageError');
  assert.ok(error instanceof Error);
});
