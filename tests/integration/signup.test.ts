import { describe, expect, it, vi } from 'vitest';
import { adminClient } from '../helpers/clients';

// `signUpAction` calls `@/lib/supabase/server`'s `createClient()`, which reads `next/headers`'
// `cookies()`. That API requires a live Next.js request scope (App Router render, Server Action
// dispatch, or Route Handler) — one doesn't exist when a plain Vitest process calls the action
// function directly, so the real `cookies()` throws "outside a request scope". This stub supplies
// an in-memory jar so the real Supabase auth calls underneath still run for real; it has no effect
// on production behavior, where a genuine request scope is always present.
vi.mock('next/headers', () => {
  const store = new Map<string, string>();
  return {
    cookies: async () => ({
      getAll: () => Array.from(store.entries()).map(([name, value]) => ({ name, value })),
      set: (name: string, value: string) => {
        store.set(name, value);
      },
    }),
  };
});

const { signUpAction } = await import('@/app/signup/actions');

describe('signUpAction', () => {
  it('returns ok(null) for a valid, fresh email', async () => {
    const result = await signUpAction(`signup-${Date.now()}@example.test`);
    expect(result).toEqual({ ok: true, data: null });
  });

  it('returns ok(null) for a malformed email — neutral, no distinct error', async () => {
    const result = await signUpAction('not-an-email');
    expect(result).toEqual({ ok: true, data: null });
  });

  it('returns ok(null) on a second attempt within the cooldown window — neutral, no distinct error', async () => {
    const email = `signup-cooldown-${Date.now()}@example.test`;
    const first = await signUpAction(email);
    const second = await signUpAction(email);
    expect(first).toEqual({ ok: true, data: null });
    expect(second).toEqual({ ok: true, data: null });
  });

  it('actually creates an unconfirmed auth user for a fresh, valid email', async () => {
    const email = `signup-real-${Date.now()}@example.test`;
    await signUpAction(email);

    const admin = adminClient();
    const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
    const created = data.users.find((u) => u.email === email);
    expect(created).toBeDefined();
    expect(created?.email_confirmed_at).toBeFalsy();
  });
});
