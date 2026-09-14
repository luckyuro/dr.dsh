/**
 * What this browser keeps between visits: one identity, and one record per room it is paired with.
 *
 * ADR-0007 split these two things apart, and the reason is that they have different lifetimes and
 * different owners:
 *
 * * the **identity** is "this browser" — one Ed25519 key pair, one device id, shared by every room, so
 *   `drdshd devices` shows the same device in each daemon's list and a person can recognise it;
 * * a **room record** is an authorisation — the room key one daemon's pairing handed over, plus what a
 *   person needs to tell two machines apart. Pairing with a second machine adds a record; it does not
 *   replace the first.
 *
 * Before that split there was a single record holding both, so pairing with a second computer silently
 * replaced the first one's key and the browser forgot the machine it had been paired with. That is the
 * failure this module exists to make impossible.
 *
 * The storage is IndexedDB rather than `localStorage`, for one reason that matters here: a record holds
 * a private key and a room key, and `localStorage` is a synchronous string map any synchronous script on
 * the origin can read at any moment. IndexedDB is at least asynchronous and transactional, and it is
 * what a browser keeps for an installed PWA.
 *
 * ## What this does not protect against
 *
 * The shell and the tunnelled DSH interface are served from **the same origin** — the interface is a
 * proxied page under `/__dr/interface`, and its assets come from the same host. Anything this origin can
 * read, the interface's JavaScript can read too. That is a real property of the architecture and not
 * something storage choice fixes; it is written down in `docs/security.md` § 5.8 rather than left for a
 * reader to discover. Separating them needs a second origin, which the relay cannot provide without a
 * second port or a second hostname.
 *
 * @module @dr.dsh/pwa/storage
 */

import type { DeviceRecord, IdentityRecord } from './identity.ts';

/** The database and its object stores. */
const DATABASE = 'dr.dsh';
const IDENTITY_STORE = 'identity';
const ROOMS_STORE = 'rooms';
/** The v1 database's single store, read once during the upgrade and then left alone. */
const LEGACY_STORE = 'device';
const IDENTITY_KEY = 'this-device';
const DATABASE_VERSION = 2;

/** One machine this browser is paired with. */
export interface RoomRecord {
  /** The room id, as the relay names it. Also the storage key. */
  readonly room: string;
  /** The room key pairing handed over, base64url. */
  readonly roomKey: string;
  /** What to call this machine in a list, so two of them are distinguishable. */
  readonly label: string;
  /** When this room was paired, in Unix milliseconds. */
  readonly pairedAtMs: number;
  /** When it was last connected to, in Unix milliseconds; `null` before the first connection. */
  readonly lastConnectedAtMs: number | null;
}

/** Where this browser's pairings live. */
export interface RoomStore {
  /** The identity, or `null` when this browser has never paired. */
  loadIdentity(): Promise<IdentityRecord | null>;
  /** Every room, most recently used first. */
  listRooms(): Promise<RoomRecord[]>;
  /**
   * Stores the identity and the room a pairing produced, as one operation.
   *
   * @param record - what `pairWithCode` returned.
   * @param label - what to call the machine.
   * @param now - the current time, passed in so a test can be deterministic.
   */
  remember(record: DeviceRecord, label: string, now: number): Promise<RoomRecord>;
  /** Records that a room was just connected to. */
  touch(room: string, now: number): Promise<void>;
  /** Forgets one room. The identity stays: the other rooms still need it. */
  forget(room: string): Promise<void>;
  /** Forgets everything, including the identity. */
  forgetAll(): Promise<void>;
}

/** Why the store could not be used. */
export class StorageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'StorageError';
  }
}

/** The identity half of a pairing record: what makes this browser *this device*. */
export function identityOf(record: DeviceRecord): IdentityRecord {
  return {
    privateKey: record.privateKey,
    publicKey: record.publicKey,
    deviceId: record.deviceId,
  };
}

/** The room half of a pairing record, with the bookkeeping fields filled in. */
export function roomOf(record: DeviceRecord, label: string, now: number): RoomRecord {
  return {
    room: record.room,
    roomKey: record.roomKey,
    label,
    pairedAtMs: now,
    lastConnectedAtMs: null,
  };
}

/**
 * Turns the v1 record — identity and room in one object — into the v2 pair.
 *
 * Pure, and separate from the upgrade transaction, so the migration can be tested without a browser:
 * the upgrade is the one moment where getting this wrong loses somebody's pairing, and "it ran once on
 * my machine" is not a way to know it works.
 *
 * @param value - whatever the old store held.
 * @param now - the current time, used for `pairedAtMs` since the old record did not carry one.
 * @returns the identity and the room, or `null` when the value was not a usable record.
 */
export function migrateLegacy(
  value: unknown,
  now: number,
): { readonly identity: IdentityRecord; readonly room: RoomRecord } | null {
  const record = asDeviceRecord(value);
  if (record === null) return null;
  return {
    identity: identityOf(record),
    // The label is derived from the room id: the old record has no name, and inventing a pretty one
    // here would be a claim about which machine this is that the stored data does not support.
    room: roomOf(record, `paired ${record.room.slice(0, 6)}`, now),
  };
}

