/**
 * Pairing: turning a short code into a device identity, in the browser.
 *
 * This is the client half of `docs/protocol.md` § 6.2, and the piece that used to be missing:
 * WebCrypto has no SPAKE2, so a phone could only ever connect with a room key pasted from the
 * daemon's terminal, which is not the product the acceptance criteria describe. The PAKE
 * itself is in `spake2.ts` over the group in `ed25519.ts`; what this module owns is the code,
 * the rendezvous room, the proof, and the receipt.
 *
 * Nothing here is a new protocol. The PAKE is `spake2` over the group in `ed25519.ts`, the
 * derivations are the labels `crates/dr-dsh-crypto` defines, and
 * `packages/crypto/conformance/pairing-vectors.json` pins every value against the Rust
 * implementation. What this module adds is the *order*: read a code, derive the rendezvous
 * room, run the PAKE, prove the code under the exchanged key, and check that the room the
 * daemon announced is the one the key derives.
 *
 * ## What the client can and cannot check
 *
 * It cannot authenticate the daemon before the PAKE: anyone can park in the rendezvous room,
 * which is derived from the code and therefore guessable in 2⁴⁰. What it *can* do — and what
 * it does — is refuse anything that does not complete the PAKE with the same code, and then
 * refuse an acceptance whose room does not match the derived root key. A wrong code, a
 * substituted message, or a substituted root key all end as a named failure with no identity
 * written.
 *
 * @module @dr.dsh/pwa/pairing
 */

import { Spake2State } from './spake2.ts';
import { base64url, base64urlDecode } from './tunnel.ts';

/** Length of the raw pairing secret: 40 bits, drawn as five bytes. */
export const PAIRING_SECRET_LEN = 5;

/** Lifetime of a pairing code, in milliseconds. The daemon enforces it; this is for the UI. */
export const PAIRING_CODE_TTL_MS = 300_000;

/** The alphabet the displayed form uses: Crockford-style base32 without `I`, `L`, `O`, `U`. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** HKDF label for both the pairing root and the room a root key derives. */
const LABEL_PAIRING_ROOT = 'dsh-remote/v1/pairing-root';

/** HKDF label for a device's enrolment confirmation. */
const LABEL_ENROLMENT_CONFIRM = 'dsh-remote/v1/enrolment-confirm';

/** Additional authenticated data binding an enrolment receipt to its device. */
const LABEL_ENROLMENT_SEAL = 'dsh-remote/v1/enrolment-seal';

/** Length of the nonce an enrolment receipt carries. */
export const RECEIPT_NONCE_LEN = 12;

/** Length of a sealed enrolment receipt: nonce, the 32-byte key, and the AEAD tag. */
export const SEALED_ROOM_KEY_LEN = RECEIPT_NONCE_LEN + 32 + 16;

/** What the constant pairing transport root is bound to. */
const TRANSPORT_SUFFIX = 'transport';

/** Why a pairing code or exchange was not usable. */
export class PairingError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PairingError';
  }
}

/**
 * Parses the displayed code back into its bytes.
 *
 * The display form is the only thing a human can transport, so it is the only thing this
 * accepts: agreeing with the daemon about what was typed matters more than accepting a
 * convenient alternative spelling. The characters the alphabet omits are folded onto the
 * digits they look like, exactly as `drdshd pair-as-device` does, because a user who typed `O`
 * for `0` should not be punished for the alphabet's choice.
 *
 * @param text - the code, with or without its grouping dashes.
 * @throws PairingError when the text is not a code the daemon could have displayed.
 */
export function parsePairingCode(text: string): Uint8Array<ArrayBuffer> {
  const cleaned: string[] = [];
  for (const character of text.toUpperCase()) {
    if (character === '-' || /\s/.test(character)) continue;
    const folded =
      character === 'I' || character === 'L'
        ? '1'
        : character === 'O'
          ? '0'
          : character === 'U'
            ? 'V'
            : character;
    const index = ALPHABET.indexOf(folded);
    if (index < 0) {
      throw new PairingError(`"${character}" is not part of a pairing code`);
    }
    cleaned.push(folded);
  }
  if (cleaned.length % 2 !== 0) {
    throw new PairingError('a pairing code has an even number of symbols');
  }
  const secret = new Uint8Array(cleaned.length / 2);
  for (let index = 0; index < secret.length; index += 1) {
    const low = ALPHABET.indexOf(cleaned[index * 2] ?? '');
    const high = ALPHABET.indexOf(cleaned[index * 2 + 1] ?? '');
    secret[index] = low | (high << 5);
  }
  if (secret.length !== PAIRING_SECRET_LEN) {
    throw new PairingError(
      `a pairing code carries ${PAIRING_SECRET_LEN} bytes, got ${secret.length}`,
    );
  }
  return secret;
}

