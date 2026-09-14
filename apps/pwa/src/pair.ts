/**
 * Pairing a browser with a daemon, over a relay.
 *
 * `pairing.ts` holds the cryptography and `identity.ts` holds the key; this is the exchange
 * that connects them to a live daemon, and it is the piece that turns "the browser cannot
 * pair" into "type the code and you are in".
 *
 * ## The four messages, and why they look like this
 *
 * The exchange runs on the daemon's *rendezvous* room — derived from the code, sealed under a
 * constant transport root — and before any session exists:
 *
 * 1. daemon → client: its SPAKE2 message (33 raw bytes on the control stream).
 * 2. client → daemon: its own SPAKE2 message.
 * 3. client → daemon: `pair_finish`, a JSON envelope with the identity being enrolled and the
 *    proof under the exchanged key. The two byte strings are JSON *arrays of numbers*, because
 *    they are `Vec<u8>` in Rust and `serde_json` writes those as sequences — a base64 string
 *    here would be refused as "the peer's pair_finish message was not usable", with nothing
 *    saying which field.
 * 4. daemon → client: `pair_accept` with the device id, the room root key and the room, or
 *    `pair_reject` with a machine-readable reason.
 *
 * The daemon speaks first, which is why this client can wait for a known message instead of
 * racing: `drdshd pair` sends its half the moment a client establishes a session on the room.
 *
 * ## What is checked here rather than trusted
 *
 * The root key the daemon sends is checked to name the room the daemon announced, and the
 * device id is checked to be the one this client's public key derives. Both are refusals. A
 * daemon that got the derivation wrong would otherwise be indistinguishable from a working
 * one until the client tried to connect to a room nobody serves.
 *
 * @module @dr.dsh/pwa/pair
 */

import {
  withRoom,
  generateDevice,
  restoreDevice,
  type Device,
  type DeviceRecord,
  type IdentityRecord,
} from './identity.ts';
import {
  PairingClient,
  PairingError,
  SEALED_ROOM_KEY_LEN,
  checkAcceptance,
  decodeField,
  openRoomKey,
  pairingTransportRoot,
} from './pairing.ts';
import { SIDE_DAEMON, SPAKE2_MESSAGE_LEN } from './spake2.ts';
import { CONTROL_STREAM, Tunnel, type TunnelSocket } from './tunnel.ts';

/** How long to wait for each message from the daemon, by default. */
export const PAIRING_STEP_TIMEOUT_MS = 30_000;

/** Where the exchange has got to, for a UI to render. */
export type PairingPhase =
  | { readonly phase: 'connecting' }
  | { readonly phase: 'waiting' }
  | { readonly phase: 'paired'; readonly deviceId: string; readonly room: string }
  | { readonly phase: 'failed'; readonly reason: string };

/** What this module needs from the browser. */
export interface PairingHost {
  /** Opens the carrier socket for a room. */
  connect(room: string): Promise<TunnelSocket>;
  /** Reports a phase change. */
  report(phase: PairingPhase): void;
}

/** A device that has just been enrolled. */
export interface PairedDevice {
  /** The identity, with live key handles. */
  readonly device: Device;
  /** What to store: the private key, the public key, the id, the room key and the room. */
  readonly record: DeviceRecord;
  /** The id the daemon knows this device by. */
  readonly deviceId: string;
  /** The room root key, which the daemon derived from the same exchange. */
  readonly roomKey: Uint8Array<ArrayBuffer>;
  /** The room that key names. */
  readonly room: string;
}

/**
 * The identity a pairing run should enrol.
 *
 * ADR-0007: a browser has **one** identity, shared by every room it is paired with. Pairing a second
 * machine therefore has to present the identity the first machine already knows — generating a fresh
 * one would leave the browser holding a key that only the newest daemon accepts, and the older machine
 * would answer "this device is not paired with that daemon any more". That is exactly what the two-room
 * browser smoke found.
 */
export interface PairingIdentity {
  /** The identity to enrol, or `null`/absent to generate a fresh one. */
  readonly identity?: IdentityRecord | null;
}

