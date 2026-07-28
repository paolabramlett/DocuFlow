import { describe, expect, it } from 'vitest';
import { MIN_PASSWORD_LENGTH, passwordsAreValid } from '@/features/auth/password';

describe('passwordsAreValid', () => {
  it('accepts two matching passwords at or above the minimum length', () => {
    expect(passwordsAreValid('a'.repeat(MIN_PASSWORD_LENGTH), 'a'.repeat(MIN_PASSWORD_LENGTH))).toBe(true);
  });

  it('rejects a password shorter than the minimum length', () => {
    const short = 'a'.repeat(MIN_PASSWORD_LENGTH - 1);
    expect(passwordsAreValid(short, short)).toBe(false);
  });

  it('rejects two passwords that do not match', () => {
    expect(passwordsAreValid('a'.repeat(MIN_PASSWORD_LENGTH), 'b'.repeat(MIN_PASSWORD_LENGTH))).toBe(false);
  });
});
