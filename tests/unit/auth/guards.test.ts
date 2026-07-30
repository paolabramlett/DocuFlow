import { describe, expect, it } from 'vitest';
import { resolveOnboardingRedirect, resolveStaffRedirect, type StaffContext } from '@/features/auth/context';

const context: StaffContext = {
  userId: 'u1',
  email: 'x@example.test',
  organizationId: 'o1',
  organizationName: 'Notaría X',
  organizationIndustry: 'notary',
  role: 'owner',
};

describe('resolveStaffRedirect', () => {
  it('no session, no context → /login', () => {
    expect(resolveStaffRedirect(null, false)).toBe('/login');
  });
  it('session, no context (no membership) → /onboarding', () => {
    expect(resolveStaffRedirect(null, true)).toBe('/onboarding');
  });
  it('session, has context → no redirect', () => {
    expect(resolveStaffRedirect(context, true)).toBeNull();
  });
});

describe('resolveOnboardingRedirect', () => {
  it('no session → /login', () => {
    expect(resolveOnboardingRedirect(false, false)).toBe('/login');
  });
  it('session, already staff → /cases', () => {
    expect(resolveOnboardingRedirect(true, true)).toBe('/cases');
  });
  it('session, not yet staff → no redirect (onboarding proceeds)', () => {
    expect(resolveOnboardingRedirect(true, false)).toBeNull();
  });
});
