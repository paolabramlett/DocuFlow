import { createHash, randomBytes } from 'node:crypto';

/**
 * Invitation tokens.
 *
 * The clear-text token exists exactly once, in the response that hands it to the inviting Staff
 * member. Only its hash is stored, so a database disclosure yields no usable invitation
 * (design.md D5).
 *
 * The token is an identifier, never a credential: it names which grant a visitor is trying to
 * claim. Access still requires an OTP delivered to the invited mailbox.
 */

const TOKEN_BYTES = 32;

export interface InvitationToken {
  /** Returned to the caller once and never persisted. */
  readonly token: string;
  /** What goes in `case_access_grants.invitation_token_hash`. */
  readonly hash: string;
}

export function generateInvitationToken(): InvitationToken {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, hash: hashInvitationToken(token) };
}

/**
 * SHA-256 without a salt, deliberately.
 *
 * Password hashing is slow on purpose to survive guessing of low-entropy secrets. This token
 * carries 256 bits of entropy from a CSPRNG, so guessing is not the threat; a fast, constant
 * lookup by hash is what the flow needs.
 */
export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