/**
 * Checks that a value read back from storage still looks like an identity.
 *
 * Storage is not a trust boundary in the cryptographic sense — a record that does not verify fails in
 * `restoreDevice` with a sentence the user can act on — but it is one in the *crash* sense: a
 * half-written value should produce "this browser has no usable pairing" rather than a property access
 * on `undefined` three screens later.
 *
 * @param value - whatever came out of the store.
 */
export function asIdentityRecord(value: unknown): IdentityRecord | null {
  if (value === null || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  for (const field of ['privateKey', 'publicKey', 'deviceId'] as const) {
    if (typeof candidate[field] !== 'string') return null;
  }
  return {
    privateKey: candidate.privateKey as string,
    publicKey: candidate.publicKey as string,
    deviceId: candidate.deviceId as string,
  };
}

/**
 * Checks that a value read back still looks like a room record.
 *
 * @param value - whatever came out of the store.
 */
export function asRoomRecord(value: unknown): RoomRecord | null {
  if (value === null || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  for (const field of ['room', 'roomKey', 'label'] as const) {
    if (typeof candidate[field] !== 'string') return null;
  }
  if (typeof candidate['pairedAtMs'] !== 'number') return null;
  const last = candidate['lastConnectedAtMs'];
  if (last !== null && last !== undefined && typeof last !== 'number') return null;
  return {
    room: candidate.room as string,
    roomKey: candidate.roomKey as string,
    label: candidate.label as string,
    pairedAtMs: candidate.pairedAtMs as number,
    lastConnectedAtMs: typeof last === 'number' ? last : null,
  };
}

/**
 * Checks that a value read back from storage still looks like a pairing record.
 *
 * @param value - whatever came out of the store.
 */
export function asDeviceRecord(value: unknown): DeviceRecord | null {
  const identity = asIdentityRecord(value);
  if (identity === null) return null;
  const candidate = value as Record<string, unknown>;
  for (const field of ['roomKey', 'room'] as const) {
    if (typeof candidate[field] !== 'string') return null;
  }
  return {
    ...identity,
    roomKey: candidate.roomKey as string,
    room: candidate.room as string,
  };
}

/** Sorts rooms the way a list should be shown: most recently used first, then newest pairing. */
export function byMostRecent(rooms: readonly RoomRecord[]): RoomRecord[] {
  return [...rooms].sort((left, right) => {
    const leftSeen = left.lastConnectedAtMs ?? left.pairedAtMs;
    const rightSeen = right.lastConnectedAtMs ?? right.pairedAtMs;
    if (leftSeen !== rightSeen) return rightSeen - leftSeen;
    // A stable tiebreak, so two rooms paired in the same millisecond do not swap places between
    // renders — a list that reorders itself looks like a bug even when the order means nothing.
    return left.room.localeCompare(right.room);
  });
}

/** Opens the database, creating the stores and migrating what v1 held. */
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(
        new StorageError(
          'this browser has no IndexedDB, so a pairing could not be remembered. It still works ' +
            'for this visit; use a browser that stores site data to stay paired.',
        ),
      );
      return;
    }
    const request = indexedDB.open(DATABASE, DATABASE_VERSION);
    request.onupgradeneeded = event => {
      const database = request.result;
      const transaction = request.transaction;
      if (transaction === null) return;
      if (!database.objectStoreNames.contains(IDENTITY_STORE)) {
        database.createObjectStore(IDENTITY_STORE);
      }
      if (!database.objectStoreNames.contains(ROOMS_STORE)) {
        database.createObjectStore(ROOMS_STORE);
      }
      // The migration runs inside the upgrade transaction, which is the only place IndexedDB lets a
      // store from the previous version be read: after this transaction commits, `device` is gone.
      const oldVersion = (event as IDBVersionChangeEvent).oldVersion;
      if (oldVersion >= 1 && oldVersion < 2 && database.objectStoreNames.contains(LEGACY_STORE)) {
        const legacy = transaction.objectStore(LEGACY_STORE);
        const read = legacy.get(IDENTITY_KEY);
        // The old store is deleted in the same upgrade, whether or not the record was usable: it holds
        // a copy of the same private key under an older layout, and a second copy of a key is a second
        // thing to leak. Nothing reads it again — the version check above runs once.
        const finish = () => {
          const migrated = migrateLegacy(read.result, Date.now());
          if (migrated !== null) {
            transaction.objectStore(IDENTITY_STORE).put(migrated.identity, IDENTITY_KEY);
            transaction.objectStore(ROOMS_STORE).put(migrated.room, migrated.room.room);
          }
          database.deleteObjectStore(LEGACY_STORE);
        };
        read.onsuccess = finish;
        read.onerror = finish;
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        new StorageError(`the browser refused to open its device store: ${String(request.error)}`),
      );
    request.onblocked = () =>
      reject(new StorageError('another tab is holding the device store open; close it and retry'));
  });
}

