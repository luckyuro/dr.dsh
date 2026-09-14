/**
 * The device identity a paired client keeps: a long-lived Ed25519 key, its derived id, and
 * the room key pairing produced.
 *
 * The daemon has stored the public half since M1 and challenges every connection with it, so
 * this is the other side of a boundary that already exists. What it adds is that the key is
 * *storable*: the private key is exported as PKCS#8 so it can be written to the browser's
 * storage and imported after a reload, instead of existing only for the lifetime of a tab.
 *
 * ## What is stored, and what that costs
 *
 * A record holds the private key, the public key, the device id, the room key and the room.
 * The room key is here because pairing is the only moment it exists: the daemon derives it
 * from the same exchange, and there is nowhere else for the client to get it. Everything in
 * the record is therefore long-lived key material, and `docs/security.md` says what that
 * means for the origin it is stored under.
 *
 * The id is derived from the public key rather than assigned, so a client and a daemon that
 * agree on the key agree on the id with no round trip — and a store cannot hold a record
 * whose id does not match its key. {@link restoreDeviceIdentity} re-derives it and signs a
 * self-check, because a corrupted record that silently produced a *different* identity would
 * lock the device out with no explanation.
 *
 * @module @dr.dsh/pwa/identity
 */

import { roomIdFor } from './pairing.ts';
import { base64url, base64urlDecode } from './tunnel.ts';

/** Length of an Ed25519 public key in bytes. */
export const DEVICE_PUBLIC_KEY_LEN = 32;

/** Length of a device identifier in bytes: the first 16 bytes of SHA-256(public key). */
export const DEVICE_ID_LEN = 16;

/** Why a stored identity could not be used. */
export class IdentityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'IdentityError';
  }
}

/**
 * What makes this browser *this device*: one key pair and the id derived from it.
 *
 * Shared by every room (ADR-0007). The device id is derived from the public key, so the same browser
 * appears under the same id in every daemon it is paired with — which is what lets a person recognise
 * it in `drdshd devices`.
 */
export interface IdentityRecord {
  /** The private key, PKCS#8, base64url. */
  readonly privateKey: string;
  /** The public key, raw, base64url. */
  readonly publicKey: string;
  /** The device id the daemon knows this key by. */
  readonly deviceId: string;
}

/**
 * A pairing result: the identity plus the room that authorisation is for.
 *
 * Kept as one shape because that is what a pairing exchange produces and what `remember` stores; the
 * store splits it into {@link IdentityRecord} and a room record, and only the room half is per-room.
 */
export interface DeviceRecord extends IdentityRecord {
  /** The room key pairing produced, base64url. */
  readonly roomKey: string;
  /** The room that key names. */
  readonly room: string;
}

/** A usable identity: the stored record plus live key handles. */
export interface Device {
  /** What to persist. */
  readonly record: IdentityRecord;
  /** The key pair the tunnel signs with. */
  readonly keyPair: CryptoKeyPair;
  /** The raw public key bytes. */
  readonly publicKeyBytes: Uint8Array<ArrayBuffer>;
}

/**
 * Derives a device id from a public key.
 *
 * @param publicKey - the 32-byte Ed25519 public key.
 */
export async function deviceIdFor(publicKey: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey));
  return base64url(digest.slice(0, DEVICE_ID_LEN));
}

/** Exports the raw public key of an Ed25519 key pair. */
async function rawPublicKey(keyPair: CryptoKeyPair): Promise<Uint8Array<ArrayBuffer>> {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  if (raw.length !== DEVICE_PUBLIC_KEY_LEN) {
    throw new IdentityError(
      `an Ed25519 public key is ${DEVICE_PUBLIC_KEY_LEN} bytes, got ${raw.length}`,
    );
  }
  return raw;
}

/**
 * Generates a fresh identity.
 *
 * Extractable, unlike the handles {@link restoreDeviceIdentity} returns: this key exists in
 * order to be written down, and a key that cannot be exported cannot be restored after a
 * reload.
 */
export async function generateDevice(): Promise<Device> {
  const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicKeyBytes = await rawPublicKey(keyPair);
  const privateKey = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  return {
    keyPair,
    publicKeyBytes,
    record: {
      privateKey: base64url(privateKey),
      publicKey: base64url(publicKeyBytes),
      deviceId: await deviceIdFor(publicKeyBytes),
    },
  };
}

/**
 * Rebuilds an identity from its record.
 *
 * The id is re-derived and the key pair is made to sign and verify a fixed message, so a
 * record that has been damaged — truncated, re-encoded, or written by a different version —
 * fails here rather than as an authentication failure against the daemon, where it would look
 * like a revoked device.
 *
 * @param record - the stored record.
 * @throws IdentityError when the record does not describe a usable, self-consistent identity.
 */
