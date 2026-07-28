/**
 * Client-side pre-check only — Supabase's own server-side password policy is the real
 * enforcement. Kept as one exported constant so the minLength attribute, the match check below,
 * and this file's own tests never drift from each other.
 */
export const MIN_PASSWORD_LENGTH = 8;

export function passwordsAreValid(password: string, confirmation: string): boolean {
  return password === confirmation && password.length >= MIN_PASSWORD_LENGTH;
}