/**
 * Renders the code the way the daemon prints it: `7Q4M-2XKP-9T`.
 *
 * @param secret - the raw code bytes.
 */
export function formatPairingCode(secret: Uint8Array<ArrayBuffer>): string {
  let rendered = '';
  for (let index = 0; index < secret.length; index += 1) {
    if (index > 0 && index % 2 === 0) rendered += '-';
    const byte = secret[index];
    if (byte === undefined) throw new PairingError('the code changed length while rendering');
    rendered += ALPHABET[byte & 0x1f];
    rendered += ALPHABET[byte >> 5];
  }
  return rendered;
}

/**
 * HKDF-SHA256 with an empty salt, which is what the Rust side's `Hkdf::new(None, …)` means:
 * an absent salt and an empty one are the same HMAC key.
 */
async function expand(
  ikm: Uint8Array<ArrayBuffer>,
  info: string,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const material = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(info),
    },
    material,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** SHA-256. */
async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

/**
 * The room a root key names.
 *
 * One-way, like the daemon's: the relay learns the room id, and a room id must not reveal
 * the key it came from. `Tunnel.roomFor` performs the same derivation; this exists so the
 * pairing module can check the daemon's announcement without a tunnel.
 *
 * @param root - the 32-byte room key.
 */
export async function roomIdFor(root: Uint8Array<ArrayBuffer>): Promise<string> {
  return base64url(await expand(root, LABEL_PAIRING_ROOT, 16));
}

/**
 * The room a pairing exchange happens in.
 *
 * Derived one-way from the code, so the relay can log it without learning anything it can
 * reuse, and it stops being interesting the moment the code expires.
 *
 * @param secret - the raw code bytes.
 */
export async function pairingRoomFor(secret: Uint8Array<ArrayBuffer>): Promise<string> {
  return roomIdFor(await expand(secret, LABEL_PAIRING_ROOT, 32));
}

/**
 * The constant root a pairing room's frames are sealed under.
 *
 * Not a secret, and not derived from the code: authentication comes from the PAKE. A
 * code-derived sealing key would mean two ends holding different codes could not open each
 * other's frames at all, so the most likely user error — a mistyped digit — would present as
 * a hang rather than as "that code is wrong".
 */
export async function pairingTransportRoot(): Promise<Uint8Array<ArrayBuffer>> {
  const label = new TextEncoder().encode(LABEL_PAIRING_ROOT);
  const suffix = new TextEncoder().encode(TRANSPORT_SUFFIX);
  const message = new Uint8Array(label.length + suffix.length);
  message.set(label, 0);
  message.set(suffix, label.length);
  return sha256(message);
}

/**
 * Derives the **enrolment key** from the raw PAKE output.
 *
 * This is not the room key, and treating it as one was a real defect: the daemon announced it
 * as the key the client should serve from, while the daemon itself served the key it was
 * configured with, so a freshly paired device dialled a room nobody served. It is now what it
 * always was cryptographically — a key only the two ends of a completed PAKE hold — and it is
 * used to open the receipt that carries the room key.
 *
 * @param exchanged - the SPAKE2 output.
 */
export async function deriveEnrolmentKey(
  exchanged: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  return expand(exchanged, LABEL_PAIRING_ROOT, 32);
}

/**
 * Seals a room key into an enrolment receipt.
 *
 * This is the **daemon's** half, and it lives here for one reason: the fake daemon in
 * `pair.test.ts` has to produce the real bytes. A hand-written copy of the layout in a test
 * encodes the same assumption as the code it checks — which is how a stray confirmation frame
 * survived several rounds in this repository — and this one is pinned against the Rust
 * implementation by `pairing.test.ts`, which seals with a fixed nonce and compares the result
 * with the vector corpus byte for byte.
 *
 * @param enrolmentKey - the key from {@link deriveEnrolmentKey}.
 * @param devicePublicKey - the identity being enrolled.
 * @param roomKey - the room key the daemon serves.
 * @param nonce - a fresh 12-byte nonce per receipt; an input so the corpus can pin the bytes.
 */