/** How a pairing run should behave. */
export interface PairingOptions extends PairingIdentity {
  /** The code the daemon displayed, as the user typed it. */
  readonly code: string;
  /** A label the daemon stores, so an operator can tell devices apart. */
  readonly deviceName: string;
  /** How long to wait for each message. Defaults to {@link PAIRING_STEP_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/** The type tag of the envelope the daemon sends when it refuses. */
const REJECTION_TYPE = 'pair_reject';

/** The envelope the daemon sends when it accepts. */
interface Acceptance {
  readonly type: 'pair_accept';
  readonly device_id: string;
  readonly root_key: string;
  readonly room: string;
}

/** Turns the daemon's machine-readable refusal into a sentence a person can act on. */
function explain(reason: string): string {
  if (reason === 'pairing_failed') {
    return (
      'the daemon refused the pairing: the code does not match the one it displayed. Check ' +
      'the code and run `drdshd pair` again — a code is spent by the attempt, whether or not ' +
      'it was right.'
    );
  }
  return `the daemon refused the pairing: ${reason}`;
}

/** Whether a payload is a JSON object, which is how the pairing envelopes announce themselves. */
function isJsonObject(payload: Uint8Array<ArrayBuffer>): boolean {
  const text = new TextDecoder().decode(payload).trimStart();
  return text.startsWith('{');
}

/**
 * Parses a control message that is supposed to be one of the pairing envelopes.
 *
 * Returns only the acceptance: a refusal is a `throw`, because every caller would otherwise
 * have to re-check which of the two it got, and one of them forgetting is how a refusal gets
 * read as an acceptance with missing fields.
 */
function asEnvelope(payload: Uint8Array<ArrayBuffer>): Acceptance {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    throw new PairingError('the daemon sent something that is not a pairing message');
  }
  const type = (parsed as { type?: unknown }).type;
  if (type === REJECTION_TYPE) {
    const reason = (parsed as { reason?: unknown }).reason;
    throw new PairingError(explain(typeof reason === 'string' ? reason : 'no reason given'));
  }
  if (type !== 'pair_accept') {
    throw new PairingError('the daemon sent something that is not a pairing message');
  }
  return parsed as Acceptance;
}

/** Whether a payload is one of the pairing envelopes rather than a raw PAKE message. */
function envelopeReason(payload: Uint8Array<ArrayBuffer>): string | null {
  if (!isJsonObject(payload)) return null;
  const parsed = JSON.parse(new TextDecoder().decode(payload)) as { type?: unknown; reason?: unknown };
  if (parsed.type !== REJECTION_TYPE) return null;
  return typeof parsed.reason === 'string' ? parsed.reason : 'no reason given';
}

/**
 * Opens the pairing tunnel, bounded in time.
 *
 * The session handshake waits for the daemon's acknowledgement, and a room nobody is serving
 * would otherwise leave the user staring at a spinner forever: the relay accepts the parking
 * as long as a daemon is registered, and a daemon that died between its registration and this
 * moment looks exactly like one that is still there. `Tunnel.open` has no timeout of its own —
 * a served room answers in milliseconds and the panel reports a silent daemon separately — so
 * pairing, which is the path a user waits on, bounds it here and says which side did not
 * answer.
 */
async function openPairingTunnel(
  socket: TunnelSocket,
  root: Uint8Array<ArrayBuffer>,
  timeoutMs: number,
): Promise<Tunnel> {
  const opened = Tunnel.open(socket, root, null, { deviceStep: false });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Rejected *before* the socket is closed: closing rejects the pending `Tunnel.open`, and
      // a race between two rejections would report whichever settled first — which would be
      // "the client closed the pairing room", a sentence about this side rather than the one
      // that stayed silent.
      reject(
        new PairingError(
          `no daemon answered in the pairing room for this code within ${Math.round(
            timeoutMs / 1000,
          )} seconds. Check that \`drdshd pair\` is still running and that the code has not expired.`,
        ),
      );
      socket.close();
    }, timeoutMs);
  });
  try {
    return await Promise.race([opened, expired]);
  } finally {
    if (timer !== null) clearTimeout(timer);
    // The losing side of the race must not surface later as an unhandled rejection; a socket
    // closed above rejects `opened`, and that rejection has already been accounted for.
    opened.catch(() => {});
  }
}

/**
 * Runs the whole exchange: code in, enrolled device out.
 *
 * @param host - the browser seams: a socket factory and a progress reporter.
 * @param options - the code, the device label and the per-message timeout.
 * @throws PairingError when the code is not a code, the daemon refuses, the exchange stalls,
 * or the daemon's acceptance does not match what this client derived.
 */
