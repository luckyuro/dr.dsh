/**
 * The client's half of device authentication.
 *
 * The daemon asks a reconnecting client to prove it is an enrolled device, and this is the
 * client answering. What is checked here is the part that only exists on this side: that the
 * signature covers the nonce *and the room*, that the acceptance is awaited before the tunnel
 * is handed out, and that a refusal becomes a comprehensible error rather than a hang.
 *
 * The stand-in daemon verifies the signature with WebCrypto against the same public key the
 * client generated, so a client that signed the wrong bytes fails here rather than in
 * production.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import type { DeviceIdentity } from './tunnel.ts';
import {
  CONTROL_STREAM,
  LABELS,
  Tunnel,
  TunnelError,
  additionalData,
  carrier,
  deriveKey,
  nonceBytes,
  parseCarrier,
} from './tunnel.ts';

const ROOT = new Uint8Array(32).fill(7);
const ROOM = 'the-room-the-client-was-told-about';

/** A stand-in daemon that challenges its client and can be told to refuse. */
async function fakeDaemon(
  devicePublicKey: CryptoKey,
  options: {
    readonly refuse?: 'not_paired' | 'bad_proof';
    /** Whether the daemon refuses before a response arrives, which is what an unpaired client sees. */
    readonly refuseUnpaired?: boolean;
    /** Whether the daemon says nothing at all after its acknowledgement, as an unpaired daemon does. */
    readonly silentAfterAck?: boolean;
  } = {},
) {
  const handlers: ((data: Uint8Array<ArrayBuffer>) => void)[] = [];
  const closeHandlers: ((reason: string) => void)[] = [];
  const seen: { streamId: number; payload: Uint8Array<ArrayBuffer> }[] = [];
  const nonce = crypto.getRandomValues(new Uint8Array(32));

  let openKey = await deriveKey(ROOT, new Uint8Array(32), LABELS.clientToDaemon);
  let sealKey = await deriveKey(ROOT, new Uint8Array(32), LABELS.daemonToClient);
  let openCounter = 0;
  let sealCounter = 0;
  let adopted = false;
  let chain: Promise<void> = Promise.resolve();

  /** What the daemon learned from the response, for the test to assert on. */
  const result: {
    signatureValid: boolean | undefined;
    deviceId: string | undefined;
  } = { signatureValid: undefined, deviceId: undefined };

  const deliver = (frame: Uint8Array<ArrayBuffer>): void => {
    for (const handler of [...handlers]) handler(frame);
  };

  async function seal(streamId: number, payload: Uint8Array<ArrayBuffer>): Promise<void> {
    const counter = sealCounter;
    sealCounter += 1;
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: nonceBytes(counter),
          additionalData: additionalData(streamId, counter),
        },
        sealKey,
        payload,
      ),
    );
    const body = new Uint8Array(8 + sealed.length);
    new DataView(body.buffer).setBigUint64(0, BigInt(counter), false);
    body.set(sealed, 8);
    deliver(carrier(streamId, body));
  }

  async function handle(frame: Uint8Array<ArrayBuffer>): Promise<void> {
    const { streamId, body } = parseCarrier(frame);
    const counter = Number(
      new DataView(body.buffer, body.byteOffset, body.byteLength).getBigUint64(0, false),
    );
    assert.equal(counter, openCounter, 'the daemon expects the next counter');
    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: nonceBytes(counter),
          additionalData: additionalData(streamId, counter),
        },
        openKey,
        body.subarray(8),
      ),
    );
    openCounter += 1;

    if (!adopted) {
      adopted = true;
      sealKey = await deriveKey(ROOT, plaintext, LABELS.daemonToClient);
      openKey = await deriveKey(ROOT, plaintext, LABELS.clientToDaemon);
      sealCounter = 0;
      await seal(CONTROL_STREAM, new Uint8Array([0x6b]));
      if (options.silentAfterAck === true) return;
      if (options.refuse !== undefined && options.refuseUnpaired === true) {
        // A client with no identity cannot answer, so the daemon does not wait for one: it
        // refuses and closes. Both halves matter — a refusal that did not close would leave
        // the client waiting for a frame that is never coming.
        await seal(
          CONTROL_STREAM,
          new TextEncoder().encode(
            JSON.stringify({ type: 'resume_reject', reason: options.refuse }),
          ),
        );
        for (const handler of [...closeHandlers]) {
          handler('the daemon closed the connection after refusing this device');
        }
        return;
      }
      // The device step begins immediately after the acknowledgement, with no frame from the
      // client in between: this daemon writes its challenge and then reads the answer. A
      // stand-in that waited for a client frame here would accept a client the real daemon
      // refuses, which is how a stray confirmation frame survived several rounds.
      await seal(
        CONTROL_STREAM,
        new TextEncoder().encode(JSON.stringify({ type: 'resume_challenge', nonce: toBase64url(nonce) })),
      );
      return;
    }

    const message = JSON.parse(new TextDecoder().decode(plaintext)) as {
      type?: string;
      device_id?: string;
      signature?: string;
    };
    if (message.type !== 'resume_response') {
      seen.push({ streamId, payload: plaintext });
      return;
    }
    result.deviceId = message.device_id;
    if (options.refuse !== undefined) {
      await seal(
        CONTROL_STREAM,
        new TextEncoder().encode(
          JSON.stringify({ type: 'resume_reject', reason: options.refuse }),
        ),
      );
      return;
    }
    // The signed bytes are checked against the room the daemon believes it is serving: a
    // client that signed the nonce alone would still verify here, which is why the room is
    // reconstructed rather than taken from the response.
    const signature = fromBase64url(message.signature ?? '');
    const signed = new Uint8Array(nonce.length + ROOM.length);
    signed.set(nonce, 0);
    signed.set(new TextEncoder().encode(ROOM), nonce.length);
    result.signatureValid = await crypto.subtle.verify(
      { name: 'Ed25519' },
      devicePublicKey,
      signature,
      signed,
    );
    await seal(
      CONTROL_STREAM,
      new TextEncoder().encode(JSON.stringify({ type: 'resume_accept' })),
    );
  }

  const fake = {
    seen,
    result,
    push: deliver,
    drop(reason: string) {
      for (const handler of [...closeHandlers]) handler(reason);
    },
    socket: {
      send(data: Uint8Array<ArrayBuffer>) {
        chain = chain.then(() => handle(data));
        chain = chain.catch(() => {});
      },
      receive(handler: (data: Uint8Array<ArrayBuffer>) => void) {
        handlers.push(handler);
      },
      closed(handler: (reason: string) => void) {
        closeHandlers.push(handler);
      },
      close() {},
    },
  };
  return fake;
}