export async function sealRoomKey(
  enrolmentKey: Uint8Array<ArrayBuffer>,
  devicePublicKey: Uint8Array<ArrayBuffer>,
  roomKey: Uint8Array<ArrayBuffer>,
  nonce: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  if (nonce.length !== RECEIPT_NONCE_LEN) {
    throw new PairingError(`a receipt nonce is ${RECEIPT_NONCE_LEN} bytes, got ${nonce.length}`);
  }
  if (roomKey.length !== 32) {
    throw new PairingError(`a room key is 32 bytes, got ${roomKey.length}`);
  }
  const key = await crypto.subtle.importKey('raw', enrolmentKey, 'AES-GCM', false, ['encrypt']);
  const label = new TextEncoder().encode(LABEL_ENROLMENT_SEAL);
  const aad = new Uint8Array(label.length + devicePublicKey.length);
  aad.set(label, 0);
  aad.set(devicePublicKey, label.length);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, roomKey),
  );
  const receipt = new Uint8Array(RECEIPT_NONCE_LEN + sealed.length);
  receipt.set(nonce, 0);
  receipt.set(sealed, RECEIPT_NONCE_LEN);
  return receipt;
}

/**
 * Opens the enrolment receipt and returns the room key the daemon serves.
 *
 * The receipt is `nonce || AES-256-GCM ciphertext+tag`, with the label and the enrolled public
 * key as additional authenticated data. Two properties matter, and they are different:
 *
 * * **Confidentiality against the relay.** The pairing room's transport root is a published
 *   constant, so whatever crosses it in the clear is readable by whoever forwards it. The room
 *   key is the daemon's long-lived secret, so it is sealed under a key the relay cannot derive:
 *   the enrolment key, which exists only on the two ends of the PAKE.
 * * **Authenticity for this device.** A relay can rewrite frames on that room — it knows the
 *   transport root too. Binding the public key into the AAD means a receipt cannot be moved
 *   onto another identity, and a substituted one cannot be opened at all.
 *
 * @param enrolmentKey - the key from {@link deriveEnrolmentKey}.
 * @param devicePublicKey - the identity being enrolled.
 * @param sealed - the receipt, as the daemon sent it.
 * @throws PairingError when the receipt is not one this key and identity can open.
 */
export async function openRoomKey(
  enrolmentKey: Uint8Array<ArrayBuffer>,
  devicePublicKey: Uint8Array<ArrayBuffer>,
  sealed: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  if (sealed.length !== SEALED_ROOM_KEY_LEN) {
    throw new PairingError(
      `an enrolment receipt is ${SEALED_ROOM_KEY_LEN} bytes, got ${sealed.length}`,
    );
  }
  const key = await crypto.subtle.importKey('raw', enrolmentKey, 'AES-GCM', false, ['decrypt']);
  const label = new TextEncoder().encode(LABEL_ENROLMENT_SEAL);
  const aad = new Uint8Array(label.length + devicePublicKey.length);
  aad.set(label, 0);
  aad.set(devicePublicKey, label.length);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: sealed.slice(0, RECEIPT_NONCE_LEN), additionalData: aad },
        key,
        sealed.slice(RECEIPT_NONCE_LEN),
      ),
    );
  } catch {
    // One message for every way this fails: a relay that substituted a receipt learns nothing
    // from being told *how* it was wrong.
    throw new PairingError(
      'the enrolment receipt could not be opened: it was not sealed for this device by the ' +
        'peer that completed the exchange',
    );
  }
}

/**
 * The client's proof that it knows the code *and* holds the identity it is enrolling.
 *
 * A MAC under the PAKE key rather than a signature over its own key: a signature proves
 * possession of an identity but says nothing about the code, so a device using the wrong code
 * would still enrol. That was a real defect in the Rust implementation, and this side has to
 * produce the shape that fixes it.
 *
 * @param exchanged - the SPAKE2 output.
 * @param publicKey - the 32-byte Ed25519 public key being enrolled.
 */
