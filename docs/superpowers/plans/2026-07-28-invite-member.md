# Invite Member + Password Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the "Invitar miembro" control in the Miembros page actually invite people by email, and build the two password pages (`/set-password`, `/forgot-password`) that make the resulting invite/recovery emails' links go somewhere real.

**Architecture:** A new `inviteMember` use case (`src/application/invite-member.ts`) does authorization, identity resolution (reuse-or-create via the Supabase Admin API), membership insert, audit logging, and a best-effort notification email — all in the corrected order the spec's review round settled on. Two new standalone client-component pages (`/set-password`, `/forgot-password`) follow `src/app/login/page.tsx`'s existing single-file pattern (no Server Component wrapper needed — neither page reads server data).

**Tech Stack:** Next.js 16 App Router, Supabase Auth (Admin API + `client.auth.getUser()`), Zod, Vitest, TypeScript, Resend (direct HTTP call, not the Supabase mailer).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-28-invite-member-design.md` — every task below implements one piece of it; read it if anything here is ambiguous.
- Product name stays **"DocuFlow"** everywhere in this plan (email copy, sender name, comments). The DocuFlow → AVANZA rebrand is explicitly a separate, future spec — do not rename anything here.
- `inviteMember`'s signature is `inviteMember(client, admin, input, sendEmail = sendTransactionalEmail)` — the fourth parameter exists only for tests; production call sites never pass it.
- The audit event's `actor` is always the inviting owner (`actorUser.id`) — never the invited person. This was a real bug in an earlier draft of the spec; do not reintroduce it.
- `organizationId` is never accepted as client input anywhere in this feature — always from `getStaffContext()` on the server.
- Files under `src/app/**` use double-quoted strings (matches `src/app/settings/actions.ts`, `src/app/login/page.tsx`). Files under `src/application/**`, `src/features/**`, `src/lib/**`, and **all of `tests/**`** use single-quoted strings — every existing file in `tests/integration/` and `tests/isolation/` uses single quotes with zero exceptions (verified directly, not assumed); an earlier version of this constraint incorrectly said `tests/**` uses double quotes, which was a mistake in this plan, not a real convention.
- Local Supabase stack must be running for every integration test: `npm run db:start` (idempotent if already running).
- Run `npm run lint` and `npm run typecheck` at the end of every task that touches TypeScript.
- This codebase has **no component-testing infrastructure** (`vitest.config.ts` runs `environment: 'node'` against real Postgres, no jsdom/`@testing-library/react`). Do not add one — it's explicitly out of scope per the spec. `/set-password` and `/forgot-password` get manual verification, plus unit tests only for the pure logic extracted into `src/features/auth/password.ts`.

---

### Task 1: Password validation helpers

**Files:**
- Create: `src/features/auth/password.ts`
- Test: `tests/unit/password.test.ts`

**Interfaces:**
- Produces: `MIN_PASSWORD_LENGTH: number` and `passwordsAreValid(password: string, confirmation: string): boolean`. Task 7 (`/set-password`) depends on both.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/password.test.ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/unit/password.test.ts
```
Expected: FAIL — `Cannot find module '@/features/auth/password'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/features/auth/password.ts

/**
 * Client-side pre-check only — Supabase's own server-side password policy is the real
 * enforcement. Kept as one exported constant so the minLength attribute, the match check below,
 * and this file's own tests never drift from each other.
 */
export const MIN_PASSWORD_LENGTH = 8;

export function passwordsAreValid(password: string, confirmation: string): boolean {
  return password === confirmation && password.length >= MIN_PASSWORD_LENGTH;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/unit/password.test.ts
```
Expected: PASS, all 3 tests.

- [ ] **Step 5: Lint and typecheck**

```bash
npm run lint
npm run typecheck
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/features/auth/password.ts tests/unit/password.test.ts
git commit -m "Add password validation helpers for /set-password"
```

---

### Task 2: Resend email helper

**Files:**
- Create: `src/lib/email/resend.ts`
- Test: `tests/unit/resend.test.ts`

**Interfaces:**
- Consumes: `required` from `@/lib/supabase/env` (the existing pattern — do not invent a second env-reading helper).
- Produces: `sendTransactionalEmail(input: { to: string; subject: string; html: string; idempotencyKey?: string }): Promise<void>`. Task 4 (`inviteMember`) depends on this exact signature.

- [ ] **Step 1: Add `RESEND_API_KEY` to the env module**

Read `src/lib/supabase/env.ts` first. Add, alongside the existing `required()`-based exports (do not change the existing `SUPABASE_URL`/`SUPABASE_ANON_KEY`/`serviceRoleKey` exports):

```ts
export const RESEND_API_KEY = required('RESEND_API_KEY');
```

This file's `required(name)` helper already exists and throws if the variable is missing — reuse it, don't duplicate it.

- [ ] **Step 2: Add `RESEND_API_KEY` to `.env.local` for local testing**

Read `.env.local` first (do not overwrite unrelated lines). Append:
```
RESEND_API_KEY=re_test_placeholder_key_for_local_dev
```
This unit test mocks `fetch` and never makes a real network call, but the module-level `required('RESEND_API_KEY')` call still needs *some* value present at import time or every test in the suite that imports anything from this module transitively would fail to even load. A placeholder value is fine for local/test — production sets the real key via Vercel env vars (already noted in the spec's "Production configuration required" section).

- [ ] **Step 3: Write the failing test**

```ts
// tests/unit/resend.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendTransactionalEmail } from '@/lib/email/resend';

describe('sendTransactionalEmail', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts to the Resend API with the required headers and body', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'test' }), { status: 200 }),
    );

    await sendTransactionalEmail({
      to: 'someone@example.test',
      subject: 'Test subject',
      html: '<p>hi</p>',
      idempotencyKey: 'test-key-123',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('docuflow/1.0');
    expect(headers['Idempotency-Key']).toBe('test-key-123');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toMatch(/^Bearer /);
    const body = JSON.parse(init?.body as string);
    expect(body).toMatchObject({
      to: 'someone@example.test',
      subject: 'Test subject',
      html: '<p>hi</p>',
    });
  });

  it('omits the Idempotency-Key header when none is given', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'test' }), { status: 200 }),
    );

    await sendTransactionalEmail({ to: 'someone@example.test', subject: 'S', html: '<p>h</p>' });

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect('Idempotency-Key' in headers).toBe(false);
  });

  it('throws a redacted error on a non-ok response, never the raw body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ name: 'validation_error', message: 'to: invalid recipient list' }), {
        status: 422,
      }),
    );

    await expect(
      sendTransactionalEmail({ to: 'bad', subject: 'S', html: '<p>h</p>' }),
    ).rejects.toThrow(/422/);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