export async function restoreDevice(record: IdentityRecord): Promise<Device> {
  let privateKeyBytes: Uint8Array<ArrayBuffer>;
  let publicKeyBytes: Uint8Array<ArrayBuffer>;
  try {
    privateKeyBytes = base64urlDecode(record.privateKey);
    publicKeyBytes = base64urlDecode(record.publicKey);
  } catch {
    throw new IdentityError('the stored device key is not base64url');
  }
  if (publicKeyBytes.length !== DEVICE_PUBLIC_KEY_LEN) {
    throw new IdentityError(
      `the stored public key is ${DEVICE_PUBLIC_KEY_LEN} bytes, got ${publicKeyBytes.length}`,
    );
  }
  let keyPair: CryptoKeyPair;
  try {
    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      privateKeyBytes,
      { name: 'Ed25519' },
      true,
      ['sign'],
    );
    const publicKey = await crypto.subtle.importKey(
      'raw',
      publicKeyBytes,
      { name: 'Ed25519' },
      true,
      ['verify'],
    );
    keyPair = { privateKey, publicKey };
  } catch {
    throw new IdentityError('the stored device key is not a usable Ed25519 key');
  }

  // A record whose halves do not belong together is worse than a missing one: the device
  // would look paired right up to the daemon's challenge, which answers "not paired".
  const selfCheck = new TextEncoder().encode('dsh-remote/v1/self-check');
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, keyPair.privateKey, selfCheck));
  const verified = await crypto.subtle.verify(
    { name: 'Ed25519' },
    keyPair.publicKey,
    signature,
    selfCheck,
  );
  if (!verified) {
    throw new IdentityError(
      'the stored device key does not match its public half; pair this device again',
    );
  }

  const derivedId = await deviceIdFor(publicKeyBytes);
  if (record.deviceId !== derivedId) {
    throw new IdentityError(
      `the stored device id does not match its key: expected ${derivedId}, found ${record.deviceId}`,
    );
  }

  // Non-extractable handles for the caller: the key has been read once, and nothing in the
  // session layer needs to export it again.
  const usable: CryptoKeyPair = {
    privateKey: await crypto.subtle.importKey(
      'pkcs8',
      privateKeyBytes,
      { name: 'Ed25519' },
      false,
      ['sign'],
    ),
    publicKey: await crypto.subtle.importKey(
      'raw',
      publicKeyBytes,
      { name: 'Ed25519' },
      false,
      ['verify'],
    ),
  };
  return { record, keyPair: usable, publicKeyBytes };
}

/**
 * Checks that a stored room key actually names the room it claims.
 *
 * The two are written together by pairing and read together here, so a disagreement means the room
 * record was edited, truncated across a write, or produced by a version whose derivation differed.
 * Left unchecked it surfaces as "no daemon is serving this room" about a room the user was told they
 * were paired to — which is why this runs *before* a socket is opened, and not by connecting and
 * reading the relay's answer.
 *
 * Split out of `restoreDevice` when ADR-0007 made the identity shared and the room per-room: the
 * identity no longer carries a room, so the check belongs where a room record is about to be used.
 *
 * @param roomKey - the room key, base64url.
 * @param room - the room id the record claims.
 * @throws IdentityError when the key is not a room key or names a different room.
 */
export async function checkRoom(roomKey: string, room: string): Promise<void> {
  let roomKeyBytes: Uint8Array<ArrayBuffer>;
  try {
    roomKeyBytes = base64urlDecode(roomKey);
  } catch {
    throw new IdentityError('the stored room key is not base64url');
  }
  if (roomKeyBytes.length !== 32) {
    throw new IdentityError(`the stored room key is 32 bytes, got ${roomKeyBytes.length}`);
  }
  const derivedRoom = await roomIdFor(roomKeyBytes);
  if (room !== derivedRoom) {
    throw new IdentityError(
      `the stored room does not match its key: the key names ${derivedRoom}, the record says ` +
        `${room}. Pair this device again.`,
    );
  }
}

/**
 * Fills in the room key and room pairing produced.
 *
 * @param device - the freshly generated device.
 * @param roomKey - the 32-byte root key from pairing.
 * @param room - the room that key names.
 * @throws IdentityError when the key is not 32 bytes.
 */
export function withRoom(
  device: Device,
  roomKey: Uint8Array<ArrayBuffer>,
  room: string,
): DeviceRecord {
  if (roomKey.length !== 32) {
    throw new IdentityError(`a room key is 32 bytes, got ${roomKey.length}`);
  }
  return { ...device.record, roomKey: base64url(roomKey), room };
}