export async function enrolmentConfirmation(
  exchanged: Uint8Array<ArrayBuffer>,
  publicKey: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey(
    'raw',
    exchanged,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const label = new TextEncoder().encode(LABEL_ENROLMENT_CONFIRM);
  const message = new Uint8Array(label.length + publicKey.length);
  message.set(label, 0);
  message.set(publicKey, label.length);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
}

/** What a completed client half of a pairing exchange holds. */
export interface PairingOutcome {
  /** The proof to send with the enrol request. */
  readonly confirm: Uint8Array<ArrayBuffer>;
  /** The key the daemon's receipt is sealed under. Not the room key; see {@link openRoomKey}. */
  readonly enrolmentKey: Uint8Array<ArrayBuffer>;
}

/** The client's half of a pairing exchange. */
export class PairingClient {
  /** The PAKE state, held until `finish` consumes it. */
  private readonly state: Spake2State;
  /** The code, kept for the room derivation. */
  private readonly secret: Uint8Array<ArrayBuffer>;
  /** The rendezvous room both ends must be in. */
  public readonly rendezvousRoom: string;
  /** The message to send first. */
  public readonly message: Uint8Array<ArrayBuffer>;
  /** Whether this exchange has been finished; a second finish is a caller bug. */
  private finished = false;

  private constructor(state: Spake2State, secret: Uint8Array<ArrayBuffer>, room: string) {
    this.state = state;
    this.secret = secret;
    this.rendezvousRoom = room;
    this.message = state.message;
  }

  /**
   * Starts a pairing from the code the daemon displayed.
   *
   * @param codeText - the code as the user typed it, dashes and all.
   * @throws PairingError when the text is not a code.
   */
  public static async begin(codeText: string): Promise<PairingClient> {
    const secret = parsePairingCode(codeText);
    const room = await pairingRoomFor(secret);
    const { state } = await Spake2State.start('client', secret);
    return new PairingClient(state, secret, room);
  }

  /** The code, for the confirmation dialog the UI shows before pairing. */
  public get code(): string {
    return formatPairingCode(this.secret);
  }

  /**
   * Completes the exchange against the daemon's message.
   *
   * @param daemonMessage - the daemon's SPAKE2 message, side byte included.
   * @param devicePublicKey - the 32-byte Ed25519 public key to enrol.
   * @throws PairingError when the peer's message is not a usable SPAKE2 message, or when this
   * exchange has already been finished.
   */
  public async finish(
    daemonMessage: Uint8Array<ArrayBuffer>,
    devicePublicKey: Uint8Array<ArrayBuffer>,
  ): Promise<PairingOutcome> {
    if (this.finished) {
      throw new PairingError('this pairing exchange is already finished');
    }
    this.finished = true;
    let exchanged: Uint8Array<ArrayBuffer>;
    try {
      exchanged = await this.state.finish(daemonMessage);
    } catch (error) {
      throw new PairingError(
        `the daemon did not answer with a usable pairing message: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return {
      confirm: await enrolmentConfirmation(exchanged, devicePublicKey),
      enrolmentKey: await deriveEnrolmentKey(exchanged),
    };
  }
}

/**
 * Checks that the room key the receipt carried names the room the daemon announced.
 *
 * A refusal, not a warning: a key that does not name the announced room would leave the client
 * dialling a room nobody serves, and the user would be told "no daemon is serving this room"
 * forever, with nothing to point at. Catching it here keeps the cause visible — the same check
 * the Rust reference client performs.
 *
 * @param roomKey - the key opened from the receipt.
 * @param announced - the room the daemon said it serves.
 * @throws PairingError when they disagree.
 */
export async function checkAcceptance(
  roomKey: Uint8Array<ArrayBuffer>,
  announced: string,
): Promise<void> {
  if ((await roomIdFor(roomKey)) !== announced) {
    throw new PairingError(
      'the daemon announced a room that the room key in its receipt does not derive; the ' +
        'exchange was substituted or the two ends disagree about the derivation',
    );
  }
}

/**
 * Decodes a base64url field of the pairing exchange, refusing a wrong length.
 *
 * @param text - the field.
 * @param length - the expected byte length.
 * @param what - a name for failure messages.
 */
export function decodeField(text: string, length: number, what: string): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = base64urlDecode(text);
  } catch {
    throw new PairingError(`${what} is not base64url`);
  }
  if (bytes.length !== length) {
    throw new PairingError(`${what} is ${length} bytes, got ${bytes.length}`);
  }
  return bytes;
}