export async function pairWithCode(
  host: PairingHost,
  options: PairingOptions,
): Promise<PairedDevice> {
  const timeoutMs = options.timeoutMs ?? PAIRING_STEP_TIMEOUT_MS;
  host.report({ phase: 'connecting' });

  let client: PairingClient;
  try {
    client = await PairingClient.begin(options.code);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    host.report({ phase: 'failed', reason });
    throw error;
  }

  const transportRoot = await pairingTransportRoot();
  /** Everything that has to be closed however this ends. */
  let socket: TunnelSocket | null = null;
  let tunnel: Tunnel | null = null;
  /** Messages that arrived on the control stream, in order. */
  const inbound: Uint8Array<ArrayBuffer>[] = [];
  let wake: (() => void) | null = null;

  /**
   * Waits for the next control message.
   *
   * The timeout is per message and named: a pairing that stalls has to end, because a live
   * code plus a parked daemon is an invitation to keep guessing — and "nothing came back" must
   * not be indistinguishable from "the relay dropped".
   */
  const next = async (what: string): Promise<Uint8Array<ArrayBuffer>> => {
    if (tunnel === null) throw new PairingError('the pairing tunnel is not open');
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const queued = inbound.shift();
      if (queued !== undefined) return queued;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new PairingError(
          `the daemon did not send ${what} within ${Math.round(timeoutMs / 1000)} seconds. ` +
            'Check that `drdshd pair` is still running and that the code has not expired.',
        );
      }
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, remaining);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = null;
    }
  };

  let device: Device | null = null;
  try {
    socket = await host.connect(client.rendezvousRoom);
    // The device step is off for this connection and only this one: the exchange below *is* what
    // creates the device, and the step would otherwise intercept the PAKE message as if it were
    // a challenge.
    tunnel = await openPairingTunnel(socket, transportRoot, timeoutMs);
    const opened = tunnel;
    opened.on(CONTROL_STREAM, payload => {
      inbound.push(payload);
      wake?.();
    });

    host.report({ phase: 'waiting' });
    const daemonMessage = await next('its half of the PAKE');
    if (daemonMessage.length !== SPAKE2_MESSAGE_LEN || daemonMessage[0] !== SIDE_DAEMON) {
      // A refusal can arrive here too, and reporting *it* as a malformed PAKE message would
      // send the user hunting for a protocol bug. Only an envelope is read as one: a payload
      // that is not JSON is a shape mismatch, and saying so is more useful than a parse error.
      const refusal = envelopeReason(daemonMessage);
      if (refusal !== null) throw new PairingError(explain(refusal));
      throw new PairingError(
        `the daemon sent ${daemonMessage.length} bytes where a ${SPAKE2_MESSAGE_LEN}-byte ` +
          'SPAKE2 message was expected',
      );
    }

    // Reused when the browser already has one: see [`PairingIdentity`]. A record that does not verify
    // fails here, before the exchange, rather than as a refusal from the daemon.
    device =
      options.identity === undefined || options.identity === null
        ? await generateDevice()
        : await restoreDevice(options.identity);
    const outcome = await client.finish(daemonMessage, device.publicKeyBytes);

    await opened.send(CONTROL_STREAM, client.message);
    // `device_public_key` and `confirm` are JSON arrays of numbers by construction: they are
    // `Vec<u8>` on the daemon's side, and `serde_json` writes those as sequences.
    const finish = JSON.stringify({
      device_name: options.deviceName,
      device_public_key: Array.from(device.publicKeyBytes),
      confirm: Array.from(outcome.confirm),
    });
    await opened.send(CONTROL_STREAM, new TextEncoder().encode(finish));

    const accepted = asEnvelope(await next('an answer to the enrolment'));
    // The receipt carries the room key the daemon serves, sealed under the enrolment key: the
    // pairing room's transport is public by construction, so a key announced in the clear would
    // be a key handed to the relay.
    const sealed = decodeField(accepted.root_key, SEALED_ROOM_KEY_LEN, 'the sealed room key');
    const rootKey = await openRoomKey(outcome.enrolmentKey, device.publicKeyBytes, sealed);
    await checkAcceptance(rootKey, accepted.room);

    // The id is derived from the public key on both sides, so a difference means the daemon
    // enrolled something other than the key this client sent — which no honest daemon can do.
    const derivedId = device.record.deviceId;
    if (accepted.device_id !== derivedId) {
      throw new PairingError(
        `the daemon enrolled a different device id than this key derives: expected ${derivedId}, ` +
          `found ${accepted.device_id}`,
      );
    }

    const record = withRoom(device, rootKey, accepted.room);
    host.report({ phase: 'paired', deviceId: derivedId, room: accepted.room });
    return {
      device,
      record,
      deviceId: derivedId,
      roomKey: rootKey,
      room: accepted.room,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    host.report({ phase: 'failed', reason });
    throw error;
  } finally {
    // The exchange is over either way: the daemon closes the room after its acceptance, and
    // leaving the socket parked would keep the relay routing the room to nobody. A failure
    // *before* the tunnel existed still has a socket to close, and a failure during the
    // handshake has neither — the timeout closes that socket itself.
    if (tunnel !== null) tunnel.close();
    else socket?.close();
  }
}
