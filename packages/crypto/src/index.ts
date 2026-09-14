/**
 * dr.dsh end-to-end crypto — browser side.
 *
 * The daemon and the client must agree on every byte of the handshake, and they
 * are written in different languages. `crates/dr-dsh-crypto` is normative; this
 * module implements the same construction over WebCrypto, and
 * `conformance.test.ts` fails when the two disagree.
 *
 * ## Why the browser can hold the keys
 *
 * Everything here uses WebCrypto primitives the platform already ships:
 * X25519 for key agreement, HKDF for derivation, AES-GCM for frame sealing. No
 * JavaScript implements a block cipher, no key material is derived from a
 * password by hand, and nothing needs a native addon — which matters because
 * the client is a PWA that has to run on a phone browser.
 *
 * ## What is deliberately not here
 *
 * There is no "trust the relay" path: the relay's certificate authenticates
 * transport, and nothing else. If the relay is honest-but-curious, or fully
 * compromised, it still holds only ciphertext. The one thing a malicious relay
 * *can* do is serve modified client code; see `docs/security.md` § Serving the
 * client for why that is stated plainly rather than papered over.
 *
 * @module @dr.dsh/crypto
 */

/** Lifetime of a pairing code, in milliseconds. Mirrors the daemon's value. */
export const PAIRING_CODE_TTL_MS = 300_000;

/** Length of a session key in bytes. */
export const SESSION_KEY_LEN = 32;

/** Length of an AES-GCM nonce (and IV) in bytes. */
export const NONCE_LEN = 12;

/**
 * HKDF labels.
 *
 * Changing one of these is a wire-breaking change: both implementations derive
 * keys from these exact strings, and the conformance corpus pins the results.
 */
export const LABELS = {
  /**
   * Extraction of the SPAKE2 output into the enrolment key — the key an enrolment receipt is
   * sealed under. It is also the info string a room id is derived with, which is why the same
   * value appears twice in `docs/protocol.md`; it is *not* the room key itself.
   */
  pairingRoot: 'dsh-remote/v1/pairing-root',
  /** Derivation of a device's enrolment confirmation. */
  enrolmentConfirm: 'dsh-remote/v1/enrolment-confirm',
  /** Additional authenticated data binding an enrolment receipt to its device. */
  enrolmentSeal: 'dsh-remote/v1/enrolment-seal',
  /** Derivation of a reconnecting device's challenge response. */
  resumeChallenge: 'dsh-remote/v1/resume-challenge',
  /** Derivation of the client-to-daemon session key. */
  sessionClientToDaemon: 'dsh-remote/v1/session/c2d',
  /** Derivation of the daemon-to-client session key. */
  sessionDaemonToClient: 'dsh-remote/v1/session/d2c',
  /** Additional authenticated data binding a frame to its stream. */
  frameAad: 'dsh-remote/v1/frame',
} as const;

/** A symmetric session key plus its direction's nonce counter. */
export interface SessionCipher {
  /** The AES-GCM key for this direction. */
  readonly key: CryptoKey;
  /**
   * Next nonce counter. A counter, not a random value: both endpoints know the
   * expected value, so a replayed or reordered frame is a detectable protocol
   * error instead of a silent acceptance — which matters because the relay is
   * not trusted to preserve order.
   */
  nonce: number;
}

/**
 * Builds the 12-byte nonce for a counter value: four zero bytes then the
 * big-endian counter, so both languages agree without negotiation.
 *
 * @param counter - nonce sequence number, starting at zero.
 */
export function nonceBytes(counter: number): Uint8Array {
  const nonce = new Uint8Array(NONCE_LEN);
  new DataView(nonce.buffer).setBigUint64(4, BigInt(counter), false);
  return nonce;
}

/**
 * Additional authenticated data for a frame: the label plus the stream id.
 *
 * Binding the stream id into the AEAD is what stops the relay from moving a
 * payload onto another stream — a redirection that would otherwise be a silent
 * feature of a byte-forwarding middlebox.
 *
 * @param streamId - stream the frame belongs to.
 */
export function frameAdditionalData(streamId: number): Uint8Array {
  const label = new TextEncoder().encode(LABELS.frameAad);
  const aad = new Uint8Array(label.byteLength + 4);
  aad.set(label, 0);
  new DataView(aad.buffer).setUint32(label.byteLength, streamId, false);
  return aad;
}

/**
 * Imports raw HKDF bytes as an AES-GCM session key.
 *
 * @param raw - 32 bytes of key material derived from the handshake.
 * @throws Error when `raw` is not exactly {@link SESSION_KEY_LEN} bytes, which
 * would mean the caller skipped a derivation step.
 */
export async function importSessionKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (raw.byteLength !== SESSION_KEY_LEN) {
    throw new Error(`session key must be ${SESSION_KEY_LEN} bytes, got ${raw.byteLength}`);
  }
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
