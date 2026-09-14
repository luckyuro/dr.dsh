/**
 * The pairing exchange, against a stand-in daemon that verifies like the real one.
 *
 * The stand-in is not a recording: it runs the same PAKE in the opposite role
 * (`Spake2State`), checks the enrolment confirmation the way `DaemonPairing::finish` does, and
 * derives the room key from the exchange. A canned response would test this client against a
 * transcript, which is exactly the blind spot that let a named-close defect survive here for
 * several rounds.
 *
 * What the real daemon adds — the rendezvous room derivation, the registry write, the throttle
 * — is covered by `scripts/pwa-pairing-smoke.mjs` against a real `drdshd pair` on a real relay.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PairingError,
  deriveEnrolmentKey,
  enrolmentConfirmation,
  formatPairingCode,
  pairingTransportRoot,
  roomIdFor,
  sealRoomKey,
} from './pairing.ts';
import { Spake2State } from './spake2.ts';
import { SIDE_DAEMON } from './spake2.ts';
import { pairWithCode, type PairingHost, type PairingPhase } from './pair.ts';
import { deviceIdFor } from './identity.ts';
import { decodeField } from './pairing.ts';
import {
  CONTROL_STREAM,
  LABELS,
  Tunnel,
  additionalData,
  carrier,
  deriveKey,
  nonceBytes,
  parseCarrier,
  type TunnelSocket,
} from './tunnel.ts';
import { base64url } from './tunnel.ts';

/** The code the client will type. */
const CLIENT_CODE = '7f3a9105c4';

/** The daemon's code; different in the tests that check a wrong code. */
const DAEMON_CODE = '7f3a9105c4';

/** A label the daemon stores. */
const DEVICE_NAME = 'test phone';

/** The room key the stand-in daemon serves, and the one the device must end up with. */
const SERVED_ROOM_KEY = new Uint8Array(32).fill(0x5a);

/** A nonce for the receipt; the real daemon draws a fresh one per receipt. */
const RECEIPT_NONCE = new Uint8Array(12).fill(0x11);

/** How a stand-in daemon should behave. */
interface StandInOptions {
  /** The daemon's code. Defaults to the client's. */
  readonly code?: Uint8Array<ArrayBuffer>;
  /** Refuse immediately with this reason, before the PAKE. */
  readonly reject?: string;
  /** Send exactly these bytes as the first message. */
  readonly firstMessage?: Uint8Array<ArrayBuffer>;
  /** How far the stand-in gets before going quiet. */
  readonly silent?: 'handshake' | 'pake';
  /** Announce this room instead of the one the served key derives. */
  readonly announceRoom?: string;
  /** Seal a different key than the one the room is derived from, to check the client's check. */
  readonly serveOtherKey?: boolean;
  /** Announce this device id instead of the derived one. */
  readonly announceDeviceId?: string;
}

/** What the stand-in daemon saw, so a test can assert on the exchange itself. */
interface StandInRecord {
  /** The payloads the client sent, in order, as text or hex. */
  readonly received: string[];
  /** Whether the confirmation the client sent verified under the exchanged key. */
  confirmValid: boolean;
  /** The public key the client enrolled. */
  publicKeyHex: string;
  /** Whether the daemon saw the enrolment at all. */
  enrolled: boolean;
}

