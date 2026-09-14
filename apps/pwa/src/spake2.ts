/**
 * SPAKE2 — the client half the browser runs, and the daemon half a test can run.
 *
 * `crates/dr-dsh-crypto/src/pairing.rs` is normative, and this is the same construction over
 * {@link ./ed25519.ts}: the Ed25519 group, `spake2`'s blinding points, its password-to-scalar
 * derivation (HKDF-SHA256 with the `SPAKE2 pw` info string, read big-endian and reduced), its
 * message shape (one side byte then a compressed point), and its fixed six-times-32-byte
 * transcript. Nothing here is a reinterpretation of the protocol; a re-interpretation would
 * produce a *different shared key*, and every exchange would fail its confirmation instead of
 * quietly weakening anything.
 *
 * ## Why there is a daemon half in the browser bundle
 *
 * Not for the product: the browser is never the daemon. It exists because the fake daemon in
 * `pair.test.ts` has to speak the real protocol — a canned byte string would test the client
 * against a recording rather than against the construction, which is exactly the blind spot
 * that let the `SESSION_OVER` defect survive in this repository for several rounds. It is the
 * same reason the Rust crate keeps `ClientPairing` next to `DaemonPairing`.
 *
 * @module
 */

import {
  BASE_POINT,
  Ed25519Error,
  addPoints,
  compressPoint,
  decompressPoint,
  hexToBytes,
  negatePoint,
  reduceWideScalar,
  scalarFromBigEndian,
  scalarMult,
} from './ed25519.ts';

/**
 * `spake2`'s blinding point M, as the crate hard-codes it.
 *
 * The values are the published `python-spake2` `ParamsEd25519` parameters, and they are
 * *system parameters*: both ends must use the same ones, and they are not secret.
 */
const M_COMPRESSED = hexToBytes(
  '15cfd18e385952982b6a8f8c7854963b58e34388c8e6dae891db756481a02312',
);

/** `spake2`'s blinding point N. */
const N_COMPRESSED = hexToBytes(
  'f04f2e7eb734b2a8f8b472eaf9c3c632576ac64aea650b496a8a20ff00e583c3',
);

/** The blinding point the client adds. */
const M_POINT = decompressPoint(M_COMPRESSED);

/** The blinding point the daemon adds. */
const N_POINT = decompressPoint(N_COMPRESSED);

/** Length of one SPAKE2 message: a side byte plus a compressed point. */
export const SPAKE2_MESSAGE_LEN = 1 + 32;

/** The side byte a client sends (`'A'`). */
export const SIDE_CLIENT = 0x41;

/** The side byte a daemon sends (`'B'`). */
export const SIDE_DAEMON = 0x42;

/**
 * Identities bound into the transcript.
 *
 * They are part of the key derivation, so changing a string changes the shared key. Both
 * ends pass them in the same order, and the order is what stops a message from one pairing
 * being replayed into another.
 */
export const PAKE_IDENTITIES = {
  /** `id_a`, the client's identity. */
  client: 'dsh-remote/v1/pairing/client',
  /** `id_b`, the daemon's identity. */
  daemon: 'dsh-remote/v1/pairing/daemon',
} as const;

/** The HKDF info string `spake2` uses to turn a password into a scalar. */
const PASSWORD_INFO = 'SPAKE2 pw';

/** Which half of the exchange a state object is. */
export type Spake2Side = 'client' | 'daemon';

/** Why a SPAKE2 exchange could not be completed. */
export class Spake2Error extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'Spake2Error';
  }
}

/** Hashes with SHA-256. */
async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

/**
 * Turns the pairing code into the scalar `spake2` would use.
 *
 * The construction is `spake2`'s, verbatim, because it is part of the wire protocol rather
 * than an implementation detail: HKDF-SHA256 over the password with an empty salt and the
 * `SPAKE2 pw` info string, 48 bytes out, read as a big-endian integer, reduced modulo the
 * group order.
 *
 * @param password - the raw code bytes, not the displayed form.
 */
export async function hashToScalar(password: Uint8Array<ArrayBuffer>): Promise<bigint> {
  const material = await crypto.subtle.importKey('raw', password, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      // An empty salt. `Hkdf::new(Some(b""), …)` on the Rust side is the same HMAC key as
      // "no salt at all": both are padded with zeros to the hash's block size.
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(PASSWORD_INFO),
    },
    material,
    48 * 8,
  );
  return scalarFromBigEndian(new Uint8Array(bits));
}

/** Draws a fresh ephemeral scalar. */
export function randomScalar(): bigint {
  return reduceWideScalar(crypto.getRandomValues(new Uint8Array(64)));
}