/** Derives the device id the way both ends do: the first 16 bytes of SHA-256(public key). */
async function deviceIdFor(publicKey: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey));
  return toBase64url(digest.subarray(0, 16));
}

function toBase64url(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Builds a paired device: a key pair, its derived id, and the identity the client holds. */
async function pairedDevice(): Promise<{
  identity: DeviceIdentity;
  publicKey: CryptoKey;
  deviceId: string;
}> {
  const key = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicBytes = new Uint8Array(await crypto.subtle.exportKey('raw', key.publicKey));
  const deviceId = await deviceIdFor(publicBytes);
  return { identity: { deviceId, room: ROOM, key }, publicKey: key.publicKey, deviceId };
}

const opened: Tunnel[] = [];
afterEach(() => {
  for (const tunnel of opened.splice(0)) tunnel.close();
});

test('a client answers the challenge and is accepted', async () => {
  // A paired device reconnecting: the daemon holds the public key from pairing, and the client
  // holds the private half it kept.
  const { identity, publicKey, deviceId } = await pairedDevice();
  const fake = await fakeDaemon(publicKey);
  const tunnel = await Tunnel.open(fake.socket, ROOT, identity);
  opened.push(tunnel);

  assert.equal(tunnel.isEstablished, true);
  assert.equal(tunnel.isDeviceBound, true, 'the daemon accepted the device');
  assert.equal(
    fake.result.signatureValid,
    true,
    'the signature must verify over nonce || room',
  );
  assert.equal(fake.result.deviceId, deviceId);
});

test('a refusal becomes an error naming the reason, not a hang', async () => {
  const { identity, publicKey } = await pairedDevice();
  const fake = await fakeDaemon(publicKey, { refuse: 'not_paired' });
  await assert.rejects(
    Tunnel.open(fake.socket, ROOT, identity),
    (error: unknown) =>
      error instanceof TunnelError && /not paired/.test((error as Error).message),
  );
});

test('an unpaired client is told it is not paired instead of waiting forever', async () => {
  // The daemon requires a device and this client has none: it cannot answer, and the daemon
  // will not let it through. What must not happen is a tunnel that reports itself established
  // and then never serves a request — which is what shipped before this test existed, because
  // the client waited for a challenge only when it had an identity to answer with.
  const { publicKey } = await pairedDevice();
  const fake = await fakeDaemon(publicKey, { refuse: 'not_paired', refuseUnpaired: true });
  await assert.rejects(Tunnel.open(fake.socket, ROOT), (error: unknown) => {
    assert.ok(error instanceof TunnelError, `expected a TunnelError, got ${String(error)}`);
    // Either wording is a correct outcome: the client may read the refusal, or it may only see
    // the connection close. What is *not* acceptable is a tunnel that reports itself
    // established — which is what shipped before this test existed.
    assert.match(
      (error as Error).message,
      /not paired|closed|refused/,
      `the failure must name what happened: ${(error as Error).message}`,
    );
    return true;
  });
});

test('a silent daemon is taken as requiring no device', async () => {
  // Every connection runs the device step, and a daemon that requires no proof says nothing.
  // What must not happen is waiting on that silence forever: the step settles after a short
  // grace period, which is what makes a daemon that has never been paired usable at all.
  const { publicKey } = await pairedDevice();
  const fake = await fakeDaemon(publicKey, { silentAfterAck: true });
  const tunnel = await Tunnel.open(fake.socket, ROOT);
  opened.push(tunnel);
  assert.equal(tunnel.isEstablished, true);
  assert.equal(tunnel.isDeviceBound, true, 'silence means no proof was required');
});

test('an unpaired client is told it is not paired instead of waiting forever', async () => {
  // The daemon requires a device and this client has none: it cannot answer, and the daemon
  // will not let it through. What must not happen is a tunnel that reports itself established
  // and then never serves a request — which is what shipped before this test existed, because
  // the client waited for a challenge only when it had an identity to answer with.
  const { publicKey } = await pairedDevice();
  const fake = await fakeDaemon(publicKey, { refuse: 'not_paired', refuseUnpaired: true });
  await assert.rejects(Tunnel.open(fake.socket, ROOT), (error: unknown) => {
    assert.ok(error instanceof TunnelError, `expected a TunnelError, got ${String(error)}`);
    // Either wording is a correct outcome: the client may read the refusal, or it may only see
    // the connection close. What is *not* acceptable is a tunnel that reports itself
    // established — which is what shipped before this test existed.
    assert.match(
      (error as Error).message,
      /not paired|closed|refused/,
      `the failure must name what happened: ${(error as Error).message}`,
    );
    return true;
  });
});

test('a signature over the nonce alone is not accepted', async () => {
  // The room is part of what is signed, so a response captured on one room cannot be replayed
  // on another. This checks the daemon-side verification is not trivially satisfiable: a
  // signature over the nonce by itself must fail when the room is bound in.
  const { identity, publicKey } = await pairedDevice();
  const fake = await fakeDaemon(publicKey);
  const tunnel = await Tunnel.open(fake.socket, ROOT, identity);
  opened.push(tunnel);
  assert.equal(fake.result.signatureValid, true);

  // Independently: a signature over the nonce without the room does not verify against the
  // bytes the daemon reconstructs.
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const roomOnly = new TextEncoder().encode(ROOM);
  const withRoom = new Uint8Array(nonce.length + roomOnly.length);
  withRoom.set(nonce, 0);
  withRoom.set(roomOnly, nonce.length);
  const good = await crypto.subtle.sign({ name: 'Ed25519' }, identity.key.privateKey, withRoom);
  const nonceOnly = await crypto.subtle.sign({ name: 'Ed25519' }, identity.key.privateKey, nonce);
  assert.equal(
    await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, good, withRoom),
    true,
  );
  assert.equal(
    await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, nonceOnly, withRoom),
    false,
    'a signature over the nonce alone must not verify against nonce || room',
  );
});