/** Hex, for failure messages. */
function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Parses the hex code the tests use. */
function secret(text: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(text.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * A daemon on the other end of an in-memory socket.
 *
 * It performs the session handshake exactly as `dr-dsh-daemon` does — provisional session, salt,
 * acknowledgement, then the real session with the counters carried across — and then the four
 * pairing messages.
 */
async function standInDaemon(options: StandInOptions = {}): Promise<{
  socket: TunnelSocket;
  record: StandInRecord;
}> {
  const record: StandInRecord = {
    received: [],
    confirmValid: false,
    publicKeyHex: '',
    enrolled: false,
  };
  const handlers: ((data: Uint8Array<ArrayBuffer>) => void)[] = [];
  const closeHandlers: ((reason: string) => void)[] = [];
  const root = await pairingTransportRoot();

  let openKey = await deriveKey(root, new Uint8Array(32), LABELS.clientToDaemon);
  let sealKey = await deriveKey(root, new Uint8Array(32), LABELS.daemonToClient);
  let sealCounter = 0;
  let adopted = false;
  let step = 0;

  // A daemon always holds a code; a case that wants a *different* one passes `code`.
  const daemon = await Spake2State.start('daemon', options.code ?? secret(DAEMON_CODE));
  let exchanged: Uint8Array<ArrayBuffer> | null = null;

  const deliver = (payload: Uint8Array<ArrayBuffer>): void => {
    for (const handler of [...handlers]) handler(payload);
  };

  /** Seals a payload and sends it as a control frame. */
  const send = async (payload: Uint8Array<ArrayBuffer>): Promise<void> => {
    const counter = sealCounter;
    sealCounter += 1;
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: nonceBytes(counter),
          additionalData: additionalData(CONTROL_STREAM, counter),
        },
        sealKey,
        payload,
      ),
    );
    const body = new Uint8Array(8 + sealed.length);
    new DataView(body.buffer).setBigUint64(0, BigInt(counter), false);
    body.set(sealed, 8);
    deliver(carrier(CONTROL_STREAM, body));
  };

  let chain: Promise<void> = Promise.resolve();

  /** Handles one payload from the client, in arrival order. */
  const receiveOne = async (payload: Uint8Array<ArrayBuffer>): Promise<void> => {
    if (!adopted) {
      // The connection salt, sealed under the provisional session.
      openKey = await deriveKey(root, payload, LABELS.clientToDaemon);
      sealKey = await deriveKey(root, payload, LABELS.daemonToClient);
      adopted = true;
      if (options.silent === 'handshake') return;
      // The acknowledgement, then whatever this case wants: back to back, as the real daemon
      // writes them, so a client that intercepts one frame too many fails here. A refusal comes
      // *after* the acknowledgement, because a real daemon must have a session before it can
      // answer on one.
      await send(new TextEncoder().encode('k'));
      if (options.reject !== undefined) {
        await send(new TextEncoder().encode(JSON.stringify({ type: 'pair_reject', reason: options.reject })));
        return;
      }
      if (options.silent === 'pake') return;
      if (options.firstMessage !== undefined) {
        await send(options.firstMessage);
      } else if (daemon !== null) {
        await send(daemon.message);
      }
      return;
    }
    if (step === 0) {
      step = 1;
      record.received.push(hex(payload));
      try {
        exchanged = await daemon.state.finish(payload);
        record.confirmValid = true;
      } catch {
        record.confirmValid = false;
      }
      return;
    }
    // The enrolment.
    const parsed = JSON.parse(new TextDecoder().decode(payload)) as {
      device_name: string;
      device_public_key: number[];
      confirm: number[];
    };
    record.received.push(parsed.device_name);
    const publicKey = new Uint8Array(parsed.device_public_key);
    record.publicKeyHex = hex(publicKey);
    if (exchanged === null) {
      await send(new TextEncoder().encode(JSON.stringify({ type: 'pair_reject', reason: 'pairing_failed' })));
      return;
    }
    const expected = await enrolmentConfirmation(exchanged, publicKey);
    if (hex(expected) !== hex(new Uint8Array(parsed.confirm))) {
      await send(new TextEncoder().encode(JSON.stringify({ type: 'pair_reject', reason: 'pairing_failed' })));
      return;
    }
    const enrolmentKey = await deriveEnrolmentKey(exchanged);
    // `serveOtherKey` seals one key while announcing the room of another: the mismatch the
    // client must refuse rather than store.
    const sealedKey = options.serveOtherKey === true ? new Uint8Array(32).fill(0x11) : SERVED_ROOM_KEY;
    const announcedKey = options.serveOtherKey === true ? SERVED_ROOM_KEY : sealedKey;
    const sealed = await sealRoomKey(enrolmentKey, publicKey, sealedKey, RECEIPT_NONCE);
    record.enrolled = true;
    await send(
      new TextEncoder().encode(
        JSON.stringify({
          type: 'pair_accept',
          device_id: options.announceDeviceId ?? (await deviceIdFor(publicKey)),
          root_key: base64url(sealed),
          room: options.announceRoom ?? (await roomIdFor(announcedKey)),
        }),
      ),
    );
  };

  const socket: TunnelSocket = {
    send(data) {
      chain = chain.then(async () => {
        const { body } = parseCarrier(data);
        const counter = Number(
          new DataView(body.buffer, body.byteOffset, body.byteLength).getBigUint64(0, false),
        );
        const plaintext = new Uint8Array(
          await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: nonceBytes(counter), additionalData: additionalData(CONTROL_STREAM, counter) },
            openKey,
            body.subarray(8),
          ),
        );
        await receiveOne(plaintext);
      });
    },
    receive(handler) {
      handlers.push(handler);
    },
    closed(handler) {
      closeHandlers.push(handler);
    },
    close() {
      for (const handler of [...closeHandlers]) handler('the client closed the pairing room');
    },
  };
  return { socket, record };
}