```bash
npx vitest run tests/unit/resend.test.ts
```
Expected: FAIL — `Cannot find module '@/lib/email/resend'`.

- [ ] **Step 5: Write the implementation**

```ts
// src/lib/email/resend.ts
import { RESEND_API_KEY } from '@/lib/supabase/env';

export interface SendTransactionalEmailInput {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly idempotencyKey?: string;
}

/**
 * Sends one transactional email directly via Resend's HTTP API — not through Supabase Auth's
 * mailer, which only handles Supabase-native auth emails (invite/recovery/magic link). Reserved
 * for product-initiated notifications that have nothing to do with authentication, e.g. "you were
 * added to an existing organization" (see src/application/invite-member.ts).
 */
export async function sendTransactionalEmail(input: SendTransactionalEmailInput): Promise<void> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      // Resend's HTTP API rejects requests with no User-Agent (403, error 1010) — its own SDK
      // sets this automatically; a manual fetch has to do it explicitly. Rename to avanza/1.0
      // whenever the product rebrand lands; this string is never user-visible.
      'User-Agent': 'docuflow/1.0',
      ...(input.idempotencyKey ? { 'Idempotency-Key': input.idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from: 'DocuFlow <noreply@avanza.work>',
      to: input.to,
      subject: input.subject,
      html: input.html,
    }),
  });

  if (!response.ok) {
    // Parsed only for Resend's own error `name`/`message` fields — never the raw response body,
    // which could otherwise carry recipient/content details into logs.
    const body = await response.json().catch(() => null);
    throw new Error(`Resend API error: ${response.status} ${body?.name ?? body?.message ?? 'unknown_error'}`);
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
npx vitest run tests/unit/resend.test.ts
```
Expected: PASS, all 3 tests.

- [ ] **Step 7: Lint and typecheck**

```bash
npm run lint
npm run typecheck
```
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/lib/email/resend.ts src/lib/supabase/env.ts tests/unit/resend.test.ts .env.local
git commit -m "Add direct Resend email helper"
```
(If `.env.local` is gitignored in this repo — check with `git check-ignore .env.local` before running the add — skip it in the commit; the placeholder value is a local-only concern either way.)

---

### Task 3: `inviteMember` use case

**Files:**
- Create: `src/application/invite-member.ts`
- Test: `tests/integration/invite-member.test.ts`

**Interfaces:**
- Consumes: `sendTransactionalEmail` (Task 2), `createAdminClient`/`AdminClient` from `@/lib/supabase/admin`, `APP_ORIGIN` (added in Step 1 below), `UseCaseError`/`ValidationError`/`parseInput` (existing), `logDomainEvent` (existing), `buildOrganizationWorld`/`createTestUser`/`addStaffMember` from test fixtures.
- Produces: `inviteMember(client: DbClient, admin: AdminClient, input: InviteMemberInput, sendEmail?: typeof sendTransactionalEmail): Promise<void>` and `interface InviteMemberInput { readonly organizationId: string; readonly email: string }`. Task 4 (Server Action) depends on this exact signature.

- [ ] **Step 1: Add `APP_ORIGIN` to the env module**

Read `src/lib/supabase/env.ts` first (it may already have `RESEND_API_KEY` from Task 2). Add:
```ts
export const APP_ORIGIN = required('APP_ORIGIN');
```
Add to `.env.local`:
```
APP_ORIGIN=http://localhost:3000
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/integration/invite-member.test.ts
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { adminClient, createTestUser } from '../helpers/clients';
import { buildOrganizationWorld } from '../helpers/fixtures';
import { inviteMember } from '@/application/invite-member';
import { UseCaseError } from '@/application/errors';

