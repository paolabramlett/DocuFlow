import { describe, expect, it } from 'vitest';
import { isSafeNextPath } from '@/app/auth/confirm/route';

describe('isSafeNextPath', () => {
  it('accepts the only value any real link ever sends', () => {
    expect(isSafeNextPath('/set-password')).toBe(true);
  });

  it('rejects a protocol-relative URL', () => {
    expect(isSafeNextPath('//evil.com')).toBe(false);
  });

  it('rejects a leading backslash that browsers parse as a scheme-relative host', () => {
    expect(isSafeNextPath('/\\evil.com')).toBe(false);
  });

  it('rejects a decoded tab that browsers strip before URL parsing', () => {
    expect(isSafeNextPath('/\t/evil.com')).toBe(false);
  });

  it('rejects an absolute external URL', () => {
    expect(isSafeNextPath('https://evil.com')).toBe(false);
  });

  it('rejects a value with no leading slash', () => {
    expect(isSafeNextPath('set-password')).toBe(false);
  });

  it('rejects null', () => {
    expect(isSafeNextPath(null)).toBe(false);
  });
});