/** A host that reports into an array and connects to a stand-in daemon. */
function hostFor(socket: TunnelSocket): { host: PairingHost; phases: PairingPhase[] } {
  const phases: PairingPhase[] = [];
  return {
    phases,
    host: {
      connect: async () => socket,
      report: phase => phases.push(phase),
    },
  };
}

test('pairing a second machine presents the identity the browser already has', async () => {
  // ADR-0007: one identity, many rooms. The failure this prevents was found by the two-room browser
  // smoke — a second pairing generated a fresh key, so the *first* daemon answered "this device is not
  // paired with that daemon any more" and the first machine became unreachable without a word.
  const first = await standInDaemon();
  const enrolled = await pairWithCode(hostFor(first.socket).host, {
    code: formatPairingCode(secret(CLIENT_CODE)),
    deviceName: DEVICE_NAME,
  });
  const existing = {
    privateKey: enrolled.record.privateKey,
    publicKey: enrolled.record.publicKey,
    deviceId: enrolled.record.deviceId,
  };

  const second = await standInDaemon();
  const again = await pairWithCode(hostFor(second.socket).host, {
    code: formatPairingCode(secret(CLIENT_CODE)),
    deviceName: DEVICE_NAME,
    identity: existing,
  });

  // The second daemon enrolled the same device: same public key, same id.
  assert.equal(again.deviceId, enrolled.deviceId);
  assert.equal(hex(again.device.publicKeyBytes), hex(enrolled.device.publicKeyBytes));
  assert.deepEqual(again.record, {
    ...existing,
    roomKey: again.record.roomKey,
    room: again.record.room,
  });
  // The room comes from the daemon's receipt, not from the client, and both stand-ins serve the same
  // room key — so this is a re-pairing of the same room with the same identity, which is the case that
  // matters here: the identity survived the second exchange unchanged.

  // Without an identity the old behaviour is kept: a first pairing has nothing to reuse.
  const third = await standInDaemon();
  const fresh = await pairWithCode(hostFor(third.socket).host, {
    code: formatPairingCode(secret(CLIENT_CODE)),
    deviceName: DEVICE_NAME,
  });
  assert.notEqual(fresh.deviceId, enrolled.deviceId);
});

