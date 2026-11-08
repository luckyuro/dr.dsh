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

import { t, LocalizedError, type DisplayText } from './i18n.ts';

import { validateCredential } from '@dr.dsh/validation';

/** Why the pasted text was neither credential. */
export class CredentialError extends LocalizedError {
  public constructor(message: DisplayText) {
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
      () => t('error.emptyCredential'),
    );
  }

  const result = validateCredential(trimmed);
  if (!result.issues) return result.value;

  // One message for every near miss, naming both shapes: telling a user "that is 42 characters"
  // is useful only if they know it should be 43, and they do not.
  throw new CredentialError(
    () => t('error.invalidCredential'),
  );
}

/**
 * A sentence for the credential, for the page to show while it works.
 *
 * @param credential - the classified value.
 */
export function describeCredential(credential: Credential): string {
  return credential.kind === 'code'
    ? t('credential.code', { code: credential.code })
    : t('credential.key');
}
