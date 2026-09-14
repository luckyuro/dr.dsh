/**
 * What a person pasted: a pairing code, or a room key.
 *
 * Two credentials, one field. The alternative — a mode switch or two forms — asks the user to
 * know which kind of secret they were given, and the two are trivially distinguishable: a
 * pairing code is ten symbols from a 32-character alphabet, and a room key is 32 bytes of
 * base64url. Classifying here rather than in the page keeps the decision testable, because the
 * failure it can produce is silent: a code treated as a room key derives a room nobody serves,
 * and the user is told "no daemon is serving this room" about a code that was perfectly good.
 *
 * @module @dr.dsh/pwa/credential
 */

/** The alphabet a displayed pairing code uses. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** How many symbols a code carries, once its grouping dashes are removed. */
const CODE_SYMBOLS = 10;

/** A room key, as unpadded base64url of 32 bytes. */
const ROOM_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/** Why the pasted text was neither credential. */
export class CredentialError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CredentialError';
  }
}

/** What the user typed, classified. */
export type Credential =
  | { readonly kind: 'code'; readonly code: string }
  | { readonly kind: 'roomKey'; readonly roomKey: string };

/**
 * Classifies a pasted credential.
 *
 * The code branch is decided by *shape* — ten symbols of the pairing alphabet, whatever grouping
 * the user typed them with — and the room-key branch by a 43-character base64url value. Nothing
 * else is accepted: guessing at a near miss would produce a wrong key, and a wrong key produces a
 * failure that names the relay rather than the paste.
 *
 * @param text - what the user typed or pasted.
 * @throws CredentialError when it is neither.
 */
export function classifyCredential(text: string): Credential {
  const trimmed = text.trim();
  if (trimmed === '') {
    throw new CredentialError(
      'Enter the code `drdshd pair` printed, or the room key `drdshd room-key` printed.',
    );
  }

  // Grouping is presentation: `drdshd pair` prints `XXXX-XXXX-XX`, and people paste it either way.
  const symbols = [...trimmed.toUpperCase()].filter(character => character !== '-' && !/\s/u.test(character));
  const folded = symbols.map(character =>
    character === 'I' || character === 'L'
      ? '1'
      : character === 'O'
        ? '0'
        : character === 'U'
          ? 'V'
          : character,
  );
  if (folded.length === CODE_SYMBOLS && folded.every(symbol => CODE_ALPHABET.includes(symbol))) {
    // Re-grouped rather than stored as typed, so the value that reaches the parser is the one the
    // parser tests: two spellings of the same code must not become two code paths.
    const ungrouped = folded.join('');
    return { kind: 'code', code: `${ungrouped.slice(0, 4)}-${ungrouped.slice(4, 8)}-${ungrouped.slice(8)}` };
  }

  if (ROOM_KEY_PATTERN.test(trimmed)) {
    return { kind: 'roomKey', roomKey: trimmed };
  }

  // One message for every near miss, naming both shapes: telling a user "that is 42 characters"
  // is useful only if they know it should be 43, and they do not.
  throw new CredentialError(
    'That is neither a pairing code (10 symbols like 7Q4M-2XKP-9T) nor a room key (43 ' +
      'URL-safe characters, the value `drdshd room-key` prints). Check what you pasted — the ' +
      'pairing code expires after five minutes and a room key does not.',
  );
}

/**
 * A sentence for the credential, for the page to show while it works.
 *
 * @param credential - the classified value.
 */
export function describeCredential(credential: Credential): string {
  return credential.kind === 'code'
    ? `pairing code ${credential.code}`
    : 'a room key';
}