test('a code typed by a user becomes an enrolled device', async () => {
  const { socket, record } = await standInDaemon();
  const { host, phases } = hostFor(socket);

  const paired = await pairWithCode(host, {
    code: formatPairingCode(secret(CLIENT_CODE)),
    deviceName: DEVICE_NAME,
  });

  assert.equal(record.enrolled, true, 'the daemon must have verified the enrolment');
  assert.equal(record.confirmValid, true, 'the confirmation must verify under the exchanged key');
  assert.equal(record.publicKeyHex, hex(paired.device.publicKeyBytes));
  assert.equal(record.received.length, 2, 'one PAKE message and one enrolment, and nothing else');

  // The record is what the client has to keep, and everything in it has to be consistent.
  assert.equal(paired.record.deviceId, await deviceIdFor(paired.device.publicKeyBytes));
  assert.equal(paired.deviceId, paired.record.deviceId);
  assert.equal(paired.record.room, paired.room);
  assert.equal(paired.roomKey.length, 32);
  assert.equal(base64url(paired.roomKey), paired.record.roomKey);
  // The heart of it: the device ends up with the key the daemon serves, not with a key derived
  // from the exchange. Announcing the derived one was a real defect — a freshly paired device
  // then dialled a room nobody served.
  assert.deepEqual(paired.roomKey, SERVED_ROOM_KEY);
  assert.equal(paired.room, await roomIdFor(SERVED_ROOM_KEY));
  assert.deepEqual(
    phases.map(phase => phase.phase),
    ['connecting', 'waiting', 'paired'],
  );
});

test('a wrong code fails at the daemon and writes no identity', async () => {
  const { socket, record } = await standInDaemon({ code: secret('7f3a9105c5') });
  const { host, phases } = hostFor(socket);

  await assert.rejects(
    () =>
      pairWithCode(host, { code: formatPairingCode(secret(CLIENT_CODE)), deviceName: DEVICE_NAME }),
    /the code does not match/,
  );
  assert.equal(record.enrolled, false);
  assert.equal(phases.at(-1)?.phase, 'failed');
});

test('a refusal before the PAKE is reported in the daemon’s own words', async () => {
  const { socket } = await standInDaemon({ reject: 'the daemon is rate limiting pairing' });
  const { host } = hostFor(socket);

  await assert.rejects(
    () =>
      pairWithCode(host, { code: formatPairingCode(secret(CLIENT_CODE)), deviceName: DEVICE_NAME }),
    /the daemon is rate limiting pairing/,
  );
});

test('a daemon that answers the handshake and then nothing is a timeout, not a hang', async () => {
  const { socket } = await standInDaemon({ silent: 'pake' });
  const { host } = hostFor(socket);

  await assert.rejects(
    () =>
      pairWithCode(host, {
        code: formatPairingCode(secret(CLIENT_CODE)),
        deviceName: DEVICE_NAME,
        timeoutMs: 30,
      }),
    /did not send its half of the PAKE within/,
  );
});

test('a room nobody answers is bounded too, rather than a spinner', async () => {
  // The relay accepts the parking as long as a daemon is registered, so a daemon that died a
  // moment ago looks exactly like a live one until the acknowledgement fails to arrive.
  const { socket } = await standInDaemon({ silent: 'handshake' });
  const { host, phases } = hostFor(socket);

  await assert.rejects(
    () =>
      pairWithCode(host, {
        code: formatPairingCode(secret(CLIENT_CODE)),
        deviceName: DEVICE_NAME,
        timeoutMs: 30,
      }),
    /no daemon answered in the pairing room/,
  );
  assert.equal(phases.at(-1)?.phase, 'failed');
});

test('an acceptance for a room the key does not derive is refused', async () => {
  const { socket } = await standInDaemon({ announceRoom: 'a-room-nobody-serves' });
  const { host } = hostFor(socket);

  await assert.rejects(
    () =>
      pairWithCode(host, { code: formatPairingCode(secret(CLIENT_CODE)), deviceName: DEVICE_NAME }),
    /room key in its receipt does not derive/,
  );
});