describe('inviteMember', () => {
  it("invites a brand-new email, creating the auth user and attributing the audit event to the owner", async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Invitar',
      industry: 'notary',
      clientEmail: `primary-${randomUUID()}@example.test`,
    });
    const newEmail = `brand-new-${randomUUID()}@example.test`;

    await inviteMember(world.owner.client, adminClient(), {
      organizationId: world.organizationId,
      email: newEmail,
    });

    const { data: newAuthUser } = await adminClient().auth.admin.listUsers({ page: 1, perPage: 200 });
    const created = newAuthUser.users.find((u) => u.email === newEmail);
    expect(created).toBeDefined();

    const { data: memberRow } = await adminClient()
      .from('members')
      .select('role, user_id')
      .eq('organization_id', world.organizationId)
      .eq('user_id', created!.id)
      .single();
    expect(memberRow?.role).toBe('staff');

    const { data: events } = await adminClient()
      .from('audit_events')
      .select('actor_auth_user_id, action, target_id, metadata')
      .eq('organization_id', world.organizationId)
      .eq('action', 'member.added');
    expect(events).toHaveLength(1);
    expect(events?.[0]?.actor_auth_user_id).toBe(world.owner.userId);
    expect(events?.[0]?.actor_auth_user_id).not.toBe(created!.id);
    expect((events?.[0]?.metadata as { identityAlreadyExisted: boolean }).identityAlreadyExisted).toBe(false);
  });

  it('adds an existing identity as a member without inviting them again, and notifies them via the injected sender', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Existente',
      industry: 'notary',
      clientEmail: `primary-${randomUUID()}@example.test`,
    });
    const existing = await createTestUser('existing');

    const sendEmail = vi.fn().mockResolvedValue(undefined);
    await inviteMember(
      world.owner.client,
      adminClient(),
      { organizationId: world.organizationId, email: existing.email },
      sendEmail,
    );

    const { data: memberRow } = await adminClient()
      .from('members')
      .select('role')
      .eq('organization_id', world.organizationId)
      .eq('user_id', existing.userId)
      .single();
    expect(memberRow?.role).toBe('staff');

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0]![0]).toMatchObject({ to: existing.email });

    const { data: events } = await adminClient()
      .from('audit_events')
      .select('metadata')
      .eq('organization_id', world.organizationId)
      .eq('action', 'member.added');
    expect((events?.[0]?.metadata as { identityAlreadyExisted: boolean }).identityAlreadyExisted).toBe(true);
  });

  it('refuses a duplicate invite to someone already a member of the same org', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Duplicado',
      industry: 'notary',
      clientEmail: `primary-${randomUUID()}@example.test`,
    });
    const existing = await createTestUser('dup');
    const sendEmail = vi.fn().mockResolvedValue(undefined);

    await inviteMember(
      world.owner.client,
      adminClient(),
      { organizationId: world.organizationId, email: existing.email },
      sendEmail,
    );

    await expect(
      inviteMember(
        world.owner.client,
        adminClient(),
        { organizationId: world.organizationId, email: existing.email },
        sendEmail,
      ),
    ).rejects.toMatchObject({ reason: 'conflict' });

    const { data: memberRows } = await adminClient()
      .from('members')
      .select('id')
      .eq('organization_id', world.organizationId)
      .eq('user_id', existing.userId);
    expect(memberRows).toHaveLength(1);
  });

  it('normalizes email casing and surrounding whitespace to the same identity', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Normaliza',
      industry: 'notary',
      clientEmail: `primary-${randomUUID()}@example.test`,
    });
    const existing = await createTestUser('norm');
    const shouty = `  ${existing.email.toUpperCase()}  `;

    await inviteMember(world.owner.client, adminClient(), {
      organizationId: world.organizationId,
      email: shouty,
    });

    const { data: memberRow } = await adminClient()
      .from('members')
      .select('role')
      .eq('organization_id', world.organizationId)
      .eq('user_id', existing.userId)
      .maybeSingle();
    expect(memberRow?.role).toBe('staff');
  });

  it("refuses a non-owner staff member via the use case's own ownership check", async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría No Owner',
      industry: 'notary',
      clientEmail: `primary-${randomUUID()}@example.test`,
    });

    await expect(
      inviteMember(world.staff.client, adminClient(), {
        organizationId: world.organizationId,
        email: `victim-${randomUUID()}@example.test`,
      }),
    ).rejects.toMatchObject({ reason: 'forbidden' });
    await expect(
      inviteMember(world.staff.client, adminClient(), {
        organizationId: world.organizationId,
        email: `victim-${randomUUID()}@example.test`,
      }),
    ).rejects.toBeInstanceOf(UseCaseError);
  });

  it('also refuses a non-owner at the RLS floor, independent of the use case', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría RLS Floor',
      industry: 'notary',
      clientEmail: `primary-${randomUUID()}@example.test`,
    });
    const target = await createTestUser('rls-floor');

    // Bypasses the use case entirely — proves members_insert_by_owner holds even if the
    // application-layer check above had a bug.
    const { data, error } = await world.staff.client
      .from('members')
      .insert({ organization_id: world.organizationId, user_id: target.userId, role: 'staff' })
      .select();

    expect(data ?? []).toEqual([]);
    expect(error).not.toBeNull();
  });

  it('deletes the newly-created auth user if the membership insert fails, but never an existing identity', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Compensación',
      industry: 'notary',
      clientEmail: `primary-${randomUUID()}@example.test`,
    });
    const brandNewEmail = `compensate-${randomUUID()}@example.test`;

    // A foreign organizationId makes the membership insert fail at the RLS floor (the owner's
    // client is not a member of this made-up org), simulating "insert fails for some reason"
    // without needing to fabricate a lower-level DB error.
    const foreignOrganizationId = randomUUID();

    await expect(
      inviteMember(world.owner.client, adminClient(), {
        organizationId: foreignOrganizationId,
        email: brandNewEmail,
      }),
    ).rejects.toThrow();

    const { data: usersAfter } = await adminClient().auth.admin.listUsers({ page: 1, perPage: 200 });
    expect(usersAfter.users.some((u) => u.email === brandNewEmail)).toBe(false);
  });

  it('organizationId always comes from the caller, never causes a cross-tenant write even if foreign', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Cross Tenant',
      industry: 'notary',
      clientEmail: `primary-${randomUUID()}@example.test`,
    });

    await expect(
      inviteMember(world.owner.client, adminClient(), {
        organizationId: randomUUID(),
        email: `nobody-${randomUUID()}@example.test`,
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npx vitest run tests/integration/invite-member.test.ts
```
Expected: FAIL — `Cannot find module '@/application/invite-member'`.

- [ ] **Step 4: Write the implementation**

```ts
// src/application/invite-member.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { Database } from '@/types/database';
import { ValidationError, parseInput } from '@/lib/validation/parse';
import { UseCaseError } from './errors';
import { logDomainEvent } from './events';
import type { AdminClient } from '@/lib/supabase/admin';
import { sendTransactionalEmail, type SendTransactionalEmailInput } from '@/lib/email/resend';
import { APP_ORIGIN } from '@/lib/supabase/env';

type DbClient = SupabaseClient<Database>;

const inviteMemberSchema = z.object({
  organizationId: z.string().uuid(),
  email: z.string().trim().email(),
});

export type InviteMemberInput = z.input<typeof inviteMemberSchema>;

const LIST_USERS_PAGE_SIZE = 200;
const LIST_USERS_MAX_PAGES = 25;

/**
 * Paginated lookup by exact, normalized email — the same bound and approach as
 * tests/helpers/fixtures.ts's findAuthUserIdByEmail and scripts/seed-demo.mjs's
 * findUserByEmail, moved into product code since this is the first place a real feature (not a
 * fixture) needs it. Never a partial/substring match.
 */
async function findAuthUserByEmail(admin: AdminClient, normalizedEmail: string) {
  for (let page = 1; page <= LIST_USERS_MAX_PAGES; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: LIST_USERS_PAGE_SIZE });
    if (error) throw new Error(`Could not list users: ${error.message}`);

    const match = data.users.find((user) => user.email?.toLowerCase() === normalizedEmail);
    if (match) return match;
    if (data.users.length < LIST_USERS_PAGE_SIZE) return null;
  }
  return null;
}

/**
 * Invites a person into an Organization by email, as staff.
 *
 * Authorization and audit attribution are both anchored to `client.auth.getUser()` — the
 * cryptographically verified calling session — never to anything this function is merely told.
 * `actorUser` (the inviting owner) and `invitedAuthUser` (the identity being resolved or created
 * for the invitee) are kept in clearly separate variables throughout: conflating the two was a
 * real bug in an earlier draft of this design, where the audit event ended up crediting the
 * invited person instead of the owner who did the inviting.
 *
 * `sendEmail` exists only for tests — production callers never pass it, and the real
 * `sendTransactionalEmail` default is what actually runs.
 */
export async function inviteMember(
  client: DbClient,
  admin: AdminClient,
  input: InviteMemberInput,
  sendEmail: (input: SendTransactionalEmailInput) => Promise<void> = sendTransactionalEmail,
): Promise<void> {
  let parsed;
  try {
    parsed = parseInput(inviteMemberSchema, input);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new UseCaseError('validation', 'Revisa el correo.', error.issues);
    }
    throw error;
  }
  const { organizationId } = parsed;
  const normalizedEmail = parsed.email.toLowerCase();

  const {
    data: { user: actorUser },
  } = await client.auth.getUser();
  if (!actorUser) {
    throw new UseCaseError('unauthenticated', 'Tu sesión expiró. Inicia sesión de nuevo.');
  }

  const { data: actorMembership, error: actorMembershipError } = await client
    .from('members')
    .select('role')
    .eq('organization_id', organizationId)
    .eq('user_id', actorUser.id)
    .maybeSingle();
  if (actorMembershipError) {
    throw new Error(`Could not resolve membership: ${actorMembershipError.message}`);
  }
  if (actorMembership?.role !== 'owner') {
    throw new UseCaseError('forbidden', 'Solo el propietario puede invitar miembros.');
  }

  const { data: organization, error: organizationError } = await client
    .from('organizations')
    .select('name')
    .eq('id', organizationId)
    .single();
  if (organizationError || !organization) {
    throw new Error(`Could not resolve organization: ${organizationError?.message ?? 'not found'}`);
  }

  const existingAuthUser = await findAuthUserByEmail(admin, normalizedEmail);

  let invitedAuthUserId: string;
  const weCreatedThisIdentity = existingAuthUser === null;

  if (existingAuthUser) {
    invitedAuthUserId = existingAuthUser.id;
  } else {
    const { data: created, error: inviteError } = await admin.auth.admin.inviteUserByEmail(normalizedEmail, {
      redirectTo: `${APP_ORIGIN}/set-password`,
    });
    if (inviteError || !created.user) {
      throw new Error(`Could not invite user: ${inviteError?.message ?? 'no user returned'}`);
    }
    invitedAuthUserId = created.user.id;
  }

  // Only meaningful (and only reachable) for an identity that already existed — a brand-new
  // identity cannot already be a member of anything.
  if (!weCreatedThisIdentity) {
    const { data: existingMembership } = await client
      .from('members')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('user_id', invitedAuthUserId)
      .maybeSingle();
    if (existingMembership) {
      throw new UseCaseError('conflict', 'Esta persona ya es miembro de tu organización.');
    }
  }

  const { data: insertedMember, error: insertError } = await client
    .from('members')
    .insert({ organization_id: organizationId, user_id: invitedAuthUserId, role: 'staff' })
    .select('id')
    .single();

  if (insertError || !insertedMember) {
    // Postgres unique-violation (23505) on (organization_id, user_id) is the real backstop
    // against a concurrent double-invite — the pre-check query above is a fast, friendly
    // rejection, not the actual guarantee.
    if (insertError?.code === '23505') {
      throw new UseCaseError('conflict', 'Esta persona ya es miembro de tu organización.');
    }

    if (weCreatedThisIdentity) {
      try {
        await admin.auth.admin.deleteUser(invitedAuthUserId);
      } catch (cleanupError) {
        // A cleanup failure must never replace or mask the real failure that triggered it — the
        // original insert error is always what gets thrown, below, regardless of this outcome.
        console.error('Failed to clean up auth user after failed membership insert', {
          invitedAuthUserId,
          cleanupError,
        });
      }
    }
    throw new Error(`Could not create membership: ${insertError?.message ?? 'no row returned'}`);
  }

  // Logged immediately after the insert succeeds, before anything else — a slow external call
  // (the notification email below) must never delay the domain event describing a change that
  // already happened.
  await logDomainEvent(client, {
    organizationId,
    action: 'member.added',
    targetType: 'member',
    targetId: insertedMember.id,
    actor: { kind: 'member', authUserId: actorUser.id },
    metadata: {
      invitedEmail: normalizedEmail,
      invitedAuthUserId,
      identityAlreadyExisted: !weCreatedThisIdentity,
    },
  });

  if (!weCreatedThisIdentity) {
    // Supabase cannot "invite" an identity that already exists, so without this the person would
    // gain access with zero notice. Best-effort, last in the sequence: never let a notification
    // failure fail the membership itself — the row is already real.
    try {
      await sendEmail({
        to: normalizedEmail,
        subject: `Te agregaron al equipo de ${organization.name} en DocuFlow`,
        html: `<p>Ya tienes acceso. Entra en <a href="${APP_ORIGIN}/login">${APP_ORIGIN}/login</a> con tu correo.</p><p>Si todavía no tienes contraseña, usa "¿Olvidaste tu contraseña?" para crear una.</p>`,
        idempotencyKey: `member-added/${organizationId}/${insertedMember.id}`,
      });
    } catch (emailError) {
      console.error('Failed to send existing-member notification', {
        organizationId,
        memberId: insertedMember.id,
        status: 'email_delivery_failed',
        emailError,
      });
    }
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run tests/integration/invite-member.test.ts
```
Expected: PASS, all 8 tests.

- [ ] **Step 6: Run the full suite once**

```bash
npx vitest run
```
Expected: no regressions.

- [ ] **Step 7: Lint and typecheck**

```bash
npm run lint
npm run typecheck
```
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/application/invite-member.ts src/lib/supabase/env.ts tests/integration/invite-member.test.ts .env.local
git commit -m "Add inviteMember use case"
```

---

### Task 4: Server Action

**Files:**
- Create: `src/app/members/actions.ts`

**Interfaces:**
- Consumes: `inviteMember`, `InviteMemberInput` from Task 3; `getStaffContext` from `@/features/auth/context`; `createClient` from `@/lib/supabase/server`; `createAdminClient` from `@/lib/supabase/admin`; `fail`, `ok`, `ActionResult` from `@/application/errors`.
- Produces: `inviteMemberAction(email: string): Promise<ActionResult<null>>`. Task 5 (UI) depends on this.

- [ ] **Step 1: Write the Server Action**

```ts
// src/app/members/actions.ts
"use server";

/*
 * Server Action for Miembros. Thin: re-establish identity, fast-reject a non-owner before ever
 * calling the use case, delegate, return a typed result. inviteMember re-verifies independently
 * regardless — this check is a fast, user-facing rejection for a non-owner hitting this by
 * direct POST, not the real authorization boundary.
 */

import { revalidatePath } from "next/cache";
import { getStaffContext } from "@/features/auth/context";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fail, ok, type ActionResult } from "@/application/errors";
import { inviteMember } from "@/application/invite-member";

export async function inviteMemberAction(email: string): Promise<ActionResult<null>> {
  try {
    const staff = await getStaffContext();
    if (!staff) {
      return { ok: false, reason: "unauthenticated", message: "Tu sesión expiró. Inicia sesión de nuevo." };
    }
    if (staff.role !== "owner") {
      return { ok: false, reason: "forbidden", message: "Solo el propietario puede invitar miembros." };
    }

    const supabase = await createClient();
    await inviteMember(supabase, createAdminClient(), { organizationId: staff.organizationId, email });

    revalidatePath("/members");
    return ok(null);
  } catch (error) {
    return fail(error);
  }
}
```

- [ ] **Step 2: Typecheck and lint**

```bash
npm run typecheck
npm run lint
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/app/members/actions.ts
git commit -m "Add inviteMemberAction Server Action"
```

---

### Task 5: Miembros UI — enable the invite control

**Files:**
- Modify: `src/app/members/members-directory.tsx`

**Interfaces:**
- Consumes: `inviteMemberAction` from Task 4 (`../actions`, since this file lives at `src/app/members/members-directory.tsx` and the action is at `src/app/members/actions.ts` — a sibling, so the import path is `./actions`, not `../actions`; double check the exact relative path against the real file locations before writing the import).

- [ ] **Step 1: Read the current file**

Read `src/app/members/members-directory.tsx` in full first (it currently renders the invite button permanently `disabled` with a "Próximamente" tooltip and no state at all).

- [ ] **Step 2: Replace the file with the working version**

```tsx
// src/app/members/members-directory.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell, type ShellAccount } from "@/components/app-shell";
import { IconMail } from "@/components/icons";
import type { MemberDirectoryRow } from "@/features/members/queries";
import { inviteMemberAction } from "./actions";

const ROLE_LABEL: Record<MemberDirectoryRow["role"], string> = {
  owner: "Propietario",
  staff: "Staff",
};

export function MembersDirectory({
  members,
  isOwner,
  account,
}: {
  members: MemberDirectoryRow[];
  isOwner: boolean;
  account: ShellAccount;
}) {
  const router = useRouter();
  const [modalOpen, setModalOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const result = await inviteMemberAction(email);
    setPending(false);
    if (result.ok) {
      setModalOpen(false);
      setEmail("");
      router.refresh();
    } else {
      setError(result.message);
    }
  }

  function closeModal() {
    setModalOpen(false);
    setEmail("");
    setError(null);
  }

  return (
    <AppShell active="members" account={account}>
      <div className="flex h-16 shrink-0 items-center gap-4 border-b border-border bg-surface px-7">
        <h1 className="text-base font-semibold text-text-primary">Miembros</h1>
        {isOwner && (
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="ml-auto flex items-center gap-2 rounded-input bg-royal-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-royal-700"
          >
            <IconMail className="size-4" /> Invitar miembro
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-7 py-6">
        <div className="mb-6">
          <h2 className="text-xl font-semibold tracking-tight text-text-primary">Miembros</h2>
          <p className="mt-1 max-w-2xl text-sm text-text-secondary">
            Todo el equipo de tu organización. Cualquier miembro puede ver este directorio.
          </p>
        </div>

        <div className="overflow-hidden rounded-card border border-border bg-surface">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-app-bg text-xs font-semibold uppercase tracking-wider text-text-secondary">
              <tr>
                <th className="px-5 py-3">Correo</th>
                <th className="px-5 py-3">Rol</th>
                <th className="px-5 py-3">Miembro desde</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {members.map((m) => (
                <tr key={m.id}>
                  <td className="px-5 py-3 font-medium text-text-primary">{m.email}</td>
                  <td className="px-5 py-3 text-text-secondary">{ROLE_LABEL[m.role]}</td>
                  <td className="px-5 py-3 text-text-secondary">{m.memberSince}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {modalOpen && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-panel border border-border bg-surface p-6 shadow-md">
            <h2 className="text-base font-semibold text-text-primary">Invitar miembro</h2>
            <form onSubmit={submit} className="mt-4 flex flex-col gap-4">
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-text-primary">Correo electrónico</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                  className="w-full rounded-input border border-border bg-app-bg px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-royal-500 focus:bg-surface focus:ring-2 focus:ring-royal-100"
                />
              </label>

              {error && <p className="text-sm text-error">{error}</p>}

              <div className="mt-1 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={closeModal}
                  className="rounded-input border border-border bg-surface px-3.5 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-app-bg"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={pending}
                  className="rounded-input bg-royal-600 px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-royal-700 disabled:opacity-60"
                >
                  {pending ? "Enviando…" : "Enviar invitación"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </AppShell>
  );
}
```

Note the import is `from "./actions"` — `members-directory.tsx` and `actions.ts` are both directly inside `src/app/members/`, siblings, not a nested/parent relationship.

- [ ] **Step 2: Typecheck and lint**

```bash
npm run typecheck
npm run lint
```
Expected: clean.

- [ ] **Step 3: Manual verification**

```bash
npm run db:start
npm run db:seed
npm run dev
```
Log in as the seeded owner, go to `/members`, click "Invitar miembro", submit a fresh email address (e.g. `test-invite-1@example.test`), confirm the modal closes and the new row appears in the table with role "Staff". Try inviting the exact same email again and confirm the inline error reads "Esta persona ya es miembro de tu organización." Log in as a non-owner staff account (if the seed produces one) and confirm the invite button is entirely absent. Stop the dev server when done.

- [ ] **Step 4: Commit**

```bash
git add src/app/members/members-directory.tsx
git commit -m "Wire the Invitar miembro control to the real invite flow"
```

---

### Task 6: `/set-password` page

**Files:**
- Create: `src/app/set-password/page.tsx`

**Interfaces:**
- Consumes: `MIN_PASSWORD_LENGTH`, `passwordsAreValid` from Task 1; `createClient` from `@/lib/supabase/client` (the existing browser client, same one `src/app/login/page.tsx` already uses).

- [ ] **Step 1: Write the page**

```tsx
// src/app/set-password/page.tsx
"use client";

/*
 * Shared landing for two entry points: clicking an invite email's link, or a "forgot password"
 * recovery email's link. Both resolve to an authenticated session once Supabase processes the
 * URL — the invite link as an ordinary SIGNED_IN, the recovery link with a dedicated
 * PASSWORD_RECOVERY event. This page deliberately does not try to tell the two apart: any
 * authenticated session may set a new password here, an accepted, explicit product decision
 * (see docs/superpowers/specs/2026-07-28-invite-member-design.md).
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { MIN_PASSWORD_LENGTH, passwordsAreValid } from "@/features/auth/password";

type LinkState = "resolving" | "valid" | "invalid";

const RESOLUTION_TIMEOUT_MS = 5000;

export default function SetPasswordPage() {
  const router = useRouter();
  const [linkState, setLinkState] = useState<LinkState>("resolving");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolvedRef = useRef(false);

  useEffect(() => {
    const supabase = createClient();
    let timeoutId: ReturnType<typeof setTimeout>;

    function resolve(next: LinkState) {
      if (resolvedRef.current) return;
      resolvedRef.current = true;
      clearTimeout(timeoutId);
      setLinkState(next);
    }

    // Two conclusive signals decide this — an authenticated user, or an explicit auth error.
    // The timeout below is a last-resort fallback only, never the primary way this is decided:
    // slow hydration or a slow connection must not be misread as an invalid link.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if ((event === "SIGNED_IN" || event === "PASSWORD_RECOVERY" || event === "INITIAL_SESSION") && session?.user) {
        resolve("valid");
      }
    });

    supabase.auth.getUser().then(({ data, error: getUserError }) => {
      if (data.user) {
        resolve("valid");
      } else if (getUserError) {
        resolve("invalid");
      }
    });

    timeoutId = setTimeout(() => resolve("invalid"), RESOLUTION_TIMEOUT_MS);

    return () => {
      clearTimeout(timeoutId);
      subscription.unsubscribe();
    };
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!passwordsAreValid(password, confirmation)) {
      setError(`Las contraseñas deben coincidir y tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
      return;
    }

    setPending(true);
    const supabase = createClient();
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setPending(false);

    if (updateError) {
      setError(updateError.message);
      return;
    }

    setSaved(true);
    router.push("/cases");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-app-bg px-5 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <div className="flex items-center gap-2.5">
            <div className="flex size-8 items-center justify-center rounded-input bg-royal-600 text-sm font-bold text-white">D</div>
            <span className="text-[15px] font-semibold tracking-tight text-text-primary">DocuFlow</span>
          </div>
        </div>

        <div className="rounded-panel border border-border bg-surface p-7 shadow-md">
          {linkState === "resolving" && (
            <p className="text-sm text-text-secondary">Validando enlace…</p>
          )}

          {linkState === "invalid" && (
            <>
              <h1 className="text-xl font-semibold tracking-tight text-text-primary">Enlace vencido o inválido</h1>
              <p className="mt-2 text-sm text-text-secondary">
                Pide un enlace nuevo e inténtalo de nuevo.
              </p>
            </>
          )}

          {linkState === "valid" && !saved && (
            <form onSubmit={onSubmit} className="flex flex-col gap-4">
              <h1 className="text-xl font-semibold tracking-tight text-text-primary">Establece tu contraseña</h1>

              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-text-primary">Nueva contraseña</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={MIN_PASSWORD_LENGTH}
                  autoComplete="new-password"
                  required
                  className="w-full rounded-input border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-royal-500 focus:ring-2 focus:ring-royal-100"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-text-primary">Confirmar contraseña</span>
                <input
                  type="password"
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  minLength={MIN_PASSWORD_LENGTH}
                  autoComplete="new-password"
                  required
                  className="w-full rounded-input border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-royal-500 focus:ring-2 focus:ring-royal-100"
                />
              </label>

              {error && <p className="text-sm text-error">{error}</p>}

              <button
                type="submit"
                disabled={pending}
                className="mt-2 w-full rounded-input bg-royal-600 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-royal-700 disabled:opacity-60"
              >
                {pending ? "Guardando…" : "Guardar contraseña"}
              </button>
            </form>
          )}

          {saved && <p className="text-sm text-success">Contraseña guardada. Entrando…</p>}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck and lint**

```bash
npm run typecheck
npm run lint
```
Expected: clean.

- [ ] **Step 3: Manual verification (as much as is possible without a real invite/recovery link yet)**

```bash
npm run dev
```
Navigate to `http://localhost:3000/set-password` directly with no session at all — confirm it shows "Validando enlace…" then, after a few seconds, "Enlace vencido o inválido" (no form). Full end-to-end verification (a real invite or recovery link actually landing here with a valid session) happens naturally once Task 5's invite flow and Task 7's forgot-password flow are both in place — re-verify then. Stop the dev server when done.

- [ ] **Step 4: Commit**

```bash
git add src/app/set-password/page.tsx
git commit -m "Add the /set-password page"
```

---

### Task 7: `/forgot-password` page + login link

**Files:**
- Create: `src/app/forgot-password/page.tsx`
- Modify: `src/app/login/page.tsx`

**Interfaces:**
- Consumes: `createClient` from `@/lib/supabase/client`.

- [ ] **Step 1: Write the forgot-password page**

```tsx
// src/app/forgot-password/page.tsx
"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);

    const normalizedEmail = email.trim().toLowerCase();
    const supabase = createClient();
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(normalizedEmail, {
      redirectTo: `${window.location.origin}/set-password`,
    });
    setPending(false);

    if (resetError) {
      // Supabase's resetPasswordForEmail already never reveals whether the address exists — an
      // error here is a genuine operational failure (network, rate limit, misconfiguration), not
      // "email not found", so it gets its own distinct message rather than folding into the
      // neutral success text below.
      setError("No pudimos procesar tu solicitud. Inténtalo de nuevo en unos minutos.");
      return;
    }

    setSent(true);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-app-bg px-5 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <div className="flex items-center gap-2.5">
            <div className="flex size-8 items-center justify-center rounded-input bg-royal-600 text-sm font-bold text-white">D</div>
            <span className="text-[15px] font-semibold tracking-tight text-text-primary">DocuFlow</span>
          </div>
        </div>

        <div className="rounded-panel border border-border bg-surface p-7 shadow-md">
          <h1 className="text-xl font-semibold tracking-tight text-text-primary">Recuperar contraseña</h1>
          <p className="mt-1 text-sm text-text-secondary">Te enviaremos un enlace para elegir una nueva.</p>

          {sent ? (
            <p className="mt-4 text-sm text-text-secondary">
              Si existe una cuenta con este correo, recibirás un enlace para restablecer tu contraseña.
            </p>
          ) : (
            <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-4">
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-text-primary">Correo electrónico</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  required
                  className="w-full rounded-input border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-royal-500 focus:ring-2 focus:ring-royal-100"
                />
              </label>

              {error && <p className="text-sm text-error">{error}</p>}

              <button
                type="submit"
                disabled={pending}
                className="mt-1 w-full rounded-input bg-royal-600 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-royal-700 disabled:opacity-60"
              >
                {pending ? "Enviando…" : "Enviar enlace"}
              </button>
            </form>
          )}

          <p className="mt-5 text-center text-sm">
            <Link href="/login" className="font-medium text-royal-600 hover:text-royal-700">
              Volver a inicio de sesión
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add the link on `/login`**

Read `src/app/login/page.tsx` first. It currently ends its form section with the submit button, then a demo-credentials hint paragraph outside the form. Add a `Link` import and the new link, directly after the submit `<button>` and before the closing `</form>`:

```tsx
// Add to the top imports:
import Link from "next/link";

// Add immediately after the closing </button> of the submit button, still inside <form>:
          <p className="mt-4 text-center text-sm">
            <Link href="/forgot-password" className="font-medium text-royal-600 hover:text-royal-700">
              ¿Olvidaste tu contraseña?
            </Link>
          </p>
```

- [ ] **Step 3: Typecheck and lint**

```bash
npm run typecheck
npm run lint
```
Expected: clean.

- [ ] **Step 4: Manual verification**

```bash
npm run dev
```
Go to `/login`, confirm "¿Olvidaste tu contraseña?" appears below the sign-in button as a text link (not a button) and navigates to `/forgot-password`. Submit the seeded staff email (`staff@docuflow.mx`) — confirm the neutral "Si existe una cuenta…" message appears regardless. Stop the dev server when done.

- [ ] **Step 5: Commit**

```bash
git add src/app/forgot-password/page.tsx src/app/login/page.tsx
git commit -m "Add the /forgot-password page and link it from /login"
```

---

### Task 8: Email templates

**Files:**
- Create: `supabase/templates/invite.html`
- Create: `supabase/templates/recovery.html`
- Modify: `supabase/config.toml`

- [ ] **Step 1: Write the invite template**

```html
<!-- supabase/templates/invite.html -->
<h2>Te invitaron a DocuFlow</h2>

<p>Alguien de tu organización te agregó como miembro. Usa el siguiente enlace para crear tu
contraseña y entrar:</p>

<p><a href="{{ .ConfirmationURL }}">Crear mi contraseña</a></p>

<p>Si no esperabas esta invitación, puedes ignorar este mensaje.</p>
```

- [ ] **Step 2: Write the recovery template**

```html
<!-- supabase/templates/recovery.html -->
<h2>Recupera tu contraseña</h2>

<p>Usa el siguiente enlace para elegir una nueva contraseña:</p>

<p><a href="{{ .ConfirmationURL }}">Elegir nueva contraseña</a></p>

<p>Si no solicitaste esto, puedes ignorar este mensaje — tu contraseña actual sigue funcionando.</p>
```

- [ ] **Step 3: Wire both templates into `config.toml`**

Read `supabase/config.toml` first — find the existing `[auth.email.template.magic_link]` section (already configured) and the commented-out `# [auth.email.template.invite]` example nearby. Replace the commented example and add a new section for recovery:

```toml
[auth.email.template.invite]
subject = "Te invitaron a DocuFlow"
content_path = "./supabase/templates/invite.html"

[auth.email.template.recovery]
subject = "Recupera tu contraseña — DocuFlow"
content_path = "./supabase/templates/recovery.html"
```

- [ ] **Step 4: Apply locally and confirm no regressions**

```bash
npm run db:reset
npx vitest run
```
Expected: reset applies cleanly (no migration changes here, just local auth config — this just confirms `config.toml` itself is syntactically valid and the stack still starts), full suite still passes.

- [ ] **Step 5: Commit**

```bash
git add supabase/templates/invite.html supabase/templates/recovery.html supabase/config.toml
git commit -m "Add Spanish invite and recovery email templates"
```

---

### Task 9: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

```bash
npx vitest run
```
Expected: every test file passes, including `tests/unit/password.test.ts`, `tests/unit/resend.test.ts`, and `tests/integration/invite-member.test.ts`.

- [ ] **Step 2: Lint and typecheck one more time**

```bash
npm run lint
npm run typecheck
```
Expected: clean.

- [ ] **Step 3: End-to-end manual smoke test of the full loop**

```bash
npm run db:reset
npm run db:seed
npm run dev
```
1. Log in as the seeded owner (`staff@docuflow.mx` / `docuflow-demo-2026`).
2. Go to `/members`, invite a brand-new email (e.g. `smoke-test@example.test`).
3. Check Mailpit (`http://127.0.0.1:54424`) for the invite email — confirm it's the Spanish
   template from Task 8, and click its link.
4. Confirm it lands on `/set-password` with the form visible ("Enlace válido" — not stuck on
   "Validando enlace…" or falling through to "Enlace vencido o inválido").
5. Set a password, confirm it redirects to `/cases`.
6. Log out, log back in with the new email/password at `/login` — confirm it works.
7. From `/login`, click "¿Olvidaste tu contraseña?", request a reset for that same email, check
   Mailpit for the recovery email, click its link, confirm it also lands on a working
   `/set-password` form, and set a different password successfully.

Stop the dev server when done.

- [ ] **Step 4: Reset to a clean baseline**

```bash
npm run db:reset
npm run db:seed
```

- [ ] **Step 5: Final commit if any cleanup was needed**

```bash
git status --short
```
If clean, nothing to commit — this task is verification-only. If lint/typecheck fixes were needed above, commit them here with a message describing what was fixed.