/** Runs one transaction across the given stores. */
async function inTransaction<T>(
  stores: readonly string[],
  mode: IDBTransactionMode,
  work: (transaction: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction([...stores], mode);
      transaction.onabort = () =>
        reject(new StorageError('the device store transaction was aborted'));
      transaction.onerror = () =>
        reject(
          new StorageError(`the device store refused the operation: ${String(transaction.error)}`),
        );
      Promise.resolve(work(transaction)).then(resolve, reject);
    });
  } finally {
    database.close();
  }
}

/** Wraps one request in a promise. */
function ask<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new StorageError(`the device store refused the operation: ${String(request.error)}`));
  });
}

/** The browser's store: IndexedDB, with the v1 record migrated on open. */
export class IndexedDbRoomStore implements RoomStore {
  /** @inheritdoc */
  public async loadIdentity(): Promise<IdentityRecord | null> {
    return await inTransaction([IDENTITY_STORE], 'readonly', async transaction =>
      asIdentityRecord(await ask(transaction.objectStore(IDENTITY_STORE).get(IDENTITY_KEY))),
    );
  }

  /** @inheritdoc */
  public async listRooms(): Promise<RoomRecord[]> {
    return await inTransaction([ROOMS_STORE], 'readonly', async transaction => {
      const values = await ask<unknown[]>(
        transaction.objectStore(ROOMS_STORE).getAll() as IDBRequest<unknown[]>,
      );
      return byMostRecent(
        values.map(asRoomRecord).filter((room): room is RoomRecord => room !== null),
      );
    });
  }

  /** @inheritdoc */
  public async remember(record: DeviceRecord, label: string, now: number): Promise<RoomRecord> {
    const room = roomOf(record, label, now);
    await inTransaction([IDENTITY_STORE, ROOMS_STORE], 'readwrite', transaction => {
      // One transaction for both: a browser that stored the room but not the identity would keep a key
      // it cannot prove it owns, and would fail at the daemon as a revoked device.
      transaction.objectStore(IDENTITY_STORE).put(identityOf(record), IDENTITY_KEY);
      transaction.objectStore(ROOMS_STORE).put(room, room.room);
    });
    return room;
  }

  /** @inheritdoc */
  public async touch(room: string, now: number): Promise<void> {
    await inTransaction([ROOMS_STORE], 'readwrite', async transaction => {
      const store = transaction.objectStore(ROOMS_STORE);
      const current = asRoomRecord(await ask(store.get(room)));
      if (current === null) return;
      store.put({ ...current, lastConnectedAtMs: now }, room);
    });
  }

  /** @inheritdoc */
  public async forget(room: string): Promise<void> {
    await inTransaction([ROOMS_STORE], 'readwrite', transaction => {
      transaction.objectStore(ROOMS_STORE).delete(room);
    });
  }

  /** @inheritdoc */
  public async forgetAll(): Promise<void> {
    await inTransaction([IDENTITY_STORE, ROOMS_STORE], 'readwrite', transaction => {
      transaction.objectStore(IDENTITY_STORE).clear();
      transaction.objectStore(ROOMS_STORE).clear();
    });
  }
}

/**
 * A store that keeps everything in memory.
 *
 * For tests, and for a browser whose storage is unavailable: the honest behaviour there is to work for
 * this visit and say that it will not be remembered, rather than to refuse to pair at all.
 */
export class MemoryRoomStore implements RoomStore {
  private identity: IdentityRecord | null = null;
  private readonly rooms = new Map<string, RoomRecord>();

  /** @inheritdoc */
  public async loadIdentity(): Promise<IdentityRecord | null> {
    return this.identity === null ? null : { ...this.identity };
  }

  /** @inheritdoc */
  public async listRooms(): Promise<RoomRecord[]> {
    return byMostRecent([...this.rooms.values()]);
  }

  /** @inheritdoc */
  public async remember(record: DeviceRecord, label: string, now: number): Promise<RoomRecord> {
    this.identity = identityOf(record);
    const room = roomOf(record, label, now);
    // An existing room keeps its original pairing time and its last-connected time: pairing again is a
    // new authorisation for the same machine, not a reason to forget that it has been used.
    const previous = this.rooms.get(room.room);
    const stored =
      previous === undefined
        ? room
        : { ...room, pairedAtMs: previous.pairedAtMs, lastConnectedAtMs: previous.lastConnectedAtMs };
    this.rooms.set(room.room, stored);
    return stored;
  }

  /** @inheritdoc */
  public async touch(room: string, now: number): Promise<void> {
    const current = this.rooms.get(room);
    if (current === undefined) return;
    this.rooms.set(room, { ...current, lastConnectedAtMs: now });
  }

  /** @inheritdoc */
  public async forget(room: string): Promise<void> {
    this.rooms.delete(room);
  }

  /** @inheritdoc */
  public async forgetAll(): Promise<void> {
    this.identity = null;
    this.rooms.clear();
  }
}