test('a receipt carrying a different room key than the room announced is refused', async () => {
  // The receipt is sealed by the peer that completed the PAKE, so this is the failure mode a
  // substituted or mismatched receipt produces, and it must be a refusal rather than a device
  // that stores a key it cannot use.
  const { socket } = await standInDaemon({ serveOtherKey: true });
  const { host } = hostFor(socket);

  await assert.rejects(
    () =>
      pairWithCode(host, { code: formatPairingCode(secret(CLIENT_CODE)), deviceName: DEVICE_NAME }),
    /room key in its receipt does not derive/,
  );
});

test('an acceptance naming another device is refused', async () => {
  const { socket } = await standInDaemon({ announceDeviceId: 'AAAAAAAAAAAAAAAAAAAAAA' });
  const { host } = hostFor(socket);

  await assert.rejects(
    () =>
      pairWithCode(host, { code: formatPairingCode(secret(CLIENT_CODE)), deviceName: DEVICE_NAME }),
    /enrolled a different device id/,
  );
});

test('a first message that is not a SPAKE2 message is refused by name', async () => {
  const { socket } = await standInDaemon({ firstMessage: new Uint8Array([1, 2, 3]) });
  const { host } = hostFor(socket);

  await assert.rejects(
    () =>
      pairWithCode(host, { code: formatPairingCode(secret(CLIENT_CODE)), deviceName: DEVICE_NAME }),
    /3 bytes where a 33-byte SPAKE2 message was expected/,
  );
});

test('a code that is not a code never opens a socket', async () => {
  let connected = false;
  const phases: PairingPhase[] = [];
  await assert.rejects(
    () =>
      pairWithCode(
        {
          connect: async () => {
            connected = true;
            throw new Error('this must not be reached');
          },
          report: phase => phases.push(phase),
        },
        { code: 'not a code', deviceName: DEVICE_NAME },
      ),
    PairingError,
  );
  assert.equal(connected, false, 'a malformed code must be refused before anything is dialled');
});

test('the pairing connection runs with the device step off, and a normal one with it on', async () => {
  // The step is what the pairing room cannot have: it intercepts control frames, and the PAKE
  // message is a control frame. This pins that the option is honoured rather than merely
  // accepted — a pairing tunnel whose step were on would hang after the acknowledgement.
  const root = await pairingTransportRoot();
  const { socket } = await standInDaemon({ silent: 'pake' });
  const tunnel = await Tunnel.open(socket, root, null, { deviceStep: false });
  assert.equal(tunnel.isEstablished, true);
  assert.equal(tunnel.isDeviceBound, true, 'a tunnel with no device step is bound by construction');
  tunnel.close();

  // With the step on — the default for every other connection — the same room cannot be used at
  // all: the step owns the control stream and reads the daemon's PAKE message as if it were a
  // device challenge. That failure is the reason the option exists.
  const second = await standInDaemon();
  await assert.rejects(
    () => Tunnel.open(second.socket, root, null, { deviceStep: true }),
    Error,
    'the pairing room must not be usable with the device step on',
  );
});

test('the enrolled public key is the one the client generated', async () => {
  const { socket, record } = await standInDaemon();
  const { host } = hostFor(socket);
  const paired = await pairWithCode(host, {
    code: formatPairingCode(secret(CLIENT_CODE)),
    deviceName: DEVICE_NAME,
  });
  // A 32-byte Ed25519 public key, and the same one the stand-in daemon verified the
  // confirmation against: an enrolment of some *other* key would make the device unable to
  // authenticate later while looking perfectly paired now.
  assert.equal(paired.device.publicKeyBytes.length, 32);
  assert.equal(record.publicKeyHex, hex(paired.device.publicKeyBytes));
  assert.equal(decodeField(paired.record.publicKey, 32, 'the public key').length, 32);
});

test('the daemon code the tests use is the client code unless a case says otherwise', () => {
  assert.equal(DAEMON_CODE, CLIENT_CODE);
  assert.equal(SIDE_DAEMON, 0x42);
});