/** One half of a SPAKE2 exchange, after `start` and before `finish`. */
export class Spake2State {
  /** Which half this is. */
  private readonly side: Spake2Side;
  /** The ephemeral scalar, `x` for a client and `y` for a daemon. */
  private readonly scalar: bigint;
  /** The password-derived scalar. */
  private readonly passwordScalar: bigint;
  /** The password itself, which the transcript hashes. */
  private readonly password: Uint8Array<ArrayBuffer>;
  /** This side's message, without the side byte. */
  private readonly point: Uint8Array<ArrayBuffer>;
  /** The message as it went on the wire. */
  private readonly sent: Uint8Array<ArrayBuffer>;

  private constructor(
    side: Spake2Side,
    scalar: bigint,
    passwordScalar: bigint,
    password: Uint8Array<ArrayBuffer>,
    point: Uint8Array<ArrayBuffer>,
    sent: Uint8Array<ArrayBuffer>,
  ) {
    this.side = side;
    this.scalar = scalar;
    this.passwordScalar = passwordScalar;
    this.password = password;
    this.point = point;
    this.sent = sent;
  }

  /**
   * Starts an exchange and produces the message to send.
   *
   * @param side - which half to play; the two ends must pick different ones.
   * @param password - the raw pairing code bytes.
   * @param scalar - the ephemeral scalar, for vectors. Drawn at random when omitted.
   */
  public static async start(
    side: Spake2Side,
    password: Uint8Array<ArrayBuffer>,
    scalar?: bigint,
  ): Promise<{ state: Spake2State; message: Uint8Array<ArrayBuffer> }> {
    const passwordScalar = await hashToScalar(password);
    const ephemeral = scalar ?? randomScalar();
    const blinding = side === 'client' ? M_POINT : N_POINT;
    const point = compressPoint(
      addPoints(scalarMult(BASE_POINT, ephemeral), scalarMult(blinding, passwordScalar)),
    );
    const sent = new Uint8Array(SPAKE2_MESSAGE_LEN);
    sent[0] = side === 'client' ? SIDE_CLIENT : SIDE_DAEMON;
    sent.set(point, 1);
    return { state: new Spake2State(side, ephemeral, passwordScalar, password, point, sent), message: sent };
  }

  /** This side's message, as it is sent. */
  public get message(): Uint8Array<ArrayBuffer> {
    return this.sent;
  }

  /**
   * Completes the exchange and returns the shared key.
   *
   * A wrong code still produces a key here — that is the point of a PAKE, and it is why the
   * enrolment confirmation is checked under this key rather than by comparing keys. What
   * fails loudly is a malformed message: a truncated one, a point that is not on the curve,
   * or a peer playing the same side.
   *
   * @param peerMessage - the peer's SPAKE2 message, side byte included.
   * @throws Spake2Error when the peer's message is not usable.
   */
  public async finish(peerMessage: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    if (peerMessage.length !== SPAKE2_MESSAGE_LEN) {
      throw new Spake2Error(
        `a SPAKE2 message is ${SPAKE2_MESSAGE_LEN} bytes, got ${peerMessage.length}`,
      );
    }
    const expectedSide = this.side === 'client' ? SIDE_DAEMON : SIDE_CLIENT;
    if (peerMessage[0] !== expectedSide) {
      throw new Spake2Error('the peer is playing the same side of this exchange');
    }
    const peerPoint = peerMessage.slice(1);
    let peer;
    try {
      peer = decompressPoint(peerPoint);
    } catch (error) {
      if (error instanceof Ed25519Error) {
        throw new Spake2Error(`the peer's SPAKE2 message is not a point: ${error.message}`);
      }
      throw error;
    }

    // The unblinding point is the *other* side's: a client removes N from the daemon's
    // message, and a daemon removes M from the client's. Swapping them yields a different
    // key rather than an error, which is why the vectors pin both directions.
    const unblinding = this.side === 'client' ? N_POINT : M_POINT;
    const unblinded = addPoints(peer, negatePoint(scalarMult(unblinding, this.passwordScalar)));
    const shared = compressPoint(scalarMult(unblinded, this.scalar));

    // sha256(sha256(password) || sha256(idA) || sha256(idB) || X || Y || K), with X and Y
    // always in that order, whichever side is computing it.
    const clientPoint = this.side === 'client' ? this.point : peerPoint;
    const daemonPoint = this.side === 'client' ? peerPoint : this.point;
    const transcript = new Uint8Array(6 * 32);
    transcript.set(await sha256(this.password), 0);
    transcript.set(await sha256(new TextEncoder().encode(PAKE_IDENTITIES.client)), 32);
    transcript.set(await sha256(new TextEncoder().encode(PAKE_IDENTITIES.daemon)), 64);
    transcript.set(clientPoint, 96);
    transcript.set(daemonPoint, 128);
    transcript.set(shared, 160);
    return sha256(transcript);
  }
}
